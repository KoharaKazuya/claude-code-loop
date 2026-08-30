/**
 * agent/<taskId> ブランチを main へ自動マージする
 *
 * Supervisor はタスクごとにブランチを切って作業させ(想定: `agent/<taskId>`)、完了後に
 * このモジュールで main へ merge commit を作る。機械的に(人手を介さず)解決してよい
 * コンフリクトは own-task-file と `.agent/decisions/index.md` の 2 種類だけで、それ以外の
 * コンフリクト(内容そのものが対立するもの)は "substantive" として区別し、人間判断に回す。
 *
 * own-task-file: コンフリクト解消のためブランチを残している間、Supervisor は
 * `.agent/tasks/<taskId>.md` に失敗記録を main 側で直接コミットする(次の試行がタスクを
 * 再開できるようにするため)。一方ブランチ側もセッション自身がステータス更新・試行履歴を
 * 同じファイルへ書き込む。両者は同じファイルの異なる変更のため再マージ時に
 * modify/modify コンフリクトになるが、これも内容が対立しているわけではなく、
 * main 側の変更は Supervisor 自身が書いた機械的な失敗記録に過ぎない(履歴には残る)。
 * ブランチ側にはセッションが書いた最終的な状態があるため、ブランチ側を採用して
 * 解決する。
 *
 * decisions/index.md: 並列セッションが同時に決定を追記すると、index.md の同じ箇所に
 * それぞれの行が挿入され modify/modify コンフリクトになる。これも内容が対立している
 * わけではなく(それぞれ独立したエントリの追加・チェックであり、双方を保持すれば足りる)、
 * `decisions-index.ts` の `mergeDecisionsIndexText` で 3-way マージして解決する。
 * マージ不能(header/footer が両側で書き換えられた等)と判定された場合のみ substantive
 * として人間判断へ回す。
 *
 * `.agent/` の ID(tasks / decisions / human-review)は日時プレフィックス + slug で付ける。
 * そのため並行する複数セッションが同じパスのファイルを作るのは「同じ分に同じ slug を
 * 付けた = 同じ内容を二重に起票した」場合に限られる。これは採番のずれではなく内容の
 * 重複であり、どちらを残すか(あるいは統合するか)は人間が決めるべきものなので、
 * `.agent/decisions/` (index.md を除く)`.agent/human-review/` `.agent/tasks/` 直下の
 * add/add も特別扱いせず substantive として扱う。
 *
 * 本モジュールはログを出さない(呼び出し側の supervisor.ts が結果を見てログ・記録を行う)。
 * 本当に壊れた状態(解決処理の途中で失敗し、かつ作業ツリーを元に戻せない等)以外は
 * 例外を投げず MergeOutcome で結果を表現する。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mergeDecisionsIndexText } from "./decisions-index.ts";
import { gitOperationInProgress } from "./worktree.ts";

// ---------- 純粋関数 ----------

/**
 * `git ls-files -u -z` の出力を解釈する。
 * 各レコードは `<mode> <sha> <stage>\t<path>` で、`-z` により NUL 区切り・パスの
 * エスケープなし。1 つのパスにつき stage(1=共通祖先, 2=ours, 3=theirs)が複数レコードに
 * 分かれて出るため、パスごとに出現した stage の集合へ畳み込む。
 */
export function parseUnmergedStages(lsFilesUZOut: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  const records = lsFilesUZOut.split("\0").filter((r) => r !== "");
  for (const record of records) {
    const tabIndex = record.indexOf("\t");
    if (tabIndex === -1) continue;
    const meta = record.slice(0, tabIndex);
    const p = record.slice(tabIndex + 1);
    const stageStr = meta.split(" ")[2];
    if (stageStr === undefined) continue;
    const stage = Number(stageStr);
    if (!Number.isInteger(stage)) continue;
    const set = result.get(p) ?? new Set<number>();
    set.add(stage);
    result.set(p, set);
  }
  return result;
}

const TASKS_DIR = ".agent/tasks/";
const DECISIONS_INDEX_PATH = ".agent/decisions/index.md";

/** stage 集合が add/add({2,3})または modify/modify({1,2,3})か */
function isAddAddOrModifyModify(stageSet: Set<number>): boolean {
  if (stageSet.size === 2 && stageSet.has(2) && stageSet.has(3)) return true;
  if (stageSet.size === 3 && stageSet.has(1) && stageSet.has(2) && stageSet.has(3)) return true;
  return false;
}

/**
 * p が「マージ中のタスク自身のタスクファイル」への add/add(stage {2,3}、共通祖先なし)
 * または modify/modify(stage {1,2,3})か。add/add になるのは branch 側が最初にタスク
 * ファイルへ触れたケース、modify/modify になるのは main 側(Supervisor の失敗記録)も
 * 既に触れているケース。
 */
function isOwnTaskFilePath(p: string, stageSet: Set<number>, taskId: string): boolean {
  if (p !== `${TASKS_DIR}${taskId}.md`) return false;
  return isAddAddOrModifyModify(stageSet);
}

/**
 * p が `.agent/decisions/index.md` そのものへの add/add({2,3})または modify/modify
 * ({1,2,3})か。並列セッションが同時に決定を追記した際に発生する。
 */
function isDecisionsIndexPath(p: string, stageSet: Set<number>): boolean {
  if (p !== DECISIONS_INDEX_PATH) return false;
  return isAddAddOrModifyModify(stageSet);
}

export type MechanicalConflicts = {
  kind: "mechanical";
  /** own-task-file の衝突があればそのパス、無ければ null */
  ownTaskFile: string | null;
  /** .agent/decisions/index.md の衝突があればそのパス、無ければ null */
  decisionsIndex: string | null;
};

export type ConflictClassification = MechanicalConflicts | { kind: "substantive"; paths: string[] };

/**
 * コンフリクトを機械的に解決してよいものと、人間判断が要る「内容の対立」に分類する。
 * 機械的に解決してよいのは ownTaskFile(`.agent/tasks/<taskId>.md` そのもの)と
 * decisionsIndex(`.agent/decisions/index.md` そのもの)で、いずれも stage が
 * {2,3}(add/add)または {1,2,3}(modify/modify)のときに限る(モジュール先頭の説明を参照)。
 * 両方が混在していてもよい。それ以外のパスが 1 つでも混ざれば全体を "substantive" と
 * して人間判断へ回す(`.agent/decisions/` の index.md 以外の同名 add/add も同様。同名になるのは
 * 二重起票のときだけなので、機械的に解決してよい対象ではない)。
 */
export function classifyConflicts(stages: Map<string, Set<number>>, taskId: string): ConflictClassification {
  const paths = [...stages.keys()];
  if (paths.length === 0) return { kind: "substantive", paths };

  let ownTaskFile: string | null = null;
  let decisionsIndex: string | null = null;
  for (const p of paths) {
    const stageSet = stages.get(p);
    if (stageSet === undefined) return { kind: "substantive", paths };
    if (isOwnTaskFilePath(p, stageSet, taskId)) {
      ownTaskFile = p;
    } else if (isDecisionsIndexPath(p, stageSet)) {
      decisionsIndex = p;
    } else {
      return { kind: "substantive", paths };
    }
  }
  if (ownTaskFile === null && decisionsIndex === null) return { kind: "substantive", paths };
  return { kind: "mechanical", ownTaskFile, decisionsIndex };
}

/** マージコミットの subject 最大長。supervisor.ts の SUBJECT_MAX_LENGTH と同じ基準だが、
 *  非 export のため import できず、この用途向けに独立して定義する */
const MERGE_SUBJECT_MAX_LENGTH = 72;

/** 改行・タブ等の制御文字を含むか(task title に混入する可能性があるため必要) */
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** mergeCommitMessage が本文に書く「何を機械的に解決したか」の内訳 */
export interface ResolvedMechanicalPaths {
  /** own-task-file を解決した場合、そのパス */
  ownTaskFile?: string | null;
  /** decisions/index.md を解決した場合、そのパス */
  decisionsIndex?: string | null;
}

/**
 * マージコミットのメッセージを組み立てる。
 * subject は `Merge branch '<branch>' (<taskId> <title>)`。長すぎる・制御文字を含む場合は
 * `Merge branch '<branch>'` へ倒す(title は自由記述でありコミットメッセージとして
 * 壊れた形になりうるため)。
 * `Merge ` で始まる subject は commit-msg フック(Conventional Commits 検査)の対象外
 * ("^(Merge|Revert|fixup!|squash!) " は無条件で許可される)なので、フォールバック後も
 * フックには通る。
 * resolved が指定されていれば、本文に機械的解決の内訳を 1 行ずつ入れる:
 * - ownTaskFile があれば「タスクファイルはブランチ側を採用: <path>」
 * - decisionsIndex があれば「決定インデックスは両ブランチの項目を統合: <path>」
 * 末尾には空行を挟んで trailer を必ず付ける。
 */
export function mergeCommitMessage(
  branch: string,
  taskId: string,
  title: string,
  trailer: string,
  resolved?: ResolvedMechanicalPaths,
): string {
  const candidate = `Merge branch '${branch}' (${taskId} ${title})`;
  const subject =
    candidate.length > MERGE_SUBJECT_MAX_LENGTH || hasControlChar(candidate)
      ? `Merge branch '${branch}'`
      : candidate;

  const bodyLines: string[] = [];
  if (resolved?.ownTaskFile != null) {
    bodyLines.push(`タスクファイルはブランチ側を採用: ${resolved.ownTaskFile}`);
  }
  if (resolved?.decisionsIndex != null) {
    bodyLines.push(`決定インデックスは両ブランチの項目を統合: ${resolved.decisionsIndex}`);
  }

  const parts = [subject];
  if (bodyLines.length > 0) parts.push("", bodyLines.join("\n"));
  parts.push("", trailer);
  return parts.join("\n");
}

// ---------- git ラッパー ----------

/** classifyConflicts の分類をそのまま観測用に持ち出したもの。 */
export type ConflictKind = "substantive" | "mechanical";

export type MergeOutcome =
  | { result: "merged" }
  /**
   * own-task-file の衝突を機械的に解決してマージできたことを表す(常に own-task-file は
   * ブランチ側の内容を採用する。モジュール先頭の説明を参照)。
   * "renumbered" という名前は ID 連番の改番機能があった頃の名残で、改番機能は既に無く
   * 実態と乖離しているが、この値は `mergeLabel` 経由で `recordMetrics`
   * (supervisor.ts の recordMetrics)が書く JSONL に残るため、過去のメトリクス値との
   * 継続性を優先してあえて改名していない。
   */
  | { result: "renumbered" }
  | { result: "nothing-to-merge" }
  /** conflictKind は classifyConflicts が何と分類したかを表す。"mechanical" は
   *  本来機械的に解決できるはずだったが解決に失敗したことを意味する。 */
  | { result: "conflict"; paths: string[]; conflictKind?: ConflictKind }
  | { result: "blocked"; reason: string }
  /** `git merge --abort` 自体が失敗し、main がマージ途中のまま残ってしまった状態。
   *  stderr にその abort 失敗の内容を持つ(呼び出し側はこれをそのままログへ出す)。 */
  | { result: "wedged"; stderr: string };

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd }).toString();
}

/** execFileSync が投げる Error から stderr を取り出す(取れなければ message で妥協) */
function extractStderr(err: unknown): string {
  if (err !== null && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString().trim();
    if (typeof stderr === "string") return stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/** `git rev-parse --git-path <p>` の結果を root からの絶対パスへ解決する */
function gitPathAbs(root: string, gitRelPath: string): string {
  const out = git(["rev-parse", "--git-path", gitRelPath], root).trim();
  return path.isAbsolute(out) ? out : path.join(root, out);
}

/**
 * `git merge --abort` を試みる。失敗(例: マージでステージされたファイルが作業ツリー上で
 * 変更されて `not uptodate` になっている場合)は stderr を添えて呼び出し側へ伝える
 * (以前は例外を握りつぶしてベストエフォート扱いにしており、abort が失敗して main が
 * マージ途中のまま残っても誰も気づけなかった)。
 */
function abortMerge(root: string): { ok: true } | { ok: false; stderr: string } {
  // マージ直後の即 abort は index の stat 情報が信用されず(racy git)
  // "Entry '...' not uptodate. Cannot merge." で reset --merge が失敗することがある
  // (実運用で発生)。先に stat 情報を更新してから abort する。refresh 自体の失敗は
  // 差分があるだけでも非ゼロ終了するため無視してよい。
  try {
    execFileSync("git", ["update-index", "-q", "--refresh"], { cwd: root });
  } catch {
    // 無視(refresh は前処理にすぎない)
  }
  try {
    execFileSync("git", ["merge", "--abort"], { cwd: root });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: extractStderr(err) };
  }
}

/** マージ進行中でなければ何もせず ok。進行中なら abortMerge を試みてその結果を返す */
function abortMergeIfInProgress(root: string): { ok: true } | { ok: false; stderr: string } {
  if (!fs.existsSync(gitPathAbs(root, "MERGE_HEAD"))) return { ok: true };
  return abortMerge(root);
}

/** `git show <spec>` を試み、失敗(対象 stage が存在しない等)すれば null を返す */
function readGitShowOrNull(root: string, spec: string): string | null {
  try {
    return git(["show", spec], root);
  } catch {
    return null;
  }
}

/**
 * "mechanical" と分類されたコンフリクト(own-task-file・decisions/index.md)を機械的に
 * 解決し、解決コミットを作る。失敗(substantive 判定・想定外の例外)時は merge を abort
 * して "conflict" を返す。abort 自体が失敗した(main が git 操作の途中で固まった)場合は
 * "wedged" を返す(呼び出し側はこれを見て人間に伝える判断をする)。
 * テストのために export しているが、通常は mergeAgentBranch の内部からのみ呼ばれる想定。
 */
export function resolveMechanically(root: string, branch: string, taskId: string, title: string, trailer: string): MergeOutcome {
  let knownPaths: string[] = [];
  let knownKind: ConflictKind | undefined;
  try {
    const stages = parseUnmergedStages(git(["ls-files", "-u", "-z"], root));
    const classification = classifyConflicts(stages, taskId);
    knownKind = classification.kind;
    if (classification.kind === "substantive") {
      knownPaths = classification.paths;
      const abortResult = abortMerge(root);
      if (!abortResult.ok) return { result: "wedged", stderr: abortResult.stderr };
      return { result: "conflict", paths: classification.paths, conflictKind: knownKind };
    }

    const { ownTaskFile, decisionsIndex } = classification;
    knownPaths = [ownTaskFile, decisionsIndex].filter((p): p is string => p !== null);

    if (ownTaskFile !== null) {
      // マージ中のタスク自身のタスクファイルは branch 側(theirs)を正とする。main 側の
      // 差分はこのマージ処理自身(Supervisor)が書き込んだ機械的な失敗記録に過ぎず、
      // 消えるわけではなく git 履歴には残る。一方 branch 側にはセッションが書いた
      // 最終的なステータス・試行履歴があり、そちらが真の内容である(モジュール先頭の
      // 説明を参照)。
      execFileSync("git", ["checkout", "--theirs", "--", ownTaskFile], { cwd: root });
      execFileSync("git", ["add", "--", ownTaskFile], { cwd: root });
    }

    if (decisionsIndex !== null) {
      // stage 1(共通祖先)は add/add のとき存在しないため、取得失敗は null として扱う。
      // stage 2/3 の取得失敗はここまでの分類と矛盾する想定外の状態なので、例外のまま
      // 外側の catch へ伝播させる。
      const base = readGitShowOrNull(root, `:1:${decisionsIndex}`);
      const ours = git(["show", `:2:${decisionsIndex}`], root);
      const theirs = git(["show", `:3:${decisionsIndex}`], root);
      const merged = mergeDecisionsIndexText(base, ours, theirs);
      if (merged === null) {
        // header/footer が両側で書き換えられた等、機械的に解決できない。substantive として
        // 諦める(ここまでに分かっている全パスを添える)
        const abortResult = abortMerge(root);
        if (!abortResult.ok) return { result: "wedged", stderr: abortResult.stderr };
        return { result: "conflict", paths: knownPaths, conflictKind: "substantive" };
      }
      fs.writeFileSync(path.join(root, decisionsIndex), merged);
      execFileSync("git", ["add", "--", decisionsIndex], { cwd: root });
    }

    const remainingUnmerged = git(["ls-files", "-u"], root).trim();
    if (remainingUnmerged !== "") {
      throw new Error(`コンフリクト解消後も未マージのパスが残っている: ${remainingUnmerged}`);
    }

    const message = mergeCommitMessage(branch, taskId, title, trailer, { ownTaskFile, decisionsIndex });
    execFileSync("git", ["commit", "-F", "-"], {
      cwd: root,
      input: message,
      // pre-commit の detect-todo だけを無効化する(--no-verify は使わない)。採用した
      // タスクファイルの本文には TODO/FIXME という語がそのまま含まれうるが、それは
      // タスクの記述内容であってこのマージ処理が持ち込む問題ではないため、この
      // チェック 1 つに絞って無効化するのが妥当(範囲を detect-todo に限定する)
      env: { ...process.env, GIT_HOOKS_IGNORE_DETECT_TODO: "1" },
    });

    return { result: "renumbered" };
  } catch {
    // 想定外の例外。作業ツリーを壊れたまま残さないよう merge 進行中なら abort してから
    // conflict として返す(ここまでに分かっているパスがあれば添える)。abort 自体が
    // 失敗した場合は main がマージ途中のまま残ってしまうため wedged として伝える
    const abortResult = abortMergeIfInProgress(root);
    if (!abortResult.ok) return { result: "wedged", stderr: abortResult.stderr };
    return { result: "conflict", paths: knownPaths, conflictKind: knownKind };
  }
}

/**
 * `branch`(想定: `agent/<taskId>`)を root 上の現在のブランチ(main を想定)へマージする。
 * - branch に root からの新規コミットが無ければ "nothing-to-merge"。
 * - 単純にマージできれば "merged"。
 * - コンフリクトが mechanical(own-task-file のみ)なら機械的に解決して "renumbered"
 *   (モジュール先頭の説明を参照)。
 * - それ以外のコンフリクトは abort して "conflict"(paths に対象パスを列挙)。
 * - マージ自体が開始できない(ローカルの未コミット変更を上書きしてしまう等)場合は
 *   "blocked"(reason に git のエラー出力)。
 * - root が既に別の git 操作(マージ・rebase 等)の途中なら、それに一切触れず即座に
 *   "blocked" を返す。ここでチェックしないと、既に残っている(場合によっては今回の
 *   branch と無関係な)コンフリクトが resolveMechanically に横取りされ、古い衝突を
 *   今回のブランチのものと誤って扱ってしまう事故が起こりうる。
 */
export function mergeAgentBranch(root: string, branch: string, taskId: string, title: string, trailer: string): MergeOutcome {
  if (gitOperationInProgress(root)) {
    return { result: "blocked", reason: "main が別の git 操作の途中のためマージを開始できない" };
  }

  const aheadOut = git(["rev-list", "--count", `HEAD..${branch}`], root).trim();
  const ahead = Number(aheadOut);
  if (!Number.isFinite(ahead) || ahead === 0) {
    return { result: "nothing-to-merge" };
  }

  const message = mergeCommitMessage(branch, taskId, title, trailer);
  try {
    execFileSync("git", ["merge", "--no-ff", "-m", message, branch], { cwd: root });
    return { result: "merged" };
  } catch (err) {
    if (!fs.existsSync(gitPathAbs(root, "MERGE_HEAD"))) {
      // マージ自体が開始できていない(ローカル変更の上書き等)。進行中の状態は残らない
      return { result: "blocked", reason: extractStderr(err) };
    }
    return resolveMechanically(root, branch, taskId, title, trailer);
  }
}
