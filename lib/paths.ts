/**
 * ccloop が読み書きするパスの一元管理
 *
 * ccloop は利用者のリポジトリの外(DevContainer feature として `/usr/local/share/ccloop/` 等)へ
 * インストールされ、任意のリポジトリに対して実行される。そのためツール自身の設置場所から
 * リポジトリルートを逆算することはできず、実行時に決定する必要がある。
 *
 * パスは 2 系統に分かれる。
 *
 * - `.agent/` 配下(git 管理): GOAL.md / OVERVIEW.md / config.json / tasks/ / decisions/ /
 *   human-review/ / archive/(+ 任意で claude-settings.json / PROMPT.local.md)。
 *   人間とエージェントが読み書きし、リポジトリの履歴に残すべきデータ。
 *   自律実行セッションの共通ルールはツール本体が持つ(`lib/prompt/PROMPT.md`)ため
 *   `.agent/` には置かない。利用側は `PROMPT.local.md` で追記だけできる。
 * - state ディレクトリ(git 管理外・リポジトリ外): state.json / metrics.jsonl /
 *   permission-denials.jsonl / patches/ / 生成した claude settings / 生成した system prompt /
 *   worktrees/。ツールの実行時状態であり、利用者のリポジトリを汚さないよう
 *   XDG state ディレクトリへ置く。
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** リポジトリルートを決定できなかったときに投げる。CLI はこれを捕まえて案内を出して終了する */
export class RepoRootNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRootNotFoundError";
  }
}

export interface ResolveRepoRootOptions {
  /** CLI のグローバルオプション `--repo <path>`(最優先) */
  repo?: string | undefined;
  /** 環境変数の入れ物(既定は process.env)。`CCLOOP_REPO` を見る */
  env?: NodeJS.ProcessEnv;
  /** 探索の起点(既定は process.cwd()) */
  cwd?: string;
}

/** dir が git のワークツリー(`.git` がディレクトリまたはファイルとして存在する)か */
function hasGitEntry(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * start から上方へ `.git` を探す。git worktree では `.git` がファイルになるため、
 * ディレクトリ・ファイルのどちらでも該当とみなす。見つからなければ null。
 */
export function findGitRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (hasGitEntry(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 対象リポジトリのルートを決める。優先順は
 * ① `--repo <path>` ② 環境変数 `CCLOOP_REPO` ③ cwd から上方への `.git` 探索。
 * ①② は指定された時点で確定し、そこが git リポジトリでなければエラーにする
 * (黙って別のリポジトリへフォールバックすると、意図しない場所を書き換えてしまうため)。
 */
export function resolveRepoRoot(opts: ResolveRepoRootOptions = {}): string {
  const env = opts.env ?? process.env;
  const explicit = opts.repo ?? (env.CCLOOP_REPO !== "" ? env.CCLOOP_REPO : undefined);
  if (explicit !== undefined) {
    const dir = path.resolve(explicit);
    const source = opts.repo !== undefined ? "--repo" : "CCLOOP_REPO";
    if (!fs.existsSync(dir)) {
      throw new RepoRootNotFoundError(`${source} で指定されたパスが存在しない: ${dir}`);
    }
    if (!hasGitEntry(dir)) {
      throw new RepoRootNotFoundError(
        `${source} で指定された ${dir} は git リポジトリのルートではない(.git が無い)。` +
          "リポジトリのルートを指定すること",
      );
    }
    return realpath(dir);
  }

  const found = findGitRoot(opts.cwd ?? process.cwd());
  if (found === null) {
    throw new RepoRootNotFoundError(
      "対象リポジトリを特定できない: カレントディレクトリから上方に .git が見つからない。" +
        "リポジトリ内で実行するか、--repo <path> か環境変数 CCLOOP_REPO でルートを指定すること",
    );
  }
  return realpath(found);
}

/** realpath を試み、失敗したら resolve 済みのパスをそのまま返す(state ディレクトリ ID の安定化用) */
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * state ディレクトリ名に使うリポジトリ識別子 `<basename>-<sha1(realpath) の先頭 8 文字>`。
 * 人間が見て分かる basename と、同名リポジトリを取り違えないためのハッシュを組み合わせる。
 */
export function repoId(root: string): string {
  const real = realpath(root);
  const hash = createHash("sha1").update(real).digest("hex").slice(0, 8);
  return `${path.basename(real)}-${hash}`;
}

/** `${XDG_STATE_HOME:-~/.local/state}/ccloop/<repo-id>`。作成はしない(純粋) */
export function stateDirFor(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, "ccloop", repoId(root));
}

/** `.agent/` のディレクトリ名。リポジトリルートからの相対パスを組み立てるときに使う */
export const AGENT_DIR_NAME = ".agent";

/**
 * リポジトリルートからの相対パスで表したタスクファイル(`.agent/tasks/<id>.md`)。
 * git のパススペックのように、絶対パスではなくリポジトリ相対で扱う必要がある箇所で使う。
 */
export function taskFileRelPath(taskId: string): string {
  return `${AGENT_DIR_NAME}/tasks/${taskId}.md`;
}

/** ccloop が読み書きするパス一式。root ごとに createPaths で作る */
export interface Paths {
  /** 対象リポジトリのルート */
  root: string;

  // ---- git 管理下(.agent/) ----
  agentDir: string;
  configPath: string;
  tasksDir: string;
  decisionsDir: string;
  humanReviewDir: string;
  archiveDir: string;
  goalPath: string;
  overviewPath: string;
  /** 利用側リポジトリ固有の追加ルール(任意)。共通ルールの後ろへ連結される */
  promptLocalPath: string;

  // ---- git 管理外(リポジトリ外の state ディレクトリ) ----
  stateDir: string;
  statePath: string;
  metricsPath: string;
  denialsPath: string;
  patchesDir: string;
  worktreesDir: string;
  generatedSettingsPath: string;
  /** 共通ルール(+ PROMPT.local.md)を連結して生成する system prompt ファイル */
  generatedSystemPromptPath: string;
}

/**
 * root に対するパス一式を組み立てる。state ディレクトリは無ければ作る
 * (実行時ファイルの書き込みは常にここへ行われるため、呼び出し側ごとの mkdir を不要にする)。
 */
export function createPaths(root: string, env: NodeJS.ProcessEnv = process.env): Paths {
  const agentDir = path.join(root, AGENT_DIR_NAME);
  const stateDir = stateDirFor(root, env);
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    root,
    agentDir,
    configPath: path.join(agentDir, "config.json"),
    tasksDir: path.join(agentDir, "tasks"),
    decisionsDir: path.join(agentDir, "decisions"),
    humanReviewDir: path.join(agentDir, "human-review"),
    archiveDir: path.join(agentDir, "archive"),
    goalPath: path.join(agentDir, "GOAL.md"),
    overviewPath: path.join(agentDir, "OVERVIEW.md"),
    promptLocalPath: path.join(agentDir, "PROMPT.local.md"),
    stateDir,
    statePath: path.join(stateDir, "state.json"),
    metricsPath: path.join(stateDir, "metrics.jsonl"),
    denialsPath: path.join(stateDir, "permission-denials.jsonl"),
    patchesDir: path.join(stateDir, "patches"),
    worktreesDir: path.join(stateDir, "worktrees"),
    generatedSettingsPath: path.join(stateDir, "claude-settings.json"),
    generatedSystemPromptPath: path.join(stateDir, "system-prompt.md"),
  };
}

/**
 * ccloop 自身のインストール先(`lib/` の絶対パス)。
 * ランチャー `bin/ccloop` が `CCLOOP_HOME` を渡すが、テストや直接 node 実行では未設定なので
 * このモジュールの位置から求める。
 */
export function ccloopHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CCLOOP_HOME;
  if (fromEnv !== undefined && fromEnv !== "") return path.resolve(fromEnv);
  return import.meta.dirname;
}
