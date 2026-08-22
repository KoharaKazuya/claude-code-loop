/**
 * agent/<taskId> ブランチを main へ自動マージする
 *
 * Supervisor はタスクごとにブランチを切って作業させ(想定: `agent/<taskId>`)、完了後に
 * このモジュールで main へ merge commit を作る。機械的に(人手を介さず)解決してよい
 * コンフリクトが 2 種類ある。それ以外のコンフリクト(内容そのものが対立するもの)は
 * "substantive" として区別し、人間判断に回す。
 *
 * 1. id-collision: 並行実行される複数セッションが同じ fork 元から `.agent/decisions/`
 *    `.agent/human-review/` に次の連番 ID(`D-YYYYMMDD-NN.md` / `HR-YYYYMMDD-NN.md`)の
 *    ファイルを作ってしまうと、両ブランチとも「新規追加」のため add/add コンフリクトになる。
 *    これは内容の対立ではなく採番の衝突でしかないため、ブランチ側の ID を次の空き番号へ
 *    振り直して解決する。
 * 2. own-task-file: コンフリクト解消のためブランチを残している間、Supervisor は
 *    `.agent/tasks/<taskId>.md` に失敗記録を main 側で直接コミットする(次の試行がタスクを
 *    再開できるようにするため)。一方ブランチ側もセッション自身がステータス更新・試行履歴を
 *    同じファイルへ書き込む。両者は同じファイルの異なる変更のため再マージ時に
 *    modify/modify コンフリクトになるが、これも内容が対立しているわけではなく、
 *    main 側の変更は Supervisor 自身が書いた機械的な失敗記録に過ぎない(履歴には残る)。
 *    ブランチ側にはセッションが書いた最終的な状態があるため、ブランチ側を採用して
 *    解決する。
 *
 * 本モジュールはログを出さない(呼び出し側の supervisor.ts が結果を見てログ・記録を行う)。
 * 本当に壊れた状態(解決処理の途中で失敗し、かつ作業ツリーを元に戻せない等)以外は
 * 例外を投げず MergeOutcome で結果を表現する。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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

const DECISIONS_DIR = ".agent/decisions/";
const HUMAN_REVIEW_DIR = ".agent/human-review/";
const TASKS_DIR = ".agent/tasks/";
/** decisions / human-review の ID ファイル名(拡張子込み)の形式 */
const ID_BASENAME_RE = /^(?:D|HR)-\d{8}-\d+\.md$/;

/** dir 直下(サブディレクトリなし)のパスか */
function isDirectChildOf(p: string, dir: string): boolean {
  if (!p.startsWith(dir)) return false;
  const rest = p.slice(dir.length);
  return rest.length > 0 && !rest.includes("/");
}

function isIdCollisionPath(p: string, stageSet: Set<number>): boolean {
  if (!isDirectChildOf(p, DECISIONS_DIR) && !isDirectChildOf(p, HUMAN_REVIEW_DIR)) return false;
  if (stageSet.size !== 2 || !stageSet.has(2) || !stageSet.has(3)) return false;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return ID_BASENAME_RE.test(base);
}

/**
 * p が「マージ中のタスク自身のタスクファイル」への add/add(stage {2,3}、共通祖先なし)
 * または modify/modify(stage {1,2,3})か。add/add になるのは branch 側が最初にタスク
 * ファイルへ触れたケース、modify/modify になるのは main 側(Supervisor の失敗記録)も
 * 既に触れているケース。
 */
function isOwnTaskFilePath(p: string, stageSet: Set<number>, taskId: string): boolean {
  if (p !== `${TASKS_DIR}${taskId}.md`) return false;
  if (stageSet.size === 2 && stageSet.has(2) && stageSet.has(3)) return true;
  if (stageSet.size === 3 && stageSet.has(1) && stageSet.has(2) && stageSet.has(3)) return true;
  return false;
}

/**
 * コンフリクトを機械的に解決してよいものと、人間判断が要る「内容の対立」に分類する。
 * 機械的に解決してよいのは以下の 2 種のみ(モジュール先頭の説明を参照):
 *   a. idCollisions: `.agent/decisions/` `.agent/human-review/` 直下・stage が
 *      {2,3}(add/add)・ファイル名が ID 形式のパス。
 *   b. ownTaskFile: `.agent/tasks/<taskId>.md` そのもの・stage が {2,3}(add/add)または
 *      {1,2,3}(modify/modify)。
 * コンフリクトした全パスが a か b のどちらかに収まる場合は "mechanical"。
 * それ以外のパス(以下「その他」)が 1 つでもあり、かつ idCollisions が 1 件以上あれば
 * "partial"(ID 採番衝突だけは機械的に解決可能・残りは人間判断が要る)。その他があっても
 * idCollisions が 0 件なら、部分的に解決できるものが無いので従来どおり "substantive"。
 * ownTaskFile は partial では機械解決の対象に含めない(substantivePaths に含める)。
 * その解決(ブランチ側を採用する)は「今マージが進行中である」ことを前提にした判断であり、
 * partial の先行解決は worktree 側(ours = ブランチ / theirs = main)で行うため、mechanical の
 * ときとは ours/theirs の向きが逆になり同じロジックを使い回せない。ID 採番衝突は採番のずれ
 * でしかなく向きに依存しないため partial でも解決できるが、ownTaskFile は今回は見送る。
 */
export function classifyConflicts(
  stages: Map<string, Set<number>>,
  taskId: string,
):
  | { kind: "mechanical"; idCollisions: string[]; ownTaskFile: string | null }
  | { kind: "partial"; idCollisions: string[]; substantivePaths: string[] }
  | { kind: "substantive"; paths: string[] } {
  const paths = [...stages.keys()];
  if (paths.length === 0) return { kind: "substantive", paths };

  const idCollisions: string[] = [];
  let ownTaskFile: string | null = null;
  let hasOther = false;
  for (const p of paths) {
    const stageSet = stages.get(p);
    if (stageSet === undefined) return { kind: "substantive", paths };
    if (isIdCollisionPath(p, stageSet)) {
      idCollisions.push(p);
      continue;
    }
    if (isOwnTaskFilePath(p, stageSet, taskId)) {
      ownTaskFile = p;
      continue;
    }
    hasOther = true;
  }
  if (!hasOther) return { kind: "mechanical", idCollisions, ownTaskFile };
  if (idCollisions.length === 0) return { kind: "substantive", paths };
  const idCollisionSet = new Set(idCollisions);
  const substantivePaths = paths.filter((p) => !idCollisionSet.has(p));
  return { kind: "partial", idCollisions, substantivePaths };
}

const ID_RE = /^(D|HR)-(\d{8})-(\d+)$/;

interface ParsedId {
  prefix: string;
  date: string;
  num: number;
  width: number;
}

function parseId(id: string): ParsedId | null {
  const m = ID_RE.exec(id);
  if (m === null) return null;
  const numStr = m[3] ?? "";
  return { prefix: m[1] ?? "", date: m[2] ?? "", num: Number(numStr), width: numStr.length };
}

/** basename(拡張子なし)を ID として取り出す */
export function basenameId(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/**
 * 衝突した ID を、prefix-date(例: `D-20260816`)ごとの空き番号へ振り直す計画を立てる。
 * usedIds は「既に使われている ID」全体(main 側・archive 側・衝突していない branch
 * 側の追加分)、collidingIds は振り直す対象。collidingIds は昇順に処理し、都度
 * グループ内の最大値 + 1 を割り当てて used を更新していく(同一グループ内で複数衝突が
 * あっても連番が飛ばない)。
 * 元のゼロ埋め桁数は保つが、繰り上がって桁が増える場合はそのまま増える
 * (`padStart` は文字列を切り詰めないため自然に対応できる)。
 * usedIds に ID 形式(`(D|HR)-YYYYMMDD-N`)に合わないもの(`.gitkeep` 等)が混ざっていても、
 * それは単に「衝突しようがないファイル」なので無視して続行する。一方 collidingIds は
 * 既に衝突と分類済みの ID そのものであり、1 つでも ID 形式に合わなければ次番号を計算できない
 * ため、安全側に倒して空の Map を返す(呼び出し側はこれを中断の合図とする)。
 */
export function planIdRenumber(usedIds: string[], collidingIds: string[]): Map<string, string> {
  const parsedUsed = usedIds.map(parseId);
  const parsedColliding = collidingIds.map((id) => ({ id, parsed: parseId(id) }));
  if (parsedColliding.some((p) => p.parsed === null)) return new Map();

  const maxByGroup = new Map<string, number>();
  const widthByGroup = new Map<string, number>();
  for (const p of parsedUsed) {
    if (p === null) continue;
    const key = `${p.prefix}-${p.date}`;
    maxByGroup.set(key, Math.max(maxByGroup.get(key) ?? 0, p.num));
    widthByGroup.set(key, Math.max(widthByGroup.get(key) ?? 0, p.width));
  }

  const sortedColliding = [...parsedColliding].sort((a, b) => a.id.localeCompare(b.id));
  const renames = new Map<string, string>();
  for (const { id, parsed } of sortedColliding) {
    if (parsed === null) continue;
    const key = `${parsed.prefix}-${parsed.date}`;
    const nextNum = (maxByGroup.get(key) ?? 0) + 1;
    maxByGroup.set(key, nextNum);
    const width = Math.max(widthByGroup.get(key) ?? 0, parsed.width);
    widthByGroup.set(key, width);
    renames.set(id, `${parsed.prefix}-${parsed.date}-${String(nextNum).padStart(width, "0")}`);
  }
  return renames;
}

/**
 * text 中の ID 参照をすべて振り直し後の ID へ置き換える。
 * `D-20260816-1` が `D-20260816-10` の内部や `XD-20260816-1` の一部にマッチしないよう、
 * 前後を英数字・ハイフン以外(先読み・後読み)で区切る。renames が複数あっても 1 回の
 * 走査で一括置換するため(逐次適用すると、ある置換の結果が別の置換の対象と偶然一致して
 * 二重に書き換わる事故が起こり得る)。
 */
export function rewriteIdReferences(text: string, renames: Map<string, string>): string {
  if (renames.size === 0) return text;
  const escaped = [...renames.keys()]
    .sort((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![A-Za-z0-9-])(${escaped.join("|")})(?![A-Za-z0-9-])`, "g");
  return text.replace(pattern, (matched) => renames.get(matched) ?? matched);
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

/**
 * マージコミットのメッセージを組み立てる。
 * subject は `Merge branch '<branch>' (<taskId> <title>)`。長すぎる・制御文字を含む場合は
 * `Merge branch '<branch>'` へ倒す(title は自由記述でありコミットメッセージとして
 * 壊れた形になりうるため)。
 * `Merge ` で始まる subject は commit-msg フック(Conventional Commits 検査)の対象外
 * ("^(Merge|Revert|fixup!|squash!) " は無条件で許可される)なので、フォールバック後も
 * フックには通る。
 * renames が空でなければ、本文に `<old> -> <new>` の一覧(改番の記録)を 1 行ずつ入れる。
 * resolvedTaskFilePath が指定されていれば、本文に「タスクファイルはブランチ側を採用」した
 * 旨を 1 行入れる。両方あれば同じ本文ブロックにまとめて入れる。
 * 末尾には空行を挟んで trailer を必ず付ける。
 */
export function mergeCommitMessage(
  branch: string,
  taskId: string,
  title: string,
  trailer: string,
  renames?: Map<string, string>,
  resolvedTaskFilePath?: string,
): string {
  const candidate = `Merge branch '${branch}' (${taskId} ${title})`;
  const subject =
    candidate.length > MERGE_SUBJECT_MAX_LENGTH || hasControlChar(candidate)
      ? `Merge branch '${branch}'`
      : candidate;

  const bodyLines: string[] = [];
  if (renames !== undefined && renames.size > 0) {
    bodyLines.push(...[...renames.entries()].map(([oldId, newId]) => `${oldId} -> ${newId}`));
  }
  if (resolvedTaskFilePath !== undefined) {
    bodyLines.push(`タスクファイルはブランチ側を採用: ${resolvedTaskFilePath}`);
  }

  const parts = [subject];
  if (bodyLines.length > 0) parts.push("", bodyLines.join("\n"));
  parts.push("", trailer);
  return parts.join("\n");
}

// ---------- git ラッパー ----------

/** classifyConflicts の分類をそのまま観測用に持ち出したもの("partial" は
 *  ID 採番衝突と実質衝突の混在)。 */
export type ConflictKind = "substantive" | "mechanical" | "partial";

export type MergeOutcome =
  | { result: "merged" }
  /** "renumbered" は「機械的に解決した」の意。renames は 0 件のこともある
   *  (own-task-file だけの解決で ID 採番の衝突が無かった場合)。 */
  | { result: "renumbered"; renames: Map<string, string>; resolvedTaskFile: boolean }
  | { result: "nothing-to-merge" }
  /** conflictKind は classifyConflicts が何と分類したかを表す。"mechanical" は
   *  本来機械的に解決できるはずだったが解決に失敗したことを意味する。
   *
   *  preResolvedRenames は "partial" 分類のときだけ添える、ID 採番衝突の改番計画。
   *  呼び出し側(supervisor.ts)が reproduceMergeConflict 経由で worktree 側の
   *  preResolveIdCollisions へ渡す。ID 採番衝突が無かった・計画が立てられなかった
   *  場合は付与しない(呼び出し側は `renames ?? new Map()` として扱う)。 */
  | {
      result: "conflict";
      paths: string[];
      conflictKind?: ConflictKind;
      preResolvedRenames?: Map<string, string>;
    }
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

/**
 * main 上で「現在使われている」decisions / human-review の ID 一覧を集める。
 * 対象: HEAD(マージ未実施なので main のまま)上の `.agent/decisions|human-review` と
 * その `.agent/archive/` 側、および今回のマージで(衝突せず)index に採用された
 * 同ディレクトリ配下の追加分。衝突中のパス自身が HEAD 側にツリーとして存在する場合は
 * ls-tree 経由で自然に含まれる(Set のため重複追加も無害)。
 * 収集対象のディレクトリには `.gitkeep` のような ID 形式でないファイルも置かれうるため、
 * 戻り値は ID 形式(`(D|HR)-YYYYMMDD-N`)に一致するものだけへ絞り込む(そうしないもの同士は
 * そもそも衝突しようがなく、下流の planIdRenumber を安全側の空 Map へ倒してしまう)。
 */
export function collectUsedIds(root: string): string[] {
  const ids = new Set<string>();
  const treeDirs = [".agent/decisions", ".agent/human-review", ".agent/archive/decisions", ".agent/archive/human-review"];
  for (const dir of treeDirs) {
    const out = git(["ls-tree", "-r", "--name-only", "HEAD", "--", dir], root);
    for (const p of out.split("\n")) {
      if (p === "") continue;
      ids.add(basenameId(p));
    }
  }
  const staged = git(["diff", "--cached", "--name-only"], root);
  for (const p of staged.split("\n")) {
    if (p === "") continue;
    if (p.startsWith(DECISIONS_DIR) || p.startsWith(HUMAN_REVIEW_DIR)) {
      ids.add(basenameId(p));
    }
  }
  return [...ids].filter((id) => ID_RE.test(id));
}

/**
 * "mechanical" と分類されたコンフリクト(id-collision・own-task-file)を機械的に解決し、
 * 解決コミットを作る。失敗(substantive 判定・振り直し不能・想定外の例外)時は merge を
 * abort して "conflict" を返す。"partial" 分類のときは own-task-file も含め機械解決は行わず、
 * ID 採番衝突だけの改番計画を preResolvedRenames として添えて "conflict" を返す(実際の
 * 先行解決は worktree 側の reproduceMergeConflict / preResolveIdCollisions が行う)。
 * abort 自体が失敗した(main が git 操作の途中で固まった)場合は "wedged" を返す
 * (呼び出し側はこれを見て人間に伝える判断をする)。
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

    if (classification.kind === "partial") {
      knownPaths = [...stages.keys()];
      // index にはまだ今回のマージで(衝突せず)採用された追加分が乗っている。abort すると
      // それが失われ collectUsedIds が正しい採番の基準を計算できなくなるため、abort する
      // 前に改番計画を作っておく。
      const collidingIds = classification.idCollisions.map((p) => basenameId(p));
      const usedIds = collectUsedIds(root);
      const renames = planIdRenumber(usedIds, collidingIds);
      const abortResult = abortMerge(root);
      if (!abortResult.ok) return { result: "wedged", stderr: abortResult.stderr };
      if (renames.size > 0) {
        return {
          result: "conflict",
          paths: classification.substantivePaths,
          conflictKind: knownKind,
          preResolvedRenames: renames,
        };
      }
      // ID 形式不正などで計画不能。何も先行解決できないので従来どおり全パスを報告する
      return { result: "conflict", paths: knownPaths, conflictKind: knownKind };
    }

    const { idCollisions, ownTaskFile } = classification;
    knownPaths = ownTaskFile !== null ? [...idCollisions, ownTaskFile] : [...idCollisions];

    // idCollisions が無ければ振り直す ID も無い(renames は空 Map のまま = 改番 0 件)。
    // own-task-file だけの解決でも "renumbered" として扱ってよい(呼び出し側にとって
    // 「機械的に解決できた」という点が重要で、改番の有無は付随情報でしかない)。
    let renames = new Map<string, string>();
    if (idCollisions.length > 0) {
      const collidingIds = idCollisions.map((p) => basenameId(p));
      const usedIds = collectUsedIds(root);
      renames = planIdRenumber(usedIds, collidingIds);
      if (renames.size === 0) {
        const abortResult = abortMerge(root);
        if (!abortResult.ok) return { result: "wedged", stderr: abortResult.stderr };
        return { result: "conflict", paths: knownPaths, conflictKind: knownKind };
      }
    }

    for (const oldPath of idCollisions) {
      const oldId = basenameId(oldPath);
      const newId = renames.get(oldId);
      if (newId === undefined) continue;
      const theirs = git(["show", `:3:${oldPath}`], root);
      // 旧パスは main(ours)の内容のまま残す
      execFileSync("git", ["checkout", "--ours", "--", oldPath], { cwd: root });
      execFileSync("git", ["add", "--", oldPath], { cwd: root });
      // branch(theirs)の内容を新しい ID のパスへ、ID 参照を書き換えた上で追加する
      const dir = oldPath.slice(0, oldPath.lastIndexOf("/"));
      const newPath = `${dir}/${newId}.md`;
      fs.writeFileSync(path.join(root, newPath), rewriteIdReferences(theirs, renames));
      execFileSync("git", ["add", "--", newPath], { cwd: root });
    }

    let resolvedTaskFile = false;
    if (ownTaskFile !== null) {
      // マージ中のタスク自身のタスクファイルは branch 側(theirs)を正とする。main 側の
      // 差分はこのマージ処理自身(Supervisor)が書き込んだ機械的な失敗記録に過ぎず、
      // 消えるわけではなく git 履歴には残る。一方 branch 側にはセッションが書いた
      // 最終的なステータス・試行履歴があり、そちらが真の内容である(モジュール先頭の
      // 説明を参照)。
      execFileSync("git", ["checkout", "--theirs", "--", ownTaskFile], { cwd: root });
      if (renames.size > 0) {
        // ID を振り直した場合、branch 側のタスクファイルが旧 ID を参照している可能性がある
        const absPath = path.join(root, ownTaskFile);
        const text = fs.readFileSync(absPath, "utf8");
        const rewritten = rewriteIdReferences(text, renames);
        if (rewritten !== text) fs.writeFileSync(absPath, rewritten);
      }
      execFileSync("git", ["add", "--", ownTaskFile], { cwd: root });
      resolvedTaskFile = true;
    }

    // 衝突パス以外に branch がステージした .agent 配下の .md ファイルは、branch 自身が
    // 新規に持ち込んだファイルなので、その中の ID 参照も書き換える対象になりうる
    // (衝突していない main 側の既存ファイルは対象外。衝突パス自身は上で処理済み)
    const stagedMdFiles = git(["diff", "--cached", "--name-only", "--", ".agent"], root)
      .split("\n")
      .filter((p) => p !== "" && p.endsWith(".md") && !knownPaths.includes(p));
    for (const p of stagedMdFiles) {
      const absPath = path.join(root, p);
      if (!fs.existsSync(absPath)) continue;
      const text = fs.readFileSync(absPath, "utf8");
      const rewritten = rewriteIdReferences(text, renames);
      if (rewritten !== text) {
        fs.writeFileSync(absPath, rewritten);
        execFileSync("git", ["add", "--", p], { cwd: root });
      }
    }

    const remainingUnmerged = git(["ls-files", "-u"], root).trim();
    if (remainingUnmerged !== "") {
      throw new Error(`コンフリクト解消後も未マージのパスが残っている: ${remainingUnmerged}`);
    }

    const message = mergeCommitMessage(
      branch,
      taskId,
      title,
      trailer,
      renames,
      resolvedTaskFile && ownTaskFile !== null ? ownTaskFile : undefined,
    );
    execFileSync("git", ["commit", "-F", "-"], {
      cwd: root,
      input: message,
      // pre-commit の detect-todo だけを無効化する(--no-verify は使わない)。振り直した
      // decisions/human-review の本文や採用したタスクファイルの本文には TODO/FIXME という
      // 語がそのまま含まれうるが、それはタスクの記述内容であってこのマージ処理が持ち込む
      // 問題ではないため、このチェック 1 つに絞って無効化するのが妥当
      // (範囲を detect-todo に限定する)
      env: { ...process.env, GIT_HOOKS_IGNORE_DETECT_TODO: "1" },
    });

    return { result: "renumbered", renames, resolvedTaskFile };
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
 * - コンフリクトが mechanical(id-collision・own-task-file のみ)なら機械的に解決して
 *   "renumbered"(モジュール先頭の説明を参照)。
 * - partial(id-collision と実質衝突が混在)なら abort して "conflict" を返すが、ID 採番衝突
 *   だけの改番計画を preResolvedRenames に添える(実際の先行解決は worktree 側で行う)。
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

/**
 * 衝突を再現した worktree(ours = ブランチ / theirs = main)上で、ID 採番衝突だけを
 * 機械的に解決して index へ載せる。実質衝突のマーカーはそのまま残す。
 * 戻り値は解決した(旧)パスの一覧。何もできなければ空配列。例外は投げない。
 * 例外時も abort はしない(衝突マーカーが残ったままなのが望ましい状態であり、失敗しても
 * 従来どおりの衝突解消セッションになるだけでよいため)。ただし複数件の ID 衝突を処理中に
 * 2 件目以降で例外が出た場合、それより前に解決できた分は checkout --theirs / add 済みのまま
 * index に残る(戻り値は空配列になり、その解決分は呼び出し側からは見えなくなる)。
 * 次のセッションが `git status` で実際の index の状態を見れば足りるため、ここでは
 * 巻き戻しは行わない。
 */
export function preResolveIdCollisions(worktree: string, renames: Map<string, string>): string[] {
  if (renames.size === 0) return [];
  try {
    if (!fs.existsSync(gitPathAbs(worktree, "MERGE_HEAD"))) return [];

    const stages = parseUnmergedStages(git(["ls-files", "-u", "-z"], worktree));
    // 先に対象を確定させる。改番計画は root 側のマージで立てたものなので、worktree 側で
    // 実際に衝突していない ID が混ざりうる。それを参照の書き換えに使うと、存在しない ID を
    // 指す参照を作ってしまうため、書き換えには「実際に解決する分」だけを使う
    const targets: { path: string; newId: string }[] = [];
    for (const [p, stageSet] of stages) {
      if (!isIdCollisionPath(p, stageSet)) continue;
      const newId = renames.get(basenameId(p));
      if (newId === undefined) continue;
      targets.push({ path: p, newId });
    }
    if (targets.length === 0) return [];
    const applied = new Map(targets.map((t) => [basenameId(t.path), t.newId]));

    const resolved: string[] = [];
    for (const { path: p, newId } of targets) {
      // worktree 側は ours = ブランチ(:2)/ theirs = main(:3)。root 側(resolveMechanically、
      // ours = main / theirs = ブランチ)とは向きが逆になる点に注意
      const ours = git(["show", `:2:${p}`], worktree);
      // 旧パスは main(theirs)の内容のまま残す
      execFileSync("git", ["checkout", "--theirs", "--", p], { cwd: worktree });
      execFileSync("git", ["add", "--", p], { cwd: worktree });
      // branch(ours)の内容を新しい ID のパスへ、ID 参照を書き換えた上で追加する
      const dir = p.slice(0, p.lastIndexOf("/"));
      const newPath = `${dir}/${newId}.md`;
      fs.writeFileSync(path.join(worktree, newPath), rewriteIdReferences(ours, applied));
      execFileSync("git", ["add", "--", newPath], { cwd: worktree });
      resolved.push(p);
    }

    // 衝突パス以外にブランチが持ち込んだ .agent 配下の .md ファイルは、ID 参照を書き換える
    // 対象になりうる。ただし未マージのまま残っているパス(衝突マーカーが入っている)は
    // 触らない
    const unmergedPaths = new Set(stages.keys());
    const base = git(["merge-base", "HEAD", "MERGE_HEAD"], worktree).trim();
    const branchMdFiles = git(["diff", "--name-only", `${base}..HEAD`, "--", ".agent"], worktree)
      .split("\n")
      .filter((p) => p !== "" && p.endsWith(".md") && !unmergedPaths.has(p));
    for (const p of branchMdFiles) {
      const absPath = path.join(worktree, p);
      if (!fs.existsSync(absPath)) continue;
      const text = fs.readFileSync(absPath, "utf8");
      const rewritten = rewriteIdReferences(text, applied);
      if (rewritten !== text) {
        fs.writeFileSync(absPath, rewritten);
        execFileSync("git", ["add", "--", p], { cwd: worktree });
      }
    }

    return resolved;
  } catch {
    return [];
  }
}
