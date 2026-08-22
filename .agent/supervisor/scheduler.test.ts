import { describe, expect, it } from "vitest";
import { type LoopInput, planLoopStep, RATE_LIMIT_SLICE_MS, STOP_REASON } from "./scheduler.ts";

const NOW = new Date("2026-08-16T00:00:00.000Z");

/** 何も起きない状態(run モード・停止指示なし・タスクなし・未探索)を基準にする */
function input(over: Partial<LoopInput> = {}): LoopInput {
  return {
    now: NOW,
    once: false,
    completedCount: 0,
    stopMode: null,
    mainDirtyOutsideAgent: false,
    runningCount: 0,
    maxSessions: 1,
    runnableTaskIds: [],
    inputsChanged: false,
    triageEnabled: false,
    triageAttempted: false,
    exploreEnabled: true,
    exploreDue: false,
    exploreDone: false,
    lastExploreYieldedNothing: false,
    pendingSnoozeCount: 0,
    rateLimitedUntilMs: null,
    idlePollMs: 60_000,
    fastCrashStreak: 0,
    ...over,
  };
}

describe("planLoopStep", () => {
  describe("停止指示 (優先度 1)", () => {
    it("STOP(session) かつセッションが走っていなければ停止する", () => {
      expect(planLoopStep(input({ stopMode: "session" }))).toEqual({
        type: "stop",
        reason: STOP_REASON.session,
      });
    });

    it("STOP(clean) かつ差分なしならクリーン停止する", () => {
      expect(planLoopStep(input({ stopMode: "clean" }))).toEqual({
        type: "stop",
        reason: STOP_REASON.clean,
      });
    });

    it("STOP(clean) で .agent 以外に差分が残っていれば理由にそれを含めて停止する", () => {
      const action = planLoopStep(input({ stopMode: "clean", mainDirtyOutsideAgent: true }));
      expect(action).toEqual({ type: "stop", reason: STOP_REASON.cleanDirty });
      expect(STOP_REASON.cleanDirty).not.toBe(STOP_REASON.clean);
    });

    it("停止指示があってもセッションが走っていれば drain 待ちにする", () => {
      expect(planLoopStep(input({ stopMode: "session", runningCount: 1, idlePollMs: 5_000 }))).toEqual({
        type: "wait",
        ms: 5_000,
        why: "drain",
      });
    });

    it("停止指示は実行可能タスクや入力変化より優先される", () => {
      expect(
        planLoopStep(input({ stopMode: "clean", runnableTaskIds: ["T-001"], inputsChanged: true })),
      ).toEqual({ type: "stop", reason: STOP_REASON.clean });
    });
  });

  describe("rate limit (優先度 2)", () => {
    it("残り時間が 1 スライスを超える場合は上限で切って待つ", () => {
      expect(planLoopStep(input({ rateLimitedUntilMs: 61_000 }))).toEqual({
        type: "wait",
        ms: RATE_LIMIT_SLICE_MS,
        why: "rate-limit",
      });
    });

    it("残り時間が 1 スライス未満ならその分だけ待つ", () => {
      expect(planLoopStep(input({ rateLimitedUntilMs: 5_000 }))).toEqual({
        type: "wait",
        ms: 5_000,
        why: "rate-limit",
      });
    });

    it("残り時間が 0 以下なら rate limit とみなさない", () => {
      expect(planLoopStep(input({ rateLimitedUntilMs: 0, runnableTaskIds: ["T-001"] }))).toEqual({
        type: "launch",
        taskIds: ["T-001"],
      });
    });

    it("rate limit は実行可能タスクより優先される", () => {
      expect(planLoopStep(input({ rateLimitedUntilMs: 10_000, runnableTaskIds: ["T-001"] }))).toEqual({
        type: "wait",
        ms: 10_000,
        why: "rate-limit",
      });
    });

    it("once で 1 件完了済みなら rate limit を待たずに終了する", () => {
      expect(planLoopStep(input({ once: true, completedCount: 1, rateLimitedUntilMs: 3_600_000 }))).toEqual({
        type: "stop",
        reason: STOP_REASON.onceDone,
      });
    });

    it("once でもまだ何も完了していなければ rate limit を待つ", () => {
      expect(planLoopStep(input({ once: true, completedCount: 0, rateLimitedUntilMs: 30_000 }))).toEqual({
        type: "wait",
        ms: 30_000,
        why: "rate-limit",
      });
    });
  });

  describe("once の終了 (優先度 3・9)", () => {
    it("1 セッション完了したら実行可能タスクが残っていても終了する", () => {
      expect(planLoopStep(input({ once: true, completedCount: 1, runnableTaskIds: ["T-001"] }))).toEqual({
        type: "stop",
        reason: STOP_REASON.onceDone,
      });
    });

    it("実行できるものが何も無ければ終了する", () => {
      expect(planLoopStep(input({ once: true }))).toEqual({ type: "stop", reason: STOP_REASON.onceIdle });
    });

    it("run モードでは同じ状況でもすぐには終了せず、未探索ならまず探索する", () => {
      expect(planLoopStep(input({ once: false }))).toEqual({ type: "explore", trigger: "idle" });
    });
  });

  describe("入力変化による割り込み (優先度 4)", () => {
    it("triage が無効ならアイドルで実行可能タスクより先に探索する", () => {
      expect(planLoopStep(input({ inputsChanged: true, runnableTaskIds: ["T-001"] }))).toEqual({
        type: "explore",
        trigger: "inputs",
      });
    });

    it("drain は廃止した: セッションが走っていても待たずに探索する(mainLoop がブロックするため git 操作は直列のまま)", () => {
      expect(planLoopStep(input({ inputsChanged: true, runningCount: 1, maxSessions: 2 }))).toEqual({
        type: "explore",
        trigger: "inputs",
      });
    });

    it("explore が無効でも入力変化の取り込みは行う", () => {
      expect(planLoopStep(input({ inputsChanged: true, exploreEnabled: false }))).toEqual({
        type: "explore",
        trigger: "inputs",
      });
    });

    it("triage が有効かつ未試行なら探索より先に triage する", () => {
      expect(planLoopStep(input({ inputsChanged: true, triageEnabled: true, triageAttempted: false }))).toEqual({
        type: "triage",
      });
    });

    it("triage はセッションが走っていても待たずに起動する", () => {
      expect(
        planLoopStep(
          input({ inputsChanged: true, triageEnabled: true, triageAttempted: false, runningCount: 1, maxSessions: 2 }),
        ),
      ).toEqual({ type: "triage" });
    });

    it("triage を既に試行済みなら探索へフォールバックする", () => {
      expect(planLoopStep(input({ inputsChanged: true, triageEnabled: true, triageAttempted: true }))).toEqual({
        type: "explore",
        trigger: "inputs",
      });
    });
  });

  describe("瞬時クラッシュの連続によるバックオフ (優先度 5)", () => {
    it("streak が 3 以上かつ実行可能タスクと空きがあれば crash-backoff で待つ", () => {
      expect(
        planLoopStep(input({ fastCrashStreak: 3, runnableTaskIds: ["T-001"], idlePollMs: 5_000 })),
      ).toEqual({ type: "wait", ms: 5_000, why: "crash-backoff" });
    });

    it("streak が 2 なら通常どおり起動する", () => {
      expect(planLoopStep(input({ fastCrashStreak: 2, runnableTaskIds: ["T-001"] }))).toEqual({
        type: "launch",
        taskIds: ["T-001"],
      });
    });

    it("streak が 3 以上でも実行可能タスクが無ければ通常の判断(定期探索等)へ進む", () => {
      expect(planLoopStep(input({ fastCrashStreak: 3, exploreDue: true }))).toEqual({
        type: "explore",
        trigger: "idle",
      });
    });

    it("streak が 3 以上でも空きスロットが無ければ通常どおり完了待ちへ進む(起動しないので抑制の必要がない)", () => {
      expect(
        planLoopStep(
          input({
            fastCrashStreak: 3,
            runnableTaskIds: ["T-001"],
            maxSessions: 1,
            runningCount: 1,
            exploreDone: true,
          }),
        ),
      ).toEqual({ type: "wait", ms: 60_000, why: "slots-full" });
    });
  });

  describe("タスク起動 (優先度 6)", () => {
    it("空きスロット数だけ先頭から起動する", () => {
      expect(
        planLoopStep(input({ maxSessions: 2, runningCount: 0, runnableTaskIds: ["T-001", "T-002", "T-003"] })),
      ).toEqual({ type: "launch", taskIds: ["T-001", "T-002"] });
    });

    it("空きが 1 でも複数走らせない", () => {
      expect(planLoopStep(input({ maxSessions: 3, runningCount: 2, runnableTaskIds: ["T-001", "T-002"] }))).toEqual(
        { type: "launch", taskIds: ["T-001"] },
      );
    });

    it("空きが無ければ slots-full で待つ", () => {
      expect(
        planLoopStep(
          input({
            maxSessions: 1,
            runningCount: 1,
            runnableTaskIds: ["T-001"],
            idlePollMs: 1_000,
            exploreDone: true,
          }),
        ),
      ).toEqual({ type: "wait", ms: 1_000, why: "slots-full" });
    });

    it("実行可能タスクがあるうちは探索の実行間隔が来ていても起動を優先する", () => {
      expect(planLoopStep(input({ runnableTaskIds: ["T-001"], exploreDue: true }))).toEqual({
        type: "launch",
        taskIds: ["T-001"],
      });
    });
  });

  describe("探索 (優先度 7)", () => {
    it("run: 未探索ならクールダウン(exploreDue)を待たずに探索する", () => {
      expect(planLoopStep(input({ exploreDone: false, exploreDue: false }))).toEqual({
        type: "explore",
        trigger: "idle",
      });
    });

    it("run: 探索済みなら実行間隔が来ていても探索しない(定期探索は廃止した)", () => {
      expect(planLoopStep(input({ exploreDone: true, exploreDue: true }))).toEqual({
        type: "stop",
        reason: STOP_REASON.idleExit,
        cause: "idle-exit",
      });
    });

    it("once: 実行間隔が来ていれば exploreDone に関わらず探索する(once の挙動は不変)", () => {
      expect(planLoopStep(input({ once: true, exploreDue: true, exploreDone: true }))).toEqual({
        type: "explore",
        trigger: "idle",
      });
    });

    it("drain は廃止した: セッションが走っていても待たずに探索する", () => {
      expect(planLoopStep(input({ exploreDone: false, runningCount: 1, maxSessions: 2 }))).toEqual({
        type: "explore",
        trigger: "idle",
      });
    });

    it("run: 直前の探索が空振りかつクールダウン未経過なら再探索せず idle-exit する(空振り探索の連鎖抑制)", () => {
      expect(
        planLoopStep(input({ exploreDone: false, lastExploreYieldedNothing: true, exploreDue: false })),
      ).toEqual({
        type: "stop",
        reason: STOP_REASON.idleExit,
        cause: "idle-exit",
      });
    });

    it("run: 直前の探索が空振りでもクールダウンが経過していれば再探索する", () => {
      expect(
        planLoopStep(input({ exploreDone: false, lastExploreYieldedNothing: true, exploreDue: true })),
      ).toEqual({
        type: "explore",
        trigger: "idle",
      });
    });

    it("run: 直前の探索がタスクを生んでいれば、クールダウン未経過でも従来どおり即座に再探索する", () => {
      expect(
        planLoopStep(input({ exploreDone: false, lastExploreYieldedNothing: false, exploreDue: false })),
      ).toEqual({
        type: "explore",
        trigger: "idle",
      });
    });

    it("直前の探索が空振りでクールダウン未経過でも、入力変化があれば抑制されず探索(triage 無効時)へ進む", () => {
      expect(
        planLoopStep(
          input({ inputsChanged: true, exploreDone: false, lastExploreYieldedNothing: true, exploreDue: false }),
        ),
      ).toEqual({
        type: "explore",
        trigger: "inputs",
      });
    });
  });

  describe("完了待ち (優先度 8)", () => {
    it("探索済みで実行可能タスクも無くセッションだけ走っていれば slots-full で待つ", () => {
      expect(planLoopStep(input({ exploreDone: true, runningCount: 1, maxSessions: 2 }))).toEqual({
        type: "wait",
        ms: 60_000,
        why: "slots-full",
      });
    });

    it("once でもセッションが走っている間は終了しない", () => {
      expect(planLoopStep(input({ once: true, runningCount: 1, maxSessions: 2 }))).toEqual({
        type: "wait",
        ms: 60_000,
        why: "slots-full",
      });
    });
  });

  describe("アイドル終了 (優先度 10・11)", () => {
    it("探索済みで実行可能タスクも実行中セッションも無ければ終了する", () => {
      expect(planLoopStep(input({ exploreDone: true }))).toEqual({
        type: "stop",
        reason: STOP_REASON.idleExit,
        cause: "idle-exit",
      });
    });

    it("explore が無効なら exploreDone に関わらず終了する", () => {
      expect(planLoopStep(input({ exploreEnabled: false, exploreDone: false }))).toEqual({
        type: "stop",
        reason: STOP_REASON.idleExit,
        cause: "idle-exit",
      });
    });

    it("実行可能タスクがあれば終了せず起動する", () => {
      expect(planLoopStep(input({ exploreDone: true, runnableTaskIds: ["T-001"] }))).toEqual({
        type: "launch",
        taskIds: ["T-001"],
      });
    });

    it("セッションが実行中なら終了せず完了を待つ", () => {
      expect(planLoopStep(input({ exploreDone: true, runningCount: 1, maxSessions: 2 }))).toEqual({
        type: "wait",
        ms: 60_000,
        why: "slots-full",
      });
    });

    it("inputsChanged なら終了せず探索へ回る", () => {
      expect(planLoopStep(input({ exploreDone: true, inputsChanged: true }))).toEqual({
        type: "explore",
        trigger: "inputs",
      });
    });

    it("rate limit 中は終了せず待機する", () => {
      expect(planLoopStep(input({ exploreDone: true, rateLimitedUntilMs: 5_000 }))).toEqual({
        type: "wait",
        ms: 5_000,
        why: "rate-limit",
      });
    });

    it("STOP 指示があれば idle-exit ではなく通常の停止理由になる", () => {
      expect(planLoopStep(input({ exploreDone: true, stopMode: "clean" }))).toEqual({
        type: "stop",
        reason: STOP_REASON.clean,
      });
    });

    it("スヌーズ中のタスクが残っていれば終了せずアイドル待機する(時間が来れば runnable に戻るため)", () => {
      expect(planLoopStep(input({ exploreDone: true, pendingSnoozeCount: 1 }))).toEqual({
        type: "wait",
        ms: 60_000,
        why: "idle",
      });
    });

    it("once モードでは idle-exit を使わず従来どおり onceIdle で終了する", () => {
      expect(planLoopStep(input({ once: true, exploreDone: true }))).toEqual({
        type: "stop",
        reason: STOP_REASON.onceIdle,
      });
    });
  });
});
