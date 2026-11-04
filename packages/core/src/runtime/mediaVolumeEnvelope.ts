import type { RuntimeTimelineChildLike, RuntimeTimelineLike } from "./types";
import { clampAudioGain, withUnclampedVolume } from "../audioGain.js";
import { parseStrictFiniteTimingNumber } from "./playbackRate";
import { createRuntimeStartTimeResolver } from "./startResolver";
import { isMediaElement } from "./domRealm";

/**
 * Shared volume-automation utilities used by both the renderer (offline PCM
 * baking in audioVolumeEnvelope.ts) and the preview runtime (per-tick gain
 * applied in syncRuntimeMedia).
 *
 * Keeping the two concerns in one place ensures preview and render derive the
 * envelope from the same logic and the same probe samples.
 */

export interface VolumeKeyframe {
  time: number;
  volume: number;
}

/**
 * Normalise raw keyframes to track-relative seconds: subtract `trackStart`,
 * clamp to [0,1], sort, de-duplicate, and prepend a `baseVolume` anchor at
 * t=0 when the first keyframe starts after the clip's begin.
 *
 * Returns an empty array when all keyframes are invalid — the caller should
 * treat an empty envelope as "no automation, use static volume."
 */
export function normaliseEnvelope(
  keyframes: VolumeKeyframe[],
  trackStart: number,
  baseVolume: number,
): VolumeKeyframe[] {
  const points = keyframes
    .filter((k) => Number.isFinite(k.time) && Number.isFinite(k.volume))
    .map((k) => ({
      time: Math.max(0, k.time - trackStart),
      volume: clampAudioGain(k.volume),
    }))
    .sort((a, b) => a.time - b.time);

  const deduped: VolumeKeyframe[] = [];
  for (const point of points) {
    const previous = deduped.at(-1);
    if (previous && Math.abs(previous.time - point.time) < 1e-9) {
      previous.volume = point.volume;
    } else {
      deduped.push(point);
    }
  }

  if (deduped.length === 0) return deduped;
  if (deduped[0]!.time > 0) {
    deduped.unshift({ time: 0, volume: clampAudioGain(baseVolume) });
  }
  return deduped;
}

/**
 * Linearly interpolate the gain at time `t` (track-relative seconds) from a
 * normalised envelope produced by `normaliseEnvelope`. Returns 1 when the
 * envelope is empty.
 */
export function interpolateVolumeGain(envelope: VolumeKeyframe[], t: number): number {
  if (envelope.length === 0) return 1;

  let segment = 0;
  // The PCM baker intentionally inlines this lookup with a monotonic cursor
  // because calling this preview-oriented helper per sample would be O(N×M).
  // fallow-ignore-next-line code-duplication
  while (segment < envelope.length - 2 && t >= envelope[segment + 1]!.time) {
    segment += 1;
  }

  const a = envelope[segment]!;
  const b = envelope[segment + 1] ?? a;
  const span = b.time - a.time;
  const progress = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - a.time) / span));
  return a.volume + (b.volume - a.volume) * progress;
}

function recordVolumeSample(
  keyframes: VolumeKeyframe[],
  previousSample: VolumeKeyframe | undefined,
  sample: VolumeKeyframe,
  isFinalSample: boolean,
): void {
  const last = keyframes.at(-1);
  if (!last || Math.abs(last.volume - sample.volume) > 0.0001) {
    // Change-only compression must retain the preceding real sample so a
    // flat run stays flat instead of being interpolated into the next value.
    // During a continuous ramp, that sample is already the last keyframe.
    if (last && previousSample && previousSample.time > last.time) {
      keyframes.push(previousSample);
    }
    keyframes.push(sample);
  } else if (isFinalSample && sample.time > last.time) {
    keyframes.push(sample);
  }
}

function parseVolumeNumber(value: string | undefined): number | undefined {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface ProbeWindow {
  start: number;
  end: number;
  staticVolume: number;
}

function resolveVolumeProbeWindow(
  el: HTMLAudioElement | HTMLVideoElement,
  compositionDuration: number,
): ProbeWindow {
  // Probe samples are stamped with ROOT-timeline seek times, and
  // `normaliseEnvelope` rebases them by this start — so it has to be the same
  // absolute start the transport plays the clip at. Reading `data-start`
  // directly gave a composition-local value, which put a nested clip's whole
  // envelope at the wrong origin.
  const start = createRuntimeStartTimeResolver({
    timelineRegistry: (window as Window & { __timelines?: Record<string, RuntimeTimelineLike> })
      .__timelines,
    includeAuthoredTimingAttrs: true,
  }).resolveMediaStartForElement(el);
  const endAttr = parseStrictFiniteTimingNumber(el.dataset.end) ?? undefined;
  const durAttr = parseStrictFiniteTimingNumber(el.dataset.duration) ?? undefined;
  let end = compositionDuration;
  if (durAttr !== undefined && durAttr > 0) {
    end = start + durAttr;
  } else if (endAttr !== undefined && endAttr > start) {
    end = endAttr;
  }
  const staticAttr = parseVolumeNumber(el.dataset.volume) ?? 1;
  return { start, end, staticVolume: clampAudioGain(staticAttr) };
}

/**
 * Probe a single media element's volume automation by seeking a GSAP timeline
 * through the element's active window.
 *
 * Runs synchronously in the browser. The timeline is left at its current
 * position after the probe (the next transport tick re-seeks it to `t`).
 *
 * Returns null when the element has no detectable automation (volume never
 * changes from its initial `data-volume` value).
 */
export function probeElementVolumeKeyframes(
  el: HTMLAudioElement | HTMLVideoElement,
  seekTimeline: (t: number) => void,
  compositionDuration: number,
  sampleFps: number,
): VolumeKeyframe[] | null {
  return probeKeyframesInWindow(
    el,
    seekTimeline,
    compositionDuration,
    sampleFps,
    resolveVolumeProbeWindow(el, compositionDuration),
  );
}

/** Sampling half of the probe, given an already-resolved window. Split out so
 *  `probeAndCacheElementVolume` resolves that window ONCE and reuses it for the
 *  envelope rebase, instead of deriving the same start twice per element. */
function probeKeyframesInWindow(
  el: HTMLAudioElement | HTMLVideoElement,
  seekTimeline: (t: number) => void,
  compositionDuration: number,
  sampleFps: number,
  { start, end, staticVolume }: ProbeWindow,
): VolumeKeyframe[] | null {
  const step = 1 / Math.min(60, Math.max(1, sampleFps));
  const sampleStart = Math.max(0, start);
  const sampleEnd = Math.min(compositionDuration, end);

  const keyframes: VolumeKeyframe[] = withUnclampedVolume(el, () => {
    // Reset to data-volume so GSAP captures the correct FROM value. Above
    // unity that only survives because the shadow accessor is installed.
    el.volume = staticVolume;

    const samples: VolumeKeyframe[] = [];
    let previousSample: VolumeKeyframe | undefined;
    for (let t = sampleStart; t <= sampleEnd + 1e-6; t = Math.min(sampleEnd, t + step)) {
      seekTimeline(t);
      const raw = Number(el.volume);
      if (Number.isFinite(raw)) {
        const sample = {
          time: Number(t.toFixed(6)),
          volume: Number(clampAudioGain(raw).toFixed(6)),
        };
        recordVolumeSample(samples, previousSample, sample, t === sampleEnd);
        previousSample = sample;
      }
      if (t === sampleEnd) break;
    }
    return samples;
  });

  const hasAutomation = keyframes.some((kf) => Math.abs(kf.volume - staticVolume) > 0.0001);
  return hasAutomation ? keyframes : null;
}

export type RuntimeTimelineRef = Partial<
  Pick<RuntimeTimelineLike, "totalTime" | "seek" | "getChildren">
>;

export interface VolumeProbeOptions {
  /**
   * Render/probe pages must not sample the live visual timeline during runtime
   * initialization. The producer discovers audio automation in its own
   * isolated pass and bakes it before frame capture, so seeking here is both
   * redundant and capable of materializing future zero-duration GSAP state.
   *
   * Preview callers omit this option and retain live automation discovery.
   */
  allowLiveTimelineSeek?: boolean;
  movers?: () => VolumeMovers;
}

function namesKey(vars: unknown, matches: (key: string) => boolean, depth = 0): boolean {
  if (depth > 3 || vars === null || typeof vars !== "object") return false;
  if (Array.isArray(vars)) return vars.some((item) => namesKey(item, matches, depth + 1));
  if (Object.getPrototypeOf(vars) !== Object.prototype) return false;
  return Object.entries(vars).some(
    ([key, value]) => matches(key) || namesKey(value, matches, depth + 1),
  );
}

const isDomNode = (target: unknown): boolean =>
  typeof (target as { nodeType?: unknown } | null)?.nodeType === "number";

function hasSetter(target: unknown, key: string): boolean {
  for (let o = Object(target); o; o = Object.getPrototypeOf(o)) {
    const descriptor = Object.getOwnPropertyDescriptor(o, key);
    if (descriptor) return typeof descriptor.set === "function";
  }
  return false;
}

export interface VolumeMovers {
  elements: Set<unknown>;
  /** Tweens on a non-DOM target whose tweened property is a setter: a gain proxy, or a clock that redraws. */
  setterTweens: RuntimeTimelineChildLike[];
  /** Per document, the media a setter tween wrote `volume` on when played once; null when that could not be told. */
  setterWrites: Map<Document, Set<unknown> | null>;
  unknown: boolean;
}

export function volumeMoversOf(timeline: RuntimeTimelineRef): VolumeMovers {
  const setterWrites = new Map<Document, Set<unknown> | null>();
  const unknown: VolumeMovers = {
    elements: new Set(),
    setterTweens: [],
    setterWrites,
    unknown: true,
  };
  if (typeof timeline.getChildren !== "function") return unknown;
  try {
    const movers: VolumeMovers = {
      elements: new Set(),
      setterTweens: [],
      setterWrites,
      unknown: false,
    };
    for (const tween of timeline.getChildren(true, true, false)) {
      const targets: unknown[] = tween.targets?.() ?? [];
      let setter = false;
      for (const target of targets) {
        if (isDomNode(target)) {
          if (namesKey(tween.vars, (key) => key === "volume")) movers.elements.add(target);
        } else if (!setter && namesKey(tween.vars, (key) => hasSetter(target, key))) {
          setter = true;
        }
      }
      if (setter) movers.setterTweens.push(tween);
    }
    return movers;
  } catch {
    return unknown;
  }
}

/** `local` seconds into `child`, on `timeline`'s clock; undefined when `child` does not hang under `timeline`. */
function timeOnTimeline(
  timeline: RuntimeTimelineRef,
  child: RuntimeTimelineChildLike,
  local: number,
): number | undefined {
  let time = local;
  let node: RuntimeTimelineChildLike | undefined = child;
  for (let depth = 0; node && node !== timeline && depth < 64; depth += 1) {
    const start = Number(node.startTime?.());
    const scale = Number(node.timeScale?.() ?? 1);
    if (!Number.isFinite(start) || !Number.isFinite(scale) || scale <= 0) return undefined;
    time = start + time / scale;
    node = node.parent;
  }
  return node === timeline ? time : undefined;
}

/** Call `onWrite` on every `el.volume` assignment until the returned undo runs; null when it cannot. */
function spyVolumeWrites(el: Element, onWrite: () => void): (() => void) | null {
  if (Object.getOwnPropertyDescriptor(el, "volume")) return null;
  let native: PropertyDescriptor | undefined;
  for (let o = Object.getPrototypeOf(el); o && !native; o = Object.getPrototypeOf(o)) {
    native = Object.getOwnPropertyDescriptor(o, "volume");
  }
  const { get, set } = native ?? {};
  if (!get || !set) return null;
  Object.defineProperty(el, "volume", {
    configurable: true,
    get() {
      return get.call(this);
    },
    set(value: unknown) {
      onWrite();
      set.call(this, value);
    },
  });
  return () => delete (el as { volume?: unknown }).volume;
}

/**
 * Which of `doc`'s media a setter tween writes `volume` on, found by seeking `timeline` once to the
 * middle of each setter tween with every media element's volume watched. A proxy that writes volume
 * does so whenever its setter runs, so one call answers; a clock that only redraws costs one redraw
 * here instead of 60 per second of every clip. Null (sample every element) when a tween cannot be
 * placed on the timeline or an element cannot be watched.
 */
function scanSetterVolumeWrites(
  timeline: RuntimeTimelineRef,
  tweens: RuntimeTimelineChildLike[],
  doc: Document,
  seek: (t: number) => void,
): Set<unknown> | null {
  const times: number[] = [];
  for (const tween of tweens) {
    const span = Number(tween.totalDuration?.() ?? tween.duration?.() ?? 0);
    const time = timeOnTimeline(timeline, tween, Number.isFinite(span) ? span / 2 : 0);
    if (time === undefined) return null;
    times.push(time);
  }
  const written = new Set<unknown>();
  const undos: (() => void)[] = [];
  try {
    for (const el of doc.querySelectorAll("audio, video")) {
      const undo = spyVolumeWrites(el, () => written.add(el));
      if (!undo) return null;
      undos.push(undo);
    }
    const originalTime = currentTime(timeline);
    for (const time of times) seek(time);
    if (Number.isFinite(originalTime)) seek(originalTime);
    return written;
  } finally {
    for (const undo of undos) undo();
  }
}

function currentTime(timeline: RuntimeTimelineRef): number {
  return typeof timeline.totalTime === "function"
    ? Number(timeline.totalTime())
    : typeof timeline.seek === "function"
      ? Number(timeline.seek())
      : 0;
}

function canMoveVolume(
  movers: VolumeMovers,
  el: HTMLMediaElement,
  timeline: RuntimeTimelineRef,
  seek: (t: number) => void,
): boolean {
  if (movers.unknown || movers.elements.has(el)) return true;
  if (movers.setterTweens.length === 0) return false;
  if (!el.isConnected) return true;
  const doc = el.ownerDocument;
  if (!movers.setterWrites.has(doc)) {
    movers.setterWrites.set(doc, scanSetterVolumeWrites(timeline, movers.setterTweens, doc, seek));
  }
  return movers.setterWrites.get(doc)?.has(el) ?? true;
}

/**
 * Probe a media element and, if volume automation is detected, store a
 * NORMALISED envelope in `cache`. Safe to call with a null timeline — returns
 * early.
 *
 * `probeElementVolumeKeyframes` stamps each keyframe with the timeline seek
 * time it was sampled at. Everything downstream of this cache — like the
 * renderer's PCM baker — indexes an envelope by track-relative seconds, so the
 * rebase belongs here, at the one point that fills the cache, rather than at
 * each read.
 */
export function probeAndCacheElementVolume(
  mediaEl: HTMLMediaElement,
  timeline: RuntimeTimelineRef | null | undefined,
  compositionDuration: number,
  cache: WeakMap<HTMLMediaElement, VolumeKeyframe[]>,
  options: VolumeProbeOptions = {},
): void {
  if (options.allowLiveTimelineSeek === false) return;
  if (!timeline) return;
  if (!isMediaElement(mediaEl)) return;
  if (compositionDuration <= 0) return;
  const seekFn = (t: number) => {
    try {
      if (typeof timeline.totalTime === "function") {
        timeline.totalTime(t, true);
      } else if (typeof timeline.seek === "function") {
        timeline.seek(t, true);
      }
    } catch {
      // ignore seek failures during probe
    }
  };
  // Sampling is ~60 whole-timeline seeks per second of clip, paid again on every rebind.
  const movers = options.movers?.() ?? volumeMoversOf(timeline);
  if (!canMoveVolume(movers, mediaEl, timeline, seekFn)) return;

  // Sampling seeks the live timeline through the entire composition. Preserve
  // its playhead so the probe cannot perturb the first rendered frame (or any
  // user scrub in the preview).
  const originalTime = currentTime(timeline);
  const probeWindow = resolveVolumeProbeWindow(mediaEl, compositionDuration);
  const keyframes = probeKeyframesInWindow(mediaEl, seekFn, compositionDuration, 60, probeWindow);
  if (Number.isFinite(originalTime)) seekFn(originalTime);
  if (keyframes) {
    const envelope = normaliseEnvelope(keyframes, probeWindow.start, probeWindow.staticVolume);
    if (envelope.length > 0) cache.set(mediaEl, envelope);
  }
}
