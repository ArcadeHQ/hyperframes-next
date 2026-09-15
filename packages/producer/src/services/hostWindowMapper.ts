/**
 * Shift a browser-discovered clip onto the root timeline.
 * Compile never sees empty-src media; discover then adds it at authored
 * `data-start` (often scene-local 0). Offset/limit only — same shape
 * collectRenderMedia uses — in this file so we do not rewrite that module
 * (playback-start-nested owns it).
 */
import { parseHTML } from "linkedom";
import { MEDIA_RENDER_ID_ATTR, resolveAuthoredTimingWindow } from "@hyperframes/core";
import {
  resolveReferencedStart,
  type RefResolverEl,
  type RefResolverDoc,
} from "@hyperframes/engine";

const COMPOSITION_HOST_ATTR = "data-composition-file";

/** Same rule as the collector: the runtime's authored timing window for the host. */
const resolveHostEnd = (host: Element, hostStart: number): number | null =>
  resolveAuthoredTimingWindow({
    start: hostStart,
    duration: host.getAttribute("data-duration"),
    end: host.getAttribute("data-end"),
  })?.end ?? null;

interface HostWindow {
  offset: number;
  limit: number;
}

const ROOT_WINDOW: HostWindow = { offset: 0, limit: Infinity };

const resolveHostWindow = (
  element: Element,
  document: RefResolverDoc,
  startCache: Map<RefResolverEl, number>,
  visiting: Set<RefResolverEl>,
): HostWindow => {
  const hosts: Element[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.hasAttribute(COMPOSITION_HOST_ATTR)) hosts.push(ancestor);
  }
  if (hosts.length === 0) return ROOT_WINDOW;

  let offset = 0;
  let limit = Infinity;
  for (const host of hosts.reverse()) {
    const hostStart = resolveReferencedStart(document, host, startCache, visiting);
    const hostEnd = resolveHostEnd(host, hostStart);
    if (hostEnd != null) limit = Math.min(limit, offset + hostEnd);
    offset += hostStart;
  }
  return { offset, limit };
};

const collectHostWindows = (html: string): Map<string, HostWindow> => {
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
};

interface HostMappedClip {
  start: number;
  end: number;
}

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
