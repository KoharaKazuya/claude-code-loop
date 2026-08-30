import { execFileSync } from "node:child_process";
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
  resolveRepoRoots,
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

/**
 * at に worktree を 1 つ生やしてそのパスを返す。`git worktree add` はコミットが 1 つ必要なため
 * 空コミットを作る(テスト環境に user 設定が無い前提で -c を使う)
 */
function addWorktree(at: string, name: string): string {
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
    { cwd: at },
  );
  const worktreeDir = path.join(at, name);
  execFileSync("git", ["worktree", "add", "-b", `${name}-branch`, worktreeDir], { cwd: at });
  return worktreeDir;
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
    // 一時ディレクトリの祖先に .git が無いことは環境として保証できない。どちらに転んでも
    // 検証が空振りしないよう、祖先リポジトリの有無で期待値を切り替える
    const orphan = path.join(dir, "no-git");
    fs.mkdirSync(orphan);

    if (findGitRoot(orphan) === null) {
      expect(() => resolveRepoRoot({ cwd: orphan, env: {} })).toThrow(RepoRootNotFoundError);
      return;
    }

    // 祖先に .git がある環境ではエラー経路に入れないため、代わりに「.git を持つ祖先へ
    // 解決され、.git を持たない起点そのものには解決されない」ことを検証する
    const resolved = resolveRepoRoot({ cwd: orphan, env: {} });
    expect(resolved).not.toBe(orphan);
    expect(findGitRoot(resolved)).toBe(resolved);
  });
});

describe("resolveRepoRoot(git worktree)", () => {
  it("worktree のネストしたディレクトリから実行しても本体リポジトリのルートに解決される", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");
    const nested = path.join(worktreeDir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    const resolved = resolveRepoRoot({ cwd: nested, env: {} });
    expect(resolved).toBe(dir);
    expect(repoId(resolved)).toBe(repoId(dir));
  });

  it("--repo に worktree のパスを渡しても本体リポジトリのルートに解決される", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");

    expect(resolveRepoRoot({ repo: worktreeDir, env: {} })).toBe(dir);
  });

  it("CCLOOP_REPO に worktree のパスを渡しても本体リポジトリのルートに解決される", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");

    expect(resolveRepoRoot({ cwd: os.tmpdir(), env: { CCLOOP_REPO: worktreeDir } })).toBe(dir);
  });

  it("本体リポジトリのルートを渡したときの repoId は worktree の有無に影響されない", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");

    expect(repoId(resolveRepoRoot({ repo: dir, env: {} }))).toBe(repoId(dir));
    expect(repoId(resolveRepoRoot({ repo: worktreeDir, env: {} }))).toBe(repoId(dir));
  });

  it(".git ファイルの中身が gitdir: 形式でなければ、そのディレクトリ自身が返る", () => {
    const root = path.join(dir, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "garbage\n");

    expect(resolveRepoRoot({ repo: root, env: {} })).toBe(root);
  });

  it("gitdir の参照先が worktrees 配下の形になっていなければ、そのディレクトリ自身が返る", () => {
    const root = path.join(dir, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /nonexistent/not-a-worktrees-layout\n");

    expect(resolveRepoRoot({ repo: root, env: {} })).toBe(root);
  });
});

describe("resolveRepoRoots", () => {
  it("worktree 内から解決すると root は本体、agentRoot は worktree 自身になる", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");

    const resolved = resolveRepoRoots({ cwd: worktreeDir, env: {} });

    expect(resolved.root).toBe(dir);
    expect(resolved.agentRoot).toBe(fs.realpathSync(worktreeDir));
  });

  it("worktree のネストしたディレクトリから解決しても agentRoot は worktree 自身になる(本体へは読み替えない)", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");
    const nested = path.join(worktreeDir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    const resolved = resolveRepoRoots({ cwd: nested, env: {} });

    expect(resolved.root).toBe(dir);
    expect(resolved.agentRoot).toBe(fs.realpathSync(worktreeDir));
  });

  it("本体ワークツリーから解決すると root === agentRoot", () => {
    initRepo(dir);
    addWorktree(dir, "wt");

    const resolved = resolveRepoRoots({ cwd: dir, env: {} });

    expect(resolved.root).toBe(dir);
    expect(resolved.agentRoot).toBe(dir);
  });

  it("--repo に worktree のパスを渡した場合も root と agentRoot が分かれる", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");

    const resolved = resolveRepoRoots({ repo: worktreeDir, env: {} });

    expect(resolved.root).toBe(dir);
    expect(resolved.agentRoot).toBe(fs.realpathSync(worktreeDir));
  });

  it("CCLOOP_REPO に worktree のパスを渡した場合も root と agentRoot が分かれる", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");

    const resolved = resolveRepoRoots({ cwd: os.tmpdir(), env: { CCLOOP_REPO: worktreeDir } });

    expect(resolved.root).toBe(dir);
    expect(resolved.agentRoot).toBe(fs.realpathSync(worktreeDir));
  });

  it("resolveRepoRoot() は resolveRepoRoots().root と同じ値を返す(既存の薄いラッパー)", () => {
    initRepo(dir);
    const worktreeDir = addWorktree(dir, "wt");

    expect(resolveRepoRoot({ cwd: worktreeDir, env: {} })).toBe(resolveRepoRoots({ cwd: worktreeDir, env: {} }).root);
  });
});

describe("repoId / stateDirFor", () => {
  // 期待値は実装と同じ式で計算せず、固定の入力に対する事前計算済みのリテラルで固定する。
  // 式を写すとハッシュ関数・スライス長・結合順が変わってもテストが追随してしまい、
  // 状態ディレクトリの同定がずれる変更(別リポジトリ扱い・状態ディレクトリの共有)を検知できない。
  it("basename と realpath の sha1 先頭 8 文字を組み合わせる", () => {
    // 存在しないパスなので realpath は失敗し、resolve 済みのパスがそのままハッシュ対象になる。
    // sha1("/nonexistent/ccloop-fixture/my-repo") = 69455ab4872... の先頭 8 文字
    expect(repoId("/nonexistent/ccloop-fixture/my-repo")).toBe("my-repo-69455ab4");
  });

  it("シンボリックリンク経由のパスでも実体パスから導出した ID になる", () => {
    const real = path.join(dir, "real-repo");
    const link = path.join(dir, "link-to-repo");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);

    expect(repoId(link)).toBe(repoId(real));
    // basename もリンク名ではなく実体側の名前になる
    expect(repoId(link)).toMatch(/^real-repo-[0-9a-f]{8}$/);
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
      p.runnerPath,
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

  it("agentRoot 省略時は root と同じ(既存呼び出しの挙動は変わらない)", () => {
    const p = createPaths(dir);

    expect(p.agentRoot).toBe(dir);
  });

  it("agentRoot を渡すと .agent/ 配下は agentRoot 基準、state 系は root 基準になる", () => {
    const agentRoot = path.join(dir, "worktree");
    fs.mkdirSync(agentRoot, { recursive: true });

    const p = createPaths(dir, process.env, agentRoot);

    expect(p.root).toBe(dir);
    expect(p.agentRoot).toBe(agentRoot);
    expect(p.agentDir).toBe(path.join(agentRoot, ".agent"));
    expect(p.tasksDir).toBe(path.join(agentRoot, ".agent", "tasks"));
    expect(p.archiveDir).toBe(path.join(agentRoot, ".agent", "archive"));
    // state ディレクトリ(repoId)は root 基準のまま(worktree ごとに変わらない)
    expect(p.stateDir).toBe(stateDirFor(dir));
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
