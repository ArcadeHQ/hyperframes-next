import { describe, expect, it } from "vitest";
import { classifyChromeProcesses } from "./frameCapture.js";

describe("classifyChromeProcesses", () => {
  it("splits CDP SystemInfo.getProcessInfo rows by type and keeps the browser pid", () => {
    const pids = classifyChromeProcesses(100, [
      { type: "browser", id: 100, cpuTime: 0 },
      { type: "renderer", id: 101, cpuTime: 0 },
      { type: "renderer", id: 102, cpuTime: 0 },
      { type: "GPU", id: 103, cpuTime: 0 },
      { type: "utility", id: 104, cpuTime: 0 },
    ]);
    expect(pids).toEqual({ browser: 100, renderers: [101, 102], gpu: [103] });
  });

  it("works without a browser pid", () => {
    expect(classifyChromeProcesses(undefined, [{ type: "renderer", id: 7, cpuTime: 0 }])).toEqual({
      renderers: [7],
      gpu: [],
    });
  });

  it("keeps the browser pid even when CDP reports no children", () => {
    expect(classifyChromeProcesses(100, [])).toEqual({ browser: 100, renderers: [], gpu: [] });
  });

  it("ignores process types that are neither renderer nor GPU", () => {
    // Guard mutation: dropping the `type` checks would fold utility/browser
    // rows into `renderers` and inflate the renderer peak.
    expect(
      classifyChromeProcesses(1, [
        { type: "utility", id: 2, cpuTime: 0 },
        { type: "browser", id: 1, cpuTime: 0 },
        { type: "gpu", id: 3, cpuTime: 0 },
      ]),
    ).toEqual({ browser: 1, renderers: [], gpu: [] });
  });
});
