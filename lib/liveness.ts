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
  /**
   * 記録した時点の `/proc/<pid>/stat` の starttime(boot からの clock tick 数)を、
   * 数値変換せず生の文字列トークンのまま保持したもの。同一 boot 内では PID とこの値の組が
   * プロセスを一意に識別するため、PID の使い回し(記録を書いたプロセスが死んだ直後に
   * 別プロセスが同じ PID を取得するケース)を検出できる。取得できない環境(非 Linux 等)では省略する。
   */
  procStartToken?: string;
}

/** 生存記録ファイルの読み取り結果。「無い」と「読めない」を呼び出し側が区別できるようにする */
export type RunnerRecordRead =
  | { kind: "record"; record: RunnerRecord }
  /** ファイルが存在しない(= ccloop run が起動していない) */
  | { kind: "absent" }
  /** ファイルはあるが読めない・記録として使えない(= 生死を判定できない) */
  | { kind: "unreadable"; detail: string };

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
    }
  | { status: "unknown"; reason: "record-unreadable"; detail: string };

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
 * `/proc/<pid>/stat` の内容から starttime(22 番目のフィールド)を取り出す。
 *
 * 2 番目のフィールド(comm)は括弧で囲まれ、中に空白や `)` 自体を含みうる(例:
 * `1234 (my (weird) proc) S ...`)。そのため先頭からの位置で数えず、**最後の `)` より後ろ**を
 * 空白で分割して数える。最後の `)` の直後の先頭要素が 3 番目のフィールド(state)なので、
 * その並びの 20 番目(0-indexed で 19 番目)が starttime にあたる。
 *
 * 取り出した値が数字だけで構成されていなければ(壊れた内容・想定外の形式)null を返す。
 */
export function parseProcStatStartTime(stat: string): string | null {
  const lastParen = stat.lastIndexOf(")");
  if (lastParen === -1) return null;
  const rest = stat.slice(lastParen + 1).trim();
  if (rest.length === 0) return null;
  const fields = rest.split(/\s+/);
  const token = fields[19];
  if (token === undefined || !/^[0-9]+$/.test(token)) return null;
  return token;
}

/**
 * pid の起動時刻トークン(procStartToken)を `/proc/<pid>/stat` から読む。
 * 読めない・形式が違う・Linux 以外などで取得できない場合はすべて null を返す(例外を投げない)。
 */
export function readProcStartToken(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return parseProcStatStartTime(stat);
  } catch {
    return null;
  }
}

/**
 * file から RunnerRecord を読む。
 *
 * ファイルが存在しない場合(ENOENT)は `{ kind: "absent" }`(= ccloop run が起動していない)。
 * それ以外の読み取りエラー・JSON パース失敗・必須フィールドの型不一致は、いずれも記録として
 * 使えない状態であり「生死を判定できない」ことを表す `{ kind: "unreadable", detail }` を返す
 * (status 表示のためのものなので例外は投げない)。
 */
export function readRunnerRecord(file: string): RunnerRecordRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", detail: code ? `読み取りエラー (${code})` : "読み取りエラー" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", detail: "内容が JSON として壊れています" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "unreadable", detail: "記録の形式が想定と異なります" };
  }
  const r = parsed as Record<string, unknown>;
  const pid = r.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0 || !Number.isInteger(pid)) {
    return { kind: "unreadable", detail: "記録の形式が想定と異なります" };
  }
  if (!isNonEmptyString(r.startedAt) || !isNonEmptyString(r.heartbeatAt) || !isNonEmptyString(r.host)) {
    return { kind: "unreadable", detail: "記録の形式が想定と異なります" };
  }
  const rawInterval = r.heartbeatIntervalMs;
  const heartbeatIntervalMs =
    typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval > 0
      ? rawInterval
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const procStartToken = r.procStartToken;
  if (procStartToken !== undefined && !isNonEmptyString(procStartToken)) {
    return { kind: "unreadable", detail: "記録の形式が想定と異なります" };
  }
  return {
    kind: "record",
    record: {
      pid,
      startedAt: r.startedAt,
      heartbeatAt: r.heartbeatAt,
      host: r.host,
      heartbeatIntervalMs,
      ...(procStartToken !== undefined ? { procStartToken } : {}),
    },
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
  readProcStartToken?: (pid: number) => string | null;
}

/**
 * 生存記録から `ccloop run` の生死を判定する。最も避けたいのは「動いていないのに動いていると
 * 出す」誤りなので、以下の順で確認し、少しでも疑わしければ running 以外を返す。
 *
 * 1. 記録が無ければ stopped/no-record
 * 2. 記録が読めなければ unknown/record-unreadable(生死を判定できないため)
 * 3. ホスト名が一致しなければ unknown/foreign-host(別マシンの記録では PID 確認が意味を持たない)
 * 4. PID が存在しなければ stopped/process-gone(異常終了で記録だけ残ったケース)
 * 5. PID は存在するが起動時刻トークン(procStartToken)が記録と食い違えば stopped/process-gone
 *    (記録を書いたプロセスが finally を経ずに死に、その直後に別プロセスが同じ PID を取得したケース。
 *    記録・現在のどちらかでトークンが取れない場合は照合をスキップし、従来どおりの判定にする)
 * 6. 心拍が古ければ unknown/heartbeat-stale(PID の使い回しの可能性を排除できないため running とはしない)
 * 7. それ以外は running
 */
export function evaluateLoopLiveness(
  read: RunnerRecordRead,
  now: Date,
  deps: LivenessDeps = {},
): LoopLiveness {
  if (read.kind === "absent") return { status: "stopped", reason: "no-record" };
  if (read.kind === "unreadable") {
    return { status: "unknown", reason: "record-unreadable", detail: read.detail };
  }
  const record = read.record;

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

  if (record.procStartToken !== undefined) {
    const readToken = deps.readProcStartToken ?? readProcStartToken;
    const currentToken = readToken(record.pid);
    if (currentToken !== null && currentToken !== record.procStartToken) {
      return {
        status: "stopped",
        reason: "process-gone",
        pid: record.pid,
        startedAt: record.startedAt,
        heartbeatAt: record.heartbeatAt,
      };
    }
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
      if (l.reason === "record-unreadable") {
        return `ループ本体: 不明 (生存記録を読めませんでした: ${l.detail})`;
      }
      return `ループ本体: 不明 (この状態は別のホスト ${l.host} で記録されました。最終応答 ${l.heartbeatAt})`;
  }
}

/** `ccloop run` の起動可否。allow=false なら二重起動とみなして起動を拒否する */
export type StartupGuard = { allow: true; warning: string | null } | { allow: false; message: string };

/**
 * 生存記録から「今 `ccloop run` を起動してよいか」を判定する(副作用なし)。
 *
 * 起動処理(generateSettings・recoverStartup など)は state を無条件に書き換えるため、後発の
 * `ccloop run` がそれらを呼んでしまうと先発プロセスの実行状態を壊す。ここでの判定を、状態を
 * 書き換える前に必ず確認させることでその事故を防ぐ。
 *
 * 判定は「少しでも先発が生きている可能性があれば拒否」に倒す。許可を誤ると実行状態の破壊という
 * 重い代償を伴うが、拒否を誤っても起動をやり直せば済むだけで代償が軽いため、疑わしきは拒否側にする。
 */
export function evaluateStartupGuard(l: LoopLiveness): StartupGuard {
  switch (l.status) {
    case "running":
      // 生死判定の最終結果が running である以上、二重起動そのもの。無条件に拒否する。
      return {
        allow: false,
        message:
          `このリポジトリでは既に ccloop run が動いています (PID ${l.pid} / 起動 ${l.startedAt})。\n` +
          "同じリポジトリに対して ccloop run を同時に 2 つ起動すると、先に動いている方の実行状態が壊れます。\n" +
          "先に停止するか、`ccloop status` で状態を確認してください。\n" +
          "それでもどうしても起動する場合は `ccloop run --force` を使ってください(通常は使わない)。",
      };
    case "unknown":
      if (l.reason === "heartbeat-stale") {
        // PID は存在し、Linux では起動時刻トークンの照合も通っている(evaluateLoopLiveness 参照)。
        // 心拍が止まっているだけで実体は生きている可能性を排除できないため、running と同様に拒否する。
        return {
          allow: false,
          message:
            `PID ${l.pid} の ccloop run から ${l.heartbeatAt} を最後に応答がありませんが、` +
            "プロセス自体はまだ存在します。\n" +
            "応答が止まっているだけで動作中の可能性があるため起動を拒否します。\n" +
            `本当に落ちているなら、先に PID ${l.pid} のプロセスを停止してから起動し直してください。\n` +
            "それでもどうしても起動する場合は `ccloop run --force` を使ってください(通常は使わない)。",
        };
      }
      if (l.reason === "record-unreadable") {
        // 記録が壊れているだけで先発プロセスの生死は分からない。ここで起動を拒否し続けると
        // 記録が壊れたままループを二度と起動できなくなるため、必ず起動を許し警告に留める。
        return {
          allow: true,
          warning: `生存記録を読み取れませんでした (${l.detail})。二重起動の判定ができないまま起動します。`,
        };
      }
      // foreign-host: 別ホスト・別コンテナで記録された PID はこのプロセスからは確認しようがない。
      // 判定不能なので起動は許し、警告だけ出す。
      return {
        allow: true,
        warning: `生存記録が別のホスト (${l.host}) で記録されたものです。二重起動の判定ができないまま起動します。`,
      };
    case "stopped":
      if (l.reason === "no-record") return { allow: true, warning: null };
      // process-gone: 前回の記録はあるが PID (または起動時刻トークン) が食い違う = 異常終了。
      // 起動は許すが、前回が正常に終わっていない旨だけ一言添える。
      return {
        allow: true,
        warning: `前回の ccloop run (PID ${l.pid}) は異常終了した可能性があります。`,
      };
  }
}
