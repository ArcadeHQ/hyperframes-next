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
  type NestedHostWindow,
} from "@hyperframes/core";
import {
  parseVideoElements,
  parseImageElements,
  parseAudioElements,
  type VideoElement,
  type ImageElement,
  type AudioElement,
} from "@hyperframes/engine";

const ROOT_WINDOW: NestedHostWindow = {
  offset: 0,
  limit: Infinity,
  windowStart: 0,
  hasInPoint: false,
};

/**
 * Map each render id to the window of the composition hosts it is nested in.
 * Keyed on the render id rather than document position so the caller never has
 * to assume two separate parses walk the document in the same order.
 */
function collectHostWindows(html: string): Map<string, NestedHostWindow> {
  const { document } = parseHTML(html);
  const windows = new Map<string, NestedHostWindow>();
  for (const element of document.querySelectorAll(`[${MEDIA_RENDER_ID_ATTR}]`)) {
    const renderId = element.getAttribute(MEDIA_RENDER_ID_ATTR);
    if (!renderId) continue;
    windows.set(renderId, resolveNestedHostWindow(element) ?? ROOT_WINDOW);
  }
  return windows;
}

function mapMediaClip<T extends { start: number; end: number; mediaStart?: number }>(
  clip: T,
  window: NestedHostWindow,
  bumpMediaStart: boolean,
): T | null {
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

interface HostMappedClip {
  start: number;
  end: number;
}

/**
 * Shift a browser-discovered clip onto the root timeline using the same host
 * windows as {@link collectRenderMedia}. Compile never sees empty-src media;
 * discover then adds it at authored `data-start` (often scene-local 0).
 * Offset/limit only — the same shape nestedHostWindow keeps — so this
 * keep-local does not import mapClipThroughHostWindow.
 */
export const createHostWindowMapper = (html: string) => {
  const windows = collectHostWindows(html);
  return (id: string, start: number, end: number): HostMappedClip | null => {
    const window = windows.get(id) ?? ROOT_WINDOW;
    const authoredEnd = end > 0 ? end : Infinity;
    const absoluteStart = start + window.offset;
    if (absoluteStart >= window.limit) return null;
    const absoluteEnd = Math.min(authoredEnd + window.offset, window.limit);
    return {
      start: absoluteStart,
      end: Number.isFinite(absoluteEnd) ? absoluteEnd : 0,
    };
  };
};

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
  const windowFor = (id: string): NestedHostWindow => windows.get(id) ?? ROOT_WINDOW;

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

  // A <video data-has-audio> track is reported as "<renderId>-audio"; strip the
  // suffix to look the element's host window back up.
  const audios: AudioElement[] = [];
  for (const audio of parseAudioElements(html)) {
    const elementId = audio.type === "video" ? audio.id.replace(/-audio$/, "") : audio.id;
    // The mixer reads end === 0 as "run to the natural media length", so an
    // unbounded track must stay unbounded rather than collapse onto its start.
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
