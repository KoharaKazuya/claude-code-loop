/**
 * finishTaskSession(セッション終了時の後始末: マージ・結果分類・退避)の結合テスト。
 *
 * 実 git リポジトリ + 実 worktree + 実タスクファイルを用意し、useRepoRoot(dir) でモジュール
 * 共有の paths をテスト用の一時リポジトリへ向けたうえで finishTaskSession を直接呼び、
 * 副作用(worktree・ブランチ・タスクファイル・state.json)を検証する。
 *
 * ヘルパ・セットアップの作法は lib/supervisor.test.ts の describe("recoverStartupIn", ...) /
 * describe("newTaskId", ...) に合わせている(そちらのヘルパを外へ出すリファクタはせず、
 * 必要な分だけこちらにも複製している)。
 *
 * 注意: finishTaskSession はモジュールグローバルな fastCrashStreak / mainChangedSinceExplore を
 * 更新する。現在の実装はこれらを書き込むだけで読み返さない(読むのは mainLoop 側)ため
 * テスト間で持ち越されても結果に影響しないが、将来 finishTaskSession 自身がこれらを参照する
 * ようになると、このファイル内のテストが実行順に依存して不安定になりうる。その場合は
 * テスト用のリセット手段を用意すること。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeFrontmatter } from "./frontmatter.ts";
import {
  type Config,
  finishTaskSession,
  repoPaths,
  type SalvageFailure,
  type SessionResult,
  setRepoPaths,
  statePathOf,
  type Task,
  taskFromFile,
  type TaskSessionContext,
  useRepoRoot,
} from "./supervisor.ts";
import { branchNameFor, createWorktree, mergeInProgress, patchFileName, worktreePathFor } from "./worktree.ts";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    claudeCommand: "claude",
    model: "opus",
    escalation: { model: "claude-fable-5", afterRetries: 2 },
    permissionMode: "auto",
    maxRetries: 3,
    taskTimeoutMs: 2400000,
    maxTurns: 0,
    rateLimit: { backoffMs: 300000 },
    explore: { enabled: true, minIntervalMs: 3600000 },
    triage: { enabled: true, model: "haiku" },
    idlePollMs: 60000,
    parallel: { maxSessions: 1, worktreeDir: "/tmp/finish-test-worktrees", linkPaths: [] },
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-001",
    title: "テストタスク",
    status: "ready",
    priority: 3,
    dependencies: [],
    retries: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    body: "本文",
    ...overrides,
  };
}

const NOW = new Date("2026-08-16T09:00:00.000Z");

describe("finishTaskSession", () => {
  let dir: string;
  let hooksDir: string;
  let wtRoot: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  function git(args: string[], cwd: string = dir): string {
    return execFileSync("git", args, { cwd }).toString();
  }

  function commit(cwd: string, message: string): void {
    git(["add", "-A"], cwd);
    git(["commit", "-m", message], cwd);
  }

  function config(): Config {
    return makeConfig({ parallel: { maxSessions: 1, worktreeDir: wtRoot, linkPaths: [] } });
  }

  function writeTaskFile(root: string, id: string, text: string): void {
    const tasksDir = path.join(root, ".agent", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, `${id}.md`), text);
  }

  function readTask(id: string): Task {
    const t = taskFromFile(path.join(dir, ".agent", "tasks"), `${id}.md`);
    if (t === null) throw new Error(`${id} を読めない`);
    return t;
  }

  function branchExists(branch: string): boolean {
    return git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${branch}`]).trim() !== "";
  }

  function anyAgentBranchMatching(pattern: RegExp): boolean {
    return git(["for-each-ref", "--format=%(refname:short)", "refs/heads/agent"])
      .split("\n")
      .some((b) => pattern.test(b.trim()));
  }

  /** タスク用の worktree をブランチごと作る(セッション起動直後の状態を再現する) */
  function createSessionWorktree(id: string): string {
    const wt = worktreePathFor(wtRoot, id);
    createWorktree(dir, wt, branchNameFor(id));
    return wt;
  }

  function readStateRunningTaskIds(): string[] {
    const state = JSON.parse(fs.readFileSync(statePathOf(dir), "utf8")) as {
      runningSessions?: { kind: string; taskId?: string }[];
    };
    return (state.runningSessions ?? []).filter((s) => s.kind === "task").map((s) => s.taskId ?? "");
  }

  /** startTaskSession が起動時に積む runningSessions エントリを再現する */
  function seedRunningSession(id: string, branch: string, worktree: string): void {
    fs.writeFileSync(
      statePathOf(dir),
      JSON.stringify({
        runningSessions: [
          { kind: "task", taskId: id, branch, worktree, model: "opus", startedAt: NOW.toISOString(), phase: "running" },
        ],
        sessionCount: 1,
      }),
    );
  }

  beforeEach(() => {
    // useRepoRoot はモジュール内で共有される currentPaths を書き換えるため、他のテストへ
    // 影響を残さないよう元の値を退避し、afterEach で必ず復元する
    originalPaths = repoPaths();
    // git が worktree のパスを realpath で記録するため、比較のためこちらも realpath に揃える
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "finish-test-")));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "finish-test-hooks-"));
    wtRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "finish-test-wt-")));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    writeTaskFile(dir, "T-001", serializeFrontmatter({ title: "タスク", status: "ready", retries: 0 }, "本文"));
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    // finishTaskSession は repoPaths() 経由で対象リポジトリを見るため、テスト用の一時リポジトリを注入する
    useRepoRoot(dir);
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it("(a) マージ成功 × セッション成功: worktree/ブランチを片付け、成果を main へ取り込み、runningSessions から除去する", () => {
    const wt = createSessionWorktree("T-001");
    // セッションが status を completed へ書き換えてコミットした状態を再現する
    // (taskFileChanged を true にして no-status-update 判定を避ける)
    writeTaskFile(
      wt,
      "T-001",
      serializeFrontmatter({ title: "タスク", status: "completed", retries: 0 }, "完了しました"),
    );
    fs.writeFileSync(path.join(wt, "result.txt"), "成果\n");
    commit(wt, "成果を追加しタスクを完了する");

    seedRunningSession("T-001", branchNameFor("T-001"), wt);

    const ctx: TaskSessionContext = {
      task: makeTask(),
      model: "opus",
      branch: branchNameFor("T-001"),
      worktree: wt,
      launchStatus: "ready",
      resuming: false,
      startedAt: NOW.toISOString(),
    };
    const res: SessionResult = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };

    finishTaskSession(config(), ctx, res);

    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists(branchNameFor("T-001"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "result.txt"))).toBe(true);
    expect(readTask("T-001").status).toBe("completed");
    expect(readStateRunningTaskIds()).toEqual([]);
  });

  it("(b) マージ衝突: worktree に衝突を再現して残し、retries を加算して試行履歴へ記録する", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    commit(dir, "基底を追加する");

    const wt = createSessionWorktree("T-001");
    fs.writeFileSync(path.join(wt, "conflict.txt"), "ブランチ側\n");
    commit(wt, "ブランチ側で書き換える");

    fs.writeFileSync(path.join(dir, "conflict.txt"), "main 側\n");
    commit(dir, "main 側で書き換える");

    const ctx: TaskSessionContext = {
      task: makeTask(),
      model: "opus",
      branch: branchNameFor("T-001"),
      worktree: wt,
      launchStatus: "ready",
      resuming: false,
      startedAt: NOW.toISOString(),
    };
    const res: SessionResult = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };

    finishTaskSession(config(), ctx, res);

    // 次回を衝突解消セッションとして同じ worktree で起動できる状態が保たれている
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists(branchNameFor("T-001"))).toBe(true);
    expect(mergeInProgress(wt)).toBe(true);
    expect(mergeInProgress(dir)).toBe(false);
    expect(fs.readFileSync(path.join(wt, "conflict.txt"), "utf8")).toContain("<<<<<<<");

    const t = readTask("T-001");
    expect(t.retries).toBe(1);
    expect(t.status).toBe("ready");
    expect(t.body).toContain("## 試行履歴");
  });

  it("(c) タイムアウト/クラッシュ × 未コミット差分あり: パッチへ退避し試行履歴に記録する", () => {
    const wt = createSessionWorktree("T-001");
    // 未コミットの変更を残したままセッションがタイムアウト/クラッシュした状態を再現する
    fs.writeFileSync(path.join(wt, "wip.txt"), "作業中の内容\n");

    const ctx: TaskSessionContext = {
      task: makeTask(),
      model: "opus",
      branch: branchNameFor("T-001"),
      worktree: wt,
      launchStatus: "ready",
      resuming: false,
      startedAt: NOW.toISOString(),
    };
    const res: SessionResult = { exitCode: null, timedOut: true, stdout: "", stderr: "" };

    finishTaskSession(config(), ctx, res);

    expect(fs.existsSync(wt)).toBe(false);

    const patchesDir = repoPaths().patchesDir;
    const patches = fs.existsSync(patchesDir)
      ? fs.readdirSync(patchesDir).filter((f) => f.startsWith("T-001-") && f.endsWith(".patch"))
      : [];
    expect(patches.length).toBe(1);
    const patchFile = path.join(patchesDir, patches[0]);
    expect(fs.readFileSync(patchFile, "utf8")).toContain("wip.txt");

    const t = readTask("T-001");
    expect(t.body).toContain("### 未コミット差分");
    expect(t.body).toContain(patchFile);
    expect(t.retries).toBe(1);
    expect(t.status).toBe("ready");
  });

  it("(c') 未コミット差分の退避が失敗: worktree・ブランチを残し、退避失敗を記録する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const wt = createSessionWorktree("T-001");
      // 未コミットの変更を残したままセッションがタイムアウト/クラッシュした状態を再現する
      fs.writeFileSync(path.join(wt, "wip.txt"), "作業中の内容\n");

      // salvagePatch の出力先(patchesDir/<taskId>-<compactTimestamp(now)>.patch)に
      // あらかじめ空ディレクトリを作っておくと、fs.openSync(outFile, "w") が EISDIR で
      // 失敗し、退避が必ず失敗する状態を再現できる(now は vi.setSystemTime で固定済み)
      const outFile = path.join(repoPaths().patchesDir, patchFileName("T-001", NOW));
      fs.mkdirSync(outFile, { recursive: true });

      const ctx: TaskSessionContext = {
        task: makeTask(),
        model: "opus",
        branch: branchNameFor("T-001"),
        worktree: wt,
        launchStatus: "ready",
        resuming: false,
        startedAt: NOW.toISOString(),
      };
      const res: SessionResult = { exitCode: null, timedOut: true, stdout: "", stderr: "" };

      finishTaskSession(config(), ctx, res);

      // 退避に失敗したので worktree・ブランチのどちらも消してはならない
      expect(fs.existsSync(wt)).toBe(true);
      expect(branchExists(branchNameFor("T-001"))).toBe(true);

      const failureFile = path.join(repoPaths().salvageFailuresDir, "T-001.json");
      expect(fs.existsSync(failureFile)).toBe(true);
      const rec = JSON.parse(fs.readFileSync(failureFile, "utf8")) as SalvageFailure;
      expect(rec.worktree).toBe(wt);
      expect(rec.taskId).toBe("T-001");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(d) リトライ上限到達: status が failed になり、worktree を片付けブランチを退避名へリネームする", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    commit(dir, "基底を追加する");

    const wt = createSessionWorktree("T-001");
    fs.writeFileSync(path.join(wt, "conflict.txt"), "ブランチ側\n");
    commit(wt, "ブランチ側で書き換える");

    const cfg = config();
    // fail() は main 側のタスクファイルを読み直すため、ctx.task ではなく main 側の
    // retries を上限直前まで進めておく
    fs.writeFileSync(path.join(dir, "conflict.txt"), "main 側\n");
    writeTaskFile(
      dir,
      "T-001",
      serializeFrontmatter({ title: "タスク", status: "ready", retries: cfg.maxRetries - 1 }, "本文"),
    );
    commit(dir, "main 側で書き換える(retries も上限直前まで進める)");

    const ctx: TaskSessionContext = {
      task: makeTask({ retries: cfg.maxRetries - 1 }),
      model: "opus",
      branch: branchNameFor("T-001"),
      worktree: wt,
      launchStatus: "ready",
      resuming: false,
      startedAt: NOW.toISOString(),
    };
    const res: SessionResult = { exitCode: 0, timedOut: false, stdout: "", stderr: "" };

    finishTaskSession(cfg, ctx, res);

    expect(fs.existsSync(wt)).toBe(false);
    expect(branchExists(branchNameFor("T-001"))).toBe(false);
    expect(anyAgentBranchMatching(/^agent\/conflict\/T-001-/)).toBe(true);

    const t = readTask("T-001");
    expect(t.status).toBe("failed");
    expect(t.retries).toBe(cfg.maxRetries);
    expect(t.body).toContain("## 試行履歴");
    expect(t.body).toContain("agent/conflict/T-001");
  });

  it("(e) ターン数上限: exitCode 0 でマージも成功するが、結果 JSON の is_error/subtype で失敗として記録する", () => {
    const wt = createSessionWorktree("T-001");
    // セッションが status を completed へ書き換えてコミットした状態を再現する
    // (taskFileChanged / statusUnchanged による安全網ではなく、ターン上限判定で失敗になることを確認する)
    writeTaskFile(
      wt,
      "T-001",
      serializeFrontmatter({ title: "タスク", status: "completed", retries: 0 }, "完了しました"),
    );
    commit(wt, "status を completed にする");

    seedRunningSession("T-001", branchNameFor("T-001"), wt);

    const ctx: TaskSessionContext = {
      task: makeTask(),
      model: "opus",
      branch: branchNameFor("T-001"),
      worktree: wt,
      launchStatus: "ready",
      resuming: false,
      startedAt: NOW.toISOString(),
    };
    const res: SessionResult = {
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        terminal_reason: "max_turns",
        session_id: "sess-max-turns",
      }),
      stderr: "",
    };

    finishTaskSession(config(), ctx, res);

    const t = readTask("T-001");
    expect(t.retries).toBe(1);
    expect(t.status).toBe("ready");
    expect(t.body).toContain("ターン上限");
    expect(t.body).toContain("## 試行履歴");
  });

  it("(f) is_error: true(ターン上限以外の subtype): 失敗として記録する", () => {
    const wt = createSessionWorktree("T-001");
    writeTaskFile(
      wt,
      "T-001",
      serializeFrontmatter({ title: "タスク", status: "completed", retries: 0 }, "完了しました"),
    );
    commit(wt, "status を completed にする");

    seedRunningSession("T-001", branchNameFor("T-001"), wt);

    const ctx: TaskSessionContext = {
      task: makeTask(),
      model: "opus",
      branch: branchNameFor("T-001"),
      worktree: wt,
      launchStatus: "ready",
      resuming: false,
      startedAt: NOW.toISOString(),
    };
    const res: SessionResult = {
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-other-error",
      }),
      stderr: "",
    };

    finishTaskSession(config(), ctx, res);

    const t = readTask("T-001");
    expect(t.retries).toBe(1);
    expect(t.status).toBe("ready");
    expect(t.body).toContain("error_during_execution");
    expect(t.body).toContain("## 試行履歴");
  });
});
