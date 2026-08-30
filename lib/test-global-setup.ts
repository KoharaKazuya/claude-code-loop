/**
 * vitest の globalSetup(テストラン全体で 1 回だけ実行される。`lib/test-setup.ts` の
 * setupFiles とは異なり、テストファイルごとには走らない)。
 *
 * 過去に vitest 実行が誤ってリポジトリ本体へブランチ(`T-001` / `agent/T-001` /
 * `agent/T-002` / `agent/T-003` / `agent/T-999` 等)を作ってしまう事故があった。
 * テストは一時ディレクトリに作った使い捨てリポジトリに対してのみ git を実行すべきで、
 * このリポジトリ本体のブランチを増やしてはならない。setup 時と teardown 時にリポジトリ本体の
 * ブランチ一覧を比較し、テスト実行中に増えたブランチが残っていれば throw してテストラン全体を
 * 失敗させ、再発を検出する。
 *
 * git が使えない・git リポジトリでない環境でもテストが動くよう、setup 時にリポジトリルートの
 * 解決やブランチ一覧の取得に失敗したら何もしない(no-op のまま teardown も呼ばない)。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_DIR_NAME, resolveRepoRoot } from "./paths.ts";

/** `git for-each-ref` でリポジトリ本体(root)のローカルブランチ名一覧を取得する */
function listBranches(root: string): string[] {
  const out = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * before/after のブランチ集合から、テストが作ってしまった疑いのあるブランチ一覧を導く純粋関数。
 * git 実行やファイル存在確認を含まないため副作用はない(単体テスト用に export する)。
 *
 * - 減ったブランチは無視する(ccloop 自身の孤児ブランチ回収や他セッションの後片付けで
 *   正常に消えることがあるため)。
 * - 増えたブランチのうち `agent/<taskId>` の形で `isKnownTask(taskId)` が true のものは無視する
 *   (このリポジトリは自分自身をドッグフーディングしており、テスト実行中にも他の自律セッションが
 *   正当な作業ブランチを作ることがあるため)。
 */
export function detectLeakedBranches(
  before: string[],
  after: string[],
  isKnownTask: (taskId: string) => boolean,
): string[] {
  const beforeSet = new Set(before);
  const added = after.filter((branch) => !beforeSet.has(branch));
  return added.filter((branch) => {
    const match = /^agent\/(.+)$/.exec(branch);
    if (match === null) return true;
    return !isKnownTask(match[1]);
  });
}

/** `.agent/tasks/<taskId>.md` または `.agent/archive/tasks/<taskId>.md` が実在するか */
function isKnownTaskId(root: string, taskId: string): boolean {
  const active = path.join(root, AGENT_DIR_NAME, "tasks", `${taskId}.md`);
  const archived = path.join(root, AGENT_DIR_NAME, "archive", "tasks", `${taskId}.md`);
  return fs.existsSync(active) || fs.existsSync(archived);
}

/**
 * vitest 4 の globalSetup 作法: `setup` を export し、その戻り値の関数が teardown として
 * 実行される。git が使えない・git リポジトリでない場合は no-op の teardown を返し、
 * git まわりのエラーで全テストを落とさないようにする。
 */
export function setup(): () => void {
  let root: string;
  let before: string[];
  try {
    root = resolveRepoRoot();
    before = listBranches(root);
  } catch {
    return () => {};
  }

  return () => {
    let after: string[];
    try {
      after = listBranches(root);
    } catch {
      return;
    }

    const leaked = detectLeakedBranches(before, after, (taskId) => isKnownTaskId(root, taskId));
    if (leaked.length === 0) return;

    throw new Error(
      "テストがリポジトリ本体にブランチを作成した: " +
        `${leaked.join(", ")}\n` +
        "テストは一時ディレクトリに作った使い捨てリポジトリに対してのみ git を実行すること。",
    );
  };
}
