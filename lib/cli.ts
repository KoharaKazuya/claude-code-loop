/**
 * ccloop の CLI エントリポイント
 *
 * 使い方:
 *   ccloop [--repo <path>] <サブコマンド> [引数...]
 *
 * サブコマンド:
 *   run      常駐ループ(自律実行)。停止は Ctrl+C(押すたびに段階が上がる)
 *   status   稼働状況・進捗の要約
 *   watch    status を一定間隔で再描画し続ける: watch [--interval <秒>]
 *   list     タスク一覧
 *   add      タスクを追加する: add "タイトル" [--desc 説明] [--priority N] [--deps T-001,T-002] [--model m]
 *   init     `.agent/` の雛形を配置する: init [--yes] [--upgrade]
 *   doctor   実行環境の自己診断(副作用なし)
 *   version  ccloop 自身のバージョン
 *
 * グローバルオプション:
 *   --repo <path>  対象リポジトリのルート(既定: 環境変数 CCLOOP_REPO、無ければ cwd から上方探索)。
 *                  サブコマンドの前でも後ろでも指定できる(例: `ccloop status --repo <path>`)。
 *
 * ランチャーは bin/ccloop。`node "$CCLOOP_HOME/cli.ts"` としてこのファイルを直接実行する
 * (Node の型ストリップを使うため、ビルド成果物は無い)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { checkNodeVersion, cmdDoctor } from "./doctor.ts";
import { checkSchemaVersion, cmdInit, configReadErrorMessage, ensureAgentDir } from "./init.ts";
import { createPaths, type Paths, RepoRootNotFoundError, resolveRepoRoot } from "./paths.ts";
import { cmdAdd, cmdList, cmdStatus, mainLoop, useRepoRoot } from "./supervisor.ts";
import { cmdWatch } from "./watch.ts";

// checkNodeVersion の実体は doctor.ts(doctor の 1 項目でもあるため)。
// 起動時チェックとしてここでも使うので、CLI の API としてそのまま再公開する。
export { checkNodeVersion };

const USAGE =
  "使い方: ccloop [--repo <path>] <run|status|watch|list|add|init|doctor|version> [引数...]" +
  "(--repo はサブコマンドの後ろでも指定可)";

/** `.agent/` が揃っていることを前提とするサブコマンド(init / doctor / version を除く) */
export const REPO_COMMANDS: readonly string[] = ["run", "status", "watch", "list", "add"];

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
    return { paths: createPaths(resolveRepoRoot({ repo })), error: null };
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
    paths = useRepoRoot(resolveRepoRoot({ repo: parsed.repo }));
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) die(err.message);
    throw err;
  }

  const args = parsed.rest.slice(1);

  // init は `.agent/` を用意する側なので、未配置チェックより前に処理する
  if (cmd === "init") {
    process.exit(await cmdInit(paths, args));
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
      await mainLoop();
      break;
    case "status":
      cmdStatus();
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
  }
}

// 直接実行されたときだけ走らせる(テストからの import では実行しない)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2));
}
