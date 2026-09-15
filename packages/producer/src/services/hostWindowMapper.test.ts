import { describe, expect, it } from "bun:test";
import { MEDIA_RENDER_ID_ATTR } from "@hyperframes/core";
import { collectRenderMedia } from "./renderMediaCollector.js";
import { createHostWindowMapper } from "./hostWindowMapper.js";

describe("createHostWindowMapper", () => {
  it("maps a browser-discovered empty-src clip through the host id-ref window", () => {
    const html =
      `<div data-composition-file="hook.html" data-composition-id="hook" data-start="0" data-duration="2"></div>` +
      `<div data-composition-file="body.html" data-composition-id="body" data-start="hook" data-duration="2">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="demo" id="demo" data-start="0" data-media-start="2"></video>` +
      `</div>`;

    expect(collectRenderMedia(html).videos).toHaveLength(0);
    const mapHost = createHostWindowMapper(html);
    // An unknown end closes with the 2s slot (data-start "hook" + data-duration 2).
    expect(mapHost("demo", 0, 0)).toEqual({ start: 2, end: 4 });
    expect(mapHost("demo", 0, 2)).toEqual({ start: 2, end: 4 });
  });

  it("closes a discovered clip at the host's data-duration when it has no data-end", () => {
    const html =
      `<div data-composition-file="hook.html" data-composition-id="hook" data-start="0" data-duration="2"></div>` +
      `<div data-composition-file="body.html" data-composition-id="body" data-start="hook" data-duration="2">` +
      `<video ${MEDIA_RENDER_ID_ATTR}="demo" id="demo" data-start="0"></video>` +
      `</div>`;

    const mapHost = createHostWindowMapper(html);
    // Discovered end comes from the 6s source file; the 2s slot wins.
    expect(mapHost("demo", 0, 6)).toEqual({ start: 2, end: 4 });
    expect(mapHost("demo", 3, 6)).toBeNull();
  });
});
