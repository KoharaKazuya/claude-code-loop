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
 *   version  ccloop 自身のバージョン
 *
 * グローバルオプション:
 *   --repo <path>  対象リポジトリのルート(既定: 環境変数 CCLOOP_REPO、無ければ cwd から上方探索)
 *
 * ランチャーは bin/ccloop。`node "$CCLOOP_HOME/cli.ts"` としてこのファイルを直接実行する
 * (Node の型ストリップを使うため、ビルド成果物は無い)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RepoRootNotFoundError, resolveRepoRoot } from "./paths.ts";
import { cmdAdd, cmdList, cmdStatus, mainLoop, useRepoRoot } from "./supervisor.ts";
import { cmdWatch } from "./watch.ts";

const USAGE = "使い方: ccloop [--repo <path>] <run|status|watch|list|add|version> [引数...]";

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
 * Node の型ストリップ(.ts の直接実行)が使えるバージョンか検査する(純粋)。
 * 使えないなら案内メッセージ、問題なければ null。
 * 型ストリップが完全に無効な Node ではこのファイル自体を読み込めないため、この検査は
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

/**
 * グローバルオプション `--repo <path>` をサブコマンドより前から取り除く(純粋)。
 * サブコマンド以降の引数はサブコマンド自身が解釈するため、そのまま残す。
 */
export function splitGlobalOptions(argv: string[]): { repo?: string; rest: string[] } {
  let repo: string | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
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
    break;
  }
  const rest = argv.slice(i);
  return repo === undefined ? { rest } : { repo, rest };
}

/** メッセージを出して終了する(戻り値の型を never にして呼び出し側の制御フローを単純に保つ) */
function die(message: string): never {
  console.error(message);
  process.exit(1);
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

  try {
    useRepoRoot(resolveRepoRoot({ repo: parsed.repo }));
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) die(err.message);
    throw err;
  }

  const args = parsed.rest.slice(1);
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
    default:
      die(`未知のサブコマンド: ${cmd}\n${USAGE}`);
  }
}

// 直接実行されたときだけ走らせる(テストからの import では実行しない)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2));
}
