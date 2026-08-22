/**
 * ccloop の CLI エントリポイント
 *
 * 使い方:
 *   ccloop [--repo <path>] <サブコマンド> [引数...]
 *
 * サブコマンド:
 *   run     常駐ループ(自律実行)
 *   once    1 タスク(なければ探索 1 回)だけ実行して終了
 *   add     タスクを追加する: add "タイトル" [--desc 説明] [--priority N] [--deps T-001,T-002] [--model m]
 *   list    タスク一覧
 *   status  稼働状況・進捗の要約
 *   retry   failed / blocked のタスクを ready へ戻す
 *   rotate  .agent/ の状態ファイルのローテーションを手動実行
 *
 * グローバルオプション:
 *   --repo <path>  対象リポジトリのルート(既定: 環境変数 CCLOOP_REPO、無ければ cwd から上方探索)
 *
 * ランチャーは bin/ccloop。`node "$CCLOOP_HOME/cli.ts"` としてこのファイルを直接実行する
 * (Node の型ストリップを使うため、ビルド成果物は無い)。
 */

import * as path from "node:path";
import { RepoRootNotFoundError, resolveRepoRoot } from "./paths.ts";
import {
  cmdAdd,
  cmdList,
  cmdRetry,
  cmdRotate,
  cmdStatus,
  mainLoop,
  useRepoRoot,
} from "./supervisor.ts";

const USAGE = "使い方: ccloop [--repo <path>] <run|once|add|list|status|retry|rotate> [引数...]";

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

  try {
    useRepoRoot(resolveRepoRoot({ repo: parsed.repo }));
  } catch (err) {
    if (err instanceof RepoRootNotFoundError) die(err.message);
    throw err;
  }

  const args = parsed.rest.slice(1);
  switch (cmd) {
    case "run":
      await mainLoop(false);
      break;
    case "once":
      await mainLoop(true);
      break;
    case "add":
      cmdAdd(args);
      break;
    case "list":
      cmdList(args);
      break;
    case "status":
      cmdStatus();
      break;
    case "retry":
      cmdRetry(args);
      break;
    case "rotate":
      cmdRotate();
      break;
    default:
      die(`未知のサブコマンド: ${cmd}\n${USAGE}`);
  }
}

// 直接実行されたときだけ走らせる(テストからの import では実行しない)
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  await main(process.argv.slice(2));
}
