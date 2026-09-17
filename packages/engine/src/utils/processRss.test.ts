import { describe, expect, it } from "vitest";
import { parsePsRss, parseTasklistCsv, sampleProcessRss } from "./processRss.js";

describe("parsePsRss", () => {
  it("parses pid and rss kilobytes into megabytes", () => {
    const out = "  4242 1048576\n 4243   2048\n";
    expect(parsePsRss(out)).toEqual([
      { pid: 4242, rssMb: 1024 },
      { pid: 4243, rssMb: 2 },
    ]);
  });

  it("skips blank and malformed lines", () => {
    expect(parsePsRss("\n  PID RSS\nabc def\n 7 10240\n")).toEqual([{ pid: 7, rssMb: 10 }]);
  });
});

describe("parseTasklistCsv", () => {
  it("parses the memory column with thousands separators", () => {
    const out = '"chrome.exe","4242","Console","1","1,048,576 K"\r\n';
    expect(parseTasklistCsv(4242, out)).toEqual([{ pid: 4242, rssMb: 1024 }]);
  });

  it("returns [] for the 'no tasks' message", () => {
    expect(
      parseTasklistCsv(4242, "INFO: No tasks are running which match the specified criteria."),
    ).toEqual([]);
  });
});

describe("sampleProcessRss", () => {
  it("uses one ps call for all pids on posix", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return { stdout: " 1 1024\n 2 2048\n" };
    };
    const result = await sampleProcessRss([1, 2], exec, "darwin");
    expect(calls).toEqual([{ file: "ps", args: ["-o", "pid=,rss=", "-p", "1,2"] }]);
    expect(result).toEqual([
      { pid: 1, rssMb: 1 },
      { pid: 2, rssMb: 2 },
    ]);
  });

  it("uses one tasklist call per pid on win32", async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: '"chrome.exe","9","Console","1","2,048 K"\r\n' };
    };
    const result = await sampleProcessRss([9], exec, "win32");
    expect(calls).toEqual([["/FO", "CSV", "/NH", "/FI", "PID eq 9"]]);
    expect(result).toEqual([{ pid: 9, rssMb: 2 }]);
  });

  it("returns [] on empty input without calling exec", async () => {
    let called = false;
    const exec = async () => {
      called = true;
      return { stdout: "" };
    };
    expect(await sampleProcessRss([], exec, "linux")).toEqual([]);
    expect(called).toBe(false);
  });

  it("never rejects when exec fails", async () => {
    const exec = async () => {
      throw new Error("ENOENT");
    };
    expect(await sampleProcessRss([1], exec, "linux")).toEqual([]);
  });
});
