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
import { mkdirSync } from "node:fs";
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
import {
  raceAgainstStall,
  resolveCaptureStallTimeoutMs,
  type StreamingEncoderOptions,
} from "./captureStreamingStage.js";

export interface SegmentedStageDeps {
  spawnEncoder: typeof spawnStreamingEncoder;
  captureFrame: typeof captureFrameToBuffer;
  concat: typeof concatVideoFiles;
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
  /** Test seam; defaults to the real engine functions. */
  deps?: Partial<SegmentedStageDeps>;
  updateCaptureObservability?: (patch: {
    capturePath?: "segmented";
    segmentIndex?: number;
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
    }
  /** The first segment's encoder could not spawn — caller replans to sdr_streaming. */
  | { success: false };

/** Zero-padded so lexical order equals frame order in the concat list and on disk. */
export function segmentOutputPath(workDir: string, index: number): string {
  return join(workDir, "segments", `segment_${String(index).padStart(5, "0")}.mp4`);
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
  workDir: string;
  streamingEncoderOptions: StreamingEncoderOptions;
  spawnEncoder: SegmentedStageDeps["spawnEncoder"];
  captureFrame: SegmentedStageDeps["captureFrame"];
  stallTimeoutMs: number;
  abortSignal: AbortSignal | undefined;
  assertNotAborted: () => void;
  onProgress?: ProgressCallback;
}

/** Capture one segment into its own encoder. Returns the encoder's encode ms. */
async function captureSegment(ctx: SegmentCaptureContext, segment: SegmentSlice): Promise<number> {
  const segmentPath = segmentOutputPath(ctx.workDir, segment.index);
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
        `Streaming frame ${i + 1}/${ctx.totalFrames} (segment ${segment.index + 1}/${ctx.segmentCount})`,
        Math.round(25 + ((i + 1) / ctx.totalFrames) * 55),
        ctx.onProgress,
      );
    }
    const encodeResult = await encoder.close();
    encoderClosed = true;
    if (!encodeResult.success) {
      throw encoderFailureError(`Segment ${segment.index} encode failed`, encodeResult);
    }
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

function resolveDeps(input: CaptureSegmentedStageInput): SegmentedStageDeps {
  return {
    spawnEncoder: input.deps?.spawnEncoder ?? spawnStreamingEncoder,
    captureFrame: input.deps?.captureFrame ?? captureFrameToBuffer,
    concat: input.deps?.concat ?? concatVideoFiles,
  };
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
  const { spawnEncoder, captureFrame, concat } = resolveDeps(input);

  const segments = planSegments(totalFrames, segmentFrames);
  mkdirSync(join(workDir, "segments"), { recursive: true });
  const session = await openSegmentedSession(input);

  let lastBrowserConsole: string[] = [];
  let encodeMs = 0;
  const segmentPaths: string[] = [];

  try {
    if (!session.isInitialized) {
      await initializeSession(session);
    }
    await completeDeferredDrawElementInit(session);
    assertNotAborted();
    lastBrowserConsole = session.browserConsoleBuffer;

    const ctx: SegmentCaptureContext = {
      session,
      job,
      cfg,
      totalFrames,
      segmentCount: segments.length,
      workDir,
      streamingEncoderOptions,
      spawnEncoder,
      captureFrame,
      stallTimeoutMs: resolveCaptureStallTimeoutMs(),
      abortSignal,
      assertNotAborted,
      onProgress,
    };

    for (const segment of segments) {
      assertNotAborted();
      updateCaptureObservability?.({ capturePath: "segmented", segmentIndex: segment.index });
      try {
        encodeMs += await captureSegment(ctx, segment);
      } catch (err) {
        if (!(err instanceof SegmentEncoderSpawnError)) throw err;
        // Nothing captured yet, so the caller can still replan onto the plain
        // streaming path. A later segment cannot: earlier segments are
        // already encoded and would be discarded.
        if (segment.index > 0) throw err.reason;
        log.warn(
          "[Render] Segment encoder spawn failed; falling back to single-encoder streaming.",
          {
            error: err.message,
            outputFormat,
            segments: segments.length,
            durationSeconds: job.duration,
          },
        );
        return { success: false };
      }
      segmentPaths.push(segmentOutputPath(workDir, segment.index));
    }

    dedupPerfs.push(getCapturePerfSummary(session));
  } catch (error) {
    lastBrowserConsole = session.browserConsoleBuffer;
    throw wrapCaptureStageError(error, lastBrowserConsole);
  } finally {
    lastBrowserConsole = session.browserConsoleBuffer;
    await closeCaptureSession(session);
  }

  await concatSegments(concat, segmentPaths, videoOnlyPath, abortSignal, cfg);

  return {
    success: true,
    encodeMs,
    probeSession: null,
    lastBrowserConsole,
    workerCount: 1,
    segments: segments.length,
    segmentPaths,
  };
}
