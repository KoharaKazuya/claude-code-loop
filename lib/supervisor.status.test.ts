/**
 * `ccloop status` の出力全体(collectStatusData / formatStatus)の結合テスト。
 * 一時ディレクトリを .agent フィクスチャとして組み立て、実データに近い状態で検証する。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeFrontmatter } from "./frontmatter.ts";
import {
  collectStatusData,
  formatStatus,
  repoPaths,
  setRepoPaths,
  useRepoRoot,
} from "./supervisor.ts";

const NOW = new Date("2026-08-30T00:00:00.000Z");

describe("collectStatusData / formatStatus", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  beforeEach(() => {
    originalPaths = repoPaths();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-status-test-"));
    // collectStatusData は git for-each-ref / git worktree list を呼ぶ。非 git でも失敗はしないが
    // 警告ログのノイズを避けるため git リポジトリにしておく(commit は打たない)。
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    useRepoRoot(dir);
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTask(id: string, fields: Record<string, string | number | string[]>): void {
    const tasksDir = path.join(dir, ".agent", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, `${id}.md`), serializeFrontmatter(fields, "本文"));
  }

  /** open な Human Review(未回答)。チェックボックスを付けないことで open のまま保つ */
  function writeOpenHr(id: string, importance: "BLOCK" | "REVIEW", title: string): void {
    const hrDir = path.join(dir, ".agent", "human-review");
    fs.mkdirSync(hrDir, { recursive: true });
    fs.writeFileSync(
      path.join(hrDir, `${id}.md`),
      serializeFrontmatter({ title, status: "open", importance }, "## 回答\n\n"),
    );
  }

  function writeDecision(id: string, title: string): void {
    const decisionsDir = path.join(dir, ".agent", "decisions");
    fs.mkdirSync(decisionsDir, { recursive: true });
    fs.writeFileSync(path.join(decisionsDir, `${id}.md`), serializeFrontmatter({ title }, "決定の本文。"));
  }

  it("何も無ければ要対応事項なしになる", () => {
    const data = collectStatusData(NOW);
    expect(data.humanReview.openBlock).toEqual([]);
    expect(data.humanReview.openReview).toEqual([]);
    expect(data.pendingDecisions.count).toBe(0);

    const out = formatStatus();
    expect(out).toContain("要対応事項なし");
  });

  it("BLOCK/REVIEW の HR・failed/blocked タスク・未承認の決定が揃うとそれぞれの節が出る", () => {
    writeOpenHr("HR-1", "BLOCK", "ブロック中の確認事項");
    writeOpenHr("HR-2", "REVIEW", "確認推奨の事項");
    writeTask("T-failed", { status: "failed", title: "失敗したタスク" });
    writeTask("T-blocked", { status: "blocked", title: "止まっているタスク" });
    writeDecision("D-1", "未承認の決定その1");

    const data = collectStatusData(NOW);
    expect(data.humanReview.openBlock).toHaveLength(1);
    expect(data.humanReview.openReview).toHaveLength(1);
    expect(data.pendingDecisions.count).toBe(1);
    expect(data.tasks.filter((t) => t.status === "failed")).toHaveLength(1);
    expect(data.tasks.filter((t) => t.status === "blocked")).toHaveLength(1);

    const out = formatStatus();
    expect(out).toContain("Human Review (BLOCK)");
    expect(out).toContain("Human Review (REVIEW/INFO)");
    expect(out).toContain("failed タスク");
    expect(out).toContain("blocked タスク");
    expect(out).toContain("未承認の決定");
    expect(out).not.toContain("要対応事項なし");
  });

  it("未承認の決定がプレビュー上限(3件)を超えると残り件数を表示する", () => {
    for (let i = 1; i <= 5; i++) {
      writeDecision(`D-${i}`, `未承認の決定その${i}`);
    }

    const data = collectStatusData(NOW);
    expect(data.pendingDecisions.count).toBe(5);

    const out = formatStatus();
    expect(out).toContain("…他 2 件");
  });
});
