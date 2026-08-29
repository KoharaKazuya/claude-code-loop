/**
 * scripts/release.mjs のユニットテスト。
 *
 * git・npm を実際に実行する本体(main)はテストしない。純粋関数として切り出した
 * parseArgs / parseAheadBehind / checkRepoState のみを検証する。
 */

import { describe, expect, it } from "vitest";
import { checkRepoState, parseAheadBehind, parseArgs } from "./release.mjs";

describe("parseArgs", () => {
  it.each(["patch", "minor", "major"])("%s を受理する", (bump) => {
    expect(parseArgs([bump])).toEqual({ bump, dryRun: false });
  });

  it("--dry-run を受理する", () => {
    expect(parseArgs(["patch", "--dry-run"])).toEqual({ bump: "patch", dryRun: true });
    expect(parseArgs(["--dry-run", "patch"])).toEqual({ bump: "patch", dryRun: true });
  });

  it("引数なしはエラーになる", () => {
    const { error, bump } = parseArgs([]);
    expect(error).toMatch(/usage:/);
    expect(bump).toBeUndefined();
  });

  it("不正な bump 値はエラーになる", () => {
    const { error } = parseArgs(["nightly"]);
    expect(error).toMatch(/usage:/);
  });

  it("bump を複数指定するとエラーになる", () => {
    const { error } = parseArgs(["patch", "minor"]);
    expect(error).toMatch(/usage:/);
  });
});

describe("parseAheadBehind", () => {
  it("behind と ahead を読み分ける", () => {
    expect(parseAheadBehind("2\t3")).toEqual({ behind: 2, ahead: 3 });
  });

  it("0\\t0 を扱える", () => {
    expect(parseAheadBehind("0\t0")).toEqual({ behind: 0, ahead: 0 });
  });

  it("前後の空白を無視する", () => {
    expect(parseAheadBehind("  1\t4\n")).toEqual({ behind: 1, ahead: 4 });
  });
});

describe("checkRepoState", () => {
  it("main ブランチ・クリーン・遅れなしなら空配列を返す", () => {
    const errors = checkRepoState({ branch: "main", porcelain: "", behind: 0 });
    expect(errors).toEqual([]);
  });

  it("main 以外のブランチはエラーになる", () => {
    const errors = checkRepoState({ branch: "feature/x", porcelain: "", behind: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/main ブランチ/);
  });

  it("porcelain が非空ならエラーになる", () => {
    const errors = checkRepoState({ branch: "main", porcelain: " M package.json\n", behind: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/クリーンではありません/);
    expect(errors[0]).toContain("package.json");
  });

  it("behind > 0 ならエラーになる", () => {
    const errors = checkRepoState({ branch: "main", porcelain: "", behind: 3 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/3 コミット遅れています/);
  });

  it("複数条件に違反していると全エラーがまとめて返る", () => {
    const errors = checkRepoState({ branch: "feature/x", porcelain: " M a.txt\n", behind: 1 });
    expect(errors).toHaveLength(3);
  });
});
