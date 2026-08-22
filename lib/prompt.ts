/**
 * 自律実行セッションへ渡す system prompt の生成
 *
 * 共通ルールはツール本体が持つ(`lib/prompt/PROMPT.md`)。利用側リポジトリには置かないため、
 * 利用者がリポジトリごとに追記したい規約は `.agent/PROMPT.local.md` に書く。
 *
 * 共通ルールは `-p` のプロンプト本文ではなく `--append-system-prompt-file` で渡す。
 * 理由は 2 つ:
 *
 * - タスク・探索のどのセッションでも同一の内容であり、セッション固有の指示(担当タスク、
 *   起動情報)と混ぜると「どこまでが共通ルールか」が読み手にも書き手にも曖昧になる。
 * - system prompt に置けば、会話が長くなってもモデルにとっての位置づけが安定する。
 *
 * 生成物は state ディレクトリ(リポジトリ外)へ書き、利用者のリポジトリを汚さない。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ccloopHome, type Paths } from "./paths.ts";

/** 共通ルール本体(CCLOOP_HOME 配下の `prompt/PROMPT.md`) */
export function commonPromptPath(home: string = ccloopHome()): string {
  return path.join(home, "prompt", "PROMPT.md");
}

/**
 * 利用側の追記分を連結するときの見出し。どこからが利用側のルールかをモデルが区別できるよう、
 * 出典のファイルパスまで書く(セッションがこのファイルを読み直せるようにするため)。
 */
export const LOCAL_RULES_HEADING = "# リポジトリ固有の追加ルール(.agent/PROMPT.local.md)";

/**
 * 共通ルールと利用側の追記分を連結して system prompt 本文を作る(純粋)。
 * local が null / 空白のみなら共通ルールだけを返す(空の見出しを足さない)。
 */
export function buildSystemPrompt(common: string, local: string | null): string {
  const body = common.replace(/\s+$/, "");
  if (local === null || local.trim() === "") return `${body}\n`;
  return [body, "", "---", "", LOCAL_RULES_HEADING, "", local.trim(), ""].join("\n");
}

/** `.agent/PROMPT.local.md`。無ければ null */
export function readLocalPrompt(paths: Paths): string | null {
  try {
    return fs.readFileSync(paths.promptLocalPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * system prompt を生成して `paths.generatedSystemPromptPath` へ書き出し、そのパスを返す。
 * `ccloop run` の起動時に 1 回だけ呼べばよい(settings の生成と同じタイミング)。
 */
export function generateSystemPrompt(paths: Paths, opts: { home?: string } = {}): string {
  const common = fs.readFileSync(commonPromptPath(opts.home ?? ccloopHome()), "utf8");
  const text = buildSystemPrompt(common, readLocalPrompt(paths));
  fs.mkdirSync(path.dirname(paths.generatedSystemPromptPath), { recursive: true });
  const tmp = `${paths.generatedSystemPromptPath}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, paths.generatedSystemPromptPath);
  return paths.generatedSystemPromptPath;
}
