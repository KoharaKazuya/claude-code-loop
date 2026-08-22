// Stop hook: タスクセッションが担当タスクファイルを更新しないまま終了しようとしたら
// 1 回だけ差し戻す。stop_hook_active が true の場合(既にこの hook で差し戻した後)は
// 許可し、無限ループを防ぐ。
//
// タスクセッションは専用ブランチの worktree で動き、担当タスクの ID は
// CLAUDE_AGENT_TASK_ID で渡される。「更新した」の判定は
// 未コミットの変更、またはブランチが main から分岐して以降のコミットに
// `.agent/tasks/<ID>.md` が含まれるか、で行う。
import { execFileSync } from "node:child_process";
import { readStdinJson } from "./stdin.ts";
import { taskFileRelPath } from "../paths.ts";

const input = await readStdinJson();

if (input.stop_hook_active === true) process.exit(0);

// 探索セッションは担当タスクを持たない
if (process.env.CLAUDE_AGENT_SESSION_KIND === "explore") process.exit(0);

// 対話セッションなど、Supervisor 以外から起動された場合は何もしない
const taskId = process.env.CLAUDE_AGENT_TASK_ID;
if (typeof taskId !== "string" || taskId === "") process.exit(0);

// git のパススペックはセッションの作業ツリー(通常はタスク用 worktree)基準で解決させる
const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
const taskPath = taskFileRelPath(taskId);

function git(args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let changed: boolean;
try {
  if (git(["status", "--porcelain", "--", taskPath]).trim() !== "") {
    changed = true;
  } else {
    const base = git(["merge-base", "HEAD", "main"]).trim();
    changed = git(["diff", "--name-only", `${base}..HEAD`, "--", taskPath]).trim() !== "";
  }
} catch (err) {
  // git で判定できない環境では終了を止めない(fail-open)
  process.stderr.write(
    `stop-check: ${taskPath} の変更判定に失敗したため終了を許可する: ${String((err as Error)?.message ?? err)}\n`,
  );
  process.exit(0);
}

if (!changed) {
  process.stderr.write(
    `セッション終了前に担当タスク ${taskPath} を更新すること: frontmatter の status` +
      "(completed / blocked / failed / 続きがあるなら ready + note)と updatedAt、および本文末尾の `## 試行履歴` を更新し、" +
      "重要な判断を .agent/decisions/ に、REVIEW 事項を .agent/human-review/ に記録してから終了すること。",
  );
  process.exit(2); // exit 2 = 終了をブロックし、stderr をモデルへ渡す
}
process.exit(0);
