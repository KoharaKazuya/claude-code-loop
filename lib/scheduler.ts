/**
 * Supervisor メインループの「次の一手」を決める判断(ポリシー)を、副作用から切り離した純粋関数。
 *
 * supervisor.ts の ROOT はモジュール定数のため、mainLoop の中に判断が埋まっている限り
 * ループの挙動はテストできない。判断だけをこのモジュールへ切り出し、supervisor.ts 側は
 * 「状態を集めて planLoopStep に渡し、返ってきた LoopAction を実行するだけ」の薄い実行器にする。
 *
 * このモジュールは判断のみを担い、実行(セッションの起動・完了の後始末)は持たない。
 * launch が複数の taskId を返すとき、実行器はそれらを同時に起動する。
 */

/**
 * 停止指示の段階。run プロセスのメモリだけに持ち、ファイルには永続化しない
 * (プロセスが終われば停止意思も消えるのが正しい: 外部からの停止手段は Ctrl+C だけ)。
 *   - none:  停止指示なし
 *   - clean: 新規セッションを起動せず、実行中が終わり次第、一区切りとして停止する
 */
export type StopMode = "none" | "clean";

export interface LoopInput {
  now: Date;
  /** Ctrl+C / SIGTERM による停止指示(run プロセスのメモリ上の状態) */
  stopMode: StopMode;
  /** .agent/ 以外に未コミットの差分があるか(clean 停止の停止理由・ログ用) */
  mainDirtyOutsideAgent: boolean;
  /** 現在走っているセッション数 */
  runningCount: number;
  /** 同時セッション数の上限 */
  maxSessions: number;
  /** planTaskSelection が返した実行可能タスクの ID(優先度順) */
  runnableTaskIds: string[];
  /** 人間からの入力(GOAL.md・Human Review の回答)が前回取り込み時から変わったか */
  inputsChanged: boolean;
  /** Human Review の段階的処理(triage: 決定論判定→軽量モデル判定)を行うか */
  triageEnabled: boolean;
  /** 現在の入力ハッシュに対して triage を既に試みたか(無限リトライ防止) */
  triageAttempted: boolean;
  exploreEnabled: boolean;
  /** lastExploreAt からの経過が minIntervalMs を超えたか。
   * 直前の探索が空振りだったときのクールダウン判定に使う */
  exploreDue: boolean;
  /** このプロセス起動後、探索セッションを一度でも完了させたか(自動終了の判定に使う) */
  exploreDone: boolean;
  /** 直前に完了した探索セッションが新規タスクを 1 件も登録しなかったか(プロセス内で追跡)。
   * true の間は exploreDue のクールダウンを課し、空振り探索の即時連鎖を防ぐ */
  lastExploreYieldedNothing: boolean;
  /** ready・依存充足・未実行だがスヌーズ中で runnable から外れているタスクの数
   * (自動終了の判定で「時間が来れば復帰するタスクがある」ことを示すために使う) */
  pendingSnoozeCount: number;
  /** rate limit の解除までの残り時間(ミリ秒)。null または 0 以下なら制限なし */
  rateLimitedUntilMs: number | null;
  idlePollMs: number;
  /** 直近の「起動直後に異常終了したタスクセッション」の連続回数(finishTaskSession が更新する)。
   * 系統的な故障(環境要因でセッションが軒並み瞬時にクラッシュする)を検知するために使う */
  fastCrashStreak: number;
}

export type LoopAction =
  | { type: "stop"; reason: string; cause?: "idle-exit" }
  | { type: "explore"; trigger: "inputs" | "idle" }
  | { type: "triage" }
  | { type: "launch"; taskIds: string[] }
  | { type: "wait"; ms: number; why: "rate-limit" | "drain" | "slots-full" | "idle" | "crash-backoff" };

/** rate limit 待機の 1 スライス。長時間待ちでも定期的に停止指示を拾い直すため上限を設ける */
export const RATE_LIMIT_SLICE_MS = 60_000;

export const STOP_REASON = {
  clean: "停止指示 (clean): 一区切りとして停止する(再開: ccloop run)",
  cleanDirty:
    "停止指示 (clean): .agent/ 以外に未コミットの差分が残っているが、新規セッションを起動しない以上は解消しないため差分を残して停止する(再開: ccloop run)",
  idleExit: "実行可能なタスクが無く、探索しても新しいタスクが生まれなかったため終了する(再開: ccloop run)",
} as const;

/**
 * 次の一手を決める。判断の優先度は以下の順で、上位が成立したら下位は評価しない。
 *
 * 1. 停止指示あり(stopMode !== "none")
 *    新規セッションの起動を止め、実行中セッションがあれば drain 待ち、無ければ停止する。
 * 2. rate limit 中(rateLimitedUntilMs > 0)
 *    最大 RATE_LIMIT_SLICE_MS のスライスで待つ。待機中も周回ごとに停止指示を拾い直せる。
 * 3. 人間からの入力が変化した → 既存タスクより先に割り込ませる。triage が有効かつこの入力
 *    ハッシュに対してまだ試みていなければ、まず軽量な triage(決定論判定→軽量モデル判定)を
 *    行う。triage で解決しきれなかった分は、次回以降 inputsChanged が残ったままになり
 *    通常の探索(Opus のフル探索)へ自動フォールバックする。
 *    探索・triage は main の状態を書き換えるが、mainLoop が await でブロックして実行するため、
 *    走っているタスクセッションを待たずに並走させてよい(git 操作は直列のまま保たれる)。
 * 4. 瞬時クラッシュが 3 回連続している かつ 起動できる状況(実行可能タスクがあり空きスロットもある)
 *    → 環境要因によるシステム的な故障の可能性が高いため、1 周回分だけ起動を見送って様子を見る
 *    (rate limit(2)と通常のタスク起動(5)の間に位置する: rate limit ほど長くは待たないが、
 *    機械的に起動し続けて失敗を積み増すことは避ける)。
 * 5. 空きスロットと実行可能タスクがある → 空き数だけ起動する。
 * 6. 探索したい → 3 と同様、走っているタスクセッションを待たずに並走させる。
 *    このプロセス起動後まだ探索を完了させていない(exploreDone=false)なら探索する。
 *    ただし直前の探索が空振りだった場合(lastExploreYieldedNothing=true)は、
 *    クールダウン(exploreDue)が経過するまで再探索しない(空振り探索の即時連鎖を抑制する)。
 * 7. 実行可能タスクは無いが走っているセッションがある → 完了を待つ。
 * 8. スヌーズ中のタスクが無い(pendingSnoozeCount === 0)→ 終了(idle-exit)。
 *    ここに到達した時点で「停止指示なし・rate limit なし・inputs 変化なし・runnable なし・
 *    実行中なし・探索済み(または explore 無効)」が構造的に成立しているため、探索しても
 *    新しい実行可能タスクは生まれなかったとみなせる。
 * 9. それ以外(スヌーズ中のタスクが残っている)→ アイドル待機(時間が来れば runnable に戻る)。
 */
export function planLoopStep(input: LoopInput): LoopAction {
  const drain: LoopAction = { type: "wait", ms: input.idlePollMs, why: "drain" };

  // 1. 停止指示
  if (input.stopMode !== "none") {
    if (input.runningCount > 0) return drain;
    return {
      type: "stop",
      reason: input.mainDirtyOutsideAgent ? STOP_REASON.cleanDirty : STOP_REASON.clean,
    };
  }

  // 2. rate limit 待機
  if (input.rateLimitedUntilMs !== null && input.rateLimitedUntilMs > 0) {
    return { type: "wait", ms: Math.min(input.rateLimitedUntilMs, RATE_LIMIT_SLICE_MS), why: "rate-limit" };
  }

  // 3. 入力変化による割り込み(triage → 解決しきれなければ探索)
  if (input.inputsChanged) {
    if (input.triageEnabled && !input.triageAttempted) return { type: "triage" };
    return { type: "explore", trigger: "inputs" };
  }

  const free = input.maxSessions - input.runningCount;

  // 4. 瞬時クラッシュの連続によるバックオフ
  if (input.fastCrashStreak >= 3 && input.runnableTaskIds.length > 0 && free > 0) {
    return { type: "wait", ms: input.idlePollMs, why: "crash-backoff" };
  }

  // 5. 空きスロットへのタスク投入
  if (free > 0 && input.runnableTaskIds.length > 0) {
    return { type: "launch", taskIds: input.runnableTaskIds.slice(0, free) };
  }

  // 6. 探索
  // 未探索ならクールダウンを待たずに探索する。ただし直前の探索が空振りだった場合は
  // クールダウン(exploreDue)が経過するまで再探索しない
  const exploreWanted = !input.exploreDone && (!input.lastExploreYieldedNothing || input.exploreDue);
  if (input.exploreEnabled && exploreWanted) {
    return { type: "explore", trigger: "idle" };
  }

  // 7. 走っているセッションの完了待ち
  if (input.runningCount > 0) return { type: "wait", ms: input.idlePollMs, why: "slots-full" };

  // 8. 自動終了: スヌーズ中のタスクが残っていなければ、探索してもタスクが
  // 生まれなかったとみなして終了する
  if (input.pendingSnoozeCount === 0) {
    return { type: "stop", reason: STOP_REASON.idleExit, cause: "idle-exit" };
  }

  // 9. アイドル待機(スヌーズ中タスクが時間経過で runnable に戻るのを待つ)
  return { type: "wait", ms: input.idlePollMs, why: "idle" };
}
