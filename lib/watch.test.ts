import { describe, expect, it } from "vitest";
import { usageOf } from "./help.ts";
import { DEFAULT_WATCH_INTERVAL_MS, MIN_WATCH_INTERVAL_MS, parseWatchArgs, renderFrame } from "./watch.ts";

describe("parseWatchArgs", () => {
  it("引数が無ければ既定の間隔", () => {
    expect(parseWatchArgs([])).toEqual({ intervalMs: DEFAULT_WATCH_INTERVAL_MS });
  });

  it("--interval <秒> を受け付ける", () => {
    expect(parseWatchArgs(["--interval", "5"])).toEqual({ intervalMs: 5_000 });
  });

  it("--interval=<秒> 形式も受け付ける", () => {
    expect(parseWatchArgs(["--interval=2.5"])).toEqual({ intervalMs: 2_500 });
  });

  it("-n も同じ意味で使える", () => {
    expect(parseWatchArgs(["-n", "3"])).toEqual({ intervalMs: 3_000 });
  });

  it("下限より短い指定は下限へ丸める", () => {
    expect(parseWatchArgs(["--interval", "0.01"])).toEqual({ intervalMs: MIN_WATCH_INTERVAL_MS });
  });

  it("値が無い・数値でない・0 以下はエラー", () => {
    expect(() => parseWatchArgs(["--interval"])).toThrow();
    expect(() => parseWatchArgs(["--interval", "abc"])).toThrow();
    expect(() => parseWatchArgs(["--interval", "0"])).toThrow();
    expect(() => parseWatchArgs(["--interval", "-1"])).toThrow();
  });

  it("未知の引数はエラーにする(黙って無視しない)", () => {
    expect(() => parseWatchArgs(["--nope"])).toThrow(/未知の引数/);
  });

  it("未知の引数のエラーメッセージは help.ts の使い方(usageOf)と一致する", () => {
    let message = "";
    try {
      parseWatchArgs(["--bogus"]);
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain(usageOf("watch"));
  });
});

describe("renderFrame", () => {
  const now = new Date("2026-08-22T04:05:06.000Z");

  it("画面クリアで始まり、本文をそのまま含む", () => {
    const frame = renderFrame("本文\n2 行目", now, 1_000);
    expect(frame.startsWith("\x1b[2J\x1b[H")).toBe(true);
    expect(frame).toContain("本文\n2 行目");
  });

  it("更新時刻と間隔と終了方法をフッタに出す", () => {
    const frame = renderFrame("body", now, 2_000);
    expect(frame).toContain("2026-08-22 04:05:06");
    expect(frame).toContain("2.0s ごとに更新");
    expect(frame).toContain("Ctrl+C で終了");
  });

  it("本文はフッタより前に出る", () => {
    const frame = renderFrame("BODY-MARKER", now, 1_000);
    expect(frame.indexOf("BODY-MARKER")).toBeLessThan(frame.indexOf("watch ("));
  });
});
