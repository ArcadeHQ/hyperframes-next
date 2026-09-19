/**
 * Segmented capture (spec §5 Phase 2a).
 *
 * The frame range is split into fixed-size segments; each one gets its own
 * closed-GOP ffmpeg process writing `segments/segment_NNNNN.mp4`, and the
 * segments are concat-copied into the video-only file the assemble stage
 * muxes. Against the single-encoder streaming path this buys two things on a
 * long render: scratch is encoded video rather than one open pipe's worth of
 * in-flight state, and a failure is attributable to one segment — which is
 * what Phase 2b (resume) and 2c (per-segment retry) build on.
 *
 * This phase keeps ONE browser session for the whole render and no retry;
 * recycling and retry are 2c, multi-worker is 2d.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  captureFrameToBuffer,
  closeCaptureSession,
  completeDeferredDrawElementInit,
  concatVideoFiles,
  createCaptureSession,
  getCapturePerfSummary,
  initializeSession,
  prepareCaptureSessionForReuse,
  spawnStreamingEncoder,
  type BeforeCaptureHook,
  type CaptureOptions,
  type CapturePerfSummary,
  type CaptureSession,
  type EngineConfig,
  type StreamingEncoder,
} from "@hyperframes/engine";
import type { FileServerHandle } from "../../fileServer.js";
import type { ProducerLogger } from "../../../logger.js";
import type { ProgressCallback, RenderJob } from "../../renderOrchestrator.js";
import { wrapCaptureStageError } from "../captureStageError.js";
import { ensureFrameWritten } from "./captureHdrFrameShared.js";
import { updateJobStatus } from "../shared.js";
import { encoderFailureError } from "../encoderInterruption.js";
import type { SdrSegmentedCapturePlan } from "../capturePlan.js";
import { planSegments, type SegmentSlice } from "../segmentPlan.js";
import { isTargetLossError } from "../segmentRecycle.js";
import {
  raceAgainstStall,
  resolveCaptureStallTimeoutMs,
  type StreamingEncoderOptions,
} from "./captureStreamingStage.js";

export interface SegmentedStageDeps {
  spawnEncoder: typeof spawnStreamingEncoder;
  captureFrame: typeof captureFrameToBuffer;
  concat: typeof concatVideoFiles;
  closeSession: typeof closeCaptureSession;
  /** Delete a partial segment so a retry cannot leave a stale file behind. */
  removeFile: (path: string) => void;
}

/** Opens a fresh, initialized capture session with the video injector attached. */
export interface SessionFactory {
  create: () => Promise<CaptureSession>;
}

export interface CaptureSegmentedStageInput {
  fileServer: FileServerHandle;
  workDir: string;
  framesDir: string;
  videoOnlyPath: string;
  job: RenderJob;
  totalFrames: number;
  cfg: EngineConfig;
  plan: SdrSegmentedCapturePlan;
  log: ProducerLogger;
  probeSession: CaptureSession | null;
  /** For the spawn-failure log message context only. */
  outputFormat: string;
  streamingEncoderOptions: StreamingEncoderOptions;
  buildCaptureOptions: () => CaptureOptions;
  createRenderVideoFrameInjector: () => BeforeCaptureHook | null;
  abortSignal: AbortSignal | undefined;
  assertNotAborted: () => void;
  onProgress?: ProgressCallback;
  /** Mutated in place, same contract as the streaming stage. */
  dedupPerfs: CapturePerfSummary[];
  segmentFrames: number;
  /** Stable directory for segments; defaults to `${workDir}/segments`. */
  segmentDir?: string;
  /** Indices the caller already validated as reusable (Phase 2b resume). */
  completedSegments?: ReadonlySet<number>;
  /** Called after each segment closes, so the caller can persist a manifest. */
  onSegmentComplete?: (entry: {
    index: number;
    startFrame: number;
    endFrame: number;
    path: string;
    bytes: number;
  }) => void;
  /** Opens each session; defaults to reusing the probe session, then fresh ones. */
  sessionFactory?: SessionFactory;
  /** Recycle the browser every N segments; 0 or absent keeps one session. */
  browserRecycleEverySegments?: number;
  /** Test seam; defaults to the real engine functions. */
  deps?: Partial<SegmentedStageDeps>;
  updateCaptureObservability?: (patch: {
    capturePath?: "segmented";
    segmentIndex?: number;
    segmentRetries?: number;
  }) => void;
}

export type CaptureSegmentedStageResult =
  | {
      success: true;
      encodeMs: number;
      probeSession: null;
      lastBrowserConsole: string[];
      workerCount: 1;
      segments: number;
      segmentPaths: string[];
      /** Segments re-captured after a Chrome target loss. */
      segmentRetries: number;
      /** Cadence-driven browser restarts (retries are counted separately). */
      browserRecycles: number;
    }
  /** The first segment's encoder could not spawn — caller replans to sdr_streaming. */
  | { success: false };

/** Zero-padded so lexical order equals frame order in the concat list and on disk. */
export function segmentOutputPath(segmentDir: string, index: number): string {
  return join(segmentDir, `segment_${String(index).padStart(5, "0")}.mp4`);
}

/**
 * One closed-GOP encoder per segment. `gopSize` is the segment's own frame
 * count so the segment is exactly one GOP and concat-copy has an IDR at every
 * boundary; without it ffmpeg picks its own keyframes and a boundary can land
 * mid-GOP, which decodes as a glitch rather than an error.
 */
function segmentEncoderOptions(
  base: StreamingEncoderOptions,
  segment: SegmentSlice,
): StreamingEncoderOptions {
  return {
    ...base,
    lockGopForChunkConcat: true,
    gopSize: segment.endFrame - segment.startFrame,
  };
}

/** A segment's encoder never started. Only segment 0 can still fall back. */
class SegmentEncoderSpawnError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "SegmentEncoderSpawnError";
    this.reason = reason;
  }
}

interface SegmentCaptureContext {
  session: CaptureSession;
  job: RenderJob;
  cfg: EngineConfig;
  totalFrames: number;
  segmentCount: number;
  segmentDir: string;
  skipped: number;
  streamingEncoderOptions: StreamingEncoderOptions;
  spawnEncoder: SegmentedStageDeps["spawnEncoder"];
  captureFrame: SegmentedStageDeps["captureFrame"];
  stallTimeoutMs: number;
  abortSignal: AbortSignal | undefined;
  assertNotAborted: () => void;
  onProgress?: ProgressCallback;
  onSegmentComplete?: CaptureSegmentedStageInput["onSegmentComplete"];
}

/** The segment's frames, in order, into an already-spawned encoder. */
async function captureSegmentFrames(
  ctx: SegmentCaptureContext,
  segment: SegmentSlice,
  encoder: StreamingEncoder,
): Promise<void> {
  let lastProgressAt = Date.now();
  for (let i = segment.startFrame; i < segment.endFrame; i++) {
    ctx.assertNotAborted();
    const time = (i * ctx.job.config.fps.den) / ctx.job.config.fps.num;
    const { buffer } = await raceAgainstStall(
      ctx.captureFrame(ctx.session, i, time),
      ctx.stallTimeoutMs - (Date.now() - lastProgressAt),
      {
        captureMode: ctx.session.captureMode,
        frameIndex: i,
        totalFrames: ctx.totalFrames,
        stallTimeoutMs: ctx.stallTimeoutMs,
      },
      ctx.abortSignal,
    );
    ensureFrameWritten(await encoder.writeFrame(buffer), i, encoder);
    ctx.job.framesRendered = i + 1;
    lastProgressAt = Date.now();

    updateJobStatus(
      ctx.job,
      "rendering",
      `Streaming frame ${i + 1}/${ctx.totalFrames} (segment ${segment.index + 1}/${ctx.segmentCount}` +
        (ctx.skipped > 0 ? `, skipped ${ctx.skipped}` : "") +
        ")",
      Math.round(25 + ((i + 1) / ctx.totalFrames) * 55),
      ctx.onProgress,
    );
  }
}

/** Capture one segment into its own encoder. Returns the encoder's encode ms. */
async function captureSegment(ctx: SegmentCaptureContext, segment: SegmentSlice): Promise<number> {
  const segmentPath = segmentOutputPath(ctx.segmentDir, segment.index);
  let encoder: StreamingEncoder;
  try {
    encoder = await ctx.spawnEncoder(
      segmentPath,
      segmentEncoderOptions(ctx.streamingEncoderOptions, segment),
      ctx.abortSignal,
      ctx.cfg,
    );
    ctx.assertNotAborted();
  } catch (err) {
    if (ctx.abortSignal?.aborted) throw err;
    throw new SegmentEncoderSpawnError(err);
  }

  let encoderClosed = false;
  try {
    await captureSegmentFrames(ctx, segment, encoder);
    const encodeResult = await encoder.close();
    encoderClosed = true;
    if (!encodeResult.success) {
      throw encoderFailureError(`Segment ${segment.index} encode failed`, encodeResult);
    }
    ctx.onSegmentComplete?.({
      index: segment.index,
      startFrame: segment.startFrame,
      endFrame: segment.endFrame,
      path: segmentPath,
      // Recorded so resume can prove the file on disk is the one that
      // finished; absent only in unit tests, whose fake encoder writes none.
      bytes: existsSync(segmentPath) ? statSync(segmentPath).size : 0,
    });
    return encodeResult.durationMs;
  } finally {
    // A throw above (capture failure, abort, write error) leaves ffmpeg
    // running; close() is idempotent so this is safe next to the success
    // path's close.
    if (!encoderClosed) {
      await encoder.close().catch(() => {});
    }
  }
}

const DEFAULT_DEPS: SegmentedStageDeps = {
  spawnEncoder: spawnStreamingEncoder,
  captureFrame: captureFrameToBuffer,
  concat: concatVideoFiles,
  // Through the import binding, not captured: a value captured at module load
  // is invisible to a test that swaps the engine module after this file has
  // been evaluated (bun updates live bindings, not copies).
  closeSession: (session) => closeCaptureSession(session),
  removeFile: (path) => rmSync(path, { force: true }),
};

/**
 * Default factory: the probe session is consumed by the first call, every
 * later one opens a fresh browser. Initialization happens here so a recycled
 * session is indistinguishable from the first.
 */
function defaultSessionFactory(input: CaptureSegmentedStageInput): SessionFactory {
  let probeSession = input.probeSession;
  return {
    create: async () => {
      const session = probeSession
        ? probeSession
        : await openSegmentedSession({ ...input, probeSession: null });
      if (probeSession) {
        openSegmentedSessionReuse(input, probeSession);
        probeSession = null;
      }
      if (!session.isInitialized) await initializeSession(session);
      await completeDeferredDrawElementInit(session);
      return session;
    },
  };
}

function openSegmentedSessionReuse(
  input: CaptureSegmentedStageInput,
  session: CaptureSession,
): void {
  prepareCaptureSessionForReuse(session, input.framesDir, input.createRenderVideoFrameInjector());
}

/** Reuse the probe session when there is one, else open a fresh one. */
async function openSegmentedSession(input: CaptureSegmentedStageInput): Promise<CaptureSession> {
  // Same reasoning as the streaming stage: the resolved forceScreenshot comes
  // from the immutable plan, not from the caller-owned cfg.
  const captureCfg: EngineConfig =
    input.cfg.forceScreenshot === input.plan.forceScreenshot
      ? input.cfg
      : { ...input.cfg, forceScreenshot: input.plan.forceScreenshot };
  const videoInjector = input.createRenderVideoFrameInjector();
  if (input.probeSession) {
    prepareCaptureSessionForReuse(input.probeSession, input.framesDir, videoInjector);
    return input.probeSession;
  }
  return createCaptureSession(
    input.fileServer.url,
    input.framesDir,
    input.buildCaptureOptions(),
    videoInjector,
    captureCfg,
  );
}

/** Stream-copy the finished segments into the video-only file, or throw. */
async function concatSegments(
  concat: SegmentedStageDeps["concat"],
  segmentPaths: readonly string[],
  videoOnlyPath: string,
  abortSignal: AbortSignal | undefined,
  cfg: EngineConfig,
): Promise<void> {
  const result = await concat(segmentPaths, videoOnlyPath, abortSignal, cfg);
  if (result.success) return;
  throw encoderFailureError("Segment concat failed", {
    error: result.error,
    failureReason: result.externalInterruption ? "external_interruption" : undefined,
  });
}

export async function runCaptureSegmentedStage(
  input: CaptureSegmentedStageInput,
): Promise<CaptureSegmentedStageResult> {
  const {
    workDir,
    videoOnlyPath,
    job,
    totalFrames,
    cfg,
    log,
    outputFormat,
    streamingEncoderOptions,
    abortSignal,
    assertNotAborted,
    onProgress,
    dedupPerfs,
    segmentFrames,
    updateCaptureObservability,
  } = input;
  const deps: SegmentedStageDeps = { ...DEFAULT_DEPS, ...input.deps };

  const segments = planSegments(totalFrames, segmentFrames);
  const segmentDir = input.segmentDir ?? join(workDir, "segments");
  mkdirSync(segmentDir, { recursive: true });
  const skip = input.completedSegments ?? new Set<number>();
  // The first segment that still has to be captured. Only it can fall back to
  // the plain streaming path on a spawn failure; by any later one, encoded
  // segments exist that a fallback would throw away.
  const firstPending = segments.find((s) => !skip.has(s.index));
  const factory = input.sessionFactory ?? defaultSessionFactory(input);
  const recycleEvery = input.browserRecycleEverySegments ?? 0;

  let lastBrowserConsole: string[] = [];
  let encodeMs = 0;
  let segmentRetries = 0;
  let browserRecycles = 0;
  let sessionSegments = 0;
  const segmentPaths: string[] = [];

  const ctx: SegmentCaptureContext = {
    session: await factory.create(),
    job,
    cfg,
    totalFrames,
    segmentCount: segments.length,
    segmentDir,
    skipped: skip.size,
    streamingEncoderOptions,
    spawnEncoder: deps.spawnEncoder,
    captureFrame: deps.captureFrame,
    stallTimeoutMs: resolveCaptureStallTimeoutMs(),
    abortSignal,
    assertNotAborted,
    onProgress,
    onSegmentComplete: input.onSegmentComplete,
  };

  /** Close the current browser and open a fresh one at a segment boundary. */
  const recycleSession = async (why: "cadence" | "retry"): Promise<void> => {
    lastBrowserConsole = ctx.session.browserConsoleBuffer;
    // Counters are only valid while the session is live, so harvest before close.
    dedupPerfs.push(getCapturePerfSummary(ctx.session));
    const memory = ctx.session.chromeMemory?.stats();
    await deps.closeSession(ctx.session);
    ctx.session = await factory.create();
    sessionSegments = 0;
    if (why === "cadence") browserRecycles += 1;
    log.info(`[Render] segment browser recycled (${why})`, {
      rendererRssPeakMb: memory?.rendererRssPeakMb,
      rssLastMb: memory?.rssLastMb,
      samples: memory?.samples,
    });
  };

  /**
   * One segment, with its cadence recycle and its single target-loss retry.
   * Returns "fallback" only for a first-pending spawn failure, which is the
   * one case the caller can still replan onto the plain streaming path.
   */
  /** The encoder never started. Only the first pending segment can fall back. */
  const onSpawnFailure = (err: SegmentEncoderSpawnError, segment: SegmentSlice): "fallback" => {
    if (segment.index !== firstPending?.index) throw err.reason;
    log.warn("[Render] Segment encoder spawn failed; falling back to single-encoder streaming.", {
      error: err.message,
      outputFormat,
      segments: segments.length,
      durationSeconds: job.duration,
    });
    return "fallback";
  };

  /**
   * Chrome losing its target mid-capture is the one failure a fresh browser
   * fixes; everything else reproduces, so retrying it only doubles the time to
   * the same error. Once, then it propagates.
   */
  const retryAfterTargetLoss = async (
    err: unknown,
    segment: SegmentSlice,
    segmentPath: string,
  ): Promise<void> => {
    if (!isTargetLossError(err) || abortSignal?.aborted) throw err;
    segmentRetries += 1;
    updateCaptureObservability?.({ segmentRetries });
    log.warn(
      `[Render] segment ${segment.index}: browser target lost; retrying once on a fresh session`,
      { error: err instanceof Error ? err.message : String(err) },
    );
    deps.removeFile(segmentPath);
    await recycleSession("retry");
    encodeMs += await captureSegment(ctx, segment);
  };

  const runSegment = async (segment: SegmentSlice): Promise<"done" | "fallback"> => {
    const segmentPath = segmentOutputPath(segmentDir, segment.index);
    if (recycleEvery > 0 && sessionSegments >= recycleEvery) await recycleSession("cadence");
    updateCaptureObservability?.({ capturePath: "segmented", segmentIndex: segment.index });
    try {
      encodeMs += await captureSegment(ctx, segment);
    } catch (err) {
      if (err instanceof SegmentEncoderSpawnError) return onSpawnFailure(err, segment);
      await retryAfterTargetLoss(err, segment, segmentPath);
    }
    sessionSegments += 1;
    segmentPaths.push(segmentPath);
    return "done";
  };

  try {
    assertNotAborted();
    lastBrowserConsole = ctx.session.browserConsoleBuffer;

    for (const segment of segments) {
      assertNotAborted();
      if (skip.has(segment.index)) {
        segmentPaths.push(segmentOutputPath(segmentDir, segment.index));
        log.info("[Render] segment skipped (resume)", { index: segment.index });
        continue;
      }
      if ((await runSegment(segment)) === "fallback") return { success: false };
    }

    dedupPerfs.push(getCapturePerfSummary(ctx.session));
  } catch (error) {
    lastBrowserConsole = ctx.session.browserConsoleBuffer;
    throw wrapCaptureStageError(error, lastBrowserConsole);
  } finally {
    lastBrowserConsole = ctx.session.browserConsoleBuffer;
    await deps.closeSession(ctx.session);
  }

  await concatSegments(deps.concat, segmentPaths, videoOnlyPath, abortSignal, cfg);

  return {
    success: true,
    encodeMs,
    probeSession: null,
    lastBrowserConsole,
    workerCount: 1,
    segments: segments.length,
    segmentPaths,
    segmentRetries,
    browserRecycles,
  };
}
