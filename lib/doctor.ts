/**
 * `ccloop doctor`(実行環境の自己診断)
 *
 * ccloop は DevContainer feature として配られ、git / Node.js / claude CLI の存在は
 * インストール時に検査しない(feature の実行順やベースイメージ次第で、その時点では
 * 揃っていないことがあるため)。代わりに実行時にここでまとめて確認する。
 *
 * doctor は**利用側リポジトリに対して副作用を持たない**(state ディレクトリは作成する)。
 * `.agent/` が無くても勝手に配置せず、✗ と `ccloop init` の案内を出すだけにする
 * (診断のつもりで実行してリポジトリが書き換わると困るため)。
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfigFrom } from "./config.ts";
import { configReadErrorMessage } from "./init.ts";
import { compareSchemaVersion, CURRENT_SCHEMA_VERSION, readSchemaVersion } from "./migrations.ts";
import { AGENT_DIR_NAME, ccloopHome, type Paths } from "./paths.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  /** 一言の補足(バージョン文字列、パス、対処の案内など) */
  detail: string;
  /** false なら ✗ でも終了コードを 1 にしない */
  required: boolean;
}

/** 外部コマンドの実行結果(テストから差し替えられるよう関数として切り出す) */
export interface CommandProbe {
  ok: boolean;
  /** 標準出力の 1 行目(トリム済み)。失敗時は理由 */
  output: string;
  /**
   * ok=false のときの失敗の種類。"not-found": コマンド自体が起動できなかった(ENOENT 等の spawn 失敗)。
   * "exit": コマンドは起動できたが非ゼロ終了した(≒ 実行できたが失敗した)。
   * 両者を区別せず一律「見つからない」と表示すると、実際には存在するが失敗しているだけのコマンドの
   * 診断を誤らせるため分ける。
   */
  failure?: "not-found" | "exit";
  /** failure が "exit" のときの終了コード */
  exitCode?: number | null;
}

export type ProbeFn = (command: string, args: string[]) => CommandProbe;

/** `<command> <args>` を実行して 1 行目を取る。存在しない・失敗したら ok=false */
export const probeCommand: ProbeFn = (command, args) => {
  const res = spawnSync(command, args, { encoding: "utf8" });
  if (res.error !== undefined) return { ok: false, output: res.error.message, failure: "not-found" };
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim().split("\n")[0] ?? "";
    return {
      ok: false,
      output: stderr === "" ? `終了コード ${String(res.status)}` : stderr,
      failure: "exit",
      exitCode: res.status,
    };
  }
  return { ok: true, output: ((res.stdout ?? "").trim().split("\n")[0] ?? "").trim() };
};

/**
 * Node の型ストリップ(.ts の直接実行)が使えるバージョンか検査する(純粋)。
 * 使えないなら案内メッセージ、問題なければ null。
 * 型ストリップが完全に無効な Node では cli.ts 自体を読み込めないため、この検査は
 * 「読み込めたが挙動が怪しいバージョン」への保険であり、最後の砦ではない。
 */
export function checkNodeVersion(version: string = process.versions.node): string | null {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  const major = Number.isNaN(parts[0]) ? 0 : parts[0];
  const minor = Number.isNaN(parts[1]) ? 0 : parts[1];
  if (major >= 24) return null;
  if (major === 22 && minor >= 18) return null;
  return (
    `ccloop は Node.js の型ストリップを使うため Node ^22.18.0 || >=24.0.0 が必要(現在 ${version})。` +
    "Node をアップグレードすること"
  );
}

/** state ディレクトリへ実際に書けるか(作成 → 削除まで試す) */
function probeWritable(dir: string): CommandProbe {
  const file = path.join(dir, `.doctor-${String(process.pid)}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "");
    fs.rmSync(file, { force: true });
    return { ok: true, output: dir };
  } catch (err) {
    return { ok: false, output: `${dir}: ${String((err as Error).message)}` };
  }
}

/** `.agent/` の有無と schemaVersion の整合を 1 項目にまとめる */
function checkAgentDir(paths: Paths | null): CheckResult {
  const name = `${AGENT_DIR_NAME}/`;
  if (paths === null) return { name, ok: false, detail: "対象リポジトリが不明のため確認できない", required: true };
  if (!fs.existsSync(paths.goalPath) || !fs.existsSync(paths.configPath)) {
    return { name, ok: false, detail: "未配置(または不完全)。`ccloop init` を実行すること", required: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as unknown;
  } catch (err) {
    return { name, ok: false, detail: configReadErrorMessage(err), required: true };
  }
  const version = readSchemaVersion(raw);
  switch (compareSchemaVersion(version)) {
    case "tool-outdated":
      return {
        name,
        ok: false,
        detail: `schemaVersion ${version} は ccloop の対応版数 ${CURRENT_SCHEMA_VERSION} より新しい。ccloop を更新すること`,
        required: true,
      };
    case "config-outdated":
      return {
        name,
        ok: false,
        detail: `schemaVersion ${version} が古い(対応版数 ${CURRENT_SCHEMA_VERSION})。\`ccloop init --upgrade\` を実行すること`,
        required: true,
      };
    default:
      return { name, ok: true, detail: `${paths.agentDir} (schemaVersion ${version})`, required: true };
  }
}

export interface DoctorOptions {
  /** 対象リポジトリ。解決できなかったときは null */
  paths: Paths | null;
  /** 対象リポジトリを解決できなかった理由 */
  repoError?: string | null;
  home?: string;
  nodeVersion?: string;
  probe?: ProbeFn;
}

/** 診断結果を組み立てる(表示と終了コードの決定は呼び出し側) */
export function collectChecks(opts: DoctorOptions): CheckResult[] {
  const probe = opts.probe ?? probeCommand;
  const home = opts.home ?? ccloopHome();
  const nodeVersion = opts.nodeVersion ?? process.versions.node;

  const git = probe("git", ["--version"]);
  const nodeError = checkNodeVersion(nodeVersion);
  // claude の起動コマンドは config で差し替えられる。実際に使われるコマンドを診断する。
  // config.json が無い場合は素の "claude" にフォールバックする。診断は `.agent/` 未配置でも
  // 動く必要があるため。config.json はあるが項目が不正な場合は loadConfigFrom が例外を投げるので、
  // doctor が落ちないよう捕まえて「失敗したチェック」として表示する(claudeCommand の判定は
  // "claude" へフォールバックし、他のチェックは続行する)。
  let claudeCommand = "claude";
  let configError: string | null = null;
  if (opts.paths !== null) {
    try {
      const configured = loadConfigFrom(opts.paths.root).claudeCommand;
      claudeCommand = typeof configured === "string" && configured !== "" ? configured : "claude";
    } catch (err) {
      configError = String((err as Error)?.message ?? err);
    }
  }
  const claude = probe(claudeCommand, ["--version"]);

  const results: CheckResult[] = [];
  if (opts.paths === null) {
    results.push({
      name: "対象リポジトリ",
      ok: false,
      detail: opts.repoError ?? "特定できない",
      required: true,
    });
  } else {
    results.push({ name: "対象リポジトリ", ok: true, detail: opts.paths.root, required: true });
  }
  results.push({ name: "git", ok: git.ok, detail: git.ok ? git.output : `見つからない: ${git.output}`, required: true });
  results.push({
    name: "node",
    ok: nodeError === null,
    detail: nodeError === null ? `v${nodeVersion}` : nodeError,
    required: true,
  });
  results.push({
    name: `claude (${claudeCommand})`,
    ok: claude.ok,
    detail: claude.ok
      ? claude.output
      : claude.failure === "exit"
        ? `実行できたが失敗した(exit ${String(claude.exitCode ?? "?")}): ${claude.output}`
        : `見つからない: ${claude.output}`,
    required: true,
  });
  results.push(checkAgentDir(opts.paths));
  if (configError !== null) {
    results.push({ name: `${AGENT_DIR_NAME}/config.json の内容`, ok: false, detail: configError, required: true });
  }
  if (opts.paths === null) {
    results.push({ name: "state ディレクトリ", ok: false, detail: "対象リポジトリが不明のため確認できない", required: true });
  } else {
    const writable = probeWritable(opts.paths.stateDir);
    results.push({
      name: "state ディレクトリ",
      ok: writable.ok,
      detail: writable.ok ? `書き込み可 ${writable.output}` : `書き込めない: ${writable.output}`,
      required: true,
    });
  }
  const homeOk = fs.existsSync(path.join(home, "cli.ts"));
  results.push({
    name: "CCLOOP_HOME",
    ok: homeOk,
    detail: homeOk ? home : `${home} に cli.ts が無い(インストールが壊れている)`,
    required: true,
  });
  return results;
}

/** 1 項目の表示行 */
export function formatCheck(r: CheckResult): string {
  return `${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`;
}

/** 必須項目に ✗ があるか */
export function hasRequiredFailure(results: CheckResult[]): boolean {
  return results.some((r) => !r.ok && r.required);
}

/** 診断を実行して表示する。戻り値はプロセスの終了コード */
export function cmdDoctor(opts: DoctorOptions): number {
  const results = collectChecks(opts);
  for (const r of results) console.log(formatCheck(r));
  if (!hasRequiredFailure(results)) return 0;
  console.error("必須項目に問題がある。上の ✗ を解消すること");
  return 1;
}
