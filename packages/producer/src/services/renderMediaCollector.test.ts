import { describe, expect, it } from "bun:test";
import { MEDIA_RENDER_ID_ATTR } from "@hyperframes/core";
import { collectRenderMedia, createHostWindowMapper } from "./renderMediaCollector.js";

describe("collectRenderMedia host windows", () => {
  it("schedules nested videos at resolved host id-ref windows", () => {
    const html =
      `<div data-composition-file="hook.html" data-composition-id="hook" data-start="0" data-duration="2">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="red" id="red" src="red.mp4" data-start="0" data-duration="2"></video>` +
      `</div>` +
      `<div data-composition-file="body.html" data-composition-id="body" data-start="hook" data-duration="2">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="blue" id="blue" src="blue.mp4" data-start="0" data-duration="2"></video>` +
      `</div>`;

    const { videos } = collectRenderMedia(html);
    expect(videos.find((v) => v.id === "red")).toMatchObject({ start: 0, end: 2 });
    expect(videos.find((v) => v.id === "blue")).toMatchObject({ start: 2, end: 4 });
  });

  it("maps a browser-discovered empty-src clip through the host id-ref window", () => {
    const html =
      `<div data-composition-file="hook.html" data-composition-id="hook" data-start="0" data-duration="2"></div>` +
      `<div data-composition-file="body.html" data-composition-id="body" data-start="hook" data-duration="2">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="demo" id="demo" data-start="0" data-media-start="2"></video>` +
      `</div>`;

    expect(collectRenderMedia(html).videos).toHaveLength(0);
    const mapHost = createHostWindowMapper(html);
    expect(mapHost("demo", 0, 0)).toEqual({ start: 2, end: 0 });
    expect(mapHost("demo", 0, 2)).toEqual({ start: 2, end: 4 });
  });
});
