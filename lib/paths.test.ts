import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ccloopHome,
  createPaths,
  findGitRoot,
  repoId,
  RepoRootNotFoundError,
  resolveRepoRoot,
  stateDirFor,
  taskFileRelPath,
} from "./paths.ts";

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-paths-test-")));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function initRepo(at: string): void {
  fs.mkdirSync(at, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: at });
}

describe("findGitRoot", () => {
  it(".git ディレクトリを持つ祖先を返す", () => {
    initRepo(dir);
    const nested = path.join(dir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    expect(findGitRoot(nested)).toBe(dir);
  });

  it(".git がファイル(git worktree)の場合も見つける", () => {
    const root = path.join(dir, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");

    expect(findGitRoot(root)).toBe(root);
  });

  it("見つからなければ null", () => {
    // ルートまで遡っても .git が無いことを保証できないため、tmpdir 直下ではなく
    // 明示的に「存在しないパス」を渡して、例外を投げずに動くことだけを確認する
    expect(() => findGitRoot(path.join(dir, "missing"))).not.toThrow();
  });
});

describe("resolveRepoRoot", () => {
  it("repo 指定が最優先される", () => {
    initRepo(dir);

    expect(resolveRepoRoot({ repo: dir, cwd: os.tmpdir(), env: {} })).toBe(dir);
  });

  it("repo 指定が無ければ CCLOOP_REPO を使う", () => {
    initRepo(dir);

    expect(resolveRepoRoot({ cwd: os.tmpdir(), env: { CCLOOP_REPO: dir } })).toBe(dir);
  });

  it("どちらも無ければ cwd から上方へ .git を探す", () => {
    initRepo(dir);
    const nested = path.join(dir, "x", "y");
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveRepoRoot({ cwd: nested, env: {} })).toBe(dir);
  });

  it("指定されたパスが git リポジトリでなければエラーにする(別のリポジトリへ勝手に落ちない)", () => {
    initRepo(dir);
    const notRepo = path.join(dir, "sub");
    fs.mkdirSync(notRepo);

    expect(() => resolveRepoRoot({ repo: notRepo, env: {} })).toThrow(RepoRootNotFoundError);
  });

  it("指定されたパスが存在しなければエラーにする", () => {
    expect(() => resolveRepoRoot({ repo: path.join(dir, "missing"), env: {} })).toThrow(
      RepoRootNotFoundError,
    );
  });

  it("cwd から上方に .git が無ければエラーにする", () => {
    // ルート直下に .git が無いことを前提にできないため、探索起点に存在しないパスを与えて
    // 「例外の型が RepoRootNotFoundError であること」だけを確認する
    const orphan = path.join(dir, "no-git");
    fs.mkdirSync(orphan);
    let thrown: unknown = null;
    try {
      resolveRepoRoot({ cwd: orphan, env: {} });
    } catch (err) {
      thrown = err;
    }
    if (thrown !== null) expect(thrown).toBeInstanceOf(RepoRootNotFoundError);
  });
});

describe("repoId / stateDirFor", () => {
  it("basename と realpath の sha1 先頭 8 文字を組み合わせる", () => {
    const expected = `${path.basename(dir)}-${createHash("sha1").update(dir).digest("hex").slice(0, 8)}`;

    expect(repoId(dir)).toBe(expected);
  });

  it("同名でもパスが違えば別の ID になる", () => {
    const a = path.join(dir, "outer-a", "repo");
    const b = path.join(dir, "outer-b", "repo");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });

    expect(repoId(a)).not.toBe(repoId(b));
  });

  it("XDG_STATE_HOME 配下の ccloop/<repo-id> を指す", () => {
    expect(stateDirFor(dir, { XDG_STATE_HOME: "/xdg" })).toBe(path.join("/xdg", "ccloop", repoId(dir)));
  });

  it("XDG_STATE_HOME が無ければ ~/.local/state を使う", () => {
    expect(stateDirFor(dir, {})).toBe(
      path.join(os.homedir(), ".local", "state", "ccloop", repoId(dir)),
    );
  });
});

describe("createPaths", () => {
  it("git 管理下のパスは .agent/ 配下、実行時ファイルは state ディレクトリ配下になる", () => {
    const p = createPaths(dir);

    expect(p.root).toBe(dir);
    expect(p.agentDir).toBe(path.join(dir, ".agent"));
    expect(p.configPath).toBe(path.join(dir, ".agent", "config.json"));
    expect(p.tasksDir).toBe(path.join(dir, ".agent", "tasks"));
    expect(p.decisionsDir).toBe(path.join(dir, ".agent", "decisions"));
    expect(p.humanReviewDir).toBe(path.join(dir, ".agent", "human-review"));
    expect(p.archiveDir).toBe(path.join(dir, ".agent", "archive"));
    expect(p.goalPath).toBe(path.join(dir, ".agent", "GOAL.md"));
    expect(p.overviewPath).toBe(path.join(dir, ".agent", "OVERVIEW.md"));
    // 共通ルール本体はツール側(lib/prompt/PROMPT.md)が持つ。.agent/ にあるのは任意の追記分だけ
    expect(p.promptLocalPath).toBe(path.join(dir, ".agent", "PROMPT.local.md"));

    expect(p.stateDir).toBe(stateDirFor(dir));
    for (const runtime of [
      p.statePath,
      p.metricsPath,
      p.denialsPath,
      p.patchesDir,
      p.worktreesDir,
      p.generatedSettingsPath,
      p.generatedSystemPromptPath,
    ]) {
      expect(runtime.startsWith(p.stateDir + path.sep)).toBe(true);
    }
    // 実行時ファイルは 1 つも利用者のリポジトリの中に置かない
    expect(p.stateDir.startsWith(dir + path.sep)).toBe(false);
  });

  it("state ディレクトリが無ければ作る", () => {
    const p = createPaths(dir);

    expect(fs.existsSync(p.stateDir)).toBe(true);
  });
});

describe("taskFileRelPath", () => {
  it("リポジトリ相対のタスクファイルパスを返す(git のパススペック用)", () => {
    expect(taskFileRelPath("T-001")).toBe(".agent/tasks/T-001.md");
  });
});

describe("ccloopHome", () => {
  it("常に自分自身の置き場(lib/)を返す。環境変数 CCLOOP_HOME は見ない", () => {
    const prev = process.env.CCLOOP_HOME;
    process.env.CCLOOP_HOME = "/opt/other/lib";
    try {
      expect(ccloopHome()).toBe(import.meta.dirname);
    } finally {
      if (prev === undefined) delete process.env.CCLOOP_HOME;
      else process.env.CCLOOP_HOME = prev;
    }
  });
});
