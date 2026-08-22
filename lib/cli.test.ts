import { describe, expect, it } from "vitest";
import { checkNodeVersion, splitGlobalOptions } from "./cli.ts";

describe("splitGlobalOptions", () => {
  it("--repo <path> を取り除きサブコマンド以降を残す", () => {
    expect(splitGlobalOptions(["--repo", "/w/x", "list", "--full"])).toEqual({
      repo: "/w/x",
      rest: ["list", "--full"],
    });
  });

  it("--repo=<path> 形式も受け付ける", () => {
    expect(splitGlobalOptions(["--repo=/w/x", "status"])).toEqual({ repo: "/w/x", rest: ["status"] });
  });

  it("--repo が無ければ repo は付かない", () => {
    expect(splitGlobalOptions(["status"])).toEqual({ rest: ["status"] });
  });

  it("サブコマンドより後ろの --repo はサブコマンドの引数として残す", () => {
    expect(splitGlobalOptions(["add", "タイトル", "--repo", "/w/x"])).toEqual({
      rest: ["add", "タイトル", "--repo", "/w/x"],
    });
  });

  it("--repo に値が無ければエラー", () => {
    expect(() => splitGlobalOptions(["--repo"])).toThrow();
  });

  it("引数なしなら空", () => {
    expect(splitGlobalOptions([])).toEqual({ rest: [] });
  });
});

describe("checkNodeVersion", () => {
  it("22.18 以降の 22 系は使える", () => {
    expect(checkNodeVersion("22.18.0")).toBeNull();
    expect(checkNodeVersion("22.20.3")).toBeNull();
  });

  it("24 以降は使える", () => {
    expect(checkNodeVersion("24.0.0")).toBeNull();
    expect(checkNodeVersion("25.1.0")).toBeNull();
  });

  it("22.18 未満と 23 系は案内メッセージを返す", () => {
    expect(checkNodeVersion("22.17.1")).toContain("22.18");
    expect(checkNodeVersion("23.11.0")).toContain("22.18");
    expect(checkNodeVersion("20.19.0")).toContain("22.18");
  });

  it("実行中の Node は要件を満たす(package.json の engines と整合する)", () => {
    expect(checkNodeVersion()).toBeNull();
  });
});
