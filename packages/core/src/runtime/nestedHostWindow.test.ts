import { describe, it, expect } from "vitest";
import {
  mapClipThroughHostWindow,
  mapNestedMediaElement,
  resolveNestedHostWindow,
} from "./nestedHostWindow";

function el(attrs: Record<string, string>, parent: { parentElement: unknown } | null = null) {
  const node = {
    parentElement: parent,
    ownerDocument: null as {
      getElementById(id: string): typeof node | null;
      querySelector(selector: string): typeof node | null;
    } | null,
    hasAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    getAttribute(name: string) {
      return attrs[name] ?? null;
    },
  };
  return node;
}

describe("nestedHostWindow", () => {
  it("head-trims overlapping media and drops clips before the in-point", () => {
    const host = el({
      "data-composition-file": "scene.html",
      "data-start": "5",
      "data-end": "7",
      "data-playback-start": "1.5",
    });
    const video = el({ "data-start": "1", "data-duration": "4", "data-end": "5" }, host);
    const window = resolveNestedHostWindow(video);
    expect(window).toMatchObject({ offset: 3.5, windowStart: 5, limit: 7, hasInPoint: true });
    expect(mapClipThroughHostWindow(1, 5, 0, window!, true)).toEqual({
      start: 5,
      end: 7,
      mediaStart: 0.5,
    });
    expect(mapClipThroughHostWindow(0, 1, 0, window!, true)).toBeNull();
    expect(mapClipThroughHostWindow(2, 3, 0, window!, true)).toEqual({
      start: 5.5,
      end: 6.5,
      mediaStart: 0,
    });
  });

  it("still head-trims when the slot is at t=0", () => {
    const host = el({
      "data-composition-file": "scene.html",
      "data-start": "0",
      "data-end": "2",
      "data-playback-start": "1.5",
    });
    const video = el({ "data-start": "1", "data-end": "5" }, host);
    const mapped = mapNestedMediaElement(video, 0);
    expect(mapped).toEqual({ start: 0, end: 2, mediaStart: 0.5 });
  });

  it("leaves identity slots (no in-point) to the PIP heuristic", () => {
    const host = el({
      "data-composition-file": "scene.html",
      "data-start": "5",
      "data-end": "7",
    });
    const video = el({ "data-start": "0" }, host);
    expect(mapNestedMediaElement(video, 0)).toBeNull();
  });

  it("resolves a host data-start id-ref against a sibling clip", () => {
    const intro = el({ "data-start": "0", "data-duration": "10" });
    const doc = {
      getElementById: (id: string) => (id === "intro" ? intro : null),
      querySelector: () => null,
    };
    intro.ownerDocument = doc;
    const host = el({
      "data-composition-file": "scene.html",
      "data-start": "intro",
      "data-end": "12",
    });
    host.ownerDocument = doc;
    const video = el({ "data-start": "0", "data-end": "4" }, host);
    expect(resolveNestedHostWindow(video)).toMatchObject({
      offset: 10,
      windowStart: 10,
      limit: 12,
    });
  });
});
