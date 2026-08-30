import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRunnerRecord,
  describeLoopLiveness,
  evaluateLoopLiveness,
  evaluateStartupGuard,
  isProcessAlive,
  parseProcStatStartTime,
  readRunnerRecord,
  writeRunnerRecord,
  type LoopLiveness,
  type RunnerRecord,
  type RunnerRecordRead,
} from "./liveness.ts";

const asRead = (r: RunnerRecord): RunnerRecordRead => ({ kind: "record", record: r });

describe("evaluateLoopLiveness", () => {
  const NOW = new Date("2026-08-30T12:00:00.000Z");
  const HOST = "host-a";

  function record(overrides: Partial<RunnerRecord> = {}): RunnerRecord {
    return {
      pid: 1234,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T11:59:00.000Z",
      host: HOST,
      heartbeatIntervalMs: 5_000,
      ...overrides,
    };
  }

  it("記録が無ければ stopped/no-record", () => {
    const result = evaluateLoopLiveness({ kind: "absent" }, NOW, { hostname: HOST, isAlive: () => true });
    expect(result).toEqual({ status: "stopped", reason: "no-record" });
  });

  it("記録が読めなければ isAlive が true でも unknown/record-unreadable", () => {
    const result = evaluateLoopLiveness(
      { kind: "unreadable", detail: "内容が JSON として壊れています" },
      NOW,
      { hostname: HOST, isAlive: () => true },
    );
    expect(result).toEqual({
      status: "unknown",
      reason: "record-unreadable",
      detail: "内容が JSON として壊れています",
    });
  });

  it("ホスト名が一致しなければ isAlive が true でも unknown/foreign-host が優先される", () => {
    const result = evaluateLoopLiveness(asRead(record({ host: "other-host" })), NOW, {
      hostname: HOST,
      isAlive: () => true,
    });
    expect(result.status).toBe("unknown");
    expect(result).toMatchObject({ reason: "foreign-host", host: "other-host" });
  });

  it("同ホストだが異常終了で記録が残ったまま(PID が存在しない)なら stopped/process-gone", () => {
    const result = evaluateLoopLiveness(asRead(record()), NOW, { hostname: HOST, isAlive: () => false });
    expect(result).toMatchObject({ status: "stopped", reason: "process-gone", pid: 1234 });
  });

  it("同ホスト・PID 存在・心拍がしきい値を超えて古ければ unknown/heartbeat-stale", () => {
    const result = evaluateLoopLiveness(
      asRead(record({ heartbeatAt: "2026-08-30T11:00:00.000Z" })), // 1 時間前
      NOW,
      { hostname: HOST, isAlive: () => true },
    );
    expect(result).toMatchObject({ status: "unknown", reason: "heartbeat-stale" });
  });

  it("同ホスト・PID 存在・心拍が新しければ running", () => {
    const result = evaluateLoopLiveness(asRead(record()), NOW, { hostname: HOST, isAlive: () => true });
    expect(result).toEqual({
      status: "running",
      pid: 1234,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T11:59:00.000Z",
    });
  });

  it("heartbeatAt がパースできない文字列なら unknown/heartbeat-stale", () => {
    const result = evaluateLoopLiveness(asRead(record({ heartbeatAt: "not-a-date" })), NOW, {
      hostname: HOST,
      isAlive: () => true,
    });
    expect(result).toMatchObject({ status: "unknown", reason: "heartbeat-stale" });
  });

  it("しきい値の下限は 5 分。heartbeatIntervalMs=1000 でも 4 分前の心拍なら running", () => {
    const fourMinutesAgo = new Date(NOW.getTime() - 4 * 60_000).toISOString();
    const result = evaluateLoopLiveness(
      asRead(record({ heartbeatIntervalMs: 1_000, heartbeatAt: fourMinutesAgo })),
      NOW,
      { hostname: HOST, isAlive: () => true },
    );
    expect(result.status).toBe("running");
  });

  it("procStartToken が記録と食い違えば PID の使い回しとみなし stopped/process-gone", () => {
    const result = evaluateLoopLiveness(asRead(record({ procStartToken: "111" })), NOW, {
      hostname: HOST,
      isAlive: () => true,
      readProcStartToken: () => "222",
    });
    expect(result).toMatchObject({ status: "stopped", reason: "process-gone", pid: 1234 });
  });

  it("procStartToken が記録と一致すれば従来どおり running", () => {
    const result = evaluateLoopLiveness(asRead(record({ procStartToken: "111" })), NOW, {
      hostname: HOST,
      isAlive: () => true,
      readProcStartToken: () => "111",
    });
    expect(result.status).toBe("running");
  });

  it("記録に procStartToken が無ければ照合をスキップして従来どおりの判定になる", () => {
    const result = evaluateLoopLiveness(asRead(record()), NOW, {
      hostname: HOST,
      isAlive: () => true,
      readProcStartToken: () => "222", // 現在値は取れるが記録に無いので使われない
    });
    expect(result.status).toBe("running");
  });

  it("現在の procStartToken が取れない(null)場合も照合をスキップして従来どおりの判定になる", () => {
    const result = evaluateLoopLiveness(asRead(record({ procStartToken: "111" })), NOW, {
      hostname: HOST,
      isAlive: () => true,
      readProcStartToken: () => null,
    });
    expect(result.status).toBe("running");
  });
});

describe("parseProcStatStartTime", () => {
  it("通常の /proc/<pid>/stat 形式から starttime(22 番目のフィールド)を取り出せる", () => {
    // 3 番目(state)以降を 1, 2, 3, ... と割り振ると、20 番目が starttime(22 番目のフィールド)
    const fields3to22 = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const stat = `1234 (bash) ${fields3to22.join(" ")}`;
    expect(parseProcStatStartTime(stat)).toBe("20");
  });

  it("comm に空白や括弧を含んでいても正しく starttime を取り出せる", () => {
    const fields3to22 = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const stat = `1234 (my (weird) proc) ${fields3to22.join(" ")}`;
    expect(parseProcStatStartTime(stat)).toBe("20");
  });

  it("')' が無い壊れた内容は null", () => {
    expect(parseProcStatStartTime("1234 bash S 1 2 3")).toBeNull();
  });

  it("フィールド数が足りない場合は null", () => {
    expect(parseProcStatStartTime("1234 (bash) S 1 2 3")).toBeNull();
  });

  it("starttime にあたる位置が数字以外なら null", () => {
    const fields3to22 = Array.from({ length: 20 }, (_, i) => String(i + 1));
    fields3to22[19] = "not-a-number"; // 0-indexed 19 番目 = starttime(22 番目のフィールド)
    const stat = `1234 (bash) ${fields3to22.join(" ")}`;
    expect(parseProcStatStartTime(stat)).toBeNull();
  });
});

describe("readRunnerRecord / writeRunnerRecord / clearRunnerRecord", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-liveness-test-"));
    file = path.join(dir, "runner.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("write したものを read すると同じ内容が戻る", () => {
    const rec: RunnerRecord = {
      pid: 4321,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T10:05:00.000Z",
      host: "host-a",
      heartbeatIntervalMs: 3_000,
    };
    writeRunnerRecord(file, rec);
    expect(readRunnerRecord(file)).toEqual({ kind: "record", record: rec });
  });

  it("存在しないファイルは kind: absent", () => {
    expect(readRunnerRecord(path.join(dir, "nope.json"))).toEqual({ kind: "absent" });
  });

  it("ディレクトリを指すパス(EISDIR)は kind: unreadable", () => {
    const result = readRunnerRecord(dir);
    expect(result.kind).toBe("unreadable");
  });

  it("壊れた JSON は kind: unreadable", () => {
    fs.writeFileSync(file, "{ not json");
    const result = readRunnerRecord(file);
    expect(result).toEqual({ kind: "unreadable", detail: "内容が JSON として壊れています" });
  });

  it("pid が文字列など不正なら kind: unreadable", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: "not-a-number",
        startedAt: "2026-08-30T10:00:00.000Z",
        heartbeatAt: "2026-08-30T10:05:00.000Z",
        host: "host-a",
        heartbeatIntervalMs: 3_000,
      }),
    );
    const result = readRunnerRecord(file);
    expect(result).toEqual({ kind: "unreadable", detail: "記録の形式が想定と異なります" });
  });

  it("procStartToken を含めて write したものを read すると同じ内容が戻る", () => {
    const rec: RunnerRecord = {
      pid: 4321,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T10:05:00.000Z",
      host: "host-a",
      heartbeatIntervalMs: 3_000,
      procStartToken: "98765",
    };
    writeRunnerRecord(file, rec);
    expect(readRunnerRecord(file)).toEqual({ kind: "record", record: rec });
  });

  it("procStartToken が文字列以外(不正な型)なら kind: unreadable", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: 4321,
        startedAt: "2026-08-30T10:00:00.000Z",
        heartbeatAt: "2026-08-30T10:05:00.000Z",
        host: "host-a",
        heartbeatIntervalMs: 3_000,
        procStartToken: 98765,
      }),
    );
    const result = readRunnerRecord(file);
    expect(result).toEqual({ kind: "unreadable", detail: "記録の形式が想定と異なります" });
  });

  it("heartbeatIntervalMs が欠落していたら 60_000 で補われる", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: 4321,
        startedAt: "2026-08-30T10:00:00.000Z",
        heartbeatAt: "2026-08-30T10:05:00.000Z",
        host: "host-a",
      }),
    );
    expect(readRunnerRecord(file)).toMatchObject({ record: { heartbeatIntervalMs: 60_000 } });
  });

  it("clear した後は kind: absent", () => {
    writeRunnerRecord(file, {
      pid: 4321,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T10:05:00.000Z",
      host: "host-a",
      heartbeatIntervalMs: 3_000,
    });
    clearRunnerRecord(file);
    expect(readRunnerRecord(file)).toEqual({ kind: "absent" });
  });
});

describe("describeLoopLiveness", () => {
  it("record-unreadable は「不明」を含み detail を含む文言になる", () => {
    const text = describeLoopLiveness({
      status: "unknown",
      reason: "record-unreadable",
      detail: "内容が JSON として壊れています",
    });
    expect(text).toContain("不明");
    expect(text).toContain("内容が JSON として壊れています");
  });
});

describe("evaluateStartupGuard", () => {
  it("running は拒否し、message は空でない", () => {
    const l: LoopLiveness = {
      status: "running",
      pid: 1234,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T11:59:00.000Z",
    };
    const result = evaluateStartupGuard(l);
    expect(result.allow).toBe(false);
    expect(result).toMatchObject({ allow: false });
    if (!result.allow) expect(result.message.length).toBeGreaterThan(0);
  });

  it("unknown/heartbeat-stale は拒否し、message は空でない(PID が生きている可能性があるため)", () => {
    const l: LoopLiveness = {
      status: "unknown",
      reason: "heartbeat-stale",
      pid: 1234,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T11:00:00.000Z",
    };
    const result = evaluateStartupGuard(l);
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.message.length).toBeGreaterThan(0);
  });

  it("stopped/no-record は許可し、warning は無い", () => {
    const l: LoopLiveness = { status: "stopped", reason: "no-record" };
    const result = evaluateStartupGuard(l);
    expect(result).toEqual({ allow: true, warning: null });
  });

  it("stopped/process-gone は許可するが、異常終了の旨を warning に出す", () => {
    const l: LoopLiveness = {
      status: "stopped",
      reason: "process-gone",
      pid: 1234,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T11:00:00.000Z",
    };
    const result = evaluateStartupGuard(l);
    expect(result.allow).toBe(true);
    if (result.allow) expect(result.warning).not.toBeNull();
  });

  it("unknown/record-unreadable は必ず許可する(記録が壊れただけで起動不能にしないため)", () => {
    const l: LoopLiveness = { status: "unknown", reason: "record-unreadable", detail: "内容が JSON として壊れています" };
    const result = evaluateStartupGuard(l);
    expect(result.allow).toBe(true);
    if (result.allow) expect(result.warning).not.toBeNull();
  });

  it("unknown/foreign-host は許可するが警告を出す(別ホストでは PID 確認が意味を持たないため)", () => {
    const l: LoopLiveness = {
      status: "unknown",
      reason: "foreign-host",
      pid: 1234,
      startedAt: "2026-08-30T10:00:00.000Z",
      heartbeatAt: "2026-08-30T11:00:00.000Z",
      host: "host-b",
    };
    const result = evaluateStartupGuard(l);
    expect(result.allow).toBe(true);
    if (result.allow) expect(result.warning).not.toBeNull();
  });
});

describe("isProcessAlive", () => {
  it("自分自身の PID は true", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("PID の上限を超えた値(ESRCH になる)は false", () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it("0 は false", () => {
    expect(isProcessAlive(0)).toBe(false);
  });

  it("負値は false", () => {
    expect(isProcessAlive(-1)).toBe(false);
  });

  it("NaN は false", () => {
    expect(isProcessAlive(NaN)).toBe(false);
  });
});
