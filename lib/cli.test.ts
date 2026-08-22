import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkNodeVersion, readConfigRaw, readVersion, splitGlobalOptions } from "./cli.ts";
import { createPaths, type Paths } from "./paths.ts";

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

  it("サブコマンドより後ろの --repo も抽出する(前後どちらでも指定できる)", () => {
    expect(splitGlobalOptions(["add", "タイトル", "--repo", "/w/x"])).toEqual({
      repo: "/w/x",
      rest: ["add", "タイトル"],
    });
  });

  it("サブコマンドより後ろの --repo=<path> 形式も抽出する", () => {
    expect(splitGlobalOptions(["status", "--repo=/w/x"])).toEqual({ repo: "/w/x", rest: ["status"] });
  });

  it("複数指定された場合は最後の指定を使う", () => {
    expect(splitGlobalOptions(["--repo", "/a", "status", "--repo", "/b"])).toEqual({
      repo: "/b",
      rest: ["status"],
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

describe("readVersion", () => {
  it("lib/ の 1 つ上の package.json の version を返す", () => {
    // 開発中のチェックアウトでは lib/../package.json がリポジトリの package.json。
    // インストール先(/usr/local/share/ccloop/)でも同じ配置になるよう install.sh が同梱する
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("package.json が無い場所を渡しても落ちず unknown を返す", () => {
    expect(readVersion(path.join(import.meta.dirname, "prompt"))).toBe("unknown");
  });

  it("devcontainer-feature.json の version と package.json の version が一致する", () => {
    const root = path.join(import.meta.dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    const feature = JSON.parse(
      fs.readFileSync(path.join(root, "features", "ccloop", "devcontainer-feature.json"), "utf8"),
    ) as { version: string };

    expect(feature.version).toBe(pkg.version);
  });
});

describe("main: --repo をサブコマンドの後ろに置いても効く(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-repo-postfix-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("`ccloop doctor --repo <path>` は前置と同じリポジトリを診断する", () => {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "doctor", "--repo", repo], {
      encoding: "utf8",
    });

    expect(res.stdout).toContain(`対象リポジトリ: ${fs.realpathSync(repo)}`);
  });
});

describe("readConfigRaw", () => {
  let repo: string;
  let paths: Paths;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-config-"));
    paths = createPaths(repo);
    fs.mkdirSync(paths.agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(paths.stateDir, { recursive: true, force: true });
  });

  it("正常な JSON はそのまま返す", () => {
    fs.writeFileSync(paths.configPath, JSON.stringify({ schemaVersion: 1 }));
    expect(readConfigRaw(paths)).toEqual({ schemaVersion: 1 });
  });

  it("壊れた JSON は既定値へ倒さず投げる(出口の無いループを防ぐ)", () => {
    fs.writeFileSync(paths.configPath, "{ this is not json");
    expect(() => readConfigRaw(paths)).toThrow();
  });
});

describe("main: 壊れた config.json の扱い(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-main-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agent", "GOAL.md"), "# GOAL\n");
    fs.writeFileSync(path.join(repo, ".agent", "config.json"), "{ broken json");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stderr: string } {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, ...args], {
      encoding: "utf8",
    });
    return { status: res.status, stderr: res.stderr };
  }

  it("status は doctor と同じ案内で exit 1 になる", () => {
    const result = run(["status"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".agent/config.json を読めない");
    expect(result.stderr).toContain("手で修正すること");
  });

  it("list / add / watch / run も同じ経路で exit 1 になる", () => {
    for (const args of [["list"], ["add", "タイトル"], ["watch"], ["run"]]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("手で修正すること");
    }
  });

  it("init --upgrade も同じ案内で exit 1 になる", () => {
    const result = run(["init", "--upgrade", "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("手で修正すること");
  });
});
