/**
 * `ccloop status` の出力全体(collectStatusData / formatStatus)の結合テスト。
 * 一時ディレクトリを .agent フィクスチャとして組み立て、実データに近い状態で検証する。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";
import { writeRunnerRecord, type RunnerRecord } from "./liveness.ts";
import { CURRENT_SCHEMA_VERSION } from "./migrations.ts";
import {
  clearArchivedTaskCache,
  collectStatusData,
  evaluateConfigSchema,
  formatStatus,
  hrSummary,
  loadArchivedTaskSummaries,
  loadSalvageFailures,
  parkedBranchMergedIntoHead,
  permissionDenialsPathOf,
  readFrontmatterData,
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
    clearArchivedTaskCache();
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
    clearArchivedTaskCache();
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

  /** `.agent/config.json` を任意の中身で書く(schemaVersion の食い違いを検証するため) */
  function writeConfig(content: Record<string, unknown>): void {
    const agentDir = path.join(dir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.json"), JSON.stringify(content, null, 2));
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

  it("abandonedAt が設定された failed タスクは「要対応」の failed タスク一覧から外れる", () => {
    writeTask("T-failed-active", { status: "failed", title: "断念していない失敗タスク" });
    writeTask("T-failed-abandoned", {
      status: "failed",
      title: "断念した失敗タスク",
      abandonedAt: "2026-01-01T00:00:00.000Z",
    });

    const data = collectStatusData(NOW);
    // 集計上は abandonedAt の有無に関わらず failed のまま数える(rotate で退避されるまでの間)
    expect(data.tasks.filter((t) => t.status === "failed")).toHaveLength(2);

    const out = formatStatus();
    expect(out).toContain("T-failed-active");
    expect(out).not.toContain("T-failed-abandoned");
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

  it("大量の archive タスク(長文の本文込み)でも進捗集計が正しい", () => {
    const longBody = "本文行。".repeat(500); // 数 KB の長文本文(frontmatter 部分読みの動作確認)
    const archivedCount = 200;
    let expectedCompleted = 0;
    for (let i = 0; i < archivedCount; i++) {
      // 3 件に 1 件は completed 以外にして、status によるフィルタが効くことも確認する
      const status = i % 3 === 0 ? "failed" : "completed";
      if (status === "completed") expectedCompleted++;
      const archivedTasksDir = path.join(dir, ".agent", "archive", "tasks");
      fs.mkdirSync(archivedTasksDir, { recursive: true });
      fs.writeFileSync(
        path.join(archivedTasksDir, `T-archived-${i}.md`),
        serializeFrontmatter({ status, title: `archive タスク ${i}` }, longBody),
      );
    }
    // アクティブ側と ID が重複する archive タスクは二重計上しない
    writeArchivedTask("T-dup", { status: "completed", title: "重複 ID(archive側)" });
    writeTask("T-dup", { status: "completed", title: "重複 ID(アクティブ側)" });
    writeTask("T-active", { status: "ready", title: "アクティブな未着手タスク" });

    const data = collectStatusData(NOW);
    expect(data.archivedCompletedCount).toBe(expectedCompleted);

    const out = formatStatus();
    // 分子: expectedCompleted(archive completed, 重複除く) + 1(T-dup) + 1(T-active は completed でない ので含まれない)
    expect(out).toContain(`完了 ${expectedCompleted + 1}/${expectedCompleted + 2}`);
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

  describe("metrics / permission-denials の読み込み上限", () => {
    // 上限(LOG_READ_MAX_ENTRIES = 1000)を超える行数だけを目的にした最小限の行数(1 行を短くして行数で踏む)
    const OVER_LIMIT_COUNT = 1200;

    it("metrics.jsonl が上限行数を超えると metricsTruncated=true になり、metrics は上限件数に収まり最新エントリを含む", () => {
      const lines: string[] = [];
      for (let i = 0; i < OVER_LIMIT_COUNT; i++) {
        lines.push(
          JSON.stringify({
            timestamp: NOW.toISOString(),
            kind: "task",
            model: "claude-test",
            taskId: `T-${String(i).padStart(4, "0")}`,
            costUsd: 0.01,
          }),
        );
      }
      fs.writeFileSync(repoPaths().metricsPath, lines.join("\n") + "\n");

      const data = collectStatusData(NOW);

      expect(data.metricsTruncated).toBe(true);
      expect(data.metrics.length).toBeLessThanOrEqual(1000);
      // 末尾(最新)のエントリが含まれる = 変数の取り違えで先頭側を読んでいない
      expect(data.metrics.at(-1)?.taskId).toBe(`T-${String(OVER_LIMIT_COUNT - 1).padStart(4, "0")}`);
    });

    it("metrics.jsonl が上限未満なら metricsTruncated=false", () => {
      const line = JSON.stringify({ timestamp: NOW.toISOString(), kind: "task", model: "claude-test", costUsd: 0.01 });
      fs.writeFileSync(repoPaths().metricsPath, line + "\n");

      const data = collectStatusData(NOW);

      expect(data.metricsTruncated).toBe(false);
      expect(data.metrics).toHaveLength(1);
    });

    it("permission-denials.jsonl が上限行数を超えると partialWindow=true になる(タイムスタンプは全て直近7日以内)", () => {
      const lines: string[] = [];
      for (let i = 0; i < OVER_LIMIT_COUNT; i++) {
        lines.push(
          JSON.stringify({
            timestamp: NOW.toISOString(),
            session: `T-${String(i).padStart(4, "0")}`,
            tool: "Bash",
            command: "ls",
          }),
        );
      }
      fs.writeFileSync(permissionDenialsPathOf(repoPaths().stateDir), lines.join("\n") + "\n");

      const data = collectStatusData(NOW);

      expect(data.permissionDenials.partialWindow).toBe(true);
    });

    it("permission-denials.jsonl が上限未満なら partialWindow=false", () => {
      const line = JSON.stringify({ timestamp: NOW.toISOString(), session: "T-0001", tool: "Bash", command: "ls" });
      fs.writeFileSync(permissionDenialsPathOf(repoPaths().stateDir), line + "\n");

      const data = collectStatusData(NOW);

      expect(data.permissionDenials.partialWindow).toBe(false);
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

  describe("依存が輪になっている", () => {
    it("要対応の節に出て「要対応事項なし」が消える", () => {
      writeTask("T-a", { status: "ready", title: "タスクA", dependencies: ["T-b"] });
      writeTask("T-b", { status: "ready", title: "タスクB", dependencies: ["T-a"] });

      const data = collectStatusData(NOW);
      expect(data.dependencyCycles).toEqual([
        {
          tasks: [
            { id: "T-a", title: "タスクA", waitingFor: ["T-b"] },
            { id: "T-b", title: "タスクB", waitingFor: ["T-a"] },
          ],
        },
      ]);

      const out = formatStatus();
      expect(out).toContain("依存が輪になっていて永久に始まらないタスク");
      expect(out).toContain("T-a");
      expect(out).toContain("T-b");
      expect(out).not.toContain("要対応事項なし");
    });
  });

  describe("競合するタスク(conflicts)", () => {
    it("実行中タスクと競合する ready タスクは conflictHeldTasks に入り、次に実行予定の一覧に競合待ちとして出る", () => {
      writeTask("T-running", { status: "ready", title: "実行中のタスク" });
      writeTask("T-conflict", {
        status: "ready",
        title: "競合するタスク",
        conflicts: ["T-running"],
      });
      fs.writeFileSync(
        statePathOf(dir),
        JSON.stringify({
          runningSessions: [{ kind: "task", taskId: "T-running", startedAt: "2026-08-29T00:00:00.000Z" }],
        }),
      );

      const data = collectStatusData(NOW);
      expect(data.conflictHeldTasks).toEqual([
        { id: "T-conflict", priority: 3, title: "競合するタスク", blockedBy: ["T-running"] },
      ]);

      const out = formatStatus();
      expect(out).toContain("競合待ち  T-conflict  p3  競合するタスク(T-running と同時に実行しない)");
    });

    it("next が空で競合待ちのみのとき「なし(競合待ち N 件)」と表示する", () => {
      writeTask("T-running", { status: "ready", title: "実行中のタスク" });
      writeTask("T-conflict", {
        status: "ready",
        title: "競合するタスク",
        conflicts: ["T-running"],
      });
      fs.writeFileSync(
        statePathOf(dir),
        JSON.stringify({
          runningSessions: [{ kind: "task", taskId: "T-running", startedAt: "2026-08-29T00:00:00.000Z" }],
        }),
      );

      const data = collectStatusData(NOW);
      expect(data.nextRunnableTasks).toEqual([]);

      const out = formatStatus();
      expect(out).toContain("なし(競合待ち 1 件)");
    });

    it("競合待ちが表示上限(3件)を超えるとき、conflictHeldTotal は全件数を保持し、一覧は先頭3件へ切り詰めつつ超過分を「ほか N 件」で示す", () => {
      writeTask("T-running", { status: "ready", title: "実行中のタスク" });
      writeTask("T-conflict-1", { status: "ready", title: "競合するタスク1", conflicts: ["T-running"] });
      writeTask("T-conflict-2", { status: "ready", title: "競合するタスク2", conflicts: ["T-running"] });
      writeTask("T-conflict-3", { status: "ready", title: "競合するタスク3", conflicts: ["T-running"] });
      writeTask("T-conflict-4", { status: "ready", title: "競合するタスク4", conflicts: ["T-running"] });
      fs.writeFileSync(
        statePathOf(dir),
        JSON.stringify({
          runningSessions: [{ kind: "task", taskId: "T-running", startedAt: "2026-08-29T00:00:00.000Z" }],
        }),
      );

      const data = collectStatusData(NOW);
      expect(data.conflictHeldTotal).toBe(4);
      expect(data.conflictHeldTasks).toHaveLength(3);

      const out = formatStatus();
      expect(out).toContain("競合待ち 4 件");
      expect(out).toContain("競合待ち  ほか 1 件");
    });
  });

  describe("次に実行予定のタスクが無いときの待ち理由表示", () => {
    // 実時刻から hours 時間後の ISO 文字列。固定日時だと経過とともにスヌーズが解除されて壊れる
    const futureIso = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

    it("next が空でスヌーズ待ちのみのとき「なし(スヌーズ待ち N 件、最短解除 <日時>)」と表示し、最短解除は複数中で最も早い時刻になる", () => {
      // formatStatus() は内部で new Date() を使うため、固定日時を書くとその日時を過ぎた時点で
      // スヌーズが解除されテストが壊れる。実時刻からの相対で未来の解除時刻を作る
      const early = futureIso(24);
      const late = futureIso(48);
      writeTask("T-snoozed-late", { status: "ready", title: "スヌーズ中(解除が遅い方)", snoozeUntil: late });
      writeTask("T-snoozed-early", { status: "ready", title: "スヌーズ中(解除が早い方)", snoozeUntil: early });

      const data = collectStatusData(NOW);
      expect(data.nextRunnableTasks).toEqual([]);
      expect(data.snoozedTasks.map((t) => t.id)).toEqual(["T-snoozed-early", "T-snoozed-late"]);

      const out = formatStatus();
      expect(out).toContain(`なし(スヌーズ待ち 2 件、最短解除 ${early})`);
    });

    it("next が空で競合待ちとスヌーズ待ちが両方あるとき「なし(競合待ち N 件、スヌーズ待ち N 件、最短解除 <日時>)」と表示する", () => {
      writeTask("T-running", { status: "ready", title: "実行中のタスク" });
      writeTask("T-conflict", {
        status: "ready",
        title: "競合するタスク",
        conflicts: ["T-running"],
      });
      const snoozeUntil = futureIso(24);
      writeTask("T-snoozed", { status: "ready", title: "スヌーズ中のタスク", snoozeUntil });
      fs.writeFileSync(
        statePathOf(dir),
        JSON.stringify({
          runningSessions: [{ kind: "task", taskId: "T-running", startedAt: "2026-08-29T00:00:00.000Z" }],
        }),
      );

      const data = collectStatusData(NOW);
      expect(data.nextRunnableTasks).toEqual([]);
      expect(data.conflictHeldTotal).toBe(1);
      expect(data.snoozedTasks.map((t) => t.id)).toEqual(["T-snoozed"]);

      const out = formatStatus();
      expect(out).toContain(`なし(競合待ち 1 件、スヌーズ待ち 1 件、最短解除 ${snoozeUntil})`);
    });
  });

  describe("config.json の schemaVersion 食い違い", () => {
    it("config.json が無ければ configSchema は null で「要対応事項なし」のまま", () => {
      const data = collectStatusData(NOW);
      expect(data.configSchema).toBeNull();

      const out = formatStatus();
      expect(out).toContain("要対応事項なし");
    });

    it("config.json が JSON として壊れていれば configSchema は null で誤報しない", () => {
      const agentDir = path.join(dir, ".agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "config.json"), "{ this is not valid json");

      const data = collectStatusData(NOW);
      expect(data.configSchema).toBeNull();

      const out = formatStatus();
      expect(out).toContain("要対応事項なし");
    });

    it("schemaVersion が古い(config-outdated)とき要対応に案内と ccloop init --upgrade が出る", () => {
      writeConfig({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 });

      const data = collectStatusData(NOW);
      expect(data.configSchema).toEqual({
        version: CURRENT_SCHEMA_VERSION - 1,
        current: CURRENT_SCHEMA_VERSION,
        compat: "config-outdated",
      });

      const out = formatStatus();
      expect(out).toContain("設定ファイルが古い");
      expect(out).toContain("ccloop init --upgrade");
      expect(out).toContain(`schemaVersion ${CURRENT_SCHEMA_VERSION - 1} → ${CURRENT_SCHEMA_VERSION}`);
      expect(out).not.toContain("要対応事項なし");
    });

    it("schemaVersion が一致していれば何も出ず「要対応事項なし」のまま", () => {
      writeConfig({ schemaVersion: CURRENT_SCHEMA_VERSION });

      const data = collectStatusData(NOW);
      expect(data.configSchema).toEqual({
        version: CURRENT_SCHEMA_VERSION,
        current: CURRENT_SCHEMA_VERSION,
        compat: "ok",
      });

      const out = formatStatus();
      expect(out).not.toContain("設定ファイルが古い");
      expect(out).not.toContain("ccloop 本体が古い");
      expect(out).toContain("要対応事項なし");
    });
  });

  describe("退避された衝突ブランチの取り込み判定", () => {
    function git(args: string[]): string {
      return execFileSync("git", args, { cwd: dir }).toString();
    }

    /** テスト用のコミット identity を設定する。GPG 署名が有効な環境でも落ちないようにする */
    function initGitIdentity(): void {
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test User"]);
      git(["config", "commit.gpgsign", "false"]);
    }

    function writeAndCommit(file: string, content: string, message: string): void {
      fs.writeFileSync(path.join(dir, file), content);
      git(["add", "-A"]);
      git(["commit", "-m", message]);
    }

    it("main と同じコミットを指す(先端がそのまま main)ブランチは取り込み済み節に出て削除コマンドが付く", () => {
      initGitIdentity();
      writeAndCommit("a.txt", "base\n", "base");
      const branch = "agent/conflict/T-001-20260830-0000";
      git(["branch", branch]);

      const out = formatStatus();
      expect(out).toContain("main に取り込み済み");
      expect(out).toContain(branch);
      expect(out).toContain(`git branch -D ${branch}`);
    });

    it("先端が main の祖先(分岐後に main だけ進んだ)ブランチも取り込み済みになる", () => {
      initGitIdentity();
      writeAndCommit("a.txt", "base\n", "base");
      const branch = "agent/conflict/T-006-20260830-0000";
      git(["branch", branch]);
      // 退避後に main だけが進む。ブランチの先端は main の祖先のままなので消してよい
      writeAndCommit("d.txt", "main のみの変更\n", "main を進める");

      const out = formatStatus();
      expect(out).toContain("main に取り込み済み");
      expect(out).toContain(`git branch -D ${branch}`);
    });

    it("main に無いコミットを持つブランチは未取り込み節に出て削除コマンドは付かない", () => {
      initGitIdentity();
      writeAndCommit("a.txt", "base\n", "base");
      const branch = "agent/conflict/T-002-20260830-0000";
      git(["checkout", "-b", branch]);
      writeAndCommit("b.txt", "extra\n", "branch 側だけの変更");
      git(["checkout", "main"]);

      const out = formatStatus();
      expect(out).toContain("main に未取り込み");
      expect(out).toContain(branch);
      expect(out).not.toContain(`git branch -D ${branch}`);
    });

    it("内容は同じでも main 側に別コミットとして取り込まれている場合は安全側に倒して未取り込み扱いにする", () => {
      initGitIdentity();
      writeAndCommit("a.txt", "base\n", "base");
      const branch = "agent/conflict/T-003-20260830-0000";
      git(["checkout", "-b", branch]);
      writeAndCommit("a.txt", "changed\n", "branch 側の変更");
      git(["checkout", "main"]);
      // main 側でも同じ内容を、squash や当て直しを模して別コミットとして取り込む
      writeAndCommit("a.txt", "changed\n", "main 側で同じ内容を別コミットとして取り込む");

      const out = formatStatus();
      expect(out).toContain("main に未取り込み");
      expect(out).toContain(branch);
      expect(out).not.toContain(`git branch -D ${branch}`);
    });

    it("取り込み済み・未取り込みが両方あれば両方の節が出る", () => {
      initGitIdentity();
      writeAndCommit("a.txt", "base\n", "base");
      const mergedBranch = "agent/conflict/T-004-20260830-0000";
      git(["branch", mergedBranch]);
      const unmergedBranch = "agent/conflict/T-005-20260830-0000";
      git(["checkout", "-b", unmergedBranch]);
      writeAndCommit("c.txt", "extra\n", "branch 側だけの変更");
      git(["checkout", "main"]);

      const out = formatStatus();
      expect(out).toContain("main に取り込み済み");
      expect(out).toContain("main に未取り込み");
      expect(out).toContain(mergedBranch);
      expect(out).toContain(unmergedBranch);
      // 削除コマンドが付くのは取り込み済み側だけであること(出し分けの本体)
      expect(out).toContain(`git branch -D ${mergedBranch}`);
      expect(out).not.toContain(`git branch -D ${unmergedBranch}`);
    });

    it("parkedBranchMergedIntoHead は存在しないブランチに対して false を返す(git 失敗時は未取り込み扱い)", () => {
      initGitIdentity();
      writeAndCommit("a.txt", "base\n", "base");

      expect(parkedBranchMergedIntoHead(dir, "agent/conflict/no-such-branch")).toBe(false);
    });
  });
});

describe("evaluateConfigSchema", () => {
  it("raw が null なら判定しない", () => {
    expect(evaluateConfigSchema(null)).toBeNull();
  });

  it("バージョンが一致していれば ok", () => {
    expect(evaluateConfigSchema({ schemaVersion: CURRENT_SCHEMA_VERSION })).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      current: CURRENT_SCHEMA_VERSION,
      compat: "ok",
    });
  });

  it("config の版数が古ければ config-outdated", () => {
    expect(evaluateConfigSchema({ schemaVersion: CURRENT_SCHEMA_VERSION - 1 })).toEqual({
      version: CURRENT_SCHEMA_VERSION - 1,
      current: CURRENT_SCHEMA_VERSION,
      compat: "config-outdated",
    });
  });

  it("config の版数がツールより新しければ tool-outdated", () => {
    expect(evaluateConfigSchema({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })).toEqual({
      version: CURRENT_SCHEMA_VERSION + 1,
      current: CURRENT_SCHEMA_VERSION,
      compat: "tool-outdated",
    });
  });
});

describe("readFrontmatterData / loadArchivedTaskSummaries", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-frontmatter-test-"));
    clearArchivedTaskCache();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    clearArchivedTaskCache();
  });

  function write(fileName: string, content: string): string {
    const full = path.join(dir, fileName);
    fs.writeFileSync(full, content);
    return full;
  }

  it("普通のファイルなら data がそのまま取れる", () => {
    const full = write("normal.md", serializeFrontmatter({ status: "completed", title: "普通" }, "本文"));
    expect(readFrontmatterData(full)).toEqual({ status: "completed", title: "普通" });
  });

  it("本文が maxBytes を超える長文でも frontmatter は正しく取れる", () => {
    const longBody = "本文行。".repeat(2000); // 数十 KB
    const full = write(
      "long.md",
      serializeFrontmatter({ status: "failed", title: "長文" }, longBody),
    );
    expect(readFrontmatterData(full)).toEqual({ status: "failed", title: "長文" });
  });

  it("frontmatter 自体が maxBytes を超えても、全文読みと同じ結果へフォールバックする", () => {
    // 値をわざと長くして、小さい maxBytes(16)では閉じ '---' に届かないようにする
    const longValue = "x".repeat(200);
    const expected = { status: "completed", note: longValue };
    const full = write("huge-frontmatter.md", serializeFrontmatter(expected, "本文"));
    // 既定の maxBytes(4096)による全文相当の読み取り結果を基準にする
    expect(readFrontmatterData(full, 16)).toEqual(readFrontmatterData(full));
    expect(readFrontmatterData(full, 16)).toEqual(expected);
  });

  it("frontmatter が無いファイルは {} を返す", () => {
    const full = write("no-frontmatter.md", "ただの本文で始まる");
    expect(readFrontmatterData(full)).toEqual({});
  });

  it("どんな maxBytes でも全文読みと同じ結果になる(BOM・CRLF・末尾 --- 等の異例込み)", () => {
    const normal = serializeFrontmatter({ status: "completed", title: "普通" }, "短い本文");
    // BOM は見えない文字なので、リテラルではなくエスケープで書く
    const bom = "\uFEFF" + serializeFrontmatter({ status: "completed", title: "BOM 付き" }, "本文");
    const crlf = serializeFrontmatter({ status: "failed", title: "CRLF" }, "本文\n複数行").replaceAll(
      "\n",
      "\r\n",
    );
    // 閉じ '---' がファイル末尾で、直後の改行も本文も無いケース
    const noTrailingNewline = "---\nstatus: completed\n---";
    // 本文中に '---' を含む行があっても、frontmatter の閉じとして誤認しないケース
    const dashInBody = serializeFrontmatter({ status: "completed" }, "前\n---\n後");
    const noFrontmatter = "ただの本文で始まる。frontmatter は無い。";
    // '---' で始まるが閉じ '---' が無いケース
    const unclosed = "---\nstatus: completed\ntitle: 閉じられていない\n";

    const smallCases: [string, string][] = [
      ["normal.md", normal],
      ["bom.md", bom],
      ["crlf.md", crlf],
      ["no-trailing-newline.md", noTrailingNewline],
      ["dash-in-body.md", dashInBody],
      ["no-frontmatter.md", noFrontmatter],
      ["unclosed.md", unclosed],
    ];

    for (const [fileName, content] of smallCases) {
      const full = write(fileName, content);
      const byteLen = Buffer.byteLength(content, "utf8");
      const expected = parseFrontmatter(fs.readFileSync(full, "utf8")).data;
      for (let maxBytes = 1; maxBytes <= byteLen + 8; maxBytes++) {
        expect(readFrontmatterData(full, maxBytes)).toEqual(expected);
      }
    }

    // マルチバイト文字(日本語)を大量に含むケース。総当たりは重いため代表値のみ確認する
    const heavyBody = "日本語の本文を大量に含む行です。".repeat(300);
    const heavyContent = serializeFrontmatter(
      { status: "completed", title: "日本語タイトル", note: "日本語の note 値" },
      heavyBody,
    );
    const heavyFull = write("heavy-multibyte.md", heavyContent);
    const heavyByteLen = Buffer.byteLength(heavyContent, "utf8");
    const heavyExpected = parseFrontmatter(fs.readFileSync(heavyFull, "utf8")).data;
    const representativeMaxBytes = [
      1, 2, 3, 4, 5, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096,
      heavyByteLen - 1, heavyByteLen, heavyByteLen + 1, heavyByteLen + 8,
    ];
    for (const maxBytes of representativeMaxBytes) {
      expect(readFrontmatterData(heavyFull, maxBytes)).toEqual(heavyExpected);
    }
  });

  it("mtime/size が変わらなければキャッシュを再利用し、変われば読み直す", () => {
    const archivedDir = path.join(dir, "archive-tasks");
    fs.mkdirSync(archivedDir, { recursive: true });
    const filePath = path.join(archivedDir, "T-1.md");
    fs.writeFileSync(filePath, serializeFrontmatter({ status: "completed", title: "旧" }, "本文"));

    const first = loadArchivedTaskSummaries(archivedDir);
    expect(first).toEqual([{ id: "T-1", status: "completed" }]);

    // 別の status・別の長さの本文に書き換え、mtime を確実にずらす
    fs.writeFileSync(filePath, serializeFrontmatter({ status: "failed", title: "新" }, "本文をもっと長くする"));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, future, future);

    const second = loadArchivedTaskSummaries(archivedDir);
    expect(second).toEqual([{ id: "T-1", status: "failed" }]);
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
