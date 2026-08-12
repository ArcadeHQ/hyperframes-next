/**
 * Nested composition slot window. Preview and render use this so a slot
 * `data-playback-start` shifts descendant media the same way.
 *
 * master = hostStart − inPoint + local. Clips that end before the visible
 * slot are dropped; clips that overlap it head-trim and bump mediaStart.
 * Host `data-start` may be an id-ref (`intro`) — resolved via ownerDocument.
 * honey: rate=1 only; compose host playback-rate if nested-rate trims land.
 */

import { parseStartExpression } from "./startExpression";

export type AttrNode = {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  parentElement: AttrNode | null;
  ownerDocument?: {
    getElementById(id: string): AttrNode | null;
    querySelector(selector: string): AttrNode | null;
  } | null;
};

export type NestedHostWindow = {
  offset: number;
  limit: number;
  windowStart: number;
  hasInPoint: boolean;
};

export type MappedClip = {
  start: number;
  end: number;
  mediaStart?: number;
};

function parseNum(el: AttrNode, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw == null || raw === "") return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function referencedDuration(target: AttrNode, targetStart: number): number | null {
  const duration = parseNum(target, "data-duration");
  if (duration != null && duration > 0) return duration;
  const endAttr = parseNum(target, "data-end");
  if (endAttr == null) return null;
  const delta = endAttr - targetStart;
  return Number.isFinite(delta) && delta > 0 ? delta : null;
}

function findStartTarget(host: AttrNode, refId: string): AttrNode | null {
  const doc = host.ownerDocument;
  if (!doc) return null;
  return doc.getElementById(refId) ?? doc.querySelector(`[data-composition-id="${refId}"]`);
}

function parseHostStart(host: AttrNode, visiting: Set<AttrNode>): number {
  const numeric = parseNum(host, "data-start");
  if (numeric != null) return numeric;
  const expression = parseStartExpression(host.getAttribute("data-start"));
  if (!expression) return 0;
  if (expression.kind === "absolute") return Math.max(0, expression.value);
  if (visiting.has(host)) return 0;
  const target = findStartTarget(host, expression.refId);
  if (!target) return 0;
  visiting.add(host);
  try {
    const targetStart = parseHostStart(target, visiting);
    const targetDuration = referencedDuration(target, targetStart);
    const resolved =
      targetDuration != null
        ? targetStart + targetDuration + expression.offset
        : targetStart + expression.offset;
    return Math.max(0, resolved);
  } finally {
    visiting.delete(host);
  }
}

function parseCompositionInPoint(host: AttrNode): number {
  const value = parseNum(host, "data-playback-start") ?? parseNum(host, "data-media-start");
  return value != null && value > 0 ? value : 0;
}

function isNestedCompositionHost(el: AttrNode): boolean {
  return el.hasAttribute("data-composition-file") || el.hasAttribute("data-composition-src");
}

export function resolveNestedHostWindow(element: AttrNode): NestedHostWindow | null {
  const hosts: AttrNode[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (isNestedCompositionHost(ancestor)) hosts.push(ancestor);
  }
  if (hosts.length === 0) return null;

  let offset = 0;
  let limit = Infinity;
  let windowStart = 0;
  let hasInPoint = false;
  const visiting = new Set<AttrNode>();
  for (const host of hosts.reverse()) {
    const hostStart = parseHostStart(host, visiting);
    const hostEnd = parseNum(host, "data-end");
    const inPoint = parseCompositionInPoint(host);
    if (inPoint > 0) hasInPoint = true;
    windowStart = Math.max(windowStart, offset + hostStart);
    if (hostEnd != null) limit = Math.min(limit, offset + hostEnd);
    offset += hostStart - inPoint;
  }
  return { offset, limit, windowStart, hasInPoint };
}

export function mapClipThroughHostWindow(
  localStart: number,
  localEnd: number,
  mediaStart: number | undefined,
  window: NestedHostWindow,
  bumpMediaStart: boolean,
): MappedClip | null {
  const start = localStart + window.offset;
  if (start >= window.limit) return null;
  const end = Math.min(localEnd + window.offset, window.limit);
  if (Number.isFinite(end) && end > start && end <= window.windowStart) return null;
  if (start < window.windowStart) {
    if (window.windowStart >= window.limit) return null;
    const bump = window.windowStart - start;
    return {
      start: window.windowStart,
      end,
      mediaStart: bumpMediaStart && mediaStart != null ? mediaStart + bump : mediaStart,
    };
  }
  return { start, end, mediaStart };
}

export function mapNestedMediaElement(
  element: AttrNode,
  mediaStart: number,
): { start: number; end: number; mediaStart: number } | null {
  const window = resolveNestedHostWindow(element);
  if (!window?.hasInPoint) return null;
  const localStart = parseNum(element, "data-start");
  if (localStart == null) return null;
  const duration = parseNum(element, "data-duration");
  const endAttr = parseNum(element, "data-end");
  const localEnd =
    endAttr != null ? endAttr : duration != null && duration > 0 ? localStart + duration : Infinity;
  const mapped = mapClipThroughHostWindow(localStart, localEnd, mediaStart, window, true);
  if (!mapped) return { start: window.windowStart, end: window.windowStart, mediaStart };
  return { start: mapped.start, end: mapped.end, mediaStart: mapped.mediaStart ?? mediaStart };
}
