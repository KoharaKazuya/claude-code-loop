import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";
import { readProcStartToken, writeRunnerRecord, type LoopLiveness } from "./liveness.ts";
import { createPaths, type Paths } from "./paths.ts";
import {
  AGENT_COMMIT_TRAILER,
  allTaskIds,
  appendAttemptRecord,
  appendUncommittedDiffRecord,
  assertDepsExist,
  buildClaudeArgs,
  buildExplorePrompt,
  buildSessionMetrics,
  buildTaskPrompt,
  byPriorityThenCreatedAt,
  classifyHumanReview,
  closeHumanReview,
  collectSubagentStats,
  commitAgentDir,
  type Config,
  crashResultFromError,
  denialMatchesRule,
  depSatisfied,
  describeMergeOutcome,
  diffInputs,
  dirtyPathsOutsideAgent,
  ensureWritableDir,
  type ExploreContext,
  exploreEndLogLine,
  fastCrashStreakAfterWait,
  formatElapsed,
  installedSourceDriftLines,
  isFastCrash,
  isInstalledSourceDrifted,
  isSnoozed,
  isSupervisorSourceStale,
  lastAttemptHistoryEntry,
  loadDenyRules,
  loadPendingDecisions,
  loadPermissionDenials,
  mainChangedByTaskOutcome,
  mainLoop,
  newTaskId,
  nextFastCrashStreak,
  nextStopEscalation,
  normalizeState,
  overviewSectionLines,
  parseDeps,
  parseNameStatus,
  parseOverview,
  partitionDeniedByRules,
  patchesToPrune,
  patchTimestamp,
  pendingDecisionsSectionLines,
  permissionDenialLines,
  permissionDenialsPathOf,
  type PermissionDenialRecord,
  pickModel,
  planConflictResume,
  planTaskSelection,
  projectsDirName,
  prunePatches,
  recordFailure,
  recordPermissionDenials,
  recoverStartupIn,
  refreshGeneratedSessionInputs,
  repoPaths,
  resolvePriority,
  resolveTaskSlug,
  retryContextSection,
  type RunningSessionState,
  runExploreSession,
  runHousekeeping,
  runningSessionLines,
  runRotate,
  selfHostedLibDir,
  type SelfHostedLibDirDeps,
  sessionDeadline,
  setRepoPaths,
  skipMainWriteIfGitBusy,
  startupRecoveryTotal,
  statePathOf,
  type SessionResult,
  type StagedChange,
  suggestSimilarTaskIds,
  summarizeAgentCommit,
  summarizePermissionDenials,
  supervisorSourceHash,
  type Task,
  taskFileChangedOnBranch,
  taskFromFile,
  taskFrontmatter,
  useRepoRoot,
  withTrailer,
  worktreeConflictPending,
} from "./supervisor.ts";
import {
  branchNameFor,
  createWorktree,
  mergeInProgress,
  parkedBranchNameFor,
  removeWorktree,
  worktreePathFor,
} from "./worktree.ts";
import { type LoopInput, planLoopStep } from "./scheduler.ts";

/**
 * runExploreSession の spawn 失敗回帰テスト用: node:child_process の spawn だけ差し替え、
 * execFileSync / spawnSync 等の他の named export(このファイル自身や supervisor.ts が git 操作に
 * 使う)は実物のまま通す。spawnControl.shouldThrow をテストごとに切り替えて同期 throw を注入する。
 */
const spawnControl = vi.hoisted(() => ({ shouldThrow: false }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnControl.shouldThrow) {
        throw new Error("spawn 起動に失敗した(テスト注入)");
      }
      return actual.spawn(...args);
    },
  };
});

/** 先頭 BOM(U+FEFF)。ソース中に不可視文字を直接書かないよう、コード値から組み立てる */
const BOM = String.fromCharCode(0xfeff);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-001",
    title: "タイトル",
    status: "ready",
    priority: 3,
    dependencies: [],
    retries: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    body: "本文",
    ...overrides,
  };
}

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
    parallel: { maxSessions: 1, worktreeDir: "/tmp/my-type-worktrees", linkPaths: ["node_modules"] },
    ...overrides,
  };
}

describe("planTaskSelection", () => {
  it("依存が failed の ready タスクは toBlock に入り、next に選ばれない", () => {
    const dep = makeTask({ id: "T-001", status: "failed" });
    const t = makeTask({ id: "T-002", status: "ready", dependencies: ["T-001"] });

    const { toBlock, next } = planTaskSelection([dep, t]);

    expect(toBlock).toEqual([{ task: t, deadDep: "T-001" }]);
    expect(next).toBeNull();
  });

  it("依存が blocked の場合も同様", () => {
    const dep = makeTask({ id: "T-001", status: "blocked" });
    const t = makeTask({ id: "T-002", status: "ready", dependencies: ["T-001"] });

    const { toBlock, next } = planTaskSelection([dep, t]);

    expect(toBlock).toEqual([{ task: t, deadDep: "T-001" }]);
    expect(next).toBeNull();
  });

  it("依存が completed なら runnable", () => {
    const dep = makeTask({ id: "T-001", status: "completed" });
    const t = makeTask({ id: "T-002", status: "ready", dependencies: ["T-001"] });

    const { toBlock, next } = planTaskSelection([dep, t]);

    expect(toBlock).toEqual([]);
    expect(next).toBe(t);
  });

  it("依存 ID がタスク一覧に存在しない(アーカイブ済み)場合は充足扱いで runnable", () => {
    const t = makeTask({ id: "T-002", status: "ready", dependencies: ["T-999"] });

    const { toBlock, next } = planTaskSelection([t]);

    expect(toBlock).toEqual([]);
    expect(next).toBe(t);
  });

  it("priority 昇順で選ばれ、同 priority なら createdAt 昇順", () => {
    const low = makeTask({ id: "T-001", priority: 5, createdAt: "2026-08-01T00:00:00.000Z" });
    const high = makeTask({ id: "T-002", priority: 1, createdAt: "2026-08-02T00:00:00.000Z" });
    const highEarlier = makeTask({
      id: "T-003",
      priority: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const { next } = planTaskSelection([low, high, highEarlier]);

    expect(next).toBe(highEarlier);
  });

  it("ready がなければ next は null、toBlock は空", () => {
    const t = makeTask({ id: "T-001", status: "working" });

    const { toBlock, next } = planTaskSelection([t]);

    expect(toBlock).toEqual([]);
    expect(next).toBeNull();
  });

  it("runningIds に含まれる ready タスクは runnable から外れ next に選ばれない", () => {
    const running = makeTask({ id: "T-001", priority: 1 });
    const other = makeTask({ id: "T-002", priority: 3 });

    const { toBlock, next } = planTaskSelection([running, other], new Date(), new Set(["T-001"]));

    expect(toBlock).toEqual([]);
    expect(next).toBe(other);
  });

  it("runningIds が唯一の ready タスクを覆う場合は next が null になる", () => {
    const running = makeTask({ id: "T-001" });

    const { next } = planTaskSelection([running], new Date(), new Set(["T-001"]));

    expect(next).toBeNull();
  });

  it("入力配列・要素が変更されない(status が書き換わっていないこと)", () => {
    const dep = makeTask({ id: "T-001", status: "failed" });
    const t = makeTask({ id: "T-002", status: "ready", dependencies: ["T-001"] });
    const tasks = [dep, t];
    const snapshot = JSON.parse(JSON.stringify(tasks));

    planTaskSelection(tasks);

    expect(tasks).toEqual(snapshot);
    expect(t.status).toBe("ready");
  });

  it("多段カスケード: X(failed) → A(ready, dep X) → B(ready, dep A) が 1 回で両方 toBlock になり、独立 C が next", () => {
    const x = makeTask({ id: "T-001", status: "failed" });
    const a = makeTask({ id: "T-002", status: "ready", dependencies: ["T-001"] });
    const b = makeTask({ id: "T-003", status: "ready", dependencies: ["T-002"] });
    const c = makeTask({ id: "T-004", status: "ready" });

    const { toBlock, next } = planTaskSelection([x, a, b, c]);

    expect(toBlock).toEqual([
      { task: a, deadDep: "T-001" },
      { task: b, deadDep: "T-002" },
    ]);
    expect(next).toBe(c);
  });

  it("3 段カスケード: X → A → B → D が 1 回で全部 toBlock になる", () => {
    const x = makeTask({ id: "T-001", status: "failed" });
    const a = makeTask({ id: "T-002", status: "ready", dependencies: ["T-001"] });
    const b = makeTask({ id: "T-003", status: "ready", dependencies: ["T-002"] });
    const d = makeTask({ id: "T-004", status: "ready", dependencies: ["T-003"] });

    const { toBlock, next } = planTaskSelection([x, a, b, d]);

    expect(toBlock).toEqual([
      { task: a, deadDep: "T-001" },
      { task: b, deadDep: "T-002" },
      { task: d, deadDep: "T-003" },
    ]);
    expect(next).toBeNull();
  });

  it("多段カスケードでも入力配列・要素は変更されない", () => {
    const x = makeTask({ id: "T-001", status: "failed" });
    const a = makeTask({ id: "T-002", status: "ready", dependencies: ["T-001"] });
    const b = makeTask({ id: "T-003", status: "ready", dependencies: ["T-002"] });
    const tasks = [x, a, b];
    const snapshot = JSON.parse(JSON.stringify(tasks));

    planTaskSelection(tasks);

    expect(tasks).toEqual(snapshot);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
  });

  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("snoozeUntil が未来のタスクは next に選ばれず、別の ready タスクが選ばれる", () => {
    const snoozed = makeTask({
      id: "T-001",
      priority: 1,
      snoozeUntil: "2026-08-15T00:00:00.000Z",
    });
    const other = makeTask({ id: "T-002", priority: 5 });

    const { next } = planTaskSelection([snoozed, other], NOW);

    expect(next).toBe(other);
  });

  it("snoozeUntil が過去のタスクは通常どおり選ばれる(期限切れで復帰)", () => {
    const t = makeTask({ id: "T-001", snoozeUntil: "2026-08-13T00:00:00.000Z" });

    const { next } = planTaskSelection([t], NOW);

    expect(next).toBe(t);
  });

  it("snoozeUntil が未設定のタスクは従来どおり選ばれる", () => {
    const t = makeTask({ id: "T-001" });

    const { next } = planTaskSelection([t], NOW);

    expect(next).toBe(t);
  });

  it("解釈不能な snoozeUntil は「スヌーズなし」として扱われ選ばれる", () => {
    const t = makeTask({ id: "T-001", snoozeUntil: "あとで" });

    const { next } = planTaskSelection([t], NOW);

    expect(next).toBe(t);
  });

  it("全タスクがスヌーズ中のとき next は null、toBlock は空、例外を投げない", () => {
    const a = makeTask({ id: "T-001", snoozeUntil: "2026-08-15T00:00:00.000Z" });
    const b = makeTask({ id: "T-002", snoozeUntil: "2026-08-20T00:00:00.000Z" });

    expect(() => planTaskSelection([a, b], NOW)).not.toThrow();
    const { toBlock, next } = planTaskSelection([a, b], NOW);
    expect(toBlock).toEqual([]);
    expect(next).toBeNull();
  });

  it("スヌーズ中でも依存が failed なら toBlock に入る(既存の block 挙動は変わらない)", () => {
    const dep = makeTask({ id: "T-001", status: "failed" });
    const t = makeTask({
      id: "T-002",
      dependencies: ["T-001"],
      snoozeUntil: "2026-08-20T00:00:00.000Z",
    });

    const { toBlock, next } = planTaskSelection([dep, t], NOW);

    expect(toBlock).toEqual([{ task: t, deadDep: "T-001" }]);
    expect(next).toBeNull();
  });

  it("スヌーズ中の ready タスク(依存充足・未実行)は snoozed に入り、runnable には入らない", () => {
    const t = makeTask({ id: "T-001", snoozeUntil: "2026-08-20T00:00:00.000Z" });

    const { snoozed, runnable } = planTaskSelection([t], NOW);

    expect(snoozed).toEqual([t]);
    expect(runnable).toEqual([]);
  });

  it("依存が未充足のスヌーズ中タスクは snoozed に入れない(時間が来ても実行可能にならないため)", () => {
    const dep = makeTask({ id: "T-001", status: "ready" });
    const t = makeTask({
      id: "T-002",
      dependencies: ["T-001"],
      snoozeUntil: "2026-08-20T00:00:00.000Z",
    });

    const { snoozed, runnable } = planTaskSelection([dep, t], NOW);

    expect(snoozed).toEqual([]);
    expect(runnable).toEqual([dep]);
  });
});

describe("planConflictResume", () => {
  const CONFLICT_NOW = new Date("2026-08-16T00:00:00.000Z");

  function resume(tasks: Task[], conflicted: string[], launched: string[] = []): string[] {
    return planConflictResume({
      tasks,
      now: CONFLICT_NOW,
      runningIds: new Set<string>(),
      launchedIds: new Set(launched),
      hasConflict: (id) => conflicted.includes(id),
    }).map((t) => t.id);
  }

  it("衝突中の worktree を持つ ready タスクだけを優先度順に返す", () => {
    const a = makeTask({ id: "T-001", priority: 5 });
    const b = makeTask({ id: "T-002", priority: 1 });
    const c = makeTask({ id: "T-003", priority: 1 });

    expect(resume([a, b, c], ["T-001", "T-002"])).toEqual(["T-002", "T-001"]);
  });

  it("この停止指示の後に既に起動したタスクは除外する(停止が無限に延びないため)", () => {
    const a = makeTask({ id: "T-001" });

    expect(resume([a], ["T-001"], ["T-001"])).toEqual([]);
  });

  it("スヌーズ中でも衝突解消の対象に含める(worktree を残したまま終われないため)", () => {
    const a = makeTask({ id: "T-001", snoozeUntil: "2026-08-17T00:00:00.000Z" });

    expect(resume([a], ["T-001"])).toEqual(["T-001"]);
  });

  it("スヌーズ中でも無視は 1 回限り(この停止指示の後に起動済みなら対象外)", () => {
    const a = makeTask({ id: "T-001", snoozeUntil: "2026-08-17T00:00:00.000Z" });

    expect(resume([a], ["T-001"], ["T-001"])).toEqual([]);
  });

  it("実行中・ready でない・依存が dead のタスクは対象外", () => {
    const running = makeTask({ id: "T-001" });
    const working = makeTask({ id: "T-002", status: "working" });
    const dead = makeTask({ id: "T-003", status: "failed" });
    const blocked = makeTask({ id: "T-004", dependencies: ["T-003"] });

    const ids = planConflictResume({
      tasks: [running, working, dead, blocked],
      now: CONFLICT_NOW,
      runningIds: new Set(["T-001"]),
      launchedIds: new Set<string>(),
      hasConflict: () => true,
    }).map((t) => t.id);

    expect(ids).toEqual([]);
  });

  it("タスクファイルを書き換えない(副作用がない)", () => {
    const dead = makeTask({ id: "T-001", status: "failed" });
    const blocked = makeTask({ id: "T-002", dependencies: ["T-001"] });
    const tasks = [dead, blocked];
    const snapshot = JSON.parse(JSON.stringify(tasks));

    resume(tasks, ["T-002"]);

    expect(tasks).toEqual(snapshot);
  });
});

describe("isSnoozed", () => {
  const NOW = new Date("2026-08-14T00:00:00.000Z");

  it("snoozeUntil が未設定なら false", () => {
    const t = makeTask({ snoozeUntil: undefined });

    expect(isSnoozed(t, NOW)).toBe(false);
  });

  it("snoozeUntil が未来なら true", () => {
    const t = makeTask({ snoozeUntil: "2026-08-15T00:00:00.000Z" });

    expect(isSnoozed(t, NOW)).toBe(true);
  });

  it("snoozeUntil が過去なら false", () => {
    const t = makeTask({ snoozeUntil: "2026-08-13T00:00:00.000Z" });

    expect(isSnoozed(t, NOW)).toBe(false);
  });

  it("解釈不能な snoozeUntil は false(スヌーズなし扱い)", () => {
    const t = makeTask({ snoozeUntil: "あとで" });

    expect(isSnoozed(t, NOW)).toBe(false);
  });
});

describe("pickModel", () => {
  it("既定は config.model", () => {
    const config = makeConfig();
    const task = makeTask();

    expect(pickModel(config, task)).toBe("opus");
  });

  it("task.model 指定時はそれ", () => {
    const config = makeConfig();
    const task = makeTask({ model: "sonnet" });

    expect(pickModel(config, task)).toBe("sonnet");
  });

  it("retries が escalation.afterRetries 以上なら escalation.model が task.model より優先", () => {
    const config = makeConfig({ escalation: { model: "claude-fable-5", afterRetries: 2 } });
    const task = makeTask({ model: "sonnet", retries: 2 });

    expect(pickModel(config, task)).toBe("claude-fable-5");
  });

  it("escalation.model が空文字なら発動しない", () => {
    const config = makeConfig({ escalation: { model: "", afterRetries: 0 } });
    const task = makeTask({ retries: 5 });

    expect(pickModel(config, task)).toBe("opus");
  });
});

describe("nextStopEscalation", () => {
  it("停止指示なし(none)なら clean を予約する", () => {
    expect(nextStopEscalation("none")).toEqual({ mode: "clean" });
  });

  it("clean なら緊急停止へ進む", () => {
    expect(nextStopEscalation("clean")).toBe("emergency");
  });

  it("3 段階で緊急停止に到達し、ファイルを一切介さない", () => {
    const first = nextStopEscalation("none");
    expect(first).not.toBe("emergency");
    expect(nextStopEscalation((first as { mode: "clean" }).mode)).toBe("emergency");
  });
});

describe("depSatisfied", () => {
  it("依存先が存在しなければ充足扱い", () => {
    const byId = new Map<string, Task>();

    expect(depSatisfied(byId, "T-999")).toBe(true);
  });

  it("依存先が completed なら充足", () => {
    const dep = makeTask({ id: "T-001", status: "completed" });
    const byId = new Map([[dep.id, dep]]);

    expect(depSatisfied(byId, "T-001")).toBe(true);
  });

  it("依存先が completed でなければ未充足", () => {
    const dep = makeTask({ id: "T-001", status: "working" });
    const byId = new Map([[dep.id, dep]]);

    expect(depSatisfied(byId, "T-001")).toBe(false);
  });
});

describe("byPriorityThenCreatedAt", () => {
  it("priority 昇順で並ぶ", () => {
    const a = makeTask({ id: "T-001", priority: 5 });
    const b = makeTask({ id: "T-002", priority: 1 });

    expect(byPriorityThenCreatedAt(a, b)).toBeGreaterThan(0);
    expect(byPriorityThenCreatedAt(b, a)).toBeLessThan(0);
  });

  it("priority が同値なら createdAt 昇順", () => {
    const a = makeTask({ id: "T-001", priority: 3, createdAt: "2026-08-02T00:00:00.000Z" });
    const b = makeTask({ id: "T-002", priority: 3, createdAt: "2026-08-01T00:00:00.000Z" });

    expect(byPriorityThenCreatedAt(a, b)).toBeGreaterThan(0);
    expect(byPriorityThenCreatedAt(b, a)).toBeLessThan(0);
  });
});

describe("taskFromFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("全フィールドありのファイルの正常パース(note/model 含む)", () => {
    const text = [
      "---",
      "title: タイトル",
      "status: ready",
      "priority: 2",
      "dependencies: [T-001, T-002]",
      "retries: 1",
      'note: "進捗メモ"',
      "model: sonnet",
      "createdAt: 2026-08-01T00:00:00.000Z",
      "---",
      "",
      "本文の内容",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "T-003.md"), text);

    const task = taskFromFile(dir, "T-003.md");

    expect(task).toEqual({
      id: "T-003",
      title: "タイトル",
      status: "ready",
      priority: 2,
      dependencies: ["T-001", "T-002"],
      retries: 1,
      note: "進捗メモ",
      model: "sonnet",
      createdAt: "2026-08-01T00:00:00.000Z",
      body: "本文の内容",
    });
  });

  it("廃止済みの updatedAt など未知の frontmatter フィールドは無視して読める", () => {
    const text = [
      "---",
      "title: タイトル",
      "status: ready",
      "createdAt: 2026-08-01T00:00:00.000Z",
      "updatedAt: 2026-08-02T00:00:00.000Z",
      "---",
      "本文",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "T-008.md"), text);

    const task = taskFromFile(dir, "T-008.md");

    expect(task).toEqual({
      id: "T-008",
      title: "タイトル",
      status: "ready",
      priority: 3,
      dependencies: [],
      retries: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      body: "本文",
    });
    expect(task).not.toHaveProperty("updatedAt");
  });

  it("status 欠落なら null", () => {
    const text = ["---", "title: タイトル", "---", "本文"].join("\n");
    fs.writeFileSync(path.join(dir, "T-004.md"), text);

    expect(taskFromFile(dir, "T-004.md")).toBeNull();
  });

  it("status が不正なら null", () => {
    const text = ["---", "status: nonsense", "---", "本文"].join("\n");
    fs.writeFileSync(path.join(dir, "T-005.md"), text);

    expect(taskFromFile(dir, "T-005.md")).toBeNull();
  });

  it("任意フィールド欠落時のデフォルト(title=ID, priority=3, dependencies=[], retries=0)", () => {
    const text = ["---", "status: ready", "---", "本文"].join("\n");
    fs.writeFileSync(path.join(dir, "T-006.md"), text);

    const task = taskFromFile(dir, "T-006.md");

    expect(task).toEqual({
      id: "T-006",
      title: "T-006",
      status: "ready",
      priority: 3,
      dependencies: [],
      retries: 0,
      createdAt: "",
      body: "本文",
    });
  });

  it("読めないファイル(ディレクトリを .md 名で作る)は null", () => {
    fs.mkdirSync(path.join(dir, "T-007.md"));

    expect(taskFromFile(dir, "T-007.md")).toBeNull();
  });

  it("先頭 BOM 付きファイルでも status が読め、null にならない(一覧から消えない)", () => {
    const text = BOM + ["---", "title: タイトル", "status: ready", "---", "本文"].join("\n");
    fs.writeFileSync(path.join(dir, "T-009.md"), text);

    expect(taskFromFile(dir, "T-009.md")).toEqual({
      id: "T-009",
      title: "タイトル",
      status: "ready",
      priority: 3,
      dependencies: [],
      retries: 0,
      createdAt: "",
      body: "本文",
    });
  });

  it("CRLF 改行のファイルでも status が読め、null にならない(一覧から消えない)", () => {
    const text = ["---", "title: タイトル", "status: ready", "---", "本文"].join("\r\n");
    fs.writeFileSync(path.join(dir, "T-011.md"), text);

    expect(taskFromFile(dir, "T-011.md")).toEqual({
      id: "T-011",
      title: "タイトル",
      status: "ready",
      priority: 3,
      dependencies: [],
      retries: 0,
      createdAt: "",
      body: "本文",
    });
  });

  it("BOM 付き依存先タスクが一覧から消えないため、未完了の依存を持つ後続タスクが誤って runnable にならない", () => {
    // 修正前は BOM 付きファイルが taskFromFile で null になり、依存先が「一覧にない」= 充足済み
    // 扱いになって、未完了の依存を持つ後続タスクが誤って動き出していた
    const depText = BOM + ["---", "title: 依存先", "status: working", "---", "本文"].join("\n");
    fs.writeFileSync(path.join(dir, "T-020.md"), depText);
    const text = ["---", "title: 後続", "status: ready", "dependencies: [T-020]", "---", "本文"].join("\n");
    fs.writeFileSync(path.join(dir, "T-021.md"), text);

    const tasks = fs
      .readdirSync(dir)
      .map((f) => taskFromFile(dir, f))
      .filter((t): t is Task => t !== null);
    const byId = new Map(tasks.map((t) => [t.id, t]));

    expect(byId.get("T-020")?.status).toBe("working");
    expect(depSatisfied(byId, "T-020")).toBe(false);
  });
});

describe("taskFrontmatter 往復", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-roundtrip-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Task をシリアライズしてファイル経由で読み直すと元の Task と一致する", () => {
    const original = makeTask({
      id: "T-010",
      title: "往復テスト",
      status: "blocked",
      priority: 4,
      dependencies: ["T-001", "T-002"],
      retries: 2,
      note: "依存待ち",
      model: "sonnet",
      createdAt: "2026-08-01T00:00:00.000Z",
      body: "本文の詳細説明\n2 行目",
    });

    const text = serializeFrontmatter(taskFrontmatter(original), original.body);
    fs.writeFileSync(path.join(dir, `${original.id}.md`), text);
    const restored = taskFromFile(dir, `${original.id}.md`);

    expect(restored).toEqual(original);
  });

  it("試行履歴入りの body も往復一致する", () => {
    const original = makeTask({
      id: "T-011",
      body: appendAttemptRecord("本文", {
        attempt: 1,
        at: "2026-08-14T00:00:00.000Z",
        kind: "timeout",
        reason: "タイムアウト(2400000ms)",
      }),
    });

    const text = serializeFrontmatter(taskFrontmatter(original), original.body);
    fs.writeFileSync(path.join(dir, `${original.id}.md`), text);
    const restored = taskFromFile(dir, `${original.id}.md`);

    expect(restored).toEqual(original);
  });
});

describe("appendAttemptRecord", () => {
  const rec = {
    attempt: 1,
    at: "2026-08-14T00:00:00.000Z",
    kind: "timeout" as const,
    reason: "タイムアウト(2400000ms)",
  };

  it("見出しが無い本文には見出しごと追加する", () => {
    const result = appendAttemptRecord("既存の本文", rec);

    expect(result).toContain("既存の本文");
    expect(result).toContain("## 試行履歴");
    expect(result).toContain("### 試行 1(2026-08-14T00:00:00.000Z, ccloop 記録: タイムアウト)");
    expect(result.match(/## 試行履歴/g)).toHaveLength(1);
  });

  it("見出しが既にある本文にはエントリのみ末尾に追加する(見出しは増えない)", () => {
    const withHeading = appendAttemptRecord("既存の本文", rec);
    const result = appendAttemptRecord(withHeading, { ...rec, attempt: 2, kind: "crash" });

    expect(result.match(/## 試行履歴/g)).toHaveLength(1);
    expect(result).toContain("### 試行 1(");
    expect(result).toContain("### 試行 2(");
    expect(result).toContain("ccloop 記録: 異常終了");
  });

  it("空の body でも壊れない", () => {
    const result = appendAttemptRecord("", rec);

    expect(result).toContain("## 試行履歴");
    expect(result).toContain("### 試行 1(");
  });

  it("kind ごとに定型文が異なる", () => {
    expect(appendAttemptRecord("", { ...rec, kind: "timeout" })).toContain(
      "git log --oneline -10",
    );
    expect(appendAttemptRecord("", { ...rec, kind: "crash" })).toContain("git log --oneline -10");
    expect(appendAttemptRecord("", { ...rec, kind: "recovery" })).toContain(
      "git log --oneline -10",
    );
    expect(appendAttemptRecord("", { ...rec, kind: "no-status-update" })).toContain(
      "status を更新しなかった",
    );
  });

  it("機械的検出であり失敗原因の分析ではない旨を明記する", () => {
    expect(appendAttemptRecord("", rec)).toContain("この記録は機械的検出のみで、失敗原因の分析ではない");
  });
});

describe("lastAttemptHistoryEntry", () => {
  it("見出しが無ければ null", () => {
    expect(lastAttemptHistoryEntry("本文だけ")).toBeNull();
  });

  it("見出しはあるがサブセクションが無ければ null", () => {
    expect(lastAttemptHistoryEntry("本文\n\n## 試行履歴\n")).toBeNull();
  });

  it("サブセクションが 1 つなら見出し行と本文をそのまま返す", () => {
    const body = appendAttemptRecord("本文", {
      attempt: 1,
      at: "2026-08-14T00:00:00.000Z",
      kind: "timeout",
      reason: "タイムアウト(2400000ms)",
    });
    const entry = lastAttemptHistoryEntry(body);
    expect(entry).toContain("### 試行 1(2026-08-14T00:00:00.000Z, ccloop 記録: タイムアウト)");
    expect(entry).toContain("タイムアウト(2400000ms)");
  });

  it("サブセクションが複数あれば最後の 1 つだけを返す(次の見出しの直前まで)", () => {
    const rec = {
      attempt: 1,
      at: "2026-08-14T00:00:00.000Z",
      kind: "timeout" as const,
      reason: "1 回目",
    };
    const body1 = appendAttemptRecord("本文", rec);
    const body2 = appendAttemptRecord(body1, { ...rec, attempt: 2, kind: "crash", reason: "2 回目" });
    const entry = lastAttemptHistoryEntry(body2);
    expect(entry).toContain("### 試行 2(");
    expect(entry).toContain("2 回目");
    expect(entry).not.toContain("### 試行 1(");
    expect(entry).not.toContain("1 回目");
  });

  it("試行履歴セクションの後に別の ## 見出しがあればそこで切る", () => {
    const body = `${appendAttemptRecord("本文", {
      attempt: 1,
      at: "2026-08-14T00:00:00.000Z",
      kind: "timeout",
      reason: "タイムアウト",
    })}\n\n## 別のセクション\n\n別セクションの本文`;
    const entry = lastAttemptHistoryEntry(body);
    expect(entry).not.toContain("別セクション");
  });
});

describe("suggestSimilarTaskIds", () => {
  it("部分文字列一致する ID を候補にする", () => {
    const result = suggestSimilarTaskIds("retry-subcommand", [
      "T-20260830-0344-retry-subcommand",
      "T-20260101-0000-unrelated-task",
    ]);
    expect(result).toEqual(["T-20260830-0344-retry-subcommand"]);
  });

  it("slug 部分のトークンを共有する ID を候補にする", () => {
    const result = suggestSimilarTaskIds("T-20260830-0344-retry-foo", [
      "T-20260101-0000-retry-bar",
      "T-20260101-0000-completely-different",
    ]);
    expect(result).toEqual(["T-20260101-0000-retry-bar"]);
  });

  it("一致も共有トークンも無ければ空配列", () => {
    const result = suggestSimilarTaskIds("no-such-task", ["T-20260101-0000-completely-different"]);
    expect(result).toEqual([]);
  });

  it("共有トークン数の多い順・ID 昇順で並び、最大 3 件に絞る", () => {
    const result = suggestSimilarTaskIds("retry-subcommand-docs", [
      "T-1-retry-subcommand-docs", // 3 トークン共有
      "T-2-retry-subcommand-docs", // 3 トークン共有(同率、ID 昇順で先の方が先着)
      "T-3-retry-only", // 1 トークン共有
      "T-4-docs-only", // 1 トークン共有
      "T-5-subcommand-only", // 1 トークン共有
    ]);
    expect(result).toEqual(["T-1-retry-subcommand-docs", "T-2-retry-subcommand-docs", "T-3-retry-only"]);
  });
});

describe("recordFailure", () => {
  it("上限未満のときは ready に戻し、retries を 1 増やす", () => {
    const t = makeTask({ retries: 0 });

    recordFailure(t, { maxRetries: 3, reason: "タイムアウト(1000ms)", kind: "timeout", at: "2026-08-14T00:00:00.000Z" });

    expect(t.status).toBe("ready");
    expect(t.retries).toBe(1);
    expect(t.note).toContain("1/3");
    expect(t.note).toContain("タイムアウト(1000ms)");
  });

  it("上限に達したときは failed にする", () => {
    const t = makeTask({ retries: 2 });

    recordFailure(t, { maxRetries: 3, reason: "claude が異常終了", kind: "crash", at: "2026-08-14T00:00:00.000Z" });

    expect(t.status).toBe("failed");
    expect(t.retries).toBe(3);
    expect(t.note).toContain("上限(3)に達した");
  });

  it("note に前 note が (元: ...) として含まれる", () => {
    const t = makeTask({ retries: 0, note: "前回の note" });

    recordFailure(t, { maxRetries: 3, reason: "理由", kind: "timeout", at: "2026-08-14T00:00:00.000Z" });

    expect(t.note).toContain("(元: 前回の note)");
  });

  it("前 note が undefined のときは (元: -) になる", () => {
    const t = makeTask({ retries: 0, note: undefined });

    recordFailure(t, { maxRetries: 3, reason: "理由", kind: "timeout", at: "2026-08-14T00:00:00.000Z" });

    expect(t.note).toContain("(元: -)");
  });

  it("80 字超の前 note は切り詰められて … が付く", () => {
    const longNote = "あ".repeat(100);
    const t = makeTask({ retries: 0, note: longNote });

    recordFailure(t, { maxRetries: 3, reason: "理由", kind: "timeout", at: "2026-08-14T00:00:00.000Z" });

    expect(t.note).toContain(`(元: ${"あ".repeat(80)}…)`);
    expect(t.note).not.toContain("あ".repeat(81));
  });

  it("body に ## 試行履歴 と ### 試行 1 が追加される", () => {
    const t = makeTask({ retries: 0, body: "本文" });

    recordFailure(t, { maxRetries: 3, reason: "理由", kind: "timeout", at: "2026-08-14T00:00:00.000Z" });

    expect(t.body).toContain("## 試行履歴");
    expect(t.body).toContain("### 試行 1(");
  });

  it("2 回連続で呼ぶと見出しは 1 つのままエントリが 2 つ増える", () => {
    const t = makeTask({ retries: 0, body: "本文" });

    recordFailure(t, { maxRetries: 5, reason: "1 回目", kind: "timeout", at: "2026-08-14T00:00:00.000Z" });
    recordFailure(t, { maxRetries: 5, reason: "2 回目", kind: "crash", at: "2026-08-14T01:00:00.000Z" });

    expect(t.body.match(/## 試行履歴/g)).toHaveLength(1);
    expect(t.body).toContain("### 試行 1(");
    expect(t.body).toContain("### 試行 2(");
  });

  it("kind=timeout の定型文(git log 確認)が body に含まれる", () => {
    const t = makeTask({ retries: 0, body: "本文" });

    recordFailure(t, { maxRetries: 3, reason: "理由", kind: "timeout", at: "2026-08-14T00:00:00.000Z" });

    expect(t.body).toContain("git log --oneline -10");
  });
});

describe("retryContextSection", () => {
  it("retries=0 のときは空配列(何も注入しない)", () => {
    const config = makeConfig({ maxRetries: 3 });
    const task = makeTask({ retries: 0 });

    expect(retryContextSection(config, task)).toEqual([]);
  });

  it("retries=2 のときは 3 回目の試行・直前の失敗・git log 確認を含む", () => {
    const config = makeConfig({ maxRetries: 5 });
    const task = makeTask({ retries: 2, note: "前回はタイムアウトした" });

    const [section] = retryContextSection(config, task);

    expect(section).toContain("再試行コンテキスト");
    expect(section).toContain("3 回目の試行");
    expect(section).toContain("直前の失敗: 前回はタイムアウトした");
    expect(section).toContain("git log");
  });

  it("note が無いときは「記録なし」と表示する", () => {
    const config = makeConfig();
    const task = makeTask({ retries: 1, note: undefined });

    const [section] = retryContextSection(config, task);

    expect(section).toContain("直前の失敗: 記録なし");
  });
});

describe("buildTaskPrompt", () => {
  it("retries=0 のタスクでは「再試行コンテキスト」が含まれない", () => {
    const config = makeConfig();
    const task = makeTask({ retries: 0 });

    expect(buildTaskPrompt(config, task)).not.toContain("再試行コンテキスト");
  });

  it("retries=2 のタスクでは「再試行コンテキスト」が含まれる", () => {
    const config = makeConfig({ maxRetries: 5 });
    const task = makeTask({ retries: 2, note: "前回失敗" });

    const prompt = buildTaskPrompt(config, task);

    expect(prompt).toContain("再試行コンテキスト");
    expect(prompt).toContain("3 回目の試行");
  });

  it("worktree の説明は常に含まれ、ブランチ名に触れる", () => {
    const prompt = buildTaskPrompt(makeConfig(), makeTask({ id: "T-042" }));

    expect(prompt).toContain("## 実行環境(Supervisor による機械的情報)");
    expect(prompt).toContain("agent/T-042");
    // ID は作成時刻 + slug で採番するため衝突せず、マージ時の改番は行わない
    expect(prompt).not.toContain("改番");
    expect(prompt).not.toContain("## 衝突解消セッション");
  });

  it("resuming のときだけ衝突解消セッションの指示が付く", () => {
    const prompt = buildTaskPrompt(makeConfig(), makeTask({ id: "T-042" }), { resuming: true });

    expect(prompt).toContain("## 衝突解消セッション(Supervisor による機械的情報)");
    expect(prompt).toContain("衝突マーカー");
    expect(prompt).toContain("main 側を優先");
  });

  it("deadline を渡すとその時刻がプロンプトに含まれる", () => {
    const prompt = buildTaskPrompt(makeConfig(), makeTask({ id: "T-042" }), {
      deadline: "2026-08-21T12:34:56.000Z",
    });

    expect(prompt).toContain("2026-08-21T12:34:56.000Z");
    expect(prompt).toContain("過ぎると強制終了される");
  });

  it("deadline を渡さない場合は締め切りの具体的な記述を含まない", () => {
    const prompt = buildTaskPrompt(makeConfig(), makeTask({ id: "T-042" }));

    expect(prompt).not.toContain("過ぎると強制終了される");
  });

  it("startedAt を渡すとその時刻がプロンプトに含まれる", () => {
    const prompt = buildTaskPrompt(makeConfig(), makeTask({ id: "T-042" }), {
      startedAt: "2026-08-21T09:12:34.567Z",
    });

    expect(prompt).toContain("2026-08-21T09:12:34.567Z");
    expect(prompt).toContain("「現在時刻」の基準");
  });

  it("startedAt を渡さない場合は開始時刻の記述を含まない(deadline のみでも壊れない)", () => {
    const prompt = buildTaskPrompt(makeConfig(), makeTask({ id: "T-042" }), {
      deadline: "2026-08-21T12:34:56.000Z",
    });

    expect(prompt).not.toContain("「現在時刻」の基準");
    expect(prompt).toContain("過ぎると強制終了される");
  });

  it("注入される startedAt は丸めた固定値ではなく実測の ISO 8601(ミリ秒付き)である", () => {
    const startedAt = new Date().toISOString();
    const prompt = buildTaskPrompt(makeConfig(), makeTask({ id: "T-042" }), { startedAt });

    // 他のセクションにも ISO 時刻が現れうるため、注入行だけを取り出して検証する
    const line = prompt.split("\n").find((l) => l.includes("「現在時刻」の基準"));
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(line).toContain(startedAt);
  });
});

describe("sessionDeadline", () => {
  it("開始時刻にタイムアウトを足した ISO 時刻を返す", () => {
    expect(sessionDeadline("2026-08-21T12:00:00.000Z", 40 * 60 * 1000)).toBe("2026-08-21T12:40:00.000Z");
  });
});

describe("diffInputs", () => {
  const current = { goalHash: "goal-b", answeredKeys: ["HR-001:aaa", "HR-002:bbb"] };

  it("前回情報がなければ両方 null(不明)", () => {
    expect(diffInputs({}, current)).toEqual({ goalChanged: null, newAnsweredIds: null });
  });

  it("GOAL のみ変化: goalChanged=true, newAnsweredIds は空配列", () => {
    const prev = { goalHash: "goal-a", answeredKeys: current.answeredKeys };

    expect(diffInputs(prev, current)).toEqual({ goalChanged: true, newAnsweredIds: [] });
  });

  it("Human Review のみ新規 answered: goalChanged=false, newAnsweredIds に新規 ID", () => {
    const prev = { goalHash: current.goalHash, answeredKeys: ["HR-001:aaa"] };

    expect(diffInputs(prev, current)).toEqual({ goalChanged: false, newAnsweredIds: ["HR-002"] });
  });

  it("両方変化: goalChanged=true, newAnsweredIds に新規 ID 全部", () => {
    const prev = { goalHash: "goal-a", answeredKeys: [] };

    expect(diffInputs(prev, current)).toEqual({
      goalChanged: true,
      newAnsweredIds: ["HR-001", "HR-002"],
    });
  });

  it("goalHash のみ前回情報あり、answeredKeys は前回情報なし", () => {
    const prev = { goalHash: current.goalHash };

    expect(diffInputs(prev, current)).toEqual({ goalChanged: false, newAnsweredIds: null });
  });

  it("既存回答の書き換え(同じ ID・別ハッシュ)は新規として検出される", () => {
    const prev = { goalHash: current.goalHash, answeredKeys: ["HR-001:old", "HR-002:bbb"] };

    expect(diffInputs(prev, current)).toEqual({ goalChanged: false, newAnsweredIds: ["HR-001"] });
  });
});

describe("parseOverview", () => {
  it("正常にパースできる", () => {
    const text = [
      "---",
      "updatedAt: 2026-08-10T03:00:00.000Z",
      "completed: 59",
      "total: 82",
      "---",
      "",
      "見立ての本文。",
    ].join("\n");

    expect(parseOverview(text)).toEqual({
      updatedAt: "2026-08-10T03:00:00.000Z",
      completed: 59,
      total: 82,
      body: "見立ての本文。",
    });
  });

  it("本文が空なら未生成扱いで null", () => {
    const text = ["---", "updatedAt: 2026-08-10T03:00:00.000Z", "completed: 59", "total: 82", "---"].join("\n");

    expect(parseOverview(text)).toBeNull();
  });

  it("数値が欠落・非数値なら 0 にフォールバックする(例外を投げない)", () => {
    const text = ["---", "updatedAt: 2026-08-10T03:00:00.000Z", "---", "", "本文"].join("\n");

    expect(parseOverview(text)).toEqual({
      updatedAt: "2026-08-10T03:00:00.000Z",
      completed: 0,
      total: 0,
      body: "本文",
    });
  });
});

describe("overviewSectionLines", () => {
  it("overview が null なら未生成の案内 1 行のみ", () => {
    expect(overviewSectionLines(null, 61, 82)).toEqual({
      rest: "未生成(次回の探索セッションが作成する)",
      lines: [],
    });
  });

  it("生成時点と現在の進捗を並記する", () => {
    const overview = {
      updatedAt: "2026-08-10T03:00:00.000Z",
      completed: 59,
      total: 82,
      body: "本文1行目\n本文2行目",
    };

    expect(overviewSectionLines(overview, 61, 82)).toEqual({
      rest: "2026-08-10T03:00:00.000Z 時点(完了 59/82 → 現在 61/82)",
      lines: ["本文1行目", "本文2行目"],
    });
  });

  it("updatedAt が空なら「不明」と表示する", () => {
    const overview = { updatedAt: "", completed: 59, total: 82, body: "本文" };

    const { rest } = overviewSectionLines(overview, 61, 82);

    expect(rest).toContain("不明 時点");
  });

  it("updatedAt が epoch(雛形の初期値)なら「(未生成)」と表示する", () => {
    // lib/templates/agent/OVERVIEW.md の初期値。init 直後、探索セッションがまだ 1 度も
    // 更新していない状態で「1970-01-01... 時点」と出るのを防ぐ。
    const overview = { updatedAt: "1970-01-01T00:00:00.000Z", completed: 0, total: 0, body: "本文" };

    const { rest } = overviewSectionLines(overview, 61, 82);

    expect(rest).toContain("(未生成) 時点");
  });

  it("本文が maxLines を超える場合は先頭 maxLines 行 + 省略メッセージにする", () => {
    const body = ["1行目", "2行目", "3行目", "4行目", "5行目", "6行目", "7行目", "8行目"].join("\n");
    const overview = { updatedAt: "2026-08-10T03:00:00.000Z", completed: 59, total: 82, body };

    const { lines } = overviewSectionLines(overview, 61, 82);

    expect(lines).toEqual([
      "1行目",
      "2行目",
      "3行目",
      "4行目",
      "5行目",
      "6行目",
      "…(全8行、詳細は .agent/OVERVIEW.md)",
    ]);
  });
});

describe("formatElapsed", () => {
  it("60秒未満は秒", () => {
    expect(formatElapsed(45000)).toBe("45秒");
    expect(formatElapsed(59000)).toBe("59秒");
  });

  it("60分未満は分", () => {
    expect(formatElapsed(60000)).toBe("1分");
    expect(formatElapsed(12 * 60000)).toBe("12分");
  });

  it("60分ちょうどは1時間0分", () => {
    expect(formatElapsed(60 * 60000)).toBe("1時間0分");
  });

  it("60分超は時間+分", () => {
    expect(formatElapsed(65 * 60000)).toBe("1時間5分");
  });

  it("0ms は0秒", () => {
    expect(formatElapsed(0)).toBe("0秒");
  });

  it("59分は境界を跨がずそのまま分表記", () => {
    expect(formatElapsed(59 * 60000)).toBe("59分");
  });

  it("負値は0秒に丸められる(時計のずれ対策)", () => {
    expect(formatElapsed(-1000)).toBe("0秒");
  });
});

function makeRunningSession(overrides: Partial<RunningSessionState> = {}): RunningSessionState {
  return { kind: "task", taskId: "T-001", startedAt: "2026-08-16T00:00:00.000Z", ...overrides };
}

const RUNNING_LIVENESS: LoopLiveness = {
  status: "running",
  pid: 1,
  startedAt: "2026-08-16T00:00:00.000Z",
  heartbeatAt: "2026-08-16T00:00:00.000Z",
};

describe("runningSessionLines", () => {
  const staleAfterMs = 2400000; // 40分

  it("セッションが無ければ空配列を返す", () => {
    expect(runningSessionLines([], new Map(), new Date(), staleAfterMs, 1, RUNNING_LIVENESS)).toEqual([]);
  });

  it("タスク実行中1件: ヘッダー・ID・優先度・タイトル・経過時間を表示する", () => {
    const t = makeTask({ id: "T-156", priority: 2, title: "GUI スクリーンショットの日本語表示を直す" });
    const byId = new Map([[t.id, t]]);
    const sessions = [
      makeRunningSession({ taskId: "T-156", startedAt: "2026-08-16T02:20:00.000Z" }),
    ];
    const now = new Date("2026-08-16T02:32:00.000Z");

    expect(runningSessionLines(sessions, byId, now, staleAfterMs, 1, RUNNING_LIVENESS)).toEqual([
      "実行中のセッション (1/1)",
      "T-156  p2  GUI スクリーンショットの日本語表示を直す",
      "  12分経過 (2026-08-16T02:20:00.000Z 開始)",
    ]);
  });

  it("探索セッション実行中: 経過時間つきで表示する", () => {
    const sessions = [makeRunningSession({ kind: "explore", taskId: undefined, startedAt: "2026-08-16T02:00:00.000Z" })];
    const now = new Date("2026-08-16T02:00:45.000Z");

    expect(runningSessionLines(sessions, new Map(), now, staleAfterMs, 1, RUNNING_LIVENESS)).toEqual([
      "実行中のセッション (1/1)",
      "探索セッション  (次の作業を探索中)",
      "  45秒経過 (2026-08-16T02:00:00.000Z 開始)",
    ]);
  });

  it("2件同時実行: ヘッダーの分母が maxSessions になり、セッションごとに行が並ぶ", () => {
    const t1 = makeTask({ id: "T-001", priority: 1, title: "タスク1" });
    const t2 = makeTask({ id: "T-002", priority: 2, title: "タスク2" });
    const byId = new Map([
      [t1.id, t1],
      [t2.id, t2],
    ]);
    const sessions = [
      makeRunningSession({ taskId: "T-001", startedAt: "2026-08-16T02:00:00.000Z" }),
      makeRunningSession({ taskId: "T-002", startedAt: "2026-08-16T02:10:00.000Z" }),
    ];
    const now = new Date("2026-08-16T02:20:00.000Z");

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 2, RUNNING_LIVENESS);

    expect(lines).toEqual([
      "実行中のセッション (2/2)",
      "T-001  p1  タスク1",
      "  20分経過 (2026-08-16T02:00:00.000Z 開始)",
      "T-002  p2  タスク2",
      "  10分経過 (2026-08-16T02:10:00.000Z 開始)",
    ]);
  });

  it("phase が finishing のセッションはメイン行に「マージ中」を付す", () => {
    const t = makeTask({ id: "T-001" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ phase: "finishing", startedAt: "2026-08-16T02:00:00.000Z" })];
    const now = new Date("2026-08-16T02:00:00.000Z");

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, RUNNING_LIVENESS);

    expect(lines[1]).toBe("T-001  p3  タイトル  マージ中");
  });

  it("経過時間が staleAfterMs を超えたらタイムアウト注記行を追加する", () => {
    const t = makeTask({ id: "T-001" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ startedAt: "2026-08-16T00:00:00.000Z" })];
    const now = new Date("2026-08-16T01:00:01.000Z"); // 60分1秒経過 > staleAfterMs(40分)

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, RUNNING_LIVENESS);

    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain("タイムアウト(40分)を超過");
  });

  it("経過時間がちょうど staleAfterMs なら(> 判定のため)タイムアウト注記は出ない", () => {
    const t = makeTask({ id: "T-001" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ startedAt: "2026-08-16T00:00:00.000Z" })];
    const now = new Date(new Date(sessions[0]!.startedAt).getTime() + staleAfterMs); // ちょうど40分経過

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, RUNNING_LIVENESS);

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("タイムアウト");
  });

  it("時計のずれで now が startedAt より前でも0秒経過として表示する(例外を投げない)", () => {
    const t = makeTask({ id: "T-001" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ startedAt: "2026-08-16T02:00:00.000Z" })];
    const now = new Date("2026-08-16T01:59:00.000Z"); // startedAt より1分前

    expect(() => runningSessionLines(sessions, byId, now, staleAfterMs, 1, RUNNING_LIVENESS)).not.toThrow();
    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, RUNNING_LIVENESS);
    expect(lines[2]).toBe("  0秒経過 (2026-08-16T02:00:00.000Z 開始)");
  });

  it("タスクが byId に無い場合はフォールバック表示にする", () => {
    const sessions = [makeRunningSession({ taskId: "T-999", startedAt: "2026-08-16T02:20:00.000Z" })];
    const now = new Date("2026-08-16T02:20:05.000Z");

    const lines = runningSessionLines(sessions, new Map(), now, staleAfterMs, 1, RUNNING_LIVENESS);

    expect(lines[1]).toBe("T-999  (タスクファイルが見つからない)");
  });

  it("startedAt がパース不能なら経過時間行を出さない", () => {
    const t = makeTask({ id: "T-010" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ taskId: "T-010", startedAt: "invalid-date" })];

    expect(runningSessionLines(sessions, byId, new Date(), staleAfterMs, 1, RUNNING_LIVENESS)).toEqual([
      "実行中のセッション (1/1)",
      "T-010  p3  タイトル",
    ]);
  });

  it("ループ停止中(process-gone)は「実行中ではないセッションの記録」見出しになり、経過・タイムアウト行は出ない", () => {
    const t = makeTask({ id: "T-001" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ startedAt: "2026-08-16T00:00:00.000Z" })];
    // staleAfterMs を大きく超えた now でもタイムアウト注記が出ないことを確認する
    const now = new Date("2026-08-17T00:00:00.000Z");
    const liveness: LoopLiveness = {
      status: "stopped",
      reason: "process-gone",
      pid: 12345,
      startedAt: "2026-08-15T00:00:00.000Z",
      heartbeatAt: "2026-08-15T00:00:00.000Z",
    };

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, liveness);

    expect(lines[0]).toBe("※ ループ本体(ccloop run)が動いていないため、下記の 1 件は実行中ではなく記録が残っているだけ");
    expect(lines.join("\n")).not.toContain("経過");
    expect(lines.join("\n")).not.toContain("タイムアウト");
  });

  it("ループ停止中(no-record)でも同じ扱いになる", () => {
    const t = makeTask({ id: "T-001" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ startedAt: "2026-08-16T00:00:00.000Z" })];
    const now = new Date("2026-08-17T00:00:00.000Z");
    const liveness: LoopLiveness = { status: "stopped", reason: "no-record" };

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, liveness);

    expect(lines[0]).toBe("※ ループ本体(ccloop run)が動いていないため、下記の 1 件は実行中ではなく記録が残っているだけ");
    expect(lines.join("\n")).not.toContain("経過");
    expect(lines.join("\n")).not.toContain("タイムアウト");
  });

  it("ループ停止中で startedAt がパース不能なら開始時刻行を出さない", () => {
    const t = makeTask({ id: "T-001" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ startedAt: "not-a-date" })];
    const now = new Date("2026-08-17T00:00:00.000Z");
    const liveness: LoopLiveness = { status: "stopped", reason: "no-record" };

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, liveness);

    expect(lines.join("\n")).not.toContain("開始");
  });

  it("生存確認できない(unknown/heartbeat-stale)ときは見出しは従来どおりで、注意行が1行追加され経過時間行も従来どおり出る", () => {
    const t = makeTask({ id: "T-156", priority: 2, title: "GUI スクリーンショットの日本語表示を直す" });
    const byId = new Map([[t.id, t]]);
    const sessions = [makeRunningSession({ taskId: "T-156", startedAt: "2026-08-16T02:20:00.000Z" })];
    const now = new Date("2026-08-16T02:32:00.000Z");
    const liveness: LoopLiveness = {
      status: "unknown",
      reason: "heartbeat-stale",
      pid: 12345,
      startedAt: "2026-08-16T00:00:00.000Z",
      heartbeatAt: "2026-08-16T01:00:00.000Z",
    };

    const lines = runningSessionLines(sessions, byId, now, staleAfterMs, 1, liveness);

    expect(lines).toEqual([
      "実行中のセッション (1/1)",
      "※ ループ本体(ccloop run)の生存を確認できないため、下記は古い記録の可能性がある",
      "T-156  p2  GUI スクリーンショットの日本語表示を直す",
      "  12分経過 (2026-08-16T02:20:00.000Z 開始)",
    ]);
  });
});

describe("normalizeState", () => {
  it("新形式(runningSessions が配列)はそのまま(ゆるく検証しつつ)使う", () => {
    const raw = {
      runningSessions: [{ kind: "task", taskId: "T-001", startedAt: "2026-08-16T00:00:00.000Z", model: "opus" }],
      lastExploreAt: "2026-08-16T00:00:00.000Z",
      rateLimit: { resumeAt: null },
      sessionCount: 5,
      updatedAt: "2026-08-16T00:00:00.000Z",
    };

    const state = normalizeState(raw);

    expect(state.runningSessions).toEqual([
      { kind: "task", taskId: "T-001", startedAt: "2026-08-16T00:00:00.000Z", model: "opus" },
    ]);
    expect(state.sessionCount).toBe(5);
  });

  it("runningSessions の要素に startedAt が無ければ現在時刻で補う", () => {
    const before = Date.now();
    const state = normalizeState({ runningSessions: [{ kind: "explore" }] });
    const after = Date.now();

    expect(state.runningSessions).toHaveLength(1);
    const startMs = Date.parse(state.runningSessions[0]!.startedAt);
    expect(startMs).toBeGreaterThanOrEqual(before);
    expect(startMs).toBeLessThanOrEqual(after);
  });

  it("旧スカラー形式(task): currentTaskId/currentSessionKind/currentSessionStartedAt から1件合成する", () => {
    const state = normalizeState({
      currentTaskId: "T-050",
      currentSessionKind: "task",
      currentSessionStartedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(state.runningSessions).toEqual([
      { kind: "task", taskId: "T-050", startedAt: "2026-08-16T00:00:00.000Z" },
    ]);
  });

  it("旧スカラー形式(explore): currentSessionKind が explore なら explore セッションを合成する", () => {
    const state = normalizeState({
      currentTaskId: null,
      currentSessionKind: "explore",
      currentSessionStartedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(state.runningSessions).toEqual([{ kind: "explore", startedAt: "2026-08-16T00:00:00.000Z" }]);
  });

  it("旧旧形式(currentSessionKind 未定義)は currentTaskId の有無で task セッションを合成する", () => {
    const state = normalizeState({ currentTaskId: "T-050", currentSessionStartedAt: "2026-08-16T00:00:00.000Z" });

    expect(state.runningSessions).toEqual([
      { kind: "task", taskId: "T-050", startedAt: "2026-08-16T00:00:00.000Z" },
    ]);
  });

  it("currentSessionKind が task かつ currentTaskId が null なら空配列", () => {
    const state = normalizeState({
      currentTaskId: null,
      currentSessionKind: "task",
      currentSessionStartedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(state.runningSessions).toEqual([]);
  });

  it("どちらの形式の手がかりも無ければ空配列", () => {
    const state = normalizeState({});

    expect(state.runningSessions).toEqual([]);
  });

  it("state.json が存在しない相当(undefined)でも例外を投げず空配列にする", () => {
    expect(() => normalizeState(undefined)).not.toThrow();
    expect(normalizeState(undefined).runningSessions).toEqual([]);
  });
});

describe("supervisorSourceHash", () => {
  // dir は CCLOOP_HOME(ccloop 自身のインストール先 = lib/)に見立てた一時ディレクトリ
  let dir: string;

  function writeSrc(name: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-srchash-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("同じ内容なら同じハッシュになる", () => {
    writeSrc("supervisor.ts", "export const a = 1;\n");

    expect(supervisorSourceHash(dir)).toBe(supervisorSourceHash(dir));
  });

  it(".ts の内容を変えるとハッシュが変わる", () => {
    writeSrc("supervisor.ts", "export const a = 1;\n");
    const before = supervisorSourceHash(dir);

    writeSrc("supervisor.ts", "export const a = 2;\n");

    expect(supervisorSourceHash(dir)).not.toBe(before);
  });

  it(".md / .json の内容を変えるとハッシュが変わる(PROMPT やテンプレートの変更も再起動が要る)", () => {
    writeSrc("supervisor.ts", "export const a = 1;\n");
    writeSrc("settings.template.json", "{}\n");
    const before = supervisorSourceHash(dir);

    writeSrc("settings.template.json", "{\"permissions\": {}}\n");

    expect(supervisorSourceHash(dir)).not.toBe(before);
  });

  it("サブディレクトリの内容を変えてもハッシュが変わる(共通ルール・サブエージェント定義も対象)", () => {
    writeSrc("supervisor.ts", "export const a = 1;\n");
    writeSrc("prompt/PROMPT.md", "# 共通ルール\n");
    writeSrc("agents/reviewer.md", "---\ndescription: d\n---\n\n本文\n");
    const before = supervisorSourceHash(dir);

    writeSrc("prompt/PROMPT.md", "# 共通ルール(改訂)\n");
    const afterPrompt = supervisorSourceHash(dir);
    expect(afterPrompt).not.toBe(before);

    writeSrc("agents/reviewer.md", "---\ndescription: d2\n---\n\n本文\n");
    expect(supervisorSourceHash(dir)).not.toBe(afterPrompt);
  });

  it(".test.ts の内容を変えてもハッシュは変わらない", () => {
    writeSrc("supervisor.ts", "export const a = 1;\n");
    writeSrc("supervisor.test.ts", "it 1\n");
    const before = supervisorSourceHash(dir);

    writeSrc("supervisor.test.ts", "it 2 に書き換える\n");

    expect(supervisorSourceHash(dir)).toBe(before);
  });

  it("ファイルを追加するとハッシュが変わる", () => {
    writeSrc("supervisor.ts", "export const a = 1;\n");
    const before = supervisorSourceHash(dir);

    writeSrc("frontmatter.ts", "export const b = 2;\n");

    expect(supervisorSourceHash(dir)).not.toBe(before);
  });

  it("CCLOOP_HOME のディレクトリが無ければ例外を投げず空文字を返す", () => {
    fs.rmSync(dir, { recursive: true, force: true });

    expect(() => supervisorSourceHash(dir)).not.toThrow();
    expect(supervisorSourceHash(dir)).toBe("");
  });

  it(".ts で終わる名前のディレクトリがあっても無視する(例外を投げない)", () => {
    writeSrc("supervisor.ts", "export const a = 1;\n");
    const before = supervisorSourceHash(dir);
    fs.mkdirSync(path.join(dir, "sub.ts"));

    expect(() => supervisorSourceHash(dir)).not.toThrow();
    expect(supervisorSourceHash(dir)).toBe(before);
  });
});

describe("isSupervisorSourceStale", () => {
  it("recorded が undefined なら判定不能として変化なし扱いにする", () => {
    expect(isSupervisorSourceStale(undefined, "abc")).toBe(false);
  });

  it("recorded が null なら判定不能として変化なし扱いにする", () => {
    expect(isSupervisorSourceStale(null, "abc")).toBe(false);
  });

  it("recorded と current が一致すれば変化なし", () => {
    expect(isSupervisorSourceStale("abc", "abc")).toBe(false);
  });

  it("recorded と current が異なれば変化ありと判定する", () => {
    expect(isSupervisorSourceStale("abc", "xyz")).toBe(true);
  });
});

describe("selfHostedLibDir", () => {
  /** files: package.json のパス → 中身の文字列。それ以外は読めない扱い */
  const depsFrom = (files: Record<string, string>, existingPaths: Set<string>): SelfHostedLibDirDeps => ({
    exists: (p) => existingPaths.has(p),
    readFile: (p) => files[p] ?? null,
  });

  it("name が claude-code-loop で lib/supervisor.ts があれば lib パスを返す", () => {
    const pkgPath = path.join("/repo", "package.json");
    const supervisorPath = path.join("/repo", "lib", "supervisor.ts");
    const deps = depsFrom({ [pkgPath]: JSON.stringify({ name: "claude-code-loop" }) }, new Set([supervisorPath]));

    expect(selfHostedLibDir("/repo", deps)).toBe(path.join("/repo", "lib"));
  });

  it("name が claude-code-loop 以外なら null", () => {
    const pkgPath = path.join("/repo", "package.json");
    const supervisorPath = path.join("/repo", "lib", "supervisor.ts");
    const deps = depsFrom({ [pkgPath]: JSON.stringify({ name: "some-other-repo" }) }, new Set([supervisorPath]));

    expect(selfHostedLibDir("/repo", deps)).toBeNull();
  });

  it("package.json が読めなければ null", () => {
    const deps = depsFrom({}, new Set([path.join("/repo", "lib", "supervisor.ts")]));

    expect(selfHostedLibDir("/repo", deps)).toBeNull();
  });

  it("package.json が不正な JSON なら null", () => {
    const pkgPath = path.join("/repo", "package.json");
    const deps = depsFrom({ [pkgPath]: "{ not json" }, new Set([path.join("/repo", "lib", "supervisor.ts")]));

    expect(selfHostedLibDir("/repo", deps)).toBeNull();
  });

  it("lib/supervisor.ts が無ければ null", () => {
    const pkgPath = path.join("/repo", "package.json");
    const deps = depsFrom({ [pkgPath]: JSON.stringify({ name: "claude-code-loop" }) }, new Set());

    expect(selfHostedLibDir("/repo", deps)).toBeNull();
  });
});

describe("isInstalledSourceDrifted", () => {
  it("repoLibDir が null(自己ホストでない)なら乖離なし扱い", () => {
    expect(
      isInstalledSourceDrifted({ repoLibDir: null, installedHome: "/usr/local/share/ccloop/lib", repoHash: "a", installedHash: "b" }),
    ).toBe(false);
  });

  it("repoLibDir と installedHome が一致(ソースから直接起動)なら乖離なし扱い", () => {
    expect(
      isInstalledSourceDrifted({
        repoLibDir: "/repo/lib",
        installedHome: "/repo/lib",
        repoHash: "a",
        installedHash: "b",
      }),
    ).toBe(false);
  });

  it("repoHash が空(読めず判定不能)なら乖離なし扱い", () => {
    expect(
      isInstalledSourceDrifted({
        repoLibDir: "/repo/lib",
        installedHome: "/usr/local/share/ccloop/lib",
        repoHash: "",
        installedHash: "b",
      }),
    ).toBe(false);
  });

  it("installedHash が空(読めず判定不能)なら乖離なし扱い", () => {
    expect(
      isInstalledSourceDrifted({
        repoLibDir: "/repo/lib",
        installedHome: "/usr/local/share/ccloop/lib",
        repoHash: "a",
        installedHash: "",
      }),
    ).toBe(false);
  });

  it("ハッシュが一致すれば乖離なし", () => {
    expect(
      isInstalledSourceDrifted({
        repoLibDir: "/repo/lib",
        installedHome: "/usr/local/share/ccloop/lib",
        repoHash: "abc",
        installedHash: "abc",
      }),
    ).toBe(false);
  });

  it("ハッシュが異なれば乖離ありと判定する", () => {
    expect(
      isInstalledSourceDrifted({
        repoLibDir: "/repo/lib",
        installedHome: "/usr/local/share/ccloop/lib",
        repoHash: "abc",
        installedHash: "xyz",
      }),
    ).toBe(true);
  });
});

describe("installedSourceDriftLines", () => {
  it("drifted が false なら空配列", () => {
    expect(installedSourceDriftLines(false)).toEqual([]);
  });

  it("drifted が true なら 1 行返し、supervisorSourceStale の警告文言とは混同しない", () => {
    const lines = installedSourceDriftLines(true);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("supervisor のコードが起動後に変更されている");
  });
});

describe("ensureWritableDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-writable-"));
  });

  afterEach(() => {
    // 読み取り専用にしたテストが復元し忘れると rmSync が失敗するため、念のためここでも戻す
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("既存の書き込み可能なディレクトリなら null", () => {
    expect(ensureWritableDir(dir)).toBeNull();
  });

  it("存在しないディレクトリは作成できれば null(親が書き込み可能な場合)", () => {
    const target = path.join(dir, "nested", "worktrees");
    expect(ensureWritableDir(target)).toBeNull();
    expect(fs.existsSync(target)).toBe(true);
  });

  // root は permission mode を無視するため、root で実行されるとこのテストは成立しない
  it.skipIf(process.getuid?.() === 0)("読み取り専用ディレクトリはエラーメッセージを返す", () => {
    fs.chmodSync(dir, 0o555);
    try {
      const result = ensureWritableDir(dir);
      expect(result).not.toBeNull();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  // root は permission mode を無視するため、root で実行されるとこのテストは成立しない
  it.skipIf(process.getuid?.() === 0)("親が読み取り専用で新規作成できない場合もエラーメッセージを返す", () => {
    fs.chmodSync(dir, 0o555);
    try {
      const result = ensureWritableDir(path.join(dir, "nested"));
      expect(result).not.toBeNull();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});

describe("crashResultFromError", () => {
  it("想定外の例外をセッション結果へ落とし込む(セッションを取りこぼさないため)", () => {
    const res = crashResultFromError(new Error("boom"));

    expect(res.exitCode).toBeNull();
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("boom");
  });

  it("Error でない値も文字列化して残す", () => {
    expect(crashResultFromError("切断").stderr).toContain("切断");
  });
});

describe("buildClaudeArgs", () => {
  it("プロンプト・model・permissionMode・settings・共通ルール・サブエージェントを含む", () => {
    const config = makeConfig({ permissionMode: "auto" });
    const args = buildClaudeArgs(config, "プロンプト本文", "haiku");

    expect(args).toEqual([
      "-p",
      "プロンプト本文",
      "--output-format",
      "json",
      "--model",
      "haiku",
      "--permission-mode",
      "auto",
      "--settings",
      expect.stringContaining("claude-settings.json"),
      "--append-system-prompt-file",
      expect.stringContaining("system-prompt.md"),
      "--agents",
      expect.any(String),
    ]);
  });

  it("--agents には lib/agents/ のサブエージェント定義(reviewer)が JSON で載る", () => {
    const args = buildClaudeArgs(makeConfig(), "p", "opus");

    const json = args[args.indexOf("--agents") + 1]!;
    const parsed = JSON.parse(json) as Record<string, { description: string; prompt: string; tools: string[]; model: string }>;
    expect(Object.keys(parsed)).toContain("reviewer");
    expect(parsed.reviewer!.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(parsed.reviewer!.model).toBe("sonnet");
    expect(parsed.reviewer!.description).not.toBe("");
    expect(parsed.reviewer!.prompt).toContain("独立したコードレビュアー");
    // name は JSON のキーで表すため、フィールドとしては渡さない
    expect(parsed.reviewer).not.toHaveProperty("name");
  });

  it("commonRules: false なら system prompt もサブエージェントも渡さない(triage セッション)", () => {
    const args = buildClaudeArgs(makeConfig(), "p", "haiku", [], { commonRules: false });

    expect(args).not.toContain("--append-system-prompt-file");
    expect(args).not.toContain("--agents");
    expect(args).toContain("--settings");
  });

  it("maxTurns > 0 なら --max-turns を付ける(既定値扱い)", () => {
    const config = makeConfig({ maxTurns: 150 });
    expect(buildClaudeArgs(config, "p", "opus")).toEqual(
      expect.arrayContaining(["--max-turns", "150"]),
    );
  });

  it("maxTurns が 0 以下なら --max-turns を付けない", () => {
    const config = makeConfig({ maxTurns: 0 });
    expect(buildClaudeArgs(config, "p", "opus")).not.toContain("--max-turns");
  });

  it("extraArgs は既定の --max-turns より後ろに置く(重複フラグは最後が勝つため上書きできる)", () => {
    const config = makeConfig({ maxTurns: 150 });
    const args = buildClaudeArgs(config, "p", "haiku", ["--max-turns", "6"]);

    // 既定の "150" と extraArgs の "6" の両方が現れるが、"6" が最後(= 有効値)
    const indices = args.reduce<number[]>((acc, v, i) => (v === "--max-turns" ? [...acc, i] : acc), []);
    expect(indices).toHaveLength(2);
    expect(args[indices[1]! + 1]).toBe("6");
    expect(args.at(-2)).toBe("--max-turns");
    expect(args.at(-1)).toBe("6");
  });

  it("extraArgs(--worktree 等、重複しないフラグ)はそのまま末尾に追加される", () => {
    const config = makeConfig({ maxTurns: 0 });
    const args = buildClaudeArgs(config, "p", "opus", ["--worktree", "T-001"]);

    expect(args.slice(-2)).toEqual(["--worktree", "T-001"]);
  });
});

describe("refreshGeneratedSessionInputs", () => {
  let dir: string;
  let paths: Paths;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-refresh-test-"));
    paths = createPaths(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(paths.stateDir, { recursive: true, force: true });
  });

  it("呼び出しのたびに .agent/claude-settings.json を読み直す(run の起動時 1 回ではない)", () => {
    refreshGeneratedSessionInputs(paths);
    const before = JSON.parse(fs.readFileSync(paths.generatedSettingsPath, "utf8")) as {
      permissions?: { allow?: string[] };
    };
    expect(before.permissions?.allow ?? []).not.toContain("Bash(cargo *)");

    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.agentDir, "claude-settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(cargo *)"] } }),
    );
    refreshGeneratedSessionInputs(paths);

    const after = JSON.parse(fs.readFileSync(paths.generatedSettingsPath, "utf8")) as {
      permissions?: { allow?: string[] };
    };
    expect(after.permissions?.allow).toContain("Bash(cargo *)");
  });

  it("呼び出しのたびに .agent/PROMPT.local.md を読み直す(run の起動時 1 回ではない)", () => {
    refreshGeneratedSessionInputs(paths);
    const before = fs.readFileSync(paths.generatedSystemPromptPath, "utf8");
    expect(before).not.toContain("リポジトリ固有の追加ルールのテキスト");

    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(paths.promptLocalPath, "リポジトリ固有の追加ルールのテキスト");
    refreshGeneratedSessionInputs(paths);

    const after = fs.readFileSync(paths.generatedSystemPromptPath, "utf8");
    expect(after).toContain("リポジトリ固有の追加ルールのテキスト");
  });

  it("生成に失敗しても例外を投げず、警告を出すだけで続行する", () => {
    // generatedSettingsPath の親ディレクトリになる場所を、あらかじめ通常ファイルとして
    // 作っておくと mkdirSync(recursive: true) が ENOTDIR で失敗する
    const blocker = path.join(paths.stateDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const badPaths: Paths = { ...paths, generatedSettingsPath: path.join(blocker, "claude-settings.json") };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => refreshGeneratedSessionInputs(badPaths)).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain("再生成に失敗");
    logSpy.mockRestore();
  });
});

describe("buildExplorePrompt", () => {
  function ctx(overrides: Partial<ExploreContext> = {}): ExploreContext {
    return { trigger: "idle", goalChanged: null, newAnsweredIds: null, runningTasks: [], ...overrides };
  }

  it("trigger=idle のとき「実行可能なタスクがない」が起動理由になる", () => {
    const prompt = buildExplorePrompt(ctx({ trigger: "idle" }));

    expect(prompt).toContain("### 今回の起動情報(Supervisor による機械的検出)");
    expect(prompt).toContain("起動理由: 実行可能なタスクがないため(main / 入力の変化を検知)");
  });

  it("trigger=periodic のとき定期見直しが起動理由になる", () => {
    const prompt = buildExplorePrompt(ctx({ trigger: "periodic" }));

    expect(prompt).toContain(
      "起動理由: タスク消化中の定期見直し(前回探索から一定時間が経過し、main / 入力が変化)",
    );
  });

  it("goalChanged の true/false/null がそれぞれ文言に反映される", () => {
    expect(buildExplorePrompt(ctx({ goalChanged: true }))).toContain("GOAL.md: 前回探索から変化あり");
    expect(buildExplorePrompt(ctx({ goalChanged: false }))).toContain("GOAL.md: 前回探索から変化なし");
    expect(buildExplorePrompt(ctx({ goalChanged: null }))).toContain("GOAL.md: 不明(前回情報なし)");
  });

  it("newAnsweredIds が列挙されるとき ID がプロンプトに含まれる", () => {
    const prompt = buildExplorePrompt(ctx({ newAnsweredIds: ["HR-20260101-01", "HR-20260101-02"] }));

    expect(prompt).toContain("新規に answered になった Human Review: HR-20260101-01, HR-20260101-02");
  });

  it("newAnsweredIds が空配列なら「なし」、null なら「不明」", () => {
    expect(buildExplorePrompt(ctx({ newAnsweredIds: [] }))).toContain(
      "新規に answered になった Human Review: なし",
    );
    expect(buildExplorePrompt(ctx({ newAnsweredIds: null }))).toContain(
      "新規に answered になった Human Review: 不明(前回情報なし)",
    );
  });

  it("OVERVIEW.md 更新ステップが含まれる", () => {
    expect(buildExplorePrompt(ctx({}))).toContain("`.agent/OVERVIEW.md` を更新する");
  });

  it("フェーズゲート運用への言及を含む", () => {
    const prompt = buildExplorePrompt(ctx({}));

    expect(prompt).toContain("フェーズゲート");
    expect(prompt).toContain("importance: BLOCK");
  });

  it("runningTasks が空なら実行中セクションを含めない", () => {
    expect(buildExplorePrompt(ctx({ runningTasks: [] }))).not.toContain("実行中のタスクセッション");
  });

  it("runningTasks があれば一覧と「触らない」制約を含める", () => {
    const prompt = buildExplorePrompt(ctx({ runningTasks: [{ id: "T-001", title: "在庫補充" }] }));

    expect(prompt).toContain("実行中のタスクセッション");
    expect(prompt).toContain("- T-001: 在庫補充");
    expect(prompt).toContain("は編集しない");
    expect(prompt).toContain("いずれも変更しない");
  });

  it("回答済みの判定基準として status=answered とチェックボックスの両方に言及する", () => {
    const prompt = buildExplorePrompt(ctx({}));

    expect(prompt).toContain("チェックボックスにチェックが入っているもの");
    expect(prompt).toContain("status: open");
  });

  it("回答の判定はチェックボックス方式で指示し、旧 `対応:` マーカーには言及しない", () => {
    // `対応:` は closeHumanReview が処理結果を書き足す記法であって、人間の回答マーカーではない。
    // 探索セッションへの指示が旧表記に戻ると、現行テンプレートに存在しない目印を探すことになる。
    const prompt = buildExplorePrompt(ctx({}));
    // GOAL.md の本文が混ざらないよう、指示部分だけを取り出して検証する
    const section = prompt.slice(prompt.indexOf("## 探索セッション"));

    expect(section).toContain("対応不要(このままクローズしてよい)");
    expect(section).toContain("回答を下に書いた");
    expect(section).not.toContain("対応:");
    expect(section).not.toContain("対応：");
  });

  it("回答があっても新規タスク化が不要なら closed にしてよいことを指示する", () => {
    // Stage 2 の close/task/escalate と揃え、「回答あり → 必ず新タスク」の 2 択にしない
    const prompt = buildExplorePrompt(ctx({}));

    expect(prompt).toContain("新規タスク化が不要なら");
    expect(prompt).toContain("タスクを作らずに closed にする");
  });

  it("deadline を渡すとその時刻がプロンプトに含まれる", () => {
    const prompt = buildExplorePrompt(ctx({ deadline: "2026-08-21T12:34:56.000Z" }));

    expect(prompt).toContain("2026-08-21T12:34:56.000Z");
    expect(prompt).toContain("過ぎると強制終了される");
  });

  it("startedAt を渡すとその時刻がプロンプトに含まれる", () => {
    const prompt = buildExplorePrompt(ctx({ startedAt: "2026-08-21T09:12:34.567Z" }));

    expect(prompt).toContain("2026-08-21T09:12:34.567Z");
    expect(prompt).toContain("「現在時刻」の基準");
  });

  it("startedAt を渡さない場合は開始時刻の記述を含まない(deadline のみでも壊れない)", () => {
    const prompt = buildExplorePrompt(ctx({ deadline: "2026-08-21T12:34:56.000Z" }));

    expect(prompt).not.toContain("「現在時刻」の基準");
    expect(prompt).toContain("過ぎると強制終了される");
  });

  it("注入される startedAt は丸めた固定値ではなく実測の ISO 8601(ミリ秒付き)である", () => {
    const startedAt = new Date().toISOString();
    const prompt = buildExplorePrompt(ctx({ startedAt }));

    // 他のセクションにも ISO 時刻が現れうるため、注入行だけを取り出して検証する
    const line = prompt.split("\n").find((l) => l.includes("「現在時刻」の基準"));
    expect(line).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(line).toContain(startedAt);
  });
});

describe("classifyHumanReview", () => {
  function hr(overrides: Partial<Parameters<typeof classifyHumanReview>[0][number]> = {}) {
    return {
      id: "HR-20260818-01",
      title: "確認事項",
      status: "open",
      importance: "REVIEW",
      raw: "",
      body: "## 回答\n\n",
      summary: "",
      ...overrides,
    };
  }

  it("closed は結果から除外する", () => {
    const result = classifyHumanReview([hr({ status: "closed" })]);
    expect(result.openBlock).toEqual([]);
    expect(result.openReview).toEqual([]);
    expect(result.answered).toEqual([]);
  });

  it("status: open のまま未回答なら openReview / openBlock に振り分ける", () => {
    const review = hr({ id: "HR-1", importance: "REVIEW" });
    const block = hr({ id: "HR-2", importance: "BLOCK" });
    const result = classifyHumanReview([review, block]);
    expect(result.openReview).toEqual([review]);
    expect(result.openBlock).toEqual([block]);
    expect(result.answered).toEqual([]);
  });

  it("status: open のままチェックボックスにチェックが入っていれば answered に分類する(旧方式の status 書き換え不要)", () => {
    const body = ["## 回答", "", "- [x] 対応不要(このままクローズしてよい)", "- [ ] 回答を下に書いた"].join("\n");
    const entry = hr({ status: "open", importance: "BLOCK", body });
    const result = classifyHumanReview([entry]);
    expect(result.answered).toEqual([entry]);
    expect(result.openBlock).toEqual([]);
  });

  it("旧方式(status: answered)も answered に分類する", () => {
    const entry = hr({ status: "answered", body: "## 回答\n\n対応不要。" });
    expect(classifyHumanReview([entry]).answered).toEqual([entry]);
  });
});

describe("runExploreSession(回帰: spawn の同期 throw が漏れない)", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  beforeEach(() => {
    // useRepoRoot はモジュール内で共有される currentPaths を書き換えるため、他のテストへ
    // 影響を残さないよう元の値を退避し、afterEach で必ず復元する
    originalPaths = repoPaths();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-exploresession-"));
    useRepoRoot(dir);
    spawnControl.shouldThrow = false;
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
    spawnControl.shouldThrow = false;
    vi.restoreAllMocks();
  });

  it("spawn が同期 throw しても例外が外へ漏れず、クラッシュ結果として処理が継続する", async () => {
    // spawn のオプション不正などで new Promise((resolve) => spawn(...)) の executor 内が
    // 同期的に throw すると、runClaude の Promise は reject になる。ここで catch していないと
    // 未捕捉例外になり、探索セッション 1 件の失敗で ccloop run プロセスごと落ちていた(回帰)。
    spawnControl.shouldThrow = true;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const config = makeConfig();
    const outcome = await runExploreSession(config, "テスト起動", {
      trigger: "idle",
      goalChanged: null,
      newAnsweredIds: null,
      runningTasks: [],
    });

    // 例外が漏れず戻り値まで到達し、瞬時クラッシュとして次の探索へクールダウンを課す扱いになる
    expect(outcome).toEqual({ rateLimited: false, fastCrashed: true });
    const logged = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain("警告: 探索セッションが想定外に失敗した");

    // finally ブロックの後始末により、実行中セッション一覧からも掃除されている
    const state = JSON.parse(fs.readFileSync(statePathOf(dir), "utf8")) as {
      runningSessions: unknown[];
      sessionCount: number;
    };
    expect(state.runningSessions).toEqual([]);
    expect(state.sessionCount).toBe(1);
  });
});

describe("closeHumanReview", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  beforeEach(() => {
    originalPaths = repoPaths();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-close-hr-"));
    useRepoRoot(dir);
    fs.mkdirSync(repoPaths().humanReviewDir, { recursive: true });
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("CRLF の Human Review ファイルを close しても title/importance/createdAt が失われず、status が closed になる", () => {
    // 修正前は parseFrontmatter が CRLF を判定できず、data が空({})のまま status だけ足して
    // 書き戻すため、title/importance/createdAt が消え、壊れた元テキストが本文に埋め込まれていた
    const text = [
      "---",
      "title: 確認事項タイトル",
      "importance: BLOCK",
      "createdAt: 2026-08-12T00:00:00.000Z",
      "status: open",
      "---",
      "## 回答",
      "",
      "- [x] 対応不要(このままクローズしてよい)",
    ].join("\r\n");
    const file = path.join(repoPaths().humanReviewDir, "HR-20260812-01.md");
    fs.writeFileSync(file, text);

    closeHumanReview("HR-20260812-01");

    const { data, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
    expect(data).toEqual({
      title: "確認事項タイトル",
      importance: "BLOCK",
      createdAt: "2026-08-12T00:00:00.000Z",
      status: "closed",
    });
    expect(body).toContain("対応不要(このままクローズしてよい)");
  });
});

describe("projectsDirName", () => {
  it("cwd のパスを Claude Code の projects ディレクトリ名に変換する", () => {
    expect(projectsDirName("/workspaces/my-type")).toBe("-workspaces-my-type");
  });
});

describe("collectSubagentStats", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-subagents-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("subagents ディレクトリが無ければ 0 件・depth 0", () => {
    expect(collectSubagentStats(dir)).toEqual({ subagentCount: 0, maxSpawnDepth: 0 });
  });

  it("spawnDepth 1 と 2 の meta が 2 件あれば件数 2・最大 depth 2", () => {
    const subagentsDir = path.join(dir, "subagents");
    fs.mkdirSync(subagentsDir);
    fs.writeFileSync(path.join(subagentsDir, "agent-a.meta.json"), JSON.stringify({ spawnDepth: 1 }));
    fs.writeFileSync(
      path.join(subagentsDir, "agent-b.meta.json"),
      JSON.stringify({ spawnDepth: 2, parentAgentId: "a" }),
    );

    expect(collectSubagentStats(dir)).toEqual({ subagentCount: 2, maxSpawnDepth: 2 });
  });

  it("spawnDepth が欠落した meta は depth 1 扱いになる", () => {
    const subagentsDir = path.join(dir, "subagents");
    fs.mkdirSync(subagentsDir);
    fs.writeFileSync(path.join(subagentsDir, "agent-a.meta.json"), JSON.stringify({ agentType: "general-purpose" }));

    expect(collectSubagentStats(dir)).toEqual({ subagentCount: 1, maxSpawnDepth: 1 });
  });

  it("壊れた JSON の meta も件数に含まれ、例外を投げない", () => {
    const subagentsDir = path.join(dir, "subagents");
    fs.mkdirSync(subagentsDir);
    fs.writeFileSync(path.join(subagentsDir, "agent-a.meta.json"), "{ not valid json");

    expect(() => collectSubagentStats(dir)).not.toThrow();
    expect(collectSubagentStats(dir)).toEqual({ subagentCount: 1, maxSpawnDepth: 1 });
  });
});

describe("buildSessionMetrics", () => {
  function res(): SessionResult {
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  }

  function baseParams(overrides: Partial<Parameters<typeof buildSessionMetrics>[0]> = {}): Parameters<
    typeof buildSessionMetrics
  >[0] {
    return { kind: "task", model: "opus", res: res(), sessionCwd: "/tmp/worktree", ...overrides };
  }

  it("衝突ありのケースでは conflictPaths と conflictKind がそのまま出力される", () => {
    const metrics = buildSessionMetrics(
      baseParams({ conflictPaths: ["src/a.ts", ".agent/tasks/T-999.md"], conflictKind: "substantive" }),
    );

    expect(metrics.conflictPaths).toEqual(["src/a.ts", ".agent/tasks/T-999.md"]);
    expect(metrics.conflictKind).toBe("substantive");
  });

  it("conflictPaths が空配列なら conflictPaths キー自体を出力しない", () => {
    const metrics = buildSessionMetrics(baseParams({ conflictPaths: [] }));

    expect("conflictPaths" in metrics).toBe(false);
  });

  it("conflictPaths / conflictKind を渡さなければどちらのキーも出力しない", () => {
    const metrics = buildSessionMetrics(baseParams());

    expect("conflictPaths" in metrics).toBe(false);
    expect("conflictKind" in metrics).toBe(false);
  });
});

describe("isFastCrash", () => {
  function res(overrides: Partial<SessionResult> = {}): SessionResult {
    return { exitCode: 1, timedOut: false, stdout: "", stderr: "", ...overrides };
  }

  it("異常終了・FAST_CRASH_MS 未満なら瞬時クラッシュとみなす", () => {
    expect(isFastCrash(res({ exitCode: 1 }), 1_000)).toBe(true);
  });

  it("タイムアウトなら瞬時クラッシュとみなさない", () => {
    expect(isFastCrash(res({ exitCode: 1, timedOut: true }), 1_000)).toBe(false);
  });

  it("正常終了(exitCode 0)なら瞬時クラッシュとみなさない", () => {
    expect(isFastCrash(res({ exitCode: 0 }), 1_000)).toBe(false);
  });

  it("FAST_CRASH_MS 以上かかった異常終了は瞬時クラッシュとみなさない", () => {
    expect(isFastCrash(res({ exitCode: 1 }), 10_000)).toBe(false);
  });
});

describe("exploreEndLogLine", () => {
  function res(overrides: Partial<SessionResult> = {}): SessionResult {
    return { exitCode: 1, timedOut: false, stdout: "", stderr: "", ...overrides };
  }

  it("タイムアウトなら時間切れと分かる文言になる(タスクセッション側と表記を揃える)", () => {
    const line = exploreEndLogLine(res({ exitCode: null, timedOut: true }), 40 * 60 * 1000);
    expect(line).toContain("タイムアウト");
    expect(line).toContain(`${40 * 60 * 1000}ms`);
  });

  it("通常の異常終了は従来どおりの文言で、タイムアウトとは表記が混ざらない", () => {
    const line = exploreEndLogLine(res({ exitCode: 1 }), 40 * 60 * 1000);
    expect(line).toContain("異常終了");
    expect(line).toContain("exitCode=1");
    expect(line).not.toContain("タイムアウト");
  });

  it("正常終了なら成功の文言になる", () => {
    const line = exploreEndLogLine(res({ exitCode: 0 }), 40 * 60 * 1000);
    expect(line).toContain("探索セッション終了");
  });

  it("timedOut と異常な exitCode が両方成立する場合、タイムアウトを優先する", () => {
    const line = exploreEndLogLine(res({ exitCode: 1, timedOut: true }), 1_000);
    expect(line).toContain("タイムアウト");
  });
});

describe("nextFastCrashStreak", () => {
  function res(overrides: Partial<SessionResult> = {}): SessionResult {
    return { exitCode: 1, timedOut: false, stdout: "", stderr: "", ...overrides };
  }

  it("レートリミット終了は streak を増やさず据え置く(異常終了・短時間でも)", () => {
    expect(nextFastCrashStreak(2, res({ exitCode: 1 }), 1_000, true)).toBe(2);
  });

  it("レートリミット終了は streak が 0 でも据え置く(0 のまま)", () => {
    expect(nextFastCrashStreak(0, res({ exitCode: 1 }), 1_000, true)).toBe(0);
  });

  it("非レートリミットで、瞬時(FAST_CRASH_MS 未満)に異常終了したら streak を加算する", () => {
    expect(nextFastCrashStreak(2, res({ exitCode: 1 }), 1_000, false)).toBe(3);
  });

  it("非レートリミットで、タイムアウトによる終了なら streak を 0 に戻す", () => {
    expect(nextFastCrashStreak(2, res({ exitCode: 1, timedOut: true }), 1_000, false)).toBe(0);
  });

  it("タイムアウト かつ レートリミット検出の両方が true でも、タイムアウトを優先して streak を 0 に戻す", () => {
    expect(nextFastCrashStreak(2, res({ exitCode: 1, timedOut: true }), 1_000, true)).toBe(0);
  });

  it("非レートリミットで、時間がかかった異常終了(FAST_CRASH_MS 以上)なら streak を 0 に戻す", () => {
    expect(nextFastCrashStreak(2, res({ exitCode: 1 }), 20_000, false)).toBe(0);
  });

  it("正常終了(exitCode 0)なら streak を 0 に戻す", () => {
    expect(nextFastCrashStreak(2, res({ exitCode: 0 }), 1_000, false)).toBe(0);
  });
});

describe("fastCrashStreakAfterWait", () => {
  it("停止処理に入っていない(none)ときの crash-backoff の待機明けは streak を 0 へ戻す", () => {
    expect(fastCrashStreakAfterWait(3, "crash-backoff", "none")).toBe(0);
  });

  it("crash-backoff 以外の理由の待機では streak を変えない(stopMode が none でも)", () => {
    expect(fastCrashStreakAfterWait(3, "rate-limit", "none")).toBe(3);
    expect(fastCrashStreakAfterWait(3, "drain", "none")).toBe(3);
    expect(fastCrashStreakAfterWait(3, "idle", "none")).toBe(3);
    expect(fastCrashStreakAfterWait(3, "slots-full", "none")).toBe(3);
    expect(fastCrashStreakAfterWait(3, "explore-running", "none")).toBe(3);
  });

  it("停止処理中(none 以外)は crash-backoff の待機明けでも streak をリセットしない", () => {
    expect(fastCrashStreakAfterWait(3, "crash-backoff", "clean")).toBe(3);
  });
});

/**
 * scheduler.planLoopStep と、supervisor.ts の fastCrashStreak 更新関数(nextFastCrashStreak /
 * fastCrashStreakAfterWait)を実際の mainLoop と同じ順序で組み合わせ、配線全体が意図通り動くかを
 * 検証する。個々の関数の単体テストとは別に、「crash-backoff で 1 周回待った後に本当に起動へ戻るか」
 * 「レートリミットが streak を汚さないか」という結合上の懸念を確認するためのもの。
 */
describe("crash-backoff の配線(planLoopStep + fastCrashStreak 更新関数)", () => {
  function loopInput(over: Partial<LoopInput> = {}): LoopInput {
    return {
      now: new Date("2026-08-16T00:00:00.000Z"),
      stopMode: "none",
      mainDirtyOutsideAgent: false,
      runningCount: 0,
      maxSessions: 1,
      runnableTaskIds: [],
      conflictResumeTaskIds: [],
      inputsDirty: false,
      mainDirty: false,
      triageEnabled: false,
      triageAttempted: false,
      exploreEnabled: true,
      exploreRunning: false,
      exploreDue: false,
      neverExplored: false,
      lastExploreYieldedNothing: false,
      lastExploreFastCrashed: false,
      pendingSnoozeCount: 0,
      rateLimitedUntilMs: null,
      idlePollMs: 60_000,
      fastCrashStreak: 0,
      ...over,
    };
  }

  function res(overrides: Partial<SessionResult> = {}): SessionResult {
    return { exitCode: 1, timedOut: false, stdout: "", stderr: "", ...overrides };
  }

  it("streak 3・runnable あり・空きありで crash-backoff wait → 待機明けにリセット → 次周回は launch", () => {
    // 周回 1: 直前まで瞬時クラッシュが 3 回連続した状態で、起動できる状況(runnable かつ空き枠あり)
    let streak = 3;
    const base = loopInput({ runnableTaskIds: ["T-001"], runningCount: 0, maxSessions: 1, fastCrashStreak: streak });
    const action1 = planLoopStep(base);
    expect(action1).toEqual({ type: "wait", ms: 60_000, why: "crash-backoff" });

    // mainLoop は sleep(action.ms) の後、停止処理に入っていなければ streak をリセットする
    streak = fastCrashStreakAfterWait(streak, "crash-backoff", "none");
    expect(streak).toBe(0);

    // 周回 2: リセット後の streak を渡すと、同じ runnable・空き枠のまま通常どおり起動へ進む
    const action2 = planLoopStep(loopInput({ runnableTaskIds: ["T-001"], runningCount: 0, maxSessions: 1, fastCrashStreak: streak }));
    expect(action2).toEqual({ type: "launch", taskIds: ["T-001"] });
  });

  it("レートリミット終了が 4 本連続しても streak は増えず、crash-backoff に入らず launch のまま", () => {
    let streak = 0;
    for (let i = 0; i < 4; i++) {
      streak = nextFastCrashStreak(streak, res({ exitCode: 1 }), 1_000, true);
    }
    expect(streak).toBe(0);

    const action = planLoopStep(
      loopInput({ runnableTaskIds: ["T-001"], runningCount: 0, maxSessions: 1, fastCrashStreak: streak }),
    );
    expect(action).toEqual({ type: "launch", taskIds: ["T-001"] });
  });
});

/**
 * isFastCrash と scheduler.planLoopStep を実際の mainLoop と同じ順序(セッション結果 → isFastCrash
 * → lastExploreFastCrashed → 次周回の planLoopStep)で組み合わせ、探索側の配線を検証する。
 * 個々の関数の単体テストとは別に、「瞬時クラッシュした探索が本当に次の即時再探索を止めるか」
 * という結合上の懸念を確認するためのもの。
 */
describe("探索の瞬時クラッシュの配線(isFastCrash + planLoopStep)", () => {
  function loopInput(over: Partial<LoopInput> = {}): LoopInput {
    return {
      now: new Date("2026-08-16T00:00:00.000Z"),
      stopMode: "none",
      mainDirtyOutsideAgent: false,
      runningCount: 0,
      maxSessions: 1,
      runnableTaskIds: [],
      conflictResumeTaskIds: [],
      inputsDirty: false,
      mainDirty: false,
      triageEnabled: false,
      triageAttempted: false,
      exploreEnabled: true,
      exploreRunning: false,
      exploreDue: false,
      neverExplored: false,
      lastExploreYieldedNothing: false,
      lastExploreFastCrashed: false,
      pendingSnoozeCount: 0,
      rateLimitedUntilMs: null,
      idlePollMs: 60_000,
      fastCrashStreak: 0,
      ...over,
    };
  }

  function res(overrides: Partial<SessionResult> = {}): SessionResult {
    return { exitCode: 1, timedOut: false, stdout: "", stderr: "", ...overrides };
  }

  it("起動直後に落ちた探索は、未消費の入力があってもクールダウン未経過中は再探索させない", () => {
    // 瞬時クラッシュは入力を消費しないぶん、再探索は時間経過でしか成立させない
    const lastExploreFastCrashed = isFastCrash(res({ exitCode: 1 }), 1_000);
    expect(lastExploreFastCrashed).toBe(true);

    const action = planLoopStep(
      loopInput({ inputsDirty: true, exploreDue: false, lastExploreFastCrashed }),
    );
    expect(action.type).not.toBe("explore");
  });

  it("起動直後に落ちた探索でも、クールダウン(exploreDue)経過後は再探索する", () => {
    const lastExploreFastCrashed = isFastCrash(res({ exitCode: 1 }), 1_000);
    expect(lastExploreFastCrashed).toBe(true);

    const action = planLoopStep(
      loopInput({ inputsDirty: true, exploreDue: true, lastExploreFastCrashed }),
    );
    expect(action).toEqual({ type: "explore", trigger: "idle" });
  });

  it("締め切りによるタイムアウトは瞬時クラッシュ扱いにならず、従来どおり即時再探索の免除が効く", () => {
    const lastExploreFastCrashed = isFastCrash(res({ exitCode: 1, timedOut: true }), 1_000);
    expect(lastExploreFastCrashed).toBe(false);

    const action = planLoopStep(
      loopInput({ inputsDirty: true, exploreDue: false, lastExploreFastCrashed }),
    );
    expect(action).toEqual({ type: "explore", trigger: "idle" });
  });
});

describe("withTrailer", () => {
  it("subject の後に空行を挟んで AGENT_COMMIT_TRAILER を付与する", () => {
    expect(withTrailer("docs(agent): 例")).toBe(`docs(agent): 例\n\n${AGENT_COMMIT_TRAILER}`);
  });
});

describe("runRotate", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-rotate-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("移動対象が無ければ null を返す", () => {
    expect(runRotate(dir)).toBeNull();
  });

  it("completed タスクと closed な human-review があれば要約文字列を返す", () => {
    const tasksDir = path.join(dir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "T-001.md"), serializeFrontmatter({ status: "completed" }, "本文"));
    const hrDir = path.join(dir, "human-review");
    fs.mkdirSync(hrDir, { recursive: true });
    fs.writeFileSync(path.join(hrDir, "R-001.md"), serializeFrontmatter({ status: "closed" }, "本文"));

    expect(runRotate(dir)).toBe("tasks 1 件, human-review 1 件");
    // 実際に archive へ移動されている(要約文字列だけのモックではない)
    expect(fs.existsSync(path.join(dir, "archive", "tasks", "T-001.md"))).toBe(true);
  });

  it("移動先に同名ファイルがあり衝突だけの場合は null を返す(空文字列ではない)", () => {
    const tasksDir = path.join(dir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "T-001.md"), serializeFrontmatter({ status: "completed" }, "本文"));
    const archiveTasksDir = path.join(dir, "archive", "tasks");
    fs.mkdirSync(archiveTasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveTasksDir, "T-001.md"),
      serializeFrontmatter({ status: "completed" }, "archive 側の本文"),
    );

    expect(runRotate(dir)).toBeNull();
    // 衝突したファイルは移動されず、archive 側も上書きされない
    expect(fs.existsSync(path.join(tasksDir, "T-001.md"))).toBe(true);
    expect(fs.readFileSync(path.join(archiveTasksDir, "T-001.md"), "utf8")).toBe(
      serializeFrontmatter({ status: "completed" }, "archive 側の本文"),
    );
  });
});

describe("runHousekeeping", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  beforeEach(() => {
    originalPaths = repoPaths();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-housekeeping-"));
    useRepoRoot(dir);
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("走行中のタスクセッションがあっても、走行中でない completed タスクは archive へ移動する", () => {
    const tasksDir = repoPaths().tasksDir;
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "T-done.md"), serializeFrontmatter({ status: "completed" }, "本文"));
    fs.writeFileSync(path.join(tasksDir, "T-running.md"), serializeFrontmatter({ status: "completed" }, "本文"));

    const state = {
      runningSessions: [{ kind: "task" as const, taskId: "T-running", startedAt: new Date().toISOString() }],
      lastExploreAt: null,
      rateLimit: { resumeAt: null },
      sessionCount: 0,
      updatedAt: null,
    };

    runHousekeeping(state);

    expect(fs.existsSync(path.join(repoPaths().archiveDir, "tasks", "T-done.md"))).toBe(true);
    expect(fs.existsSync(path.join(tasksDir, "T-done.md"))).toBe(false);
  });

  it("走行中タスクの記録は completed でも .agent/tasks/ に残る", () => {
    const tasksDir = repoPaths().tasksDir;
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "T-running.md"), serializeFrontmatter({ status: "completed" }, "本文"));

    const state = {
      runningSessions: [{ kind: "task" as const, taskId: "T-running", startedAt: new Date().toISOString() }],
      lastExploreAt: null,
      rateLimit: { resumeAt: null },
      sessionCount: 0,
      updatedAt: null,
    };

    runHousekeeping(state);

    expect(fs.existsSync(path.join(tasksDir, "T-running.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoPaths().archiveDir, "tasks", "T-running.md"))).toBe(false);
  });

  it("走行中のタスクセッションがあっても decisions/index.md のリコンサイルは走る([x] の判断が archive へ移動する)", () => {
    const decisionsDir = repoPaths().decisionsDir;
    fs.mkdirSync(decisionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(decisionsDir, "D-20260101-0000-a.md"),
      serializeFrontmatter({ title: "判断 A" }, "本文"),
    );
    fs.writeFileSync(
      path.join(decisionsDir, "index.md"),
      [
        "# 決定インデックス",
        "",
        "チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。",
        "",
        "- [x] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A",
        "",
      ].join("\n"),
    );

    // 除外は tasks だけに効くので、走行中セッションがあっても decisions は片付く
    const state = {
      runningSessions: [{ kind: "task" as const, taskId: "T-running", startedAt: new Date().toISOString() }],
      lastExploreAt: null,
      rateLimit: { resumeAt: null },
      sessionCount: 0,
      updatedAt: null,
    };

    runHousekeeping(state);

    expect(fs.existsSync(path.join(repoPaths().archiveDir, "decisions", "D-20260101-0000-a.md"))).toBe(true);
    const indexText = fs.readFileSync(path.join(decisionsDir, "index.md"), "utf8");
    expect(indexText).not.toContain("D-20260101-0000-a");
  });
});

describe("parseNameStatus", () => {
  it("M/A/D を status とパスの組として解釈する", () => {
    const out = "M\0.agent/OVERVIEW.md\0A\0.agent/tasks/T-002.md\0D\0.agent/tasks/T-001.md\0";
    expect(parseNameStatus(out)).toEqual([
      { status: "M", path: ".agent/OVERVIEW.md", from: null },
      { status: "A", path: ".agent/tasks/T-002.md", from: null },
      { status: "D", path: ".agent/tasks/T-001.md", from: null },
    ]);
  });

  it("R は 3 レコードで移動元を from に入れる", () => {
    const out = "R100\0.agent/tasks/T-001.md\0.agent/archive/tasks/T-001.md\0";
    expect(parseNameStatus(out)).toEqual([
      { status: "R100", path: ".agent/archive/tasks/T-001.md", from: ".agent/tasks/T-001.md" },
    ]);
  });

  it("R の直後に別の変更が続いてもレコード境界を取り違えない", () => {
    const out = "R100\0.agent/tasks/T-001.md\0.agent/archive/tasks/T-001.md\0M\0.agent/OVERVIEW.md\0";
    expect(parseNameStatus(out)).toEqual([
      { status: "R100", path: ".agent/archive/tasks/T-001.md", from: ".agent/tasks/T-001.md" },
      { status: "M", path: ".agent/OVERVIEW.md", from: null },
    ]);
  });

  it("空文字列は空配列になる", () => {
    expect(parseNameStatus("")).toEqual([]);
  });

  it("末尾 NUL・空レコード・status だけの不完全な末尾は無視する", () => {
    expect(parseNameStatus("M\0.agent/OVERVIEW.md\0\0\0")).toEqual([
      { status: "M", path: ".agent/OVERVIEW.md", from: null },
    ]);
    expect(parseNameStatus("M\0.agent/OVERVIEW.md\0A\0")).toEqual([
      { status: "M", path: ".agent/OVERVIEW.md", from: null },
    ]);
  });

  it("日本語ファイル名がエスケープされずにそのまま返る(-z 前提)", () => {
    expect(parseNameStatus("M\0.agent/決定事項.md\0")).toEqual([
      { status: "M", path: ".agent/決定事項.md", from: null },
    ]);
  });
});

describe("summarizeAgentCommit", () => {
  // commit-msg フック(dotfiles の convetional-commits.sh)が subject 先頭行に課す制約
  const CONVENTIONAL = /^(build|ci|docs|feat|fix|perf|refactor|style|test)(\(.*\))?!?: .*$/;

  const edit = (path: string, status = "M"): StagedChange => ({ status, path, from: null });
  const move = (from: string, path: string): StagedChange => ({ status: "R100", path, from });

  it("編集 1 件なら ID を出す", () => {
    expect(summarizeAgentCommit([edit(".agent/human-review/HR-20260815-14.md")])).toBe(
      "docs(agent): HR-20260815-14 を更新する",
    );
  });

  it("A / D で動詞を切り替える", () => {
    expect(summarizeAgentCommit([edit(".agent/tasks/T-152.md", "A")])).toBe("docs(agent): T-152 を追加する");
    expect(summarizeAgentCommit([edit(".agent/decisions/D-20260814-23.md", "D")])).toBe(
      "docs(agent): D-20260814-23 を削除する",
    );
  });

  it("archive への移動だけなら移動として表現する(単一種別)", () => {
    const changes = [
      move(".agent/decisions/D-1.md", ".agent/archive/decisions/D-1.md"),
      move(".agent/decisions/D-2.md", ".agent/archive/decisions/D-2.md"),
    ];
    expect(summarizeAgentCommit(changes)).toBe("docs(agent): 判断記録 2 件を archive へ移動する");
  });

  it("archive への移動だけなら移動として表現する(複数種別)", () => {
    const changes = [
      move(".agent/decisions/D-1.md", ".agent/archive/decisions/D-1.md"),
      move(".agent/tasks/T-001.md", ".agent/archive/tasks/T-001.md"),
    ];
    expect(summarizeAgentCommit(changes)).toBe("docs(agent): タスク 1 件と判断記録 1 件を archive へ移動する");
  });

  it("編集が複数種別ならカテゴリと件数を優先順に並べる", () => {
    const changes = [
      edit(".agent/decisions/D-1.md"),
      edit(".agent/tasks/T-001.md"),
      edit(".agent/tasks/T-002.md", "A"),
    ];
    expect(summarizeAgentCommit(changes)).toBe("docs(agent): タスク 2 件と判断記録 1 件を更新する");
  });

  it("編集と移動が混在するなら移動を併記する", () => {
    const changes = [
      edit(".agent/tasks/T-001.md"),
      edit(".agent/tasks/T-002.md"),
      move(".agent/decisions/D-1.md", ".agent/archive/decisions/D-1.md"),
    ];
    expect(summarizeAgentCommit(changes)).toBe("docs(agent): タスク 2 件を更新する (archive へ 1 件移動)");
  });

  it("4 種別以上は上位 3 種だけ挙げ、残りは件数で丸める", () => {
    const changes = [
      edit(".agent/tasks/T-001.md"),
      edit(".agent/decisions/D-1.md"),
      edit(".agent/human-review/HR-1.md"),
      edit(".agent/OVERVIEW.md"),
      edit(".agent/GOAL.md"),
    ];
    expect(summarizeAgentCommit(changes)).toBe(
      "docs(agent): タスク 1 件と判断記録 1 件とレビュー 1 件ほか 2 件を更新する",
    );
  });

  it("ID を持たないファイルはカテゴリ名で表現する", () => {
    expect(summarizeAgentCommit([edit(".agent/OVERVIEW.md")])).toBe("docs(agent): 全体像を更新する");
    expect(summarizeAgentCommit([edit(".agent/PROMPT.local.md")])).toBe("docs(agent): 手順書を更新する");
  });

  it("カテゴリ不明のファイルは「運用ファイル」として扱う", () => {
    expect(summarizeAgentCommit([edit(".agent/metrics.jsonl")])).toBe("docs(agent): 運用ファイルを更新する");
  });

  it("空配列なら定型文を返す", () => {
    expect(summarizeAgentCommit([])).toBe("docs(agent): 運用状態を更新する");
  });

  it("72 文字を超える場合は件数だけの定型文へフォールバックする", () => {
    const longId = `T-${"0".repeat(80)}`;
    expect(summarizeAgentCommit([edit(`.agent/tasks/${longId}.md`)])).toBe("docs(agent): 運用ファイル 1 件を更新する");
  });

  it("パスに制御文字が含まれる場合は定型文へフォールバックする", () => {
    const changes = [edit(".agent/tasks/T-0\n01.md"), edit(".agent/tasks/T-002.md")];
    // 内訳表現には ID が出ないので、この 2 件では改行は subject に載らない
    expect(summarizeAgentCommit(changes)).toBe("docs(agent): タスク 2 件を更新する");
    // ID が subject に載る単一編集では制御文字が混入しうるため落とす
    expect(summarizeAgentCommit([edit(".agent/tasks/T-0\n01.md")])).toBe("docs(agent): 運用ファイル 1 件を更新する");
  });

  it("生成されるあらゆる subject が commit-msg フックの検査を通り、制御文字を含まない", () => {
    const cases: StagedChange[][] = [
      [],
      [edit(".agent/human-review/HR-20260815-14.md")],
      [edit(".agent/tasks/T-152.md", "A")],
      [edit(".agent/decisions/D-1.md", "D")],
      [edit(".agent/OVERVIEW.md")],
      [edit(".agent/GOAL.md")],
      [edit(".agent/PROMPT.local.md")],
      [edit(".agent/metrics.jsonl")],
      [edit(".agent/tasks/T-0\n01.md")],
      [edit(`.agent/tasks/T-${"0".repeat(80)}.md`)],
      [move(".agent/tasks/T-001.md", ".agent/archive/tasks/T-001.md")],
      [
        move(".agent/tasks/T-001.md", ".agent/archive/tasks/T-001.md"),
        move(".agent/decisions/D-1.md", ".agent/archive/decisions/D-1.md"),
      ],
      [edit(".agent/tasks/T-001.md"), move(".agent/decisions/D-1.md", ".agent/archive/decisions/D-1.md")],
      [
        edit(".agent/tasks/T-001.md"),
        edit(".agent/decisions/D-1.md"),
        edit(".agent/human-review/HR-1.md"),
        edit(".agent/OVERVIEW.md"),
        edit(".agent/GOAL.md"),
      ],
    ];
    for (const changes of cases) {
      const subject = summarizeAgentCommit(changes);
      expect(subject).toMatch(CONVENTIONAL);
      // biome/oxlint に頼らず、制御文字が 1 文字も無いことをコード値で確認する
      expect([...subject].every((ch) => (ch.codePointAt(0) ?? 0) >= 0x20 && ch.codePointAt(0) !== 0x7f)).toBe(true);
      expect(subject.length).toBeLessThanOrEqual(72);
    }
  });
});

describe("commitAgentDir", () => {
  let dir: string;
  let hooksDir: string;
  let wtRoot: string;

  function headHash(cwd: string = dir): string {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
  }

  function headFiles(cwd: string = dir): string[] {
    return execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd })
      .toString()
      .split("\n")
      .filter((f) => f !== "");
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-git-"));
    // core.hooksPath を空ディレクトリに向け、グローバルの commit-msg フックから隔離する
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-hooks-"));
    wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-wt-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it("a: .agent の差分がある周回で 1 コミットになり、rotate の rename も同じコミットに含まれる", () => {
    const agentDir = path.join(dir, ".agent");
    const tasksDir = path.join(agentDir, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "T-001.md"), serializeFrontmatter({ status: "completed" }, "本文"));
    fs.writeFileSync(path.join(agentDir, "OVERVIEW.md"), "# 概要");

    const before = headHash();
    const summary = runRotate(agentDir);
    expect(summary).toBe("tasks 1 件");
    commitAgentDir("docs(agent): 運用状態を更新する", dir);

    expect(headHash()).not.toBe(before);
    const files = headFiles();
    expect(files).toContain(".agent/OVERVIEW.md");
    expect(files).toContain(".agent/archive/tasks/T-001.md");
    expect(files).not.toContain(".agent/tasks/T-001.md");
    const message = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: dir }).toString();
    expect(message).toContain(AGENT_COMMIT_TRAILER);
  });

  it("b: .agent に差分が無ければ HEAD は変わらない", () => {
    const before = headHash();
    commitAgentDir("docs(agent): 運用状態を更新する", dir);
    expect(headHash()).toBe(before);
  });

  it("c: .agent 以外のパスがステージ済みだとコミットをスキップし、.agent はステージに残さず人間のステージも保つ", () => {
    fs.writeFileSync(path.join(dir, "outside.txt"), "human work");
    execFileSync("git", ["add", "outside.txt"], { cwd: dir });
    const agentDir = path.join(dir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "OVERVIEW.md"), "# 概要");

    const before = headHash();
    commitAgentDir("docs(agent): 運用状態を更新する", dir);

    // (a) 新しいコミットが作られない
    expect(headHash()).toBe(before);
    // (b) .agent 配下が自分のステージ(add -A)によってインデックスに残っていない
    const cachedNames = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir }).toString();
    expect(cachedNames).not.toContain(".agent/");
    // (c) 人間がステージしていたファイルはステージされたまま残る
    expect(cachedNames).toContain("outside.txt");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString();
    expect(status).toContain("outside.txt");
  });

  it("d: 作業ツリーの .agent 外の未ステージ変更はコミットに含まれない", () => {
    fs.writeFileSync(path.join(dir, "outside.txt"), "untracked human work");
    const agentDir = path.join(dir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "OVERVIEW.md"), "# 概要");

    commitAgentDir("docs(agent): 運用状態を更新する", dir);

    expect(headFiles()).toEqual([".agent/OVERVIEW.md"]);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString();
    expect(status).toContain("outside.txt");
  });

  it("e: message 省略時はステージ内容から subject を生成し、trailer も付く", () => {
    const hrDir = path.join(dir, ".agent", "human-review");
    fs.mkdirSync(hrDir, { recursive: true });
    fs.writeFileSync(path.join(hrDir, "HR-20260815-14.md"), "本文");

    commitAgentDir(undefined, dir);

    const message = execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: dir }).toString();
    expect(message.split("\n")[0]).toBe("docs(agent): HR-20260815-14 を追加する");
    expect(message).toContain(AGENT_COMMIT_TRAILER);
  });

  it("f: archive への移動だけの周回は移動として表現される", () => {
    const tasksDir = path.join(dir, ".agent", "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    const body = serializeFrontmatter({ status: "completed" }, "本文\n".repeat(20));
    fs.writeFileSync(path.join(tasksDir, "T-001.md"), body);
    commitAgentDir("docs(agent): タスクを追加する", dir);

    // rotate 相当の移動(内容は変えない)
    const archiveTasks = path.join(dir, ".agent", "archive", "tasks");
    fs.mkdirSync(archiveTasks, { recursive: true });
    fs.renameSync(path.join(tasksDir, "T-001.md"), path.join(archiveTasks, "T-001.md"));

    commitAgentDir(undefined, dir);

    const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir }).toString().trim();
    expect(subject).toBe("docs(agent): タスク 1 件を archive へ移動する");
  });

  it("g: rename の移動元が .agent の外ならコミットをスキップする", () => {
    const docsDir = path.join(dir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    const body = "人間が書いた文書\n".repeat(20);
    fs.writeFileSync(path.join(docsDir, "x.md"), body);
    execFileSync("git", ["add", "docs/x.md"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "docs: 追加する"], { cwd: dir });

    // .agent/ の外から .agent/ へ移動した状態をステージ済みにする(移動先だけを見ると
    // 「.agent/ 配下の追加」に見え、旧実装では巻き込んでコミットしてしまうケース)
    const agentDir = path.join(dir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.renameSync(path.join(docsDir, "x.md"), path.join(agentDir, "x.md"));
    execFileSync("git", ["add", "-A", "--", "docs"], { cwd: dir });

    const before = headHash();
    commitAgentDir(undefined, dir);

    expect(headHash()).toBe(before);
  });

  it("h: .agent 配下だけが事前にステージ済みなら従来どおり正常にコミットされる", () => {
    const agentDir = path.join(dir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "OVERVIEW.md"), "# 概要");
    execFileSync("git", ["add", "--", ".agent"], { cwd: dir });

    const before = headHash();
    commitAgentDir("docs(agent): 運用状態を更新する", dir);

    expect(headHash()).not.toBe(before);
    expect(headFiles()).toEqual([".agent/OVERVIEW.md"]);
    const cachedNames = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir }).toString();
    expect(cachedNames.trim()).toBe("");
  });

  it("cherry-pick 進行中はコミットをスキップする", () => {
    const agentDir = path.join(dir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "OVERVIEW.md"), "# 概要");
    fs.writeFileSync(path.join(dir, ".git", "CHERRY_PICK_HEAD"), "deadbeef\n");

    const before = headHash();
    commitAgentDir("docs(agent): 運用状態を更新する", dir);

    expect(headHash()).toBe(before);
  });

  it("linked worktree(.git がファイル)上でも commit でき、main 側は変化しない", () => {
    const wtPath = worktreePathFor(wtRoot, "T-100");
    createWorktree(dir, wtPath, branchNameFor("T-100"));
    expect(fs.statSync(path.join(wtPath, ".git")).isFile()).toBe(true);

    const mainBefore = headHash(dir);
    const wtBefore = headHash(wtPath);

    const agentDir = path.join(wtPath, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "OVERVIEW.md"), "# 概要");

    commitAgentDir("docs(agent): 運用状態を更新する", wtPath);

    // worktree のブランチ側にコミットが積まれる
    expect(headHash(wtPath)).not.toBe(wtBefore);
    expect(headFiles(wtPath)).toContain(".agent/OVERVIEW.md");
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: wtPath }).toString().trim();
    expect(branch).toBe(branchNameFor("T-100"));

    // main(本体リポジトリの現在ブランチ)は触られない
    expect(headHash(dir)).toBe(mainBefore);
  });

  it("linked worktree 内でコンフリクトした merge が進行中なら commit をスキップする(gitOperationInProgress の worktree.ts 実装経由)", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add base"], { cwd: dir });
    execFileSync("git", ["branch", "side"], { cwd: dir });
    execFileSync("git", ["checkout", "side"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "conflict.txt"), "side change\n");
    execFileSync("git", ["commit", "-am", "side change"], { cwd: dir });
    execFileSync("git", ["checkout", "main"], { cwd: dir });

    const wtPath = worktreePathFor(wtRoot, "T-101");
    createWorktree(dir, wtPath, branchNameFor("T-101"));
    expect(fs.statSync(path.join(wtPath, ".git")).isFile()).toBe(true);

    fs.writeFileSync(path.join(wtPath, "conflict.txt"), "wt change\n");
    execFileSync("git", ["commit", "-am", "wt change"], { cwd: wtPath });
    try {
      execFileSync("git", ["merge", "side"], { cwd: wtPath });
    } catch {
      // コンフリクトによる非ゼロ終了は想定通り
    }

    const agentDir = path.join(wtPath, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "OVERVIEW.md"), "# 概要");

    const before = headHash(wtPath);
    commitAgentDir("docs(agent): 運用状態を更新する", wtPath);

    // supervisor.ts 自身の existsSync ベース判定(直接の .git/MERGE_HEAD 参照)では
    // linked worktree の MERGE_HEAD(本体リポジトリの .git/worktrees/<name>/ 配下)を
    // 検出できず、誤ってコミットしてしまう。ここでスキップされることが
    // ./worktree.ts の gitOperationInProgress を使っている効果の確認になる。
    expect(headHash(wtPath)).toBe(before);
  });
});

describe("mainChangedByTaskOutcome", () => {
  it("main の内容が変わるマージは true", () => {
    expect(mainChangedByTaskOutcome({ result: "merged" }, null)).toBe(true);
    expect(
      mainChangedByTaskOutcome({ result: "renumbered", resolved: { ownTaskFile: "x", decisionsIndex: null } }, null),
    ).toBe(true);
  });

  it("main が変わらないマージ結果(マージ無し・失敗・マージ未実施)は false", () => {
    expect(mainChangedByTaskOutcome({ result: "nothing-to-merge" }, null)).toBe(false);
    expect(mainChangedByTaskOutcome({ result: "conflict", paths: ["a.ts"], conflictKind: "substantive" }, null)).toBe(
      false,
    );
    expect(mainChangedByTaskOutcome({ result: "blocked", reason: "dirty" }, null)).toBe(false);
    expect(mainChangedByTaskOutcome({ result: "wedged", stderr: "not uptodate" }, null)).toBe(false);
    // マージを試みていない(worktree が無い・衝突解消が未完)場合
    expect(mainChangedByTaskOutcome(null, null)).toBe(false);
  });

  it("失敗が確定した(status=failed)場合は、マージできていなくても true", () => {
    expect(mainChangedByTaskOutcome(null, "failed")).toBe(true);
    expect(mainChangedByTaskOutcome({ result: "conflict", paths: ["a.ts"] }, "failed")).toBe(true);
  });

  it("リトライ待ちに戻るだけ(failed 以外)なら false", () => {
    expect(mainChangedByTaskOutcome(null, "ready")).toBe(false);
    expect(mainChangedByTaskOutcome(null, "working")).toBe(false);
    expect(mainChangedByTaskOutcome(null, "blocked")).toBe(false);
  });
});

describe("describeMergeOutcome", () => {
  it("renumbered で own-task-file のみを解決した場合、タスクファイル採用のみを報告する", () => {
    expect(
      describeMergeOutcome({
        result: "renumbered",
        resolved: { ownTaskFile: ".agent/tasks/T-042.md", decisionsIndex: null },
      }),
    ).toBe("main へマージした(機械的に解決: タスクファイルはブランチ側を採用)");
  });

  it("renumbered で decisions/index.md のみを解決した場合、決定インデックス統合のみを報告する", () => {
    expect(
      describeMergeOutcome({
        result: "renumbered",
        resolved: { ownTaskFile: null, decisionsIndex: ".agent/decisions/index.md" },
      }),
    ).toBe("main へマージした(機械的に解決: 決定インデックスは両ブランチの項目を統合)");
  });

  it("renumbered で両方を解決した場合、タスクファイル採用と決定インデックス統合の両方を報告する", () => {
    expect(
      describeMergeOutcome({
        result: "renumbered",
        resolved: {
          ownTaskFile: ".agent/tasks/T-030.md",
          decisionsIndex: ".agent/decisions/index.md",
        },
      }),
    ).toBe(
      "main へマージした(機械的に解決: タスクファイルはブランチ側を採用 / 決定インデックスは両ブランチの項目を統合)",
    );
  });
});

describe("skipMainWriteIfGitBusy", () => {
  let dir: string;
  let hooksDir: string;

  function git(args: string[], cwd: string = dir): string {
    return execFileSync("git", args, { cwd }).toString();
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-gitbusy-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-gitbusy-hooks-"));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it("main が通常状態(マージ等の途中でない)なら false を返し、書き込みを妨げない", () => {
    expect(skipMainWriteIfGitBusy("T-001", dir)).toBe(false);
  });

  it("main がマージ途中(MERGE_HEAD あり)なら true を返し、main 側への書き込みをスキップさせる", () => {
    fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "add base"]);
    git(["branch", "side"]);
    git(["checkout", "side"]);
    fs.writeFileSync(path.join(dir, "f.txt"), "side\n");
    git(["commit", "-am", "side change"]);
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(dir, "f.txt"), "main\n");
    git(["commit", "-am", "main change"]);
    expect(() => git(["merge", "side"])).toThrow();
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);

    expect(skipMainWriteIfGitBusy("T-001", dir)).toBe(true);
  });
});

describe("denialMatchesRule", () => {
  const root = "/repo";

  it("Bash: パターン末尾が * なら前方一致で判定する", () => {
    const denial = { tool_name: "Bash", tool_input: { command: "git push origin main" } };
    expect(denialMatchesRule(denial, "Bash(git push*)", root)).toBe(true);
    expect(denialMatchesRule(denial, "Bash(git pull*)", root)).toBe(false);
  });

  it("Bash: パターンに * が無ければ完全一致で判定する", () => {
    const denial = { tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } };
    expect(denialMatchesRule(denial, "Bash(sudo rm -rf /)", root)).toBe(true);
    expect(
      denialMatchesRule({ tool_name: "Bash", tool_input: { command: "sudo rm -rf /tmp" } }, "Bash(sudo rm -rf /)", root),
    ).toBe(false);
  });

  it("Read: // 始まりの絶対パスパターンを ** グロブで判定する", () => {
    const denial = { tool_name: "Read", tool_input: { file_path: "/home/node/.claude/settings.json" } };
    expect(denialMatchesRule(denial, "Read(//home/node/.claude/**)", root)).toBe(true);
    expect(
      denialMatchesRule(
        { tool_name: "Read", tool_input: { file_path: "/home/other/.claude/x" } },
        "Read(//home/node/.claude/**)",
        root,
      ),
    ).toBe(false);
  });

  it("Read: ./ 始まりの root 基準パターンは完全一致で判定する", () => {
    const denial = { tool_name: "Read", tool_input: { file_path: `${root}/.env` } };
    expect(denialMatchesRule(denial, "Read(./.env)", root)).toBe(true);
    expect(
      denialMatchesRule({ tool_name: "Read", tool_input: { file_path: `${root}/.env.local` } }, "Read(./.env)", root),
    ).toBe(false);
  });

  it("Read: root 基準パターンの * グロブで .env.* 系にマッチする", () => {
    const denial = { tool_name: "Read", tool_input: { file_path: `${root}/.env.local` } };
    expect(denialMatchesRule(denial, "Read(./.env.*)", root)).toBe(true);
    expect(
      denialMatchesRule(
        { tool_name: "Read", tool_input: { file_path: `${root}/sub/.env.local` } },
        "Read(./.env.*)",
        root,
      ),
    ).toBe(false);
  });

  it("Read: ~/ 始まりのホーム基準パターンを ** グロブで判定する", () => {
    const denial = {
      tool_name: "Read",
      tool_input: { file_path: path.join(os.homedir(), ".claude", "settings.json") },
    };
    expect(denialMatchesRule(denial, "Read(~/.claude/**)", root)).toBe(true);
    expect(
      denialMatchesRule({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" } }, "Read(~/.claude/**)", root),
    ).toBe(false);
  });

  it("Edit: ./ 始まりの root 基準パターンは tool_name Edit にも一致する", () => {
    const denial = { tool_name: "Edit", tool_input: { file_path: `${root}/.agent/config.json` } };
    expect(denialMatchesRule(denial, "Edit(./.agent/config.json)", root)).toBe(true);
    expect(
      denialMatchesRule(
        { tool_name: "Edit", tool_input: { file_path: `${root}/.agent/other.json` } },
        "Edit(./.agent/config.json)",
        root,
      ),
    ).toBe(false);
  });

  it("Bash: git branch -D * は削除コマンドに一致し --show-current には一致しない", () => {
    const denial = { tool_name: "Bash", tool_input: { command: "git branch -D victim" } };
    expect(denialMatchesRule(denial, "Bash(git branch -D *)", root)).toBe(true);
    expect(
      denialMatchesRule(
        { tool_name: "Bash", tool_input: { command: "git branch --show-current" } },
        "Bash(git branch -D *)",
        root,
      ),
    ).toBe(false);
  });

  it("ツール名が一致しなければ false", () => {
    const denial = { tool_name: "Write", tool_input: { file_path: `${root}/.env` } };
    expect(denialMatchesRule(denial, "Read(./.env)", root)).toBe(false);
  });

  it("tool_input に対象フィールドが無ければ false(判別不能は記録側に倒す)", () => {
    expect(denialMatchesRule({ tool_name: "Bash", tool_input: {} }, "Bash(git push*)", root)).toBe(false);
    expect(denialMatchesRule({ tool_name: "Read", tool_input: {} }, "Read(./.env)", root)).toBe(false);
  });
});

describe("partitionDeniedByRules", () => {
  const root = "/repo";
  const denyRules = ["Bash(git push*)", "Bash(sudo *)"];

  it("deny ルールに一致する denial のみ除外する", () => {
    const denials = [
      { tool_name: "Bash", tool_input: { command: "git push origin main" } },
      { tool_name: "Bash", tool_input: { command: "git status" } },
    ];
    const { kept, excludedCount } = partitionDeniedByRules(denials, denyRules, root);
    expect(excludedCount).toBe(1);
    expect(kept).toEqual([denials[1]]);
  });

  it("deny ルールが空なら全件 kept", () => {
    const denials = [{ tool_name: "Bash", tool_input: { command: "git push origin main" } }];
    const { kept, excludedCount } = partitionDeniedByRules(denials, [], root);
    expect(excludedCount).toBe(0);
    expect(kept).toEqual(denials);
  });
});

describe("loadDenyRules", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-denyrules-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("permissions.deny を配列として読み込む", () => {
    const settingsPath = path.join(dir, "claude-settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ["Bash(sudo *)"] } }));
    expect(loadDenyRules(settingsPath)).toEqual(["Bash(sudo *)"]);
  });

  it("ファイルが無ければ空配列", () => {
    expect(loadDenyRules(path.join(dir, "missing.json"))).toEqual([]);
  });

  it("壊れた JSON なら空配列", () => {
    const settingsPath = path.join(dir, "broken.json");
    fs.writeFileSync(settingsPath, "{ not valid json");
    expect(loadDenyRules(settingsPath)).toEqual([]);
  });

  it("permissions.deny が配列でなければ空配列", () => {
    const settingsPath = path.join(dir, "bad-shape.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: "not-an-array" } }));
    expect(loadDenyRules(settingsPath)).toEqual([]);
  });
});

describe("recordPermissionDenials", () => {
  let dir: string;
  // 実プロジェクトの .agent/claude-settings.json(既定値)には Bash(git push*) 等の deny が
  // 実在するため、deny 一致を明示的にテストする以外はテスト用の空(存在しない)パスを渡して
  // 実運用の deny 内容にテストが左右されないようにする
  let emptySettingsPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-denials-"));
    emptySettingsPath = path.join(dir, "no-such-settings.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readRecords = (): PermissionDenialRecord[] =>
    fs
      .readFileSync(permissionDenialsPathOf(dir), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as PermissionDenialRecord);

  it("複数の拒否が JSONL の複数行として追記される", () => {
    const res: SessionResult = {
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: "git status && git log" } },
          { tool_name: "Read", tool_input: { file_path: "/etc/passwd" } },
        ],
      }),
      stderr: "",
    };

    recordPermissionDenials("T-999", res, dir, dir, emptySettingsPath);

    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ session: "T-999", tool: "Bash", command: "git status && git log" });
    expect(records[1]?.tool).toBe("Read");
    expect(records[1]?.input).toContain("/etc/passwd");
  });

  it("2 回呼ぶと追記される(上書きされない)", () => {
    const res = (command: string): SessionResult => ({
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({ permission_denials: [{ tool_name: "Bash", tool_input: { command } }] }),
      stderr: "",
    });

    recordPermissionDenials("T-001", res("git push origin main"), dir, dir, emptySettingsPath);
    recordPermissionDenials("T-002", res("npm publish"), dir, dir, emptySettingsPath);

    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.session)).toEqual(["T-001", "T-002"]);
  });

  it("permission_denials が空ならファイルを作らない", () => {
    const res: SessionResult = {
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({ permission_denials: [] }),
      stderr: "",
    };

    recordPermissionDenials("T-999", res, dir, dir);

    expect(fs.existsSync(permissionDenialsPathOf(dir))).toBe(false);
  });

  it("全 denial が permissions.deny に一致するときファイルを作らない", () => {
    const settingsPath = path.join(dir, "claude-settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { deny: ["Bash(sudo *)"] } }));
    const res: SessionResult = {
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({
        permission_denials: [{ tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } }],
      }),
      stderr: "",
    };

    recordPermissionDenials("T-999", res, dir, dir, settingsPath);

    expect(fs.existsSync(permissionDenialsPathOf(dir))).toBe(false);
  });

  it("human-review ディレクトリを作らない(退行検出)", () => {
    const res: SessionResult = {
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({
        permission_denials: [{ tool_name: "Bash", tool_input: { command: "git status" } }],
      }),
      stderr: "",
    };

    recordPermissionDenials("T-999", res, dir, dir, emptySettingsPath);

    expect(fs.existsSync(path.join(dir, "human-review"))).toBe(false);
  });
});

describe("loadPermissionDenials", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-load-denials-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ファイルが無ければ空配列", () => {
    expect(loadPermissionDenials(dir)).toEqual([]);
  });

  it("壊れた行はスキップして続行する", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-08-10T00:00:00.000Z", session: "T-001", tool: "Bash", command: "ls" }),
      "not json",
      JSON.stringify({ timestamp: "2026-08-10T00:00:01.000Z", session: "T-002", tool: "Read", input: "{}" }),
    ];
    fs.writeFileSync(permissionDenialsPathOf(dir), lines.join("\n") + "\n");

    const entries = loadPermissionDenials(dir);

    expect(entries.map((e) => e.session)).toEqual(["T-001", "T-002"]);
  });
});

describe("summarizePermissionDenials", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  function record(overrides: Partial<PermissionDenialRecord> = {}): PermissionDenialRecord {
    return {
      timestamp: now.toISOString(),
      session: "T-001",
      tool: "Bash",
      command: "git status",
      ...overrides,
    };
  }

  it("7 日ウィンドウ外の記録を除外する", () => {
    const inWindow = record({ timestamp: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString() });
    const outOfWindow = record({
      timestamp: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      session: "T-002",
    });

    const summary = summarizePermissionDenials([inWindow, outOfWindow], now);

    expect(summary.total).toBe(1);
    expect(summary.rows).toHaveLength(1);
  });

  it("Bash はコマンド先頭語で集約するが git/npm/npx はサブコマンドまで含める", () => {
    const entries = [
      record({ command: "git push origin main" }),
      record({ command: "git push --force" }),
      record({ command: "git status" }),
      record({ command: "npm publish" }),
      record({ command: "stat -c %s file" }),
    ];

    const summary = summarizePermissionDenials(entries, now);
    const patterns = summary.rows.map((r) => r.pattern).sort();

    expect(patterns).toEqual(
      ["Bash(git push …)", "Bash(git status …)", "Bash(npm publish …)", "Bash(stat …)"].sort(),
    );
    expect(summary.rows.find((r) => r.pattern === "Bash(git push …)")?.count).toBe(2);
  });

  it("Bash 以外はツール名のみで集約する", () => {
    const entries = [
      record({ tool: "Read", command: undefined, input: '{"file_path":"/etc/passwd"}' }),
      record({ tool: "Read", command: undefined, input: '{"file_path":"/etc/shadow"}' }),
    ];

    const summary = summarizePermissionDenials(entries, now);

    expect(summary.rows).toEqual([expect.objectContaining({ pattern: "Read", count: 2 })]);
  });

  it("maxRows を超える分は hiddenPatterns / hiddenCount に畳む", () => {
    const distinct = ["alpha", "bravo", "charlie"].map((head) => record({ command: `${head} arg` }));

    const summary = summarizePermissionDenials(distinct, now, { maxRows: 2 });

    expect(summary.rows).toHaveLength(2);
    expect(summary.hiddenPatterns).toBe(1);
    expect(summary.hiddenCount).toBe(1);
  });

  it("command を持たないツールは input を example に使う", () => {
    const entries = [
      record({ tool: "Write", command: undefined, input: '{"file_path":"/etc/passwd","content":"x"}' }),
    ];

    const summary = summarizePermissionDenials(entries, now);

    expect(summary.rows[0]?.example).toContain("/etc/passwd");
  });

  it("sessions は新しい順・重複除去・最大 3 件", () => {
    const t0 = now.getTime();
    const at = (offsetMs: number): string => new Date(t0 - offsetMs).toISOString();
    const entries = [
      record({ session: "T-001", timestamp: at(4000) }),
      record({ session: "T-002", timestamp: at(3000) }),
      record({ session: "T-001", timestamp: at(2000) }),
      record({ session: "T-003", timestamp: at(1000) }),
      record({ session: "T-004", timestamp: at(0) }),
    ];

    const summary = summarizePermissionDenials(entries, now);

    expect(summary.rows[0]?.sessions).toEqual(["T-004", "T-003", "T-001"]);
  });
});

describe("permissionDenialLines", () => {
  it("rows が空なら空配列を返す", () => {
    expect(permissionDenialLines({ total: 0, rows: [], hiddenPatterns: 0, hiddenCount: 0 })).toEqual([]);
  });

  it("各行に件数・パターン・例・最終時刻(分まで)・セッションを含め、隠れた分と導線を末尾に付ける", () => {
    const summary = {
      total: 9,
      rows: [
        {
          pattern: "Bash(stat …)",
          count: 9,
          example: "stat -c %s file",
          lastAt: "2026-08-16T20:39:12.000Z",
          sessions: ["T-178", "T-171"],
        },
      ],
      hiddenPatterns: 2,
      hiddenCount: 5,
    };

    const lines = permissionDenialLines(summary);

    expect(lines[0]).toBe("9x Bash(stat …)  例: stat -c %s file  最終 2026-08-16T20:39 (T-178, T-171)");
    expect(lines).toContain("…他 2 パターン 5 件");
    expect(lines.at(-1)).toContain("permissions.allow");
  });
});

describe("loadPendingDecisions", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-pending-decisions-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ディレクトリが存在しなければ 0 件", () => {
    expect(loadPendingDecisions(path.join(dir, "not-exist"))).toEqual({ count: 0, preview: [] });
  });

  it("D-*.md 以外(index.md・README.md・ディレクトリ)は数えない", () => {
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(dir, `D-00${i}.md`), serializeFrontmatter({ title: `決定${i}` }, "本文"));
    }
    fs.writeFileSync(path.join(dir, "index.md"), "# index\n");
    fs.writeFileSync(path.join(dir, "README.md"), "# readme\n");
    // ディレクトリ名が D-*.md 相当でもファイルではないので数えない(isFile フィルタの確認)
    fs.mkdirSync(path.join(dir, "D-999.md"));

    const pd = loadPendingDecisions(dir);

    expect(pd.count).toBe(5);
    expect(pd.preview.some((d) => d.id === "index" || d.id === "D-999")).toBe(false);
  });

  it("preview は ID 降順(新しい順)の先頭 3 件", () => {
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(dir, `D-00${i}.md`), serializeFrontmatter({ title: `決定${i}` }, "本文"));
    }

    const pd = loadPendingDecisions(dir);

    expect(pd.preview.map((d) => d.id)).toEqual(["D-005", "D-004", "D-003"]);
  });

  it("frontmatter に title があればそれを使う", () => {
    fs.writeFileSync(path.join(dir, "D-001.md"), serializeFrontmatter({ title: "タイトルあり" }, "本文"));

    const pd = loadPendingDecisions(dir);

    expect(pd.preview).toEqual([{ id: "D-001", title: "タイトルあり" }]);
  });

  it("frontmatter が壊れている・title が無い決定は ID をそのまま title にする", () => {
    fs.writeFileSync(path.join(dir, "D-001.md"), "not frontmatter at all");
    fs.writeFileSync(path.join(dir, "D-002.md"), serializeFrontmatter({}, "本文"));

    const pd = loadPendingDecisions(dir);

    expect(pd.preview.find((d) => d.id === "D-001")?.title).toBe("D-001");
    expect(pd.preview.find((d) => d.id === "D-002")?.title).toBe("D-002");
  });
});

describe("pendingDecisionsSectionLines", () => {
  it("count が 0 なら空配列を返す", () => {
    expect(pendingDecisionsSectionLines({ count: 0, preview: [] })).toEqual([]);
  });

  it("2 件ならプレビュー 2 行と案内行のみ(「…他」行は出ない)", () => {
    const lines = pendingDecisionsSectionLines({
      count: 2,
      preview: [
        { id: "D-002", title: "決定2" },
        { id: "D-001", title: "決定1" },
      ],
    });

    expect(lines).toEqual([
      "D-002: 決定2",
      "D-001: 決定1",
      "→ 内容を確認したら .agent/decisions/index.md のチェックボックスを [x] にすると archive へ移動",
    ]);
  });

  it("5 件(プレビュー 3 件)ならプレビュー 3 行 + 「…他 2 件」+ 案内行", () => {
    const lines = pendingDecisionsSectionLines({
      count: 5,
      preview: [
        { id: "D-005", title: "決定5" },
        { id: "D-004", title: "決定4" },
        { id: "D-003", title: "決定3" },
      ],
    });

    expect(lines).toEqual([
      "D-005: 決定5",
      "D-004: 決定4",
      "D-003: 決定3",
      "…他 2 件",
      "→ 内容を確認したら .agent/decisions/index.md のチェックボックスを [x] にすると archive へ移動",
    ]);
  });
});

describe("appendUncommittedDiffRecord", () => {
  // patchFile は実際には state ディレクトリ配下の絶対パス(lib/paths.ts の patchesDir 参照。
  // `.agent/` 配下ではない)。フィクスチャもそれに合わせる。
  const PATCH_FILE = "/home/node/.local/state/ccloop/repo-a1b2c3d4/patches/T-001-20260815T000000Z.patch";
  const rec = {
    at: "2026-08-15T00:00:00.000Z",
    patchFile: PATCH_FILE,
    paths: ["src/a.ts", "src/b.ts"],
  };

  it("見出しが無い本文には見出しごと追加する", () => {
    const result = appendUncommittedDiffRecord("既存の本文", rec);

    expect(result).toContain("既存の本文");
    expect(result).toContain("## 試行履歴");
    expect(result).toContain("### 未コミット差分(2026-08-15T00:00:00.000Z, ccloop 記録)");
    expect(result).toContain("`src/a.ts`, `src/b.ts`");
    expect(result.match(/## 試行履歴/g)).toHaveLength(1);
  });

  it("退避先のパッチと復元コマンドを記載する", () => {
    const result = appendUncommittedDiffRecord("既存の本文", rec);

    expect(result).toContain(`\`${PATCH_FILE}\``);
    expect(result).toContain(`git apply ${PATCH_FILE}`);
  });

  it("見出しが既にある本文にはエントリのみ末尾に追加し既存エントリを保持する", () => {
    const withAttempt = appendAttemptRecord("既存の本文", {
      attempt: 1,
      at: "2026-08-14T00:00:00.000Z",
      kind: "timeout",
      reason: "タイムアウト(2400000ms)",
    });

    const result = appendUncommittedDiffRecord(withAttempt, rec);

    expect(result.match(/## 試行履歴/g)).toHaveLength(1);
    expect(result).toContain("### 試行 1(");
    expect(result).toContain("### 未コミット差分(");
  });

  it("paths が空なら本文をそのまま返す", () => {
    const body = "既存の本文";
    expect(appendUncommittedDiffRecord(body, { ...rec, paths: [] })).toBe(body);
  });

  it("21 件以上のときは先頭 20 件のみ列挙し、残りを「ほか N 件」と付記する", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);

    const result = appendUncommittedDiffRecord("", { ...rec, paths });

    expect(result).toContain("`src/file-0.ts`");
    expect(result).toContain("`src/file-19.ts`");
    expect(result).not.toContain("`src/file-20.ts`");
    expect(result).toContain("ほか 5 件");
  });
});

describe("dirtyPathsOutsideAgent", () => {
  let dir: string;
  let hooksDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-dirty-"));
    // core.hooksPath を空ディレクトリに向け、グローバルの commit-msg フックから隔離する
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-dirty-hooks-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    // git 既定の normal では未追跡ディレクトリが `src/` に畳まれる。ローカルの ~/.gitconfig で
    // `all` にしていると実装側の指定漏れを見逃すため、既定値を明示して CI と同じ条件にする
    execFileSync("git", ["config", "status.showUntrackedFiles", "normal"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it(".agent/ 配下だけが汚れているときは空配列を返す", () => {
    const agentDir = path.join(dir, ".agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "state.json"), "{}");

    expect(dirtyPathsOutsideAgent(dir)).toEqual([]);
  });

  it(".agent/ 以外の追跡済みファイルの変更を検出する", () => {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "src/a.ts"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add a.ts"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");

    expect(dirtyPathsOutsideAgent(dir)).toEqual(["src/a.ts"]);
  });

  it("未追跡ファイルも検出する", () => {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "new.ts"), "export const b = 1;\n");

    expect(dirtyPathsOutsideAgent(dir)).toEqual(["src/new.ts"]);
  });

  it("git status に失敗した場合は空配列を返す", () => {
    expect(dirtyPathsOutsideAgent(path.join(dir, "does-not-exist"))).toEqual([]);
  });
});

/** テスト用の git リポジトリを 1 つ作る(グローバルの hook / 署名設定から隔離する) */
function initTestRepo(prefix: string, branch = "main"): { dir: string; hooksDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-hooks-`));
  execFileSync("git", ["init", "-b", branch], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return { dir, hooksDir };
}

/** リポジトリ内へタスクファイルを書く(ディレクトリは必要に応じて作る) */
function writeTaskFile(root: string, taskId: string, body: string): void {
  const tasksDir = path.join(root, ".agent", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, `${taskId}.md`), body);
}

describe("taskFileChangedOnBranch", () => {
  let dir: string;
  let hooksDir: string;
  let wtRoot: string;

  beforeEach(() => {
    ({ dir, hooksDir } = initTestRepo("supervisor-test-branch-diff"));
    wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-branch-diff-wt-"));
    writeTaskFile(dir, "T-001", serializeFrontmatter({ status: "ready" }, "本文"));
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(wtRoot, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  function branchWorktree(taskId: string): string {
    const wtPath = worktreePathFor(wtRoot, taskId);
    createWorktree(dir, wtPath, branchNameFor(taskId));
    execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: wtPath });
    return wtPath;
  }

  it("ブランチがタスクファイルを変更していれば true", () => {
    const wtPath = branchWorktree("T-001");
    writeTaskFile(wtPath, "T-001", serializeFrontmatter({ status: "completed" }, "本文"));
    execFileSync("git", ["commit", "-am", "タスクを完了する"], { cwd: wtPath });

    expect(taskFileChangedOnBranch(dir, branchNameFor("T-001"), "T-001")).toBe(true);
  });

  it("ブランチにコミットはあるがタスクファイルは触っていなければ false", () => {
    const wtPath = branchWorktree("T-001");
    fs.writeFileSync(path.join(wtPath, "other.txt"), "実装だけした\n");
    execFileSync("git", ["add", "other.txt"], { cwd: wtPath });
    execFileSync("git", ["commit", "-m", "実装する"], { cwd: wtPath });

    expect(taskFileChangedOnBranch(dir, branchNameFor("T-001"), "T-001")).toBe(false);
  });

  it("ブランチに新しいコミットが無ければ false", () => {
    branchWorktree("T-001");

    expect(taskFileChangedOnBranch(dir, branchNameFor("T-001"), "T-001")).toBe(false);
  });

  it("ブランチが存在せず判定できない場合は true(fail-open)", () => {
    expect(taskFileChangedOnBranch(dir, "agent/does-not-exist", "T-001")).toBe(true);
  });
});

describe("stop-check hook (lib/hooks/stop-check.ts)", () => {
  const script = path.resolve(import.meta.dirname, "hooks", "stop-check.ts");
  let dir: string;
  let hooksDir: string;
  let wt: string;

  beforeEach(() => {
    ({ dir, hooksDir } = initTestRepo("supervisor-test-stop-check"));
    writeTaskFile(dir, "T-001", serializeFrontmatter({ status: "ready" }, "本文"));
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    // 実際の Supervisor と同じく、タスクセッションは本体(dir, CCLOOP_REPO が指す先)とは
    // 別の worktree で動く。本体側を main のままにしておかないと、既定ブランチの判定
    // (CCLOOP_REPO の symbolic-ref)を正しく検査できない。
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-stop-check-wt-"));
    fs.rmdirSync(wt);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-001", wt, "main"], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  });

  /** hook を子プロセスで実行する。env は Supervisor が渡す環境変数のみを明示的に与える */
  function runHook(
    env: Record<string, string>,
    input: Record<string, unknown> = { cwd: wt },
  ): { status: number | null; stderr: string } {
    const base = { ...process.env };
    delete base.CLAUDE_AGENT_SESSION_KIND;
    delete base.CLAUDE_AGENT_TASK_ID;
    const res = spawnSync(process.execPath, [script], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...base, CCLOOP_REPO: dir, ...env },
    });
    return { status: res.status, stderr: res.stderr };
  }

  it("stop_hook_active なら何もせず許可する", () => {
    expect(runHook({ CLAUDE_AGENT_TASK_ID: "T-001" }, { cwd: wt, stop_hook_active: true }).status).toBe(0);
  });

  it("タスク ID が渡されていない(対話セッション)なら許可する", () => {
    expect(runHook({}).status).toBe(0);
  });

  it("探索セッションなら許可する", () => {
    expect(runHook({ CLAUDE_AGENT_SESSION_KIND: "explore", CLAUDE_AGENT_TASK_ID: "T-001" }).status).toBe(0);
  });

  it("タスクファイルが変更されていなければ終了をブロックする", () => {
    const res = runHook({ CLAUDE_AGENT_SESSION_KIND: "task", CLAUDE_AGENT_TASK_ID: "T-001" });

    expect(res.status).toBe(2);
    expect(res.stderr).toContain(".agent/tasks/T-001.md");
    expect(res.stderr).toContain("status");
  });

  it("タスクファイルに未コミットの変更があれば許可する", () => {
    writeTaskFile(wt, "T-001", serializeFrontmatter({ status: "completed" }, "本文"));

    expect(runHook({ CLAUDE_AGENT_SESSION_KIND: "task", CLAUDE_AGENT_TASK_ID: "T-001" }).status).toBe(0);
  });

  it("ブランチ上でタスクファイルをコミット済みなら許可する", () => {
    writeTaskFile(wt, "T-001", serializeFrontmatter({ status: "completed" }, "本文"));
    execFileSync("git", ["commit", "-am", "タスクを完了する"], { cwd: wt });

    expect(runHook({ CLAUDE_AGENT_SESSION_KIND: "task", CLAUDE_AGENT_TASK_ID: "T-001" }).status).toBe(0);
  });

  it("git で判定できない場所では終了を許可する(fail-open)", () => {
    const res = runHook(
      { CLAUDE_AGENT_SESSION_KIND: "task", CLAUDE_AGENT_TASK_ID: "T-001" },
      { cwd: path.join(wt, "does-not-exist") },
    );

    expect(res.status).toBe(0);
  });

  it("既定ブランチが master のリポジトリでも判定できる(main を決め打ちしない)", () => {
    const { dir: masterDir, hooksDir: masterHooksDir } = initTestRepo("supervisor-test-stop-check-master", "master");
    writeTaskFile(masterDir, "T-002", serializeFrontmatter({ status: "ready" }, "本文"));
    execFileSync("git", ["add", "-A"], { cwd: masterDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: masterDir });
    const masterWt = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-stop-check-master-wt-"));
    fs.rmdirSync(masterWt);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-002", masterWt, "master"], { cwd: masterDir });

    try {
      const base = { ...process.env };
      delete base.CLAUDE_AGENT_SESSION_KIND;
      delete base.CLAUDE_AGENT_TASK_ID;
      const res = spawnSync(process.execPath, [script], {
        input: JSON.stringify({ cwd: masterWt }),
        encoding: "utf8",
        env: { ...base, CCLOOP_REPO: masterDir, CLAUDE_AGENT_SESSION_KIND: "task", CLAUDE_AGENT_TASK_ID: "T-002" },
      });

      expect(res.status).toBe(2);
    } finally {
      fs.rmSync(masterDir, { recursive: true, force: true });
      fs.rmSync(masterHooksDir, { recursive: true, force: true });
      fs.rmSync(masterWt, { recursive: true, force: true });
    }
  });
});

describe("patchTimestamp", () => {
  it("命名規則どおりのパッチ名から退避時刻を取り出す", () => {
    expect(patchTimestamp("T-001-20260816T101112Z.patch")?.toISOString()).toBe("2026-08-16T10:11:12.000Z");
  });

  it("ID にハイフンが含まれていても末尾のタイムスタンプを読む", () => {
    expect(patchTimestamp("T-001-extra-20260816T000000Z.patch")?.toISOString()).toBe("2026-08-16T00:00:00.000Z");
  });

  it("命名規則から外れた名前は null", () => {
    expect(patchTimestamp("T-001.patch")).toBeNull();
    expect(patchTimestamp("T-001-20260816T101112Z.txt")).toBeNull();
    expect(patchTimestamp("メモ.md")).toBeNull();
  });

  it("実在しない日時は null(判定不能なファイルを消さない)", () => {
    expect(patchTimestamp("T-001-20261340T000000Z.patch")).toBeNull();
  });
});

describe("patchesToPrune", () => {
  const now = new Date("2026-08-16T00:00:00.000Z");

  it("keepDays より古いパッチだけを返す", () => {
    const names = [
      "T-001-20260701T000000Z.patch", // 46 日前
      "T-002-20260815T235959Z.patch", // 直前
    ];
    expect(patchesToPrune(names, now, 14)).toEqual(["T-001-20260701T000000Z.patch"]);
  });

  it("ちょうど keepDays 経過したものは削除対象に含める", () => {
    const boundary = "T-001-20260802T000000Z.patch"; // ちょうど 14 日前
    const justInside = "T-002-20260802T000001Z.patch"; // 14 日に 1 秒足りない
    expect(patchesToPrune([boundary, justInside], now, 14)).toEqual([boundary]);
  });

  it("命名規則から外れた名前は決して削除対象にしない", () => {
    const names = ["README.md", "T-001.patch", "手で置いたパッチ.patch"];
    expect(patchesToPrune(names, now, 0)).toEqual([]);
  });
});

describe("prunePatches", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-patches-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("古いパッチだけを削除し、件数を返す", () => {
    const patchesDir = path.join(dir, "patches");
    fs.mkdirSync(patchesDir, { recursive: true });
    fs.writeFileSync(path.join(patchesDir, "T-001-20260701T000000Z.patch"), "old");
    fs.writeFileSync(path.join(patchesDir, "T-002-20260815T000000Z.patch"), "new");
    fs.writeFileSync(path.join(patchesDir, "メモ.txt"), "人間が置いたファイル");

    const removed = prunePatches(patchesDir, new Date("2026-08-16T00:00:00.000Z"), 14);

    expect(removed).toBe(1);
    expect(fs.readdirSync(patchesDir).sort()).toEqual(["T-002-20260815T000000Z.patch", "メモ.txt"]);
  });

  it("patches ディレクトリが無ければ 0 件", () => {
    expect(prunePatches(path.join(dir, "patches"), new Date("2026-08-16T00:00:00.000Z"), 14)).toBe(0);
  });
});

describe("recoverStartupIn", () => {
  let dir: string;
  let hooksDir: string;
  let wtRoot: string;

  const NOW = new Date("2026-08-16T09:00:00.000Z");

  function git(args: string[], cwd: string = dir): string {
    return execFileSync("git", args, { cwd }).toString();
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

  function mergeHeadOf(cwd: string): string {
    const rel = git(["rev-parse", "--git-path", "MERGE_HEAD"], cwd).trim();
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    return fs.readFileSync(abs, "utf8").trim();
  }

  /** agent/<id> ブランチを worktree 上に作り、1 コミット積む。worktree のパスを返す */
  function commitOnAgentBranch(id: string, write: (wt: string) => void, message: string): string {
    const wt = worktreePathFor(wtRoot, id);
    createWorktree(dir, wt, branchNameFor(id));
    write(wt);
    git(["add", "-A"], wt);
    git(["commit", "-m", message], wt);
    return wt;
  }

  beforeEach(() => {
    // git が worktree のパスを realpath で記録するため、比較のためこちらも realpath に揃える
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-recover-")));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-recover-hooks-"));
    wtRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-recover-wt-")));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    writeTaskFile(dir, "T-001", serializeFrontmatter({ title: "タスク", status: "ready", retries: 0 }, "本文"));
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it("A: worktree の無い孤児ブランチは main へ回収し、ブランチを削除して試行履歴を残す", () => {
    const wt = commitOnAgentBranch(
      "T-001",
      (p) => fs.writeFileSync(path.join(p, "result.txt"), "成果\n"),
      "成果を追加する",
    );
    removeWorktree(dir, wt);

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(counts.recoveredMerges).toBe(1);
    expect(startupRecoveryTotal(counts)).toBe(1);
    expect(fs.existsSync(path.join(dir, "result.txt"))).toBe(true);
    expect(branchExists("agent/T-001")).toBe(false);

    const t = readTask("T-001");
    expect(t.status).toBe("ready");
    expect(t.retries).toBe(1);
    expect(t.body).toContain("## 試行履歴");
    expect(t.body).toContain("中断復旧");
  });

  it("B: 回収したタスクファイルが completed なら失敗として記録しない", () => {
    const wt = commitOnAgentBranch(
      "T-001",
      (p) =>
        writeTaskFile(p, "T-001", serializeFrontmatter({ title: "タスク", status: "completed", retries: 0 }, "本文")),
      "タスクを完了する",
    );
    removeWorktree(dir, wt);

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(counts.recoveredMerges).toBe(1);
    const t = readTask("T-001");
    expect(t.status).toBe("completed");
    expect(t.retries).toBe(0);
    expect(t.body).not.toContain("## 試行履歴");
  });

  it("C: 衝突する孤児ブランチは worktree に衝突を再現して残す", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "基底を追加する"]);

    const wt = commitOnAgentBranch(
      "T-001",
      (p) => fs.writeFileSync(path.join(p, "conflict.txt"), "ブランチ側\n"),
      "ブランチ側で書き換える",
    );

    fs.writeFileSync(path.join(dir, "conflict.txt"), "main 側\n");
    git(["commit", "-am", "main 側で書き換える"]);
    const mainHead = git(["rev-parse", "HEAD"]).trim();

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(counts.keptConflicts).toBe(1);
    expect(counts.parked).toBe(0);
    // main は巻き戻され、worktree 側に衝突が再現している
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(mainHead);
    expect(mergeInProgress(dir)).toBe(false);
    expect(fs.existsSync(wt)).toBe(true);
    expect(mergeInProgress(wt)).toBe(true);
    expect(branchExists("agent/T-001")).toBe(true);

    const t = readTask("T-001");
    expect(t.retries).toBe(1);
    expect(t.body).toContain("マージが衝突した");
    expect(t.body).toContain("conflict.txt");
  });

  it("D: 既に衝突解消待ちの worktree は触らず、retries も進めない(単純な再起動が試行回数を消費しないこと)", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "基底を追加する"]);
    git(["branch", "side"]);
    git(["checkout", "side"]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "side\n");
    git(["commit", "-am", "side で書き換える"]);
    git(["checkout", "main"]);

    const wt = commitOnAgentBranch(
      "T-001",
      (p) => fs.writeFileSync(path.join(p, "conflict.txt"), "ブランチ側\n"),
      "ブランチ側で書き換える",
    );
    try {
      git(["merge", "side"], wt);
    } catch {
      // コンフリクトによる非ゼロ終了は想定通り
    }
    const mergeHeadBefore = mergeHeadOf(wt);
    const mainHead = git(["rev-parse", "HEAD"]).trim();

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(counts.keptConflicts).toBe(1);
    expect(mergeInProgress(wt)).toBe(true);
    expect(mergeHeadOf(wt)).toBe(mergeHeadBefore);
    expect(branchExists("agent/T-001")).toBe(true);
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(mainHead);

    const t = readTask("T-001");
    expect(t.retries).toBe(0);
    expect(t.body).not.toContain("## 試行履歴");
  });

  it("E: agent ブランチ先端を指す中断マージは巻き戻してから回収を試みる", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "基底を追加する"]);

    const wt = commitOnAgentBranch(
      "T-001",
      (p) => fs.writeFileSync(path.join(p, "conflict.txt"), "ブランチ側\n"),
      "ブランチ側で書き換える",
    );
    removeWorktree(dir, wt);

    fs.writeFileSync(path.join(dir, "conflict.txt"), "main 側\n");
    git(["commit", "-am", "main 側で書き換える"]);
    try {
      git(["merge", "agent/T-001"]);
    } catch {
      // 衝突したところで Supervisor が落ちた状況を再現する
    }
    expect(mergeInProgress(dir)).toBe(true);

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(mergeInProgress(dir)).toBe(false);
    // 巻き戻したうえで改めて回収を試み、worktree が無いのでブランチを退避する
    expect(counts.parked).toBe(1);
    expect(branchExists("agent/T-001")).toBe(false);
    expect(branchExists(parkedBranchNameFor("T-001", NOW))).toBe(true);

    const t = readTask("T-001");
    expect(t.retries).toBe(1);
    expect(t.body).toContain(parkedBranchNameFor("T-001", NOW));
  });

  it("F: agent 由来でない中断マージには触らず、孤児ブランチの回収も見送る", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "基底を追加する"]);
    git(["branch", "side"]);
    git(["checkout", "side"]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "side\n");
    git(["commit", "-am", "side で書き換える"]);
    const sideHead = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "main 側\n");
    git(["commit", "-am", "main 側で書き換える"]);

    // 衝突しないブランチも用意し、こちらにも手が付かないことを確かめる
    const wt = commitOnAgentBranch(
      "T-001",
      (p) => fs.writeFileSync(path.join(p, "result.txt"), "成果\n"),
      "成果を追加する",
    );
    removeWorktree(dir, wt);

    try {
      git(["merge", "side"]);
    } catch {
      // 人間が手で始めたマージが衝突したまま残っている状況
    }

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(startupRecoveryTotal(counts)).toBe(0);
    expect(mergeInProgress(dir)).toBe(true);
    expect(mergeHeadOf(dir)).toBe(sideHead);
    expect(branchExists("agent/T-001")).toBe(true);
    expect(readTask("T-001").retries).toBe(0);
  });

  it("G: 旧形式の status: working は ready へ戻し retries を進める", () => {
    writeTaskFile(dir, "T-002", serializeFrontmatter({ title: "旧タスク", status: "working", retries: 0 }, "本文"));

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(counts.legacyWorking).toBe(1);
    const t = readTask("T-002");
    expect(t.status).toBe("ready");
    expect(t.retries).toBe(1);
    expect(t.body).toContain("中断復旧");
  });

  it("H: state.json の runningSessions を空にする", () => {
    const statePath = statePathOf(dir);
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        runningSessions: [{ kind: "task", taskId: "T-001", startedAt: "2026-08-16T08:00:00.000Z" }],
        sessionCount: 3,
      }),
    );

    recoverStartupIn(dir, config(), NOW);

    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as { runningSessions: unknown[]; sessionCount: number };
    expect(state.runningSessions).toEqual([]);
    expect(state.sessionCount).toBe(3);
  });

  it("I: agent/conflict/* の退避ブランチは自動処理の対象にしない", () => {
    const wt = commitOnAgentBranch(
      "T-001",
      (p) => fs.writeFileSync(path.join(p, "result.txt"), "成果\n"),
      "成果を追加する",
    );
    removeWorktree(dir, wt);
    const parked = parkedBranchNameFor("T-001", new Date("2026-08-15T00:00:00.000Z"));
    git(["branch", "-m", "agent/T-001", parked]);

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(startupRecoveryTotal(counts)).toBe(0);
    expect(branchExists(parked)).toBe(true);
    expect(fs.existsSync(path.join(dir, "result.txt"))).toBe(false);
  });

  it("J: 起動時点の ccloop 自身のソースのハッシュを state.json に記録する", () => {
    recoverStartupIn(dir, config(), NOW);

    const state = JSON.parse(fs.readFileSync(statePathOf(dir), "utf8")) as { supervisorSourceHash?: string };
    expect(state.supervisorSourceHash).toBe(supervisorSourceHash());
    expect(state.supervisorSourceHash).not.toBe("");
  });

  it("K: worktree に CHERRY_PICK_HEAD が残っている(merge 以外の中断)も衝突解消待ちとして保持する", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "基底を追加する"]);
    git(["branch", "side"]);
    git(["checkout", "side"]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "side\n");
    git(["commit", "-am", "side で書き換える"]);
    const sideHead = git(["rev-parse", "HEAD"]).trim();
    git(["checkout", "main"]);

    const wt = commitOnAgentBranch(
      "T-001",
      (p) => fs.writeFileSync(path.join(p, "conflict.txt"), "ブランチ側\n"),
      "ブランチ側で書き換える",
    );
    try {
      git(["cherry-pick", sideHead], wt);
    } catch {
      // コンフリクトによる非ゼロ終了は想定通り
    }
    // MERGE_HEAD ではなく CHERRY_PICK_HEAD が残っている状態(狭い mergeInProgress では捉えられない)
    expect(mergeInProgress(wt)).toBe(false);
    expect(worktreeConflictPending(wt)).toBe(true);

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(counts.keptConflicts).toBe(1);
    expect(fs.existsSync(wt)).toBe(true);
    expect(worktreeConflictPending(wt)).toBe(true);
    expect(branchExists("agent/T-001")).toBe(true);
  });

  it("L: git リポジトリでないディレクトリを渡しても worktreeConflictPending は例外を投げず false を返す", () => {
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-not-git-"));
    try {
      expect(worktreeConflictPending(notGit)).toBe(false);
    } finally {
      fs.rmSync(notGit, { recursive: true, force: true });
    }
  });

  it("M: main の merge --abort 自体が失敗する(wedged)場合、worktree・ブランチ・タスクファイルに一切手を付けない", () => {
    // 本番インシデントの再現(lib/merge.test.ts の resolveMechanically 直接呼び出しのテストと同根):
    // 衝突なく自動マージされたタスクファイルが、abort 直前に作業ツリー上だけで(git を経由せず)
    // 書き換わっていると、abort が "not uptodate" で失敗し main が固まる(wedged)。
    // ここでは recoverStartupIn の実行経路そのものを通す必要があるため、直接 fs に書くのではなく、
    // `git merge` の実行中に必ず発火する post-index-change フックを使ってタイミングよく再現する。
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "基底を追加する"]);

    const wt = commitOnAgentBranch(
      "T-001",
      (p) => {
        fs.writeFileSync(path.join(p, "conflict.txt"), "ブランチ側\n");
        writeTaskFile(
          p,
          "T-001",
          serializeFrontmatter({ title: "タスク", status: "ready", retries: 0 }, "ブランチが更新した本文"),
        );
      },
      "ブランチ側で書き換える(conflict.txt と自身のタスクファイル)",
    );

    fs.writeFileSync(path.join(dir, "conflict.txt"), "main 側\n");
    git(["commit", "-am", "main 側で書き換える"]);

    const branchHead = git(["rev-parse", "agent/T-001"]).trim();
    const mainHead = git(["rev-parse", "HEAD"]).trim();

    // conflict.txt は main/branch 双方が書き換えるので実質的な(mechanical でない)衝突になり、
    // .agent/tasks/T-001.md は branch だけが書き換えるので衝突なく自動マージされる。
    // core.hooksPath はリポジトリ共有設定のため worktree 側の git 呼び出し(commitAgentDir の
    // `git status`)でも同じフックが発火しうる。dir(main)上での git merge 実行時だけタスク
    // ファイルを書き換えたいので、フック内で cwd が dir と一致する場合のみ発火させる。
    // このフックは git merge の実行中(コンフリクト検出後・abort 前を含む)何度も発火するが、
    // 毎回同じ内容を書くだけなので最終状態は決定的
    const taskFilePath = path.join(dir, ".agent", "tasks", "T-001.md");
    fs.writeFileSync(
      path.join(hooksDir, "post-index-change"),
      `#!/bin/sh\nif [ "$(pwd)" = "${dir}" ]; then printf 'external tamper\\n' > "${taskFilePath}"; fi\n`,
    );
    fs.chmodSync(path.join(hooksDir, "post-index-change"), 0o755);

    const counts = recoverStartupIn(dir, config(), NOW);

    expect(startupRecoveryTotal(counts)).toBe(0);
    // main は merge --abort の失敗で固まったまま(wedged): 次回起動時の再評価に委ねる
    expect(mergeInProgress(dir)).toBe(true);
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(mainHead);

    // worktree・ブランチはどちらも触られていない
    expect(fs.existsSync(wt)).toBe(true);
    expect(branchExists("agent/T-001")).toBe(true);
    expect(git(["rev-parse", "agent/T-001"]).trim()).toBe(branchHead);

    // タスクファイルは(再現のためフックが直接書き換えた内容のまま)recordFailure 等で
    // さらに書き換えられていない。もし saveTaskIn が走っていれば frontmatter 形式で
    // 上書きされ、この文字列のままにはならない
    expect(fs.readFileSync(taskFilePath, "utf8")).toBe("external tamper\n");
  });
});

describe("newTaskId", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  beforeEach(() => {
    // useRepoRoot はモジュール内で共有される currentPaths を書き換えるため、他のテストへ
    // 影響を残さないよう元の値を退避し、afterEach で必ず復元する
    originalPaths = repoPaths();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-taskid-"));
    // newTaskId は repoPaths() 経由で対象リポジトリを見るため、テスト用の一時リポジトリを注入する
    useRepoRoot(dir);
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeTask = (relDir: string, id: string): void => {
    const d = path.join(dir, ".agent", relDir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${id}.md`), serializeFrontmatter({ status: "ready" }, "本文"));
  };

  it("日時プレフィックスと slug を繋いだ ID を作る", () => {
    expect(newTaskId("fix-login-retry", "2026-08-22T09:05:31.123Z")).toBe("T-20260822-0905-fix-login-retry");
  });

  it("同じ ID のタスクが既にあれば -2 を付ける", () => {
    writeTask("tasks", "T-20260822-0905-fix-login-retry");
    expect(newTaskId("fix-login-retry", "2026-08-22T09:05:31.123Z")).toBe("T-20260822-0905-fix-login-retry-2");
  });

  it("archive 済みのタスクとも衝突させない(ローテーション後の ID 再利用を防ぐ)", () => {
    writeTask("archive/tasks", "T-20260822-0905-fix-login-retry");
    expect(newTaskId("fix-login-retry", "2026-08-22T09:05:31.123Z")).toBe("T-20260822-0905-fix-login-retry-2");
  });

  it("サフィックス付きも埋まっていれば次の番号まで進める", () => {
    writeTask("tasks", "T-20260822-0905-fix-login-retry");
    writeTask("archive/tasks", "T-20260822-0905-fix-login-retry-2");
    expect(newTaskId("fix-login-retry", "2026-08-22T09:05:31.123Z")).toBe("T-20260822-0905-fix-login-retry-3");
  });

  it("旧形式のタスクが残っていても新形式で採番する", () => {
    writeTask("tasks", "T-001");
    writeTask("archive/tasks", "T-042");
    expect(newTaskId("drop-serial-ids", "2026-08-22T09:05:31.123Z")).toBe("T-20260822-0905-drop-serial-ids");
  });
});

describe("resolveTaskSlug", () => {
  it("有効な --slug 指定があればそのまま使う", () => {
    expect(resolveTaskSlug("タイトルは無視される", "fix-login-retry")).toBe("fix-login-retry");
  });

  it("不正な --slug 指定は throw する", () => {
    expect(() => resolveTaskSlug("タイトル", "Fix Login")).toThrow(/--slug/);
  });

  it("--slug 未指定なら title から生成する", () => {
    expect(resolveTaskSlug("Fix login retry", undefined)).toBe("fix-login-retry");
  });

  it("--slug 未指定かつ日本語だけの title なら既定値 task にフォールバックする", () => {
    expect(resolveTaskSlug("タスクの整理", undefined)).toBe("task");
  });
});

describe("resolvePriority", () => {
  it("未指定なら既定値 3 を返す", () => {
    expect(resolvePriority(undefined)).toBe(3);
  });

  it("整数文字列はそのまま数値にする", () => {
    expect(resolvePriority("1")).toBe(1);
  });

  it("数値でない値は throw する", () => {
    expect(() => resolvePriority("abc")).toThrow(/--priority/);
  });

  it("空文字は throw する", () => {
    expect(() => resolvePriority("")).toThrow(/--priority/);
  });

  it("小数は throw する", () => {
    expect(() => resolvePriority("1.5")).toThrow(/--priority/);
  });

  it("Infinity は throw する", () => {
    expect(() => resolvePriority("Infinity")).toThrow(/--priority/);
  });

  it("空白のみの文字列は throw する(Number では 0 になってしまうため)", () => {
    expect(() => resolvePriority("   ")).toThrow(/--priority/);
  });

  it("16 進数表記は throw する(Number では 16 になってしまうため)", () => {
    expect(() => resolvePriority("0x10")).toThrow(/--priority/);
  });
});

describe("parseDeps", () => {
  it("未指定なら空配列を返す", () => {
    expect(parseDeps(undefined)).toEqual([]);
  });

  it("カンマ区切りの後の空白を trim して登録する", () => {
    expect(parseDeps("T-a, T-b")).toEqual(["T-a", "T-b"]);
  });

  it("末尾カンマや空要素は捨てる", () => {
    expect(parseDeps("T-a,,T-b,")).toEqual(["T-a", "T-b"]);
  });
});

describe("assertDepsExist", () => {
  it("存在する ID のみなら throw しない", () => {
    expect(() => assertDepsExist(["T-a", "T-b"], ["T-a", "T-b", "T-c"])).not.toThrow();
  });

  it("存在しない ID が含まれると throw し、メッセージにその ID が含まれる", () => {
    expect(() => assertDepsExist(["T-a", "T-x"], ["T-a", "T-b"])).toThrow(/T-x/);
  });

  it("空配列なら throw しない", () => {
    expect(() => assertDepsExist([], [])).not.toThrow();
  });

  it("似た ID がある場合「もしかして」候補がメッセージに含まれる", () => {
    expect(() => assertDepsExist(["T-20260830-0344-retry-foo"], ["T-20260101-0000-retry-bar"])).toThrow(
      /もしかして: T-20260101-0000-retry-bar/,
    );
  });
});

describe("allTaskIds / assertDepsExist(archive)", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;

  beforeEach(() => {
    // useRepoRoot はモジュール内で共有される currentPaths を書き換えるため、他のテストへ
    // 影響を残さないよう元の値を退避し、afterEach で必ず復元する
    originalPaths = repoPaths();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-alltaskids-"));
    useRepoRoot(dir);
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeTask = (relDir: string, id: string): void => {
    const d = path.join(dir, ".agent", relDir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${id}.md`), serializeFrontmatter({ status: "ready" }, "本文"));
  };

  it("allTaskIds は .agent/tasks と .agent/archive/tasks の両方の ID を返す", () => {
    writeTask("tasks", "T-open");
    writeTask("archive/tasks", "T-done");

    expect(allTaskIds().sort()).toEqual(["T-done", "T-open"]);
  });

  it("completed で archive 済みのタスクへの依存は throw しない(回帰)", () => {
    writeTask("archive/tasks", "T-done");

    expect(() => assertDepsExist(["T-done"], allTaskIds())).not.toThrow();
  });
});

describe("mainLoop の二重起動ガード(回帰)", () => {
  let dir: string;
  let originalPaths: ReturnType<typeof repoPaths>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    // useRepoRoot はモジュール内で共有される currentPaths を書き換えるため、他のテストへ
    // 影響を残さないよう元の値を退避し、afterEach で必ず復元する
    originalPaths = repoPaths();
    originalExitCode = process.exitCode;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-startupguard-"));
    useRepoRoot(dir);
  });

  afterEach(() => {
    setRepoPaths(originalPaths);
    process.exitCode = originalExitCode;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it(
    "生存記録が『生きている』状態なら、mainLoop は state.json の runningSessions を書き換えずに起動を拒否する",
    async () => {
      // 起動時点で先発プロセスが積んだ「実行中セッション」を再現する。ガードが本体の処理へ
      // 抜けてしまうと、この内容が recoverStartup 等によって書き換えられてしまう。
      const stateBefore = {
        runningSessions: [
          {
            kind: "task",
            taskId: "T-001",
            branch: "agent/T-001",
            worktree: "/tmp/does-not-matter",
            model: "opus",
            startedAt: "2026-08-30T09:00:00.000Z",
            phase: "running",
          },
        ],
        sessionCount: 1,
      };
      fs.writeFileSync(repoPaths().statePath, JSON.stringify(stateBefore));

      // 「生きている」生存記録: PID は自分自身(必ず生存する)、procStartToken は実測値を使う
      // (Linux では起動時刻トークンの照合が走るため、記録時と評価時で値を一致させる必要がある)。
      const procStartToken = readProcStartToken(process.pid);
      writeRunnerRecord(repoPaths().runnerPath, {
        pid: process.pid,
        startedAt: "2026-08-30T08:00:00.000Z",
        heartbeatAt: new Date().toISOString(),
        host: os.hostname(),
        heartbeatIntervalMs: 60_000,
        ...(procStartToken !== null ? { procStartToken } : {}),
      });

      const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await mainLoop();

      expect(process.exitCode).toBe(1);
      expect(JSON.parse(fs.readFileSync(repoPaths().statePath, "utf8"))).toEqual(stateBefore);
      expect(stderrSpy).toHaveBeenCalled();
      // 原因(既に動いている)と対処(停止する / status で確認する)が読み取れる文言であること
      const message = stderrSpy.mock.calls.flat().join("\n");
      expect(message).toContain("既に ccloop run が動いています");
      expect(message).toContain("ccloop status");
    },
    10000,
  );
});
