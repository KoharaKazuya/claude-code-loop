/**
 * ccloop の CLI エントリポイント
 *
 * 利用者向けの使い方・サブコマンド一覧・オプションは help.ts(TOP_LEVEL_HELP / SUBCOMMAND_HELP)を
 * 正とする(`ccloop --help` / `ccloop <サブコマンド> --help` の実体もここ)。二重管理を避けるため
 * このコメントには書かない。
 *
 * ランチャーは bin/ccloop。`node "$CCLOOP_HOME/cli.ts"` としてこのファイルを直接実行する
 * (Node の型ストリップを使うため、ビルド成果物は無い)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkNodeVersion, cmdDoctor } from "./doctor.ts";
import { SUBCOMMAND_HELP, TOP_LEVEL_HELP } from "./help.ts";
import { checkSchemaVersion, cmdInit, configReadErrorMessage, ensureAgentDir } from "./init.ts";
import { createPaths, type Paths, RepoRootNotFoundError, resolveRepoRoots } from "./paths.ts";
import { cmdAbandon, cmdAdd, cmdList, cmdRetry, cmdStatus, mainLoop, useRepoRoot } from "./supervisor.ts";
import { cmdWatch } from "./watch.ts";

// checkNodeVersion の実体は doctor.ts(doctor の 1 項目でもあるため)。
// 起動時チェックとしてここでも使うので、CLI の API としてそのまま再公開する。
export { checkNodeVersion };

const USAGE = TOP_LEVEL_HELP;

/** `.agent/` が揃っていることを前提とするサブコマンド(init / doctor / version を除く) */
export const REPO_COMMANDS: readonly string[] = ["run", "status", "watch", "list", "add", "retry", "abandon"];

/**
 * ccloop 自身のバージョン。インストール先にも `package.json` を同梱する前提で、
 * `lib/` から見て 1 つ上の `package.json` を読む。
 * バージョンを持たない開発中のチェックアウトでも落ちないよう、読めなければ "unknown" を返す。
 */
export function readVersion(libDir: string = import.meta.dirname): string {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(libDir, "..", "package.json"), "utf8"));
    const version = (raw as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * グローバルオプション `--repo <path>` を argv 全体から取り除く(純粋)。
 * サブコマンドが独自に `--repo` を使うことは無いため、サブコマンドの前でも後ろでも
 * 受け付ける(`ccloop status --repo <path>` のように後置しても効く)。複数回指定されたら
 * 最後の指定を使う。それ以外の引数は元の順序のままサブコマンドへ渡す。
 */
export function splitGlobalOptions(argv: string[]): { repo?: string; rest: string[] } {
  let repo: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--repo にはパスを指定すること");
      repo = value;
      i += 1;
      continue;
    }
    if (a.startsWith("--repo=")) {
      repo = a.slice("--repo=".length);
      continue;
    }
    rest.push(a);
  }
  return repo === undefined ? { rest } : { repo, rest };
}

/** メッセージを出して終了する(戻り値の型を never にして呼び出し側の制御フローを単純に保つ) */
function die(message: string): never {
  console.error(message);
  process.exit(1);
}

/** doctor 用: リポジトリを特定できなくても診断を続けられるよう、失敗を値で返す */
function tryResolvePaths(repo: string | undefined): { paths: Paths | null; error: string | null } {
  try {
    const { root, agentRoot } = resolveRepoRoots({ repo });
    return { paths: createPaths(root, process.env, agentRoot), error: null };
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) return { paths: null, error: err.message };
    return { paths: null, error: String((err as Error).message) };
  }
}

/**
 * `.agent/config.json` の生データ。読めない・パースできなければ投げる(呼び出し側で
 * `configReadErrorMessage` を使ってエラー終了させる)。
 * 以前はここで失敗を空オブジェクトに倒していたが、それだと壊れた config.json が
 * schemaVersion 0(古い)として扱われ、`init --upgrade` → 書き込めない → 変わらず古い
 * という出口の無いループになっていた。
 */
export function readConfigRaw(paths: Paths): unknown {
  return JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as unknown;
}

export async function main(argv: string[]): Promise<void> {
  const versionError = checkNodeVersion();
  if (versionError !== null) die(versionError);

  let parsed: { repo?: string; rest: string[] };
  try {
    parsed = splitGlobalOptions(argv);
  } catch (err) {
    die(`${String((err as Error).message)}\n${USAGE}`);
  }

  const cmd = parsed.rest[0];
  if (cmd === undefined) die(USAGE);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return;
  }

  // サブコマンド別ヘルプはリポジトリ解決より前に返す(`.agent/` 未配置・repo 未特定でも
  // `ccloop <サブコマンド> --help` が使えるようにするため)
  const subArgs = parsed.rest.slice(1);
  const subHelp = SUBCOMMAND_HELP[cmd];
  if (subHelp !== undefined && (subArgs.includes("--help") || subArgs.includes("-h"))) {
    console.log(subHelp);
    return;
  }

  // version はリポジトリに紐づかないため、ルート解決より前に返す
  // (リポジトリ外から `ccloop version` を叩いても答えられるようにする)
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(readVersion());
    return;
  }

  // doctor は「動かない環境を調べる」ためのコマンドなので、リポジトリを特定できなくても
  // 診断結果を出し切る(ここで die すると一番知りたい情報が出ない)
  if (cmd === "doctor") {
    const resolved = tryResolvePaths(parsed.repo);
    process.exit(cmdDoctor({ paths: resolved.paths, repoError: resolved.error }));
  }

  let paths: Paths;
  try {
    const { root, agentRoot } = resolveRepoRoots({ repo: parsed.repo });
    paths = useRepoRoot(root, agentRoot);
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) die(err.message);
    throw err;
  }

  const args = subArgs;

  // init は `.agent/` を用意する側なので、未配置チェックより前に処理する
  if (cmd === "init") {
    process.exit(await cmdInit(paths, args));
  }

  // `ccloop run` は自身が worktree を作って git 操作(worktree add / merge / branch)を本体
  // (paths.root)に対して行う一方、`.agent/` の読み書きは paths.agentRoot を基準にする。
  // linked worktree 内から `ccloop run` を起動すると両者がずれて壊れるため、他のサブコマンドとは
  // 異なりここで止める(status/list/add/retry/abandon は worktree 内から実行しても安全)。
  if (cmd === "run" && paths.root !== paths.agentRoot) {
    die(
      "ccloop run はリポジトリ本体のワーキングツリーで実行すること" +
        `(今いる worktree: ${paths.agentRoot} / 本体: ${paths.root})。` +
        "本体のワーキングツリーへ移動して実行すること。",
    );
  }

  // 打ち間違いに対して `.agent/` の配置を促すのは筋が悪いので、未配置チェックより前に弾く
  if (!REPO_COMMANDS.includes(cmd)) die(`未知のサブコマンド: ${cmd}\n${USAGE}`);

  // 他のコマンドは `.agent/` が揃っていることが前提。無ければ init と同じ案内を出す
  if (!(await ensureAgentDir(paths))) process.exit(1);

  // config.json のパース失敗はここで確定させる(既定値に倒すと出口の無いループになるため)
  let configRaw: unknown;
  try {
    configRaw = readConfigRaw(paths);
  } catch (err) {
    die(configReadErrorMessage(err));
  }

  // schemaVersion の整合。ツールが古ければ全コマンド停止、config が古ければ run だけ停止する
  const schema = checkSchemaVersion(configRaw, cmd);
  if (schema.message !== null) console.error(schema.message);
  if (!schema.ok) process.exit(1);

  switch (cmd) {
    case "run":
      await mainLoop({ force: args.includes("--force") });
      break;
    case "status":
      cmdStatus(args);
      break;
    case "watch":
      try {
        await cmdWatch(args);
      } catch (err) {
        die(String((err as Error).message));
      }
      break;
    case "list":
      cmdList(args);
      break;
    case "add":
      cmdAdd(args);
      break;
    case "retry":
      cmdRetry(args);
      break;
    case "abandon":
      cmdAbandon(args);
      break;
  }
}

// 直接実行されたときだけ走らせる(テストからの import では実行しない)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2));
}
