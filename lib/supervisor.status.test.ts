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
import { writeRunnerRecord, type RunnerRecord } from "./liveness.ts";
import {
  collectStatusData,
  formatStatus,
  hrSummary,
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
    writeOpenHrWithBody(id, importance, title, "## 回答\n\n");
  }

  /** 本文を指定できる版。summary 抽出のテストなど、`## 確認事項` を含む本文を検証したい場合に使う */
  function writeOpenHrWithBody(
    id: string,
    importance: "BLOCK" | "REVIEW",
    title: string,
    body: string,
  ): void {
    const hrDir = path.join(dir, ".agent", "human-review");
    fs.mkdirSync(hrDir, { recursive: true });
    fs.writeFileSync(
      path.join(hrDir, `${id}.md`),
      serializeFrontmatter({ title, status: "open", importance }, body),
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

  it("「一言でいうと」形式の確認事項は強調記号を落として表示される", () => {
    writeOpenHrWithBody(
      "HR-1",
      "REVIEW",
      "確認したい事項",
      ["## 確認事項", "", "一言でいうと: **これは重要な確認内容だよ**", "", "## 回答", "", ""].join("\n"),
    );

    const out = formatStatus();
    // 本文の「一言でいうと:」はそのまま活き、表示側は見出し語を重ねない
    expect(out).toContain("→ 一言でいうと: これは重要な確認内容だよ");
    expect(out).not.toContain("**");
  });

  it("「一言でいうと」形式でなくても確認事項見出し直後の文が表示される", () => {
    writeOpenHrWithBody(
      "HR-1",
      "REVIEW",
      "確認したい事項",
      ["## 確認事項", "", "ふつうの文から始まる確認内容です。", "", "## 回答", "", ""].join("\n"),
    );

    const out = formatStatus();
    expect(out).toContain("→ ふつうの文から始まる確認内容です。");
  });

  it("確認事項見出しが無くても本文冒頭が使われ、例外にならない", () => {
    writeOpenHrWithBody(
      "HR-1",
      "REVIEW",
      "確認したい事項",
      ["見出しの無い本文の冒頭行です。", "", "## 回答", "", ""].join("\n"),
    );

    expect(() => formatStatus()).not.toThrow();
    const out = formatStatus();
    expect(out).toContain("→ 見出しの無い本文の冒頭行です。");
  });

  it("本文が回答テンプレートのみ(確認事項なし・実質空)なら summary 行を出さない", () => {
    writeOpenHr("HR-1", "REVIEW", "確認したい事項");

    const out = formatStatus();
    expect(out).toContain("HR-1: 確認したい事項");
    expect(out).not.toContain("      → ");
  });

  it("非常に長い一言は省略記号付きで1行に収まる", () => {
    const longLine = "x".repeat(120);
    writeOpenHrWithBody(
      "HR-1",
      "REVIEW",
      "確認したい事項",
      ["## 確認事項", "", longLine, "", "## 回答", "", ""].join("\n"),
    );

    const out = formatStatus();
    expect(out).toContain(`${"x".repeat(80)}…`);
    expect(out).not.toContain("x".repeat(81));
    const summaryLine = out.split("\n").find((l) => l.includes("→ "));
    expect(summaryLine).toBeDefined();
    expect(summaryLine!.length).toBeLessThan(200);
  });

  it("note がある snoozed タスクは note を表示し、無いタスクは [snoozed until ...] のみ表示する", () => {
    writeTask("T-snoozed-note", {
      status: "ready",
      title: "スヌーズ中(note あり)",
      snoozeUntil: "2026-09-01T00:00:00.000Z",
      note: "外部 API のレート制限解除待ち",
    });
    writeTask("T-snoozed-plain", {
      status: "ready",
      title: "スヌーズ中(note なし)",
      snoozeUntil: "2026-09-02T00:00:00.000Z",
    });

    const out = formatStatus();
    expect(out).toContain("note: 外部 API のレート制限解除待ち");
    expect(out).toContain("T-snoozed-plain");
    expect(out).toContain("[snoozed until");
  });

  describe("ループ本体(ccloop run)の生存表示", () => {
    function writeRunner(record: RunnerRecord): void {
      writeRunnerRecord(repoPaths().runnerPath, record);
    }

    it("生存記録が無ければ「動いていません」になる", () => {
      const data = collectStatusData(NOW);
      expect(data.loopLiveness.status).toBe("stopped");

      const out = formatStatus();
      expect(out).toContain("ループ本体: 動いていません");
      expect(out).not.toContain("ループ本体: 動いています");
    });

    it("自ホスト・自 PID・新しい心拍なら「動いています」になる", () => {
      // formatStatus() は内部で new Date() を使うため、固定の NOW ではなく実時刻に合わせて心拍を書く
      writeRunner({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        host: os.hostname(),
        heartbeatIntervalMs: 5_000,
      });

      const data = collectStatusData(new Date());
      expect(data.loopLiveness.status).toBe("running");

      const out = formatStatus();
      expect(out).toContain("ループ本体: 動いています");
    });

    it("異常終了で記録が残ったまま(存在しない PID)だと「動いていません」になる", () => {
      writeRunner({
        pid: 999_999_999,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        host: os.hostname(),
        heartbeatIntervalMs: 5_000,
      });

      const data = collectStatusData(new Date());
      expect(data.loopLiveness).toMatchObject({ status: "stopped", reason: "process-gone" });

      const out = formatStatus();
      expect(out).toContain("ループ本体: 動いていません");
      expect(out).not.toContain("ループ本体: 動いています");
    });

    it("状態の更新: の行が出る", () => {
      const out = formatStatus();
      expect(out).toContain("状態の更新:");
    });
  });
});

describe("hrSummary", () => {
  it("空文字列を渡すと空文字を返す", () => {
    expect(hrSummary("")).toBe("");
  });

  it("見出しだけで本文が無ければ空文字を返す", () => {
    expect(hrSummary("## 確認事項\n\n## 回答\n\n")).toBe("");
  });

  it("先頭のリスト記号を落とす", () => {
    expect(hrSummary("## 確認事項\n\n- 一言でいうと: リスト記法の確認事項\n")).toBe(
      "一言でいうと: リスト記法の確認事項",
    );
  });

  it("ソフトラップされた日本語の段落は空白を挟まず連結する", () => {
    expect(hrSummary("## 確認事項\n\n一言でいうと: 途中で折り返された\n日本語の一文です。\n\n次の段落\n")).toBe(
      "一言でいうと: 途中で折り返された日本語の一文です。",
    );
  });

  it("連結の境界に英数字があれば単語が潰れないよう空白を挟む", () => {
    expect(hrSummary("## 確認事項\n\nfoo\nbar\n")).toBe("foo bar");
  });

  it("段落は空行または次の見出しで区切る", () => {
    expect(hrSummary("## 確認事項\n\nあいう\n\n## 暫定判断\n\nえおか\n")).toBe("あいう");
  });

  it("確認事項見出しが無ければ本文冒頭を使う", () => {
    expect(hrSummary("本文の冒頭行\n\n## 回答\n\n")).toBe("本文の冒頭行");
  });

  it("maxLen を超えると省略記号を付けて切り詰める", () => {
    const result = hrSummary("## 確認事項\n\nabc", 2);
    expect(result).toBe("ab…");
  });
});
