/**
 * タスクごとの git worktree 管理
 *
 * Supervisor は各タスクセッションを、リポジトリ本体の外側(既定では state ディレクトリ配下の
 * `worktrees/<taskId>`、ブランチ `agent/<taskId>`。置き場は `parallel.worktreeDir` で変更できる)の
 * worktree 上で実行する。本体の作業ツリーを汚さず、複数タスクを並行して走らせられるようにするため。
 *
 * ここでは経路計算などの純粋関数と、それを使う薄い git/fs ラッパーを提供する。
 * ラッパーは root/paths を明示的に受け取り、モジュールレベルの ROOT は持たない
 * (Supervisor 本体からも、単体の worktree からも同じ関数を使えるようにするため)。
 * 致命的な失敗は例外として投げる(何をリトライ・スキップするかは呼び出し側の Supervisor が決める)。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `git diff --name-only` の出力上限。パス名だけなので --binary のように base64 で
 * 膨らむことはないが、生成物を大量に含むツリーでは既定の 1MB を超えうるため広めに取る。
 */
const DIFF_NAME_LIST_MAX_BUFFER = 64 * 1024 * 1024;

// ---------- 純粋関数 ----------

/** worktreeDir(worktree をまとめて置くディレクトリ)配下の taskId 用 worktree パス */
export function worktreePathFor(worktreeDir: string, taskId: string): string {
  return path.join(worktreeDir, taskId);
}

/** タスク用の通常ブランチ名 */
export function branchNameFor(taskId: string): string {
  return `agent/${taskId}`;
}

/** Date を `YYYYMMDDTHHMMSSZ` 形式(UTC・区切り無し)へ整形する */
function compactTimestamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * コンフリクトにより本線へ統合できず退避したブランチの名前。
 * 同じ taskId で複数回退避しても衝突しないよう、退避時刻を含める。
 */
export function parkedBranchNameFor(taskId: string, at: Date): string {
  return `agent/conflict/${taskId}-${compactTimestamp(at)}`;
}

/** salvagePatch が書き出すパッチファイル名(拡張子 .patch) */
export function patchFileName(taskId: string, at: Date): string {
  return `${taskId}-${compactTimestamp(at)}.patch`;
}

export interface WorktreeListEntry {
  path: string;
  head: string;
  branch: string | null;
}

/**
 * `git worktree list --porcelain` の出力をパースする。
 * レコードは空行区切り。各レコードは `worktree` / `HEAD` / (`branch` か `detached`) の行を持ち、
 * 加えて `bare` / `locked` / `prunable` が付くことがある(ここでは無視する)。
 * branch は `refs/heads/` を剥がした短い名前で返す(detached の場合は null)。
 */
export function parseWorktreeList(porcelainOut: string): WorktreeListEntry[] {
  const records = porcelainOut
    .split(/\n\n+/)
    .map((r) => r.trim())
    .filter((r) => r !== "");

  const result: WorktreeListEntry[] = [];
  for (const record of records) {
    let wtPath = "";
    let head = "";
    let branch: string | null = null;
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      }
      // detached / bare / locked / prunable 行は情報として使わないため読み飛ばす
    }
    if (wtPath !== "") result.push({ path: wtPath, head, branch });
  }
  return result;
}

// ---------- 薄い git/fs ラッパー ----------

function branchExists(root: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/**
 * wtPath に branch の worktree を作る。
 * wtPath が既に存在するなら何もしない(冪等: コンフリクト解決の再開などで同じ worktree を使い回す)。
 * branch が既存なら `git worktree add <wtPath> <branch>`、無ければ HEAD から新規作成する。
 */
export function createWorktree(root: string, wtPath: string, branch: string): void {
  if (fs.existsSync(wtPath)) return;
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  if (branchExists(root, branch)) {
    execFileSync("git", ["worktree", "add", wtPath, branch], { cwd: root });
  } else {
    execFileSync("git", ["worktree", "add", "-b", branch, wtPath, "HEAD"], { cwd: root });
  }
}

/**
 * root 直下の linkPaths(例: node_modules)を wtPath へシンボリックリンクする。
 * root 側に存在しない、または wtPath 側に既に存在する場合はスキップする(上書きしない)。
 */
export function linkSharedPaths(root: string, wtPath: string, linkPaths: string[]): void {
  for (const name of linkPaths) {
    const src = path.join(root, name);
    const dest = path.join(wtPath, name);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.symlinkSync(src, dest);
    }
  }
}

/**
 * wtPath の worktree を削除する。
 * Claude Code がロックしていることがあるため、まず unlock を試みる(失敗は無視)。
 * `git worktree remove --force` に失敗したら(壊れている等)ディレクトリを直接削除して prune する。
 */
export function removeWorktree(root: string, wtPath: string): void {
  try {
    // stdio を握りつぶす: 未ロック時の "fatal: ... is not locked" がコンソールへ漏れるのを防ぐ
    execFileSync("git", ["worktree", "unlock", wtPath], { cwd: root, stdio: "ignore" });
  } catch {
    // ロックされていない、あるいは既に worktree として認識されていない場合はここで無視する
  }
  try {
    execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: root });
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: root });
  }
}

/** 存在しなくなった worktree の管理情報を掃除する */
export function pruneWorktrees(root: string): void {
  execFileSync("git", ["worktree", "prune"], { cwd: root });
}

/** root が知っている worktree の一覧 */
export function listWorktrees(root: string): WorktreeListEntry[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root }).toString();
  return parseWorktreeList(out);
}

/** branch を強制削除する。失敗しても例外を投げず false を返す(呼び出し側でログのみ残す用途) */
export function deleteBranch(root: string, branch: string): boolean {
  try {
    execFileSync("git", ["branch", "-D", branch], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/** ブランチをリネームする */
export function renameBranch(root: string, from: string, to: string): void {
  execFileSync("git", ["branch", "-m", from, to], { cwd: root });
}

/**
 * dir(通常の作業ツリーでも、外部に置いた linked worktree でもよい)における
 * `--git-path <name>` の実パスを解決する。linked worktree では `.git` がファイルであり
 * MERGE_HEAD 等の実体は本体リポジトリの `.git/worktrees/<name>/` 配下にあるため、
 * `.git/<name>` を dir に単純結合する existsSync では検出できない。
 * `git rev-parse --git-path` はどちらの場合も正しい実パス(相対 or 絶対)を返す。
 */
function gitPath(dir: string, name: string): string {
  const rel = execFileSync("git", ["rev-parse", "--git-path", name], { cwd: dir }).toString().trim();
  return path.isAbsolute(rel) ? rel : path.join(dir, rel);
}

/** merge の途中か(コンフリクト解決待ちなど) */
export function mergeInProgress(dir: string): boolean {
  return fs.existsSync(gitPath(dir, "MERGE_HEAD"));
}

/**
 * merge・cherry-pick・revert・bisect・rebase のいずれかが進行中か。
 * supervisor.ts の同名の判定(`.git/<name>` を直接 existsSync するもの)は
 * linked worktree で `.git` がファイルになるため機能しない。これはその置き換え用。
 */
export function gitOperationInProgress(dir: string): boolean {
  const headFiles = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];
  if (headFiles.some((name) => fs.existsSync(gitPath(dir, name)))) return true;
  const rebaseDirs = ["rebase-merge", "rebase-apply"];
  return rebaseDirs.some((name) => fs.existsSync(gitPath(dir, name)));
}

/**
 * wtPath 上のコミットされていない変更を、`.agent/` 配下を除いてパッチとして退避する。
 * `git add -N`(intent-to-add)で未追跡ファイルも diff に載せてから `git diff HEAD` を取る。
 * 差分が無ければ null を返し、outFile は作らない。
 * 差分があれば outFile へ書き出し、影響を受けたパス一覧(ソート済み)を返す。
 *
 * 差分本体は execFileSync のバッファを経由せず、outFile の fd へ子プロセスの stdout を
 * 直接つないで書き出す。`--binary` は中身を base64 化するため execFileSync の既定 maxBuffer
 * (1MB)を容易に超え、かつ上限を単に引き上げるだけでは生成物を含む巨大な差分で再発するため
 * (差分本体だけは maxBuffer という有限の上限に縛られない形にする必要がある)。
 */
export function salvagePatch(wtPath: string, outFile: string): string[] | null {
  execFileSync("git", ["add", "-N", "--", ".", ":(exclude).agent"], { cwd: wtPath });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const fd = fs.openSync(outFile, "w");
  try {
    execFileSync("git", ["diff", "--binary", "HEAD", "--", ".", ":(exclude).agent"], {
      cwd: wtPath,
      stdio: ["ignore", fd, "pipe"],
    });
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(outFile, { force: true }); // 途中まで書けたパッチは適用できないので残さない
    throw err;
  }
  fs.closeSync(fd);
  if (fs.statSync(outFile).size === 0) {
    fs.rmSync(outFile, { force: true });
    return null;
  }

  const names = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ".", ":(exclude).agent"], {
    cwd: wtPath,
    maxBuffer: DIFF_NAME_LIST_MAX_BUFFER,
  })
    .toString()
    .split("\n")
    .filter((f) => f !== "")
    .sort();
  return names;
}
