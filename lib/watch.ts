/**
 * `ccloop watch`: `ccloop status` の内容を一定間隔で描き直す。
 *
 * 外部の `watch(1)` に頼らないのは、`watch` が色付き出力を素通ししない環境があること、
 * ANSI エスケープの扱いが実装ごとに違うこと、そして「ccloop の使い方は ccloop だけで完結する」
 * ほうが導入手順を短くできることによる。
 *
 * 監視対象(state.json・タスクファイル)は複数のプロセスから随時書き換えられるうえ、
 * 1 回の描画に必要な読み込みは十数ファイル程度で軽い。ファイル監視でイベント駆動にすると
 * 書き込みの途中を読んでしまう競合を自前で捌く必要が出るため、素朴なポーリングで十分とする。
 */

import { usageOf } from "./help.ts";
import { formatStatus } from "./supervisor.ts";

/** 既定の再描画間隔 */
export const DEFAULT_WATCH_INTERVAL_MS = 1_000;

/** 間隔の下限。これより短くしても表示は追いつかず、ファイル読み込みだけが増える */
export const MIN_WATCH_INTERVAL_MS = 200;

/** 画面をクリアしてカーソルを左上へ戻す */
const CLEAR_SCREEN = "\x1b[2J\x1b[H";
/** カーソルを隠す / 戻す(描画のたびにカーソルが飛び回るのを避ける) */
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/**
 * `watch` の引数を解釈する(純粋)。`--interval <秒>` / `--interval=<秒>` を受け付ける。
 * 秒は小数でもよいが、下限 MIN_WATCH_INTERVAL_MS で丸める。
 */
export function parseWatchArgs(argv: string[]): { intervalMs: number } {
  let intervalMs = DEFAULT_WATCH_INTERVAL_MS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let raw: string | undefined;
    if (a === "--interval" || a === "-n") {
      raw = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--interval=")) {
      raw = a.slice("--interval=".length);
    } else {
      throw new Error(`未知の引数: ${a}\n${usageOf("watch")}`);
    }
    if (raw === undefined) throw new Error("--interval には秒数を指定すること");
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`--interval には正の秒数を指定すること: ${raw}`);
    }
    intervalMs = Math.max(MIN_WATCH_INTERVAL_MS, Math.round(seconds * 1000));
  }
  return { intervalMs };
}

/**
 * 1 フレーム分の出力を組み立てる(純粋)。画面クリア + status 本文 + 現在時刻のフッタ。
 * 「いつの表示か」が分からないと固まっているのか動いているのか判別できないため、
 * 時刻とインターバルをフッタに必ず添える。
 */
export function renderFrame(body: string, now: Date, intervalMs: number): string {
  const time = now.toISOString().replace("T", " ").slice(0, 19);
  const footer = `\n\n-- watch (${(intervalMs / 1000).toFixed(1)}s ごとに更新 / ${time} UTC) — Ctrl+C で終了 --`;
  return `${CLEAR_SCREEN}${body}${footer}\n`;
}

/**
 * status を intervalMs ごとに描き直し続ける。Ctrl+C を受けたらカーソルを戻して 0 で終わる
 * (watch を止めるだけで、稼働中の `ccloop run` には一切影響しない)。
 */
export async function cmdWatch(argv: string[]): Promise<void> {
  const { intervalMs } = parseWatchArgs(argv);

  let stopped = false;
  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    // 画面は最後のフレームを残したまま、カーソルだけ復帰させて次の行から促す
    process.stdout.write(`${SHOW_CURSOR}\n`);
    process.exit(0);
  };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);

  process.stdout.write(HIDE_CURSOR);
  try {
    while (!stopped) {
      let body: string;
      try {
        body = formatStatus();
      } catch (err) {
        // 監視対象は別プロセスが書き換えている最中でありうる。1 フレーム分の失敗で
        // watch 全体を落とさず、次の周回で読み直す
        body = `status の取得に失敗した(次の更新で再試行する): ${String(err)}`;
      }
      process.stdout.write(renderFrame(body, new Date(), intervalMs));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    if (!stopped) process.stdout.write(SHOW_CURSOR);
  }
}
