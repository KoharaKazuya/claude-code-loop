import { describe, expect, it } from "vitest";
import { detectLeakedBranches, leakMessage } from "./test-global-setup.ts";

describe("detectLeakedBranches", () => {
  it("ブランチが増えていなければ空を返す", () => {
    const before = ["main", "agent/T-100"];
    const after = ["main", "agent/T-100"];
    expect(detectLeakedBranches(before, after, () => true)).toEqual([]);
  });

  it("テスト由来と思われるブランチが増えたら報告する", () => {
    const before = ["main"];
    const after = ["main", "T-001", "agent/T-999"];
    // isKnownTask が false を返す = タスクファイルが存在しない = テストが作ったとみなす
    expect(detectLeakedBranches(before, after, () => false)).toEqual(["T-001", "agent/T-999"]);
  });

  it("実在するタスクの agent/<taskId> ブランチは無視する(他の自律セッションの正当な作業)", () => {
    const before = ["main"];
    const after = ["main", "agent/T-123"];
    expect(detectLeakedBranches(before, after, (taskId) => taskId === "T-123")).toEqual([]);
  });

  it("agent/<taskId> でもタスクファイルが実在しなければ報告する", () => {
    const before = ["main"];
    const after = ["main", "agent/T-999"];
    expect(detectLeakedBranches(before, after, (taskId) => taskId === "T-123")).toEqual(["agent/T-999"]);
  });

  it("ブランチが減っただけなら無視する", () => {
    const before = ["main", "agent/T-100", "agent/T-200"];
    const after = ["main", "agent/T-100"];
    expect(detectLeakedBranches(before, after, () => true)).toEqual([]);
  });

  it("agent/ 以外の増分と agent/ の増分が混在する場合、agent/ 側だけ既知判定を適用する", () => {
    const before = ["main"];
    const after = ["main", "feature-x", "agent/T-100"];
    expect(detectLeakedBranches(before, after, (taskId) => taskId === "T-100")).toEqual(["feature-x"]);
  });

  it("実在するタスクの衝突退避ブランチ agent/conflict/<taskId>-<時刻> は無視する", () => {
    const before = ["main"];
    const after = ["main", "agent/conflict/T-123-20260830T092322Z"];
    expect(detectLeakedBranches(before, after, (taskId) => taskId === "T-123")).toEqual([]);
  });

  it("衝突退避ブランチでもタスクファイルが実在しなければ報告する", () => {
    const before = ["main"];
    const after = ["main", "agent/conflict/T-999-20260830T092322Z"];
    expect(detectLeakedBranches(before, after, (taskId) => taskId === "T-123")).toEqual([
      "agent/conflict/T-999-20260830T092322Z",
    ]);
  });
});

describe("leakMessage", () => {
  it("検出したブランチ名と対処方針を含む", () => {
    const message = leakMessage(["T-001", "agent/T-999"]);
    expect(message).toContain("T-001");
    expect(message).toContain("agent/T-999");
    expect(message).toContain("使い捨てリポジトリ");
  });
});
