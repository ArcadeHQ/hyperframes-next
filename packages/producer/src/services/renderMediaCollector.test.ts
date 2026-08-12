import { describe, expect, it } from "bun:test";
import { collectRenderMedia } from "./renderMediaCollector.js";

function inlinedScene(hostStart: number, inPoint: number): string {
  return `<div data-composition-id="root" data-start="0">
  <div data-composition-id="scene" data-composition-file="scene.html"
       data-start="${hostStart}" data-end="${hostStart + 2}" data-playback-start="${inPoint}">
    <video id="scene-video" data-hf-render-id="scene-video" src="clip.mp4"
           data-start="1" data-end="5" data-duration="4"></video>
    <audio id="pre-audio" data-hf-render-id="pre-audio" src="early.wav"
           data-start="0" data-end="1" data-duration="1"></audio>
    <audio id="late-audio" data-hf-render-id="late-audio" src="late.wav"
           data-start="2" data-end="3" data-duration="1"></audio>
  </div>
</div>`;
}

describe("collectRenderMedia nested in-point", () => {
  it.each([
    { name: "mid-timeline slot", hostStart: 5, videoStart: 5, lateStart: 5.5 },
    { name: "slot at t=0", hostStart: 0, videoStart: 0, lateStart: 0.5 },
  ])("shifts media by the slot in-point ($name)", ({ hostStart, videoStart, lateStart }) => {
    const media = collectRenderMedia(inlinedScene(hostStart, 1.5));
    expect(media.videos).toContainEqual(
      expect.objectContaining({
        id: "scene-video",
        start: videoStart,
        end: hostStart + 2,
        mediaStart: 0.5,
      }),
    );
    expect(media.audios).not.toContainEqual(expect.objectContaining({ id: "pre-audio" }));
    expect(media.audios).toContainEqual(
      expect.objectContaining({ id: "late-audio", start: lateStart, end: lateStart + 1 }),
    );
  });

  it("resolves a host data-start id-ref against a sibling clip", () => {
    const html = `<div data-composition-id="root" data-start="0">
  <video id="intro" data-hf-render-id="intro" src="intro.mp4"
         data-start="0" data-end="10" data-duration="10"></video>
  <div data-composition-id="scene" data-composition-file="scene.html"
       data-start="intro" data-duration="2">
    <video id="scene-video" data-hf-render-id="scene-video" src="clip.mp4"
           data-start="0" data-end="4" data-duration="4"></video>
  </div>
</div>`;
    const media = collectRenderMedia(html);
    expect(media.videos.find((v) => v.id === "scene-video")).toMatchObject({
      start: 10,
      end: 14,
    });
  });
});
