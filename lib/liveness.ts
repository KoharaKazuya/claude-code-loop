/**
 * `ccloop run`(ループ本体)が生きているかを判定する。
 *
 * `ccloop status` で実行中のタスクが 0 件のとき、それが「手が空いている」のか
 * 「ループ本体が落ちている」のかは、タスクの状態だけからは区別できない。そこで
 * `ccloop run` は自分の PID と心拍を state ディレクトリへ記録し、`status` 側はその記録を
 * 読んで生死を判定する。
 *
 * ただし記録が残っているだけでは異常終了(process.exit・kill -9 等)と区別できない。
 * そのため PID の存在確認(isProcessAlive)と心拍の鮮度(heartbeatAt)を併用し、
 * どちらも満たす場合のみ「動いている」と判定する。
 */

import * as fs from "node:fs";
import * as os from "node:os";

/** `ccloop run` が状態ディレクトリへ書く生存記録 */
export interface RunnerRecord {
  /** run プロセスの PID */
  pid: number;
  /** run プロセスの起動時刻 (ISO 8601) */
  startedAt: string;
  /** 最後に心拍を書いた時刻 (ISO 8601) */
  heartbeatAt: string;
  /** 記録したホスト名。別マシン・別コンテナの状態を読んだときに PID 判定を当てにしないための目印 */
  host: string;
  /** 心拍を書く想定間隔 (ms)。鮮度のしきい値をこの値から導く */
  heartbeatIntervalMs: number;
}

export type LoopLiveness =
  | { status: "running"; pid: number; startedAt: string; heartbeatAt: string }
  | { status: "stopped"; reason: "no-record" }
  | { status: "stopped"; reason: "process-gone"; pid: number; startedAt: string; heartbeatAt: string }
  | { status: "unknown"; reason: "heartbeat-stale"; pid: number; startedAt: string; heartbeatAt: string }
  | {
      status: "unknown";
      reason: "foreign-host";
      pid: number;
      startedAt: string;
      heartbeatAt: string;
      host: string;
    };

/** 心拍を「古い」とみなすしきい値の下限 (ms)。心拍間隔が短くても最低このぶんは待つ */
const MIN_STALE_THRESHOLD_MS = 300_000;

/** heartbeatIntervalMs が記録に欠けている/不正なときに補う既定値 (ms) */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * pid が生きているか。`process.kill(pid, 0)` はシグナルを送らず存在確認だけ行う。
 * ESRCH(該当プロセスなし)は false、EPERM(存在するが権限が無いだけ)は true として扱う。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * file から RunnerRecord を読む。存在しない・壊れている・必須フィールドの型が合わない場合は
 * すべて null を返す(status 表示のためのものなので例外を投げない)。
 */
export function readRunnerRecord(file: string): RunnerRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  const pid = r.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0 || !Number.isInteger(pid)) return null;
  if (!isNonEmptyString(r.startedAt) || !isNonEmptyString(r.heartbeatAt) || !isNonEmptyString(r.host)) {
    return null;
  }
  const rawInterval = r.heartbeatIntervalMs;
  const heartbeatIntervalMs =
    typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval > 0
      ? rawInterval
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
  return {
    pid,
    startedAt: r.startedAt,
    heartbeatAt: r.heartbeatAt,
    host: r.host,
    heartbeatIntervalMs,
  };
}

/**
 * record を file へアトミックに書く(`file + ".tmp"` へ書いてから rename)。
 * 生存表示のためだけの記録が run 本体を落としてはならないため、失敗は握りつぶす。
 */
export function writeRunnerRecord(file: string, record: RunnerRecord): void {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    // 生存記録の書き込み失敗で run 本体を止めない
  }
}

/** file を削除する。失敗は握りつぶす(clear もあくまで表示のための後始末)。 */
export function clearRunnerRecord(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 握りつぶす
  }
}

export interface LivenessDeps {
  isAlive?: (pid: number) => boolean;
  hostname?: string;
}

/**
 * 生存記録から `ccloop run` の生死を判定する。最も避けたいのは「動いていないのに動いていると
 * 出す」誤りなので、以下の順で確認し、少しでも疑わしければ running 以外を返す。
 *
 * 1. 記録が無ければ stopped/no-record
 * 2. ホスト名が一致しなければ unknown/foreign-host(別マシンの記録では PID 確認が意味を持たない)
 * 3. PID が存在しなければ stopped/process-gone(異常終了で記録だけ残ったケース)
 * 4. 心拍が古ければ unknown/heartbeat-stale(PID の使い回しの可能性を排除できないため running とはしない)
 * 5. それ以外は running
 */
export function evaluateLoopLiveness(
  record: RunnerRecord | null,
  now: Date,
  deps: LivenessDeps = {},
): LoopLiveness {
  if (record === null) return { status: "stopped", reason: "no-record" };

  const hostname = deps.hostname ?? os.hostname();
  if (record.host !== hostname) {
    return {
      status: "unknown",
      reason: "foreign-host",
      pid: record.pid,
      startedAt: record.startedAt,
      heartbeatAt: record.heartbeatAt,
      host: record.host,
    };
  }

  const isAlive = deps.isAlive ?? isProcessAlive;
  if (!isAlive(record.pid)) {
    return {
      status: "stopped",
      reason: "process-gone",
      pid: record.pid,
      startedAt: record.startedAt,
      heartbeatAt: record.heartbeatAt,
    };
  }

  const staleThresholdMs = Math.max(record.heartbeatIntervalMs * 3, MIN_STALE_THRESHOLD_MS);
  const heartbeatMs = Date.parse(record.heartbeatAt);
  const isStale = Number.isNaN(heartbeatMs) || now.getTime() - heartbeatMs > staleThresholdMs;
  if (isStale) {
    return {
      status: "unknown",
      reason: "heartbeat-stale",
      pid: record.pid,
      startedAt: record.startedAt,
      heartbeatAt: record.heartbeatAt,
    };
  }

  return {
    status: "running",
    pid: record.pid,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt,
  };
}

/** `LoopLiveness` を人間向けの 1 行へ整形する(装飾なしのプレーン文字列)。 */
export function describeLoopLiveness(l: LoopLiveness): string {
  switch (l.status) {
    case "running":
      return `ループ本体: 動いています (ccloop run / PID ${l.pid} / 起動 ${l.startedAt})`;
    case "stopped":
      if (l.reason === "no-record") {
        return "ループ本体: 動いていません (ccloop run が起動していません)";
      }
      return (
        `ループ本体: 動いていません (PID ${l.pid} のプロセスが見つかりません。` +
        "前回の ccloop run は異常終了した可能性があります)"
      );
    case "unknown":
      if (l.reason === "heartbeat-stale") {
        return `ループ本体: 不明 (PID ${l.pid} は存在しますが ${l.heartbeatAt} から応答がありません)`;
      }
      return `ループ本体: 不明 (この状態は別のホスト ${l.host} で記録されました。最終応答 ${l.heartbeatAt})`;
  }
}
