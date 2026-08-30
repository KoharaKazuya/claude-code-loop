import { styleText } from "node:util";

/**
 * コンソールへ 1 行出力する(ファイルには残さない)。
 * セッションの中身は Claude Code 自身が transcript として保存しており、
 * セッション ID からたどれる(README「セッションログを追う」参照)。
 */
export function log(message: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`${styleText("dim", time)} ${message}`);
}
