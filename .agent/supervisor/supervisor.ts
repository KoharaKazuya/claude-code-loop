/**
 * 自律実行 Supervisor
 *
 * Claude Code セッションを決定論的に起動・監視するループ。LLM 的な判断は持たない。
 * 状態はすべて .agent/ 以下のファイルに永続化される(このプロセスはステートレス)。
 *
 * 使い方:
 *   node .agent/supervisor/supervisor.ts run    # 常駐ループ(停止方法は下記)
 *   node .agent/supervisor/supervisor.ts once   # 1 タスク(なければ探索 1 回)だけ実行して終了
 *   node .agent/supervisor/supervisor.ts add "タイトル" [--desc 説明] [--priority N] [--deps T-001,T-002]
 *   npm run agent:add -- "タイトル" [--desc 説明] [--priority N] [--deps T-001,T-002]
 *     (npm 経由では `--` を必ず入れる。省略すると --desc が npm の description
 *      ショートハンドとして消費され、説明文が意図せず落ちることがある)
 *   node .agent/supervisor/supervisor.ts list   # タスク一覧
 *   node .agent/supervisor/supervisor.ts rotate # .agent/ 状態ファイルのローテーションを手動実行
 *
 * 停止方法(run モード。再開はいずれも rm .agent/STOP && npm run agent):
 *   touch .agent/STOP            # 通常停止: 新規セッションを起動せず、実行中のセッションが
 *                                #   終わり次第停止する。git 差分(.agent/ 除く)が残っていれば
 *                                #   その旨をログに出したうえで差分を残して停止する
 *   echo session > .agent/STOP   # セッション境界停止: 実行中セッションが supervisor に
 *                                #   返ってきた時点で停止(作業途中の差分が残りうる)
 *   Ctrl+C                       # 段階停止: 1 回目で STOP(clean) を作成、2 回目で session に
 *                                #   更新、3 回目で緊急停止(SIGTERM → 猶予後 SIGKILL)、4 回目で
 *                                #   即 SIGKILL。中断されたセッションの worktree とブランチは
 *                                #   そのまま残り、次回そのタスクを実行するときに再利用される
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
import { parseFrontmatter, serializeFrontmatter, type FrontmatterValue } from "./frontmatter.ts";
import {
  basenameId,
  mergeAgentBranch,
  preResolveIdCollisions,
  type ConflictKind,
  type MergeOutcome,
} from "./merge.ts";
import { detectRateLimit } from "./ratelimit.ts";
import { rotate, rotateResultIsEmpty } from "./rotate.ts";
import { planLoopStep } from "./scheduler.ts";
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

const ROOT = path.resolve(import.meta.dirname, "../..");
const AGENT_DIR = path.join(ROOT, ".agent");
const CONFIG_PATH = path.join(AGENT_DIR, "config.json");
const TASKS_DIR = path.join(AGENT_DIR, "tasks");
const HR_DIR = path.join(AGENT_DIR, "human-review");
const ARCHIVE_DIR = path.join(AGENT_DIR, "archive");
const PROMPT_PATH = path.join(AGENT_DIR, "PROMPT.md");
const STOP_PATH = path.join(AGENT_DIR, "STOP");
const METRICS_PATH = path.join(AGENT_DIR, "metrics.jsonl");
/**
 * agentDir 配下の `.agent/permission-denials.jsonl`(git 管理外)。permission 拒否の追記型ログ。
 * テストから tmpdir を渡せるよう、statePathOf / patchesDirOf と同じパターンで agentDir を引数に取る。
 */
export function permissionDenialsPathOf(agentDir: string): string {
  return path.join(agentDir, "permission-denials.jsonl");
}
const OVERVIEW_PATH = path.join(AGENT_DIR, "OVERVIEW.md");
const CLAUDE_SETTINGS_PATH = path.join(AGENT_DIR, "claude-settings.json");
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

export interface Config {
  claudeCommand: string;
  model: string;
  /** 同一タスクの失敗が afterRetries 回に達したら、以降の再試行を model で実行(model 空文字で無効) */
  escalation: { model: string; afterRetries: number };
  permissionMode: string;
  maxRetries: number;
  taskTimeoutMs: number;
  maxTurns: number;
  rateLimit: { backoffMs: number };
  /** minIntervalMs: 探索の実行間隔。`npm run agent:once` の探索判定に使うほか、
   * `npm run agent` の run モードでも直前の探索が空振り(新規タスク 0 件)だった場合の
   * 再探索クールダウンとして使う(空振り探索の即時連鎖を防ぐ)。run モードで直前の探索が
   * タスクを生んでいれば、従来どおり間隔を待たずに探索する */
  explore: { enabled: boolean; minIntervalMs: number };
  /** Human Review 回答の段階的処理(Stage 1: 決定論判定 / Stage 2: 軽量モデル判定)の設定。
   * enabled=false なら Stage 1/2 を飛ばし、従来どおり毎回フル探索(Stage 3)へ回す */
  triage: { enabled: boolean; model: string };
  idlePollMs: number;
  /** 並列セッション実行の設定 */
  parallel: {
    /** 同時タスクセッション数上限 */
    maxSessions: number;
    /** worktree 置き場のディレクトリ */
    worktreeDir: string;
    /** worktree へ symlink する gitignore 済みパス。
     * 注意: 実運用の worktree 作成は WorktreeCreate hook(.agent/hooks/worktree-create.mjs)が
     * 行い、そちらは node_modules 固定で symlink する。この設定は worktree.ts の
     * linkSharedPaths(現状テスト用)にのみ効き、config.json で変えても hook 経路には影響しない */
    linkPaths: string[];
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** リポジトリルートから見た既定の worktree 置き場(`<ROOT の親>/<ROOT のディレクトリ名>-worktrees`) */
function defaultWorktreeDir(root: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
}

/**
 * config.json の生の中身から Config を組み立てる。欠損・不正値は既定値で埋める。
 * 既存の .agent/config.json (parallel を持たない形式)もそのまま読み込める。
 */
export function normalizeConfig(raw: unknown, root: string): Config {
  const r = isPlainObject(raw) ? raw : {};

  const escalation = isPlainObject(r.escalation)
    ? (r.escalation as unknown as Config["escalation"])
    : { model: "", afterRetries: Infinity };

  const p = isPlainObject(r.parallel) ? r.parallel : {};
  const maxSessionsRaw = p.maxSessions;
  const maxSessions =
    typeof maxSessionsRaw === "number" && Number.isFinite(maxSessionsRaw)
      ? Math.min(8, Math.max(1, Math.trunc(maxSessionsRaw)))
      : 1;
  const worktreeDir =
    typeof p.worktreeDir === "string" && p.worktreeDir !== "" ? p.worktreeDir : defaultWorktreeDir(root);
  const linkPaths = Array.isArray(p.linkPaths) ? (p.linkPaths as string[]) : ["node_modules"];

  const tr = isPlainObject(r.triage) ? r.triage : {};
  const triage: Config["triage"] = {
    enabled: typeof tr.enabled === "boolean" ? tr.enabled : true,
    model: typeof tr.model === "string" && tr.model !== "" ? tr.model : "haiku",
  };

  return {
    ...(r as unknown as Config),
    escalation,
    parallel: { maxSessions, worktreeDir, linkPaths },
    triage,
  };
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
  /** 実行中セッションの一覧(タスクセッションは最大 parallel.maxSessions 件、探索は排他で 1 件) */
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
   * run 起動時点の .agent/supervisor/ ソースのハッシュ。現在のソースと異なれば、稼働中のプロセスは
   * 古いコードのまま動いている(supervisor.ts 等の変更は再起動するまで反映されない)。
   */
  supervisorSourceHash?: string | null;
  rateLimit: { resumeAt: string | null };
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
  return normalizeConfig(readJson<unknown>(CONFIG_PATH), ROOT);
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
function loadTasksFrom(dir: string, warn: boolean): Task[] {
  const tasks: Task[] = [];
  for (const fileName of listMdFiles(dir)) {
    const task = taskFromFile(dir, fileName);
    if (task === null) {
      const full = path.join(dir, fileName);
      if (warn && !warnedInvalidFiles.has(full)) {
        warnedInvalidFiles.add(full);
        log(`警告: ${full} は frontmatter の status が不正なため無視する`);
      }
      continue;
    }
    tasks.push(task);
  }
  return tasks;
}

// タスク・state の読み書きは通常モジュールレベルの ROOT に対して行うが、起動時復旧
// (recoverStartupIn)はフィクスチャのリポジトリを相手にテストできる必要があるため、
// root を明示的に受け取る変種を用意し、ROOT 版はその薄いラッパーにしている。

/** root 配下の `.agent/tasks` */
function tasksDirOf(root: string): string {
  return path.join(root, ".agent", "tasks");
}

/** root 配下の `.agent/state.json` */
function statePathOf(root: string): string {
  return path.join(root, ".agent", "state.json");
}

/** root 配下の `.agent/patches`(git 管理外) */
function patchesDirOf(root: string): string {
  return path.join(root, ".agent", "patches");
}

function loadTasksIn(root: string): Task[] {
  return loadTasksFrom(tasksDirOf(root), true);
}

function loadTasks(): Task[] {
  return loadTasksIn(ROOT);
}

/** id のタスクを 1 件だけ読む。見つからなければ null */
function loadTaskIn(root: string, id: string): Task | null {
  return loadTasksIn(root).find((x) => x.id === id) ?? null;
}

function loadTask(id: string): Task | null {
  return loadTaskIn(ROOT, id);
}

/**
 * rotate で .agent/archive/tasks/ へ退避された completed タスクを読む。
 * ID 採番・進捗集計・依存表示の母集団に含めるための参照専用。
 */
function loadArchivedTasks(): Task[] {
  return loadTasksFrom(path.join(ARCHIVE_DIR, "tasks"), false);
}

export function taskFrontmatter(t: Task): Record<string, FrontmatterValue | undefined> {
  return {
    title: t.title,
    status: t.status,
    priority: t.priority,
    dependencies: t.dependencies,
    retries: t.retries,
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
  saveTaskIn(ROOT, t);
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
  return loadStateIn(ROOT);
}

function saveStateIn(root: string, state: State): void {
  state.updatedAt = new Date().toISOString();
  writeJson(statePathOf(root), state);
}

function saveState(state: State): void {
  saveStateIn(ROOT, state);
}

/**
 * コンソールへ 1 行出力する(ファイルには残さない)。
 * セッションの中身は Claude Code 自身が transcript として保存しており、
 * claude-code-log(README 参照)でセッション ID から確認できる。
 */
function log(message: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`${styleText("dim", time)} ${message}`);
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
  { match: (p) => p.endsWith("/PROMPT.md"), label: "手順書" },
  { match: (p) => p.includes("/supervisor/"), label: "supervisor" },
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
 * スキップしてパススペックなしで commit する。失敗しても Supervisor 本体は止めず、
 * 警告ログのみ残す。
 *
 * message を省略するとステージ内容から subject を生成する(何が変わったか分からない
 * 定型コミットが履歴を埋めるのを避けるため)。呼び出し側が文脈を持っている場合
 * (復旧直後など)だけ明示的に渡す。
 */
export function commitAgentDir(message?: string, root: string = ROOT): void {
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
    execFileSync("git", ["add", "-A", "--", ".agent"], { cwd: root });
    const staged = parseNameStatus(
      execFileSync("git", ["diff", "--cached", "--name-status", "-M", "-z", "HEAD"], { cwd: root }).toString(),
    );
    if (staged.length === 0) return;
    // rename は移動元も検査する(`docs/x.md` → `.agent/x.md` のような、人間の作業を
    // .agent/ へ引き込む形のステージを見逃さないため)
    if (staged.some((c) => !c.path.startsWith(".agent/") || (c.from !== null && !c.from.startsWith(".agent/")))) {
      log("警告: .agent 以外の変更がステージされているため自動コミットをスキップする(人間の並行作業を保護)");
      return;
    }
    const subject = message ?? safeSummarize(staged);
    execFileSync("git", ["commit", "-m", withTrailer(subject)], { cwd: root });
    log(`.agent を commit した: ${subject}`);
  } catch (err) {
    log(`警告: .agent の自動コミットに失敗した: ${String(err)}`);
  }
}

// ---------- .agent/ 状態ファイルのローテーション ----------

/** 何かを移動した場合だけログ 1 行を出し、移動の要約文字列を返す(移動が無ければ null) */
export function runRotate(agentDir: string = AGENT_DIR): string | null {
  const result = rotate(agentDir);
  if (rotateResultIsEmpty(result)) return null;
  const parts: string[] = [];
  if (result.tasks > 0) parts.push(`tasks ${result.tasks} 件`);
  if (result.decisions > 0) parts.push(`decisions ${result.decisions} 件`);
  if (result.humanReview > 0) parts.push(`human-review ${result.humanReview} 件`);
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
 * `.agent/patches/` の古い退避パッチを削除し、削除件数を返す。
 * パッチは git 管理外(.gitignore 済み)のため、放置すると誰も見ないまま溜まり続ける。
 * 試行履歴には退避先のパスが残るので、消えたことは後から辿れる。
 */
export function prunePatches(agentDir: string = AGENT_DIR, now: Date = new Date(), keepDays: number = PATCH_KEEP_DAYS): number {
  const dir = path.join(agentDir, "patches");
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

// ---------- 停止制御 ----------

type StopMode = "session" | "clean";

/**
 * .agent/STOP による停止指示を読む。
 *   - ファイルなし: 停止しない(null)
 *   - 空 or "clean": セッション終了後、git 差分(.agent/ 除く)がない一区切りで停止(通常はこちら)
 *   - "session": 実行中セッションが supervisor に返ってきた時点で停止(作業途中の差分が残りうる)
 * 未知の内容は「停止したい意図」を汲んで安全側(早く止まる session)に倒す。
 */
function readStopMode(): StopMode | null {
  if (!fs.existsSync(STOP_PATH)) return null;
  const text = fs.readFileSync(STOP_PATH, "utf8").trim().toLowerCase();
  if (text === "" || text === "clean") return "clean";
  if (text !== "session") {
    log(`STOP の内容 "${text}" は未知のため session として扱う`);
  }
  return "session";
}

/**
 * .agent/ を除いた git 差分(未ステージ・ステージ済み・未追跡)のパス一覧を返す。
 * porcelain 出力の各行は `XY <path>`(リネームは `XY old -> new`)形式のため、
 * 先頭 3 文字のステータス部分を落とし、リネームは `-> ` 以降(新しいパス)を採る。
 * git status に失敗した場合は「判定できないなら止まらない」既存の流儀に合わせ空配列を返す。
 *
 * `.agent/` の未コミット差分は設計上ここでは無視する。mainLoop は `.agent/` を触った周回の
 * 待機直前とループ終了時にしかコミットしないため `.agent/` は常時 dirty になりうる。
 * この除外を外すと STOP(clean) が永久に成立しなくなる。
 */
export function dirtyPathsOutsideAgent(root: string = ROOT): string[] {
  try {
    const out = execSync("git status --porcelain -- . ':(exclude).agent'", { cwd: root }).toString();
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
 * 直近の「瞬時クラッシュ」の連続回数(finishTaskSession が更新する)。scheduler.ts の
 * crash-backoff ルール(fastCrashStreak >= 3 で 1 周回だけ起動を見送る)へ渡すための状態。
 * 起動直後に全滅するような環境要因の系統的な故障(例: worktree 置き場への書き込み権限がない)を
 * 検知し、機械的な再試行で失敗コミットを積み増し続ける事故を避けるために持つ。
 */
let fastCrashStreak = 0;

// sleep() をタイマー満了前に起こすための通知チャネル(Ctrl+C で STOP を書いた直後に
// アイドル待機・rate limit 待機を打ち切って STOP チェックへ即座に戻す。並列実行では
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
 * Ctrl+C 段階エスカレーションの次の一手を判定する。
 * 現在の .agent/STOP の状態(readStopMode の結果)を見て、まだ未作成なら clean を作成、
 * 既に clean なら session へ格上げ、既に session(=これ以上待たずに止めたい意図)なら
 * 緊急停止に進む。手動 touch/echo で作った STOP からもこのエスカレーションに合流する。
 */
export type StopEscalation = { content: string } | "emergency";
export function nextStopEscalation(mode: StopMode | null): StopEscalation {
  if (mode === null) return { content: "" };
  if (mode === "clean") return { content: "session" };
  return "emergency";
}

/**
 * run モードの SIGINT(Ctrl+C)ハンドラ。1 回目は STOP(clean) 作成、2 回目は session への
 * 更新に留め、セッションが安全な区切りで自発的に止まるのを待つ。既に緊急停止(SIGTERM)を
 * 送信済み、またはエスカレーション判定が emergency のときのみ強制終了へ進む。
 */
function handleSigint(): void {
  if (shuttingDown) {
    emergencyStop("SIGINT");
    return;
  }
  const escalation = nextStopEscalation(readStopMode());
  if (escalation === "emergency") {
    emergencyStop("SIGINT");
    return;
  }
  fs.writeFileSync(STOP_PATH, escalation.content);
  if (escalation.content === "") {
    log(
      "SIGINT 受信。.agent/STOP (clean) を作成し、git 差分のない一区切りでの停止を予約した。もう一度 Ctrl+C でセッション境界停止",
    );
  } else {
    log(
      "SIGINT 受信。.agent/STOP を session に更新した。実行中セッション終了時点で停止する。もう一度 Ctrl+C で緊急停止(実行中セッションを強制終了)",
    );
  }
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

/** mergeInProgress の判定不能(git が使えない等)を「進行中でない」に倒す版 */
function mergeInProgressSafe(dir: string): boolean {
  try {
    return mergeInProgress(dir);
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
 * 前回のプロセスが main のマージ中に落ちた場合の後始末。MERGE_HEAD が agent/* ブランチの
 * 先端を指していれば Supervisor 自身の自動マージの中断とみなして巻き戻す。一致しなければ
 * 人間が手で始めたマージの途中なので、警告だけ出して一切触らない。戻り値は巻き戻したか。
 */
function abortInterruptedAutoMerge(root: string): boolean {
  if (!mergeInProgressSafe(root)) return false;
  const sha = (readGitPathFile(root, "MERGE_HEAD") ?? "").split("\n")[0]?.trim() ?? "";
  if (sha === "") {
    log("警告: main でマージが進行中だが MERGE_HEAD を読めないため触らない");
    return false;
  }
  const match = listAgentBranches(root).find((b) => b.sha === sha);
  if (match === undefined) {
    log("警告: main で agent 由来でないマージが進行中のため触らない(人間のマージ途中とみなす)");
    return false;
  }
  try {
    execFileSync("git", ["merge", "--abort"], { cwd: root });
    log(`中断していた自動マージを巻き戻した(${match.branch})`);
    return true;
  } catch (err) {
    log(`警告: 中断していた自動マージの巻き戻しに失敗した: ${String(err)}`);
    return false;
  }
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
  recordFailure(t, { maxRetries: config.maxRetries, reason: opts.reason, kind: "recovery", at: opts.at });
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

  if (worktreeExists && mergeInProgressSafe(worktree)) {
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
      // ここで初めて先行解決を実際に試みる(それまでは preResolvedRenames は計画に過ぎない)
      const resolved = reproduceMergeConflict(worktree, { root, renames: outcome.preResolvedRenames });
      const note = describePreResolvedRenames(outcome.preResolvedRenames, resolved.length);
      const conflictReason = `セッションが中断され、main へのマージが衝突した(${outcome.paths.join(", ")})${note !== "" ? `。${note}` : ""}`;
      counts.keptConflicts += 1;
      recordStartupRecoveryNote(root, config, taskId, {
        reason: conflictReason,
        at,
      });
    } else {
      // worktree が無いため先行解決は試みていない(resolvedCount は常に 0)
      const note = describePreResolvedRenames(outcome.preResolvedRenames, 0);
      const conflictReason = `セッションが中断され、main へのマージが衝突した(${outcome.paths.join(", ")})${note !== "" ? `。${note}` : ""}`;
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
  const leftovers = worktreeExists ? salvageWorktreeDiff(taskId, worktree, now, root) : null;
  if (worktreeExists) removeWorktree(root, worktree);
  if (!deleteBranch(root, branch)) log(`警告: ブランチ ${branch} の削除に失敗した`);
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
  });

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
 * 起動時の復旧一式(root を明示的に受け取る本体)。ROOT 版は recoverStartup。
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
  const currentSourceHash = supervisorSourceHash(root);
  if (state.supervisorSourceHash !== currentSourceHash) {
    state.supervisorSourceHash = currentSourceHash;
    stateChanged = true;
  }
  if (stateChanged) saveStateIn(root, state);

  return counts;
}

/** 起動時の復旧をリポジトリ本体(ROOT)に対して実行する */
function recoverStartup(config: Config): StartupRecovery {
  return recoverStartupIn(ROOT, config);
}

// ---------- タスク選択 ----------

// ---------- 失敗時の知見引き継ぎ ----------

/** タスク失敗の種別。試行履歴への定型文・見出し表記を出し分けるために使う */
type FailureKind = "timeout" | "crash" | "no-status-update" | "merge-conflict" | "recovery";

const FAILURE_KIND_LABEL: Record<FailureKind, string> = {
  timeout: "タイムアウト",
  crash: "異常終了",
  "no-status-update": "status 未更新",
  "merge-conflict": "マージ衝突",
  recovery: "中断復旧",
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
};

const ATTEMPT_HISTORY_HEADING = "## 試行履歴";

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
    `### 試行 ${rec.attempt}(${rec.at}, Supervisor 記録: ${FAILURE_KIND_LABEL[rec.kind]})`,
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
 * 差分は失われる。patchFile はリポジトリルートからの相対パスで渡す。
 */
export function appendUncommittedDiffRecord(
  body: string,
  rec: { at: string; patchFile: string; paths: string[] },
): string {
  if (rec.paths.length === 0) return body;

  const entry = [
    `### 未コミット差分(${rec.at}, Supervisor 記録)`,
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
 * retries を増やし、上限判定で ready/failed の遷移と note を決め、
 * body の「## 試行履歴」へ機械的な記録(appendAttemptRecord)を追記する。
 * recoverWorkingTasks(kind: "recovery")と finishTaskSession の fail
 * (kind: timeout/crash/no-status-update/merge-conflict)の両方から呼ばれ、
 * 前 note の保存(元: ...)を共通化する。
 */
export function recordFailure(
  t: Task,
  opts: { maxRetries: number; reason: string; kind: FailureKind; at: string },
): void {
  const { maxRetries, reason, kind, at } = opts;
  t.retries += 1;

  const prevNote = t.note === undefined ? "-" : truncateNote(t.note);
  if (t.retries >= maxRetries) {
    t.status = "failed";
    t.note = `失敗回数が上限(${maxRetries})に達した。最後の失敗: ${reason}(元: ${prevNote})`;
  } else {
    t.status = "ready";
    t.note = `失敗のため ready に戻す(${t.retries}/${maxRetries})。理由: ${reason}(元: ${prevNote})`;
  }

  t.body = appendAttemptRecord(t.body, { attempt: t.retries, at, kind, reason });
}

/** 依存タスクが充足しているか(completed または依存先が存在しない) */
export function depSatisfied(byId: Map<string, Task>, depId: string): boolean {
  const dep = byId.get(depId);
  return dep === undefined || dep.status === "completed";
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
export function buildClaudeArgs(config: Config, prompt: string, model: string, extraArgs: string[] = []): string[] {
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
    CLAUDE_SETTINGS_PATH,
  ];
  if (config.maxTurns > 0) args.push("--max-turns", String(config.maxTurns));
  args.push(...extraArgs);
  return args;
}

/**
 * claude を 1 回起動する。引数の組み立ては buildClaudeArgs を参照。
 * env は CLAUDE_AGENT_AUTONOMOUS に追加する環境変数(hook がセッション種別を判別するために使う)。
 */
function runClaude(
  config: Config,
  prompt: string,
  model: string,
  cwd: string,
  opts: { extraArgs?: string[]; env?: Record<string, string> } = {},
): Promise<SessionResult> {
  const args = buildClaudeArgs(config, prompt, model, opts.extraArgs ?? []);

  return new Promise((resolve) => {
    const child = spawn(config.claudeCommand, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_AGENT_AUTONOMOUS: "1", ...opts.env },
    });
    const pid = child.pid;
    if (pid !== undefined) childPids.add(pid);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 10_000).unref();
    }, config.taskTimeoutMs);

    /**
     * 子の終了を 1 か所で受ける。緊急停止中は結果を resolve せず(= マージ・タスク状態の
     * 更新をさせず)、ブランチと worktree を残して次回に任せる。全ての子が落ちた時点で
     * Supervisor 自身を終了させる。
     */
    const settle = (result: SessionResult): void => {
      if (pid !== undefined) childPids.delete(pid);
      clearTimeout(killTimer);
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
 * claude-code-log(README 参照)で確認する。タイムアウト・起動失敗などで
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
export function loadDenyRules(settingsPath: string = CLAUDE_SETTINGS_PATH): string[] {
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

/** .agent/permission-denials.jsonl の 1 行(1 件の拒否)。追記型ログのレコード形式 */
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
  agentDir: string = AGENT_DIR,
  settingsPath: string = CLAUDE_SETTINGS_PATH,
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
    fs.appendFileSync(permissionDenialsPathOf(agentDir), text);
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
 * セッション終了のたびに呼び、コスト・トークン計測を .agent/metrics.jsonl へ 1 行追記する。
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
    fs.appendFileSync(METRICS_PATH, JSON.stringify(metrics) + "\n");
  } catch (err) {
    log(`警告: メトリクス記録に失敗した: ${String(err)}`);
  }
}

// ---------- レートリミット ----------

/** ベストエフォートのレートリミット検出(誤検出しても待機するだけで壊れない) */
function isSessionRateLimited(res: SessionResult): boolean {
  return detectRateLimit(`${res.stdout}\n${res.stderr}`, res.exitCode);
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

/**
 * .agent/supervisor/ 直下の .ts ファイル(.test.ts を除く)から作るハッシュ。稼働中プロセスが
 * run 起動時点のソースからどれだけ乖離しているか(＝再起動しないと変更が反映されない状態か)を
 * 検出するために使う。ファイルの追加・削除・リネームも検出できるよう、ファイル名も内容に含める。
 */
export function supervisorSourceHash(root: string): string {
  const dir = path.join(root, ".agent", "supervisor");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
      .map((e) => e.name)
      .sort();
  } catch {
    return "";
  }
  const combined = files.map((f) => `${f}\0${fs.readFileSync(path.join(dir, f), "utf8")}`).join("\0");
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

function readGoal(): string {
  const goalPath = path.join(AGENT_DIR, "GOAL.md");
  return fs.existsSync(goalPath) ? fs.readFileSync(goalPath, "utf8") : "";
}

/**
 * 人間からの入力(GOAL.md と Human Review の answered エントリ)のハッシュ。
 * 変化を検出したら、次のタスクより先に探索セッションを割り込ませて取り込む。
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
  const goalPath = path.join(AGENT_DIR, "GOAL.md");
  if (!fs.existsSync(goalPath)) return [];
  return ["---", "# 人間が定めた方向性(.agent/GOAL.md)", fs.readFileSync(goalPath, "utf8")];
}

/**
 * 再試行時に注入する「Supervisor による機械的情報」のセクション。
 * 初回試行(retries === 0)では注入しない(過去の試行がなく伝える情報がないため)。
 */
export function retryContextSection(config: Config, task: Task): string[] {
  if (task.retries === 0) return [];
  return [
    [
      "## 再試行コンテキスト(Supervisor による機械的情報)",
      "",
      `- これは ${task.retries + 1} 回目の試行(過去 ${task.retries} 回失敗、上限 ${config.maxRetries})`,
      `- 直前の失敗: ${task.note ?? "記録なし"}`,
      "- 上記タスク本文の「## 試行履歴」を読み、前回と同じ戦略の単純リトライは避けること",
      "- ただし試行履歴のうち「未検証の推測」は前回セッションの観察であり誤りうる。git log / git status / " +
        "このリポジトリの検証コマンドで現状を確認し、記録と現状が食い違う場合は現状を優先して方針を決めること",
      "- 前回の作業が既にコミットされている可能性がある。再実装を始める前に必ず git log を確認すること",
    ].join("\n"),
  ];
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
    "- 新規に作る `D-`(decisions)/ `HR-`(human-review)の ID は、マージ時に既存 ID と衝突すると機械的に改番されることがある。" +
      "本文から ID を参照するのは同一セッション内で作ったファイルに留めること(改番時は参照ごと機械的に書き換えられる)",
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
    "- この作業ツリーには main とのマージが進行中で、衝突マーカーが残っている(`git status` で確認する)",
    "- まず衝突を解消し、機械的検証(tests / lint / typecheck)を通した上で `git add` → `git commit` でマージを完成させること",
    "- 解消の判断に迷う箇所は main 側を優先する。優先した理由と捨てた変更は `.agent/decisions/` に記録する",
    "- `D-`/`HR-` の ID 採番が重複しただけの衝突は、Supervisor が改番して解決済み(index に載った状態)のことがある。まず `git status` で実際に残っている衝突を確認し、内容の衝突だけに集中すること",
    "- 衝突解消が終わってから、必要なら本来のタスクの続きに取りかかること",
  ].join("\n");
}

export function buildTaskPrompt(
  config: Config,
  task: Task,
  opts: { resuming?: boolean; startedAt?: string; deadline?: string } = {},
): string {
  const common = fs.readFileSync(PROMPT_PATH, "utf8");
  return [
    common,
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
  trigger: "inputs" | "idle";
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
    ctx.trigger === "inputs"
      ? "GOAL.md / Human Review 回答の変化を検知したため"
      : "実行可能なタスクがないため(定期探索)";
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
    "「変化なし」と明記された入力の再確認は省略してよい。新規 answered の ID が列挙されている場合、",
    "手順1ではそのファイルだけを読めばよい。「不明」の項目は従来どおり全て確認する。",
    "起動理由が変化検知のときは、変化した入力の取り込みに集中してよく、変化していない観点の手順は",
    "省略してよい。定期探索のときは全手順を従来どおり実施する(タスク全体・GOAL との整合の見直し",
    "機会はここで担保する)。",
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
  const common = fs.readFileSync(PROMPT_PATH, "utf8");
  const running = runningTasksSection(ctx);
  return [
    common,
    ...goalSection(),
    "---",
    "## 探索セッション",
    [
      "このセッションは「実行可能なタスクがないとき」「GOAL.md が更新された直後」",
      "「Human Review に新しい回答(answered)が付いたとき」に起動される。",
      "次の実行可能な作業を探して `.agent/tasks/` にタスクファイルとして登録すること。",
      "",
      launchInfoSection(ctx),
      ...(running === "" ? [] : ["", running]),
      "",
      "1. `.agent/human-review/` の各ファイルを読み、status が answered、またはチェックボックスにチェックが入っているものを確認する",
      "   (`status: open` のままチェックだけ入っている場合も回答済み)。",
      "   `対応:` が「不要」ならそのまま closed にする。それ以外は回答内容に沿って新タスクとして登録し、",
      "   frontmatter の status を closed に更新する。",
      "   BLOCK エントリだった場合は、影響タスクを再開できるか判断し、可能なら該当タスクを ready に戻す。",
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
      "5. 4. で突き合わせた GOAL とタスクの完了状況を踏まえて `.agent/OVERVIEW.md` を更新する。",
      "   GOAL に対する現在地(どこまで実装できたか)と、これから何をやれば完了に近づくかの見立てを",
      "   本文に短くまとめる。frontmatter の `updatedAt`(ISO 8601)と、`npm run agent:status` の",
      "   進捗バーが示す完了数・総数を `completed`/`total` として記録する(形式は `.agent/PROMPT.md` 参照)。",
      "   内容に実質的な変化がなければファイルには触れない(無変更の書き直しは禁止)。ファイルが無ければ",
      "   新規作成する。",
      "6. 既存の ready タスクが GOAL.md の方向性と矛盾していないか確認する。矛盾するタスクは",
      "   blocked にして note に理由(方向転換)を書き、`.agent/human-review/` へ REVIEW として記録する",
      "   (人間が最終確認してから破棄できるようにするため。勝手に削除しない)。",
      "",
      "GOAL.md が実質未記入の場合、新しい作業を発明してはならない(勝手な方向へ進まない)。",
      "その場合は `.agent/human-review/` に「方向性が未設定」を REVIEW として記録する(既に同趣旨の",
      "open エントリがあれば重複して記録しない)。OVERVIEW.md にも見立てを捏造せず「方向性未設定」と",
      "だけ書くに留める。",
      "",
      "タスクや記録の作成は PROMPT.md 記載のファイル形式(1 トピック 1 ファイル + YAML frontmatter)に従うこと。",
      "このセッションでは調査とタスク登録のみを行い、実装はしないこと。",
      "登録すべき作業がなければ何も登録せず終了してよい。",
    ].join("\n"),
  ].join("\n\n");
}

/** タスクに使うモデルを決める。失敗が閾値に達したらエスカレーション先 > タスク指定 > 既定 */
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
}

/** `git status --porcelain -- .agent` に何か出るか(自動コミットで流し切れたかの確認) */
function agentDirDirty(root: string = ROOT): boolean {
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

  commitAgentDir();
  if (agentDirDirty()) {
    log(`警告: .agent の差分をコミットできなかったため ${task.id} を起動しない(人間の並行作業を保護)`);
    return null;
  }

  const model = pickModel(config, t);
  const worktree = worktreePathFor(config.parallel.worktreeDir, t.id);
  const branch = branchNameFor(t.id);
  // 前回の統合が失敗し、コンフリクトを再現した状態の worktree が残っているか
  const resuming = fs.existsSync(worktree) && mergeInProgress(worktree);
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
  log(
    `${styleText("cyan", "▶")} ${t.id} "${t.title}" を開始 (model=${model}${escalated ? " エスカレーション" : ""}${t.retries > 0 ? `, 再試行 ${t.retries} 回目` : ""}${resuming ? ", 衝突解消の継続" : ""}, branch=${branch})`,
  );

  // cwd は ROOT のまま。CLI が --worktree の worktree へ移動する(worktree 自体は
  // WorktreeCreate hook が作る / 既にあれば再利用する)
  const deadline = sessionDeadline(startedAt, config.taskTimeoutMs);
  const result = runClaude(config, buildTaskPrompt(config, t, { resuming, startedAt, deadline }), model, ROOT, {
    extraArgs: ["--worktree", t.id],
    env: {
      CLAUDE_AGENT_SESSION_KIND: "task",
      CLAUDE_AGENT_TASK_ID: t.id,
      // worktree 上のセッションが並ぶと CPU が飽和するため、テストのワーカー数を絞る
      VITEST_MAX_THREADS: "2",
    },
  });

  return { ctx: { task: t, model, branch, worktree, launchStatus: t.status, resuming, startedAt }, result };
}

/**
 * reason: なぜ探索セッションを起動するのか(ログにそのまま表示する)。ctx: プロンプトへ注入する差分内訳
 * 戻り値の rateLimited は、run モードの自動終了判定(exploreDone)で
 * 「rate limit による中断は探索完了として扱わない」ために呼び出し元が使う。
 */
async function runExploreSession(
  config: Config,
  reason: string,
  ctx: ExploreContext,
): Promise<{ rateLimited: boolean }> {
  const startedAt = new Date().toISOString();
  const state = loadState();
  state.lastExploreAt = startedAt;
  state.sessionCount += 1;
  state.runningSessions.push({ kind: "explore", startedAt });
  saveState(state);

  let rateLimited = false;
  try {
    log(`${styleText("cyan", "▶")} 探索セッションを開始: ${reason}`);
    const deadline = sessionDeadline(startedAt, config.taskTimeoutMs);
    const res = await runClaude(config, buildExplorePrompt({ ...ctx, startedAt, deadline }), config.model, ROOT, {
      env: { CLAUDE_AGENT_SESSION_KIND: "explore" },
    });
    recordMetrics({ kind: "explore", model: config.model, res, sessionCwd: ROOT });
    if (isSessionRateLimited(res)) {
      applyRateLimit(config);
      rateLimited = true;
    } else {
      // 探索が成功した = レートリミットは回復している
      clearRateLimit();
      recordPermissionDenials("explore", res, ROOT);
      // このセッションが現在の入力(GOAL.md・answered な Review)を確認済みとして記録する。
      // レートリミット時は更新せず、復帰後に再度取り込ませる
      const st = loadState();
      st.inputsHash = hashInputs();
      st.goalHash = currentGoalHash();
      st.answeredKeys = currentAnsweredKeys();
      saveState(st);
      if (res.exitCode === 0) {
        log(`${styleText("green", "✔")} 探索セッション終了 (session ${sessionId(res)})`);
      } else {
        log(
          `${styleText("red", "✖")} 探索セッションが異常終了 (exitCode=${res.exitCode}, session ${sessionId(res)})${stderrTail(res)}`,
        );
      }
    }
  } finally {
    const st = loadState();
    st.runningSessions = st.runningSessions.filter((s) => s.kind !== "explore");
    saveState(st);
  }
  return { rateLimited };
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
 * opts.renames が渡されていれば(mergeAgentBranch が "partial" 分類で立てた ID 改番計画)、
 * 衝突再現後に ID 採番衝突だけを preResolveIdCollisions で先に解決しておく。実質衝突の
 * マーカーはそのまま残る。
 * 戻り値は実際に先行解決できた(旧)パスの一覧(実測値)。マージが衝突なく通った場合・
 * renames が無い場合・解決 0 件の場合は空配列。呼び出し側はこの実測値を記録・プロンプトへ
 * 反映すること(preResolvedRenames は「計画」に過ぎず、実際に解決できたとは限らない)。
 */
function reproduceMergeConflict(
  worktree: string,
  opts: { root?: string; renames?: Map<string, string> } = {},
): string[] {
  const root = opts.root ?? ROOT;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    execFileSync("git", ["merge", head], { cwd: worktree, stdio: "ignore" });
    log(`警告: ${worktree} で main のマージが衝突なく通った(次のセッションは通常起動になる)`);
    return [];
  } catch {
    // コンフリクトによる非ゼロ終了が期待動作
  }

  const renames = opts.renames ?? new Map<string, string>();
  const resolved = preResolveIdCollisions(worktree, renames);
  if (resolved.length > 0) {
    const resolvedIds = new Set(resolved.map(basenameId));
    const list = [...renames.entries()]
      .filter(([oldId]) => resolvedIds.has(oldId))
      .map(([o, n]) => `${o} -> ${n}`)
      .join(", ");
    log(`${worktree}: 先に ID 採番衝突 ${resolved.length} 件を解決した(${list})`);
  } else if (renames.size > 0) {
    log(`警告: ${worktree}: ID 採番衝突の先行解決に失敗した(計画: ${[...renames.keys()].join(", ")})。衝突マーカーが残っている`);
  }
  return resolved;
}

/** worktree 上の未コミット差分を .agent/patches/ へ退避する。戻り値はリポジトリ相対のパッチパスと対象パス */
function salvageWorktreeDiff(
  taskId: string,
  worktree: string,
  at: Date,
  root: string = ROOT,
): { patchFile: string; paths: string[] } | null {
  try {
    const name = patchFileName(taskId, at);
    const paths = salvagePatch(worktree, path.join(patchesDirOf(root), name));
    if (paths === null) return null;
    return { patchFile: `.agent/patches/${name}`, paths };
  } catch (err) {
    log(`警告: ${taskId} の未コミット差分の退避に失敗した: ${String(err)}`);
    return null;
  }
}

/**
 * 上限到達で failed になったタスクの worktree を片付け、ブランチは削除せず退避名へ改名する。
 * 成果を消さずに人間が後から拾えるようにするため。既に片付け済み(成功経路)なら何もしない。
 * 試行履歴へ追記する説明行を返す。
 */
function parkTaskWorktree(taskId: string, worktree: string, branch: string, at: Date): string[] {
  if (!fs.existsSync(worktree)) return [];
  const lines: string[] = [];
  const salvaged = salvageWorktreeDiff(taskId, worktree, at);
  if (salvaged !== null) {
    lines.push(
      `- 未コミット差分を \`${salvaged.patchFile}\` へ退避した(${formatDiffPathList(salvaged.paths)})。復元は \`git apply ${salvaged.patchFile}\``,
    );
  }
  try {
    removeWorktree(ROOT, worktree);
    const parked = parkedBranchNameFor(taskId, at);
    renameBranch(ROOT, branch, parked);
    lines.push(`- コミット済みの成果はブランチ \`${parked}\` に退避した(削除していない)`);
    log(`${taskId}: worktree を削除し、ブランチを ${parked} へ退避した`);
  } catch (err) {
    log(`警告: ${taskId} の worktree/ブランチ退避に失敗した: ${String(err)}`);
  }
  return lines;
}

/**
 * ID 採番衝突の先行解決について、「計画された renames」と「実際に解決できた件数」から
 * 人間可読な文を組み立てる(実測値専用。呼び出し側は reproduceMergeConflict /
 * preResolveIdCollisions の戻り値から resolvedCount を渡すこと)。分岐は 3 つ:
 *   - renames が未指定・空(先行解決の計画自体が無い) -> 補足なし(空文字列)
 *   - renames があり resolvedCount > 0 -> "ID 採番衝突 N 件は先に解決済み(D-x -> D-y, ...)"
 *   - renames があり resolvedCount === 0 -> "ID 採番衝突の先行解決に失敗した(D-x, ... の
 *     衝突マーカーが残っている)"
 * finishTaskSession の fail 理由 / recoverOrphanBranch の recordStartupRecoveryNote で
 * 共通して使う(どちらも reproduceMergeConflict の戻り値を実測値として持っている)。
 */
export function describePreResolvedRenames(renames: Map<string, string> | undefined, resolvedCount: number): string {
  if (renames === undefined || renames.size === 0) return "";
  if (resolvedCount > 0) {
    const list = [...renames.entries()].map(([o, n]) => `${o} -> ${n}`).join(", ");
    return `ID 採番衝突 ${resolvedCount} 件は先に解決済み(${list})`;
  }
  return `ID 採番衝突の先行解決に失敗した(${[...renames.keys()].join(", ")} の衝突マーカーが残っている)`;
}

/**
 * MergeOutcome を 1 行のログ表現にする。この関数は mergeAgentBranch の戻り値(= 計画)
 * しか見ておらず、ID 採番衝突の先行解決を実際に試みてすらいない(worktree 側の
 * reproduceMergeConflict が呼ばれるのはこの後)。そのため conflict の補足は
 * 「先行解決予定」という計画止まりの表現に留め、解決済みであるかのようには書かない
 * (実測値を使った文言は describePreResolvedRenames 側が担う)。
 */
function describeMergeOutcome(outcome: MergeOutcome): string {
  switch (outcome.result) {
    case "merged":
      return "main へマージした";
    case "renumbered": {
      const parts: string[] = [];
      if (outcome.renames.size > 0) {
        parts.push(`ID を改番 ${outcome.renames.size} 件: ${[...outcome.renames.entries()].map(([o, n]) => `${o} -> ${n}`).join(", ")}`);
      }
      if (outcome.resolvedTaskFile) {
        parts.push("タスクファイルはブランチ側を採用");
      }
      return `main へマージした(機械的に解決${parts.length > 0 ? `: ${parts.join(" / ")}` : ""})`;
    }
    case "nothing-to-merge":
      return "ブランチに新しいコミットがなく、マージするものがなかった";
    case "conflict": {
      const planned = outcome.preResolvedRenames;
      const note = planned !== undefined && planned.size > 0 ? ` (ID 改番 ${planned.size} 件を先行解決する予定)` : "";
      return `コンフリクトのためマージを中止した(${outcome.paths.join(", ")})${note}`;
    }
    case "blocked":
      return `マージを開始できなかった: ${outcome.reason}`;
    case "wedged":
      return `main が git 操作の途中で固まった(merge --abort 失敗): ${outcome.stderr}`;
  }
}

/**
 * finishTaskSession が main 側のタスクファイルへ書き込む直前に必ず呼ぶガード。
 * main が git 操作(マージ等)の途中なら true を返し、警告ログを 1 行出す。
 * 途中の書き込み(saveTask 等)がその後の `git merge --abort` を `not uptodate` で
 * 失敗させる原因になりうるため(実際に本番でこの経路が発生し main が固まった)、
 * 書き込み側は必ずこれを先にチェックしてスキップする。
 */
export function skipMainWriteIfGitBusy(taskId: string, root: string = ROOT): boolean {
  if (!gitOperationInProgress(root)) return false;
  log(`警告: ${taskId}: main がマージ途中のため記録を書かない(復旧後の再試行で再評価される)`);
  return true;
}

/**
 * タスクセッション終了後の後始末。順序に意味がある:
 * sweep(worktree 側の .agent コミット)→ タスクファイル更新判定 → マージ →
 * メトリクス → permission 拒否記録 → 結果分類 → 退避記録 → runningSessions から除去。
 *
 * タイムアウト・クラッシュ・レートリミットで終わったセッションでもマージは必ず試みる
 * (途中までコミットされた成果を worktree に閉じ込めないため)。
 */
function finishTaskSession(config: Config, ctx: TaskSessionContext, res: SessionResult): void {
  const { task, model, branch, worktree } = ctx;
  const taskId = task.id;
  const now = new Date();
  const at = now.toISOString();
  const session = sessionId(res);

  // 瞬時クラッシュの検知。起動直後に異常終了するセッションが連続する場合は環境要因による
  // 系統的な故障の可能性が高いため、その連続回数を scheduler.ts の crash-backoff ルールへ渡す
  // (fastCrashStreak >= 3 になった周回だけ、起動可能でも 1 周回起動を見送る)。
  const wallMs = now.getTime() - new Date(ctx.startedAt).getTime();
  if (res.exitCode !== 0 && !res.timedOut && wallMs < FAST_CRASH_MS) {
    fastCrashStreak += 1;
  } else {
    fastCrashStreak = 0;
  }

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
  /** reproduceMergeConflict が実際に先行解決できた件数(実測値。outcome.preResolvedRenames は計画に過ぎない) */
  let preResolvedCount = 0;
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
      taskFileChanged = taskFileChangedOnBranch(ROOT, branch, taskId);

      // 3. 統合。マージ未完了のまま終わった衝突解消セッションは worktree をそのまま残す
      mergeStuck = mergeInProgress(worktree);
      if (mergeStuck) {
        mergeLabel = "unresolved";
        log(`${taskId}: 衝突解消が未完のままセッションが終了した。worktree を残す`);
      } else {
        outcome = mergeAgentBranch(ROOT, branch, taskId, task.title, AGENT_COMMIT_TRAILER);
        mergeLabel = outcome.result;
        log(`${taskId}: ${describeMergeOutcome(outcome)}`);
        if (outcome.result === "conflict") {
          conflictPaths = outcome.paths;
          conflictKind = outcome.conflictKind;
          preResolvedCount = reproduceMergeConflict(worktree, { renames: outcome.preResolvedRenames }).length;
        } else if (outcome.result === "wedged") {
          // main が git merge --abort の失敗で固まっている。ここでは stderr を全文ログに
          // 残すだけに留め、worktree・ブランチ・stale なコンフリクトには一切触れない
          // (誤って現在のブランチのものと扱わない。次の試行が回復後に再評価する)
          log(`error: ${taskId}: ${describeMergeOutcome(outcome)}`);
        } else if (outcome.result !== "blocked") {
          // blocked は main 側でマージを開始すらできていない状態。worktree に手を触れず次の試行へ回す
          leftovers = salvageWorktreeDiff(taskId, worktree, now);
          removeWorktree(ROOT, worktree);
          if (!deleteBranch(ROOT, branch)) log(`警告: ブランチ ${branch} の削除に失敗した`);
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
      if (skipMainWriteIfGitBusy(taskId)) return;
      const t = loadTask(taskId);
      if (t === null) {
        log(`警告: ${taskId} のタスクファイルが見つからないため結果を記録できない`);
        return;
      }
      recordFailure(t, { maxRetries: config.maxRetries, reason, kind, at });
      if (t.status === "failed") {
        const lines = parkTaskWorktree(taskId, worktree, branch, now);
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

    // 6. 結果の分類(判定の順序に意味がある)
    if (res.timedOut) {
      fail(`タイムアウト(${config.taskTimeoutMs}ms)`, "timeout");
    } else if (isSessionRateLimited(res)) {
      // レートリミットはタスクの失敗として数えない(retries を増やさない)。worktree の
      // 扱いはマージ結果に従うため、ここでは待機の設定だけ行う
      applyRateLimit(config);
    } else {
      clearRateLimit();
      // 統合できていれば main 側のタスクファイルにセッションの更新が反映されている
      const merged = loadTask(taskId);
      const statusUnchanged = merged !== null && merged.status === ctx.launchStatus;
      if (mergeStuck) {
        fail("衝突解消が未完のまま終了。main とのマージが進行中のまま残っている", "merge-conflict");
      } else if (outcome !== null && outcome.result === "wedged") {
        // main が git merge --abort の失敗で固まっている。fail() は呼ばない: retries を
        // 消費させず、main 側のタスクファイルにも一切書き込まない(復旧後の再試行で
        // 現在の状態のまま再評価される)。ログだけ残す
        log(
          `${styleText("red", "✖")} ${taskId}: main が git 操作の途中で固まっているため記録を書かない(復旧後の再試行で再評価される)`,
        );
      } else if (outcome !== null && outcome.result === "conflict") {
        const note = describePreResolvedRenames(outcome.preResolvedRenames, preResolvedCount);
        fail(`main へのマージが衝突した(${conflictPaths.join(", ")})${note !== "" ? `。${note}` : ""}`, "merge-conflict");
      } else if (outcome !== null && outcome.result === "blocked") {
        fail(`main へのマージを開始できなかった: ${outcome.reason}`, "merge-conflict");
      } else if (res.exitCode !== 0) {
        fail(`claude が異常終了 (exitCode=${res.exitCode})${stderrTail(res)}`, "crash");
      } else if (!taskFileChanged && statusUnchanged) {
        fail("セッションがタスクファイルの status を更新せず終了した", "no-status-update");
      } else {
        logFinalStatus();
      }
    }

    // 7. 退避したパッチを試行履歴へ残す(worktree はもう無く、ここにしか手がかりがない)
    if (leftovers !== null && !skipMainWriteIfGitBusy(taskId)) {
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
//   main のワーキングツリーに対する git 操作(commitAgentDir(ROOT) / mergeAgentBranch)と
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

async function mainLoop(once: boolean): Promise<void> {
  const loaded = loadConfig();
  // once は 1 セッション実行して終わるモードなので、並列度を 1 に固定する
  // (planLoopStep が空きスロット分まとめて launch を返すのを防ぐ)
  const config: Config = once ? { ...loaded, parallel: { ...loaded.parallel, maxSessions: 1 } } : loaded;
  // once は 1 セッションで終了するため、段階停止で STOP(clean) を作っても効き目が無いに等しく、
  // 作られたファイルだけが残って次回 run が起動直後に停止する罠になる。
  // そのため once では段階化せず即緊急停止にする。
  process.on("SIGINT", once ? () => emergencyStop("SIGINT") : handleSigint);
  process.on("SIGTERM", () => emergencyStop("SIGTERM"));
  log(`supervisor start (mode=${once ? "once" : "run"})`);
  // 前回の終了時に積み残した .agent/ の差分もここで拾う。復旧が無かった周回で
  // 「中断していたタスクを復旧する」と名乗ると嘘になるため、件数で文言を出し分ける。
  const recovered = startupRecoveryTotal(recoverStartup(config));
  if (recovered > 0) commitAgentDir("docs(agent): 中断していたタスクを復旧する");
  else commitAgentDir();

  /** このループで完了したセッション(タスク・探索)の数。once の終了判定に使う */
  let completedCount = 0;
  // この周回までに main の `.agent/` を触ったか。アイドル・rate limit 待機の周回まで
  // コミットすると内容を語らない定型コミットが 1 分おきに積み上がるため、`.agent/` を
  // 触った場合だけ、次に待機へ入る直前とループ終了時にまとめてコミットする。
  let agentDirty = false;
  // run モードの自動終了判定に使うプロセス内フラグ(永続化しない)。探索セッションが
  // rate limit 以外の理由で完了したら true、タスクセッションが完了したら false に戻す。
  // 「探索したのに新しいタスクが生まれなかった」を検出するための唯一の判定材料。
  let exploreDone = false;
  // 直前に完了した探索セッションが新規タスクを 1 件も登録しなかったか(プロセス内フラグ、
  // 永続化しない)。true の間は run モードでも exploreDue のクールダウンを課し、
  // 空振り探索がタスク完了のたびに即座に連鎖するのを防ぐ。
  let lastExploreYieldedNothing = false;

  try {
    // worktree 置き場が書き込めない環境(EACCES 等)では、タスクセッションが 1 本も
    // 起動できないまま起動直後にクラッシュを繰り返すだけになる。ループへ入る前にまとめて
    // 検証し、その場合は原因と復旧手順を示して止まる(機械的な再試行の空回りを避ける)。
    const worktreeDirError = ensureWritableDir(config.parallel.worktreeDir);
    if (worktreeDirError !== null) {
      log(`fatal: worktree 置き場 ${config.parallel.worktreeDir} に書き込めない: ${worktreeDirError}`);
      log(
        `fatal: 復旧するには次を実行する: sudo mkdir -p ${config.parallel.worktreeDir} && sudo chown node: ${config.parallel.worktreeDir}`,
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
      const finished = drainCompletedSessions(config);
      if (finished > 0) {
        completedCount += finished;
        agentDirty = true;
        // タスクセッションが完了して main の状態が変わったため、終了前にもう一度
        // 探索して GOAL と突き合わせ直す必要がある
        exploreDone = false;
      }

      // 後始末で state.json が書き換わるため、判断材料はその後で読む
      const state = loadState();
      const runningCount = state.runningSessions.length;

      // ローテーションはセッションが走っていない周回だけ行う(走行中のセッションが参照して
      // いるファイルを動かさないため)。退避パッチの掃除も同じ間隔で行う(git 管理外なので
      // 消してもコミットは要らず、agentDirty は立てない)。
      if (runningCount === 0) {
        // main が git 操作(マージ等)の途中で固まっていないかを確認し、可能なら自己修復する。
        // wedged(F3)や、想定していない経路で残ったマージが起きても、次の周回でここが拾って
        // 復旧を試みる。abortInterruptedAutoMerge 自体は失敗を投げずに false を返す設計だが、
        // 想定外の例外を投げても mainLoop を落とさないよう念のため try で囲む
        if (gitOperationInProgress(ROOT)) {
          log("警告: main で git 操作が進行中を検知。自己修復を試みる");
          try {
            abortInterruptedAutoMerge(ROOT);
          } catch (err) {
            log(`警告: 自己修復に失敗した: ${String(err)}`);
          }
          if (gitOperationInProgress(ROOT)) {
            log("fatal: 人間の git 操作が進行中、または巻き戻し不能。対処後に再起動すること");
            break;
          }
        }

        if (runRotate() !== null) agentDirty = true;
        prunePatches();
      }

      const stopMode = readStopMode();
      const dirtyPaths = stopMode === null ? [] : dirtyPathsOutsideAgent();

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
      // 周回でだけ動かす(planLoopStep の優先度 1〜3 が成立する周回では使われない)。
      const gathering =
        stopMode === null && rateLimitedUntilMs === null && !(once && completedCount >= 1);

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

      const { runnable, snoozedCount } =
        gathering && !inputsChanged ? selectRunnable() : { runnable: [], snoozedCount: 0 };

      const action = planLoopStep({
        now: new Date(),
        once,
        completedCount,
        stopMode,
        mainDirtyOutsideAgent: dirtyPaths.length > 0,
        runningCount,
        maxSessions: config.parallel.maxSessions,
        runnableTaskIds: runnable.map((t) => t.id),
        inputsChanged,
        triageEnabled: config.triage.enabled,
        triageAttempted,
        exploreEnabled: config.explore.enabled,
        exploreDue:
          state.lastExploreAt === null ||
          Date.now() - new Date(state.lastExploreAt).getTime() >= config.explore.minIntervalMs,
        exploreDone,
        lastExploreYieldedNothing,
        pendingSnoozeCount: snoozedCount,
        rateLimitedUntilMs,
        idlePollMs: config.idlePollMs,
        fastCrashStreak,
      });

      if (action.type === "stop") {
        // planLoopStep は実行中セッションが 0 のときしか stop を返さないので通常は空だが、
        // 後始末を取りこぼさないよう最後にもう一度掃き出す
        completedCount += drainCompletedSessions(config);
        log(action.reason);
        if (dirtyPaths.length > 0) log(`残った差分: ${formatDiffPathList(dirtyPaths)}`);
        if (action.cause === "idle-exit") {
          const idleExitTasks = loadTasks();
          const blockedCount = idleExitTasks.filter((t) => t.status === "blocked").length;
          const failedCount = idleExitTasks.filter((t) => t.status === "failed").length;
          const openBlockCount = classifyHumanReview(parseHumanReview()).openBlock.length;
          if (blockedCount + failedCount + openBlockCount > 0) {
            log(
              `残件: blocked ${blockedCount} 件 / failed ${failedCount} 件 / human-review(BLOCK) ${openBlockCount} 件 — 詳細は npm run agent:status`,
            );
          }
          log("対応後、再開するには npm run agent を実行する");
        }
        break; // .agent/ の最終フラッシュは finally の commitAgentDir() が行う
      }

      if (action.type === "triage") {
        // await より前に立てる(triage が HR/タスクファイルを書き換えうるため、
        // セッションが例外を投げてもこの周回はコミット扱いにする)
        agentDirty = true;
        const ok = await runHumanReviewTriage(config);
        if (!ok) log("警告: triage セッションに失敗した。次回は Stage 3(探索)にフォールバックする");
        // 無限リトライ防止のため、成功・失敗に関わらずこの入力ハッシュへの triage 試行を記録する
        const st = loadState();
        st.triageAttemptedHash = currentInputsHash;
        saveState(st);
        completedCount += 1;
        continue;
      }

      if (action.type === "explore") {
        const { goalChanged, newAnsweredIds } = diffInputs(state, {
          goalHash: currentGoalHash(),
          answeredKeys: currentAnsweredKeys(),
        });
        // await より前に立てる(セッションが例外を投げてもこの周回はコミット扱いにし、
        // セッションが書いた .agent/ の状態を失わせないため)
        agentDirty = true;
        const reason =
          action.trigger === "inputs"
            ? "GOAL.md / Human Review 回答の変化を検出。取り込みと消化順序の再検討"
            : "実行可能なタスクがないため、次の作業を探す";
        // 探索セッションの前後で main の `.agent/tasks/` の ID 集合を比べ、新規登録の有無を見る。
        // 並走するタスクセッションは専用 worktree で動き、その成果が main へ現れるのは
        // ループ先頭の drainCompletedSessions()(同期実行)による自動マージ時なので、
        // この await の区間で main にタスクが増えるのは探索セッション自身の仕業に限られる。
        const taskIdsBefore = new Set(loadTasks().map((t) => t.id));
        const { rateLimited } = await runExploreSession(config, reason, {
          trigger: action.trigger,
          goalChanged,
          newAnsweredIds,
          runningTasks: runningTaskSummaries(state),
        });
        const yielded = loadTasks().some((t) => !taskIdsBefore.has(t.id));
        // rate limit による中断は探索完了として扱わない(解除後に再試行させる)。
        // その場合は空振り判定も更新しない(中断前の状態を引きずらせない)
        if (!rateLimited) {
          exploreDone = true;
          lastExploreYieldedNothing = !yielded;
        }
        completedCount += 1;
        continue;
      }

      if (action.type === "launch") {
        // 空きスロット分をまとめて起動する。await しないので、次の周回はすぐ回り、
        // 完了は completedSessions 経由で先頭の掃き出しへ戻ってくる
        const byId = new Map(runnable.map((t) => [t.id, t]));
        let launched = 0;
        for (const taskId of action.taskIds) {
          const task = byId.get(taskId);
          if (task === undefined) continue; // 判断材料と実行の間でタスクが消えた場合の保険
          agentDirty = true; // 起動処理自体が main の .agent/ をコミットするため先に立てる
          if (launchTaskSession(config, task)) launched += 1;
          // 起動できなかった 1 件は次の周回で選び直す(startTaskSession 側でログ済み)
        }
        if (launched === 0) {
          // 1 件も起動できなかった(.agent をコミットできない等)場合、同じ条件で即座に
          // 選び直すと空回りし続けるため、状況が変わるのを待ってから次の周回へ進む。
          // once は起動できないまま待ち続けても意味がないのでここで終了する。
          if (once) {
            log("タスクセッションを起動できなかった。終了");
            break;
          }
          await sleep(config.idlePollMs);
        }
        continue;
      }

      // wait: 待機に入る前に、この周回までに溜めた .agent/ の差分を流し切る。
      // sleep は wakeEmitter でも起きるため、走っているセッションの完了は待機を打ち切って
      // 先頭の掃き出しへ戻す(idlePollMs を待たされない)
      if (agentDirty) {
        commitAgentDir();
        agentDirty = false;
      }
      if (action.why === "rate-limit") log(`rate limit 待機中(${Math.ceil(action.ms / 60000)} 分)`);
      if (action.why === "crash-backoff") {
        log("警告: 瞬時クラッシュが連続している。環境要因の可能性が高いため起動を抑制する");
      }
      await sleep(action.ms);
    }
  } finally {
    // break・例外・once 終了のいずれの経路でも 1 回だけ最終フラッシュする。finally は
    // break が効く前に走るため、抜け道は構造的に存在しない(break 側に手を入れる必要がない)。
    commitAgentDir();
  }
  log("supervisor stop");
}

// ---------- CLI サブコマンド ----------

/** archive 済みタスクの ID も母集団に含め、ローテーション後の ID 再利用・衝突を防ぐ */
function nextTaskId(): string {
  const max = [...listMdFiles(TASKS_DIR), ...listMdFiles(path.join(ARCHIVE_DIR, "tasks"))]
    .map((f) => Number(f.replace(/^T-/, "").replace(/\.md$/, "")))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `T-${String(max + 1).padStart(3, "0")}`;
}

const ADD_FLAG_NAMES = ["desc", "priority", "deps", "model"];

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

function cmdAdd(argv: string[]): void {
  const positional = positionalArgs(argv);
  const title = positional[0];
  if (!title) {
    console.error(
      '使い方: supervisor.ts add "タイトル" [--desc 説明] [--priority N] [--deps a,b] [--model 名]',
    );
    process.exit(1);
  }
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const now = new Date().toISOString();
  const fallbackBody = positional.slice(1).join("\n") || title;
  const task: Task = {
    id: nextTaskId(),
    title,
    status: "ready",
    priority: Number(opt("priority") ?? 3),
    dependencies: opt("deps")?.split(",").filter(Boolean) ?? [],
    retries: 0,
    createdAt: now,
    body: opt("desc") ?? fallbackBody,
  };
  const model = opt("model");
  if (model !== undefined) task.model = model;
  saveTask(task);
  console.log(`追加: .agent/tasks/${task.id}.md "${task.title}" (priority=${task.priority})`);
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

/** 1 タスクの表示(id/priority/title 行 + 依存行 + note 行) */
function printTaskLine(t: Task, byId: Map<string, Task>, full: boolean): void {
  const idCol = t.id.padEnd(7);
  let line = `  ${idCol}p${t.priority}  ${t.title}`;
  if (t.retries > 0) {
    line += ` ${styleText("yellow", `retries=${t.retries}`)}`;
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
    const allSatisfied = t.dependencies.every((d) => depSatisfied(byId, d));
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

function cmdList(argv: string[]): void {
  const full = argv.includes("--full");
  const tasks = loadTasks();
  // 依存表示用の参照は archive 済みタスクも含める(rotate 後の依存先を (missing) ではなく
  // ✔ 完了として表示するため)。同一 ID はアクティブ側を優先
  const byId = new Map([...loadArchivedTasks(), ...tasks].map((t) => [t.id, t]));

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
    for (const t of group) printTaskLine(t, byId, full);
  }
  if (!printedGroup) console.log("タスクなし");
}

// ---------- 人間向け: status / retry ----------

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
}

/** .agent/human-review/ の各ファイルをエントリとして読む */
function parseHumanReview(): HrEntry[] {
  return listMdFiles(HR_DIR).map((fileName) => {
    const id = fileName.replace(/\.md$/, "");
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(HR_DIR, fileName), "utf8");
    } catch {}
    const { data, body } = parseFrontmatter(raw);
    return {
      id,
      title: str(data.title) || id,
      status: str(data.status) || "?",
      importance: str(data.importance) || "?",
      raw,
      body,
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
function closeHumanReview(id: string, note?: string): void {
  const file = path.join(HR_DIR, `${id}.md`);
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
    const res = await runClaude(config, buildTriagePrompt(stage2, tasks), config.triage.model, ROOT, {
      extraArgs: ["--disallowed-tools", "Edit Write Task TodoWrite WebFetch WebSearch Bash", "--max-turns", "6"],
      env: { CLAUDE_AGENT_SESSION_KIND: "triage" },
    });
    recordMetrics({ kind: "triage", model: config.triage.model, res, sessionCwd: ROOT });

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
        const id = nextTaskId();
        saveTask({
          id,
          title: d.title,
          status: "ready",
          priority: d.priority,
          dependencies: [],
          retries: 0,
          createdAt: new Date().toISOString(),
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
): string[] {
  if (sessions.length === 0) return [];

  const lines = [`実行中のセッション (${sessions.length}/${maxSessions})`];

  for (const s of sessions) {
    let mainLine: string;
    if (s.kind === "explore") {
      mainLine = "探索セッション  (実行可能なタスクを探索中)";
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

/** .agent/metrics.jsonl の各行を読む。ファイルが無ければ空配列、壊れた行はスキップして続行する */
function loadMetrics(): SessionMetrics[] {
  if (!fs.existsSync(METRICS_PATH)) return [];
  const lines = fs
    .readFileSync(METRICS_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const entries: SessionMetrics[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SessionMetrics);
    } catch {}
  }
  return entries;
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
    return parseOverview(fs.readFileSync(OVERVIEW_PATH, "utf8"));
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
  const when = overview.updatedAt !== "" ? overview.updatedAt : "不明";
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
      try {
        if (!fs.existsSync(entry.path) || !mergeInProgress(entry.path)) continue;
      } catch {
        continue;
      }
      worktrees.push({ taskId: path.basename(entry.path), path: entry.path });
    }
  } catch {
    // worktree を列挙できない場合は「無し」として表示を続ける
  }
  return { worktrees, parkedBranches };
}

/** .agent/permission-denials.jsonl の各行を読む。ファイルが無ければ空配列、壊れた行はスキップして続行する */
export function loadPermissionDenials(agentDir: string = AGENT_DIR): PermissionDenialRecord[] {
  const p = permissionDenialsPathOf(agentDir);
  if (!fs.existsSync(p)) return [];
  const lines = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const entries: PermissionDenialRecord[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as PermissionDenialRecord);
    } catch {}
  }
  return entries;
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
}

/**
 * permission 拒否ログを直近ウィンドウ(既定 7 日)でフィルタし、パターン集約して件数降順の
 * 上位 maxRows 件(既定 5)を返す純関数。status 表示専用で、denyRules 等の記録判断には関与しない。
 */
export function summarizePermissionDenials(
  entries: PermissionDenialRecord[],
  now: Date,
  opts?: { windowMs?: number; maxRows?: number },
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
  lines.push(
    "→ 許可するなら .agent/claude-settings.json の permissions.allow に追記(次に起動するセッションから有効。deny が allow に優先)",
  );
  return lines;
}

function cmdStatus(): void {
  const tasks = loadTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = loadState();
  const hr = parseHumanReview();
  const by = (s: TaskStatus): Task[] => tasks.filter((t) => t.status === s);

  console.log("== 自律実行ステータス ==");
  // 進捗は archive へ退避済みの completed タスクも分子・分母に含め、
  // ローテーション後も「完了 X/N」が累積の実績を反映するようにする
  const archivedCompleted = loadArchivedTasks().filter((t) => t.status === "completed").length;
  console.log(progressBar(by("completed").length + archivedCompleted, tasks.length + archivedCompleted));
  const counts = STATUS_ORDER.map((s) => by(s).length)
    .map((n, i) => [STATUS_ORDER[i]!, n] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${statusLabel(s)} ${n}`)
    .join(" / ");
  console.log(counts || "タスクなし");

  const overview = loadOverview();
  const { rest: overviewRest, lines: overviewLines } = overviewSectionLines(
    overview,
    by("completed").length + archivedCompleted,
    tasks.length + archivedCompleted,
  );
  console.log(`\n${styledSectionLabel("概観", overviewRest)}`);
  for (const l of overviewLines) console.log(`  ${l}`);

  const { openBlock, openReview, answered } = classifyHumanReview(hr);
  const failed = by("failed");
  const blocked = by("blocked");
  /** open 行の表示用ラベル。回答本文はあるがチェック忘れの場合に注意喚起を付ける */
  const hrLine = (h: HrEntry): string =>
    hasFreeTextAnswer(h.body)
      ? `${h.id}: ${h.title}\n      回答本文あり — [ ] を [x] にすると取り込まれます`
      : `${h.id}: ${h.title}`;

  // config は要対応セクション(worktree 置き場)と稼働状態の両方で使う
  let taskTimeoutMs = 2400000;
  let maxSessions = 1;
  let worktreeDir = defaultWorktreeDir(ROOT);
  try {
    const c = loadConfig();
    taskTimeoutMs = c.taskTimeoutMs;
    maxSessions = c.parallel.maxSessions;
    worktreeDir = c.parallel.worktreeDir;
  } catch {
    // config が読めなければ既定値にフォールバック
  }
  const pending = collectPendingConflicts(ROOT, worktreeDir);

  const section = (tag: string, rest: string, lines: string[]): void => {
    if (lines.length === 0) return;
    console.log(`\n${styledSectionLabel(tag, rest)}`);
    for (const l of lines) console.log(`  ${l}`);
  };
  section("要対応", "open な Human Review (BLOCK) — タスクが停止中:", openBlock.map(hrLine));
  section(
    "要対応",
    "failed タスク — retry するか断念を判断:",
    failed.map((t) => `${t.id}: ${t.title}${t.note ? `\n      note: ${t.note}` : ""}`),
  );
  section(
    "要対応",
    "blocked タスク:",
    blocked.map((t) => `${t.id}: ${t.title}${t.note ? `\n      note: ${t.note}` : ""}`),
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
  section("確認推奨", "open な Human Review (REVIEW/INFO) — 回答を待たず続行中:", openReview.map(hrLine));
  section(
    "対応不要",
    "answered — 探索セッションが割り込みで取り込み予定:",
    answered.map((h) => `${h.id}: ${h.title}`),
  );
  if (
    openBlock.length +
      openReview.length +
      answered.length +
      failed.length +
      blocked.length +
      pending.worktrees.length +
      pending.parkedBranches.length ===
    0
  ) {
    console.log("\n要対応事項なし");
  }

  const denialSummary = summarizePermissionDenials(loadPermissionDenials(), new Date());
  section(
    "対応不要",
    `直近7日の permission 拒否 ${denialSummary.total} 件(セッションは代替手段で続行済み。回答不要):`,
    permissionDenialLines(denialSummary),
  );

  console.log("\n実行中のタスク");
  const running = runningSessionLines(state.runningSessions, byId, new Date(), taskTimeoutMs, maxSessions);
  if (running.length === 0) {
    console.log("  なし");
  } else {
    for (const l of running) console.log(`  ${l}`);
  }

  // 人間の入力(GOAL.md・answered な Human Review)が未取り込みなら、mainLoop は新規タスクを
  // 起動せず探索セッションを割り込ませる。表示もその実態に合わせる
  const inputsChanged = isInputsChanged(state.inputsHash, hashInputs());
  if (inputsChanged) {
    console.log("\n新規タスクの起動は保留中: 人間の入力変化(answered HR / GOAL.md)を取り込む探索セッションを優先");
    console.log(`  → 実行中セッションの完了後に探索を 1 本実行し、その後 ${maxSessions} 並列に戻ります`);
  }

  console.log(`\n${inputsChanged ? "探索後に起動予定のタスク" : "次に実行予定のタスク"}`);
  const runningTaskIds = new Set(
    state.runningSessions.map((s) => s.taskId).filter((id): id is string => id !== undefined),
  );
  const next = nextRunnableTasks(tasks, runningTaskIds, 3);
  const snoozed = snoozedTasksByUntil(tasks, runningTaskIds);
  if (next.length === 0) {
    console.log(
      snoozed.length > 0
        ? `  なし(スヌーズ待ち ${snoozed.length} 件、最短解除 ${snoozed[0]!.snoozeUntil})`
        : "  なし(依存待ちの可能性)",
    );
  } else {
    for (const t of next) console.log(`  ${t.id}  p${t.priority}  ${t.title}`);
  }

  console.log(`\nスヌーズ中のタスク (${snoozed.length} 件)`);
  if (snoozed.length === 0) {
    console.log("  なし");
  } else {
    for (const t of snoozed) {
      console.log(`  ${t.id}  ${t.title}  ${styleText("dim", `[snoozed until ${t.snoozeUntil}]`)}`);
    }
    console.log("  → 残っている間、run モードのループは自動終了(idle-exit)しない");
  }

  console.log("\n-- 稼働状態 --");
  console.log(`セッション数: ${state.sessionCount} / 最終探索: ${state.lastExploreAt ?? "未実行"}`);
  if (state.rateLimit.resumeAt !== null) {
    console.log(`レートリミット待機中: ${state.rateLimit.resumeAt} まで`);
  }
  if (isSupervisorSourceStale(state.supervisorSourceHash, supervisorSourceHash(ROOT))) {
    console.log(
      "  ※ supervisor のコードが起動後に変更されている — 稼働中なら再起動(npm run agent を止めて起動し直す)しないと反映されない",
    );
  }

  const metrics = loadMetrics();
  if (metrics.length > 0) {
    const last = metrics[metrics.length - 1]!;
    const totalCost = metrics.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
    const fmtCost = (cost: number | undefined): string => (cost !== undefined ? `$${cost.toFixed(4)}` : "不明");
    console.log(
      `直近セッション: cost=${fmtCost(last.costUsd)} / turns=${last.numTurns ?? "不明"}${last.abnormal ? ` / 異常終了: ${last.abnormal}` : ""}`,
    );
    console.log(`累計: cost=${fmtCost(totalCost)} / セッション数=${metrics.length}`);
  }
  console.log("\n確認・介入の手順: README.md の「人間の関与」");
}

function cmdRotate(): void {
  const summary = runRotate();
  if (summary !== null) {
    // subject はステージ内容から生成させる(rotate 以外の未コミット差分が同時に載ることがあり、
    // rotate の要約だけを名乗ると実際のコミット内容と食い違うため)
    commitAgentDir();
  }
}

function cmdRetry(argv: string[]): void {
  const id = argv[0];
  if (!id) {
    console.error("使い方: supervisor.ts retry <task-id>");
    process.exit(1);
  }
  const t = loadTask(id);
  if (!t) {
    console.error(`タスクが見つからない: ${id}`);
    process.exit(1);
  }
  if (t.status !== "failed" && t.status !== "blocked") {
    console.error(`retry は failed / blocked のタスクのみ対象(${id} は ${t.status})`);
    process.exit(1);
  }
  const prev = t.status;
  t.status = "ready";
  t.retries = 0;
  t.note = `人間の介入により ready へ戻す(元: ${prev}。${t.note ?? "-"})`;
  saveTask(t);
  console.log(`${id} を ready に戻した(retries をリセット)。失敗原因が残っていれば先に対処すること`);
}

// CLI ディスパッチ。テスト等からの import 時は実行しない
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const cmd = process.argv[2];
  switch (cmd) {
    case "run":
      await mainLoop(false);
      break;
    case "once":
      await mainLoop(true);
      break;
    case "add":
      cmdAdd(process.argv.slice(3));
      break;
    case "list":
      cmdList(process.argv.slice(3));
      break;
    case "status":
      cmdStatus();
      break;
    case "retry":
      cmdRetry(process.argv.slice(3));
      break;
    case "rotate":
      cmdRotate();
      break;
    default:
      console.error(
        "使い方: node .agent/supervisor/supervisor.ts <run|once|add|list|status|retry|rotate>",
      );
      process.exit(1);
  }
}
