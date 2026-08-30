import { describe, expect, it } from "vitest";
import { detectRateLimit, detectSessionRateLimit } from "./ratelimit.ts";

describe("detectRateLimit", () => {
  it("exitCode 0 はレートリミットとみなさない", () => {
    expect(detectRateLimit("You've hit your session limit · resets 9:20am (UTC)", 0)).toBe(false);
  });

  it("レートリミットと無関係な失敗は検出しない", () => {
    expect(detectRateLimit("Error: something went wrong", 1)).toBe(false);
  });

  it("session limit / weekly limit の文言を検出する", () => {
    expect(detectRateLimit("You've hit your session limit · resets 9:20am (UTC)", 1)).toBe(true);
    expect(detectRateLimit("You've hit your weekly limit · resets Aug 15, 9am (UTC)", 1)).toBe(true);
  });

  it("旧形式(usage limit)や 429 も検出する", () => {
    expect(detectRateLimit("Claude AI usage limit reached|1765000000", 1)).toBe(true);
    expect(detectRateLimit("429 Too Many Requests", 1)).toBe(true);
  });
});

describe("detectSessionRateLimit", () => {
  it("タイムアウトかつ stderr に上限文言があれば検出する", () => {
    expect(
      detectSessionRateLimit({
        stdout: "",
        stderr: "You've hit your session limit · resets 9:20am (UTC)",
        exitCode: null,
        timedOut: true,
      }),
    ).toBe(true);
  });

  it("タイムアウト時は stdout の上限文言を見ない(CLI 由来ではないため)", () => {
    expect(
      detectSessionRateLimit({
        stdout: "You've hit your session limit · resets 9:20am (UTC)",
        stderr: "Error: something unrelated",
        exitCode: null,
        timedOut: true,
      }),
    ).toBe(false);
  });

  it("タイムアウトでなければ従来どおり stdout も判定対象にする", () => {
    expect(
      detectSessionRateLimit({
        stdout: "You've hit your session limit · resets 9:20am (UTC)",
        stderr: "",
        exitCode: 1,
        timedOut: false,
      }),
    ).toBe(true);
  });

  it("exitCode 0 はレートリミットとみなさない", () => {
    expect(
      detectSessionRateLimit({
        stdout: "You've hit your session limit · resets 9:20am (UTC)",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    ).toBe(false);
  });
});
