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
  loadSalvageFailures,
  repoPaths,
  type SalvageFailure,
  setRepoPaths,
  statePathOf,
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

  /** `.agent/archive/tasks/` へタスクを書く。rotate で退避済みの completed タスクを模す */
  function writeArchivedTask(id: string, fields: Record<string, string | number | string[]>): void {
    const archivedTasksDir = path.join(dir, ".agent", "archive", "tasks");
    fs.mkdirSync(archivedTasksDir, { recursive: true });
    fs.writeFileSync(path.join(archivedTasksDir, `${id}.md`), serializeFrontmatter(fields, "本文"));
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

  it("片付けの衝突で同じ ID がアクティブ側と archive 側の両方に completed で残っても 1 件として数える", () => {
    // T-a は片付けの移動が衝突で見送られ、アクティブ側にも archive 側にも同じ ID で残っている想定
    writeTask("T-a", { status: "completed", title: "完了したタスクA" });
    writeTask("T-b", { status: "completed", title: "完了したタスクB" });
    writeArchivedTask("T-a", { status: "completed", title: "完了したタスクA(archive側)" });
    writeArchivedTask("T-c", { status: "completed", title: "完了したタスクC(archiveのみ)" });

    const data = collectStatusData(NOW);
    // archive 側のうちアクティブ側と重複しない T-c のみが加算対象
    expect(data.archivedCompletedCount).toBe(1);

    const out = formatStatus();
    // 分子(T-a, T-b, T-c の3件)・分母(同じく3件)とも二重計上されない
    expect(out).toContain("完了 3/3");
  });

  it("衝突が無ければこれまでどおり archive 分をそのまま足して数える", () => {
    writeTask("T-a", { status: "completed", title: "完了したタスクA" });
    writeTask("T-b", { status: "ready", title: "未着手のタスクB" });
    writeArchivedTask("T-c", { status: "completed", title: "完了したタスクC" });
    writeArchivedTask("T-d", { status: "completed", title: "完了したタスクD" });

    const data = collectStatusData(NOW);
    expect(data.archivedCompletedCount).toBe(2);

    const out = formatStatus();
    expect(out).toContain("完了 3/4");
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

    it("ループ本体が process-gone で、かつ runningSessions が残っていても「実行中のタスク」節は経過時間を出さず記録扱いになる", () => {
      writeRunner({
        pid: 999_999_999,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        host: os.hostname(),
        heartbeatIntervalMs: 5_000,
      });
      writeTask("T-orphan", { status: "working", title: "停止したループに取り残されたタスク" });
      fs.writeFileSync(
        statePathOf(dir),
        JSON.stringify({
          runningSessions: [{ kind: "task", taskId: "T-orphan", startedAt: "2026-08-29T00:00:00.000Z" }],
        }),
      );

      const data = collectStatusData(NOW);
      expect(data.loopLiveness).toMatchObject({ status: "stopped", reason: "process-gone" });
      expect(data.state.runningSessions).toHaveLength(1);

      const out = formatStatus();
      // 稼働状態節の表示と矛盾しないこと
      expect(out).toContain("ループ本体: 動いていません");

      // 「実行中のタスク」節だけを切り出して検証する(他の節の「経過」を誤って拾わないため)
      const lines = out.split("\n");
      const startIdx = lines.findIndex((l) => l.startsWith("実行中のタスク"));
      expect(startIdx).toBeGreaterThanOrEqual(0);
      const endIdx = lines.findIndex((l, i) => i > startIdx && l === "");
      const section = lines.slice(startIdx, endIdx === -1 ? lines.length : endIdx).join("\n");

      expect(lines[startIdx]).toBe("実行中のタスク(ループ停止時の記録)");
      expect(section).toContain(
        "※ ループ本体(ccloop run)が動いていないため、下記の 1 件は実行中ではなく記録が残っているだけ",
      );
      expect(section).toContain("T-orphan");
      expect(section).not.toContain("経過");
    });
  });

  describe("起動セッション数と終了済みセッション数の表示", () => {
    /** 計測行は最低限の必須フィールドのみ埋めて metrics.jsonl に追記する */
    function appendMetric(costUsd: number): void {
      const line = JSON.stringify({
        timestamp: NOW.toISOString(),
        kind: "task",
        model: "claude-test",
        costUsd,
      });
      fs.appendFileSync(repoPaths().metricsPath, line + "\n");
    }

    it("起動セッション数(sessionCount)と終了したセッション数(metrics.jsonl の行数)が別々の値で両方表示される", () => {
      // わざと違う値にする: 起動は 7 件、うち終了して計測が残っているのは 3 件
      fs.writeFileSync(statePathOf(dir), JSON.stringify({ sessionCount: 7 }));
      appendMetric(0.1);
      appendMetric(0.2);
      appendMetric(0.3);

      const data = collectStatusData(NOW);
      expect(data.state.sessionCount).toBe(7);
      expect(data.metrics).toHaveLength(3);

      const out = formatStatus();
      expect(out).toContain("起動セッション: 7 件");
      expect(out).toContain("終了した 3 セッション分");

      // 「セッション数」という重複ラベル(何を数えているか区別できない旧表記)が再発していないこと
      const occurrences = out.match(/セッション数/g) ?? [];
      expect(occurrences.length).toBeLessThanOrEqual(1);
    });
  });

  describe("status が不正なタスクファイル", () => {
    it("集計・進捗の分母から除外され、要対応セクションにファイル名が出る", () => {
      writeTask("T-ok", { status: "ready", title: "正常なタスク" });
      writeTask("T-bad", { status: "done", title: "不正な status のタスク" });

      const data = collectStatusData(NOW);
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0]?.id).toBe("T-ok");
      expect(data.invalidTaskFiles).toEqual(["T-bad.md"]);

      const out = formatStatus();
      // 進捗バーの分母は正常タスクのみ(1件)で数えられ、不正タスクは含まれない
      expect(out).toContain("完了 0/1");
      expect(out).toContain("T-bad.md");
      expect(out).not.toContain("要対応事項なし");
    });
  });

  describe("依存に存在しないタスク ID が書かれている", () => {
    it("要対応の節に出て「要対応事項なし」が消える", () => {
      writeTask("T-child", {
        status: "ready",
        title: "打ち間違いの依存を持つタスク",
        dependencies: ["T-typo"],
      });

      const data = collectStatusData(NOW);
      expect(data.missingDependencies).toEqual([
        { taskId: "T-child", title: "打ち間違いの依存を持つタスク", missing: ["T-typo"] },
      ]);

      const out = formatStatus();
      expect(out).toContain("依存に書かれたタスク ID が見つからないタスク");
      expect(out).toContain("T-child");
      expect(out).toContain("T-typo");
      expect(out).not.toContain("要対応事項なし");
    });

    it("archive にある完了済みタスクへの依存は要対応に出ず、依存充足のまま実行対象に残る", () => {
      writeArchivedTask("T-parent", { status: "completed", title: "archive済みの完了タスク" });
      writeTask("T-child", {
        status: "ready",
        title: "archive済みタスクに依存するタスク",
        dependencies: ["T-parent"],
      });

      const data = collectStatusData(NOW);
      expect(data.missingDependencies).toEqual([]);
      expect(data.nextRunnableTasks.map((t) => t.id)).toContain("T-child");
    });
  });
});

describe("loadSalvageFailures", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  beforeEach(() => {
    originalPaths = repoPaths();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-salvage-failures-test-"));
    useRepoRoot(dir);
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFailureMarker(rec: SalvageFailure): void {
    fs.mkdirSync(repoPaths().salvageFailuresDir, { recursive: true });
    fs.writeFileSync(path.join(repoPaths().salvageFailuresDir, `${rec.taskId}.json`), JSON.stringify(rec));
  }

  it("記録された worktree が既に無ければ、マーカーファイルごと削除して結果から除く(自己清掃)", () => {
    const stillThere = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-salvage-failures-wt-"));
    try {
      writeFailureMarker({ taskId: "T-gone", worktree: "/does/not/exist", at: NOW.toISOString(), error: "boom" });
      writeFailureMarker({ taskId: "T-kept", worktree: stillThere, at: NOW.toISOString(), error: "boom" });

      const result = loadSalvageFailures(dir);

      expect(result.map((r) => r.taskId)).toEqual(["T-kept"]);
      expect(fs.existsSync(path.join(repoPaths().salvageFailuresDir, "T-gone.json"))).toBe(false);
      expect(fs.existsSync(path.join(repoPaths().salvageFailuresDir, "T-kept.json"))).toBe(true);
    } finally {
      fs.rmSync(stillThere, { recursive: true, force: true });
    }
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
