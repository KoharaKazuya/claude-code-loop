/**
 * .agent/ 配下の記録ファイルローテーション
 *
 * tasks / decisions / human-review は「1 トピック 1 ファイル + frontmatter」で
 * `.agent/<種別>/<ID>.md` に置かれる。アクティブ側のファイル数が増え続けると
 * 自律セッションが一覧を読む際のコンテキスト消費が線形に増えるため、
 * 「終わったもの」(completed タスク・closed な Review・直近 10 件より古い判断)を
 * ファイルごと `.agent/archive/<同名ディレクトリ>/` へ移動し、アクティブ側を有界に保つ。
 *
 * ファイル名 = ID がそのまま索引になるため、旧実装にあった索引の再生成は行わない。
 * 冪等: 移動対象が無ければ何もしない(2 回連続実行しても 2 回目は全カウント 0)。
 * state.json など本モジュールが扱わない種別のファイルには一切触れない。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

/** decisions でアクティブ側に残す最新エントリ数(それより古いものをアーカイブへ) */
const DECISIONS_KEEP = 10;

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
 * files が空なら何もせず 0 を返す。
 */
function moveToArchive(agentDir: string, sub: string, files: string[]): number {
  if (files.length === 0) return 0;
  const srcDir = path.join(agentDir, sub);
  const destDir = path.join(agentDir, "archive", sub);
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of files) {
    fs.renameSync(path.join(srcDir, file), path.join(destDir, file));
  }
  return files.length;
}

// ---------- 公開 API ----------

export interface RotateResult {
  tasks: number;
  decisions: number;
  humanReview: number;
}

/** ローテーション対象が 1 件も無いか(ログを出す必要が無いか) */
export function rotateResultIsEmpty(result: RotateResult): boolean {
  return result.tasks === 0 && result.decisions === 0 && result.humanReview === 0;
}

/**
 * agentDir(通常 .agent/)配下のローテーションを実行する。
 * state.json など本モジュールが扱わないファイルには一切触れない。
 */
export function rotate(agentDir: string): RotateResult {
  const tasksDir = path.join(agentDir, "tasks");
  const tasksToArchive = listMdFiles(tasksDir).filter((f) => statusOf(tasksDir, f) === "completed");

  const humanReviewDir = path.join(agentDir, "human-review");
  const humanReviewToArchive = listMdFiles(humanReviewDir).filter(
    (f) => statusOf(humanReviewDir, f) === "closed",
  );

  const decisionsDir = path.join(agentDir, "decisions");
  // ID は D-<YYYYMMDD>-<HHMM>-<slug> で、日時部分がゼロ埋めされているためファイル名の辞書順 = 時系列である。
  // そのため「古い側」は昇順ソート済み一覧の先頭側になる。
  const allDecisions = listMdFiles(decisionsDir);
  const decisionsToArchive = allDecisions.slice(0, Math.max(0, allDecisions.length - DECISIONS_KEEP));

  return {
    tasks: moveToArchive(agentDir, "tasks", tasksToArchive),
    decisions: moveToArchive(agentDir, "decisions", decisionsToArchive),
    humanReview: moveToArchive(agentDir, "human-review", humanReviewToArchive),
  };
}
