import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultWorktreeDir } from "./config.ts";
import {
  branchNameFor,
  createWorktree,
  deleteBranch,
  gitOperationInProgress,
  linkSharedPaths,
  listWorktrees,
  mergeInProgress,
  parkedBranchNameFor,
  parseWorktreeList,
  patchFileName,
  pruneWorktrees,
  removeWorktree,
  renameBranch,
  salvagePatch,
  worktreePathFor,
} from "./worktree.ts";

/**
 * dir に git リポジトリを初期化する。
 * core.hooksPath を空ディレクトリに向け、グローバルの commit-msg フックから隔離する
 * (supervisor.test.ts の commitAgentDir フィクスチャと同じ手法)。
 */
function initRepo(dir: string, hooksDir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

describe("純粋関数", () => {
  it("worktreePathFor: worktreeDir 配下の taskId パスを返す", () => {
    expect(worktreePathFor("/repo-worktrees", "T-001")).toBe(path.join("/repo-worktrees", "T-001"));
  });

  it("branchNameFor: agent/<taskId>", () => {
    expect(branchNameFor("T-001")).toBe("agent/T-001");
  });

  it("parkedBranchNameFor: agent/conflict/<taskId>-<UTC コンパクト時刻>", () => {
    const at = new Date("2026-08-16T10:21:05.000Z");
    expect(parkedBranchNameFor("T-001", at)).toBe("agent/conflict/T-001-20260816T102105Z");
  });

  it("patchFileName: <taskId>-<同じ時刻>.patch", () => {
    const at = new Date("2026-08-16T10:21:05.000Z");
    expect(patchFileName("T-001", at)).toBe("T-001-20260816T102105Z.patch");
  });

  it("parseWorktreeList: worktree/HEAD/branch/detached を含む複数レコードをパースする", () => {
    const porcelain =
      "worktree /repo\n" +
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
      "branch refs/heads/main\n" +
      "\n" +
      "worktree /repo-worktrees/T-001\n" +
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" +
      "branch refs/heads/agent/T-001\n" +
      "\n" +
      "worktree /repo-worktrees/T-002\n" +
      "HEAD cccccccccccccccccccccccccccccccccccccccc\n" +
      "detached\n" +
      "\n";

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/repo", head: "a".repeat(40), branch: "main" },
      { path: "/repo-worktrees/T-001", head: "b".repeat(40), branch: "agent/T-001" },
      { path: "/repo-worktrees/T-002", head: "c".repeat(40), branch: null },
    ]);
  });
});

describe("createWorktree", () => {
  let dir: string;
  let hooksDir: string;
  let wtRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-repo-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-hooks-"));
    wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-wt-"));
    initRepo(dir, hooksDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it("存在しないブランチなら HEAD から新規ブランチを作って worktree を作る", () => {
    const wtPath = worktreePathFor(wtRoot, "T-001");
    createWorktree(dir, wtPath, branchNameFor("T-001"));

    expect(fs.existsSync(wtPath)).toBe(true);
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: wtPath })
      .toString()
      .trim();
    expect(branch).toBe("agent/T-001");
  });

  it("冪等: 2 回目の呼び出しは何もしない", () => {
    const wtPath = worktreePathFor(wtRoot, "T-002");
    createWorktree(dir, wtPath, branchNameFor("T-002"));

    expect(() => createWorktree(dir, wtPath, branchNameFor("T-002"))).not.toThrow();

    const entries = listWorktrees(dir).filter((e) => e.path === wtPath);
    expect(entries).toHaveLength(1);
  });

  it("ブランチだけ既存で worktree ディレクトリが無ければ、既存ブランチをチェックアウトする", () => {
    execFileSync("git", ["branch", "feature-x"], { cwd: dir });
    const wtPath = path.join(wtRoot, "feature-x-wt");

    createWorktree(dir, wtPath, "feature-x");

    expect(fs.existsSync(wtPath)).toBe(true);
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: wtPath })
      .toString()
      .trim();
    expect(branch).toBe("feature-x");
  });
});

describe("linkSharedPaths", () => {
  let root: string;
  let wtPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-link-root-"));
    wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-link-wt-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wtPath, { recursive: true, force: true });
  });

  it("root 側に存在するパスを wtPath へシンボリックリンクする", () => {
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "marker.txt"), "x");

    linkSharedPaths(root, wtPath, ["node_modules"]);

    const linked = path.join(wtPath, "node_modules");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(linked, "marker.txt"), "utf8")).toBe("x");
  });

  it("root 側に無いパスはスキップする", () => {
    linkSharedPaths(root, wtPath, ["does-not-exist"]);
    expect(fs.existsSync(path.join(wtPath, "does-not-exist"))).toBe(false);
  });

  it("wtPath 側に既に存在するなら上書きしない", () => {
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.mkdirSync(path.join(wtPath, "node_modules"));
    fs.writeFileSync(path.join(wtPath, "node_modules", "own.txt"), "keep");

    linkSharedPaths(root, wtPath, ["node_modules"]);

    const linked = path.join(wtPath, "node_modules");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(linked, "own.txt"), "utf8")).toBe("keep");
  });
});

describe("removeWorktree", () => {
  let dir: string;
  let hooksDir: string;
  let wtRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-remove-repo-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-remove-hooks-"));
    wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-remove-wt-"));
    initRepo(dir, hooksDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it("worktree を削除し、一覧から消える", () => {
    const wtPath = worktreePathFor(wtRoot, "T-001");
    createWorktree(dir, wtPath, branchNameFor("T-001"));

    removeWorktree(dir, wtPath);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(listWorktrees(dir).some((e) => e.path === wtPath)).toBe(false);
  });

  it("ロックされた worktree も削除できる(Claude Code によるロックを想定)", () => {
    const wtPath = worktreePathFor(wtRoot, "T-002");
    createWorktree(dir, wtPath, branchNameFor("T-002"));
    execFileSync("git", ["worktree", "lock", wtPath], { cwd: dir });

    removeWorktree(dir, wtPath);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(listWorktrees(dir).some((e) => e.path === wtPath)).toBe(false);
  });
});

describe("mergeInProgress / gitOperationInProgress", () => {
  let dir: string;
  let hooksDir: string;
  let wtRoot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-merge-repo-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-merge-hooks-"));
    wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-merge-wt-"));
    initRepo(dir, hooksDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  });

  it("通常時は false", () => {
    expect(mergeInProgress(dir)).toBe(false);
    expect(gitOperationInProgress(dir)).toBe(false);
  });

  it("コンフリクトした merge の途中は true(通常の作業ツリー)", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add base"], { cwd: dir });
    execFileSync("git", ["branch", "side"], { cwd: dir });

    execFileSync("git", ["checkout", "side"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "conflict.txt"), "side change\n");
    execFileSync("git", ["commit", "-am", "side change"], { cwd: dir });

    execFileSync("git", ["checkout", "main"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "conflict.txt"), "main change\n");
    execFileSync("git", ["commit", "-am", "main change"], { cwd: dir });

    try {
      execFileSync("git", ["merge", "side"], { cwd: dir });
    } catch {
      // コンフリクトによる非ゼロ終了は想定通り
    }

    expect(mergeInProgress(dir)).toBe(true);
    expect(gitOperationInProgress(dir)).toBe(true);
  });

  it("linked worktree(.git がファイル)の中でも通常時は false、コンフリクト中は true", () => {
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    execFileSync("git", ["add", "conflict.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add base"], { cwd: dir });
    execFileSync("git", ["branch", "side2"], { cwd: dir });
    execFileSync("git", ["checkout", "side2"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "conflict.txt"), "side change\n");
    execFileSync("git", ["commit", "-am", "side change"], { cwd: dir });
    execFileSync("git", ["checkout", "main"], { cwd: dir });

    const wtPath = worktreePathFor(wtRoot, "T-003");
    createWorktree(dir, wtPath, "wtbranch");
    expect(fs.statSync(path.join(wtPath, ".git")).isFile()).toBe(true);

    expect(mergeInProgress(wtPath)).toBe(false);
    expect(gitOperationInProgress(wtPath)).toBe(false);

    fs.writeFileSync(path.join(wtPath, "conflict.txt"), "wt change\n");
    execFileSync("git", ["commit", "-am", "wt change"], { cwd: wtPath });

    try {
      execFileSync("git", ["merge", "side2"], { cwd: wtPath });
    } catch {
      // コンフリクトによる非ゼロ終了は想定通り
    }

    expect(mergeInProgress(wtPath)).toBe(true);
    expect(gitOperationInProgress(wtPath)).toBe(true);
  });
});

describe("deleteBranch / renameBranch / pruneWorktrees", () => {
  let dir: string;
  let hooksDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-branch-repo-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-branch-hooks-"));
    initRepo(dir, hooksDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it("deleteBranch: 削除できれば true、失敗すれば例外を投げず false", () => {
    execFileSync("git", ["branch", "throwaway"], { cwd: dir });
    expect(deleteBranch(dir, "throwaway")).toBe(true);
    expect(deleteBranch(dir, "throwaway")).toBe(false);
  });

  it("renameBranch: ブランチ名を変更する", () => {
    execFileSync("git", ["branch", "old-name"], { cwd: dir });
    renameBranch(dir, "old-name", "new-name");
    const branches = execFileSync("git", ["branch", "--list"], { cwd: dir }).toString();
    expect(branches).toContain("new-name");
    expect(branches).not.toContain("old-name");
  });

  it("pruneWorktrees: エラーなく実行できる", () => {
    expect(() => pruneWorktrees(dir)).not.toThrow();
  });
});

describe("salvagePatch", () => {
  let dir: string;
  let hooksDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-salvage-repo-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-salvage-hooks-"));
    initRepo(dir, hooksDir);
    fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add tracked"], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it("追跡ファイルの変更・未追跡ファイル・.agent 配下の変更が混在するとき、.agent を除外したパッチを書き出す", () => {
    fs.appendFileSync(path.join(dir, "tracked.txt"), "changed\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "new file\n");
    fs.mkdirSync(path.join(dir, ".agent"));
    fs.writeFileSync(path.join(dir, ".agent", "inside.md"), "internal\n");

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-salvage-out-"));
    const outFile = path.join(outDir, "T-001-20260816T102105Z.patch");

    try {
      const paths = salvagePatch(dir, outFile);

      expect(paths).toEqual(["new.txt", "tracked.txt"]);
      expect(fs.existsSync(outFile)).toBe(true);
      const patchText = fs.readFileSync(outFile, "utf8");
      expect(patchText).not.toContain(".agent/");

      // 素の HEAD 状態のクローンにパッチが適用できることを確認する
      const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-salvage-clone-"));
      try {
        execFileSync("git", ["clone", "--quiet", dir, cloneDir]);
        expect(() =>
          execFileSync("git", ["apply", "--check", outFile], { cwd: cloneDir }),
        ).not.toThrow();
      } finally {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("差分が無ければ null を返し、outFile を作らない", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-salvage-empty-"));
    const outFile = path.join(outDir, "unused.patch");

    try {
      const result = salvagePatch(dir, outFile);
      expect(result).toBeNull();
      expect(fs.existsSync(outFile)).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("worktree-create hook (lib/hooks/worktree-create.ts)", () => {
  let dir: string;
  let hooksDir: string;
  let worktreesDir: string;

  const scriptPath = path.join(import.meta.dirname, "hooks", "worktree-create.ts");

  // hook は CLAUDE_PROJECT_DIR を最優先で見る。テストは stdin の cwd で対象を指定するため、
  // 実行環境から継承した値がテスト対象のリポジトリを上書きしないよう取り除く
  function runHook(input: object): { stdout: string; status: number } {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CCLOOP_REPO;
    try {
      const stdout = execFileSync("node", [scriptPath], {
        input: JSON.stringify(input),
        cwd: dir,
        encoding: "utf8",
        env,
      });
      return { stdout, status: 0 };
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-create-test-repo-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-create-test-hooks-"));
    initRepo(dir, hooksDir);
    // hook は Supervisor と同じ config.ts の既定値(state ディレクトリ配下)を使う
    worktreesDir = defaultWorktreeDir(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  });

  it("worktree を作成し、そのパスを標準出力へ返す", () => {
    const result = runHook({ name: "T-001", cwd: dir });

    expect(result.status).toBe(0);
    const wtPath = result.stdout.trim();
    expect(wtPath).toBe(path.join(worktreesDir, "T-001"));
    expect(fs.existsSync(wtPath)).toBe(true);
    const branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: wtPath })
      .toString()
      .trim();
    expect(branch).toBe("agent/T-001");
  });

  it("同名 worktree は再作成せず既存パスを返す(冪等・コンフリクト解決の継続で使う)", () => {
    const first = runHook({ name: "T-002", cwd: dir });
    expect(first.status).toBe(0);

    const second = runHook({ name: "T-002", cwd: dir });

    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(first.stdout.trim());
  });

  it("不正な name(パストラバーサル等)は拒否される", () => {
    const result = runHook({ name: "../../etc", cwd: dir });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(worktreesDir)).toBe(false);
  });

  it("許可文字のみでも '.' '..' 単体は拒否される(親ディレクトリへの解決を防ぐ)", () => {
    for (const name of [".", ".."]) {
      const result = runHook({ name, cwd: dir });
      expect(result.status).not.toBe(0);
    }
    expect(fs.existsSync(worktreesDir)).toBe(false);
  });

  it("root に node_modules があれば worktree へシンボリックリンクする", () => {
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "marker.txt"), "x");

    const result = runHook({ name: "T-003", cwd: dir });

    expect(result.status).toBe(0);
    const wtPath = result.stdout.trim();
    const linked = path.join(wtPath, "node_modules");
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(linked, "marker.txt"), "utf8")).toBe("x");
  });
});
