/**
 * レートリミット検出(ベストエフォート)。
 *
 * Claude Code の出力文字列は安定仕様ではないため、文言マッチによる検出のみを行い、
 * 出力に含まれる復帰時刻の解析はしない。待機時間は呼び出し側(supervisor)の
 * 固定間隔(5 分)待機に一任する。復帰前に再試行しても失敗して再度待つだけなので、
 * 実害はログのノイズに限られる。
 */

/** text はセッションの stdout + stderr、exitCode は claude プロセスの終了コード */
export function detectRateLimit(text: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  return /usage limit|rate.?limit|hit your [a-z ]{0,15}limit|Too Many Requests|"429"|status.{0,3}429/i.test(
    text,
  );
}

/**
 * セッション結果からレートリミットを検出する。`--output-format json` を使っているため、
 * タイムアウトで kill されたセッションは CLI が結果 JSON を出力し終える前に殺される。
 * つまりタイムアウトしたセッションの stdout に上限らしき文言が載っていても、それは CLI が
 * 実行中に出したものではなく(既存出力の断片や偶然の一致であり)誤検出の元になる。
 * CLI が実行中に出す通知は stderr に出るため、タイムアウト時は stderr のみを判定対象にする。
 */
export function detectSessionRateLimit(res: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}): boolean {
  const text = res.timedOut ? res.stderr : `${res.stdout}\n${res.stderr}`;
  return detectRateLimit(text, res.exitCode);
}
