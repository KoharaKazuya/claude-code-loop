/**
 * .agent/ 配下の記録ファイルローテーション
 *
 * tasks / decisions / human-review は「1 トピック 1 ファイル + frontmatter」で
 * `.agent/<種別>/<ID>.md` に置かれる。アクティブ側のファイル数が増え続けると
 * 自律セッションが一覧を読む際のコンテキスト消費が線形に増えるため、
 * 「終わったもの」(completed タスク・closed な Review・人間がチェックを付けた判断)を
 * ファイルごと `.agent/archive/<同名ディレクトリ>/` へ移動し、アクティブ側を有界に保つ。
 *
 * tasks / human-review はファイル名 = ID がそのまま索引になるため索引の再生成は行わない。
 * decisions だけは `.agent/decisions/index.md` のチェックボックスに人間がチェックを付けた
 * ものをアーカイブする(件数基準ではない)。ローテーションのたびに index.md を実体ファイルと
 * 突き合わせて補修する(リコンサイル)。
 * 冪等: 移動対象・index.md の変更が無ければ何もしない(2 回連続実行しても 2 回目は全カウント 0、
 * index.md も無変更)。
 * state.json など本モジュールが扱わない種別のファイルには一切触れない。
 *
 * 移動先の archive 側に同名ファイルが既にある場合は上書きせず移動をスキップし、呼び出し側へ
 * 報告する(ファイル名 = ID は他ファイルからの参照キーのため、リネームして退避すると参照が壊れる)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildDecisionsIndexText, DECISIONS_INDEX_FILE, parseDecisionsIndex } from "./decisions-index.ts";
import { parseFrontmatter } from "./frontmatter.ts";

/** dir 内の .md ファイル名をソート済みで返す。dir が存在しなければ空配列 */
function listMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** dir/fileName の frontmatter から status を読む。読めない・無い場合は "" */
function statusOf(dir: string, fileName: string): string {
  try {
    const text = fs.readFileSync(path.join(dir, fileName), "utf8");
    const { data } = parseFrontmatter(text);
    const status = data.status;
    return typeof status === "string" ? status : "";
  } catch {
    return "";
  }
}

/**
 * agentDir/<sub>/ 配下の files を agentDir/archive/<sub>/ へ移動する。
 * 移動先に同名ファイルが既にある場合は上書きせずスキップし、そのファイル名を skipped に積む。
 * files が空なら何もせず { moved: 0, skipped: [] } を返す(mkdirSync もしない)。
 */
function moveToArchive(
  agentDir: string,
  sub: string,
  files: string[],
): { moved: number; skipped: string[] } {
  if (files.length === 0) return { moved: 0, skipped: [] };
  const srcDir = path.join(agentDir, sub);
  const destDir = path.join(agentDir, "archive", sub);
  fs.mkdirSync(destDir, { recursive: true });
  let moved = 0;
  const skipped: string[] = [];
  for (const file of files) {
    const destPath = path.join(destDir, file);
    if (fs.existsSync(destPath)) {
      skipped.push(file);
      continue;
    }
    fs.renameSync(path.join(srcDir, file), destPath);
    moved++;
  }
  return { moved, skipped };
}

// ---------- decisions: index.md のリコンサイル & アーカイブ ----------

/** decisionsDir/<id>.md の frontmatter title を 1 行要約として読む。読めない・文字列でなければ id を使う */
function summaryFromDecisionFile(decisionsDir: string, id: string): string {
  try {
    const text = fs.readFileSync(path.join(decisionsDir, `${id}.md`), "utf8");
    const { data } = parseFrontmatter(text);
    const title = data.title;
    if (typeof title === "string") return title.replace(/\s+/g, " ").trim();
  } catch {
    // 読めない場合は id にフォールバック
  }
  return id;
}

/**
 * decisions のリコンサイル + アーカイブ。
 * 1. index.md を実体ファイル(D-*.md)と突き合わせ、無い行を削除・未登録の行を未チェックで追加する。
 * 2. リコンサイル後に `[x]` が付いた ID を archive/decisions/ へ移動し、index.md から取り除く。
 *    移動先に同名ファイルが既にあってスキップした決定は、実体ファイルが残ったままなので
 *    index.md の行も `[x]` を付けたまま残す(消すと次回リコンサイルで未チェックとして
 *    再追加され、人間が付けたチェックが失われる)。
 * 戻り値は移動したファイル数(index.md の書き換え件数は含まない)と、衝突でスキップした
 * ファイルの `decisions/<ファイル名>` 形式の一覧。
 */
function rotateDecisions(agentDir: string): { moved: number; conflicts: string[] } {
  const decisionsDir = path.join(agentDir, "decisions");
  const indexPath = path.join(decisionsDir, DECISIONS_INDEX_FILE);

  let existingIds: string[];
  try {
    existingIds = fs
      .readdirSync(decisionsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith("D-") && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -".md".length));
  } catch {
    existingIds = [];
  }
  const existingIdSet = new Set(existingIds);

  let originalText: string | undefined;
  try {
    originalText = fs.readFileSync(indexPath, "utf8");
  } catch {
    originalText = undefined;
  }

  // 決定ファイルも index.md も無ければ何もしない(index.md を新規作成しない)
  if (existingIdSet.size === 0 && originalText === undefined) return { moved: 0, conflicts: [] };

  const { header, entries, footer } = parseDecisionsIndex(originalText ?? "");
  const byId = new Map(entries.map((e) => [e.id, e] as const));

  // 実体ファイルが無い行を削除
  for (const id of byId.keys()) {
    if (!existingIdSet.has(id)) byId.delete(id);
  }
  // 実体はあるが index.md に無い ID を未チェックで追加
  for (const id of existingIds) {
    if (!byId.has(id)) {
      byId.set(id, { id, checked: false, summary: summaryFromDecisionFile(decisionsDir, id) });
    }
  }

  // ID 降順(新しい順)に正規化
  const reconciled = [...byId.keys()].sort().reverse().map((id) => byId.get(id)!);

  const toArchiveFiles = reconciled.filter((e) => e.checked).map((e) => `${e.id}.md`);

  // 先に移動してから index.md を書く。逆順だと移動に失敗したとき index.md からだけ行が消え、
  // 次回リコンサイルで人間が付けたチェックが失われる。
  const { moved, skipped } = moveToArchive(agentDir, "decisions", toArchiveFiles);
  const skippedIds = new Set(skipped.map((f) => f.slice(0, -".md".length)));
  const remaining = reconciled.filter((e) => !e.checked || skippedIds.has(e.id));

  const newText = buildDecisionsIndexText(header, remaining, footer);
  if (newText !== originalText) {
    fs.writeFileSync(indexPath, newText);
  }

  return { moved, conflicts: skipped.map((f) => `decisions/${f}`) };
}

// ---------- 公開 API ----------

export interface RotateResult {
  tasks: number;
  decisions: number;
  humanReview: number;
  /**
   * 移動先の archive 側に同名ファイルが既にあり、上書きを避けて移動をスキップしたものの一覧。
   * 要素は `"tasks/T-xxx.md"` のような `<種別>/<ファイル名>` 形式(区切りは常に `/`)で、
   * tasks / decisions / human-review の順に並ぶ。
   */
  conflicts: string[];
}

/** ローテーション対象(移動・スキップとも)が 1 件も無いか(ログを出す必要が無いか) */
export function rotateResultIsEmpty(result: RotateResult): boolean {
  return (
    result.tasks === 0 &&
    result.decisions === 0 &&
    result.humanReview === 0 &&
    result.conflicts.length === 0
  );
}

export interface RotateOptions {
  /**
   * ローテーション対象から外すタスク ID の集合(走行中のタスクセッションが担当しているもの)。
   * 対象は tasks のみ。走行中タスクの記録ファイルを main 側で動かすと、そのタスクのブランチが
   * 同じファイルを更新しているため、後の自動マージが modify/delete の衝突になる。decisions /
   * human-review は走行中セッションが「終わったもの」を書き換える経路が無く、除外しなくても
   * 衝突しないため対象にしない(意図的に粒度を細かくしていない)。
   */
  excludeTaskIds?: ReadonlySet<string>;
}

/**
 * agentDir(通常 .agent/)配下のローテーションを実行する。
 * state.json など本モジュールが扱わないファイルには一切触れない。
 * 移動先に同名ファイルが既にある場合は上書きせずスキップし、`conflicts` に積んで報告する。
 */
export function rotate(agentDir: string, options: RotateOptions = {}): RotateResult {
  const tasksDir = path.join(agentDir, "tasks");
  const tasksToArchive = listMdFiles(tasksDir).filter(
    (f) =>
      statusOf(tasksDir, f) === "completed" &&
      !(options.excludeTaskIds?.has(f.slice(0, -".md".length)) ?? false),
  );
  const tasksResult = moveToArchive(agentDir, "tasks", tasksToArchive);

  const decisionsResult = rotateDecisions(agentDir);

  const humanReviewDir = path.join(agentDir, "human-review");
  const humanReviewToArchive = listMdFiles(humanReviewDir).filter(
    (f) => statusOf(humanReviewDir, f) === "closed",
  );
  const humanReviewResult = moveToArchive(agentDir, "human-review", humanReviewToArchive);

  return {
    tasks: tasksResult.moved,
    decisions: decisionsResult.moved,
    humanReview: humanReviewResult.moved,
    conflicts: [
      ...tasksResult.skipped.map((f) => `tasks/${f}`),
      ...decisionsResult.conflicts,
      ...humanReviewResult.skipped.map((f) => `human-review/${f}`),
    ],
  };
}
