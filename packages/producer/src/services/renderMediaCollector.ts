/**
 * Collect the render pipeline's media list from the fully inlined document.
 *
 * Sub-composition media used to be gathered from each composition FILE before
 * inlining, then merged with the main document's media and deduplicated by
 * element id. That merge is unsound: ids are unique per file, not per render
 * document, so two scenes that both declare `<video id="clip">` — or that both
 * declare a bare `<video>` and get the per-file auto-id `hf-video-0` — collapse
 * into a single entry. See mediaRenderIds.ts for the full failure.
 *
 * Reading the inlined document instead makes the render document the single
 * source of truth for what media exists: every element is present exactly once,
 * `assignMediaRenderIds` has already given it a document-unique key, and the
 * timeline offsets are recoverable from the composition hosts it sits inside.
 */

import { parseHTML } from "linkedom";
import {
  MEDIA_RENDER_ID_ATTR,
  mapClipThroughHostWindow,
  resolveNestedHostWindow,
} from "@hyperframes/core";
import {
  MEDIA_START_BASIS_ATTR,
  readMediaStartBasis,
  resolveAbsoluteMediaStartSeconds,
  type MediaStartBasis,
} from "@hyperframes/core/media-timing";
import {
  parseVideoElements,
  parseImageElements,
  parseAudioElements,
  resolveReferencedStart,
  type RefResolverEl,
  type RefResolverDoc,
  type VideoElement,
  type ImageElement,
  type AudioElement,
} from "@hyperframes/engine";

/**
 * Marks a host element that `inlineSubCompositions` hoisted a composition into.
 * Set unconditionally on every inlined host, which makes it the reliable signal
 * for "this ancestor shifts its children along the timeline".
 */
const COMPOSITION_HOST_ATTR = "data-composition-file";

/**
 * Where a composition host closes, in its parent's time. `data-end` wins; a
 * host authored with only `data-duration` closes at start + duration — the
 * same window the runtime uses to hide the host's descendants, so nested
 * media stops with the scene instead of running to the scene file's end.
 */
function resolveHostEnd(host: Element, hostStart: number): number | null {
  const end = parseNumeric(host.getAttribute("data-end"));
  if (end != null) return end;
  const duration = parseNumeric(host.getAttribute("data-duration"));
  return duration == null ? null : hostStart + duration;
}

interface HostWindow {
  /** Seconds to add to a descendant's authored, scene-relative start. */
  offset: number;
  /** Absolute time past which a descendant is outside its host, or Infinity. */
  limit: number;
  windowStart: number;
  hasInPoint: boolean;
  /** Whether authored media time is composition-local or legacy root-global. */
  basis: MediaStartBasis;
}

const ROOT_WINDOW: HostWindow = {
  offset: 0,
  limit: Infinity,
  windowStart: 0,
  hasInPoint: false,
  basis: "local",
};

function parseNumeric(value: string | null): number | null {
  if (value == null || value === "") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mediaBasis(element: Element): MediaStartBasis {
  const tag = element.tagName.toLowerCase();
  return tag === "video" || tag === "audio"
    ? readMediaStartBasis(element.getAttribute(MEDIA_START_BASIS_ATTR))
    : "local";
}

/**
 * Fold a media element's chain of composition hosts into one window.
 *
 * Host `data-start` is resolved the same way media is (`resolveReferencedStart`):
 * numeric literals, or an id / `data-composition-id` ref to a sibling slot's
 * end (`data-start="hook"`). A slot in-point (`data-playback-start`) remaps
 * through `resolveNestedHostWindow` so render matches preview.
 */
function resolveHostWindow(
  element: Element,
  document: RefResolverDoc,
  startCache: Map<RefResolverEl, number>,
  visiting: Set<RefResolverEl>,
): HostWindow {
  const nested = resolveNestedHostWindow(element);
  const basis = mediaBasis(element);
  if (nested?.hasInPoint) return { ...nested, basis };

  const hosts: Element[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute(COMPOSITION_HOST_ATTR)) hosts.push(ancestor);
  }
  if (hosts.length === 0) return { ...ROOT_WINDOW, basis };

  let offset = 0;
  let limit = Infinity;
  for (const host of hosts.reverse()) {
    const hostStart = resolveReferencedStart(document, host, startCache, visiting);
    const hostEnd = resolveHostEnd(host, hostStart);
    if (hostEnd != null) limit = Math.min(limit, offset + hostEnd);
    offset += hostStart;
  }
  return { offset, limit, windowStart: 0, hasInPoint: false, basis };
}

function collectHostWindows(html: string): Map<string, HostWindow> {
  const { document } = parseHTML(html);
  const windows = new Map<string, HostWindow>();
  const startCache = new Map<RefResolverEl, number>();
  const visiting = new Set<RefResolverEl>();
  for (const element of document.querySelectorAll(`[${MEDIA_RENDER_ID_ATTR}]`)) {
    const renderId = element.getAttribute(MEDIA_RENDER_ID_ATTR);
    if (!renderId) continue;
    windows.set(
      renderId,
      resolveHostWindow(element as unknown as Element, document, startCache, visiting),
    );
  }
  return windows;
}

function toAbsoluteWindow(
  start: number,
  end: number,
  window: HostWindow,
): { start: number; end: number } | null {
  const absoluteStart = resolveAbsoluteMediaStartSeconds({
    authoredStart: start,
    hostStart: window.offset,
    basis: window.basis,
  });
  if (absoluteStart >= window.limit) return null;
  const absoluteEnd = resolveAbsoluteMediaStartSeconds({
    authoredStart: end,
    hostStart: window.offset,
    basis: window.basis,
  });
  return { start: absoluteStart, end: Math.min(absoluteEnd, window.limit) };
}

function mapMediaClip<T extends { start: number; end: number; mediaStart?: number }>(
  clip: T,
  window: HostWindow,
  bumpMediaStart: boolean,
): T | null {
  if (window.hasInPoint) {
    const mapped = mapClipThroughHostWindow(
      clip.start,
      clip.end,
      clip.mediaStart,
      window,
      bumpMediaStart,
    );
    if (!mapped) return null;
    return bumpMediaStart
      ? {
          ...clip,
          start: mapped.start,
          end: mapped.end,
          mediaStart: mapped.mediaStart ?? clip.mediaStart,
        }
      : { ...clip, start: mapped.start, end: mapped.end };
  }
  const absolute = toAbsoluteWindow(clip.start, clip.end, window);
  if (!absolute) return null;
  return { ...clip, ...absolute };
}

export interface RenderMedia {
  videos: VideoElement[];
  audios: AudioElement[];
  images: ImageElement[];
}

/**
 * Parse every media element in the inlined render document, with each clip's
 * window resolved onto the root timeline.
 *
 * Expects `assignMediaRenderIds` to have run: the parsers report the stamped
 * render id as each element's `id`, which is what the rest of the pipeline
 * keys on and what the engine resolves back to a DOM node.
 */
export function collectRenderMedia(html: string): RenderMedia {
  const windows = collectHostWindows(html);
  const windowFor = (id: string): HostWindow => windows.get(id) ?? ROOT_WINDOW;

  const videos: VideoElement[] = [];
  for (const video of parseVideoElements(html)) {
    const clipped = mapMediaClip(video, windowFor(video.id), true);
    if (clipped) videos.push(clipped);
  }

  const images: ImageElement[] = [];
  for (const image of parseImageElements(html)) {
    const clipped = mapMediaClip(image, windowFor(image.id), false);
    if (clipped) images.push(clipped);
  }

  const audios: AudioElement[] = [];
  for (const audio of parseAudioElements(html)) {
    const elementId = audio.type === "video" ? audio.id.replace(/-audio$/, "") : audio.id;
    const authoredEnd = audio.end > 0 ? audio.end : Infinity;
    const clipped = mapMediaClip({ ...audio, end: authoredEnd }, windowFor(elementId), true);
    if (!clipped) continue;
    audios.push({
      ...clipped,
      end: Number.isFinite(clipped.end) ? clipped.end : 0,
    });
  }

  return { videos, audios, images };
}
