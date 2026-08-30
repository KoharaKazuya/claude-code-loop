/**
 * 自律実行 Supervisor
 *
 * Claude Code セッションを決定論的に起動・監視するループ。LLM 的な判断は持たない。
 * このプロセスはステートレスで、状態はすべてファイルに永続化される。
 * 人間と共有するデータは対象リポジトリの `.agent/` に、実行時状態はリポジトリ外の
 * state ディレクトリに置く(paths.ts を参照)。
 *
 * CLI のエントリポイントは cli.ts。サブコマンドの一覧はそちらを参照。
 *
 * 停止方法(run モード): 外部からの停止手段は Ctrl+C(SIGINT)だけで、停止指示は
 * このプロセスのメモリ(currentStopMode)にしか存在しない。プロセスが終われば停止意思も消える
 * ため、再開はいつでも `ccloop run` を実行するだけでよい。Ctrl+C は押すたびに段階が上がる:
 *   1 回目 (clean) 新規セッションを起動せず、実行中のセッションが終わり次第停止する。
 *                  git 差分(.agent/ 除く)が残っていればその旨をログに出したうえで残して停止する。
 *                  例外として、衝突解消待ちの worktree があれば、その解消セッションだけは
 *                  1 本ずつ(タスクごとに停止後 1 回まで)起動してから停止する
 *   2 回目         緊急停止(SIGTERM → 猶予後 SIGKILL)
 *   3 回目         即 SIGKILL
 * 中断されたセッションの worktree とブランチはそのまま残り、次回そのタスクを実行するときに
 * 再利用される。SIGTERM も同じ段階エスカレーションに合流する(1 回目は clean 相当)。
 *
 * タスクセッションは常に `claude -p --worktree <タスクID>` で起動され、リポジトリ本体の外側の
 * worktree(ブランチ `agent/<タスクID>`)で動く。成果は終了後に Supervisor が main へ自動マージし、
 * worktree とブランチを片付ける。コンフリクト時は worktree を残し、次の試行を「衝突解消セッション」
 * として同じ worktree で起動する。探索セッションは従来どおりリポジトリ本体で動く。
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { styleText } from "node:util";
import { normalizeConfig, type Config } from "./config.ts";
import { parseFrontmatter, serializeFrontmatter, type FrontmatterValue } from "./frontmatter.ts";
import { usageOf } from "./help.ts";
import { buildId, disambiguateId, isValidSlug, slugify, SLUG_MAX_LENGTH } from "./ids.ts";
import {
  clearRunnerRecord,
  describeLoopLiveness,
  evaluateLoopLiveness,
  evaluateStartupGuard,
  readProcStartToken,
  readRunnerRecord,
  writeRunnerRecord,
  type LoopLiveness,
} from "./liveness.ts";
import { log } from "./log.ts";
import {
  abortMerge,
  mergeAgentBranch,
  type AbortRetryPolicy,
  type ConflictKind,
  type MergeOutcome,
  type WedgedStep,
} from "./merge.ts";
import { ccloopHome, createPaths, resolveRepoRoot, type Paths } from "./paths.ts";
import { detectSessionRateLimit } from "./ratelimit.ts";
import { rotate, rotateResultIsEmpty, type RotateOptions } from "./rotate.ts";
import { agentsArgs } from "./agents.ts";
import { generateSystemPrompt } from "./prompt.ts";
import { generateSettings } from "./settings.ts";
import { type LoopAction, planLoopStep, type StopMode } from "./scheduler.ts";
import {
  buildTriagePrompt,
  hasFreeTextAnswer,
  isAnsweredEntry,
  parseTriageResponse,
  selectDeterministicCloses,
  selectLightTriageCandidates,
  type TaskSummary,
} from "./triage.ts";
import {
  branchNameFor,
  deleteBranch,
  gitOperationInProgress,
  listWorktrees,
  mergeInProgress,
  parkedBranchNameFor,
  patchFileName,
  pruneWorktrees,
  removeWorktree,
  renameBranch,
  salvagePatch,
  worktreePathFor,
} from "./worktree.ts";

// ---------- 対象リポジトリのパス ----------
//
// ccloop はリポジトリの外にインストールされ、任意のリポジトリに対して実行される。
// そのため対象リポジトリはモジュールのロード時ではなく実行時に決まる。CLI(cli.ts)が
// 起動時に setRepoPaths で確定させ、以降はここから参照する。

let currentPaths: Paths | null = null;

/**
 * 対象リポジトリのパス一式。未確定なら cwd から解決する
 * (テストや直接 import での利用を、CLI を経由せずとも動くようにするため)。
 *
 * ただしこのフォールバックに依存してよいのは設定・タスク・state の読み書きまでである。
 * worktree やブランチを作成・削除・改名・マージする関数は、対象リポジトリのルートを
 * 引数で受け取ること(cwd 由来の暗黙値のまま呼ばれると、意図しないリポジトリのブランチを壊す)。
 */
export function repoPaths(): Paths {
  if (currentPaths === null) currentPaths = createPaths(resolveRepoRoot());
  return currentPaths;
}

/** 対象リポジトリを確定させる(CLI の起動時、およびテストからの注入用) */
export function setRepoPaths(p: Paths): void {
  currentPaths = p;
}

/** 対象リポジトリを root で確定させ、確定した Paths を返す */
export function useRepoRoot(root: string): Paths {
  const p = createPaths(root);
  setRepoPaths(p);
  return p;
}

/**
 * state ディレクトリ配下の `permission-denials.jsonl`(git 管理外)。permission 拒否の追記型ログ。
 * テストから tmpdir を渡せるよう、stateDir を引数に取る。
 */
export function permissionDenialsPathOf(stateDir: string): string {
  return path.join(stateDir, "permission-denials.jsonl");
}
// state.json と patches/ のパスは root を受け取る statePathOf / patchesDirOf で求める
// (起動時復旧をフィクスチャのリポジトリに対しても実行できるようにするため)

/**
 * "working" は現行の Supervisor が書き込むことはない(実行中セッションは state.json の
 * runningSessions が持ち、タスクファイルには現れない)。過去バージョンが残した
 * working のファイルを読めるよう、型と起動時復旧(recoverStartupIn)にのみ残している。
 */
type TaskStatus = "ready" | "working" | "blocked" | "completed" | "failed";

const TASK_STATUSES: readonly TaskStatus[] = ["ready", "working", "blocked", "completed", "failed"];

/** .agent/tasks/<id>.md の内容。frontmatter がフィールド、本文が説明・詳細メモ */
export interface Task {
  /** ファイル名(拡張子を除く)が ID */
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  dependencies: string[];
  retries: number;
  /** マージ衝突による失敗の再試行回数。retries とは別枠(マージ衝突はタスクの中身の失敗ではないため) */
  conflictRetries: number;
  createdAt: string;
  /** 1 行の進捗・結果・ブロック理由(詳細は本文へ) */
  note?: string;
  /** このタスクだけ使うモデル(未指定なら config.model。エスカレーション発動時はそちらが優先) */
  model?: string;
  /** この時刻(ISO 8601)まで選択対象から外す(任意) */
  snoozeUntil?: string;
  /** frontmatter 以降の本文(自己完結した説明・進捗の詳細) */
  body: string;
}

// Config と normalizeConfig は WorktreeCreate hook からも使うため config.ts に置く。
// 既存の import 元(supervisor.ts)を保つため、ここから再 export する。
export { normalizeConfig };
export type { Config };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 実行中の 1 セッション(タスク or 探索)の状態 */
export interface RunningSessionState {
  kind: "task" | "explore";
  /** kind が task のときのタスク ID */
  taskId?: string;
  /** 並列実行用の作業ブランチ名(未使用なら省略) */
  branch?: string;
  /** 並列実行用の worktree パス(未使用なら省略) */
  worktree?: string;
  /** このセッションが使用しているモデル */
  model?: string;
  /** 開始時刻(ISO 8601) */
  startedAt: string;
  /** セッションプロセスの PID(未使用なら省略) */
  pid?: number;
  /** running: 実行中 / finishing: 結果反映(マージ等)中。未指定は running 扱い */
  phase?: "running" | "finishing";
}

interface State {
  /** 実行中セッションの一覧。探索セッションも並列枠を 1 つ消費するため、
   * タスクセッションと探索セッションの合計が parallel.maxSessions を超えることはない
   * (探索が走っている間は新しいタスクセッションを起動しない) */
  runningSessions: RunningSessionState[];
  lastExploreAt: string | null;
  /** 前回取り込んだ人間からの入力(GOAL.md と answered な Human Review)のハッシュ */
  inputsHash?: string | null;
  /**
   * 前回探索セッション時点の GOAL.md ハッシュ / answered な human-review キー一覧。
   * inputsHash はトリガー判定(一致/不一致のみ)に使うため変更しない。こちらは探索プロンプトへの
   * 差分内訳(何が変わったか)表示専用に別で持ち、ベストエフォートの内訳提供に留めてトリガー判定への
   * 影響を避ける。
   */
  goalHash?: string | null;
  answeredKeys?: string[];
  /** triage(Stage 1/2)を試みた時点の入力ハッシュ。inputsHash と一致する間は同じ入力に対して
   * triage を繰り返さない(無限リトライ防止)。triage で解決しきれず inputsChanged が残った
   * 場合は、次に変わった入力ハッシュへ対して改めて triage を試みる */
  triageAttemptedHash?: string | null;
  /**
   * run 起動時点の ccloop 自身(CCLOOP_HOME)のソースのハッシュ。現在のソースと異なれば、稼働中のプロセスは
   * 古いコードのまま動いている(supervisor.ts 等の変更は再起動するまで反映されない)。
   */
  supervisorSourceHash?: string | null;
  rateLimit: { resumeAt: string | null };
  /**
   * 現在の停止指示(**表示専用**)。制御は run プロセスのメモリ(currentStopMode)だけで行い、
   * ここは `ccloop status` / `ccloop watch` が「停止処理中」を出すための写しに過ぎない。
   * run の起動時に "none" へリセットされるため、前回のプロセスの値が残ることはない。
   */
  stopMode?: StopMode;
  sessionCount: number;
  updatedAt: string | null;
}

// ---------- ファイル IO(すべて同期・アトミック書き込み) ----------

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function loadConfig(): Config {
  return normalizeConfig(readJson<unknown>(repoPaths().configPath), repoPaths().root);
}

/** `ccloop run` の生存記録を書き直す(起動時と毎周回の心拍で使う) */
function touchRunnerRecord(startedAt: string, heartbeatIntervalMs: number): void {
  const procStartToken = readProcStartToken(process.pid);
  writeRunnerRecord(repoPaths().runnerPath, {
    pid: process.pid,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    host: os.hostname(),
    heartbeatIntervalMs,
    ...(procStartToken !== null ? { procStartToken } : {}),
  });
}

/** dir 直下の .md ファイル名一覧(ID 順)。ディレクトリがなければ空 */
function listMdFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** frontmatter の値を文字列として取り出す(文字列でなければ空文字) */
function str(v: FrontmatterValue | undefined): string {
  return typeof v === "string" ? v : "";
}

/** status が不正なファイルの警告は 1 プロセスにつき 1 回だけ出す(ポーリング毎の繰り返しを防ぐ) */
const warnedInvalidFiles = new Set<string>();

/** 1 ファイルを Task として読む。status が不正・読み込み不能なら null */
export function taskFromFile(dir: string, fileName: string): Task | null {
  try {
    const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, fileName), "utf8"));
    const status = str(data.status) as TaskStatus;
    if (!TASK_STATUSES.includes(status)) return null;
    const id = fileName.replace(/\.md$/, "");
    const task: Task = {
      id,
      title: str(data.title) || id,
      status,
      priority: typeof data.priority === "number" ? data.priority : 3,
      dependencies: Array.isArray(data.dependencies) ? data.dependencies : [],
      retries: typeof data.retries === "number" ? data.retries : 0,
      conflictRetries: typeof data.conflictRetries === "number" ? data.conflictRetries : 0,
      createdAt: str(data.createdAt),
      body,
    };
    if (str(data.note) !== "") task.note = str(data.note);
    if (str(data.model) !== "") task.model = str(data.model);
    if (str(data.snoozeUntil) !== "") task.snoozeUntil = str(data.snoozeUntil);
    return task;
  } catch {
    return null;
  }
}

/** dir 直下の全タスクファイルを読む。warn が真なら不正ファイルを警告する */
function loadTasksFrom(dir: string, warn: boolean): { tasks: Task[]; invalidFiles: string[] } {
  const tasks: Task[] = [];
  const invalidFiles: string[] = [];
  for (const fileName of listMdFiles(dir)) {
    const task = taskFromFile(dir, fileName);
    if (task === null) {
      invalidFiles.push(fileName);
      const full = path.join(dir, fileName);
      if (warn && !warnedInvalidFiles.has(full)) {
        warnedInvalidFiles.add(full);
        log(`警告: ${full} は frontmatter の status が不正なため無視する`);
      }
      continue;
    }
    tasks.push(task);
  }
  return { tasks, invalidFiles };
}

// タスク・state の読み書きは通常、確定済みの対象リポジトリ(repoPaths())に対して行うが、起動時復旧
// (recoverStartupIn)はフィクスチャのリポジトリを相手にテストできる必要があるため、
// root を明示的に受け取る変種を用意し、対象リポジトリ版はその薄いラッパーにしている。

/** root 配下の `.agent/tasks` */
function tasksDirOf(root: string): string {
  return path.join(root, ".agent", "tasks");
}

/** root に対応する state ディレクトリの `state.json`(リポジトリ外・git 管理外) */
export function statePathOf(root: string): string {
  return createPaths(root).statePath;
}

/** root に対応する state ディレクトリの `patches/`(リポジトリ外・git 管理外) */
function patchesDirOf(root: string): string {
  return createPaths(root).patchesDir;
}

function loadTasksIn(root: string): Task[] {
  return loadTasksFrom(tasksDirOf(root), true).tasks;
}

function loadTasks(): Task[] {
  return loadTasksIn(repoPaths().root);
}

/** id のタスクを 1 件だけ読む。見つからなければ null */
function loadTaskIn(root: string, id: string): Task | null {
  return loadTasksIn(root).find((x) => x.id === id) ?? null;
}

function loadTask(id: string): Task | null {
  return loadTaskIn(repoPaths().root, id);
}

/**
 * rotate で .agent/archive/tasks/ へ退避された completed タスクを読む。
 * ID 採番・進捗集計・依存表示の母集団に含めるための参照専用。
 */
function loadArchivedTasks(): Task[] {
  return loadTasksFrom(path.join(repoPaths().archiveDir, "tasks"), false).tasks;
}

export function taskFrontmatter(t: Task): Record<string, FrontmatterValue | undefined> {
  return {
    title: t.title,
    status: t.status,
    priority: t.priority,
    dependencies: t.dependencies,
    retries: t.retries,
    conflictRetries: t.conflictRetries !== 0 ? t.conflictRetries : undefined,
    model: t.model,
    note: t.note,
    snoozeUntil: t.snoozeUntil,
    createdAt: t.createdAt,
  };
}

function saveTaskIn(root: string, t: Task): void {
  const tasksDir = tasksDirOf(root);
  fs.mkdirSync(tasksDir, { recursive: true });
  const file = path.join(tasksDir, `${t.id}.md`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serializeFrontmatter(taskFrontmatter(t), t.body));
  fs.renameSync(tmp, file);
}

function saveTask(t: Task): void {
  saveTaskIn(repoPaths().root, t);
}

/** state.json が無いフレッシュなクローン向けの初期状態 */
const INITIAL_STATE: State = {
  runningSessions: [],
  lastExploreAt: null,
  rateLimit: { resumeAt: null },
  sessionCount: 0,
  updatedAt: null,
};

/** RunningSessionState 1 件分のゆるい検証。startedAt が無ければ現在時刻で補う */
function normalizeRunningSession(raw: unknown): RunningSessionState {
  const r = isPlainObject(raw) ? raw : {};
  const session: RunningSessionState = {
    kind: r.kind === "explore" ? "explore" : "task",
    startedAt: typeof r.startedAt === "string" ? r.startedAt : new Date().toISOString(),
  };
  if (typeof r.taskId === "string") session.taskId = r.taskId;
  if (typeof r.branch === "string") session.branch = r.branch;
  if (typeof r.worktree === "string") session.worktree = r.worktree;
  if (typeof r.model === "string") session.model = r.model;
  if (typeof r.pid === "number") session.pid = r.pid;
  if (r.phase === "running" || r.phase === "finishing") session.phase = r.phase;
  return session;
}

/**
 * runningSessions を正規化する。配列形式ならゆるく検証してそのまま使い、無ければ旧スカラー形式
 * (currentTaskId / currentSessionKind / currentSessionStartedAt)から 0〜1 件を合成する。
 * 合成のケース分けは旧 runningSessionLines(移行前の実装)の判定をそのまま踏襲する:
 * kind が "explore" なら探索セッション、kind が明示されていればその値で task/それ以外を判定し、
 * 未定義(旧旧形式)なら currentTaskId の有無で判定する。
 */
function normalizeRunningSessions(r: Record<string, unknown>): RunningSessionState[] {
  if (Array.isArray(r.runningSessions)) {
    return r.runningSessions.map(normalizeRunningSession);
  }

  const kindRaw = r.currentSessionKind;
  const hasKind = kindRaw !== undefined && kindRaw !== null;
  const currentTaskId = typeof r.currentTaskId === "string" ? r.currentTaskId : null;
  const startedAt =
    typeof r.currentSessionStartedAt === "string" ? r.currentSessionStartedAt : new Date().toISOString();

  if (kindRaw === "explore") return [{ kind: "explore", startedAt }];
  if (hasKind ? kindRaw === "task" : currentTaskId !== null) {
    if (currentTaskId === null) return [];
    return [{ kind: "task", taskId: currentTaskId, startedAt }];
  }
  return [];
}

/** state.json の生の中身から State を組み立てる。旧スカラー形式は runningSessions へ合成する */
export function normalizeState(raw: unknown): State {
  const r = isPlainObject(raw) ? raw : {};
  const rateLimit =
    isPlainObject(r.rateLimit) && (typeof r.rateLimit.resumeAt === "string" || r.rateLimit.resumeAt === null)
      ? { resumeAt: r.rateLimit.resumeAt as string | null }
      : { resumeAt: null };

  const state: State = {
    runningSessions: normalizeRunningSessions(r),
    lastExploreAt: typeof r.lastExploreAt === "string" ? r.lastExploreAt : null,
    rateLimit,
    sessionCount: typeof r.sessionCount === "number" ? r.sessionCount : 0,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
  };
  if (typeof r.inputsHash === "string" || r.inputsHash === null) state.inputsHash = r.inputsHash;
  if (typeof r.goalHash === "string" || r.goalHash === null) state.goalHash = r.goalHash;
  if (Array.isArray(r.answeredKeys)) state.answeredKeys = r.answeredKeys as string[];
  if (typeof r.triageAttemptedHash === "string" || r.triageAttemptedHash === null)
    state.triageAttemptedHash = r.triageAttemptedHash;
  if (typeof r.supervisorSourceHash === "string" || r.supervisorSourceHash === null)
    state.supervisorSourceHash = r.supervisorSourceHash;
  if (r.stopMode === "none" || r.stopMode === "clean") state.stopMode = r.stopMode;
  return state;
}

/** state.json が無ければ初期状態を返す(パースエラー等それ以外の失敗は従来通り例外を投げる) */
function loadStateIn(root: string): State {
  try {
    return normalizeState(readJson<unknown>(statePathOf(root)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...INITIAL_STATE };
    throw err;
  }
}

function loadState(): State {
  return loadStateIn(repoPaths().root);
}

function saveStateIn(root: string, state: State): void {
  state.updatedAt = new Date().toISOString();
  writeJson(statePathOf(root), state);
}

function saveState(state: State): void {
  saveStateIn(repoPaths().root, state);
}

// ---------- .agent/ の自動コミット ----------

/** 自動コミットのコミットメッセージに付与する trailer。人間向け履歴からの除外フィルタに使う */
export const AGENT_COMMIT_TRAILER = "Agent-Auto: supervisor-state";

/** subject の後に空行を挟んで AGENT_COMMIT_TRAILER を付与したコミットメッセージを組み立てる */
export function withTrailer(subject: string): string {
  return `${subject}\n\n${AGENT_COMMIT_TRAILER}`;
}

/** ステージ済みの 1 変更(`git diff --cached --name-status` の 1 レコード) */
export interface StagedChange {
  /** git のステータス文字("M" / "A" / "D" / "R100" 等) */
  status: string;
  /** 変更後のパス(削除なら削除されたパス) */
  path: string;
  /** rename/copy の移動元パス。それ以外は null */
  from: string | null;
}

/**
 * `git diff --cached --name-status -M -z` の出力を解釈する。
 * `-z` は NUL 区切りかつ core.quotePath のエスケープが無効になるため、
 * 日本語パスや空白入りパスがそのまま取れる(この関数の前提)。
 * R/C は 3 レコード(status, 移動元, 移動先)、それ以外は 2 レコード(status, path)。
 * 末尾 NUL による空レコードや不完全な末尾レコードは無視する。
 */
export function parseNameStatus(out: string): StagedChange[] {
  const records = out.split("\0").filter((r) => r !== "");
  const changes: StagedChange[] = [];
  let i = 0;
  while (i < records.length) {
    const status = records[i];
    i += 1;
    if (status === undefined) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = records[i];
      const to = records[i + 1];
      i += 2;
      if (from === undefined || to === undefined) break; // 不完全な末尾レコードは捨てる
      changes.push({ status, path: to, from });
    } else {
      const p = records[i];
      i += 1;
      if (p === undefined) break;
      changes.push({ status, path: p, from: null });
    }
  }
  return changes;
}

/**
 * `.agent/` 配下のパスから人間向けのカテゴリ名を決める(先に一致したものを採る固定優先順)。
 * 配列の順序がそのまま subject 内のカテゴリ列挙順にもなる。
 */
const AGENT_CATEGORIES: { readonly match: (p: string) => boolean; readonly label: string }[] = [
  { match: (p) => p.includes("/tasks/"), label: "タスク" },
  { match: (p) => p.includes("/decisions/"), label: "判断記録" },
  { match: (p) => p.includes("/human-review/"), label: "レビュー" },
  { match: (p) => p.endsWith("/OVERVIEW.md"), label: "全体像" },
  { match: (p) => p.endsWith("/GOAL.md"), label: "目標" },
  { match: (p) => p.endsWith("/PROMPT.local.md"), label: "手順書" },
];

/** カテゴリ未確定のファイルに使う総称 */
const FALLBACK_CATEGORY = "運用ファイル";

/** 自動生成に失敗した(できなかった)ときの固定 subject */
const DEFAULT_AGENT_SUBJECT = "docs(agent): 運用状態を更新する";

/** subject の最大長。これを超えたら情報量より読みやすさを優先してフォールバックする */
const SUBJECT_MAX_LENGTH = 72;

/** `.agent/archive/` 配下への移動か(カテゴリ判定では移動元パスを見る必要がある) */
function isArchivePath(p: string): boolean {
  return p.includes("/archive/") || p.startsWith("archive/");
}

function categoryOf(change: StagedChange): string {
  // archive への移動は宛先が全て archive/<種別>/ になるため、種別は移動元から採る
  const p = isArchivePath(change.path) && change.from !== null ? change.from : change.path;
  const normalized = p.startsWith("/") ? p : `/${p}`;
  return AGENT_CATEGORIES.find((c) => c.match(normalized))?.label ?? FALLBACK_CATEGORY;
}

/** tasks/decisions/human-review のファイルは basename(拡張子なし)が人間が使う ID そのもの */
function idOf(change: StagedChange): string | null {
  const category = categoryOf(change);
  if (category !== "タスク" && category !== "判断記録" && category !== "レビュー") return null;
  const base = change.path.split("/").pop();
  if (base === undefined || base === "") return null;
  return base.replace(/\.md$/, "");
}

/** ステータス文字 → 動詞(rename は呼び出し側で別扱いするためここでは扱わない) */
function verbOf(status: string): string {
  if (status.startsWith("A")) return "追加する";
  if (status.startsWith("D")) return "削除する";
  return "更新する";
}

/** カテゴリごとの件数を優先順に数える */
function countByCategory(changes: StagedChange[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of changes) {
    const label = categoryOf(c);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const order = [...AGENT_CATEGORIES.map((c) => c.label), FALLBACK_CATEGORY];
  return order.filter((label) => counts.has(label)).map((label) => ({ label, count: counts.get(label) ?? 0 }));
}

/**
 * カテゴリ内訳を「タスク 2 件と判断記録 1 件」の形に整形する。
 * 種別が 4 つ以上あるときは上位 3 種だけ挙げ、残りは合計ファイル数を `ほか N 件` で丸める
 * (前の「N 件」と単位を揃えるため、N は種別数ではなくファイル数)。
 */
function formatCategoryCounts(counts: { label: string; count: number }[]): string {
  const head = counts.slice(0, 3);
  const rest = counts.slice(3);
  const text = head.map((c) => `${c.label} ${c.count} 件`).join("と");
  if (rest.length === 0) return text;
  const restCount = rest.reduce((a, c) => a + c.count, 0);
  return `${text}ほか ${restCount} 件`;
}

/** 改行・タブ等の制御文字を含むか(git は -z 出力でパス中の改行をそのまま返すため必要) */
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * ステージ内容から接頭辞込みのコミット subject を組み立てる。
 * 例外は投げず、判断できない・長すぎる・制御文字が混ざる入力では定型文へ倒す
 * (生成 subject は commit-msg フックの Conventional Commits 検査を必ず通す必要があるため)。
 */
export function summarizeAgentCommit(changes: StagedChange[]): string {
  if (changes.length === 0) return DEFAULT_AGENT_SUBJECT;

  const moves = changes.filter((c) => c.status.startsWith("R") && isArchivePath(c.path));
  const edits = changes.filter((c) => !moves.includes(c));

  const subject = ((): string => {
    if (edits.length === 0) {
      return `docs(agent): ${formatCategoryCounts(countByCategory(moves))}を archive へ移動する`;
    }
    if (edits.length === 1 && moves.length === 0) {
      const only = edits[0];
      if (only !== undefined) {
        // ID は英数字なので前後に空白を入れる(カテゴリ名は日本語なので詰める)
        const id = idOf(only);
        const name = id !== null ? `${id} ` : categoryOf(only);
        return `docs(agent): ${name}を${verbOf(only.status)}`;
      }
    }
    const body = `${formatCategoryCounts(countByCategory(edits))}を更新する`;
    const suffix = moves.length > 0 ? ` (archive へ ${moves.length} 件移動)` : "";
    return `docs(agent): ${body}${suffix}`;
  })();

  // 制御文字(パスに改行等が含まれる場合)や長すぎる subject は読みにくく、フックの
  // Conventional Commits 検査もすり抜けうるため、件数だけの定型文へ倒す
  if (hasControlChar(subject) || subject.length > SUBJECT_MAX_LENGTH) {
    return `docs(agent): ${FALLBACK_CATEGORY} ${changes.length} 件を更新する`;
  }
  return subject;
}

/** summarizeAgentCommit は例外を投げない設計だが、コミット自体を落とさないための二重の安全網 */
function safeSummarize(changes: StagedChange[]): string {
  try {
    return summarizeAgentCommit(changes);
  } catch {
    return DEFAULT_AGENT_SUBJECT;
  }
}

/** rebase/merge 途中の警告は 1 プロセスにつき 1 回だけ出す */
let warnedGitInProgress = false;

// rebase・merge・cherry-pick・revert・bisect の途中でないかの判定(gitOperationInProgress)は
// linked worktree(.git がファイル)でも正しく動く ./worktree.ts の実装を使う
// (途中なら人間の作業に割り込まないよう commit をスキップする)

/**
 * .agent/ 配下の変更だけを git commit する。差分が無ければ何もしない。
 * pathspec 付き commit(`-- .agent`)は gitignore 済みファイルを再ステージする事故を
 * 招くため使わない。`git add -A -- .agent` でステージした後、ステージ内容を確認し、
 * .agent/ 以外のパスが混ざっていれば(人間が並行でステージ中の作業がある)コミットを
 * スキップする。ただし add の後に初めて検査すると、スキップする場合でも自分が加えた
 * .agent 分のステージだけが index に残ってしまい、人間が次に git commit したときに
 * .agent/ の自動生成物を巻き込んでしまう。そのため add の前にも同じ検査を行い、
 * 既に .agent 以外がステージ済みなら add 自体を行わずに抜ける(この時点ではインデックス
 * を一切変更していないため戻す処理は不要)。add の後の再検査は add による巻き込みに
 * 対する保険で、通常は起こらないが、該当したら自分が加えた分だけ index から戻す。
 * 失敗しても Supervisor 本体は止めず、警告ログのみ残す。
 *
 * message を省略するとステージ内容から subject を生成する(何が変わったか分からない
 * 定型コミットが履歴を埋めるのを避けるため)。呼び出し側が文脈を持っている場合
 * (復旧直後など)だけ明示的に渡す。
 */
export function commitAgentDir(message?: string, root: string = repoPaths().root): void {
  if (gitOperationInProgress(root)) {
    if (!warnedGitInProgress) {
      warnedGitInProgress = true;
      log("警告: rebase/merge/cherry-pick/revert/bisect 進行中のため .agent の自動コミットをスキップする");
    }
    return;
  }
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--", ".agent"], { cwd: root }).toString();
    if (status.trim() === "") return;

    const before = parseNameStatus(
      execFileSync("git", ["diff", "--cached", "--name-status", "-M", "-z", "HEAD"], { cwd: root }).toString(),
    );
    // rename は移動元も検査する(`docs/x.md` → `.agent/x.md` のような、人間の作業を
    // .agent/ へ引き込む形のステージを見逃さないため)
    if (before.some((c) => !c.path.startsWith(".agent/") || (c.from !== null && !c.from.startsWith(".agent/")))) {
      log("警告: .agent 以外の変更がステージされているため自動コミットをスキップする(人間の並行作業を保護)");
      return;
    }

    execFileSync("git", ["add", "-A", "--", ".agent"], { cwd: root });
    const after = parseNameStatus(
      execFileSync("git", ["diff", "--cached", "--name-status", "-M", "-z", "HEAD"], { cwd: root }).toString(),
    );
    if (after.length === 0) return;
    if (after.some((c) => !c.path.startsWith(".agent/") || (c.from !== null && !c.from.startsWith(".agent/")))) {
      log("警告: .agent 以外の変更がステージされているため自動コミットをスキップする(人間の並行作業を保護)");
      try {
        const beforePaths = new Set(before.map((c) => c.path));
        const toUnstage = after.filter((c) => !beforePaths.has(c.path)).map((c) => c.path);
        if (toUnstage.length > 0) {
          execFileSync("git", ["reset", "-q", "HEAD", "--", ...toUnstage], { cwd: root });
        }
      } catch (err) {
        log(`警告: .agent のステージを戻すのに失敗した: ${String(err)}`);
      }
      return;
    }
    const subject = message ?? safeSummarize(after);
    execFileSync("git", ["commit", "-m", withTrailer(subject)], { cwd: root });
    log(`.agent を commit した: ${subject}`);
  } catch (err) {
    log(`警告: .agent の自動コミットに失敗した: ${String(err)}`);
  }
}

// ---------- .agent/ 状態ファイルのローテーション ----------

/**
 * 何かを移動した場合だけログ 1 行を出し、移動の要約文字列を返す(移動が無ければ null)。
 * 移動先に同名ファイルが既にあってスキップされたものがあれば、件数に関わらず警告ログを 1 件ずつ出す
 * (記録が失われないよう移動を見送っているため、人間が気づいて手で解決する必要がある)。
 */
export function runRotate(agentDir: string = repoPaths().agentDir, options: RotateOptions = {}): string | null {
  const result = rotate(agentDir, options);
  for (const conflict of result.conflicts) {
    log(
      `警告: archive に同名ファイルがあるため移動をスキップした: ${conflict}` +
        `(記録が失われないよう移動を見送った。両方の内容を確認して手で解決すること)`,
    );
  }
  if (rotateResultIsEmpty(result)) return null;
  const parts: string[] = [];
  if (result.tasks > 0) parts.push(`tasks ${result.tasks} 件`);
  if (result.decisions > 0) parts.push(`decisions ${result.decisions} 件`);
  if (result.humanReview > 0) parts.push(`human-review ${result.humanReview} 件`);
  if (parts.length === 0) return null;
  const summary = parts.join(", ");
  log(`archive へ移動: ${summary}`);
  return summary;
}

// ---------- 退避パッチの掃除 ----------

/** 退避パッチを残す日数。これより古いものは自動削除する */
const PATCH_KEEP_DAYS = 14;

/** salvagePatch が付けるファイル名 `<taskId>-<YYYYMMDDTHHMMSSZ>.patch` の形 */
const PATCH_NAME_RE = /^.+-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.patch$/;

/**
 * パッチ名に埋め込まれた退避時刻を取り出す(純関数)。
 * 命名規則から外れた名前・実在しない日時は null(= 掃除の対象外)。
 * 人間が置いたファイルや将来の命名変更を、判定不能を理由に消してしまわないため。
 */
export function patchTimestamp(name: string): Date | null {
  const m = PATCH_NAME_RE.exec(name);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * names のうち削除対象(退避から keepDays 以上経過したもの)を返す(純関数)。
 * ちょうど keepDays 経過したものは削除対象に含める。
 */
export function patchesToPrune(names: string[], now: Date, keepDays: number): string[] {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  return names.filter((name) => {
    const at = patchTimestamp(name);
    return at !== null && at.getTime() <= cutoff;
  });
}

/**
 * state ディレクトリの `patches/` から古い退避パッチを削除し、削除件数を返す。
 * パッチはリポジトリ外にあり誰も見ないまま溜まり続けるため、期限を切って掃除する。
 * 試行履歴には退避先のパスが残るので、消えたことは後から辿れる。
 */
export function prunePatches(
  patchesDir: string = repoPaths().patchesDir,
  now: Date = new Date(),
  keepDays: number = PATCH_KEEP_DAYS,
): number {
  const dir = patchesDir;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // ディレクトリが無い = 退避パッチがまだ 1 件も無い
  }
  let removed = 0;
  for (const name of patchesToPrune(names, now, keepDays)) {
    try {
      fs.rmSync(path.join(dir, name));
      removed += 1;
    } catch (err) {
      log(`警告: 古い退避パッチ ${name} の削除に失敗した: ${String(err)}`);
    }
  }
  if (removed > 0) log(`${keepDays} 日より古い退避パッチを削除した: ${removed} 件`);
  return removed;
}

/**
 * 記録の片付け(ローテーション + 退避パッチの掃除)をまとめて行う。
 * 走行中のタスクセッションが担当しているタスクの記録だけは動かさない
 * (main 側で動かすとそのブランチの自動マージが modify/delete 衝突になるため)。
 */
export function runHousekeeping(state: State): void {
  const excludeTaskIds = new Set(
    state.runningSessions
      .filter((s): s is RunningSessionState & { taskId: string } => s.kind === "task" && s.taskId !== undefined)
      .map((s) => s.taskId),
  );
  runRotate(repoPaths().agentDir, { excludeTaskIds });
  prunePatches();
}

// ---------- 停止制御 ----------

/**
 * 現在の停止指示。**run プロセスのメモリだけに持ち、ファイルには永続化しない**。
 * 停止指示は「この実行中プロセスを止めたい」という意思であって、リポジトリの状態ではない。
 * ファイルに残すと、意思が消えたあとも残り続け、次回起動が起動直後に止まる罠になる。
 * 更新するのはシグナルハンドラ(escalateStop)と、プロセス開始時のリセットだけ。
 */
let currentStopMode: StopMode = "none";

/**
 * 現在の停止指示を読む。直接 currentStopMode を参照せず関数越しに読むのは型のため:
 * mainLoop は入口で `currentStopMode = "none"` を代入しており、実際の更新はシグナルハンドラ
 * (制御フロー解析からは見えない)が行うため、同じ関数内で直接読むと "none" に絞り込まれた
 * 型になってしまい、"clean" との比較がコンパイルエラーになる。
 */
function readStopMode(): StopMode {
  return currentStopMode;
}

/**
 * 停止指示を state.json へ写す(**表示専用**。制御には使わない)。
 * `ccloop status` / `ccloop watch` が「停止処理中」を出せるようにするためだけの副産物なので、
 * 書き込みに失敗しても停止処理は続ける。
 */
function publishStopMode(mode: StopMode): void {
  try {
    const state = loadState();
    if ((state.stopMode ?? "none") === mode) return;
    state.stopMode = mode;
    saveState(state);
  } catch (err) {
    log(`警告: 停止状態の表示用書き込みに失敗した(制御には影響しない): ${String(err)}`);
  }
}

/**
 * .agent/ を除いた git 差分(未ステージ・ステージ済み・未追跡)のパス一覧を返す。
 * porcelain 出力の各行は `XY <path>`(リネームは `XY old -> new`)形式のため、
 * 先頭 3 文字のステータス部分を落とし、リネームは `-> ` 以降(新しいパス)を採る。
 * git status に失敗した場合は「判定できないなら止まらない」既存の流儀に合わせ空配列を返す。
 *
 * `.agent/` の未コミット差分は設計上ここでは無視する。mainLoop は `.agent/` を触った周回の
 * 待機直前とループ終了時にしかコミットしないため `.agent/` は常時 dirty になりうる。
 * この除外を外すと clean 停止が永久に成立しなくなる。
 */
export function dirtyPathsOutsideAgent(root: string = repoPaths().root): string[] {
  try {
    const out = execSync("git status --porcelain --untracked-files=all -- . ':(exclude).agent'", { cwd: root }).toString();
    const paths = out
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "")
      .map((line) => {
        const rest = line.slice(3);
        const renameIdx = rest.indexOf("-> ");
        return renameIdx === -1 ? rest : rest.slice(renameIdx + 3);
      });
    return [...paths].sort();
  } catch (err) {
    log(`git status に失敗したため差分なしとみなす: ${String(err)}`);
    return [];
  }
}

// Ctrl+C(SIGINT)/SIGTERM による緊急停止。claude 子プロセスは detached(別プロセスグループ)で
// 起動しているため、シグナルは自動では届かない。明示的にグループごと殺して即座に終了する。
// タスクファイルは触られていないので status は ready のまま残り、次回そのまま再選択される
// (worktree とブランチも残り、次の試行で再利用される)。
// 並列実行のため、生きている子プロセスの PID を集合で持つ(各子は detached で別プロセス
// グループのため、グループ ID = PID を負値にして kill する)。
const childPids = new Set<number>();
let shuttingDown = false;

/**
 * main のワーキングツリーを壊しうる処理(マージ・main への commit・state.json の書き込み)を
 * 実行している最中を示すカウンタ。緊急停止でもこれが 0 になるまで exit を遅らせ、マージを
 * 途中で切ってコンフリクトしたままの main を残すことを防ぐ。
 * finishTaskSession は同期処理なので実際にはシグナルハンドラがその最中に走ることはないが、
 * 将来の非同期化に対する保険として置く。
 */
let criticalSection = 0;

/** セッションの壁時計時間がこれ未満で exitCode !== 0 のまま終わったら「瞬時クラッシュ」とみなす */
const FAST_CRASH_MS = 10_000;

/**
 * 「瞬時クラッシュ」判定: タイムアウトは含めない。壁時計時間 wallMs が FAST_CRASH_MS 未満で
 * exitCode !== 0 のまま終わった = 起動直後に落ちた疑いが濃いものを指す。
 */
export function isFastCrash(res: SessionResult, wallMs: number): boolean {
  return !res.timedOut && res.exitCode !== 0 && wallMs < FAST_CRASH_MS;
}

/**
 * fastCrashStreak の次の値を、1 セッションの結果から計算する。finishTaskSession から
 * 判定ロジックだけを切り出したもの(単体テストで検証できるようにするため)。
 *
 * finishTaskSession の結果分類(classifyTaskSessionResult: レートリミット → 衝突未解消 →
 * タイムアウト → それ以外)は retries・待機の設定と申し送りを誤らせないためレートリミットを
 * 最優先にし、衝突未解消をタイムアウトより先に見るが、こちらは判定の目的が
 * 異なるため timedOut を先に見てよい: タイムアウトになるまで(taskTimeoutMs 分、通常は数十分)
 * 走ったセッションはレートリミットが絡んでいるかどうかに関わらず「起動直後に落ちた」瞬時
 * クラッシュではないため、streak は 0 に戻すのが正しい。
 *   1. タイムアウトは瞬時クラッシュではないため streak を 0 に戻す(レートリミットかどうかに
 *      関わらず優先する)。
 *   2. レートリミットによる終了は環境要因の故障でも復旧の証拠でもないため据え置く(増減させない)。
 *   3. それ以外は、壁時計時間 wallMs が FAST_CRASH_MS 未満で異常終了(exitCode !== 0)なら
 *      加算し、そうでなければ 0 に戻す。
 */
export function nextFastCrashStreak(current: number, res: SessionResult, wallMs: number, rateLimited: boolean): number {
  if (res.timedOut) return 0;
  if (rateLimited) return current;
  if (isFastCrash(res, wallMs)) return current + 1;
  return 0;
}

/**
 * crash-backoff の待機を終えた後の fastCrashStreak。mainLoop の wait 分岐から呼ばれる決定
 * ロジックだけを切り出したもの(単体テストで検証できるようにするため)。1 周回だけ見送る
 * ルールのため、crash-backoff の待機明けは streak を 0 へ戻す。ただし停止処理に入っている
 * (stopMode !== "none")間は戻さない: scheduler.ts の停止分岐(優先度 1)は
 * 「fastCrashStreak が高いままなら諦めて停止する」設計であり、ここで streak を消してしまうと
 * その設計を迂回してしまう(Ctrl+C で停止指示が入り wakeEmitter が sleep を早期に起こした
 * 場合でも、この境界を守るために stopMode を見て判定する)。それ以外の理由の待機では変えない。
 */
export function fastCrashStreakAfterWait(
  streak: number,
  why: Extract<LoopAction, { type: "wait" }>["why"],
  stopMode: StopMode,
): number {
  return why === "crash-backoff" && stopMode === "none" ? 0 : streak;
}

/**
 * 直近の「瞬時クラッシュ」の連続回数。scheduler.ts の crash-backoff ルール
 * (fastCrashStreak >= 3 で 1 周回だけ起動を見送る)へ渡すための状態。
 * 起動直後に全滅するような環境要因の系統的な故障(例: worktree 置き場への書き込み権限がない)を
 * 検知し、機械的な再試行で失敗コミットを積み増し続ける事故を避けるために持つ。
 * レートリミットによる終了は環境要因の故障でも復旧の証拠でもないため数えない(据え置き)。
 * 更新箇所は 2 か所: finishTaskSession が瞬時クラッシュのたびに加算・非クラッシュで 0 に戻し、
 * mainLoop が crash-backoff の待機を 1 周回終えるたびに 0 に戻す(抑制を解除して次周回で
 * 通常どおり起動できるようにするため)。
 * 探索セッションの瞬時クラッシュは意図的に数えない。理由は 2 つ:
 *   - 数えても効かない: crash-backoff(scheduler.ts 優先度 5)は「実行可能タスクがある」ことを
 *     発火条件にするため、探索しか走らない状況では加算しても抑制は起きない。その状況でも
 *     探索は瞬時クラッシュ時に入力ハッシュを更新せず(未消費のまま次回へ持ち越す)、
 *     lastExploreFastCrashed により、同じプロセスの中では exploreDue(minInterval)が経過するまで
 *     次周回の探索条件が成立しない。ループは空回りせず idle-exit か待機へ落ちる。
 *   - 数えると害がある: タスクセッションが健全でも探索固有の失敗だけでタスク起動を抑制し、
 *     停止分岐(scheduler.ts 優先度 1)の衝突解消まで諦めさせてしまう。
 */
let fastCrashStreak = 0;

/**
 * 前回の探索セッション以降に、探索が見直すべき変化が main へ入ったか
 * (プロセス内フラグ、永続化しない)。scheduler.ts の探索判定へ mainDirty として渡す。
 * 立てるのは次の 2 つ、どちらも「成果または失敗確定が main に入った」場合だけ:
 *   - タスクセッションの成果が main へマージされた(merged / renumbered)
 *   - タスクの失敗が確定した(再試行が尽きて status=failed になった)
 * セッションが完了しただけ・クラッシュしてリトライ待ちに戻るだけでは立てない
 * (見直す対象が増えていないため)。
 * 起動時は mainLoop が true にリセットする(前回 run の積み残しを一度は見直すため)。
 */
let mainChangedSinceExplore = true;

/**
 * タスクセッションの結末が「探索が見直すべき main の変化」かどうか(mainChangedSinceExplore の定義)。
 * finishTaskSession はマージ時点と結果記録時点の 2 か所からこれを呼ぶため、判定はどちらか片方の
 * 材料だけを渡して評価できるようにしてある(未実施・未確定は null)。
 *   - merge:       マージ結果。merged / renumbered だけが main の内容を変える。
 *                  conflict / blocked / wedged はもちろん、nothing-to-merge(ブランチに新しい
 *                  コミットが無い)も main は変わっていないため false。
 *   - finalStatus: 結果記録後の main 側タスク status。failed(再試行が尽きて確定)は、探索が
 *                  後追いタスクや Human Review を起こすべき情報なので main の変化として扱う。
 *                  クラッシュしてリトライ待ちに戻るだけ(ready 等)なら false。
 */
export function mainChangedByTaskOutcome(merge: MergeOutcome | null, finalStatus: TaskStatus | null): boolean {
  if (merge !== null && (merge.result === "merged" || merge.result === "renumbered")) return true;
  return finalStatus === "failed";
}

// sleep() をタイマー満了前に起こすための通知チャネル(Ctrl+C で停止指示を立てた直後に
// アイドル待機・rate limit 待機を打ち切って停止判定へ即座に戻す。並列実行では
// セッション完了時にも発火し、アイドル待機中の周回を即座に後始末へ進める)。
const wakeEmitter = new EventEmitter();

/** 生きている全ての子プロセスグループへシグナルを送る(既に居なければ何もしない) */
function killAllChildren(signal: NodeJS.Signals): void {
  for (const pid of childPids) {
    try {
      process.kill(-pid, signal);
    } catch {}
  }
}

/** 緊急停止の最終段。main を触っている最中なら抜けるまで待ってから終了する */
function exitWhenSafe(): void {
  if (criticalSection > 0) {
    setTimeout(exitWhenSafe, 100);
    return;
  }
  process.exit(130);
}

function emergencyStop(signal: string): void {
  if (shuttingDown) {
    // 2 回目のシグナルは猶予を与えず即殺して終了
    killAllChildren("SIGKILL");
    exitWhenSafe();
    return;
  }
  shuttingDown = true;
  log(`${signal} 受信。緊急停止する(実行中セッションを強制終了。中断タスクは次回起動時に自動復旧)`);
  // 子が居なければ待つものがない。居る場合は最後の 1 つが落ちた時点で
  // runClaude 側の close ハンドラが exitWhenSafe() を呼ぶ
  if (childPids.size === 0) {
    exitWhenSafe();
    return;
  }
  killAllChildren("SIGTERM");
  setTimeout(() => {
    killAllChildren("SIGKILL");
    exitWhenSafe();
  }, 5_000);
}

/**
 * 段階エスカレーションの次の一手を判定する(純粋)。
 * 停止指示なし(none)なら clean を予約、既に clean(= 一度待つ意思表示は済んでいる)なら
 * 緊急停止に進む。
 */
export type StopEscalation = { mode: Exclude<StopMode, "none"> } | "emergency";
export function nextStopEscalation(mode: StopMode): StopEscalation {
  if (mode === "none") return { mode: "clean" };
  return "emergency";
}

/**
 * SIGINT(Ctrl+C)/ SIGTERM のハンドラ。1 回目は clean へ留め、セッションが安全な区切りで
 * 自発的に止まるのを待つ。既に緊急停止(SIGTERM)を送信済み、またはエスカレーション判定が
 * emergency のときは強制終了へ進む。
 * 停止指示はメモリ上の currentStopMode にだけ書く(state.json への反映は表示専用で、
 * メインループが「main を触るのはループ上だけ」の不変条件を守りながら行う)。
 */
function escalateStop(signal: string): void {
  if (shuttingDown) {
    emergencyStop(signal);
    return;
  }
  const escalation = nextStopEscalation(currentStopMode);
  if (escalation === "emergency") {
    emergencyStop(signal);
    return;
  }
  currentStopMode = escalation.mode;
  log(
    `${signal} 受信。停止 (clean) を予約した: 新規セッションを起動せず(衝突解消待ちの worktree がある場合は解消セッションだけ 1 本ずつ起動してから)、実行中が終わり次第停止する。もう一度 Ctrl+C すると実行中セッションを強制終了する(SIGTERM→猶予後 SIGKILL)`,
  );
  wakeEmitter.emit("wake");
}

// ---------- 起動時の復旧 ----------
//
// Supervisor はステートレスなので、前回のプロセスが落ちた痕跡はファイルシステムにしか残らない。
// 起動時に一度だけ、その痕跡(main の中断マージ・生き残った worktree・宙に浮いた agent/* ブランチ・
// 旧形式の status: working)を洗い、成果を main へ回収するか、人間が拾える形に固定する。
// 起動直後は走っているセッションが 1 つも無いため、agent/<id> ブランチはすべて「孤児」とみなせる。

/** 起動時復旧の内訳。合計 > 0 の周回だけ復旧を名乗るコミットメッセージを使う */
export interface StartupRecovery {
  /** 中断されたブランチから main へ成果を回収したタスク数 */
  recoveredMerges: number;
  /** 衝突解消待ちとして worktree を残したタスク数 */
  keptConflicts: number;
  /** worktree が無く、ブランチを agent/conflict/* へ退避したタスク数 */
  parked: number;
  /** 旧バージョンが残した status: working を再評価したタスク数 */
  legacyWorking: number;
}

export function startupRecoveryTotal(r: StartupRecovery): number {
  return r.recoveredMerges + r.keptConflicts + r.parked + r.legacyWorking;
}

/** `refs/heads/agent` 配下のローカルブランチを (先端 SHA, ブランチ名) で列挙する */
function listAgentBranches(root: string): { sha: string; branch: string }[] {
  try {
    const out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads/agent"],
      { cwd: root },
    ).toString();
    const result: { sha: string; branch: string }[] = [];
    for (const line of out.split("\n")) {
      const sep = line.indexOf(" ");
      if (sep <= 0) continue;
      result.push({ sha: line.slice(0, sep), branch: line.slice(sep + 1).trim() });
    }
    return result;
  } catch (err) {
    log(`警告: agent ブランチの列挙に失敗した: ${String(err)}`);
    return [];
  }
}

/**
 * mergeInProgress の判定不能(git が使えない等)を「進行中でない」に倒す版。
 * main 側専用(MERGE_HEAD の中身を読んで agent ブランチ由来か人間のマージかを見分ける
 * 処理に使うため、merge 固有の狭い判定のままにしている)。worktree 側の「衝突解消待ちか」の
 * 判定には代わりに worktreeConflictPending を使うこと。
 */
function mergeInProgressSafe(dir: string): boolean {
  try {
    return mergeInProgress(dir);
  } catch {
    return false;
  }
}

/**
 * worktree に前回の git 操作(merge / cherry-pick / revert / rebase / bisect)が
 * 中断されたまま残っているか。判定不能(git が使えない等)は「残っていない」に倒す。
 *
 * worktree 側の「衝突解消待ちか」の判定は、残す(finishTaskSession)・再開対象に選ぶ
 * (selectConflictResumable / startTaskSession)・起動時に保持する(recoverStartupIn)・
 * status に表示する(collectPendingConflicts)がすべて同じ状態を指していなければならない。
 * ここで一箇所に集約し、判定がずれて worktree が取り残されるのを防ぐ。
 */
export function worktreeConflictPending(dir: string): boolean {
  try {
    return gitOperationInProgress(dir);
  } catch {
    return false;
  }
}

/** dir における `git rev-parse --git-path <name>` のファイル内容(読めなければ null) */
function readGitPathFile(dir: string, name: string): string | null {
  try {
    const rel = execFileSync("git", ["rev-parse", "--git-path", name], { cwd: dir }).toString().trim();
    const abs = path.isAbsolute(rel) ? rel : path.join(dir, rel);
    return fs.readFileSync(abs, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * abortInterruptedAutoMerge の結果。呼び出し元が「再試行すべきか」「諦めるべきか」を
 * 判別できるよう boolean ではなく列挙で返す。
 * - "no-merge": そもそもマージが進行中でなかった
 * - "not-ours": MERGE_HEAD が読めない、または agent/* ブランチ由来でない(人間のマージ途中)
 * - "aborted": 巻き戻しに成功した
 * - "abort-failed": agent 由来のマージだったが abort 自体が失敗した(racy git 等)
 */
export type AutoMergeAbortResult = "no-merge" | "not-ours" | "aborted" | "abort-failed";

/**
 * 前回のプロセスが main のマージ中に落ちた場合の後始末。MERGE_HEAD が agent/* ブランチの
 * 先端を指していれば Supervisor 自身の自動マージの中断とみなして巻き戻す。一致しなければ
 * 人間が手で始めたマージの途中なので、警告だけ出して一切触らない。
 */
export function abortInterruptedAutoMerge(root: string, policy?: AbortRetryPolicy): AutoMergeAbortResult {
  if (!mergeInProgressSafe(root)) return "no-merge";
  const sha = (readGitPathFile(root, "MERGE_HEAD") ?? "").split("\n")[0]?.trim() ?? "";
  if (sha === "") {
    log("警告: main でマージが進行中だが MERGE_HEAD を読めないため触らない");
    return "not-ours";
  }
  const match = listAgentBranches(root).find((b) => b.sha === sha);
  if (match === undefined) {
    log("警告: main で agent 由来でないマージが進行中のため触らない(人間のマージ途中とみなす)");
    return "not-ours";
  }
  const result = abortMerge(root, policy);
  if (result.ok) {
    log(`中断していた自動マージを巻き戻した(${match.branch})`);
    return "aborted";
  }
  log(`警告: 中断していた自動マージの巻き戻しに失敗した: ${result.stderr}`);
  return "abort-failed";
}

/** p が dir の配下にあるか(dir 自身は含まない) */
function isInsideDir(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** worktreeDir 配下にある worktree を「ブランチ名 -> パス」で引けるようにする */
function agentWorktreesByBranch(root: string, worktreeDir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const entry of listWorktrees(root)) {
      if (entry.branch === null) continue;
      if (!isInsideDir(worktreeDir, entry.path)) continue;
      map.set(entry.branch, entry.path);
    }
  } catch (err) {
    log(`警告: worktree の列挙に失敗した: ${String(err)}`);
  }
  return map;
}

/**
 * 復旧したタスクの本文へ「## 試行履歴」の記録を残す(retries も進める)。
 * 既に completed / failed で決着しているタスクには何も書かない。completed は成果が
 * 無事に main へ渡った証拠であり、failed は既に人間の判断待ちで、どちらも
 * ここで retries を消費させる意味が無いため。extraLines は記録の末尾に足す補足。
 */
function recordStartupRecoveryNote(
  root: string,
  config: Config,
  taskId: string,
  opts: { reason: string; at: string; extraLines?: string[] },
): void {
  const t = loadTaskIn(root, taskId);
  if (t === null) {
    log(`警告: ${taskId} のタスクファイルが見つからないため復旧の記録を残せない`);
    return;
  }
  if (t.status === "completed" || t.status === "failed") return;
  recordFailure(t, {
    maxRetries: config.maxRetries,
    maxConflictRetries: config.maxConflictRetries,
    reason: opts.reason,
    kind: "recovery",
    at: opts.at,
  });
  if (opts.extraLines !== undefined && opts.extraLines.length > 0) {
    t.body = `${t.body}\n${opts.extraLines.join("\n")}`;
  }
  saveTaskIn(root, t);
  log(`recover: ${taskId} -> ${t.status} (retries=${t.retries})`);
}

/**
 * 孤児になった agent/<taskId> ブランチ 1 本を回収する。counts を破壊的に更新する。
 *
 * 判断の骨格:
 *   - worktree にマージが残っている  → 触らない(次の試行を衝突解消セッションとして再開させる)
 *   - マージできた / 何も無かった     → 成果を main へ入れ、worktree とブランチを片付ける
 *   - 衝突した(worktree あり)       → worktree に衝突を再現して残す
 *   - 衝突した(worktree なし)       → ブランチを agent/conflict/* へ退避して人間に渡す
 *   - マージを開始できなかった        → 何も触らない(次回の起動で再試行する)
 */
function recoverOrphanBranch(
  root: string,
  config: Config,
  branch: string,
  taskId: string,
  worktreeDir: string,
  worktreePath: string | undefined,
  now: Date,
  counts: StartupRecovery,
): void {
  const at = now.toISOString();
  const worktree = worktreePath ?? worktreePathFor(worktreeDir, taskId);
  const worktreeExists = fs.existsSync(worktree);

  if (worktreeExists && worktreeConflictPending(worktree)) {
    // ここは「セッションが中断された」わけではなく、単に衝突解消待ちの worktree が
    // まだ残っているだけの可能性がある(例えば単純な再起動)。実際にセッションが走って
    // 失敗した場合のみ retries を進めるべきで、ここで recordFailure すると再起動のたびに
    // 試行回数を無駄に消費してしまう(次に走るセッションが衝突解消を試みればよい)。
    counts.keptConflicts += 1;
    log(`${taskId}: 衝突解消待ちの worktree を保持した(再開後の試行で解消される) (${worktree})`);
    return;
  }

  // セッションが取りこぼした .agent/ の更新をブランチ側で拾ってからマージする
  if (worktreeExists) commitAgentDir(undefined, worktree);

  const task = loadTaskIn(root, taskId);
  const outcome = mergeAgentBranch(root, branch, taskId, task?.title ?? taskId, AGENT_COMMIT_TRAILER);
  log(`${taskId}: ${describeMergeOutcome(outcome)}`);

  if (outcome.result === "blocked") {
    log(`警告: ${taskId} は起動時に回収できなかった。worktree とブランチを残す(次回の起動で再試行する)`);
    return;
  }

  if (outcome.result === "wedged") {
    // このマージ試行自体が main を固まらせた。worktree・ブランチ・タスクファイルには
    // 一切触れず、次回の起動時(recoverStartupIn の巻き戻しステップ)での再評価に委ねる
    log(`error: ${taskId}: ${describeMergeOutcome(outcome)}`);
    return;
  }

  if (outcome.result === "conflict") {
    if (worktreeExists) {
      reproduceMergeConflict(worktree, root);
      const conflictReason = `セッションが中断され、main へのマージが衝突した(${outcome.paths.join(", ")})`;
      counts.keptConflicts += 1;
      recordStartupRecoveryNote(root, config, taskId, {
        reason: conflictReason,
        at,
      });
    } else {
      const conflictReason = `セッションが中断され、main へのマージが衝突した(${outcome.paths.join(", ")})`;
      const parked = parkedBranchNameFor(taskId, now);
      try {
        renameBranch(root, branch, parked);
        counts.parked += 1;
        log(`${taskId}: worktree が無く衝突したためブランチを ${parked} へ退避した`);
        recordStartupRecoveryNote(root, config, taskId, {
          reason: conflictReason,
          at,
          extraLines: [`- コミット済みの成果はブランチ \`${parked}\` に退避した(削除していない)`],
        });
      } catch (err) {
        log(`警告: ${taskId} のブランチ退避に失敗した: ${String(err)}`);
      }
    }
    return;
  }

  // merged / renumbered / nothing-to-merge: 成果は main 側にあるので worktree とブランチを畳む
  const salvage = worktreeExists ? salvageWorktreeDiff(taskId, worktree, now, root) : ({ kind: "none" } as const);
  if (salvage.kind === "failed") {
    log(`警告: ${taskId}: 未コミット差分の退避に失敗したため worktree ${worktree} を残す`);
  } else {
    if (worktreeExists) removeWorktree(root, worktree);
    if (!deleteBranch(root, branch)) log(`警告: ブランチ ${branch} の削除に失敗した`);
  }
  if (outcome.result !== "nothing-to-merge") {
    counts.recoveredMerges += 1;
    log(`${taskId}: 中断していたタスクの成果を回収した`);
  }

  // マージ後のタスクファイルが completed なら、セッションは実質やり切っている。
  // その場合に retries を進めると、完了済みのタスクに失敗の記録が残ってしまう
  // (この判定は recordStartupRecoveryNote 側が持つ)
  recordStartupRecoveryNote(root, config, taskId, {
    reason:
      outcome.result === "nothing-to-merge"
        ? "セッションが中断された(ブランチに成果は残っていなかった)"
        : "セッションが中断された(ブランチの成果は main へ回収済み)",
    at,
    extraLines:
      salvage.kind === "failed"
        ? [
            `- 未コミット差分の退避に失敗したため worktree \`${worktree}\` を残した(中の差分を回収してから手で削除すること)`,
          ]
        : undefined,
  });

  const leftovers = salvage.kind === "saved" ? salvage : null;
  if (leftovers !== null) {
    const t = loadTaskIn(root, taskId);
    if (t === null) {
      log(`警告: 未コミット差分を記録しようとしたが ${taskId} が見つからない`);
    } else {
      t.body = appendUncommittedDiffRecord(t.body, { at, patchFile: leftovers.patchFile, paths: leftovers.paths });
      saveTaskIn(root, t);
      log(`${taskId}: 未コミット差分を ${leftovers.patchFile} へ退避し試行履歴へ記録した(${leftovers.paths.length} 件)`);
    }
  }
}

/**
 * 起動時の復旧一式(root を明示的に受け取る本体)。対象リポジトリ版は recoverStartup。
 * 手順の順序に意味がある: main のマージを片付けてからでないと agent ブランチのマージは
 * すべて blocked になるため、中断マージの巻き戻しが最初に来る。
 */
export function recoverStartupIn(root: string, config: Config, now: Date = new Date()): StartupRecovery {
  const counts: StartupRecovery = { recoveredMerges: 0, keptConflicts: 0, parked: 0, legacyWorking: 0 };

  // 1. main に残った中断マージ
  abortInterruptedAutoMerge(root);

  // 2〜3. 孤児ブランチの回収。人間のマージが進行中なら main を触らずに見送る
  const handled = new Set<string>();
  if (mergeInProgressSafe(root)) {
    log("警告: main のマージが進行中のため、中断したタスクの回収は次回の起動へ見送る");
  } else {
    try {
      pruneWorktrees(root);
    } catch (err) {
      log(`警告: worktree の prune に失敗した: ${String(err)}`);
    }
    const worktreeDir = config.parallel.worktreeDir;
    const byBranch = agentWorktreesByBranch(root, worktreeDir);
    for (const { branch } of listAgentBranches(root)) {
      // agent/conflict/* は既に人間へ渡した退避ブランチ。自動処理の対象にしない
      if (branch.startsWith("agent/conflict/")) continue;
      const taskId = branch.slice("agent/".length);
      if (taskId === "") continue;
      handled.add(taskId);
      try {
        recoverOrphanBranch(root, config, branch, taskId, worktreeDir, byBranch.get(branch), now, counts);
      } catch (err) {
        log(`警告: ${taskId} の起動時復旧に失敗した: ${String(err)}`);
      }
    }
  }

  // 4. 旧バージョンが status: working のまま残したタスク(現行の Supervisor は working を書かない)
  for (const t of loadTasksIn(root)) {
    if (t.status !== "working" || handled.has(t.id)) continue;
    counts.legacyWorking += 1;
    recordFailure(t, {
      maxRetries: config.maxRetries,
      maxConflictRetries: config.maxConflictRetries,
      reason: "セッション中断から復旧",
      kind: "recovery",
      at: now.toISOString(),
    });
    saveTaskIn(root, t);
    log(`recover: ${t.id} working -> ${t.status} (retries=${t.retries})`);
  }

  // 5. 起動直後に走っているセッションは無いので、前回の残骸は必ず捨てる。あわせて起動時点の
  //    supervisor ソースのハッシュを記録し、稼働中プロセスとソースの乖離を status で検出できるようにする
  //    (変化が無いときに書かないのは、内容を語らない state.json だけのコミットを増やさないため)
  const state = loadStateIn(root);
  let stateChanged = false;
  if (state.runningSessions.length > 0) {
    state.runningSessions = [];
    stateChanged = true;
  }
  const currentSourceHash = supervisorSourceHash();
  if (state.supervisorSourceHash !== currentSourceHash) {
    state.supervisorSourceHash = currentSourceHash;
    stateChanged = true;
  }
  if (stateChanged) saveStateIn(root, state);

  return counts;
}

/** 起動時の復旧を対象リポジトリ本体に対して実行する */
function recoverStartup(config: Config): StartupRecovery {
  return recoverStartupIn(repoPaths().root, config);
}

// ---------- タスク選択 ----------

// ---------- 失敗時の知見引き継ぎ ----------

/** タスク失敗の種別。試行履歴への定型文・見出し表記を出し分けるために使う */
type FailureKind = "timeout" | "crash" | "no-status-update" | "merge-conflict" | "recovery" | "max-turns";

const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
  timeout: "タイムアウト",
  crash: "異常終了",
  "no-status-update": "status 未更新",
  "merge-conflict": "マージ衝突",
  recovery: "中断復旧",
  "max-turns": "ターン上限",
};

const RESUME_INTERRUPTED_NOTE =
  "セッションは終了処理を実行できていない。作業がコミット済み・未コミットのまま残っている可能性がある。" +
  "`git log --oneline -10` と `git status` で現状を確認してから再開すること";

const FAILURE_KIND_ADVICE: Record<FailureKind, string> = {
  timeout: RESUME_INTERRUPTED_NOTE,
  crash: RESUME_INTERRUPTED_NOTE,
  recovery: RESUME_INTERRUPTED_NOTE,
  "no-status-update":
    "セッションは正常終了したが status を更新しなかった。本文と作業ツリーに進捗が残っていないか確認すること",
  "merge-conflict":
    "このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。" +
    "`git status` で衝突ファイルを確認し、解消してコミットすることから始めること",
  "max-turns":
    `セッションはターン数の上限に達して打ち切られた。${RESUME_INTERRUPTED_NOTE}。` +
    "同じ失敗が続く場合はタスクの範囲が 1 セッションに対して大きすぎる可能性があるので、分割を検討すること",
};

const ATTEMPT_HISTORY_HEADING = "## 試行履歴";

/** FAILURE_KIND_LABEL の値からキーを引く逆引き表(ラベル定義を二重管理しないため機械的に導出する) */
const FAILURE_KIND_BY_LABEL: Record<string, FailureKind> = Object.fromEntries(
  (Object.entries(FAILURE_KIND_LABEL) as [FailureKind, string][]).map(([kind, label]) => [label, kind]),
);

/** `### 試行 N(...)` 見出し行から `ccloop 記録: <ラベル>` のラベル部分だけを取り出す */
const ATTEMPT_HEADING_KIND_PATTERN = /^### 試行 .*ccloop 記録: ([^)]*)\)/;

/**
 * タスク本文の「## 試行履歴」に記録された、直前の試行の失敗種別を復元する(純関数)。
 * タスクの frontmatter には失敗種別が保存されていないため、appendAttemptRecord が残す
 * `### 試行 N(<ISO 時刻>, ccloop 記録: <ラベル>)` 見出しから逆引きする。
 * `### 未コミット差分(...)` など他の見出しは対象にせず、`### 試行 ` 見出しのうち最後のものだけを見る。
 * 該当する見出しが無い、またはラベルが未知の場合は null を返す。
 */
export function lastAttemptFailureKind(body: string): FailureKind | null {
  const headings = body
    .split("\n")
    .filter((line) => line.startsWith("### 試行 "));
  const lastHeading = headings.at(-1);
  if (lastHeading === undefined) return null;

  const match = lastHeading.match(ATTEMPT_HEADING_KIND_PATTERN);
  if (match === null) return null;

  return FAILURE_KIND_BY_LABEL[match[1]] ?? null;
}

/**
 * 「1 セッションに対して作業量が多すぎた」ことを示す失敗種別と、再試行コンテキストの本文で使う
 * その呼び名(FAILURE_KIND_LABEL とは別に、文中で読みやすい表現を持たせる)。
 * timeout と max-turns は、いずれもセッションが与えられた持ち時間・ターン数を使い切って
 * 打ち切られた失敗であり、再試行しても上限は増えない点で共通する。この表に載っている種別のときだけ
 * タスク分割を促す文言を出す(載っていない種別は undefined になり、従来どおりの文面になる)。
 */
const OVERSIZED_FAILURE_KIND_PHRASE: Partial<Record<FailureKind, string>> = {
  timeout: "時間切れ(タイムアウト)",
  "max-turns": "ターン数の上限による打ち切り",
};

/**
 * タスク本文の末尾に「## 試行履歴」セクションへ 1 試行分のエントリを追記する(純関数)。
 * 見出しが本文に無ければ見出しごと追加し、既にあればエントリのみ追加する。
 * この記録は機械的検出(timeout/crash/no-status-update/recovery)であり、失敗原因の分析ではない。
 */
export function appendAttemptRecord(
  body: string,
  rec: { attempt: number; at: string; kind: FailureKind; reason: string },
): string {
  const entry = [
    `### 試行 ${rec.attempt}(${rec.at}, ccloop 記録: ${FAILURE_KIND_LABEL[rec.kind]})`,
    "",
    `- 結果: ${rec.reason}`,
    `- ${FAILURE_KIND_ADVICE[rec.kind]}`,
    "- この記録は機械的検出のみで、失敗原因の分析ではない",
  ].join("\n");

  const trimmedBody = body.trim();
  const hasHeading = trimmedBody
    .split("\n")
    .some((line) => line === ATTEMPT_HISTORY_HEADING);
  if (hasHeading) {
    return `${trimmedBody}\n\n${entry}`;
  }
  const prefix = trimmedBody === "" ? "" : `${trimmedBody}\n\n`;
  return `${prefix}${ATTEMPT_HISTORY_HEADING}\n\n${entry}`;
}

/** appendUncommittedDiffRecord で列挙するパスの上限。超えた分は件数のみ末尾に付記する */
const UNCOMMITTED_DIFF_PATHS_LIMIT = 20;

/** rec.paths を「先頭 N 件を列挙し、残りは件数だけ付記する」形に整形する */
function formatDiffPathList(paths: string[]): string {
  const shown = paths.slice(0, UNCOMMITTED_DIFF_PATHS_LIMIT);
  const rest = paths.length - shown.length;
  return shown.map((p) => `\`${p}\``).join(", ") + (rest > 0 ? `, ほか ${rest} 件` : "");
}

/**
 * タスク本文の末尾に「## 試行履歴」セクションへ、セッションがコミットせずに残した差分を
 * パッチへ退避した記録を追記する(純関数)。appendAttemptRecord と同じパターンを踏襲するが、
 * 失敗の試行記録ではなく retries/status を変えないため「### 試行 N」ではない別見出し
 * (### 未コミット差分(...))を使う。paths が空なら body をそのまま返す。
 *
 * タスクセッションは worktree 上で動き、worktree は終了後に削除されるため、退避しなければ
 * 差分は失われる。patchFile は退避先の絶対パスで渡す(退避先はリポジトリの外にある)。
 */
export function appendUncommittedDiffRecord(
  body: string,
  rec: { at: string; patchFile: string; paths: string[] },
): string {
  if (rec.paths.length === 0) return body;

  const entry = [
    `### 未コミット差分(${rec.at}, ccloop 記録)`,
    "",
    `- このセッションが \`.agent/\` 以外にコミットせず残した差分をパッチへ退避した: ${formatDiffPathList(rec.paths)}`,
    `- 退避先: \`${rec.patchFile}\`。作業していた worktree は削除済みのため、差分はこのパッチにしか残っていない`,
    `- 復元するには \`git apply ${rec.patchFile}\` を実行する。検証もコミットもされていないので、内容を確認し、妥当なら検証を通してからコミット、不要ならパッチごと破棄すること`,
    "- この記録は機械的検出のみで、差分の妥当性は判断していない",
  ].join("\n");

  const trimmedBody = body.trim();
  const hasHeading = trimmedBody
    .split("\n")
    .some((line) => line === ATTEMPT_HISTORY_HEADING);
  if (hasHeading) {
    return `${trimmedBody}\n\n${entry}`;
  }
  const prefix = trimmedBody === "" ? "" : `${trimmedBody}\n\n`;
  return `${prefix}${ATTEMPT_HISTORY_HEADING}\n\n${entry}`;
}

/**
 * タスク失敗 1 回分の状態遷移を行う(破壊的更新、保存はしない)。
 * kind === "merge-conflict" のときは conflictRetries を、それ以外は retries を増やし、
 * それぞれ独立の上限(maxConflictRetries / maxRetries)で ready/failed の遷移と note を決める。
 * マージ衝突はタスクの中身の失敗ではないため、本来のやり直し回数(retries)を消費させない
 * ための別枠。
 * body の「## 試行履歴」へ機械的な記録(appendAttemptRecord)を追記する。エントリ番号
 * (attempt)は retries + conflictRetries の合計を使い、両枠を跨いでも通し番号が巻き戻らない
 * ようにする。
 * recoverWorkingTasks(kind: "recovery")と finishTaskSession の fail
 * (kind: timeout/crash/no-status-update/merge-conflict)の両方から呼ばれ、
 * 前 note の保存(元: ...)を共通化する。
 */
export function recordFailure(
  t: Task,
  opts: { maxRetries: number; maxConflictRetries: number; reason: string; kind: FailureKind; at: string },
): void {
  const { maxRetries, maxConflictRetries, reason, kind, at } = opts;
  const prevNote = t.note === undefined ? "-" : truncateNote(t.note);

  if (kind === "merge-conflict") {
    t.conflictRetries += 1;
    if (t.conflictRetries >= maxConflictRetries) {
      t.status = "failed";
      t.note = `マージ衝突が上限(${maxConflictRetries})に達した。最後の失敗: ${reason}(元: ${prevNote})`;
    } else {
      t.status = "ready";
      t.note =
        `マージ衝突が続くため ready に戻す(${t.conflictRetries}/${maxConflictRetries})。` +
        `理由: ${reason}(元: ${prevNote})`;
    }
  } else {
    t.retries += 1;
    if (t.retries >= maxRetries) {
      t.status = "failed";
      t.note = `失敗回数が上限(${maxRetries})に達した。最後の失敗: ${reason}(元: ${prevNote})`;
    } else {
      t.status = "ready";
      t.note = `失敗のため ready に戻す(${t.retries}/${maxRetries})。理由: ${reason}(元: ${prevNote})`;
    }
  }

  t.body = appendAttemptRecord(t.body, { attempt: t.retries + t.conflictRetries, at, kind, reason });
}

/**
 * 依存タスクが充足しているか(completed または依存先が存在しない)。
 * 依存先が見つからない場合を満たされている扱いにするのは、完了タスクが archive へ
 * 移動して現役一覧から消えるため。実在しない依存(打ち間違い等)の検出は
 * `findMissingDependencies` が担い、`ccloop status` の要対応に出す。
 */
export function depSatisfied(byId: Map<string, Task>, depId: string): boolean {
  const dep = byId.get(depId);
  return dep === undefined || dep.status === "completed";
}

/**
 * 存在しない依存(現役の `.agent/tasks/` にも `.agent/archive/tasks/` にも無い ID)を持つタスクを返す。
 * knownIds には両方の ID を渡すこと。completed なタスクの依存は今さら意味がないため対象外にする。
 */
export function findMissingDependencies(
  tasks: Task[],
  knownIds: ReadonlySet<string>,
): { task: Task; missing: string[] }[] {
  const result: { task: Task; missing: string[] }[] = [];
  for (const t of tasks) {
    if (t.status === "completed") continue;
    const missing = t.dependencies.filter((d) => !knownIds.has(d));
    if (missing.length > 0) result.push({ task: t, missing });
  }
  return result;
}

/** runnable なタスクの並び順(優先度昇順 → 作成日時昇順) */
export function byPriorityThenCreatedAt(a: Task, b: Task): number {
  return a.priority - b.priority || a.createdAt.localeCompare(b.createdAt);
}

/**
 * now 時点でスヌーズ中か。snoozeUntil が未設定・解釈不能なら false(選択対象に残す)。
 * 誤記で恒久的にタスクが隠れるのを避けるため、パース失敗は「スヌーズなし」に倒す。
 */
export function isSnoozed(t: Task, now: Date): boolean {
  if (t.snoozeUntil === undefined) return false;
  const until = Date.parse(t.snoozeUntil);
  if (Number.isNaN(until)) return false;
  return until > now.getTime();
}

/**
 * タスク選定の判断(純粋)。blocked へ落とすべきタスクと、次に実行すべきタスクを返す。
 *
 * 入力 tasks はミューテートせず、その代わりに effectiveStatus というローカルな実効ステータスを
 * 使って多段カスケード(X(failed) → A(ready, dep X) → B(ready, dep A) が 1 回の呼び出しで
 * 両方 blocked になる挙動)を再現する。走査は tasks の配列順(= ファイル名 ID 順)で 1 パスのみ
 * のため、依存先が配列順で後方にあるタスクを指す場合は 1 回で伝播しない(旧実装と同じ制約)。
 *
 * スヌーズ中(isSnoozed(t, now))のタスクは runnable から除外する。ただし toBlock の判定は
 * スヌーズの有無にかかわらず従来どおり行う(依存が failed/blocked なのは待っても直らないため)。
 *
 * runningIds は今まさにセッションが走っているタスクの ID。実行中はタスクファイルの status が
 * ready のまま(working は書かれない)なので、二重起動を防ぐにはここで除外する必要がある。
 * 実行中タスクを依存に持つタスクは、依存が completed でない以上そのまま runnable にならない。
 */
export function planTaskSelection(
  tasks: Task[],
  now: Date = new Date(),
  runningIds: ReadonlySet<string> = new Set(),
): {
  /** 依存タスクが failed/blocked のため blocked へ落とすべき ready タスクと、その原因の依存 ID */
  toBlock: { task: Task; deadDep: string }[];
  /** 実行可能なタスクを優先度順に並べたもの。toBlock 対象・スヌーズ中・実行中のタスクは除外済み */
  runnable: Task[];
  /** 次に実行可能なタスク(なければ null)= runnable の先頭 */
  next: Task | null;
  /** ready・依存充足・未実行だが、スヌーズ中のため runnable から外れているタスク
   * (時間が来れば runnable に戻るため、run モードの自動終了判定で使う) */
  snoozed: Task[];
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const effectiveStatus = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));
  const toBlock: { task: Task; deadDep: string }[] = [];
  const blockedIds = new Set<string>();
  for (const t of tasks) {
    if (t.status !== "ready") continue;
    const deadDep = t.dependencies.find((d) => {
      const depStatus = effectiveStatus.get(d);
      return depStatus === "failed" || depStatus === "blocked";
    });
    if (deadDep !== undefined) {
      toBlock.push({ task: t, deadDep });
      blockedIds.add(t.id);
      effectiveStatus.set(t.id, "blocked");
    }
  }

  const selectable = (t: Task): boolean =>
    t.status === "ready" &&
    !blockedIds.has(t.id) &&
    !runningIds.has(t.id) &&
    t.dependencies.every((d) => depSatisfied(byId, d));

  const runnable = tasks.filter((t) => selectable(t) && !isSnoozed(t, now));
  runnable.sort(byPriorityThenCreatedAt);
  const snoozed = tasks.filter((t) => selectable(t) && isSnoozed(t, now));
  return { toBlock, runnable, next: runnable[0] ?? null, snoozed };
}

/**
 * 依存が failed/blocked のタスクを blocked へ落とし(副作用)、実行可能なタスクを優先度順に返す。
 * mainLoop は空きスロット数だけ先頭から取るため、1 件ではなく一覧を返す。
 * snoozedCount は run モードの自動終了判定(pendingSnoozeCount)にそのまま使う。
 */
function selectRunnable(): { runnable: Task[]; snoozedCount: number } {
  const runningIds = new Set(
    loadState()
      .runningSessions.map((s) => s.taskId)
      .filter((id): id is string => id !== undefined),
  );
  const { toBlock, runnable, snoozed } = planTaskSelection(loadTasks(), new Date(), runningIds);
  for (const { task: t, deadDep } of toBlock) {
    t.status = "blocked";
    t.note = `依存タスク ${deadDep} が failed/blocked のため blocked`;
    saveTask(t);
    log(`block: ${t.id} (依存 ${deadDep})`);
  }
  return { runnable, snoozedCount: snoozed.length };
}

/**
 * clean 停止中に例外的に起動してよい「衝突解消待ち」タスクを選ぶ判断(純粋)。
 *
 * 通常の選定(selectRunnable)はタスクファイルを書き換える副作用(依存 dead の blocked 落ち)を
 * 持つため、停止処理中には使えない。ここでは planTaskSelection の純粋な選定結果だけを使い、
 * 「worktree にマージが残っている(hasConflict)」かつ「この停止指示の後にまだ起動していない
 * (launchedIds に無い)」タスクを優先度順に返す。
 *
 * スヌーズ中のタスクも対象に含める。スヌーズが無視されるのはこの停止直前の経路だけで、
 * 通常周回の選定(planTaskSelection)はスヌーズを尊重する。無視は「タスクごとに停止指示後
 * 1 回まで」の上限つきであり、無条件に空振りを繰り返す構造にはならない。
 * 衝突解消セッションの仕事(マーカーの解消・検証・コミット)はスヌーズが待っている人間の
 * 入力とは独立に進められるため空振りにあたらない。MERGE_HEAD 付きの worktree を残したまま
 * プロセスを終えないことを優先する。
 */
export function planConflictResume(opts: {
  tasks: Task[];
  now: Date;
  runningIds: Set<string>;
  launchedIds: Set<string>;
  hasConflict: (taskId: string) => boolean;
}): Task[] {
  const { runnable, snoozed } = planTaskSelection(opts.tasks, opts.now, opts.runningIds);
  return [...runnable, ...snoozed]
    .filter((t) => !opts.launchedIds.has(t.id) && opts.hasConflict(t.id))
    .sort(byPriorityThenCreatedAt);
}

/** planConflictResume を実際のファイル・worktree の状態へ配線したもの(副作用なし) */
function selectConflictResumable(config: Config, launchedIds: Set<string>): Task[] {
  const runningIds = new Set(
    loadState()
      .runningSessions.map((s) => s.taskId)
      .filter((id): id is string => id !== undefined),
  );
  return planConflictResume({
    tasks: loadTasks(),
    now: new Date(),
    runningIds,
    launchedIds,
    hasConflict: (taskId) => {
      const worktree = worktreePathFor(config.parallel.worktreeDir, taskId);
      return fs.existsSync(worktree) && worktreeConflictPending(worktree);
    },
  });
}

/**
 * 探索プロンプトへ注入する、走行中タスクセッションの要約(id・title)。
 * drain を廃止したため、探索は他のタスクセッションと並走しうる。タイトルはタスクファイルから
 * 引く(見つからなければ id をそのまま使う)。
 */
function runningTaskSummaries(state: State): { id: string; title: string }[] {
  const byId = new Map(loadTasks().map((t) => [t.id, t]));
  const runningTaskIds = state.runningSessions
    .filter((s) => s.kind === "task")
    .map((s) => s.taskId)
    .filter((id): id is string => id !== undefined);
  return runningTaskIds.map((id) => ({ id, title: byId.get(id)?.title ?? id }));
}

// ---------- Claude Code の起動 ----------

export interface SessionResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * runClaude の起動引数を組み立てる(単体テストで確認できるよう runClaude 本体から切り出したもの。
 * buildSessionMetrics/recordMetrics と同じ「組み立てはテスト可能な純粋関数、実行は IO 側」の分担)。
 * extraArgs は共通オプション(--max-turns を含む)の後ろに差し込む。claude CLI は commander
 * ベースで重複フラグは最後の指定が勝つため、この順序なら extraArgs 側で共通オプションを
 * 上書きできる(例: triage セッションの `--max-turns 6` で config.maxTurns の既定値を狭める)。
 * タスクセッションの `--worktree <タスクID>` のように、セッション種別ごとに違うオプションを
 * 渡すためにも使う(こちらは上書きではなく追加)。
 */
export interface ClaudeArgsOptions {
  /**
   * 共通ルール(生成済み system prompt)を注入するか。既定は true。
   * triage セッションだけ false にする(後述)。
   */
  commonRules?: boolean;
}

export function buildClaudeArgs(
  config: Config,
  prompt: string,
  model: string,
  extraArgs: string[] = [],
  opts: ClaudeArgsOptions = {},
): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--model",
    model,
    "--permission-mode",
    config.permissionMode,
    // 自律実行専用の permissions / hooks(対話セッションには影響させない)
    "--settings",
    repoPaths().generatedSettingsPath,
  ];
  if (opts.commonRules !== false) {
    // 共通ルールは `-p` の本文ではなく system prompt へ置く(lib/prompt.ts の説明を参照)。
    // ファイルはセッションを 1 本起動するたびに再生成される(runClaude 冒頭の
    // refreshGeneratedSessionInputs を参照)。
    args.push("--append-system-prompt-file", repoPaths().generatedSystemPromptPath);
    // サブエージェント(reviewer 等)は利用側の `.claude/agents/` ではなくツール本体が持つ
    args.push(...agentsArgs());
  }
  if (config.maxTurns > 0) args.push("--max-turns", String(config.maxTurns));
  args.push(...extraArgs);
  return args;
}

/**
 * セッションを 1 本起動するたびに、生成物(settings / system prompt)を組み立て直す。
 *
 * 利用側が `.agent/claude-settings.json` へ追記した権限や `.agent/PROMPT.local.md` の編集が、
 * `ccloop run` を再起動しなくても次のセッションから効くようにするため(README / lib/prompt/PROMPT.md
 * が約束している挙動)。`mainLoop` 起動時の 1 回だけでは、ループを動かしたまま利用側が追記しても
 * 反映されない。
 *
 * 失敗しても起動自体は止めない(例外を投げない)。再生成できなかったファイルは直前に生成済みの
 * 内容のままセッションへ渡す(settings と system prompt は個別に書き出すため、片方だけが
 * 新しくなることもある)。
 */
export function refreshGeneratedSessionInputs(paths: Paths = repoPaths()): void {
  try {
    generateSettings(paths);
    generateSystemPrompt(paths);
  } catch (err) {
    log(`警告: settings / system prompt の再生成に失敗したため、前回生成した内容のままセッションを起動する: ${String(err)}`);
  }
}

/**
 * claude を 1 回起動する。引数の組み立ては buildClaudeArgs を参照。
 * env は CLAUDE_AGENT_AUTONOMOUS に追加する環境変数(hook がセッション種別を判別するために使う)。
 *
 * 子プロセスの異常(実行ファイルが無い等)は error イベント経由で resolve するが、spawn 自体の
 * 同期 throw(オプション不正など)は executor の外へ出て Promise の reject になる。**呼び出し元は
 * 必ず reject に備えること**(crashResultFromError でクラッシュ結果へ変換する)。備えを忘れると
 * 未捕捉例外になり、セッション 1 件の起動失敗で ccloop run プロセス全体が落ちる。
 */
function runClaude(
  config: Config,
  prompt: string,
  model: string,
  cwd: string,
  opts: { extraArgs?: string[]; env?: Record<string, string>; commonRules?: boolean } = {},
): Promise<SessionResult> {
  refreshGeneratedSessionInputs();
  const args = buildClaudeArgs(config, prompt, model, opts.extraArgs ?? [], { commonRules: opts.commonRules });

  return new Promise((resolve) => {
    const child = spawn(config.claudeCommand, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // CCLOOP_HOME は生成 settings の hooks コマンド(`node "$CCLOOP_HOME/hooks/*.ts"`)が
      // sh で展開する。ccloop はリポジトリ外にあるため、子プロセスへ明示的に渡す必要がある
      env: {
        ...process.env,
        CLAUDE_AGENT_AUTONOMOUS: "1",
        CCLOOP_HOME: ccloopHome(),
        CCLOOP_REPO: repoPaths().root,
        ...opts.env,
      },
    });
    const pid = child.pid;
    if (pid !== undefined) childPids.add(pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    // SIGTERM の猶予後に SIGKILL する二段構え。子が SIGTERM に応じて終了した場合は
    // settle() で解除する(解除しないと、その pid が別プロセスに再利用されていたとき
    // 無関係なプロセスグループを撃つ)。
    let forceKillTimer: NodeJS.Timeout | undefined;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
      forceKillTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 10_000);
      forceKillTimer.unref();
    }, config.taskTimeoutMs);

    /**
     * 子の終了を 1 か所で受ける。緊急停止中は結果を resolve せず(= マージ・タスク状態の
     * 更新をさせず)、ブランチと worktree を残して次回に任せる。全ての子が落ちた時点で
     * Supervisor 自身を終了させる。
     */
    const settle = (result: SessionResult): void => {
      if (pid !== undefined) childPids.delete(pid);
      clearTimeout(killTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (shuttingDown) {
        if (childPids.size === 0) exitWhenSafe();
        return;
      }
      resolve(result);
    };

    child.on("close", (code) => settle({ exitCode: code, timedOut, stdout, stderr }));
    child.on("error", (err) => {
      settle({ exitCode: null, timedOut, stdout, stderr: stderr + "\n" + String(err) });
    });
  });
}

// ---------- セッション結果の解析・記録 ----------

/** claude -p --output-format json の結果 JSON をベストエフォートで取り出す */
function parseResultJson(res: SessionResult): Record<string, unknown> | null {
  try {
    return JSON.parse(res.stdout) as Record<string, unknown>;
  } catch {}
  const line = res.stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .pop();
  if (line !== undefined) {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {}
  }
  return null;
}

/**
 * 結果 JSON からセッション ID を取り出す。ログの中身はこの ID を使って
 * transcript から確認する(README「セッションログを追う」参照)。タイムアウト・起動失敗などで
 * 結果 JSON が得られなかった場合は "不明"。
 */
function sessionId(res: SessionResult): string {
  const id = parseResultJson(res)?.session_id;
  return typeof id === "string" && id !== "" ? id : "不明";
}

/** 異常終了の手がかりとして stderr の最終行を 1 行に詰めて返す(なければ空文字) */
function stderrTail(res: SessionResult): string {
  const line = res.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  if (line === undefined) return "";
  const chars = Array.from(line);
  return `: ${chars.slice(0, 200).join("")}${chars.length > 200 ? "…" : ""}`;
}

/**
 * 結果 JSON が「エラーとして終わったセッション」を示しているか。is_error !== true なら null を返す。
 * is_error: true のときは subtype(無ければ terminal_reason、どちらも無ければ "unknown")を返す。
 * is_error: true であること自体は失敗として扱うため、この場合は必ず非 null を返す。
 * レートリミットも is_error: true な結果を返すことがあるため、呼び出し側では
 * isSessionRateLimited を先に判定してから使うこと。
 */
function sessionErrorSubtype(res: SessionResult): string | null {
  const json = parseResultJson(res);
  if (json === null || json.is_error !== true) return null;
  if (typeof json.subtype === "string") return json.subtype;
  if (typeof json.terminal_reason === "string") return json.terminal_reason;
  return "unknown";
}

/** 結果 JSON がターン数上限による打ち切り(`subtype: error_max_turns` / `terminal_reason: max_turns`)を示しているか */
function isMaxTurnsError(res: SessionResult): boolean {
  const json = parseResultJson(res);
  if (json === null) return false;
  return json.subtype === "error_max_turns" || json.terminal_reason === "max_turns";
}

// ---------- permission deny ルールとの照合 ----------
//
// CLI の結果 JSON(permission_denials)には拒否理由・ルール名が含まれない(実測確認済み)ため、
// ここで自前に tool_name / tool_input と permissions.deny を照合する。

/** "Bash(git push*)" → { tool: "Bash", pattern: "git push*" }。括弧なしはツール全体の deny として pattern: null */
function parsePermissionRule(rule: string): { tool: string; pattern: string | null } {
  const m = rule.match(/^([^(]+)\((.*)\)$/);
  if (m === null) return { tool: rule, pattern: null };
  return { tool: m[1], pattern: m[2] };
}

/** deny パターンの `**`(任意)/ `*`(スラッシュ以外任意)を簡易グロブとして正規表現化する */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${body}$`);
}

/** パス系パターンを絶対パスに解決する。`//` = 絶対パス、`~/` = ホーム基準、`./` / 裸 = root 基準 */
function resolvePatternPath(pattern: string, root: string): string {
  if (pattern.startsWith("//")) return pattern.slice(1);
  if (pattern.startsWith("~/")) return path.join(os.homedir(), pattern.slice(2));
  if (pattern.startsWith("./")) return path.join(root, pattern.slice(2));
  return path.join(root, pattern);
}

/**
 * permission_denials の 1 件が deny ルール文字列に一致するか判定する。
 * ツール名不一致・tool_input に対象フィールドが無い・パターン解析不能など判別できない場合は
 * すべて false(=一致なし=記録する側)に倒す。完全互換は狙わず、Bash のコマンド前方一致/完全一致と
 * Read 等パス系ツールの簡易グロブが判定できれば十分とする。
 */
export function denialMatchesRule(denial: Record<string, unknown>, rule: string, root: string): boolean {
  const { tool, pattern } = parsePermissionRule(rule);
  if (denial.tool_name !== tool) return false;
  if (pattern === null) return true;

  const toolInput = denial.tool_input;
  if (typeof toolInput !== "object" || toolInput === null) return false;
  const input = toolInput as Record<string, unknown>;

  if (tool === "Bash") {
    const command = input.command;
    if (typeof command !== "string") return false;
    return pattern.endsWith("*") ? command.startsWith(pattern.slice(0, -1)) : command === pattern;
  }

  // Read 等パス系ツール: file_path をパターンから解決した絶対パスの簡易グロブで判定
  const filePath = input.file_path;
  if (typeof filePath !== "string") return false;
  return globToRegExp(resolvePatternPath(pattern, root)).test(filePath);
}

/** denials のうち deny ルールに一致する分を除外する。ルールが空なら全件そのまま kept */
export function partitionDeniedByRules(
  denials: Record<string, unknown>[],
  denyRules: string[],
  root: string,
): { kept: Record<string, unknown>[]; excludedCount: number } {
  const kept = denials.filter((d) => !denyRules.some((rule) => denialMatchesRule(d, rule, root)));
  return { kept, excludedCount: denials.length - kept.length };
}

/** claude-settings.json から permissions.deny を読む。欠落・パース不能・型不正なら警告ログのうえ空配列(=フィルタなし) */
export function loadDenyRules(settingsPath: string = repoPaths().generatedSettingsPath): string[] {
  let settings: { permissions?: { deny?: unknown } };
  try {
    settings = readJson<{ permissions?: { deny?: unknown } }>(settingsPath);
  } catch (err) {
    log(`${settingsPath} の読み込みに失敗したため permissions.deny フィルタなしで続行: ${String(err)}`);
    return [];
  }
  const deny = settings.permissions?.deny;
  if (!Array.isArray(deny) || !deny.every((d) => typeof d === "string")) {
    log(`${settingsPath} の permissions.deny が不正な形式のため permissions.deny フィルタなしで続行`);
    return [];
  }
  return deny;
}

/** permission-denials.jsonl の 1 行(1 件の拒否)。追記型ログのレコード形式 */
export interface PermissionDenialRecord {
  timestamp: string;
  session: string;
  tool: string;
  /** Bash の場合のみ: tool_input.command を 300 文字で切ったもの */
  command?: string;
  /** command を持たないツール: tool_input 全体を JSON.stringify して 300 文字で切ったもの */
  input?: string;
}

/**
 * permission 拒否(auto モードで「人間の判断が必要」となった操作)の発生の事実を観測用ログへ記録する。
 * 人間のアクション(回答・クローズ)は要求しない。permissions.deny に一致する拒否は人間が既に
 * 禁止と決めたものなので記録しない(ログに 1 行残すのみ)。
 */
export function recordPermissionDenials(
  sessionLabel: string,
  res: SessionResult,
  sessionRoot: string,
  stateDir: string = repoPaths().stateDir,
  settingsPath: string = repoPaths().generatedSettingsPath,
): void {
  const json = parseResultJson(res);
  const denials = json?.permission_denials;
  if (!Array.isArray(denials) || denials.length === 0) return;

  const denyRules = loadDenyRules(settingsPath);
  const { kept, excludedCount } = partitionDeniedByRules(
    denials as Record<string, unknown>[],
    denyRules,
    sessionRoot,
  );
  if (excludedCount > 0) {
    log(`permission 拒否 ${excludedCount} 件は permissions.deny に一致するため記録しない (${sessionLabel})`);
  }
  if (kept.length === 0) return;

  const timestamp = new Date().toISOString();
  const text =
    kept
      .map((d: Record<string, unknown>) => {
        const tool = String(d.tool_name ?? "?");
        const toolInput = d.tool_input;
        const record: PermissionDenialRecord = { timestamp, session: sessionLabel, tool };
        const command =
          tool === "Bash" && typeof toolInput === "object" && toolInput !== null
            ? (toolInput as Record<string, unknown>).command
            : undefined;
        if (typeof command === "string") {
          record.command = command.slice(0, 300);
        } else {
          record.input = JSON.stringify(toolInput ?? {}).slice(0, 300);
        }
        return JSON.stringify(record);
      })
      .join("\n") + "\n";

  // ログのローテーション・prune は実装しない(年 1MB 未満の見込みで metrics.jsonl と同じ無制限運用)
  try {
    fs.appendFileSync(permissionDenialsPathOf(stateDir), text);
  } catch (err) {
    log(`警告: permission 拒否ログの記録に失敗した: ${String(err)}`);
  }
}

// ---------- メトリクス記録 ----------

/** claude 実行 1 回分のコスト・トークン計測。結果 JSON に無いフィールドは記録しない(CLI バージョン差異への防御) */
interface SessionMetrics {
  timestamp: string;
  kind: "task" | "explore" | "triage";
  taskId?: string;
  model: string;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  /** メインセッションのみの累計(サブエージェントを含まない)。costUsd はサブエージェントを含む合計であり集計範囲が異なる点に注意 */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  subtype?: string;
  isError?: boolean;
  /** タイムアウトによる強制 kill・結果 JSON のパース不能など、空セッションの原因切り分け用 */
  abnormal?: string;
  /** レートリミット到達によるセッション(成功扱いの is_error: true・cost 0 と区別するためのフラグ) */
  rateLimited?: boolean;
  /** セッション中に起動されたサブエージェント数(transcript の subagents/*.meta.json の件数) */
  subagentCount?: number;
  /** spawnDepth の最大値。メイン直下は 1、2 以上は多段委譲。0 = サブエージェントなし */
  maxSpawnDepth?: number;
  /** タスクセッションが動いた作業ブランチ名(`agent/<タスクID>`) */
  branch?: string;
  /** タスクセッションが動いた worktree のディレクトリ名(パス全体ではなく basename) */
  worktree?: string;
  /** 終了後の main への統合結果(MergeOutcome の result、またはマージを試みなかった理由) */
  merge?: string;
  /** 衝突したファイルパス(衝突しなかったセッションでは出力しない) */
  conflictPaths?: string[];
  /** 衝突の分類(classifyConflicts の判定結果) */
  conflictKind?: ConflictKind;
}

/** 結果 JSON の usage から数値フィールドのみを安全に取り出す(1 つも取れなければ undefined) */
function extractUsage(rawUsage: unknown): SessionMetrics["usage"] {
  if (rawUsage === null || typeof rawUsage !== "object") return undefined;
  const u = rawUsage as Record<string, unknown>;
  const usage: NonNullable<SessionMetrics["usage"]> = {};
  if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === "number") usage.cacheReadInputTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === "number")
    usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Claude Code が cwd から導出する `~/.claude/projects/` 配下のディレクトリ名 */
export function projectsDirName(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * transcript の `<sessionDir>/subagents/*.meta.json` を集計し、サブエージェント数と
 * spawnDepth の最大値を返す。ディレクトリなし・読めない場合は { subagentCount: 0,
 * maxSpawnDepth: 0 }。個別ファイルが JSON パース不能・spawnDepth 欠落の場合は
 * depth 1 扱いとして件数には含める(観測用のベストエフォート集計であり例外は投げない)。
 */
export function collectSubagentStats(sessionDir: string): { subagentCount: number; maxSpawnDepth: number } {
  const subagentsDir = path.join(sessionDir, "subagents");
  let entries: string[];
  try {
    entries = fs.readdirSync(subagentsDir).filter((f) => f.endsWith(".meta.json"));
  } catch {
    return { subagentCount: 0, maxSpawnDepth: 0 };
  }
  let subagentCount = 0;
  let maxSpawnDepth = 0;
  for (const entry of entries) {
    subagentCount++;
    let depth = 1;
    try {
      const raw = fs.readFileSync(path.join(subagentsDir, entry), "utf8");
      const meta = JSON.parse(raw) as Record<string, unknown>;
      if (typeof meta.spawnDepth === "number") depth = meta.spawnDepth;
    } catch {
      // JSON パース不能・読み取り失敗は depth 1 扱い
    }
    if (depth > maxSpawnDepth) maxSpawnDepth = depth;
  }
  return { subagentCount, maxSpawnDepth };
}

/**
 * セッション終了のたびに呼び、コスト・トークン計測を metrics.jsonl へ 1 行追記する。
 * 結果 JSON が得られない(タイムアウト強制 kill・パース不能)場合も、空セッションの原因を
 * 切り分けられるよう abnormal を付けて記録する。書き込み失敗はメトリクス欠落に留め、
 * supervisor 本体は止めない。
 */
/** recordMetrics から組み立て処理だけを切り出したもの(単体テストで組み立て結果を検証できるようにするため) */
export function buildSessionMetrics(params: {
  kind: "task" | "explore" | "triage";
  taskId?: string;
  model: string;
  res: SessionResult;
  sessionCwd: string;
  branch?: string;
  worktree?: string;
  merge?: string;
  conflictPaths?: string[];
  conflictKind?: ConflictKind;
}): SessionMetrics {
  const { kind, taskId, model, res, sessionCwd, branch, worktree, merge, conflictPaths, conflictKind } = params;
  const json = parseResultJson(res);
  const metrics: SessionMetrics = {
    timestamp: new Date().toISOString(),
    kind,
    model,
  };
  if (taskId !== undefined) metrics.taskId = taskId;
  if (branch !== undefined) metrics.branch = branch;
  if (worktree !== undefined) metrics.worktree = path.basename(worktree);
  if (merge !== undefined) metrics.merge = merge;
  if (conflictPaths !== undefined && conflictPaths.length > 0) metrics.conflictPaths = conflictPaths;
  if (conflictKind !== undefined) metrics.conflictKind = conflictKind;
  if (json !== null) {
    if (typeof json.session_id === "string") metrics.sessionId = json.session_id;
    if (typeof json.total_cost_usd === "number") metrics.costUsd = json.total_cost_usd;
    if (typeof json.num_turns === "number") metrics.numTurns = json.num_turns;
    if (typeof json.duration_ms === "number") metrics.durationMs = json.duration_ms;
    if (typeof json.subtype === "string") metrics.subtype = json.subtype;
    if (typeof json.is_error === "boolean") metrics.isError = json.is_error;
    const usage = extractUsage(json.usage);
    if (usage !== undefined) metrics.usage = usage;
  }
  if (res.timedOut) {
    metrics.abnormal = "タイムアウトによる強制 kill";
  } else if (json === null) {
    metrics.abnormal = "結果 JSON がパース不能";
  }
  if (isSessionRateLimited(res)) metrics.rateLimited = true;
  if (metrics.sessionId !== undefined) {
    const sessionDir = path.join(os.homedir(), ".claude", "projects", projectsDirName(sessionCwd), metrics.sessionId);
    const stats = collectSubagentStats(sessionDir);
    metrics.subagentCount = stats.subagentCount;
    metrics.maxSpawnDepth = stats.maxSpawnDepth;
  }
  return metrics;
}

function recordMetrics(params: {
  kind: "task" | "explore" | "triage";
  taskId?: string;
  model: string;
  res: SessionResult;
  sessionCwd: string;
  branch?: string;
  worktree?: string;
  merge?: string;
  conflictPaths?: string[];
  conflictKind?: ConflictKind;
}): void {
  const metrics = buildSessionMetrics(params);
  try {
    fs.appendFileSync(repoPaths().metricsPath, JSON.stringify(metrics) + "\n");
  } catch (err) {
    log(`警告: メトリクス記録に失敗した: ${String(err)}`);
  }
}

// ---------- レートリミット ----------

/**
 * ベストエフォートのレートリミット検出(誤検出しても待機するだけで壊れない)。
 * 判定自体は ratelimit.ts の detectSessionRateLimit に委譲する(タイムアウト時は
 * stderr のみを見る、という線引きの詳細はそちらのコメントを参照)。
 */
function isSessionRateLimited(res: SessionResult): boolean {
  return detectSessionRateLimit(res);
}

function applyRateLimit(config: Config): void {
  const state = loadState();
  const resumeAt = new Date(Date.now() + config.rateLimit.backoffMs);
  state.rateLimit.resumeAt = resumeAt.toISOString();
  saveState(state);
  log(`rate limit 検出。${resumeAt.toISOString()} まで待機`);
}

/** レートリミット待機状態をリセットする。既に null なら書き込みを省く */
function clearRateLimit(): void {
  const state = loadState();
  if (state.rateLimit.resumeAt === null) return;
  state.rateLimit.resumeAt = null;
  saveState(state);
}

// ---------- セッション実行(タスク / 探索) ----------

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** supervisorSourceHash が対象にする拡張子(ツールの挙動を決めるコードとデータ) */
const SOURCE_HASH_EXTENSIONS = [".ts", ".md", ".json"];

/** dir 配下(再帰)のハッシュ対象ファイルを、dir からの相対パスで列挙する */
function sourceHashFiles(dir: string, prefix = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) files.push(...sourceHashFiles(path.join(dir, e.name), rel));
    else if (
      e.isFile() &&
      SOURCE_HASH_EXTENSIONS.some((ext) => e.name.endsWith(ext)) &&
      !e.name.endsWith(".test.ts")
    ) {
      files.push(rel);
    }
  }
  return files;
}

/**
 * ccloop 自身のインストール先(CCLOOP_HOME = lib/)配下のソース(.ts / .md / .json、
 * ただし .test.ts を除く)から作るハッシュ。稼働中プロセスが run 起動時点のソースから
 * どれだけ乖離しているか(＝再起動しないと変更が反映されない状態か)を検出するために使う。
 * サブディレクトリ(prompt/ の共通ルール、agents/ のサブエージェント定義、hooks/、
 * templates/)も対象にする。これらは起動時に 1 度だけ読まれるため、変更を反映するには
 * 直下のソースと同じく再起動が要るため。
 * ファイルの追加・削除・リネームも検出できるよう、パスも内容に含める。
 */
export function supervisorSourceHash(home: string = ccloopHome()): string {
  if (!fs.existsSync(home)) return "";
  const files = sourceHashFiles(home).sort();
  const combined = files.map((f) => `${f}\0${fs.readFileSync(path.join(home, f), "utf8")}`).join("\0");
  return sha256(combined);
}

/**
 * supervisor のソースが run 起動(記録)時点から変わっているか(純粋)。recorded が未記録
 * (undefined/null, 旧 state.json)なら判定不能として「変化なし」に倒す。
 */
export function isSupervisorSourceStale(recorded: string | null | undefined, current: string): boolean {
  if (recorded === undefined || recorded === null) return false;
  return recorded !== current;
}

/** ccloop 自身(claude-code-loop)のリポジトリを判定するための package.json name */
const CCLOOP_PACKAGE_NAME = "claude-code-loop";

/** selfHostedLibDir が使う fs 依存(テストからフェイクを注入できるようにする) */
export interface SelfHostedLibDirDeps {
  exists(p: string): boolean;
  /** 読めなければ null */
  readFile(p: string): string | null;
}

/**
 * repoRoot が ccloop 自身(claude-code-loop)のリポジトリかどうかを判定し、そうであれば
 * リポジトリ側の lib/ の絶対パスを返す(純粋)。判定できなければ null
 * (package.json が読めない・name が一致しない・lib/supervisor.ts が無い場合を含む、通常の
 * 利用側リポジトリ)。インストール先(ccloopHome())との乖離検出(isInstalledSourceDrifted)に使う。
 */
export function selfHostedLibDir(repoRoot: string, deps: SelfHostedLibDirDeps): string | null {
  const raw = deps.readFile(path.join(repoRoot, "package.json"));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { name?: unknown }).name !== CCLOOP_PACKAGE_NAME) {
    return null;
  }
  const libDir = path.join(repoRoot, "lib");
  if (!deps.exists(path.join(libDir, "supervisor.ts"))) return null;
  return libDir;
}

/**
 * リポジトリの lib/(自己ホスト時のみ)とインストール済み ccloop のソースが乖離しているか(純粋)。
 * isSupervisorSourceStale とは異なり、「run 起動時からの変化」ではなく「リポジトリと
 * インストール先という 2 箇所のソースの不一致」を見る。乖離していれば、リポジトリの lib/ を
 * 変更してもコンテナを再ビルドするまで稼働中の ccloop コマンドには反映されない。
 * 判定不能・比較不能なケースはすべて「乖離なし」に倒す(誤検知で無用な警告を出さないため)。
 */
export function isInstalledSourceDrifted(args: {
  repoLibDir: string | null;
  installedHome: string;
  repoHash: string;
  installedHash: string;
}): boolean {
  const { repoLibDir, installedHome, repoHash, installedHash } = args;
  if (repoLibDir === null) return false;
  if (repoLibDir === installedHome) return false;
  if (repoHash === "" || installedHash === "") return false;
  return repoHash !== installedHash;
}

/**
 * isInstalledSourceDrifted の結果を status 表示行に整形する。drifted が false なら空配列。
 * isSupervisorSourceStale の警告(起動後にソースが変わった)とは別の事象を指すため、文言を
 * 混同しないようにする。
 */
export function installedSourceDriftLines(drifted: boolean): string[] {
  if (!drifted) return [];
  return [
    "  ※ インストール済みの ccloop がこのリポジトリの lib/ と一致していない (docs/architecture.md「インストール済み ccloop とリポジトリ lib/ の乖離検出」参照)",
  ];
}

function readGoal(): string {
  const goalPath = repoPaths().goalPath;
  return fs.existsSync(goalPath) ? fs.readFileSync(goalPath, "utf8") : "";
}

/**
 * 人間からの入力(GOAL.md と Human Review の answered エントリ)のハッシュ。
 * 変化を検出したら triage の起動条件になり、以降の探索セッションの起動理由にもなる
 * (取り込みのためにタスクの起動を止めることはしない)。
 * answered はファイル全文を対象にするため、既存回答の書き換えも変化として検出される。
 */
function hashInputs(): string {
  const answered = parseHumanReview()
    .filter((h) => isAnsweredEntry({ status: h.status, body: h.body }))
    .map((h) => `${h.id}\n${h.raw}`)
    .join("\n");
  return sha256(`${readGoal()}\0${answered}`);
}

/**
 * 人間からの入力が前回取り込み時点から変化したか(純粋)。
 * savedHash が未設定(初回起動・移行直後)なら「変化なし」に倒す。覚えていない過去との比較で
 * 探索を割り込ませても取り込む差分が示せないため。mainLoop と status 表示の両方から使う。
 */
export function isInputsChanged(savedHash: string | null | undefined, currentHash: string): boolean {
  if (savedHash === undefined || savedHash === null) return false;
  return savedHash !== currentHash;
}

/** GOAL.md 単体のハッシュ(探索プロンプトへの差分内訳表示用) */
function currentGoalHash(): string {
  return sha256(readGoal());
}

/** answered な human-review の "<id>:<sha256(raw)>" キー一覧(ソート済み。差分内訳表示用) */
function currentAnsweredKeys(): string[] {
  return parseHumanReview()
    .filter((h) => isAnsweredEntry({ status: h.status, body: h.body }))
    .map((h) => `${h.id}:${sha256(h.raw)}`)
    .sort();
}

/**
 * 前回探索セッション時点の状態(goalHash/answeredKeys)と現在値を比べた差分内訳。
 * 保存済み情報がなければ(移行直後など)該当項目は null(不明)を返す。
 */
export function diffInputs(
  prev: { goalHash?: string | null; answeredKeys?: string[] },
  current: { goalHash: string; answeredKeys: string[] },
): { goalChanged: boolean | null; newAnsweredIds: string[] | null } {
  const goalChanged = prev.goalHash == null ? null : prev.goalHash !== current.goalHash;
  const newAnsweredIds =
    prev.answeredKeys == null
      ? null
      : current.answeredKeys
          .filter((k) => !prev.answeredKeys!.includes(k))
          .map((k) => k.slice(0, k.indexOf(":")));
  return { goalChanged, newAnsweredIds };
}

/** 人間が方向性を記述する GOAL.md(存在すれば全セッションへ注入) */
function goalSection(): string[] {
  const goalPath = repoPaths().goalPath;
  if (!fs.existsSync(goalPath)) return [];
  return ["---", "# 人間が定めた方向性(.agent/GOAL.md)", fs.readFileSync(goalPath, "utf8")];
}

/**
 * 再試行時に注入する「Supervisor による機械的情報」のセクション。
 * 初回試行(retries === 0 かつ conflictRetries === 0)では注入しない
 * (過去の試行がなく伝える情報がないため)。マージ衝突での試行も過去試行の一種なので、
 * 合計(retries + conflictRetries)で初回判定する。
 */
export function retryContextSection(config: Config, task: Task): string[] {
  const totalAttempts = task.retries + task.conflictRetries;
  if (totalAttempts === 0) return [];
  const conflictSuffix =
    task.conflictRetries > 0 ? `、マージ衝突 ${task.conflictRetries} 回(上限 ${config.maxConflictRetries})` : "";

  const lines = [
    "## 再試行コンテキスト(Supervisor による機械的情報)",
    "",
    `- これは ${totalAttempts + 1} 回目の試行(過去 ${task.retries} 回失敗、上限 ${config.maxRetries}${conflictSuffix})`,
    `- 直前の失敗: ${task.note ?? "記録なし"}`,
    "- 上記タスク本文の「## 試行履歴」を読み、前回と同じ戦略の単純リトライは避けること",
    "- ただし試行履歴のうち「未検証の推測」は前回セッションの観察であり誤りうる。git log / git status / " +
      "このリポジトリの検証コマンドで現状を確認し、記録と現状が食い違う場合は現状を優先して方針を決めること",
    "- 前回の作業が既にコミットされている可能性がある。再実装を始める前に必ず git log を確認すること",
  ];

  const lastKind = lastAttemptFailureKind(task.body);
  const phrase = lastKind === null ? undefined : OVERSIZED_FAILURE_KIND_PHRASE[lastKind];
  if (phrase !== undefined) {
    lines.push(
      `- 直前の失敗は${phrase}である。1 セッションの持ち時間・ターン数の上限は再試行しても増えないため、` +
        "同じ範囲を同じやり方でもう一度やれば同じところで打ち切られる。まずこのタスクが 1 セッションに収まる大きさかを見直すこと",
      "- 収まらないと判断したら、最後までやり切ろうとしないこと。1 ラウンド(例: 調査 → 一部の実装 → 機械的検証)で区切り、" +
        "そこまでの成果をコミットし、残りを新しいタスクとして `.agent/tasks/` に登録し、このタスクの `## 試行履歴` に" +
        "到達点と続きの手掛かりを書いてからセッションを終える",
      "- 範囲を絞って終えることは失敗ではない。上限に達して打ち切られるより、確実に前進した分を残すほうが良い",
    );
  }

  return [lines.join("\n")];
}

/** セッション開始時刻とタイムアウトから、強制終了される締め切り時刻(ISO 8601)を計算する */
export function sessionDeadline(startedAtIso: string, timeoutMs: number): string {
  return new Date(Date.parse(startedAtIso) + timeoutMs).toISOString();
}

/**
 * プロンプトへ注入する「セッション開始時刻」「締め切り」の案内行。それぞれ独立に有無を判定し、
 * 渡された分だけ行を組み立てる(片方だけでも壊れない)。
 */
function sessionTimeLines(startedAt: string | undefined, deadline: string | undefined): string[] {
  const lines: string[] = [];
  if (startedAt !== undefined) {
    lines.push(
      `- セッション開始時刻(このセッションの「現在時刻」の基準): ${startedAt}。` +
        "`.agent/` の記録ファイルに書く `createdAt` / `updatedAt` はこの値か、" +
        '`node -e "console.log(new Date().toISOString())"` の実測値を使うこと(丸めた推測値を書かない)',
    );
  }
  if (deadline !== undefined) {
    lines.push(
      `- このセッションの締め切り(この時刻を過ぎると強制終了される): ${deadline}。` +
        '現在時刻は `node -e "console.log(new Date().toISOString())"` で取得できる',
    );
  }
  return lines;
}

/**
 * タスクセッションが動く worktree・ブランチの説明。常時注入する。
 * セッションがブランチを切り替えたり自分でマージしたりすると Supervisor 側の自動統合が
 * 壊れるため、やってよいこと(通常のコミット)とやってはいけないことを明示する。
 */
function worktreeSection(task: Task, times: { startedAt?: string; deadline?: string } = {}): string {
  return [
    "## 実行環境(Supervisor による機械的情報)",
    "",
    `- このセッションは専用ブランチ \`${branchNameFor(task.id)}\` の worktree で動いている(リポジトリ本体とは別ディレクトリ)`,
    "- コミットは通常どおり行う(メッセージは日本語、意味のある単位で)",
    "- ブランチの切替(checkout / switch)・マージ・push はしない。ブランチ操作は Supervisor の担当",
    "- main への統合はセッション終了後に Supervisor が自動で行う",
    ...sessionTimeLines(times.startedAt, times.deadline),
  ].join("\n");
}

/**
 * 前回セッションの成果を main へマージできず、コンフリクトを再現した状態の worktree で
 * 再開する場合に注入するセクション。
 */
function conflictResolutionSection(task: Task): string {
  return [
    "## 衝突解消セッション(Supervisor による機械的情報)",
    "",
    `- 前回の試行の成果は \`${branchNameFor(task.id)}\` に既にコミットされている(作業をやり直す必要はない)`,
    "- この作業ツリーには前回の git 操作(main とのマージなど)が中断されたまま残っている。多くは衝突マーカーを伴うが、必ずしもそうとは限らないため、まず `git status` で実際の中断状態を確認すること",
    "- 衝突があれば解消し、機械的検証(tests / lint / typecheck)を通した上で `git add` → `git commit` で中断された操作を完了させること",
    "- 解消の判断に迷う箇所は main 側を優先する。優先した理由と捨てた変更は `.agent/decisions/` に記録する",
    "- ただし変更履歴(CHANGELOG.md)のような追記専用のファイルは例外で、両側の項目をどちらも残す。同じ箇所への独立した追記であって内容の対立ではないため、片方を捨てる理由が無い。並べる順は main 側を先、ブランチ側を後にする",
    `- このタスク自身のタスクファイル(\`.agent/tasks/${task.id}.md\`)が衝突している場合は、main 側の内容をそのまま土台にし、自分が変えたい frontmatter(status / note)だけを上書きする。末尾の「## 試行履歴」へ自分の記録を書き足すと、ccloop が main 側の同じ位置へ書く機械記録と次のマージでまた衝突する。残したい試行知見はコミットメッセージか \`.agent/decisions/\` に書くこと`,
    "- `.agent/` 配下で同じ ID のファイルが両側にある衝突は、同じ内容を二重に起票した状態(ID は日時 + slug で付けるため偶然は起きない)。内容を 1 つに統合するか、どちらかの ID を付け替えて両方残すこと。これは新規追加同士の衝突であり、どちらの ID もこの時点ではまだ他から参照されていないため付け替えてよい(一度付けた slug を変更しないルールは、参照が発生した後の ID に対するもの)。付け替える場合は重複時の規約と同様に末尾へ `-2` を付ける",
    "- 衝突解消が終わってから、必要なら本来のタスクの続きに取りかかること",
  ].join("\n");
}

/**
 * 全セッションのプロンプト冒頭に置く一行。共通ルール本体(`lib/prompt/PROMPT.md`)は
 * `--append-system-prompt-file` で system prompt として注入済みなので、ここでは
 * 「どこにあるか」だけを伝え、本文は重複させない。
 */
const COMMON_RULES_NOTICE =
  "自律実行セッションの共通ルールは system prompt として注入済み(改めて読み込む必要はない)。" +
  "以下はこのセッション固有の指示である。";

export function buildTaskPrompt(
  config: Config,
  task: Task,
  opts: { resuming?: boolean; startedAt?: string; deadline?: string } = {},
): string {
  return [
    COMMON_RULES_NOTICE,
    ...goalSection(),
    "---",
    `## 担当タスク(.agent/tasks/${task.id}.md)`,
    "```markdown",
    serializeFrontmatter(taskFrontmatter(task), task.body).trimEnd(),
    "```",
    worktreeSection(task, { startedAt: opts.startedAt, deadline: opts.deadline }),
    ...(opts.resuming === true ? [conflictResolutionSection(task)] : []),
    ...retryContextSection(config, task),
    `このタスクを完了させること。終了前に必ず .agent/tasks/${task.id}.md の frontmatter の status を更新すること(実質的な変更がなければファイル自体には触れない)。`,
  ].join("\n\n");
}

/** 探索セッション起動時にわかっている、機械的に検出済みの差分情報(プロンプトへ注入する) */
export interface ExploreContext {
  /** idle: 実行可能タスクが無い / periodic: タスク消化中の定期見直し */
  trigger: "idle" | "periodic";
  /** GOAL.md が前回探索から変化したか。前回情報がなければ null(不明) */
  goalChanged: boolean | null;
  /** 新規に answered になった Human Review の ID。前回情報がなければ null(不明) */
  newAnsweredIds: string[] | null;
  /** この探索と並走しているタスクセッションの一覧(drain を廃止したため空でないことがある) */
  runningTasks: { id: string; title: string }[];
  /** このセッションの開始時刻(ISO 8601)。記録ファイルに書く時刻の実測基準として注入する */
  startedAt?: string;
  /** このセッションの締め切り(ISO 8601)。強制終了までの残り時間の目安として注入する */
  deadline?: string;
}

/** buildExplorePrompt に埋め込む「今回の起動情報」セクション本文 */
function launchInfoSection(ctx: ExploreContext): string {
  const reasonText =
    ctx.trigger === "idle"
      ? "実行可能なタスクがないため(main / 入力の変化を検知)"
      : "タスク消化中の定期見直し(前回探索から一定時間が経過し、main / 入力が変化)";
  const goalText =
    ctx.goalChanged === null
      ? "不明(前回情報なし)"
      : ctx.goalChanged
        ? "前回探索から変化あり"
        : "前回探索から変化なし";
  const answeredText =
    ctx.newAnsweredIds === null
      ? "不明(前回情報なし)"
      : ctx.newAnsweredIds.length === 0
        ? "なし"
        : ctx.newAnsweredIds.join(", ");
  return [
    "### 今回の起動情報(Supervisor による機械的検出)",
    "",
    `- 起動理由: ${reasonText}`,
    `- GOAL.md: ${goalText}`,
    `- 新規に answered になった Human Review: ${answeredText}`,
    ...sessionTimeLines(ctx.startedAt, ctx.deadline),
    "",
    "省略してよいのは「変化なし」と明記された入力の再読だけ。新規 answered の ID が列挙されている",
    "場合、手順1ではそのファイルだけを読めばよい。「不明」の項目は従来どおり全て確認する。",
    "GOAL.md / Human Review に変化がある場合は、その取り込みを先に行ってよいが、手順はすべて実施する",
    "(このセッションが GOAL とタスク全体の整合を見直す唯一の機会であり、手順を飛ばすと",
    "変化のたびに探索を起こさずまとめて処理している意味が失われるため)。",
  ].join("\n");
}

/**
 * 走行中タスクがある場合に注入する「触らない」制約節。drain を廃止したため、探索セッションは
 * 他のタスクセッションと並走しうる。空なら空文字(呼び出し側でセクションごと省く)。
 */
function runningTasksSection(ctx: ExploreContext): string {
  if (ctx.runningTasks.length === 0) return "";
  return [
    "### 実行中のタスクセッション(Supervisor による機械的情報)",
    "",
    "次のタスクは他のセッションが実行中で、この探索と並走している(drain は廃止した)。",
    "実行中のタスクの `.agent/tasks/<id>.md` は編集しない(priority・dependencies・status の",
    "いずれも変更しない)。調整が必要な場合は本文にメモを残すか、次回の探索セッションに委ねる。",
    "結果はまだ出ていない前提で判断すること。",
    "",
    ...ctx.runningTasks.map((t) => `- ${t.id}: ${t.title}`),
  ].join("\n");
}

export function buildExplorePrompt(ctx: ExploreContext): string {
  const running = runningTasksSection(ctx);
  return [
    COMMON_RULES_NOTICE,
    ...goalSection(),
    "---",
    "## 探索セッション",
    [
      "このセッションは「実行可能なタスクがないとき」「タスク消化中でも前回探索から一定時間が経過し、",
      "main / 入力(GOAL.md・Human Review の回答)が変化したとき」に起動される。",
      "次の実行可能な作業を探して `.agent/tasks/` にタスクファイルとして登録すること。",
      "",
      launchInfoSection(ctx),
      ...(running === "" ? [] : ["", running]),
      "",
      "1. `.agent/human-review/` の各ファイルを読み、status が answered、またはチェックボックスにチェックが入っているものを確認する",
      "   (`status: open` のままチェックだけ入っている場合も回答済み)。",
      "   回答は `## 回答` 節のチェックボックスで判定する。`- [x] 対応不要(このままクローズしてよい)` だけに",
      "   チェックが入っているものは Stage 1 が機械的に closed にするため、ここへ回ってきた場合でも",
      "   そのまま closed にしてよい。`- [x] 回答を下に書いた` にチェックがあるもの(チェックボックス行を",
      "   消して本文に直接書かれている場合も含む)は、回答本文の内容に沿って判断する。新しい作業が必要なら",
      "   新タスクとして登録し、新規タスク化が不要なら(既に別タスクで対応済み・感想のみ・方針の確認だけ等)",
      "   タスクを作らずに closed にする。いずれの場合も frontmatter の status を closed に更新する。",
      "   BLOCK エントリだった場合は、影響タスクを再開できるか判断し、可能なら該当タスクを ready に戻す。",
      "   フェーズゲート HR の BLOCK には再開すべき影響タスクは存在しない。回答内容(続行同意・方針変更)を",
      "   踏まえて次フェーズのタスク生成を再開する、または方針変更を反映する(詳細は共通ルールの",
      "   「フェーズゲート」節を参照)。フェーズ 4 の個別トピック確認 HR への回答の場合は、同意された",
      "   トピックのみタスク化し、不同意のトピックはタスク化せず見送りとして記録する。",
      "   回答は最優先の指示ではなく「新しい情報」である。回答から作るタスクの priority は",
      "   既存タスクとの相対で内容から判断し、急がないものは低い priority でよい。",
      "2. 1. の回答を含む新しい情報を踏まえて、既存タスクの priority・dependencies を見直し、",
      "   タスク全体の消化順序を再検討する。見直した場合は理由を該当タスクの note または",
      "   `.agent/decisions/` に残す。値が実際に変わる場合のみファイルを書き直す。値が変わらない",
      "   タスクファイルは Edit/Write で触らない(無変更の書き直しはコミット履歴のノイズになるため禁止)。",
      "3. `.agent/tasks/` の blocked タスクを確認し、ブロック理由が解消済みなら ready に戻す。",
      "4. `.agent/GOAL.md` の方向性(ミッション・現在の目標・優先順位・やらないこと)と",
      "   リポジトリの現状を突き合わせ、目標へ近づく次の一手をタスクとして登録する。",
      "   壊れているもの・未完了の TODO の修理タスクもここで登録してよい。",
      "   GOAL がプロダクトの構築・拡張である場合はフェーズゲート運用に従う: `OVERVIEW.md` で",
      "   現在フェーズを確認し、未回答のフェーズゲートより先のフェーズに属するタスクは生成しない。",
      "   現在フェーズが完了したと判断したら、フェーズゲート HR(`importance: BLOCK`)を作成する。",
      "   フェーズ 4 ではトピック案ごとに個別の HR(`importance: BLOCK`)で可否を確認し、同意済みの",
      "   ものだけタスク化する(確認 HR は並行して最大 4 件程度まで開いてよい。同意済みトピックは他の",
      "   回答を待たず着手可)。詳細は共通ルールの「フェーズゲート」節を参照。",
      "5. 4. で突き合わせた GOAL とタスクの完了状況を踏まえて `.agent/OVERVIEW.md` を更新する。",
      "   GOAL に対する現在地(どこまで実装できたか)と、これから何をやれば完了に近づくかの見立てを",
      "   本文に短くまとめる。frontmatter の `updatedAt`(ISO 8601)と、`ccloop status` の",
      "   進捗バーが示す完了数・総数を `completed`/`total` として記録する(形式は共通ルール参照)。",
      "   フェーズゲート運用時は現在フェーズと各ゲートの回答状況も記載する。",
      "   内容に実質的な変化がなければファイルには触れない(無変更の書き直しは禁止)。ファイルが無ければ",
      "   新規作成する。ファイル全体は 10KiB 程度を上限とし、超えそうなら古い記述を削って圧縮する。",
      "6. 既存の ready タスクが GOAL.md の方向性と矛盾していないか確認する。矛盾するタスクは",
      "   blocked にして note に理由(方向転換)を書き、`.agent/human-review/` へ REVIEW として記録する",
      "   (人間が最終確認してから破棄できるようにするため。勝手に削除しない)。",
      "",
      "GOAL.md が実質未記入の場合、新しい作業を発明してはならない(勝手な方向へ進まない)。",
      "その場合は `.agent/human-review/` に「方向性が未設定」を REVIEW として記録する(既に同趣旨の",
      "open エントリがあれば重複して記録しない)。OVERVIEW.md にも見立てを捏造せず「方向性未設定」と",
      "だけ書くに留める。",
      "",
      "タスクや記録の作成は共通ルール記載のファイル形式(1 トピック 1 ファイル + YAML frontmatter)に従うこと。",
      "このセッションでは調査とタスク登録のみを行い、実装はしないこと。",
      "登録すべき作業がなければ何も登録せず終了してよい。",
    ].join("\n"),
  ].join("\n\n");
}

/**
 * タスクに使うモデルを決める。失敗が閾値に達したらエスカレーション先 > タスク指定 > 既定。
 * 判定は retries のみで conflictRetries は含めない: マージ衝突はタスクの難しさを示す
 * シグナルではないため、モデルを重くする理由にならない。
 */
export function pickModel(config: Config, task: Task): string {
  const esc = config.escalation;
  if (esc.model !== "" && task.retries >= esc.afterRetries) return esc.model;
  return task.model ?? config.model;
}

/** 起動したタスクセッション 1 件について、終了処理(finishTaskSession)に必要な文脈 */
export interface TaskSessionContext {
  /** 起動時点のタスク(タスクファイルから読み直したもの) */
  task: Task;
  model: string;
  branch: string;
  worktree: string;
  /** 起動時点の status。終了後に更新されたかの比較に使う */
  launchStatus: TaskStatus;
  /** コンフリクト解消の継続セッションか */
  resuming: boolean;
  startedAt: string;
  /**
   * 対象リポジトリのルート。破壊的な git 操作(worktree/ブランチの削除・改名・マージ)の
   * 対象を、プロセスの cwd 由来の暗黙値ではなく起動時に確定した値で固定するため、
   * 起動時の文脈として持ち回す
   */
  root: string;
}

/** `git status --porcelain -- .agent` に何か出るか(自動コミットで流し切れたかの確認) */
function agentDirDirty(root: string = repoPaths().root): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain", "--", ".agent"], { cwd: root }).toString().trim() !== "";
  } catch (err) {
    log(`警告: .agent の差分確認に失敗した: ${String(err)}`);
    return false;
  }
}

/**
 * タスクセッションを起動する(await はしない)。起動できなかった場合は null を返す
 * (タスクは失敗扱いにしない。次の周回で再度選ばれる)。
 *
 * worktree の作成は Claude Code の WorktreeCreate hook が行うため、ここでは経路名を決めるだけ。
 * 起動前に main の `.agent/` をコミットして流し切る。worktree は main の HEAD から作られるので、
 * コミットされていないタスクファイルの更新はセッションから見えないため。
 */
function startTaskSession(
  config: Config,
  task: Task,
): { ctx: TaskSessionContext; result: Promise<SessionResult> } | null {
  const t = loadTask(task.id);
  if (t === null) {
    log(`警告: ${task.id} のタスクファイルが見つからないためスキップ`);
    return null;
  }

  const root = repoPaths().root;
  commitAgentDir(undefined, root);
  if (agentDirDirty(root)) {
    log(`警告: .agent の差分をコミットできなかったため ${task.id} を起動しない(人間の並行作業を保護)`);
    return null;
  }

  const model = pickModel(config, t);
  const worktree = worktreePathFor(config.parallel.worktreeDir, t.id);
  const branch = branchNameFor(t.id);
  // 前回の統合が失敗し、コンフリクトを再現した状態の worktree が残っているか
  const resuming = fs.existsSync(worktree) && worktreeConflictPending(worktree);
  const startedAt = new Date().toISOString();

  const state = loadState();
  state.runningSessions.push({
    kind: "task",
    taskId: task.id,
    branch,
    worktree,
    model,
    startedAt,
    phase: "running",
  });
  state.sessionCount += 1;
  saveState(state);

  const escalated = model !== (t.model ?? config.model);
  const conflictRetrySuffix = t.conflictRetries > 0 ? `, 衝突再試行 ${t.conflictRetries} 回目` : "";
  log(
    `${styleText("cyan", "▶")} ${t.id} "${t.title}" を開始 (model=${model}${escalated ? " エスカレーション" : ""}${t.retries > 0 ? `, 再試行 ${t.retries} 回目` : ""}${conflictRetrySuffix}${resuming ? ", 衝突解消の継続" : ""}, branch=${branch})`,
  );

  // cwd はリポジトリ本体のまま。CLI が --worktree の worktree へ移動する(worktree 自体は
  // WorktreeCreate hook が作る / 既にあれば再利用する)
  const deadline = sessionDeadline(startedAt, config.taskTimeoutMs);
  const result = runClaude(config, buildTaskPrompt(config, t, { resuming, startedAt, deadline }), model, root, {
    extraArgs: ["--worktree", t.id],
    env: {
      CLAUDE_AGENT_SESSION_KIND: "task",
      CLAUDE_AGENT_TASK_ID: t.id,
      // worktree 上のセッションが並ぶと CPU が飽和するため、テストのワーカー数を絞る
      VITEST_MAX_THREADS: "2",
    },
  });

  return { ctx: { task: t, model, branch, worktree, launchStatus: t.status, resuming, startedAt, root }, result };
}

/**
 * 探索セッション終了時のログ 1 行を組み立てる。判定順序はタスクセッション側(fail 呼び出し前の分岐)
 * と同様に timedOut を最優先にし、タイムアウトを異常終了と区別できる文言にする
 * (タイムアウト時も session id・stderrTail は異常終了時と同様に含める)。
 */
export function exploreEndLogLine(res: SessionResult, timeoutMs: number): string {
  if (res.timedOut) {
    return `${styleText("red", "✖")} 探索セッションがタイムアウト(${timeoutMs}ms)で終了 (session ${sessionId(res)})${stderrTail(res)}`;
  }
  if (res.exitCode === 0) {
    return `${styleText("green", "✔")} 探索セッション終了 (session ${sessionId(res)})`;
  }
  return `${styleText("red", "✖")} 探索セッションが異常終了 (exitCode=${res.exitCode}, session ${sessionId(res)})${stderrTail(res)}`;
}

/**
 * reason: なぜ探索セッションを起動するのか(ログにそのまま表示する)。ctx: プロンプトへ注入する差分内訳
 * 戻り値の rateLimited は、呼び出し元が「rate limit による中断は探索完了として扱わない」
 * (mainDirty・空振り判定を更新せず、解除後に再試行させる)ために使う。
 * 戻り値の fastCrashed は、呼び出し元が「探索は何もしていない」扱いにして次の探索へ
 * クールダウン(exploreDue)を課すために使う(rateLimited のときは常に false)。
 */
// テスト用に export する(spawn 失敗時に例外が漏れず継続することを回帰テストで検証するため)
export async function runExploreSession(
  config: Config,
  reason: string,
  ctx: ExploreContext,
): Promise<{ rateLimited: boolean; fastCrashed: boolean }> {
  const startedAt = new Date().toISOString();
  const state = loadState();
  state.lastExploreAt = startedAt;
  state.sessionCount += 1;
  state.runningSessions.push({ kind: "explore", startedAt });
  saveState(state);

  let rateLimited = false;
  let fastCrashed = false;
  try {
    log(`${styleText("cyan", "▶")} 探索セッションを開始: ${reason}`);
    const deadline = sessionDeadline(startedAt, config.taskTimeoutMs);
    // 起動そのものの失敗(spawn の同期 throw など)はタスクセッション経路(launchTaskSession)と
    // 同じくクラッシュ結果へ変換する。ここで捕まえないと未捕捉例外になり、探索 1 件の失敗で
    // ccloop run 全体が落ちる(タスクセッションでは同じ失敗が吸収されるため、経路ごとの差になる)。
    let res: SessionResult;
    try {
      res = await runClaude(config, buildExplorePrompt({ ...ctx, startedAt, deadline }), config.model, repoPaths().root, {
        env: { CLAUDE_AGENT_SESSION_KIND: "explore" },
      });
    } catch (err) {
      log(`警告: 探索セッションが想定外に失敗した: ${String(err)}`);
      // exitCode: null かつ即座に返るため、以降の isFastCrash が「瞬時クラッシュ」と判定する
      // = 入力ハッシュを更新せず、次の探索へクールダウンを課す
      res = crashResultFromError(err);
    }
    recordMetrics({ kind: "explore", model: config.model, res, sessionCwd: repoPaths().root });
    if (isSessionRateLimited(res)) {
      applyRateLimit(config);
      rateLimited = true;
    } else {
      // 探索が成功した = レートリミットは回復している
      clearRateLimit();
      recordPermissionDenials("explore", res, repoPaths().root);
      const wallMs = Date.now() - new Date(startedAt).getTime();
      fastCrashed = isFastCrash(res, wallMs);
      if (!fastCrashed) {
        // このセッションが現在の入力(GOAL.md・answered な Review)を確認済みとして記録する。
        // レートリミット時・瞬時クラッシュ時は更新せず、次回に再度取り込ませる
        const st = loadState();
        st.inputsHash = hashInputs();
        st.goalHash = currentGoalHash();
        st.answeredKeys = currentAnsweredKeys();
        saveState(st);
      }
      log(exploreEndLogLine(res, config.taskTimeoutMs));
      if (fastCrashed) {
        log("人間の入力(GOAL.md / Human Review の回答)は未取り込みのままにする。次の探索が取り込む");
      }
    }
  } finally {
    const st = loadState();
    st.runningSessions = st.runningSessions.filter((s) => s.kind !== "explore");
    saveState(st);
  }
  return { rateLimited, fastCrashed: rateLimited ? false : fastCrashed };
}

/**
 * branch が root の HEAD から分岐して以降、タスクファイル `.agent/tasks/<id>.md` を
 * 変更したか。マージで main へ取り込む前(ブランチ先端がまだ生きているうち)に呼ぶ。
 * git が失敗して判定できない場合は「変更あり」に倒す(判定不能を理由に status 未更新と
 * 誤判定して retries を無駄に消費しないため)。
 */
export function taskFileChangedOnBranch(root: string, branch: string, taskId: string): boolean {
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", branch], { cwd: root }).toString().trim();
    const out = execFileSync(
      "git",
      ["diff", "--name-only", `${base}..${branch}`, "--", `.agent/tasks/${taskId}.md`],
      { cwd: root },
    ).toString();
    return out.trim() !== "";
  } catch {
    return true;
  }
}

/**
 * main の現在の HEAD を worktree へマージし直し、コンフリクトを worktree 上に再現する。
 * 次の試行を「衝突解消セッション」として同じ worktree で起動するための準備であり、
 * マージが失敗する(= 衝突マーカーと MERGE_HEAD が残る)のが期待動作。
 * 衝突はすべて内容の対立(substantive)なので、ここでは何も先行解決せず、衝突マーカーを
 * 残したまま次のセッションへ渡す。
 */
function reproduceMergeConflict(worktree: string, root: string): void {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    execFileSync("git", ["merge", head], { cwd: worktree, stdio: "ignore" });
    log(`警告: ${worktree} で main のマージが衝突なく通った(次のセッションは通常起動になる)`);
  } catch {
    // コンフリクトによる非ゼロ終了が期待動作
  }
}

/** 未コミット差分の退避結果。失敗(failed)を null と区別できないと worktree を消してしまう */
type SalvageOutcome =
  | { kind: "none" }
  | { kind: "saved"; patchFile: string; paths: string[] }
  | { kind: "failed"; error: string };

/** 退避に失敗して残した worktree の記録(status の「要対応」に出す) */
export interface SalvageFailure {
  taskId: string;
  worktree: string;
  at: string; // ISO 8601
  error: string;
}

/**
 * 退避失敗を state ディレクトリへ記録する(`<taskId>.json`。同じタスクの再発は上書きでよい)。
 * 書き込み自体が失敗しても例外を投げない。退避失敗の記録でさらに落ちて worktree 削除の判断まで
 * 壊すことがないようにするため
 */
function recordSalvageFailure(root: string, rec: SalvageFailure): void {
  try {
    const dir = createPaths(root).salvageFailuresDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rec.taskId}.json`), JSON.stringify(rec));
  } catch (err) {
    log(`警告: ${rec.taskId} の退避失敗記録の書き込みに失敗した: ${String(err)}`);
  }
}

/**
 * 退避に失敗して残っている worktree の一覧(status 表示用)。
 * 記録された worktree が既に存在しない(人間が片付けた)エントリはマーカーファイルごと
 * 削除して結果から除く(自己清掃: status から自然に消える)。taskId 昇順。
 * 失敗は握りつぶして空配列を返す(status を例外で落とさないため)。
 */
export function loadSalvageFailures(root: string = repoPaths().root): SalvageFailure[] {
  try {
    const dir = createPaths(root).salvageFailuresDir;
    if (!fs.existsSync(dir)) return [];
    const result: SalvageFailure[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const rec = JSON.parse(fs.readFileSync(file, "utf8")) as SalvageFailure;
        if (!fs.existsSync(rec.worktree)) {
          fs.rmSync(file, { force: true });
          continue;
        }
        result.push(rec);
      } catch {
        // 壊れたファイルはスキップする
      }
    }
    return result.sort((a, b) => a.taskId.localeCompare(b.taskId));
  } catch {
    return [];
  }
}

/** worktree 上の未コミット差分を state ディレクトリの patches/ へ退避する */
function salvageWorktreeDiff(taskId: string, worktree: string, at: Date, root: string): SalvageOutcome {
  try {
    const patchFile = path.join(patchesDirOf(root), patchFileName(taskId, at));
    const paths = salvagePatch(worktree, patchFile);
    if (paths === null) return { kind: "none" };
    return { kind: "saved", patchFile, paths };
  } catch (err) {
    const error = String(err);
    log(`警告: ${taskId} の未コミット差分の退避に失敗した: ${error}`);
    recordSalvageFailure(root, { taskId, worktree, at: at.toISOString(), error });
    return { kind: "failed", error };
  }
}

/**
 * 上限到達で failed になったタスクの worktree を片付け、ブランチは削除せず退避名へ改名する。
 * 成果を消さずに人間が後から拾えるようにするため。既に片付け済み(成功経路)なら何もしない。
 * 試行履歴へ追記する説明行を返す。
 */
function parkTaskWorktree(taskId: string, worktree: string, branch: string, at: Date, root: string): string[] {
  if (!fs.existsSync(worktree)) return [];
  const lines: string[] = [];
  const salvage = salvageWorktreeDiff(taskId, worktree, at, root);
  if (salvage.kind === "saved") {
    lines.push(
      `- 未コミット差分を \`${salvage.patchFile}\` へ退避した(${formatDiffPathList(salvage.paths)})。復元は \`git apply ${salvage.patchFile}\``,
    );
  } else if (salvage.kind === "failed") {
    lines.push(
      `- 未コミット差分の退避に失敗したため worktree \`${worktree}\` を残した(中の差分を回収してから手で削除すること)`,
    );
    return lines;
  }
  try {
    removeWorktree(root, worktree);
    const parked = parkedBranchNameFor(taskId, at);
    renameBranch(root, branch, parked);
    lines.push(`- コミット済みの成果はブランチ \`${parked}\` に退避した(削除していない)`);
    log(`${taskId}: worktree を削除し、ブランチを ${parked} へ退避した`);
  } catch (err) {
    log(`警告: ${taskId} の worktree/ブランチ退避に失敗した: ${String(err)}`);
  }
  return lines;
}

/** wedged の step を日本語ラベルへ変換する(網羅性を型で担保するため Record にしている)。 */
const WEDGED_STEP_LABELS: Record<WedgedStep, string> = {
  "substantive-conflict": "実質コンフリクトの中止",
  "decisions-index": "decisions/index.md の機械マージ失敗",
  "unexpected-error": "想定外の例外",
};

/** MergeOutcome を 1 行のログ表現にする。 */
export function describeMergeOutcome(outcome: MergeOutcome): string {
  switch (outcome.result) {
    case "merged":
      return "main へマージした";
    case "renumbered": {
      // 内訳の文言は mergeCommitMessage が本文に書く表現と揃える。パス自体は
      // 1 行ログを短く保つため出さない。
      const details: string[] = [];
      if (outcome.resolved.ownTaskFile != null) {
        details.push("タスクファイルはブランチ側を採用");
      }
      if (outcome.resolved.decisionsIndex != null) {
        details.push("決定インデックスは両ブランチの項目を統合");
      }
      return details.length > 0
        ? `main へマージした(機械的に解決: ${details.join(" / ")})`
        : "main へマージした(機械的に解決)";
    }
    case "nothing-to-merge":
      return "ブランチに新しいコミットがなく、マージするものがなかった";
    case "conflict":
      return `コンフリクトのためマージを中止した(${outcome.paths.join(", ")})`;
    case "blocked":
      return `マージを開始できなかった: ${outcome.reason}`;
    case "wedged": {
      const context: string[] = [];
      if (outcome.step !== undefined) context.push(`失敗ステップ: ${WEDGED_STEP_LABELS[outcome.step]}`);
      if (outcome.conflictKind !== undefined) context.push(`分類: ${outcome.conflictKind}`);
      if (outcome.cause !== undefined) context.push(`直前のエラー: ${outcome.cause}`);
      const suffix = context.length > 0 ? `【${context.join(" / ")}】` : "";
      return `main が git 操作の途中で固まった(merge --abort 失敗): ${outcome.stderr}${suffix}`;
    }
  }
}

/**
 * finishTaskSession が main 側のタスクファイルへ書き込む直前に必ず呼ぶガード。
 * main が git 操作(マージ等)の途中なら true を返し、警告ログを 1 行出す。
 * 途中の書き込み(saveTask 等)がその後の `git merge --abort` を `not uptodate` で
 * 失敗させる原因になりうるため(実際に本番でこの経路が発生し main が固まった)、
 * 書き込み側は必ずこれを先にチェックしてスキップする。
 */
export function skipMainWriteIfGitBusy(taskId: string, root: string): boolean {
  if (!gitOperationInProgress(root)) return false;
  log(`警告: ${taskId}: main がマージ途中のため記録を書かない(復旧後の再試行で再評価される)`);
  return true;
}

export type TaskSessionVerdict =
  | { kind: "fail"; reason: string; failureKind: FailureKind }
  | { kind: "rate-limited" }
  | { kind: "wedged" }
  | { kind: "ok" };

/**
 * finishTaskSession の結果分類ロジックを純関数として切り出したもの。複数の失敗種別が同時に
 * 成立しうるため、判定の順序に意味がある:
 *
 * 1. レートリミット。利用上限に当たったまま CLI がすぐには終了せずタイムアウトで kill される
 *    ケースがあり、これを他の分岐で先に拾うと retries を消費したうえ待機(rateLimit.resumeAt)も
 *    設定されないまま同じ状況を繰り返してしまう。レートリミットは失敗として数えない。
 * 2. 衝突未解消(mergeStuck)。時間切れより先に判定する。両方成立しうるが、次の試行に渡す
 *    べき申し送りは「衝突を解消せよ」であって「タスクを分割せよ」ではないため、衝突未解消を
 *    timeout より優先する。
 * 3. タイムアウト。
 * 4. それ以外(マージ結果・異常終了・ターン上限・エラー・status 未更新)。
 */
export function classifyTaskSessionResult(input: {
  timedOut: boolean;
  taskTimeoutMs: number;
  rateLimited: boolean;
  mergeStuck: boolean;
  outcome: MergeOutcome | null;
  conflictPaths: string[];
  exitCode: number | null;
  stderrTail: string;
  maxTurns: boolean;
  errorSubtype: string | null;
  taskFileChanged: boolean;
  statusUnchanged: boolean;
}): TaskSessionVerdict {
  const {
    timedOut,
    taskTimeoutMs,
    rateLimited,
    mergeStuck,
    outcome,
    conflictPaths,
    exitCode,
    stderrTail,
    maxTurns,
    errorSubtype,
    taskFileChanged,
    statusUnchanged,
  } = input;

  if (rateLimited) {
    return { kind: "rate-limited" };
  }

  if (mergeStuck) {
    const timeoutSuffix = timedOut ? `(セッションはタイムアウト(${taskTimeoutMs}ms)で打ち切られた)` : "";
    return {
      kind: "fail",
      reason: `衝突解消が未完のまま終了。main とのマージが進行中のまま残っている${timeoutSuffix}`,
      failureKind: "merge-conflict",
    };
  }

  if (timedOut) {
    return { kind: "fail", reason: `タイムアウト(${taskTimeoutMs}ms)`, failureKind: "timeout" };
  }

  if (outcome !== null && outcome.result === "wedged") {
    return { kind: "wedged" };
  }
  if (outcome !== null && outcome.result === "conflict") {
    return { kind: "fail", reason: `main へのマージが衝突した(${conflictPaths.join(", ")})`, failureKind: "merge-conflict" };
  }
  if (outcome !== null && outcome.result === "blocked") {
    return { kind: "fail", reason: `main へのマージを開始できなかった: ${outcome.reason}`, failureKind: "merge-conflict" };
  }
  if (exitCode !== 0) {
    return { kind: "fail", reason: `claude が異常終了 (exitCode=${exitCode})${stderrTail}`, failureKind: "crash" };
  }
  if (maxTurns) {
    // exitCode 0 でも結果 JSON が is_error を立てることがある。レートリミットは
    // 成功扱いの is_error: true を出すため、この判定は必ずレートリミット判定より後ろに置く
    return { kind: "fail", reason: "セッションがターン数の上限に達して打ち切られた", failureKind: "max-turns" };
  }
  if (errorSubtype !== null) {
    return { kind: "fail", reason: `claude がエラーを報告して終了した (subtype=${errorSubtype})`, failureKind: "crash" };
  }
  if (!taskFileChanged && statusUnchanged) {
    return { kind: "fail", reason: "セッションがタスクファイルの status を更新せず終了した", failureKind: "no-status-update" };
  }
  return { kind: "ok" };
}

/**
 * タスクセッション終了後の後始末。順序に意味がある:
 * sweep(worktree 側の .agent コミット)→ タスクファイル更新判定 → マージ →
 * メトリクス → permission 拒否記録 → 結果分類 → 退避記録 → runningSessions から除去。
 *
 * タイムアウト・クラッシュ・レートリミットで終わったセッションでもマージは必ず試みる
 * (途中までコミットされた成果を worktree に閉じ込めないため)。
 *
 * worktree/ブランチの破壊的操作の対象リポジトリは、プロセスの cwd 由来の暗黙値ではなく
 * `ctx.root`(起動時に確定した値)を使う。`.agent/` や state の読み書きは共有の `repoPaths()` を
 * 経由するが、こちらは対象を取り違えてもリポジトリの履歴を壊さない読み書きであるため区別している。
 */
export function finishTaskSession(config: Config, ctx: TaskSessionContext, res: SessionResult): void {
  const { task, model, branch, worktree, root } = ctx;
  const taskId = task.id;
  const now = new Date();
  const at = now.toISOString();
  const session = sessionId(res);

  // 瞬時クラッシュの検知。起動直後に異常終了するセッションが連続する場合は環境要因による
  // 系統的な故障の可能性が高いため、その連続回数を scheduler.ts の crash-backoff ルールへ渡す
  // (fastCrashStreak >= 3 になった周回だけ、起動可能でも 1 周回起動を見送る。抑制した周回の
  // 終わりに mainLoop 側が fastCrashStreak を 0 に戻すため、抑制は最大 1 周回で解除される)。
  // レートリミットによる終了は時間経過で解決する事象であり環境要因の故障ではないため、
  // 瞬時クラッシュとしては数えない(据え置き: 増やしも減らしもしない)。
  const rateLimited = isSessionRateLimited(res);
  const wallMs = now.getTime() - new Date(ctx.startedAt).getTime();
  fastCrashStreak = nextFastCrashStreak(fastCrashStreak, res, wallMs, rateLimited);

  const state = loadState();
  for (const s of state.runningSessions) {
    if (s.kind === "task" && s.taskId === taskId) s.phase = "finishing";
  }
  saveState(state);

  // worktree が無いのは、CLI 側の worktree 作成に失敗した(= セッションが成立しなかった)場合。
  // マージ・退避はできないが、結果の分類(crash として retries を進める)は必ず行う必要がある。
  const worktreeExists = fs.existsSync(worktree);
  let outcome: MergeOutcome | null = null;
  let mergeLabel = "skipped";
  let leftovers: { patchFile: string; paths: string[] } | null = null;
  let conflictPaths: string[] = [];
  let conflictKind: ConflictKind | undefined;
  let mergeStuck = false;
  let taskFileChanged = true;

  try {
    if (!worktreeExists) {
      mergeLabel = "no-worktree";
      log(`警告: ${taskId} の worktree (${worktree}) が存在しないため、マージ・退避をスキップする`);
    } else {
      // 1. セッションが取りこぼした .agent/ の差分をブランチ側でコミットする
      commitAgentDir(undefined, worktree);

      // 2. マージ前にしか取れない情報(ブランチ先端との差分)を先に確定させる
      taskFileChanged = taskFileChangedOnBranch(root, branch, taskId);

      // 3. 統合。中断された git 操作が残ったまま終わったセッションは worktree をそのまま残す
      mergeStuck = worktreeConflictPending(worktree);
      if (mergeStuck) {
        mergeLabel = "unresolved";
        log(`${taskId}: 衝突解消が未完のままセッションが終了した。worktree を残す`);
      } else {
        // main 側の `.agent/` に未コミットの差分が残っていると、取り込み側の変更と
        // 競合して git merge が「ローカル変更の上書き」を検知し blocked になりうるため、
        // マージ直前に main 側もコミットしておく
        commitAgentDir(undefined, root);
        outcome = mergeAgentBranch(root, branch, taskId, task.title, AGENT_COMMIT_TRAILER);
        mergeLabel = outcome.result;
        // main が実際に変わったときだけ探索理由(mainDirty)を立てる。
        // クラッシュ・衝突・マージ不能では立てない(見直す対象が増えていないため)
        if (mainChangedByTaskOutcome(outcome, null)) mainChangedSinceExplore = true;
        log(`${taskId}: ${describeMergeOutcome(outcome)}`);
        if (outcome.result === "conflict") {
          conflictPaths = outcome.paths;
          conflictKind = outcome.conflictKind;
          reproduceMergeConflict(worktree, root);
        } else if (outcome.result === "wedged") {
          // main が git merge --abort の失敗で固まっている。ここでは stderr を全文ログに
          // 残すだけに留め、worktree・ブランチ・stale なコンフリクトには一切触れない
          // (誤って現在のブランチのものと扱わない。次の試行が回復後に再評価する)
          log(`error: ${taskId}: ${describeMergeOutcome(outcome)}`);
        } else if (outcome.result !== "blocked") {
          // blocked は main 側でマージを開始すらできていない状態。worktree に手を触れず次の試行へ回す
          const salvage = salvageWorktreeDiff(taskId, worktree, now, root);
          if (salvage.kind === "saved") leftovers = salvage;
          if (salvage.kind === "failed") {
            log(`警告: ${taskId}: 未コミット差分の退避に失敗したため worktree ${worktree} を残す`);
          } else {
            removeWorktree(root, worktree);
            if (!deleteBranch(root, branch)) log(`警告: ブランチ ${branch} の削除に失敗した`);
          }
        }
      }
    }
  } catch (err) {
    // 統合処理が想定外に失敗しても、結果の分類まで飛ばしてタスクを宙吊りにはしない
    mergeLabel = "error";
    log(`警告: ${taskId} の統合処理に失敗した: ${String(err)}`);
  }

  try {
    // 4. メトリクス(マージ結果まで含めて 1 行にする)
    recordMetrics({
      kind: "task",
      taskId,
      model,
      res,
      sessionCwd: worktree,
      branch,
      worktree,
      merge: mergeLabel,
      conflictPaths,
      conflictKind,
    });

    // 5. permission 拒否の記録(マージ結果に関係なく記録する)
    recordPermissionDenials(taskId, res, worktree);

    const fail = (reason: string, kind: FailureKind): void => {
      if (skipMainWriteIfGitBusy(taskId, root)) return;
      const t = loadTask(taskId);
      if (t === null) {
        log(`警告: ${taskId} のタスクファイルが見つからないため結果を記録できない`);
        return;
      }
      recordFailure(t, {
        maxRetries: config.maxRetries,
        maxConflictRetries: config.maxConflictRetries,
        reason,
        kind,
        at,
      });
      // 失敗が確定した(再試行が尽きた)場合は、探索が後追いタスクや Human Review を起こすべき
      // 情報なので main の変化として扱う。リトライ待ちに戻るだけの場合は立てない
      if (mainChangedByTaskOutcome(null, t.status)) mainChangedSinceExplore = true;
      if (t.status === "failed") {
        const lines = parkTaskWorktree(taskId, worktree, branch, now, root);
        if (lines.length > 0) t.body = `${t.body}\n${lines.join("\n")}`;
      }
      saveTask(t);
      log(`${styleText("red", "✖")} ${taskId} ${t.status} (${reason}, session ${session})`);
    };

    /** 成功時: マージ後の main 側タスクファイルの最終 status を 1 行で表示する */
    const logFinalStatus = (): void => {
      const t = loadTask(taskId);
      if (t === null) {
        log(`警告: ${taskId} のタスクファイルが見つからないため完了を確認できない`);
        return;
      }
      const meta = STATUS_META[t.status];
      log(`${styleText(meta.color, meta.symbol)} ${taskId} ${t.status} (session ${session})`);
    };

    // 6. 結果の分類(判定の順序に意味があるため classifyTaskSessionResult に委譲する)
    // 統合できていれば main 側のタスクファイルにセッションの更新が反映されている
    const merged = loadTask(taskId);
    const statusUnchanged = merged !== null && merged.status === ctx.launchStatus;

    const verdict = classifyTaskSessionResult({
      timedOut: res.timedOut,
      taskTimeoutMs: config.taskTimeoutMs,
      rateLimited,
      mergeStuck,
      outcome,
      conflictPaths,
      exitCode: res.exitCode,
      stderrTail: stderrTail(res),
      maxTurns: isMaxTurnsError(res),
      errorSubtype: sessionErrorSubtype(res),
      taskFileChanged,
      statusUnchanged,
    });

    if (verdict.kind === "rate-limited") {
      // レートリミットはタスクの失敗として数えない(retries を増やさない)。worktree の
      // 扱いはマージ結果に従うため、ここでは待機の設定だけ行う
      applyRateLimit(config);
      if (res.timedOut) {
        log(
          `${taskId}: タイムアウトで打ち切られたが利用上限が検出されたため、やり直し回数を消費しない(session ${session})`,
        );
      }
    } else if (!res.timedOut) {
      // タイムアウトしたセッションは上限に達していない証拠にならないので待機状態はそのままにする
      clearRateLimit();
    }

    if (verdict.kind === "fail") {
      fail(verdict.reason, verdict.failureKind);
    } else if (verdict.kind === "wedged") {
      // main が git merge --abort の失敗で固まっている。fail() は呼ばない: retries を
      // 消費させず、main 側のタスクファイルにも一切書き込まない(復旧後の再試行で
      // 現在の状態のまま再評価される)。ログだけ残す
      log(
        `${styleText("red", "✖")} ${taskId}: main が git 操作の途中で固まっているため記録を書かない(復旧後の再試行で再評価される)`,
      );
    } else if (verdict.kind === "ok") {
      logFinalStatus();
    }

    // 7. 退避したパッチを試行履歴へ残す(worktree はもう無く、ここにしか手がかりがない)
    if (leftovers !== null && !skipMainWriteIfGitBusy(taskId, root)) {
      const t = loadTask(taskId);
      if (t === null) {
        log(`警告: 未コミット差分を記録しようとしたが ${taskId} が見つからない`);
      } else {
        t.body = appendUncommittedDiffRecord(t.body, { at, patchFile: leftovers.patchFile, paths: leftovers.paths });
        saveTask(t);
        log(`${taskId}: 未コミット差分を ${leftovers.patchFile} へ退避し試行履歴へ記録した(${leftovers.paths.length} 件)`);
      }
    }
  } catch (err) {
    log(`警告: ${taskId} の終了処理に失敗した: ${String(err)}`);
  } finally {
    const st = loadState();
    st.runningSessions = st.runningSessions.filter((s) => !(s.kind === "task" && s.taskId === taskId));
    saveState(st);
  }
}

// ---------- メインループ ----------
//
// 並列実行の要となる不変条件:
//   main のワーキングツリーに対する git 操作(commitAgentDir / mergeAgentBranch)と
//   state.json の書き込みは、すべてメインループの「スレッド」上でだけ行う。
//   すなわち起動の同期部分(launchTaskSession)と完了キューの掃き出し(drainCompletedSessions)
//   だけが main を触り、セッション完了コールバックはキューへ積むだけで何も触らない。
//   これにより、同時に走る複数セッションの後始末は直列化され、マージ同士が競合しない。

/**
 * dir が存在する(無ければ mkdir -p で作れる)か、かつ書き込み可能かを検証する。
 * worktree 置き場が root 所有ディレクトリの直下(devcontainer の /workspaces 等)にある環境では
 * mkdirSync が EACCES で失敗し、タスクセッションが軒並み起動直後にクラッシュしうる
 * (WorktreeCreate hook が worktree を作れないため)。mainLoop の起動時にまとめて検証し、
 * 1 セッションも起動できないまま失敗を積み重ねる前に停止できるようにする。
 * 戻り値は問題なければ null、問題があれば人間向けのエラーメッセージ。
 */
export function ensureWritableDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return String(err);
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    return String(err);
  }
  return null;
}

/** 完了したがまだ後始末(finishTaskSession)をしていないタスクセッション。FIFO で処理する */
const completedSessions: { ctx: TaskSessionContext; res: SessionResult }[] = [];

/**
 * 想定外の promise reject をセッション結果へ落とし込む。runClaude は reject しない設計だが、
 * 万一 reject してもセッションを完了キューから取りこぼさないための保険
 * (取りこぼすと runningSessions に残り続け、そのタスクのスロットが永久に埋まる)。
 */
export function crashResultFromError(err: unknown): SessionResult {
  return { exitCode: null, timedOut: false, stdout: "", stderr: `セッションが想定外に失敗した: ${String(err)}` };
}

/**
 * タスクセッションを 1 件起動する。同期部分(state 更新・spawn)だけをここで行い、await はしない。
 * 完了は completedSessions へ積んでメインループへ返す。**このコールバックの中で main の git 操作や
 * state.json の書き込みをしてはならない**(上記の不変条件)。
 * 戻り値は起動できたか。起動できなくてもタスクは失敗扱いにしない(次の周回で再度選ばれる)。
 */
function launchTaskSession(config: Config, task: Task): boolean {
  const started = startTaskSession(config, task);
  if (started === null) return false;
  started.result.then(
    (res) => {
      completedSessions.push({ ctx: started.ctx, res });
      wakeEmitter.emit("wake");
    },
    (err: unknown) => {
      log(`警告: ${task.id} のセッションが想定外に失敗した: ${String(err)}`);
      completedSessions.push({ ctx: started.ctx, res: crashResultFromError(err) });
      wakeEmitter.emit("wake");
    },
  );
  return true;
}

/**
 * 完了キューを FIFO で空にし、後始末した件数を返す。メインループ上からのみ呼ぶこと。
 * finishTaskSession は main へのマージを含むため criticalSection で囲み、緊急停止に
 * 途中で切られないようにする。
 */
function drainCompletedSessions(config: Config): number {
  let finished = 0;
  for (;;) {
    const done = completedSessions.shift();
    if (done === undefined) break;
    criticalSection += 1;
    try {
      finishTaskSession(config, done.ctx, done.res);
    } finally {
      criticalSection -= 1;
    }
    finished += 1;
  }
  return finished;
}

/** タイマー満了、または wakeEmitter の "wake" イベントの早い方で resolve する */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const onWake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      wakeEmitter.off("wake", onWake);
      resolve();
    }, ms);
    wakeEmitter.once("wake", onWake);
  });
}

/**
 * main で git 操作(マージ等)が進行中のときに自己修復(abortInterruptedAutoMerge)を試みる。
 * マージ直後の同一秒内は racy-git により `merge --abort` が `not uptodate` で失敗しうるため、
 * 失敗直後に諦めず待機を挟んで再試行する。「人間の git 操作が進行中」という結論(false を
 * 再試行なしで返す)は、agent 由来でないと判定できた場合にのみ出す。
 *
 * 再試行の層はここ 1 つに集約する。abortMerge も自前の再試行を持つが、ここからは
 * `attempts: 1` で呼び、待機はこのループの `delayMs`(非同期 sleep)だけが行う。
 * 二重に再試行させると待ち時間が掛け算で伸びるうえ、abortMerge 側の待機は同期
 * (Atomics.wait)でイベントループを止めるため、非同期で待てるここが待つ方がよい。
 * 既定の待機は秒境界を必ず跨ぐよう 1 秒より少し長くとる(racy git の解消条件)。
 */
export async function selfHealGitOperationInProgress(
  root: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<boolean> {
  const attempts = opts?.attempts ?? 3;
  const delayMs = opts?.delayMs ?? 1100;
  const singleAttempt: AbortRetryPolicy = { attempts: 1, delayMs: 0 };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let result: AutoMergeAbortResult | undefined;
    try {
      result = abortInterruptedAutoMerge(root, singleAttempt);
    } catch (err) {
      log(`警告: 自己修復に失敗した: ${String(err)}`);
    }
    if (result === "not-ours") return false;
    if ((result === "aborted" || result === "no-merge") && !gitOperationInProgress(root)) {
      return true;
    }
    if (result === "abort-failed" && attempt < attempts) {
      log(`main の自己修復を再試行する(${attempt + 1}/${attempts} 回目)`);
      await sleep(delayMs);
    }
  }
  return false;
}

export async function mainLoop(opts: { force?: boolean } = {}): Promise<void> {
  // 状態を書き換える処理(generateSettings 以降)より前に、必ず二重起動ガードを確認する。
  // 後発の ccloop run がここより後ろへ進むと、recoverStartup 等が先発プロセスの実行状態を
  // 無条件に書き換えてしまうため、判定だけを行うここでは一切のファイル書き込みをしない。
  const guard = evaluateStartupGuard(evaluateLoopLiveness(readRunnerRecord(repoPaths().runnerPath), new Date()));
  if (!guard.allow) {
    if (opts.force === true) {
      log(`警告: --force が指定されたため、次の警告を無視して起動します:\n${guard.message}`);
    } else {
      // log() は標準出力なので、起動を諦めたことは標準エラーへ出す
      // (呼び出し元が出力を分けて扱えるように。終了コードも 1 にする)
      console.error(guard.message);
      process.exitCode = 1;
      return;
    }
  } else if (guard.warning !== null) {
    log(`警告: ${guard.warning}`);
  }

  // 自律実行セッションへ渡す settings / 共通ルール(system prompt)は、ここでは初回の用意と
  // 早期の失敗検出のためだけに組み立てる。ループを動かしたまま利用側が `.agent/claude-settings.json`
  // や `.agent/PROMPT.local.md` を編集しても反映されるよう、以降はセッションを 1 本起動するたびに
  // runClaude 側の refreshGeneratedSessionInputs が組み立て直す。
  generateSettings(repoPaths());
  generateSystemPrompt(repoPaths());
  // config.json の内容が壊れていると loadConfig が例外を投げる。未捕捉のまま投げさせると
  // スタックトレースだけが出て `ccloop run` が落ちるので、ここで捕まえて人間向けメッセージだけ出す。
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    log(`fatal: ${String((err as Error)?.message ?? err)}`);
    return;
  }
  // `ccloop status` がループ本体の生死を判定できるよう、起動時点の生存記録を書く
  // (以降はタイマーの心拍で heartbeatAt を更新する)
  const runnerStartedAt = new Date().toISOString();
  touchRunnerRecord(runnerStartedAt, config.idlePollMs);
  // 心拍はループの周回ではなくタイマーで打つ。探索・triage セッションは await で
  // 最大 taskTimeoutMs ブロックし、その間ループ先頭へ戻らないため、周回に紐づけると
  // 正常稼働中に「応答がありません」と誤表示されてしまう。
  const heartbeat = setInterval(() => touchRunnerRecord(runnerStartedAt, config.idlePollMs), config.idlePollMs);
  // このタイマーだけでプロセスを生かし続けないようにする(終了判断はループ側の責務)
  heartbeat.unref();
  // 停止指示はプロセスのメモリにしか無い。起動時に必ずリセットしておく
  // (同一プロセス内で mainLoop を再実行した場合に前回の意思を引きずらないため)。
  // state.json 側は表示専用の写しなので、前回プロセスが緊急停止で残した値をここで消す
  currentStopMode = "none";
  publishStopMode("none");
  // SIGTERM も 1 回目の Ctrl+C と同じ段階停止として扱う。サービスマネージャからの停止でも
  // 走っているセッションを取り込んでから止まるほうが成果を失わずに済む
  // (待てない場合は 3 回送れば緊急停止に到達する)。
  process.on("SIGINT", () => escalateStop("SIGINT"));
  process.on("SIGTERM", () => escalateStop("SIGTERM"));
  log("supervisor start");
  // 緊急停止(Ctrl-C 2 回、finally を通らない終了)で root 側 .agent/ に未コミットの差分が
  // 残っていると、recoverStartup 内の recoverOrphanBranch が呼ぶ mergeAgentBranch(root, ...)
  // が「ローカル変更の上書き」を検知して blocked になり、孤児ブランチの回収が次回 run まで
  // 丸ごと遅延しうる。recoverStartup を呼ぶ前に root 側を先にコミットして防ぐ。
  commitAgentDir();
  // 前回の終了時に積み残した .agent/ の差分もここで拾う。復旧が無かった周回で
  // 「中断していたタスクを復旧する」と名乗ると嘘になるため、件数で文言を出し分ける。
  const recovered = startupRecoveryTotal(recoverStartup(config));
  if (recovered > 0) commitAgentDir("docs(agent): 中断していたタスクを復旧する");
  else commitAgentDir();

  // 起動直後は recover 済みの main を一度は探索させたいので、mainDirty 相当から始める
  // (前回の run が積み残した状態を GOAL と突き合わせ直す機会をここで担保する)。
  mainChangedSinceExplore = true;
  // 直前に完了した探索セッションが新規タスクを 1 件も登録しなかったか(プロセス内フラグ、
  // 永続化しない)。true の間は exploreDue のクールダウンを課し、
  // 空振り探索がタスク完了のたびに即座に連鎖するのを防ぐ。
  let lastExploreYieldedNothing = false;
  // 直前の探索セッションが瞬時クラッシュで終わったか(プロセス内フラグ、永続化しない)。
  // 永続化しない = この抑制は再起動で完全に外れる(意図的)。ccloop run を打ち直すのは、人間が
  // クラッシュの原因を直して再開したときであり、そこで minInterval を待たせる意味がないため。
  // 未取り込みの入力(inputsDirty)が残っていれば、再起動後の初回周回で即座に再探索する。
  let lastExploreFastCrashed = false;
  // 停止 (clean) 指示の後、衝突解消のために起動したタスク ID(プロセス内フラグ、永続化しない)。
  // タスクごとに停止後 1 回までに制限し、解消セッションが再び衝突しても停止が無限に延びないようにする。
  const conflictResumeLaunched = new Set<string>();

  try {
    // worktree 置き場が書き込めない環境(EACCES 等)では、タスクセッションが 1 本も
    // 起動できないまま起動直後にクラッシュを繰り返すだけになる。ループへ入る前にまとめて
    // 検証し、その場合は原因と復旧手順を示して止まる(機械的な再試行の空回りを避ける)。
    const worktreeDirError = ensureWritableDir(config.parallel.worktreeDir);
    if (worktreeDirError !== null) {
      log(`fatal: worktree 置き場 ${config.parallel.worktreeDir} に書き込めない: ${worktreeDirError}`);
      log(
        `fatal: 復旧するには ${config.parallel.worktreeDir} の親ディレクトリの書き込み権限を確認すること` +
          "(既定では環境変数 XDG_STATE_HOME、またはホームディレクトリ配下 ~/.local/state の権限が原因になる)",
      );
      log("fatal: タスクセッションを 1 本も起動できないため停止する");
      return;
    }

    while (true) {
      // 緊急停止中は新しい判断をしない(main を触らせない)。終了は emergencyStop 側が行う
      if (shuttingDown) {
        await sleep(1_000);
        continue;
      }

      // 1. 完了したセッションの後始末。並列に走ったセッションもここで 1 件ずつ直列に処理する
      // 探索の要否(mainDirty)は「main へマージできたか」で判断するため、ここでは何も立てない
      // (finishTaskSession がマージ結果を見て mainChangedSinceExplore を更新する)
      drainCompletedSessions(config);

      // 後始末で state.json が書き換わるため、判断材料はその後で読む
      const state = loadState();
      const runningCount = state.runningSessions.length;

      // この周回はセッションが 0 なので、main の git 自己修復とあわせて記録の片付け
      // (ローテーション + 退避パッチの掃除)も行う。片付けはこれと「探索セッションの起動直前」
      // の 2 箇所が契機で、タスクが途切れず runningCount === 0 の周回が来ない状況でも記録が
      // 溜まり続けないようにしている。
      if (runningCount === 0) {
        // main が git 操作(マージ等)の途中で固まっていないかを確認し、可能なら自己修復する。
        // wedged(F3)や、想定していない経路で残ったマージが起きても、次の周回でここが拾って
        // 復旧を試みる。マージ直後の同一秒内は racy-git により abort 自体が一時的に失敗しうる
        // ため、selfHealGitOperationInProgress が待機を挟んで再試行してから fatal 判定する。
        if (gitOperationInProgress(repoPaths().root)) {
          log("警告: main で git 操作が進行中を検知。自己修復を試みる");
          if (!(await selfHealGitOperationInProgress(repoPaths().root))) {
            log("fatal: 人間の git 操作が進行中、または巻き戻し不能。対処後に再起動すること");
            break;
          }
        }

        runHousekeeping(state);
      }

      // 停止指示はシグナルハンドラがメモリ上で進めるだけなので、state.json への写し
      // (status / watch の表示専用)はメインループ上でだけ書く(不変条件を守るため)
      const stopMode = readStopMode();
      if ((state.stopMode ?? "none") !== stopMode) {
        state.stopMode = stopMode;
        saveState(state);
      }
      const dirtyPaths = stopMode === "none" ? [] : dirtyPathsOutsideAgent();

      // 解除時刻を過ぎた rate limit は判断材料を作る前に state から落とす
      let rateLimitedUntilMs: number | null = null;
      if (state.rateLimit.resumeAt !== null) {
        const waitMs = new Date(state.rateLimit.resumeAt).getTime() - Date.now();
        if (waitMs > 0) {
          rateLimitedUntilMs = waitMs;
        } else {
          state.rateLimit.resumeAt = null;
          saveState(state);
        }
      }

      // 上位の判断で周回が確定する場合、下位の判断材料は集めない。hashInputs は state を、
      // selectRunnable はタスクファイルを書き換える副作用を持つため、その判断を実際に使う
      // 周回でだけ動かす(planLoopStep の優先度 1〜2 が成立する周回では使われない)。
      const gathering = stopMode === "none" && rateLimitedUntilMs === null;

      // 人間からの入力(GOAL.md・Human Review の回答)の変更検出。確認済みハッシュの更新は
      // runExploreSession 側(レートリミット時は更新されず再試行される)
      let inputsChanged = false;
      // triage(mainLoop の action=triage 分岐)が対象にした入力ハッシュを覚えておくため、
      // gathering の間だけ計算したハッシュをループの後段でも参照できるようにする
      let currentInputsHash: string | null = null;
      if (gathering) {
        currentInputsHash = hashInputs();
        if (state.inputsHash === undefined || state.inputsHash === null) {
          state.inputsHash = currentInputsHash; // 初回はハッシュを覚えるだけ(次回の変更から検出)
          saveState(state);
        } else {
          inputsChanged = isInputsChanged(state.inputsHash, currentInputsHash);
        }
      }
      const triageAttempted =
        currentInputsHash !== null &&
        state.triageAttemptedHash !== undefined &&
        state.triageAttemptedHash !== null &&
        state.triageAttemptedHash === currentInputsHash;

      // 入力変化(inputsChanged)があっても起動は止めない(探索は枠の中でしか走らないため)。
      // 探索の起動条件が「実行可能タスクの有無」で分かれる以上、gathering の周回では常に必要になる。
      // triage や探索が確定する周回では結果を使わず副作用(依存が dead なタスクの blocked 落ち)
      // だけが走るが、この副作用は決定論的で何周回に分けて走っても結果が変わらないため害はない。
      const { runnable, snoozedCount } = gathering ? selectRunnable() : { runnable: [], snoozedCount: 0 };

      // clean 停止中でも、衝突解消待ちの worktree を抱えたタスクだけは例外的に起動する
      // (衝突解消はセッションを起動しないと進まないため)。selectRunnable は副作用を持つので
      // ここでは使わず、副作用のない selectConflictResumable で選ぶ。rate limit 中は
      // planLoopStep がどのみち起動しないため、worktree ごとの git 呼び出しも省く。
      const conflictResumable =
        stopMode === "clean" && runningCount === 0 && rateLimitedUntilMs === null
          ? selectConflictResumable(config, conflictResumeLaunched)
          : [];

      const action = planLoopStep({
        now: new Date(),
        stopMode,
        mainDirtyOutsideAgent: dirtyPaths.length > 0,
        runningCount,
        maxSessions: config.parallel.maxSessions,
        runnableTaskIds: runnable.map((t) => t.id),
        conflictResumeTaskIds: conflictResumable.map((t) => t.id),
        inputsDirty: inputsChanged,
        mainDirty: mainChangedSinceExplore,
        triageEnabled: config.triage.enabled,
        triageAttempted,
        exploreEnabled: config.explore.enabled,
        // 現状の構造では探索を await するためここは常に false になるが、
        // 不変条件(探索中は起動しない)を planLoopStep 側にも渡しておく
        exploreRunning: state.runningSessions.some((s) => s.kind === "explore"),
        exploreDue:
          state.lastExploreAt === null ||
          Date.now() - new Date(state.lastExploreAt).getTime() >= config.explore.minIntervalMs,
        neverExplored: state.lastExploreAt === null,
        lastExploreYieldedNothing,
        lastExploreFastCrashed,
        pendingSnoozeCount: snoozedCount,
        rateLimitedUntilMs,
        idlePollMs: config.idlePollMs,
        fastCrashStreak,
      });

      if (action.type === "stop") {
        // planLoopStep は実行中セッションが 0 のときしか stop を返さないので通常は空だが、
        // 後始末を取りこぼさないよう最後にもう一度掃き出す
        drainCompletedSessions(config);
        log(action.reason);
        if (dirtyPaths.length > 0) log(`残った差分: ${formatDiffPathList(dirtyPaths)}`);
        // 解消セッションが再び衝突した場合や idle-exit の場合、衝突解消待ちの worktree が残りうる。
        // 放置すると忘れられるため、次回 run が再開することまで含めて明示する
        const pendingConflicts = collectPendingConflicts(repoPaths().root, config.parallel.worktreeDir).worktrees;
        if (pendingConflicts.length > 0) {
          log(
            `衝突解消待ちの worktree が ${pendingConflicts.length} 件残っている(${pendingConflicts.map((w) => w.taskId).join(", ")})。次の ccloop run が同じ worktree で解消セッションを再開する`,
          );
        }
        if (action.cause === "idle-exit") {
          const idleExitTasks = loadTasks();
          const blockedCount = idleExitTasks.filter((t) => t.status === "blocked").length;
          const failedCount = idleExitTasks.filter((t) => t.status === "failed").length;
          const openBlockCount = classifyHumanReview(parseHumanReview()).openBlock.length;
          if (blockedCount + failedCount + openBlockCount > 0) {
            log(
              `残件: blocked ${blockedCount} 件 / failed ${failedCount} 件 / human-review(BLOCK) ${openBlockCount} 件 — 詳細は ccloop status`,
            );
          }
          log("対応後、再開するには ccloop run を実行する");
        }
        break; // .agent/ の最終フラッシュは finally の commitAgentDir() が行う
      }

      if (action.type === "triage") {
        const ok = await runHumanReviewTriage(config);
        if (!ok) log("警告: triage セッションに失敗した。次回は Stage 3(探索)にフォールバックする");
        // 無限リトライ防止のため、成功・失敗に関わらずこの入力ハッシュへの triage 試行を記録する
        const st = loadState();
        st.triageAttemptedHash = currentInputsHash;
        saveState(st);
        continue;
      }

      if (action.type === "explore") {
        const { goalChanged, newAnsweredIds } = diffInputs(state, {
          goalHash: currentGoalHash(),
          answeredKeys: currentAnsweredKeys(),
        });
        const reason =
          action.trigger === "idle"
            ? "実行可能なタスクがなく、前回探索以降に main / 入力が変化したため、次の作業を探す"
            : "前回探索から一定時間が経過し、main / 入力が変化したため、タスク起動前に全体を見直す";
        // 探索セッションの起動直前にも記録を片付ける。走行中セッションがあっても記録が
        // 溜まり続けないよう、「セッションが 0 の周回」に加えてここも契機にしている。
        // この区間は mainLoop の同期区間でマージ・自動コミットが走らないため安全に動かせ、
        // 探索セッション自身も整理後の記録を読める。
        runHousekeeping(state);
        commitAgentDir();
        // 探索セッションの前後で main の `.agent/tasks/` の ID 集合を比べ、新規登録の有無を見る。
        // 片付けでアーカイブされた分を新規登録と誤認しないよう、基準は片付けの後で取る。
        // 並走するタスクセッションは専用 worktree で動き、その成果が main へ現れるのは
        // ループ先頭の drainCompletedSessions()(同期実行)による自動マージ時なので、
        // この await の区間で main にタスクが増えるのは探索セッション自身の仕業に限られる。
        const taskIdsBefore = new Set(loadTasks().map((t) => t.id));
        const { rateLimited, fastCrashed } = await runExploreSession(config, reason, {
          trigger: action.trigger,
          goalChanged,
          newAnsweredIds,
          runningTasks: runningTaskSummaries(state),
        });
        lastExploreFastCrashed = fastCrashed;
        const yielded = loadTasks().some((t) => !taskIdsBefore.has(t.id));
        // rate limit による中断・瞬時クラッシュは探索完了として扱わない(解除後・クールダウン後に
        // 再試行させる)。その場合は main の変化(mainDirty)も空振り判定も更新しない
        // (中断前の状態を引きずらせない)
        if (!rateLimited && !fastCrashed) {
          mainChangedSinceExplore = false;
          lastExploreYieldedNothing = !yielded;
        }
        continue;
      }

      if (action.type === "launch") {
        // 空きスロット分をまとめて起動する。await しないので、次の周回はすぐ回り、
        // 完了は completedSessions 経由で先頭の掃き出しへ戻ってくる
        const byId = new Map([...runnable, ...conflictResumable].map((t) => [t.id, t]));
        let launched = 0;
        for (const taskId of action.taskIds) {
          const task = byId.get(taskId);
          if (task === undefined) continue; // 判断材料と実行の間でタスクが消えた場合の保険
          // 起動の成否に関わらず記録する(起動できない状態で同じタスクを選び続けないため)
          if (action.conflictResume === true) conflictResumeLaunched.add(taskId);
          const ok = launchTaskSession(config, task);
          if (ok) launched += 1;
          // 起動できなかった 1 件は次の周回で選び直す(startTaskSession 側でログ済み)。
          // ただし停止中の衝突解消は 1 回きりなので、次の周回では選び直さず停止へ進む
          if (action.conflictResume === true) {
            log(
              ok
                ? `停止指示 (clean) 中だが衝突解消待ちの worktree があるため、衝突解消セッションを起動した (${taskId})。完了後に停止する。即停止するにはもう一度 Ctrl+C`
                : `停止指示 (clean) 中の衝突解消セッションの起動に失敗した (${taskId})。このタスクは再試行せず停止に進む`,
            );
          }
        }
        // 停止中の衝突解消は起動に失敗しても次の周回で即 stop が確定するため、待つ意味がない
        if (launched === 0 && action.conflictResume !== true) {
          // 1 件も起動できなかった(.agent をコミットできない等)場合、同じ条件で即座に
          // 選び直すと空回りし続けるため、状況が変わるのを待ってから次の周回へ進む
          await sleep(config.idlePollMs);
        }
        continue;
      }

      // wait: `.agent/` のコミットはここでは行わない。頻繁な待機のたびにコミットすると
      // 内容を語らない定型コミットが積み上がるため、コミットはタスク起動前・main マージ前・
      // ループ終了時の finally に集約している。
      // sleep は wakeEmitter でも起きるため、走っているセッションの完了は待機を打ち切って
      // 先頭の掃き出しへ戻す(idlePollMs を待たされない)
      if (action.why === "rate-limit") log(`rate limit 待機中(${Math.ceil(action.ms / 60000)} 分)`);
      if (action.why === "crash-backoff") {
        log("警告: 瞬時クラッシュが連続している。環境要因の可能性が高いため 1 周回だけ起動を抑制する");
      }
      await sleep(action.ms);
      // crash-backoff は 1 周回だけ起動を見送るルールなので、待機を終えたら基本的にここで
      // 解除する(fastCrashStreak を更新するもう一方の場所である finishTaskSession は、抑制中は
      // セッションが起動せず呼ばれないため、ここでリセットしないと抑制が解けなくなる)。
      // ただし sleep は wakeEmitter でも早期に起きるため、待機中に Ctrl+C で停止指示が入った
      // 場合に備えて stopMode を待機明けに読み直す(停止処理中は fastCrashStreakAfterWait が
      // リセットしない)。
      fastCrashStreak = fastCrashStreakAfterWait(fastCrashStreak, action.why, readStopMode());
    }
  } finally {
    // タイマーを先に止めてから生存記録を消す(clearRunnerRecord 後にタイマーが発火して
    // 記録を復活させてしまうのを防ぐ)。
    clearInterval(heartbeat);
    // break・例外・正常終了のいずれの経路でも 1 回だけ最終フラッシュする。finally は
    // break が効く前に走るため、抜け道は構造的に存在しない(break 側に手を入れる必要がない)。
    commitAgentDir();
    // 表示用の停止指示もプロセスと一緒に畳む(緊急停止は process.exit するためここを通らないが、
    // その場合は次回 run の起動時のリセットが拾う)
    publishStopMode("none");
    // 正常終了では生存記録を消す。緊急停止(process.exit)ではここを通らないが、その場合は
    // PID の存在確認(isProcessAlive)が「動いていません」を返すので誤って running とは出ない
    clearRunnerRecord(repoPaths().runnerPath);
  }
  log("supervisor stop");
}

// ---------- CLI サブコマンド ----------

/**
 * 新規タスクの ID(`T-<YYYYMMDD>-<HHMM>-<slug>`)を作る。
 * archive 済みタスクの ID も母集団に含め、ローテーション後の ID 再利用・衝突を防ぐ
 * (旧形式 `T-NNN` のファイルもそのまま母集団に入る)。
 */
export function newTaskId(slug: string, createdAt: string): string {
  const taken = new Set(
    [...listMdFiles(repoPaths().tasksDir), ...listMdFiles(path.join(repoPaths().archiveDir, "tasks"))].map((f) =>
      f.replace(/\.md$/, ""),
    ),
  );
  return disambiguateId(buildId("T", slug, createdAt), (id) => taken.has(id));
}

const ADD_FLAG_NAMES = ["desc", "priority", "deps", "model", "slug"];

/**
 * argv からフラグとその直後の値を除いた位置引数のみを抽出する。
 * `--desc` を npm 経由で `--` なしに渡すと description ショートハンド展開により
 * 値が位置引数として渡ってくる場合があるため、title に続く 2 個目以降を
 * body のフォールバックに使う(フラグの値と誤認しないよう既知フラグの直後は除外する)。
 */
function positionalArgs(argv: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (ADD_FLAG_NAMES.includes(a.slice(2))) i++;
      continue;
    }
    positional.push(a);
  }
  return positional;
}

/**
 * 新規タスクの ID に使う slug を決定する。`explicit`(`--slug`)が指定されていればその妥当性を
 * 検証して使う(不正なら throw)。未指定なら title から生成し、日本語だけのタイトルなど
 * slugify が null を返す入力では既定値 "task" にフォールバックする(採番自体は必ず成功させる)。
 * process.exit を伴わない純粋関数にして cmdAdd から切り出し、単体テストできるようにしている。
 */
export function resolveTaskSlug(title: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!isValidSlug(explicit)) {
      throw new Error(
        `--slug は小文字英数字とハイフンのみ・${SLUG_MAX_LENGTH} 文字以内で指定する(例: fix-login-retry): ${explicit}`,
      );
    }
    return explicit;
  }
  return slugify(title) ?? "task";
}

/**
 * `--priority` の値を決定する。`raw` が未指定なら既定値 3(新規タスクは通常このあたりの優先度)を
 * 返す。指定されている場合は整数であることのみ検証する(1 が最高優先度という意味はあるが、
 * 1〜5 のような範囲は仕様として定まっていないため範囲チェックはしない)。不正な値(数値でない、
 * 小数、Infinity、空文字など)は throw する。process.exit を伴わない純粋関数にして cmdAdd から
 * 切り出し、単体テストできるようにしている。
 *
 * 判定に `Number()` の結果ではなく整数リテラルの正規表現を使うのは、`Number()` が空文字・
 * 空白のみの文字列を 0 に、"0x10" を 16 に変換してしまい、ユーザーの意図と違う priority が
 * エラーにならず書き込まれるためである。
 */
export function resolvePriority(raw: string | undefined): number {
  if (raw === undefined) return 3;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`--priority は整数で指定する(例: 2): ${raw}`);
  }
  return Number(raw.trim());
}

/**
 * `--deps` の値をカンマ区切りのタスク ID 配列に変換する。`raw` が未指定なら空配列を返す。
 * "T-a, T-b" のようにカンマの後に空白を入れるのは自然な書き方なので各要素を trim し、
 * 空要素(連続カンマや末尾カンマ由来)は捨てる。trim しないと " T-b" のような先頭空白付き ID が
 * 登録され、依存関係が黙って無効になる。
 */
export function parseDeps(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `deps` の各 ID が `knownIds` に実在するか検証する。存在しない ID を書いたタスクは
 * 依存が満たされず永久に選ばれないが、`add` した本人には成功メッセージしか出ないため、
 * その場でエラーにして気付けるようにする。completed タスクへの依存は正当なので、
 * 突き合わせ先には `.agent/archive/tasks` の ID も含める(呼び出し側が `allTaskIds()` を渡す)。
 */
export function assertDepsExist(deps: string[], knownIds: string[]): void {
  if (deps.length === 0) return;
  const knownSet = new Set(knownIds);
  const missing = deps.filter((id) => !knownSet.has(id));
  if (missing.length === 0) return;
  const lines = [`--deps に存在しないタスク ID があります: ${missing.join(", ")}`];
  for (const id of missing) {
    const suggestions = suggestSimilarTaskIds(id, knownIds);
    if (suggestions.length > 0) lines.push(`  ${id} → もしかして: ${suggestions.join(", ")}`);
  }
  throw new Error(lines.join("\n"));
}

export function cmdAdd(argv: string[]): void {
  const positional = positionalArgs(argv);
  const title = positional[0];
  if (!title) {
    console.error(usageOf("add"));
    process.exit(1);
  }
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const now = new Date().toISOString();
  const fallbackBody = positional.slice(1).join("\n") || title;
  let slug: string;
  let priority: number;
  let dependencies: string[];
  try {
    slug = resolveTaskSlug(title, opt("slug"));
    priority = resolvePriority(opt("priority"));
    dependencies = parseDeps(opt("deps"));
    if (dependencies.length > 0) assertDepsExist(dependencies, allTaskIds());
  } catch (err) {
    console.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const task: Task = {
    id: newTaskId(slug, now),
    title,
    status: "ready",
    priority,
    dependencies,
    retries: 0,
    conflictRetries: 0,
    createdAt: now,
    body: opt("desc") ?? fallbackBody,
  };
  const model = opt("model");
  if (model !== undefined) task.model = model;
  saveTask(task);
  console.log(`追加: .agent/tasks/${task.id}.md "${task.title}" (priority=${task.priority})`);
}

// ---------- retry ----------

/** `.agent/tasks/<id>.md` のパス */
function taskFilePath(id: string): string {
  return path.join(repoPaths().tasksDir, `${id}.md`);
}

/** `.agent/archive/tasks/<id>.md` のパス(completed タスクの退避先) */
function archivedTaskFilePath(id: string): string {
  return path.join(repoPaths().archiveDir, "tasks", `${id}.md`);
}

/** 先頭の `<prefix>-<YYYYMMDD>-<HHMM>-` を除いた slug 部分(新形式以外・パターン外はそのまま返す) */
function slugPartOf(id: string): string {
  const m = /^[A-Za-z]+-\d{8}-\d{4}-(.+)$/.exec(id);
  return m ? m[1]! : id;
}

/** slug 部分をハイフンで区切ったトークン一覧(小文字化、空要素なし) */
function slugTokensOf(id: string): string[] {
  return slugPartOf(id).toLowerCase().split("-").filter(Boolean);
}

/**
 * `ccloop retry` で ID を取り違えたときの「もしかして」候補(最大 3 件)。
 * 素朴な近さ判定: 小文字化した ID どうしの部分文字列一致、または slug 部分のハイフン区切り
 * トークンを 1 つ以上共有していれば候補とし、共有トークン数の多い順・ID 昇順で並べる。
 */
export function suggestSimilarTaskIds(query: string, candidateIds: string[]): string[] {
  const queryLower = query.toLowerCase();
  const queryTokens = new Set(slugTokensOf(query));
  const scored: { id: string; shared: number }[] = [];
  for (const id of new Set(candidateIds)) {
    const idLower = id.toLowerCase();
    const shared = slugTokensOf(id).filter((t) => queryTokens.has(t)).length;
    const substringMatch = idLower.includes(queryLower) || queryLower.includes(idLower);
    if (substringMatch || shared > 0) scored.push({ id, shared });
  }
  scored.sort((a, b) => b.shared - a.shared || a.id.localeCompare(b.id));
  return scored.slice(0, 3).map((s) => s.id);
}

/**
 * すべてのタスク ID(.agent/tasks + .agent/archive/tasks)。retry の「もしかして」候補の母集団、
 * および add の `--deps` 実在チェックの突き合わせ先として使う。
 */
export function allTaskIds(): string[] {
  return [...listMdFiles(repoPaths().tasksDir), ...listMdFiles(path.join(repoPaths().archiveDir, "tasks"))].map(
    (f) => f.replace(/\.md$/, ""),
  );
}

/**
 * body 内「## 試行履歴」セクションのうち最後の `### ` サブセクション(見出し行とその本文、
 * 次の `### ` または `## ` の直前まで)を取り出す。セクション自体・サブセクションが
 * 無ければ null。
 */
export function lastAttemptHistoryEntry(body: string): string | null {
  const lines = body.split("\n");
  const headingIdx = lines.findIndex((l) => l === ATTEMPT_HISTORY_HEADING);
  if (headingIdx === -1) return null;

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }
  const sectionLines = lines.slice(headingIdx + 1, sectionEnd);

  let lastStart = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    if (sectionLines[i]!.startsWith("### ")) lastStart = i;
  }
  if (lastStart === -1) return null;
  return sectionLines.slice(lastStart).join("\n").trim();
}

/** text を maxLines 行に切り詰める。切り詰めた場合のみ末尾に「(以下略)」を付ける */
function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n(以下略)`;
}

/**
 * retry でタスクを ready へ戻す直前に、直前の失敗理由を stdout へ表示する。
 * note と試行履歴の最後のエントリのどちらも無ければその旨を 1 行出す。
 */
function printPreviousFailureReason(task: Task): void {
  let printed = false;
  if (task.note !== undefined) {
    console.log(`直前の記録: ${task.note}`);
    printed = true;
  }
  const lastEntry = lastAttemptHistoryEntry(task.body);
  if (lastEntry !== null) {
    console.log(truncateLines(lastEntry, 20));
    printed = true;
  }
  if (!printed) console.log("直前の失敗理由の記録はありません。");
}

/**
 * `ccloop retry <タスクID>`。failed / blocked のタスクを status: ready / retries: 0 /
 * conflictRetries: 0 へ戻し、次の周回で再選択されるようにする。実行中のタスクや、
 * failed / blocked 以外の status は対象外(安全のため何も変更せず終了する)。
 */
export function cmdRetry(argv: string[]): void {
  if (argv.length !== 1 || argv[0]!.startsWith("-")) {
    console.error(usageOf("retry"));
    process.exit(1);
  }
  const id = argv[0]!;

  if (!fs.existsSync(taskFilePath(id))) {
    if (fs.existsSync(archivedTaskFilePath(id))) {
      console.error(`タスク ${id} は完了済みとして .agent/archive/tasks/ へ退避されています。`);
      console.error("やり直す場合はファイルを .agent/tasks/ へ戻してから再実行してください。");
      process.exit(1);
    }
    console.error(`タスクが見つかりません: ${id}`);
    const suggestions = suggestSimilarTaskIds(id, allTaskIds());
    if (suggestions.length > 0) {
      console.error("もしかして:");
      for (const s of suggestions) console.error(`  ${s}`);
    }
    process.exit(1);
  }

  const state = loadState();
  const runningTaskIds = new Set(
    state.runningSessions.map((s) => s.taskId).filter((tid): tid is string => tid !== undefined),
  );
  if (runningTaskIds.has(id)) {
    console.error(`タスク ${id} は実行中です。セッションの終了を待ってから再実行してください。`);
    process.exit(1);
  }

  const task = loadTask(id);
  if (task === null) {
    // ファイルは存在するが frontmatter の status が不正で読めない(通常起こらない想定)
    console.error(`タスクが見つかりません: ${id}`);
    process.exit(1);
  }
  if (task.status !== "failed" && task.status !== "blocked") {
    console.error(
      `タスク ${id} の status は ${task.status} です(failed / blocked のみやり直せます)。何も変更していません。`,
    );
    process.exit(1);
  }

  printPreviousFailureReason(task);

  task.status = "ready";
  task.retries = 0;
  task.conflictRetries = 0;
  const hadSnooze = task.snoozeUntil !== undefined;
  if (hadSnooze) task.snoozeUntil = undefined;
  saveTask(task);
  if (hadSnooze) console.log("待機指定(snoozeUntil)を解除しました。");
  console.log(`タスク ${id} を再実行対象に戻しました(status: ready / retries: 0 / conflictRetries: 0)。`);
}

// ---------- 表示共通(色・ステータス表現) ----------

type StyleFormat = Parameters<typeof styleText>[0];

/** cmdList / cmdStatus で共通のステータス表現(記号・色・表示順) */
const STATUS_ORDER: TaskStatus[] = ["working", "ready", "blocked", "failed", "completed"];

const STATUS_META: Record<TaskStatus, { symbol: string; color: StyleFormat }> = {
  working: { symbol: "▶", color: "cyan" },
  ready: { symbol: "●", color: "blue" },
  blocked: { symbol: "■", color: "yellow" },
  failed: { symbol: "✖", color: "red" },
  completed: { symbol: "✔", color: "green" },
};

/** 例: 「▶ working」を色付きで返す */
function statusLabel(status: TaskStatus): string {
  const meta = STATUS_META[status];
  return styleText(meta.color, `${meta.symbol} ${status}`);
}

/** note の 1 行目のみを対象に、コードポイント基準で maxLen 文字に切って「…」を付ける */
function truncateNote(note: string, maxLen = 80): string {
  const firstLine = note.split("\n")[0] ?? "";
  const chars = Array.from(firstLine);
  if (chars.length <= maxLen) return firstLine;
  return chars.slice(0, maxLen).join("") + "…";
}

// ---------- list ----------

/**
 * 1 タスクの表示(id/priority/title 行 + 依存行 + note 行)。
 * ID は slug を含んで長さがまちまちなため、桁揃えの幅は呼び出し側が一覧全体から決めて渡す。
 */
function printTaskLine(t: Task, byId: Map<string, Task>, full: boolean, idWidth: number): void {
  const idCol = t.id.padEnd(idWidth);
  let line = `  ${idCol}p${t.priority}  ${t.title}`;
  if (t.retries > 0) {
    line += ` ${styleText("yellow", `retries=${t.retries}`)}`;
  }
  if (t.conflictRetries > 0) {
    line += ` ${styleText("yellow", `衝突=${t.conflictRetries}`)}`;
  }
  if (t.snoozeUntil !== undefined && isSnoozed(t, new Date())) {
    line += ` ${styleText("dim", `[snoozed until ${t.snoozeUntil}]`)}`;
  }
  console.log(line);

  if (t.dependencies.length > 0) {
    const parts = t.dependencies.map((d) => {
      const dep = byId.get(d);
      if (dep === undefined) return `${d}(missing)`;
      return dep.status === "completed" ? `${d}✔` : `${d}(${dep.status})`;
    });
    // 依存先が byId(現役+archive)に無い(= missing)場合はスケジューリング上は充足扱いだが、
    // 打ち間違いに気づけるよう表示上は淡色にしない
    const allSatisfied = t.dependencies.every((d) => byId.has(d) && depSatisfied(byId, d));
    const depsLine = `    deps: ${parts.join(" ")}`;
    console.log(allSatisfied ? styleText("dim", depsLine) : depsLine);
  }

  if (t.note) {
    if (full) {
      // 1 行目は "    note: ..." に揃え、2 行目以降はその文字数(6 文字分)を空けて縦を揃える
      const [firstLine, ...restLines] = t.note.split("\n");
      const noteText = [`    note: ${firstLine}`, ...restLines.map((l) => `          ${l}`)].join(
        "\n",
      );
      console.log(styleText("dim", noteText));
    } else {
      console.log(styleText("dim", `    note: ${truncateNote(t.note)}`));
    }
  }
}

export function cmdList(argv: string[]): void {
  const full = argv.includes("--full");
  const tasks = loadTasks();
  if (argv.includes("--json")) {
    // タスクは frontmatter のフィールドをそのまま持つので、--full の有無に関わらず全フィールドを
    // 出す(整形出力のような省略・切り詰めをしない)。JSON.stringify して 1 行で出す
    console.log(JSON.stringify({ tasks }));
    return;
  }
  // 依存表示用の参照は archive 済みタスクも含める(rotate 後の依存先を (missing) ではなく
  // ✔ 完了として表示するため)。同一 ID はアクティブ側を優先
  const byId = new Map([...loadArchivedTasks(), ...tasks].map((t) => [t.id, t]));
  // 表示する ID の最大長 + 区切りの 2 文字で桁を揃える(旧形式の短い ID だけなら従来どおり 7 桁)
  const idWidth = tasks.reduce((w, t) => Math.max(w, t.id.length), 5) + 2;

  let printedGroup = false;
  for (const status of STATUS_ORDER) {
    const group = tasks.filter((t) => t.status === status);
    if (group.length === 0) continue;
    if (status === "ready") {
      group.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    } else {
      group.sort((a, b) => a.id.localeCompare(b.id));
    }
    if (printedGroup) console.log("");
    printedGroup = true;
    console.log(`${statusLabel(status)} (${group.length})`);
    for (const t of group) printTaskLine(t, byId, full, idWidth);
  }
  if (!printedGroup) console.log("タスクなし");
}

// ---------- 人間向け: status ----------

/**
 * 回答済み判定は `status` フィールド単体では行わない(チェックボックス方式では `status: open` の
 * ままチェックだけ入る状態が正常なため)。必ず `isAnsweredEntry({ status, body })` を使う。
 */
interface HrEntry {
  /** ファイル名(拡張子を除く)が ID */
  id: string;
  title: string;
  status: string;
  importance: string;
  /** ファイル全文(回答の書き換え検出に使う) */
  raw: string;
  /** frontmatter 以降の本文(triage の判定材料) */
  body: string;
  /** status 表示用の一言(hrSummary の結果。無ければ空文字) */
  summary: string;
}

/**
 * Human Review 本文から status 表示用の一言(なければ空文字)を取り出す。
 * `## 確認事項` 見出しがあればその直後、無ければ本文全体の冒頭から、見出し行(# で始まる行)と
 * 空行を読み飛ばして最初に現れた段落を採用する。Markdown のソフトラップ(1 文が複数行に折り返されて
 * いる書き方)で途中切れしないよう、空行に当たるまでの連続行を 1 行に連結してから、飾り(先頭のリスト/
 * 引用記号、強調記号、バッククォート)を落として maxLen 文字に切り詰める。
 */
export function hrSummary(body: string, maxLen = 80): string {
  const lines = body.split("\n");
  const headingIndex = lines.findIndex((l) => l.trim() === "## 確認事項");
  const searchLines = headingIndex === -1 ? lines : lines.slice(headingIndex + 1);
  const start = searchLines.findIndex((l) => {
    const trimmed = l.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  if (start === -1) return "";
  const paragraph: string[] = [];
  for (const l of searchLines.slice(start)) {
    const trimmed = l.trim();
    if (trimmed === "" || trimmed.startsWith("#")) break;
    paragraph.push(trimmed);
  }
  // 折り返しの連結。日本語は行末・行頭に空白が入らない書き方なので、境界が両側とも非 ASCII の
  // ときだけ空白なしで繋ぎ、英数字が絡む場合は単語が潰れないよう空白を挟む
  let cleaned = paragraph.reduce((acc, line) => {
    if (acc === "") return line;
    const boundary = `${acc.slice(-1)}${line.slice(0, 1)}`;
    return /^[^\p{ASCII}]{2}$/u.test(boundary) ? acc + line : `${acc} ${line}`;
  }, "");
  // 先頭のリスト/引用記号(- / * / > とその組み合わせ)を繰り返し剥がす
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/^[-*>]\s+/, "");
  } while (cleaned !== prev);
  // 強調記号・バッククォートを除去し、空白を畳む
  cleaned = cleaned
    .replace(/\*\*|__|\*|_|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return "";
  return truncateForDisplay(cleaned, maxLen);
}

/** .agent/human-review/ の各ファイルをエントリとして読む */
function parseHumanReview(): HrEntry[] {
  return listMdFiles(repoPaths().humanReviewDir).map((fileName) => {
    const id = fileName.replace(/\.md$/, "");
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(repoPaths().humanReviewDir, fileName), "utf8");
    } catch {}
    const { data, body } = parseFrontmatter(raw);
    return {
      id,
      title: str(data.title) || id,
      status: str(data.status) || "?",
      importance: str(data.importance) || "?",
      raw,
      body,
      summary: hrSummary(body),
    };
  });
}

/**
 * Human Review 一覧を「未回答(BLOCK)」「未回答(REVIEW/INFO)」「回答済み」に分類する(述語ベース。
 * status フィールドだけでは分類できない = チェックボックス方式では `status: open` のまま
 * チェックだけ入るため、`isAnsweredEntry` で判定する)。closed は除外する。
 */
export function classifyHumanReview(hr: HrEntry[]): {
  openBlock: HrEntry[];
  openReview: HrEntry[];
  answered: HrEntry[];
} {
  const notClosed = hr.filter((h) => h.status !== "closed");
  const answered = notClosed.filter((h) => isAnsweredEntry({ status: h.status, body: h.body }));
  const open = notClosed.filter((h) => !isAnsweredEntry({ status: h.status, body: h.body }));
  return {
    openBlock: open.filter((h) => h.importance === "BLOCK"),
    openReview: open.filter((h) => h.importance !== "BLOCK"),
    answered,
  };
}

/**
 * Human Review 1 件の frontmatter status を closed に更新する。note があれば本文末尾に
 * `対応: <note>` を追記する(既存の探索セッションが人間向けに使ってきた記法を踏襲)。
 * note を省略すると本文は変更しない(Stage 1 の決定論クローズ用)。
 */
export function closeHumanReview(id: string, note?: string): void {
  const file = path.join(repoPaths().humanReviewDir, `${id}.md`);
  const { data, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
  data.status = "closed";
  const newBody = note === undefined ? body : `${body}\n\n対応: ${note}`;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serializeFrontmatter(data, newBody));
  fs.renameSync(tmp, file);
}

/**
 * Human Review の回答を段階的に処理する(Stage 1: 決定論判定 / Stage 2: 軽量モデル判定)。
 * BLOCK エントリは常に対象外(Stage 3 のフル探索でのみ扱う)。
 *
 * 戻り値は claude 呼び出し(Stage 2)が正常に完了したか。判定できなかった件数があっても、
 * それ自体は失敗ではない(次回 Stage 3 へ自動フォールバックする設計のため true を返す)。
 * claude の起動・応答解釈が例外を投げた場合のみ false を返し、rate limit への連動はしない
 * (triage は軽量な判定であり、失敗しても素通りしてよい)。
 */
async function runHumanReviewTriage(config: Config): Promise<boolean> {
  try {
    const answered = parseHumanReview()
      .filter((h) => isAnsweredEntry({ status: h.status, body: h.body }))
      .map((h) => ({ id: h.id, title: h.title, importance: h.importance, status: h.status, body: h.body }));

    const closedIds = new Set(selectDeterministicCloses(answered));
    for (const id of closedIds) closeHumanReview(id);
    if (closedIds.size > 0) {
      log(`triage: 「対応不要」マーカーで ${closedIds.size} 件を自動クローズ`);
    }

    const stage2 = selectLightTriageCandidates(answered, closedIds);
    if (stage2.length === 0) return true;

    const tasks: TaskSummary[] = loadTasks().map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
    }));

    log(`${styleText("cyan", "▶")} triage セッションを開始 (${stage2.length} 件, model=${config.triage.model})`);
    const res = await runClaude(config, buildTriagePrompt(stage2, tasks), config.triage.model, repoPaths().root, {
      extraArgs: ["--disallowed-tools", "Edit Write Task TodoWrite WebFetch WebSearch Bash", "--max-turns", "6"],
      // triage は「回答を仕分けて JSON を返すだけ」の読み取り専用セッション。共通ルール
      // (worktree 運用・記録ファイルの書き方・reviewer への委譲)はどれも実行できない
      // 指示になるため注入しない。サブエージェントも Task が禁止されていて起動できない。
      commonRules: false,
      env: { CLAUDE_AGENT_SESSION_KIND: "triage" },
    });
    recordMetrics({ kind: "triage", model: config.triage.model, res, sessionCwd: repoPaths().root });

    const json = parseResultJson(res);
    const text = typeof json?.result === "string" ? json.result : "";
    const validIds = new Set(stage2.map((c) => c.id));
    const decisions = parseTriageResponse(text, validIds);

    let applied = 0;
    for (const d of decisions) {
      if (d.action === "close") {
        closeHumanReview(d.id, d.reason);
        applied += 1;
      } else if (d.action === "task") {
        const createdAt = new Date().toISOString();
        const id = newTaskId(d.slug, createdAt);
        saveTask({
          id,
          title: d.title,
          status: "ready",
          priority: d.priority,
          dependencies: [],
          retries: 0,
          conflictRetries: 0,
          createdAt,
          body: d.body,
        });
        closeHumanReview(d.id, `タスク ${id} を登録`);
        applied += 1;
      }
      // escalate・未言及の id: 何もしない(answered のまま残し、Stage 3 のフル探索へ委ねる)
    }
    log(
      applied > 0
        ? `${styleText("green", "✔")} triage セッション終了 (${applied}/${stage2.length} 件を処理, session ${sessionId(res)})`
        : `triage セッション終了 (判定できず、Stage 3 の探索へ委ねる, session ${sessionId(res)})`,
    );
    return true;
  } catch (err) {
    log(`警告: triage セッションに失敗した: ${String(err)}`);
    return false;
  }
}

/** 進捗バー(例: 「完了 5/15 [██████░░░░░░░░░░░░]」) */
function progressBar(completed: number, total: number, width = 20): string {
  const filled = total === 0 ? 0 : Math.round((completed / total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `完了 ${completed}/${total} [${bar}]`;
}

/** [要対応]/[確認推奨]/[対応不要] のタグ部分だけ色付けする */
const SECTION_TAG_STYLE: Record<string, StyleFormat> = {
  "要対応": ["red", "bold"],
  "確認推奨": "yellow",
  "対応不要": "dim",
  "概観": "cyan",
};

function styledSectionLabel(tag: string, rest: string): string {
  const style = SECTION_TAG_STYLE[tag];
  const styledTag = style !== undefined ? styleText(style, `[${tag}]`) : `[${tag}]`;
  return `${styledTag} ${rest}`;
}

/**
 * 次に実行されうるタスクを priority 昇順 → createdAt 昇順で返す。
 *
 * 判定基準を表示用に複製すると実際のスケジューラと乖離するため、mainLoop の selectRunnable と
 * 同じ planTaskSelection をそのまま呼ぶ(planTaskSelection は純粋で、状態は書き換えない)。
 * 実行中タスクは runningIds で除外する。これを渡さないと、実行中のタスクが「実行中」と
 * 「次に実行予定」の両方に重複表示される。
 */
function nextRunnableTasks(tasks: Task[], runningIds: ReadonlySet<string>, limit: number): Task[] {
  return planTaskSelection(tasks, new Date(), runningIds).runnable.slice(0, limit);
}

/**
 * スヌーズ中(解除待ち)のタスクを解除日時の昇順で返す。
 * run モードの自動終了判定(scheduler.ts の pendingSnoozeCount)と同じ
 * planTaskSelection().snoozed をそのまま使う(判定基準を表示用に複製しない)。
 */
function snoozedTasksByUntil(tasks: Task[], runningIds: ReadonlySet<string>): Task[] {
  return [...planTaskSelection(tasks, new Date(), runningIds).snoozed].sort(
    (a, b) => Date.parse(a.snoozeUntil ?? "") - Date.parse(b.snoozeUntil ?? ""),
  );
}

/** ミリ秒を人間向けの経過時間表記(45秒 / 12分 / 1時間5分)にする */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}時間${minutes}分`;
}

/**
 * 実行中セッションの表示行を返す。実行中でなければ空配列。
 * 状態は書き換えない(参照専用)。
 */
export function runningSessionLines(
  sessions: RunningSessionState[],
  byId: Map<string, Task>,
  now: Date,
  staleAfterMs: number,
  maxSessions: number,
  liveness: LoopLiveness,
): string[] {
  if (sessions.length === 0) return [];

  const stopped = liveness.status === "stopped";

  const lines = stopped
    ? [`※ ループ本体(ccloop run)が動いていないため、下記の ${sessions.length} 件は実行中ではなく記録が残っているだけ`]
    : [`実行中のセッション (${sessions.length}/${maxSessions})`];
  if (liveness.status === "unknown") {
    lines.push("※ ループ本体(ccloop run)の生存を確認できないため、下記は古い記録の可能性がある");
  }

  for (const s of sessions) {
    let mainLine: string;
    if (s.kind === "explore") {
      mainLine = "探索セッション  (次の作業を探索中)";
    } else {
      const id = s.taskId;
      if (id === undefined) {
        mainLine = "(タスク ID 不明)";
      } else {
        const t = byId.get(id);
        mainLine = t !== undefined ? `${t.id}  p${t.priority}  ${t.title}` : `${id}  (タスクファイルが見つからない)`;
      }
    }
    if (s.phase === "finishing") mainLine += "  マージ中";
    lines.push(mainLine);

    if (stopped) {
      if (!Number.isNaN(Date.parse(s.startedAt))) {
        lines.push(`  ${s.startedAt} 開始(ループ停止時のまま残った記録)`);
      }
      continue;
    }

    const startMs = Date.parse(s.startedAt);
    if (!Number.isNaN(startMs)) {
      const elapsedMs = now.getTime() - startMs;
      // 開始時刻はリポジトリ全体の慣習(toISOString() 系)に揃え、TZ 非依存の ISO 文字列のまま出す
      // (state.json に保存された値をそのまま表示するだけなので再フォーマットしない)
      lines.push(`  ${formatElapsed(elapsedMs)}経過 (${s.startedAt} 開始)`);
      if (elapsedMs > staleAfterMs) {
        lines.push(
          `  ※ タイムアウト(${Math.round(staleAfterMs / 60000)}分)を超過 — supervisor が停止していれば古い表示(次回起動時に復旧)`,
        );
      }
    }
  }

  return lines;
}

/**
 * JSONL の実行ログ(metrics / permission-denials)を status 表示のために読む量の上限。
 * 記録自体は上限なく残す方針のままで、読む量だけを絞る(古い行は表示の集計に入らない)。
 * このリポジトリでの実測は metrics が 1 行約 540 バイト・permission-denials が約 320 バイト。
 * 512 KiB / 1000 行はおよそ 1000 セッション分にあたり、1 日 10 セッション回しても 3 か月以上を
 * 覆う。ccloop watch は既定 1 秒ごとに読み直すため、この程度に抑えて描き直しの負荷を一定にする。
 */
const LOG_READ_MAX_BYTES = 512 * 1024;
const LOG_READ_MAX_ENTRIES = 1000;

/** 末尾読みの結果。truncated が true なら古い行を読み飛ばしている */
export interface TailReadResult {
  lines: string[];
  truncated: boolean;
}

/**
 * JSONL ファイルの末尾だけを読む。ファイルが無ければ空扱い。ファイルサイズが maxBytes 以下なら
 * 全体を読み、超えていれば末尾 maxBytes バイトだけを fs.openSync + fs.readSync(position 指定)で
 * 読む。この場合、先頭の行は途中で切れている可能性がある(UTF-8 の途中で切れた不正バイトも
 * 含めて)ため必ず捨てて truncated = true にする。さらに行数が maxEntries を超えていれば末尾
 * maxEntries 行だけに絞り、truncated = true にする。読み取りに失敗した場合(権限エラー等)は
 * 例外を投げず空扱いにする(status 表示を例外で落とさない既存方針に合わせる)。
 */
export function readTailLines(filePath: string, maxBytes: number, maxEntries: number): TailReadResult {
  try {
    if (!fs.existsSync(filePath)) return { lines: [], truncated: false };
    const size = fs.statSync(filePath).size;

    let text: string;
    let truncated = false;
    if (size <= maxBytes) {
      text = fs.readFileSync(filePath, "utf8");
    } else {
      const readSize = maxBytes;
      const position = size - readSize;
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(filePath, "r");
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(fd, buf, 0, readSize, position);
      } finally {
        fs.closeSync(fd);
      }
      // 要求より少なく読めた場合、buf の残りは 0 埋めのままなので実際に読めた分だけを使う
      // (末尾 = 最新の行が NUL 混じりになって JSON.parse に失敗するのを避ける)
      text = buf.subarray(0, bytesRead).toString("utf8");
      truncated = true;
    }

    let lines = text.split("\n");
    if (truncated) {
      // 先頭行は途中で切れている可能性があるため常に捨てる
      lines = lines.slice(1);
    }
    lines = lines.filter((l) => l.trim() !== "");

    if (lines.length > maxEntries) {
      lines = lines.slice(lines.length - maxEntries);
      truncated = true;
    }

    return { lines, truncated };
  } catch {
    return { lines: [], truncated: false };
  }
}

/** metrics.jsonl の末尾を読む。ファイルが無ければ空、壊れた行はスキップして続行する */
export function loadMetrics(
  metricsPath: string = repoPaths().metricsPath,
): { entries: SessionMetrics[]; truncated: boolean } {
  const { lines, truncated } = readTailLines(metricsPath, LOG_READ_MAX_BYTES, LOG_READ_MAX_ENTRIES);
  const entries: SessionMetrics[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SessionMetrics);
    } catch {}
  }
  return { entries, truncated };
}

/** .agent/OVERVIEW.md の内容。探索セッションが GOAL とタスク全体を突き合わせて更新する */
interface Overview {
  updatedAt: string;
  completed: number;
  total: number;
  body: string;
}

/** OVERVIEW.md のテキストをパースする。本文が空なら未生成扱いで null(壊れたファイルで例外を投げない) */
export function parseOverview(text: string): Overview | null {
  const { data, body } = parseFrontmatter(text);
  if (body === "") return null;
  return {
    updatedAt: str(data.updatedAt),
    completed: typeof data.completed === "number" ? data.completed : 0,
    total: typeof data.total === "number" ? data.total : 0,
    body,
  };
}

/** .agent/OVERVIEW.md を読む。存在しない・パース不能なら null(未生成扱い) */
function loadOverview(): Overview | null {
  try {
    return parseOverview(fs.readFileSync(repoPaths().overviewPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * status 表示用の概観セクションを組み立てる。overview が null なら未生成の案内 1 行のみ。
 * あれば生成時点(updatedAt・completed/total)と現在の進捗を並記して鮮度を可視化し、
 * 本文を続ける。
 */
export function overviewSectionLines(
  overview: Overview | null,
  currentCompleted: number,
  currentTotal: number,
  maxLines = 6,
): { rest: string; lines: string[] } {
  if (overview === null) {
    return { rest: "未生成(次回の探索セッションが作成する)", lines: [] };
  }
  // 雛形の OVERVIEW.md は updatedAt: 1970-01-01T00:00:00.000Z を初期値として持つ(init 直後、
  // 探索セッションがまだ 1 度も更新していない状態)。これをそのまま表示すると
  // 「1970-01-01... 時点」という紛らわしい表示になるため、未生成として扱う。
  const EPOCH = "1970-01-01T00:00:00.000Z";
  const when = overview.updatedAt === EPOCH ? "(未生成)" : overview.updatedAt !== "" ? overview.updatedAt : "不明";
  const rest = `${when} 時点(完了 ${overview.completed}/${overview.total} → 現在 ${currentCompleted}/${currentTotal})`;
  const allLines = overview.body.split("\n");
  const lines =
    allLines.length <= maxLines
      ? allLines
      : [...allLines.slice(0, maxLines), `…(全${allLines.length}行、詳細は .agent/OVERVIEW.md)`];
  return { rest, lines };
}

/** 人間の対応が要る、衝突まわりの残骸(表示専用) */
interface PendingConflicts {
  /** 衝突解消待ちで残っている worktree */
  worktrees: { taskId: string; path: string }[];
  /** 退避済みの agent/conflict/* ブランチ名 */
  parkedBranches: string[];
}

/**
 * 衝突で止まっている worktree と、退避済みの agent/conflict/* ブランチを集める。
 * どちらも Supervisor は自動では解消せず、放置すると忘れられるため status に出す。
 * git が使えない等の失敗は空扱いにする(status 表示を例外で落とさないため)。
 */
function collectPendingConflicts(root: string, worktreeDir: string): PendingConflicts {
  const parkedBranches = listAgentBranches(root)
    .map((b) => b.branch)
    .filter((b) => b.startsWith("agent/conflict/"))
    .sort();

  const worktrees: { taskId: string; path: string }[] = [];
  try {
    for (const entry of listWorktrees(root)) {
      if (!isInsideDir(worktreeDir, entry.path)) continue;
      if (!fs.existsSync(entry.path) || !worktreeConflictPending(entry.path)) continue;
      worktrees.push({ taskId: path.basename(entry.path), path: entry.path });
    }
  } catch {
    // worktree を列挙できない場合は「無し」として表示を続ける
  }
  return { worktrees, parkedBranches };
}

/** permission-denials.jsonl の末尾を読む。ファイルが無ければ空、壊れた行はスキップして続行する */
export function loadPermissionDenials(
  stateDir: string = repoPaths().stateDir,
): { entries: PermissionDenialRecord[]; truncated: boolean } {
  const p = permissionDenialsPathOf(stateDir);
  const { lines, truncated } = readTailLines(p, LOG_READ_MAX_BYTES, LOG_READ_MAX_ENTRIES);
  const entries: PermissionDenialRecord[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as PermissionDenialRecord);
    } catch {}
  }
  return { entries, truncated };
}

/** unicode-safe に max 文字で切り、切った場合は "…" を付ける(stderrTail と同じ方式) */
function truncateForDisplay(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}

/**
 * permission 拒否の集約キーを決める。Bash はコマンド先頭語(git/npm/npx はサブコマンドまで含める)、
 * それ以外はツール名のみ。表示上「同じ操作の繰り返し」をひとまとめにするための粒度で、
 * denyRules の厳密な照合(denialMatchesRule)とは無関係の簡易分類。
 */
function permissionDenialPattern(entry: PermissionDenialRecord): string {
  if (entry.tool !== "Bash") return entry.tool;
  const words = (entry.command ?? "").trim().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return "Bash(…)";
  const head = words[0]!;
  const sub = ["git", "npm", "npx"].includes(head) && words.length > 1 ? `${head} ${words[1]}` : head;
  return `Bash(${sub} …)`;
}

export interface PermissionDenialSummaryRow {
  pattern: string;
  count: number;
  /** 最新 1 件の command/input を 80 文字で切ったもの */
  example: string;
  /** 最新 1 件の timestamp(ISO 8601) */
  lastAt: string;
  /** 新しい順・重複除去・最大 3 件のセッションラベル */
  sessions: string[];
}

export interface PermissionDenialSummary {
  /** ウィンドウ内の全件数(パターン集約前) */
  total: number;
  rows: PermissionDenialSummaryRow[];
  /** maxRows に収まらず畳まれたパターン数 */
  hiddenPatterns: number;
  /** 畳まれたパターンの合計件数 */
  hiddenCount: number;
  /** 読み込み上限で古い記録を読み飛ばしており、ウィンドウ内の件数が実際より少ない可能性がある */
  partialWindow: boolean;
}

/**
 * entries が読み込み上限で末尾読みされていた(truncated)とき、読み飛ばした側にウィンドウ内の
 * 記録が残っている可能性があるかを判定する。entries の中で解釈できる最古の timestamp が
 * cutoff 以降なら「読み飛ばした側もまだウィンドウ内かもしれない」ので true。最古が cutoff より
 * 古ければウィンドウ内は entries だけで全部読めているので false。timestamp を 1 つも
 * 解釈できない場合は安全側に倒して true。
 */
function hasPartialWindow(entries: PermissionDenialRecord[], cutoffMs: number, truncated: boolean): boolean {
  if (!truncated) return false;
  let oldestMs: number | null = null;
  for (const e of entries) {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (oldestMs === null || t < oldestMs) oldestMs = t;
  }
  if (oldestMs === null) return true;
  return oldestMs >= cutoffMs;
}

/**
 * permission 拒否ログを直近ウィンドウ(既定 7 日)でフィルタし、パターン集約して件数降順の
 * 上位 maxRows 件(既定 5)を返す純関数。status 表示専用で、denyRules 等の記録判断には関与しない。
 */
export function summarizePermissionDenials(
  entries: PermissionDenialRecord[],
  now: Date,
  opts?: { windowMs?: number; maxRows?: number; truncated?: boolean },
): PermissionDenialSummary {
  const windowMs = opts?.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxRows = opts?.maxRows ?? 5;
  const cutoff = now.getTime() - windowMs;
  const recent = entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    return !Number.isNaN(t) && t >= cutoff;
  });
  // 新しい順に処理し、各パターンの「最新の例・最終時刻・新しい順セッション」を先勝ちで確定させる
  const sorted = [...recent].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  interface Agg {
    count: number;
    example: string;
    lastAt: string;
    sessions: string[];
  }
  const byPattern = new Map<string, Agg>();
  for (const e of sorted) {
    const pattern = permissionDenialPattern(e);
    let agg = byPattern.get(pattern);
    if (agg === undefined) {
      agg = { count: 0, example: truncateForDisplay(e.command ?? e.input ?? "", 80), lastAt: e.timestamp, sessions: [] };
      byPattern.set(pattern, agg);
    }
    agg.count += 1;
    if (agg.sessions.length < 3 && !agg.sessions.includes(e.session)) {
      agg.sessions.push(e.session);
    }
  }

  const allRows = [...byPattern.entries()]
    .map(([pattern, agg]) => ({ pattern, ...agg }))
    .sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt));
  const rows = allRows.slice(0, maxRows);
  const hidden = allRows.slice(maxRows);

  return {
    total: recent.length,
    rows,
    hiddenPatterns: hidden.length,
    hiddenCount: hidden.reduce((sum, r) => sum + r.count, 0),
    partialWindow: hasPartialWindow(entries, cutoff, opts?.truncated === true),
  };
}

/**
 * summarizePermissionDenials の結果を status 表示行に整形する。rows が空なら空配列
 * (= section() が呼び出し側でセクションごと表示しない)。
 */
export function permissionDenialLines(summary: PermissionDenialSummary): string[] {
  if (summary.rows.length === 0) return [];
  const lines = summary.rows.map((r) => {
    const lastAt = r.lastAt.slice(0, 16);
    return `${r.count}x ${r.pattern}  例: ${r.example}  最終 ${lastAt} (${r.sessions.join(", ")})`;
  });
  if (summary.hiddenPatterns > 0) {
    lines.push(`…他 ${summary.hiddenPatterns} パターン ${summary.hiddenCount} 件`);
  }
  if (summary.partialWindow) {
    lines.push("※ 記録が多いため直近ぶんだけを読んで集計している(これより古い拒否は件数に入っていない)");
  }
  lines.push(
    "→ 許可するなら .agent/claude-settings.json の permissions.allow に追記(次に起動するセッションから有効。deny が allow に優先)",
  );
  return lines;
}

/** 未承認(未アーカイブ)の決定の件数とプレビュー */
interface PendingDecisions {
  count: number;
  preview: { id: string; title: string }[];
}

/**
 * `.agent/decisions/` に残っている `D-*.md`(index.md 等は除く)を未承認の決定として読む。
 * チェック済みの決定は rotateDecisions が archive へ移動するため、ここに残っているものが
 * 「人間の確認待ち」。ディレクトリが無い・読めない場合は 0 件として扱う(例外を投げない)。
 */
export function loadPendingDecisions(decisionsDir: string = repoPaths().decisionsDir): PendingDecisions {
  let ids: string[];
  try {
    ids = fs
      .readdirSync(decisionsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith("D-") && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -".md".length))
      .sort()
      .reverse();
  } catch {
    return { count: 0, preview: [] };
  }
  const preview = ids.slice(0, 3).map((id) => {
    let title = id;
    try {
      const text = fs.readFileSync(path.join(decisionsDir, `${id}.md`), "utf8");
      const { data } = parseFrontmatter(text);
      if (typeof data.title === "string") title = data.title;
    } catch {
      // 読めない場合は id にフォールバック
    }
    return { id, title };
  });
  return { count: ids.length, preview };
}

/**
 * loadPendingDecisions の結果を status 表示行に整形する。count が 0 なら空配列
 * (= section() が呼び出し側でセクションごと表示しない)。
 */
export function pendingDecisionsSectionLines(pd: PendingDecisions): string[] {
  if (pd.count === 0) return [];
  const lines = pd.preview.map((d) => `${d.id}: ${d.title}`);
  if (pd.count > pd.preview.length) {
    lines.push(`…他 ${pd.count - pd.preview.length} 件`);
  }
  lines.push(
    "→ 内容を確認したら .agent/decisions/index.md のチェックボックスを [x] にすると archive へ移動",
  );
  return lines;
}

/**
 * `ccloop status` が扱う生データ一式(表示に依存しない)。
 * `formatStatus`(人間向けテキスト)と `statusDataToJson`(`--json`)の両方がここから作る
 * ことで、データ取得と整形表示を分離する。値は内部の型(Task / State 等)をそのまま持つ。
 */
export interface StatusData {
  tasks: Task[];
  /**
   * archive へ退避済みの completed タスク件数(「完了 X/N」の累積表示に使う)。
   * アクティブ側 `tasks` と同じ ID を持つ archive タスクは二重計上を避けるため除く
   */
  archivedCompletedCount: number;
  state: State;
  humanReview: { openBlock: HrEntry[]; openReview: HrEntry[]; answered: HrEntry[] };
  overview: Overview | null;
  pendingConflicts: PendingConflicts;
  /** 未コミット差分の退避に失敗して残された worktree */
  salvageFailures: SalvageFailure[];
  permissionDenials: PermissionDenialSummary;
  /** 未承認(未アーカイブ)の決定 */
  pendingDecisions: PendingDecisions;
  nextRunnableTasks: Task[];
  snoozedTasks: Task[];
  metrics: SessionMetrics[];
  /** 読み込み上限で metrics.jsonl の古い記録を読み飛ばしているか(累計 cost が直近ぶんの集計になる) */
  metricsTruncated: boolean;
  /** 人間の入力(GOAL.md / answered な Human Review)が未取り込みか */
  inputsChanged: boolean;
  taskTimeoutMs: number;
  maxSessions: number;
  /** 起動中の supervisor のソースが、現在のソースと異なるか(再起動が必要か) */
  supervisorSourceStale: boolean;
  /** インストール済みの ccloop がこのリポジトリの lib/ と乖離しているか(自己ホスト時のみ判定) */
  installedSourceDrifted: boolean;
  /** ループ本体(ccloop run)が生きているか */
  loopLiveness: LoopLiveness;
  /** status が不正で処理対象から外れているタスクファイル名(`.agent/tasks/` 直下) */
  invalidTaskFiles: string[];
  /** 存在しないタスク ID を依存に書いているタスク(現役にも archive にも無い依存) */
  missingDependencies: { taskId: string; title: string; missing: string[] }[];
}

/** realpath を試み、失敗したら元のパスをそのまま返す(インストール先とリポジトリの lib/ の比較を安定させる) */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * `ccloop status` / `ccloop status --json` の元になるデータを 1 回の走査で集める(純粋読み取り。
 * ファイルへの書き込みは行わない)。config.json が読めない場合は既定値へフォールバックする
 * (status は状況を見るためのものなので、他コマンドのように止めない)。
 */
export function collectStatusData(now: Date): StatusData {
  const { tasks, invalidFiles: invalidTaskFiles } = loadTasksFrom(tasksDirOf(repoPaths().root), false);
  const state = loadState();
  const hr = parseHumanReview();
  // 進捗は archive へ退避済みの completed タスクも分子・分母に含め、
  // ローテーション後も「完了 X/N」が累積の実績を反映するようにする。
  // 片付けが移動先の同名ファイルとの衝突で移動を見送ると同じ ID が両側に残るため、
  // アクティブ側にある ID は archive 側から除いて二重計上を防ぐ
  const activeTaskIds = new Set(tasks.map((t) => t.id));
  const archivedTasks = loadArchivedTasks();
  const archivedCompletedCount = archivedTasks.filter(
    (t) => t.status === "completed" && !activeTaskIds.has(t.id),
  ).length;
  const overview = loadOverview();
  const humanReview = classifyHumanReview(hr);

  // config は要対応セクション(worktree 置き場)と稼働状態の両方で使う
  let taskTimeoutMs = 2400000;
  let maxSessions = 1;
  let worktreeDir = repoPaths().worktreesDir;
  try {
    const c = loadConfig();
    taskTimeoutMs = c.taskTimeoutMs;
    maxSessions = c.parallel.maxSessions;
    worktreeDir = c.parallel.worktreeDir;
  } catch {
    // config が読めなければ既定値にフォールバック
  }
  const pendingConflicts = collectPendingConflicts(repoPaths().root, worktreeDir);
  const salvageFailures = loadSalvageFailures(repoPaths().root);
  const { entries: permissionDenialEntries, truncated: permissionDenialsTruncated } = loadPermissionDenials();
  const permissionDenials = summarizePermissionDenials(permissionDenialEntries, now, {
    truncated: permissionDenialsTruncated,
  });
  const pendingDecisions = loadPendingDecisions();

  const runningTaskIds = new Set(
    state.runningSessions.map((s) => s.taskId).filter((id): id is string => id !== undefined),
  );
  const next = nextRunnableTasks(tasks, runningTaskIds, 3);
  const snoozed = snoozedTasksByUntil(tasks, runningTaskIds);
  const inputsChanged = isInputsChanged(state.inputsHash, hashInputs());
  const { entries: metrics, truncated: metricsTruncated } = loadMetrics();
  // インストール先のハッシュは 2 つの判定(起動時からの陳腐化・リポジトリとの乖離)で共用する。
  // 走査対象は同一ディレクトリなので、watch の毎秒ポーリングで二重に走らせない
  const installedSourceHash = supervisorSourceHash();
  const supervisorSourceStale = isSupervisorSourceStale(state.supervisorSourceHash, installedSourceHash);

  // インストール先(ccloopHome())とリポジトリの lib/ の乖離検出。自己ホストでない
  // (= repoLibDir が null)場合や、ソースから直接起動している場合はハッシュ計算(ディレクトリ走査)
  // 自体が無駄なので行わない
  const installedHome = realpathOrSelf(ccloopHome());
  const repoLibDir = selfHostedLibDir(repoPaths().root, {
    exists: (p) => fs.existsSync(p),
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  });
  const resolvedRepoLibDir = repoLibDir === null ? null : realpathOrSelf(repoLibDir);
  const needsInstalledSourceHashCompare = resolvedRepoLibDir !== null && resolvedRepoLibDir !== installedHome;
  const installedSourceDrifted = isInstalledSourceDrifted({
    repoLibDir: resolvedRepoLibDir,
    installedHome,
    repoHash: needsInstalledSourceHashCompare ? supervisorSourceHash(resolvedRepoLibDir) : "",
    installedHash: needsInstalledSourceHashCompare ? installedSourceHash : "",
  });

  const knownIds = new Set([...tasks.map((t) => t.id), ...archivedTasks.map((t) => t.id)]);
  const missingDependencies = findMissingDependencies(tasks, knownIds).map(({ task, missing }) => ({
    taskId: task.id,
    title: task.title,
    missing,
  }));

  return {
    tasks,
    archivedCompletedCount,
    state,
    humanReview,
    overview,
    pendingConflicts,
    salvageFailures,
    permissionDenials,
    pendingDecisions,
    nextRunnableTasks: next,
    snoozedTasks: snoozed,
    metrics,
    metricsTruncated,
    inputsChanged,
    taskTimeoutMs,
    maxSessions,
    supervisorSourceStale,
    installedSourceDrifted,
    loopLiveness: evaluateLoopLiveness(readRunnerRecord(repoPaths().runnerPath), now),
    invalidTaskFiles,
    missingDependencies,
  };
}

/** 累計 cost 行を作る。truncated なら「直近ぶんだけの集計」であることを明示する */
export function metricsTotalLine(metrics: SessionMetrics[], truncated: boolean): string {
  const totalCost = metrics.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  const scope = truncated
    ? `直近 ${metrics.length} セッション分・サブエージェント込み。これより古い記録は集計に入っていない`
    : `終了した ${metrics.length} セッション分・サブエージェント込み`;
  return `累計: cost=$${totalCost.toFixed(4)}(${scope})`;
}

/**
 * `ccloop status` の表示内容を 1 つの文字列として組み立てる。
 * `status` は 1 回出力するだけだが、`watch` は同じ内容を毎秒描き直すため、
 * 「出力」ではなく「文字列」を作る形にして両方から使えるようにしてある。
 */
export function formatStatus(): string {
  const now = new Date();
  const data = collectStatusData(now);
  const out: string[] = [];
  const push = (line: string): void => {
    out.push(line);
  };
  const tasks = data.tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const by = (s: TaskStatus): Task[] => tasks.filter((t) => t.status === s);

  push("== 自律実行ステータス ==");
  const archivedCompleted = data.archivedCompletedCount;
  push(progressBar(by("completed").length + archivedCompleted, tasks.length + archivedCompleted));
  const counts = STATUS_ORDER.map((s) => by(s).length)
    .map((n, i) => [STATUS_ORDER[i]!, n] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${statusLabel(s)} ${n}`)
    .join(" / ");
  push(counts || "タスクなし");

  const { rest: overviewRest, lines: overviewLines } = overviewSectionLines(
    data.overview,
    by("completed").length + archivedCompleted,
    tasks.length + archivedCompleted,
  );
  push(`\n${styledSectionLabel("概観", overviewRest)}`);
  for (const l of overviewLines) push(`  ${l}`);

  const { openBlock, openReview, answered } = data.humanReview;
  const failed = by("failed");
  const blocked = by("blocked");
  /**
   * open 行の表示用ラベル。何を聞かれているかが一目で分かるよう summary を添え、回答本文はあるが
   * チェック忘れの場合はさらに注意喚起を付ける
   */
  const hrLine = (h: HrEntry): string => {
    const extra: string[] = [];
    // 本文側が「一言でいうと: …」で始まる書き方に揃っているため、こちらで見出し語を足すと
    // 二重になる。抜き出した行をそのまま「→」で示すだけにする
    if (h.summary !== "") extra.push(`→ ${h.summary}`);
    if (hasFreeTextAnswer(h.body)) extra.push("回答本文あり — [ ] を [x] にすると取り込まれます");
    return [`${h.id}: ${h.title}`, ...extra.map((l) => `      ${l}`)].join("\n");
  };

  const pending = data.pendingConflicts;

  const section = (tag: string, rest: string, lines: string[]): void => {
    if (lines.length === 0) return;
    push(`\n${styledSectionLabel(tag, rest)}`);
    for (const l of lines) push(`  ${l}`);
  };
  section("要対応", "open な Human Review (BLOCK) — タスクまたはフェーズ進行が停止中:", openBlock.map(hrLine));
  section(
    "要対応",
    "failed タスク — タスクファイルの status を ready に戻して再挑戦するか、断念を判断:",
    failed.map((t) => `${t.id}: ${t.title}${t.note ? `\n      note: ${t.note}` : ""}`),
  );
  section(
    "要対応",
    "blocked タスク:",
    blocked.map((t) => `${t.id}: ${t.title}${t.note ? `\n      note: ${t.note}` : ""}`),
  );
  section(
    "要対応",
    `status が不正で集計から除外されているタスクファイル — frontmatter の status を ${TASK_STATUSES.join(" / ")} のいずれかに直す:`,
    data.invalidTaskFiles,
  );
  section(
    "要対応",
    "依存に書かれたタスク ID が見つからないタスク — 打ち間違いなら直す。このままだと依存を待たずに実行される:",
    data.missingDependencies.map(
      (m) => `${m.taskId}: ${m.title}\n      見つからない依存: ${m.missing.join(" ")}`,
    ),
  );
  section(
    "要対応",
    "衝突解消待ちの worktree — 次の試行がこの worktree で再開される。長引くなら手で解消:",
    pending.worktrees.map((w) => `${w.taskId}: ${w.path}`),
  );
  section(
    "要対応",
    "退避された衝突ブランチ — 内容を確認し、統合するか破棄するかを判断:",
    pending.parkedBranches,
  );
  section(
    "要対応",
    "未コミット差分の退避に失敗して残した worktree — 中の差分を回収したら " +
      "`git worktree remove --force <path>` と `git branch -D agent/<タスクID>` で片付けてよい:",
    data.salvageFailures.map((f) => `${f.taskId}: ${f.worktree}\n      ${f.at} の退避が失敗: ${f.error}`),
  );
  section("確認推奨", "open な Human Review (REVIEW/INFO) — 回答を待たず続行中:", openReview.map(hrLine));
  section(
    "確認推奨",
    `未承認の決定 ${data.pendingDecisions.count} 件 — 人間の確認待ち:`,
    pendingDecisionsSectionLines(data.pendingDecisions),
  );
  section(
    "対応不要",
    "answered — 次の triage / 探索セッションが取り込み予定:",
    answered.map((h) => `${h.id}: ${h.title}`),
  );
  if (
    openBlock.length +
      openReview.length +
      answered.length +
      failed.length +
      blocked.length +
      pending.worktrees.length +
      pending.parkedBranches.length +
      data.salvageFailures.length +
      data.pendingDecisions.count +
      data.invalidTaskFiles.length +
      data.missingDependencies.length ===
    0
  ) {
    push("\n要対応事項なし");
  }

  section(
    "対応不要",
    `直近7日の permission 拒否 ${data.permissionDenials.total} 件(セッションは代替手段で続行済み。回答不要):`,
    permissionDenialLines(data.permissionDenials),
  );

  const runningSectionTitle =
    data.loopLiveness.status === "stopped" && data.state.runningSessions.length > 0
      ? "\n実行中のタスク(ループ停止時の記録)"
      : "\n実行中のタスク";
  push(runningSectionTitle);
  const running = runningSessionLines(
    data.state.runningSessions,
    byId,
    now,
    data.taskTimeoutMs,
    data.maxSessions,
    data.loopLiveness,
  );
  if (running.length === 0) {
    push("  なし");
  } else {
    for (const l of running) push(`  ${l}`);
  }

  // 人間の入力(GOAL.md・answered な Human Review)が未取り込みなら、次の triage / 探索セッションが
  // 取り込む。タスクの起動は止まらない(探索は並列枠の中でしか走らない)ので、表示もその実態に合わせる
  if (data.inputsChanged) {
    push("\n未取り込みの入力変化あり (answered HR / GOAL.md): 次の triage / 探索セッションが取り込みます");
    push(`  → タスクの起動は止まりません(探索は ${data.maxSessions} 並列の枠を 1 つ使って走ります)`);
  }

  push("\n次に実行予定のタスク");
  const next = data.nextRunnableTasks;
  const snoozed = data.snoozedTasks;
  if (next.length === 0) {
    push(
      snoozed.length > 0
        ? `  なし(スヌーズ待ち ${snoozed.length} 件、最短解除 ${snoozed[0]!.snoozeUntil})`
        : "  なし(依存待ちの可能性)",
    );
  } else {
    for (const t of next) push(`  ${t.id}  p${t.priority}  ${t.title}`);
  }

  push(`\nスヌーズ中のタスク (${snoozed.length} 件)`);
  if (snoozed.length === 0) {
    push("  なし");
  } else {
    for (const t of snoozed) {
      push(
        `  ${t.id}  ${t.title}  ${styleText("dim", `[snoozed until ${t.snoozeUntil}]`)}${
          t.note ? `\n      note: ${t.note}` : ""
        }`,
      );
    }
    push("  → 残っている間、run モードのループは自動終了(idle-exit)しない");
  }

  push("\n-- 稼働状態 --");
  push(
    `起動セッション: ${data.state.sessionCount} 件(実行中を含む) / 最終探索: ${data.state.lastExploreAt ?? "未実行"}`,
  );
  push(describeLoopLiveness(data.loopLiveness));
  push(`状態の更新: ${data.state.updatedAt ?? "未記録"}`);
  // 停止指示は run プロセスのメモリが本体で、ここに出るのはその写し(表示専用)
  if (data.state.stopMode === "clean") {
    push("停止処理中 (clean): 新規セッションを起動せず、実行中が終わり次第 run が停止する");
  }
  if (data.state.rateLimit.resumeAt !== null) {
    push(`レートリミット待機中: ${data.state.rateLimit.resumeAt} まで`);
  }
  if (data.supervisorSourceStale) {
    push(
      "  ※ supervisor のコードが起動後に変更されている — 稼働中なら再起動(ccloop run を止めて起動し直す)しないと反映されない",
    );
  }
  for (const l of installedSourceDriftLines(data.installedSourceDrifted)) push(l);

  const metrics = data.metrics;
  if (metrics.length > 0) {
    const last = metrics[metrics.length - 1]!;
    const fmtCost = (cost: number | undefined): string => (cost !== undefined ? `$${cost.toFixed(4)}` : "不明");
    push(
      `直近セッション: cost=${fmtCost(last.costUsd)} / turns=${last.numTurns ?? "不明"}${last.abnormal ? ` / 異常終了: ${last.abnormal}` : ""}`,
    );
    push(metricsTotalLine(metrics, data.metricsTruncated));
  }
  push("\n確認・介入の手順: README.md の「人間の関与」");
  return out.join("\n");
}

/**
 * `ccloop status [--json]`。`--json` があれば `collectStatusData` の結果をそのまま
 * JSON.stringify して 1 行で出す(整形出力とは別の出口。既存のテキスト出力は変えない)。
 */
export function cmdStatus(argv: string[] = []): void {
  if (argv.includes("--json")) {
    console.log(JSON.stringify(collectStatusData(new Date())));
    return;
  }
  console.log(formatStatus());
}
