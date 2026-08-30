import { describe, expect, it } from "vitest";
import {
  FAST_CRASH_STREAK_LIMIT,
  type LoopInput,
  planLoopStep,
  RATE_LIMIT_SLICE_MS,
  STOP_REASON,
} from "./scheduler.ts";

const NOW = new Date("2026-08-16T00:00:00.000Z");

/**
 * 何も起きない状態(停止指示なし・タスクなし・探索済みで main も入力も変化なし)を基準にする。
 * この基準では探索の理由が無いため、素の input() は idle-exit になる。
 */
function input(over: Partial<LoopInput> = {}): LoopInput {
  return {
    now: NOW,
    stopMode: "none",
    mainDirtyOutsideAgent: false,
    runningCount: 0,
    maxSessions: 1,
    runnableTaskIds: [],
    conflictResumeTaskIds: [],
    inputsDirty: false,
    mainDirty: false,
    triageEnabled: false,
    triageAttempted: false,
    exploreEnabled: true,
    exploreRunning: false,
    exploreDue: false,
    neverExplored: false,
    lastExploreYieldedNothing: false,
    lastExploreFastCrashed: false,
    pendingSnoozeCount: 0,
    rateLimitedUntilMs: null,
    idlePollMs: 60_000,
    fastCrashStreak: 0,
    ...over,
  };
}

const IDLE_EXIT = { type: "stop", reason: STOP_REASON.idleExit, cause: "idle-exit" };

describe("planLoopStep", () => {
  describe("停止指示 (優先度 1)", () => {
    it("停止指示 clean かつ差分なしならクリーン停止する", () => {
      expect(planLoopStep(input({ stopMode: "clean" }))).toEqual({
        type: "stop",
        reason: STOP_REASON.clean,
      });
    });

    it("停止指示 clean で .agent 以外に差分が残っていれば理由にそれを含めて停止する", () => {
      const action = planLoopStep(input({ stopMode: "clean", mainDirtyOutsideAgent: true }));
      expect(action).toEqual({ type: "stop", reason: STOP_REASON.cleanDirty });
      expect(STOP_REASON.cleanDirty).not.toBe(STOP_REASON.clean);
    });

    it("停止指示があってもセッションが走っていれば drain 待ちにする", () => {
      expect(planLoopStep(input({ stopMode: "clean", runningCount: 1, idlePollMs: 5_000 }))).toEqual({
        type: "wait",
        ms: 5_000,
        why: "drain",
      });
    });

    it("停止指示 clean でも衝突解消待ちのタスクがあれば先頭 1 件だけ起動する", () => {
      expect(
        planLoopStep(input({ stopMode: "clean", conflictResumeTaskIds: ["T-001", "T-002"] })),
      ).toEqual({ type: "launch", taskIds: ["T-001"], conflictResume: true });
    });

    it("衝突解消待ちがあってもセッションが走っていれば drain 待ちを優先する", () => {
      expect(
        planLoopStep(
          input({ stopMode: "clean", runningCount: 1, conflictResumeTaskIds: ["T-001"], idlePollMs: 5_000 }),
        ),
      ).toEqual({ type: "wait", ms: 5_000, why: "drain" });
    });

    it("rate limit 中は衝突解消セッションを起動せず rate limit 待機に回す", () => {
      expect(
        planLoopStep(input({ stopMode: "clean", conflictResumeTaskIds: ["T-001"], rateLimitedUntilMs: 5_000 })),
      ).toEqual({ type: "wait", ms: 5_000, why: "rate-limit" });
    });

    it("瞬時クラッシュが連続しているときは衝突解消セッションを諦めて停止する", () => {
      expect(
        planLoopStep(
          input({
            stopMode: "clean",
            conflictResumeTaskIds: ["T-001"],
            fastCrashStreak: FAST_CRASH_STREAK_LIMIT,
          }),
        ),
      ).toEqual({ type: "stop", reason: STOP_REASON.clean });
    });

    it("衝突解消待ちが無ければ従来どおり停止する", () => {
      expect(planLoopStep(input({ stopMode: "clean", conflictResumeTaskIds: [] }))).toEqual({
        type: "stop",
        reason: STOP_REASON.clean,
      });
    });

    it("停止指示は実行可能タスクや入力変化より優先される", () => {
      expect(
        planLoopStep(input({ stopMode: "clean", runnableTaskIds: ["T-001"], inputsDirty: true })),
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
  });

  describe("入力変化の取り込み (優先度 4: triage)", () => {
    it("triage が有効かつ未試行なら実行可能タスクより先に triage する", () => {
      expect(
        planLoopStep(input({ inputsDirty: true, triageEnabled: true, runnableTaskIds: ["T-001"] })),
      ).toEqual({ type: "triage" });
    });

    it("triage は軽量なのでセッションが走っていても空きが無くても起動する", () => {
      expect(
        planLoopStep(
          input({ inputsDirty: true, triageEnabled: true, runningCount: 1, maxSessions: 1 }),
        ),
      ).toEqual({ type: "triage" });
    });

    it("triage を既に試行済みなら triage しない(残りは探索が取り込む)", () => {
      expect(
        planLoopStep(input({ inputsDirty: true, triageEnabled: true, triageAttempted: true })),
      ).toEqual({ type: "explore", trigger: "idle" });
    });

    it("triage が無効なら入力変化だけでは割り込まず、探索の起動条件で判断する", () => {
      // 実行可能タスクがある + クールダウン未経過 → 探索せずタスクを起動する(枠の割り込みは廃止)
      expect(
        planLoopStep(input({ inputsDirty: true, runnableTaskIds: ["T-001"], exploreDue: false })),
      ).toEqual({ type: "launch", taskIds: ["T-001"] });
    });

    it("入力変化があっても空きが無ければ探索しない(枠を超える割り込みは廃止した)", () => {
      expect(
        planLoopStep(
          input({ inputsDirty: true, runningCount: 1, maxSessions: 1, exploreDue: true }),
        ),
      ).toEqual({ type: "wait", ms: 60_000, why: "slots-full" });
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

    it("streak が 3 以上でも実行可能タスクが無ければ通常の判断(探索等)へ進む", () => {
      expect(planLoopStep(input({ fastCrashStreak: 3, mainDirty: true }))).toEqual({
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
          }),
        ),
      ).toEqual({ type: "wait", ms: 60_000, why: "slots-full" });
    });

    // 探索セッションの瞬時クラッシュを fastCrashStreak に数えても、この分岐は runnableTaskIds
    // が無ければ通過するだけで抑制が効かない。探索しか走らない状況では crash-backoff が
    // 発火せず空回りもしないことを固定し、意図的なスコープ外であることを担保する。
    it("実行可能タスクが無ければ瞬時クラッシュが連続していても crash-backoff は発火しない", () => {
      expect(
        planLoopStep(
          input({
            fastCrashStreak: FAST_CRASH_STREAK_LIMIT,
            runnableTaskIds: [],
          }),
        ),
      ).toEqual(IDLE_EXIT);
    });
  });

  describe("探索 (優先度 6、探索中ゲートは優先度 3)", () => {
    describe("A: アイドル時の探索", () => {
      it("main が変化していれば、実行可能タスクが無いときに探索する", () => {
        expect(planLoopStep(input({ mainDirty: true }))).toEqual({ type: "explore", trigger: "idle" });
      });

      it("入力が変化していれば探索する(triage 無効時)", () => {
        expect(planLoopStep(input({ inputsDirty: true }))).toEqual({ type: "explore", trigger: "idle" });
      });

      it("未探索なら main も入力も変化していなくても探索する", () => {
        expect(planLoopStep(input({ neverExplored: true }))).toEqual({ type: "explore", trigger: "idle" });
      });

      it("main も入力も変化しておらず探索済みなら探索しない(idle-exit)", () => {
        expect(planLoopStep(input({ exploreDue: true }))).toEqual(IDLE_EXIT);
      });

      it("クールダウン(exploreDue)が未経過でも、空振りでなければ探索する", () => {
        expect(
          planLoopStep(input({ mainDirty: true, lastExploreYieldedNothing: false, exploreDue: false })),
        ).toEqual({ type: "explore", trigger: "idle" });
      });

      it("直前の探索が空振りかつクールダウン未経過なら再探索せず idle-exit する", () => {
        expect(
          planLoopStep(input({ mainDirty: true, lastExploreYieldedNothing: true, exploreDue: false })),
        ).toEqual(IDLE_EXIT);
      });

      it("空振りクールダウン中でも、新しい人間の入力があれば探索する(取り込みを落とさない)", () => {
        expect(
          planLoopStep(input({ inputsDirty: true, lastExploreYieldedNothing: true, exploreDue: false })),
        ).toEqual({ type: "explore", trigger: "idle" });
      });

      it("直前の探索が空振りでもクールダウンが経過していれば再探索する", () => {
        expect(
          planLoopStep(input({ mainDirty: true, lastExploreYieldedNothing: true, exploreDue: true })),
        ).toEqual({ type: "explore", trigger: "idle" });
      });

      it("直前の探索が瞬時クラッシュなら、新しい人間の入力があってもクールダウン未経過中は再探索しない", () => {
        const action = planLoopStep(
          input({ inputsDirty: true, lastExploreFastCrashed: true, exploreDue: false }),
        );
        expect(action.type).not.toBe("explore");
      });

      it("直前の探索が瞬時クラッシュでも、クールダウン(exploreDue)が経過していれば再探索する", () => {
        expect(
          planLoopStep(input({ inputsDirty: true, lastExploreFastCrashed: true, exploreDue: true })),
        ).toEqual({ type: "explore", trigger: "idle" });
      });

      it("回帰: 瞬時クラッシュでなければ、新しい人間の入力による免除は従来どおり効く", () => {
        expect(
          planLoopStep(
            input({
              inputsDirty: true,
              lastExploreFastCrashed: false,
              lastExploreYieldedNothing: true,
              exploreDue: false,
            }),
          ),
        ).toEqual({ type: "explore", trigger: "idle" });
      });

      it("走っているセッションがあっても空きがあれば待たずに探索する(drain は廃止した)", () => {
        expect(planLoopStep(input({ mainDirty: true, runningCount: 1, maxSessions: 2 }))).toEqual({
          type: "explore",
          trigger: "idle",
        });
      });

      it("空きが無ければ探索しない(探索も枠を 1 つ消費する)", () => {
        expect(
          planLoopStep(input({ mainDirty: true, runningCount: 1, maxSessions: 1, neverExplored: true })),
        ).toEqual({ type: "wait", ms: 60_000, why: "slots-full" });
      });
    });

    describe("B: 忙しい中の定期見直し", () => {
      it("実行可能タスクがあっても、変化があり実行間隔が来ていれば起動より探索を優先する", () => {
        expect(
          planLoopStep(input({ runnableTaskIds: ["T-001"], mainDirty: true, exploreDue: true })),
        ).toEqual({ type: "explore", trigger: "periodic" });
      });

      it("入力変化でも定期見直しは成立する(triage 試行済み)", () => {
        expect(
          planLoopStep(
            input({
              runnableTaskIds: ["T-001"],
              inputsDirty: true,
              triageEnabled: true,
              triageAttempted: true,
              exploreDue: true,
            }),
          ),
        ).toEqual({ type: "explore", trigger: "periodic" });
      });

      it("実行間隔が来ていなければ探索せず起動する", () => {
        expect(
          planLoopStep(input({ runnableTaskIds: ["T-001"], mainDirty: true, exploreDue: false })),
        ).toEqual({ type: "launch", taskIds: ["T-001"] });
      });

      it("変化がなければ実行間隔が来ていても探索せず起動する", () => {
        expect(planLoopStep(input({ runnableTaskIds: ["T-001"], exploreDue: true }))).toEqual({
          type: "launch",
          taskIds: ["T-001"],
        });
      });

      it("未探索であることは定期見直しの理由にならない(変化が必要)", () => {
        expect(
          planLoopStep(input({ runnableTaskIds: ["T-001"], neverExplored: true, exploreDue: true })),
        ).toEqual({ type: "launch", taskIds: ["T-001"] });
      });

      it("空きが無ければ探索しない", () => {
        expect(
          planLoopStep(
            input({
              runnableTaskIds: ["T-001"],
              mainDirty: true,
              exploreDue: true,
              runningCount: 1,
              maxSessions: 1,
            }),
          ),
        ).toEqual({ type: "wait", ms: 60_000, why: "slots-full" });
      });
    });

    describe("共通", () => {
      it("explore が無効なら理由があっても探索しない", () => {
        expect(planLoopStep(input({ exploreEnabled: false, mainDirty: true, neverExplored: true }))).toEqual(
          IDLE_EXIT,
        );
      });

      it("探索セッションが走っている間は triage も返さない(HR / タスクファイルを書くため)", () => {
        expect(
          planLoopStep(
            input({
              exploreRunning: true,
              inputsDirty: true,
              triageEnabled: true,
              runningCount: 1,
              maxSessions: 4,
            }),
          ),
        ).toEqual({ type: "wait", ms: 60_000, why: "explore-running" });
      });

      it("探索セッションが走っている間は次の探索もタスク起動もしない", () => {
        expect(
          planLoopStep(
            input({
              exploreRunning: true,
              runnableTaskIds: ["T-001"],
              mainDirty: true,
              exploreDue: true,
              runningCount: 1,
              maxSessions: 4,
              idlePollMs: 5_000,
            }),
          ),
        ).toEqual({ type: "wait", ms: 5_000, why: "explore-running" });
      });
    });
  });

  describe("タスク起動 (優先度 7)", () => {
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
          input({ maxSessions: 1, runningCount: 1, runnableTaskIds: ["T-001"], idlePollMs: 1_000 }),
        ),
      ).toEqual({ type: "wait", ms: 1_000, why: "slots-full" });
    });
  });

  describe("完了待ち (優先度 8)", () => {
    it("探索理由も実行可能タスクも無くセッションだけ走っていれば slots-full で待つ", () => {
      expect(planLoopStep(input({ runningCount: 1, maxSessions: 2 }))).toEqual({
        type: "wait",
        ms: 60_000,
        why: "slots-full",
      });
    });
  });

  describe("アイドル終了 (優先度 9・10)", () => {
    it("探索理由も実行可能タスクも実行中セッションも無ければ終了する", () => {
      expect(planLoopStep(input())).toEqual(IDLE_EXIT);
    });

    it("explore が無効なら未探索でも終了する", () => {
      expect(planLoopStep(input({ exploreEnabled: false, neverExplored: true }))).toEqual(IDLE_EXIT);
    });

    it("実行可能タスクがあれば終了せず起動する", () => {
      expect(planLoopStep(input({ runnableTaskIds: ["T-001"] }))).toEqual({
        type: "launch",
        taskIds: ["T-001"],
      });
    });

    it("セッションが実行中なら終了せず完了を待つ", () => {
      expect(planLoopStep(input({ runningCount: 1, maxSessions: 2 }))).toEqual({
        type: "wait",
        ms: 60_000,
        why: "slots-full",
      });
    });

    it("入力変化があれば終了せず探索へ回る", () => {
      expect(planLoopStep(input({ inputsDirty: true }))).toEqual({ type: "explore", trigger: "idle" });
    });

    it("rate limit 中は終了せず待機する", () => {
      expect(planLoopStep(input({ rateLimitedUntilMs: 5_000 }))).toEqual({
        type: "wait",
        ms: 5_000,
        why: "rate-limit",
      });
    });

    it("停止指示があれば idle-exit ではなく通常の停止理由になる", () => {
      expect(planLoopStep(input({ stopMode: "clean" }))).toEqual({
        type: "stop",
        reason: STOP_REASON.clean,
      });
    });

    it("スヌーズ中のタスクが残っていれば終了せずアイドル待機する(時間が来れば runnable に戻るため)", () => {
      expect(planLoopStep(input({ pendingSnoozeCount: 1 }))).toEqual({
        type: "wait",
        ms: 60_000,
        why: "idle",
      });
    });
  });
});
