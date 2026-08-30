import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultWorktreeDir } from "../config.ts";
import { branchNameFor, worktreePathFor } from "../worktree.ts";

// この hook 自身の入力検証(name のバリデーション)と、config 解決・worktree 作成・パス出力の
// グルーだけを検証する。worktree 作成そのものの詳細な挙動(冪等性・branch 分岐など)は
// lib/worktree.test.ts 側の createWorktree のテストで既に担保済みのため重複しない。
const SCRIPT = path.join(import.meta.dirname, "worktree-create.ts");
const SHARED_DIR_NAME = "shared-assets";

/**
 * dir に git リポジトリを初期化する。
 * core.hooksPath を空ディレクトリに向け、グローバルの commit-msg フックから隔離する
 * (worktree.test.ts / stop-check.test.ts のフィクスチャと同じ手法)。
 */
function initRepo(dir: string, hooksDir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
}

interface RunOpts {
  cwd: string;
  input: Record<string, unknown>;
  /** 未指定なら CLAUDE_PROJECT_DIR を env から明示的に取り除く(startDir フォールバックの検証用) */
  claudeProjectDir?: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(opts: RunOpts): RunResult {
  // 実行元セッションが CLAUDE_PROJECT_DIR を持っている可能性があるため、テストが明示的に制御する
  // (そのまま継承すると、テストが指定した対象リポジトリを黙って上書きしてしまう)。
  // CCLOOP_REPO は resolveRepoRoot 内で CLAUDE_PROJECT_DIR/cwd より優先されるため
  // (このテスト自身が ccloop の worktree セッションとして動いており、実行元 shell の
  // CCLOOP_REPO がリポジトリ本体を指したまま継承されてしまう)、常に取り除く。
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CCLOOP_REPO;
  if (opts.claudeProjectDir !== undefined) {
    env.CLAUDE_PROJECT_DIR = opts.claudeProjectDir;
  } else {
    delete env.CLAUDE_PROJECT_DIR;
  }
  const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", SCRIPT], {
    cwd: opts.cwd,
    input: JSON.stringify(opts.input),
    encoding: "utf8",
    env,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("worktree-create hook", () => {
  let repo: string;
  let hooksDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-wtc-repo-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-wtc-hooks-"));
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-wtc-worktrees-"));
    initRepo(repo, hooksDir);

    fs.mkdirSync(path.join(repo, SHARED_DIR_NAME));
    fs.writeFileSync(path.join(repo, SHARED_DIR_NAME, "marker.txt"), "x");

    // worktreeDir / linkPaths を明示指定し、既定値(state ディレクトリ配下)に頼らず
    // テストが生成物を確実に把握・削除できるようにする。
    // normalizeConfig は必須項目が揃っていない config を例外にするため、parallel 以外の
    // 必須項目もすべて満たした完全な config を書く
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agent", "config.json"),
      JSON.stringify({
        claudeCommand: "claude",
        model: "opus",
        permissionMode: "auto",
        maxRetries: 3,
        taskTimeoutMs: 2400000,
        maxTurns: 150,
        rateLimit: { backoffMs: 300000 },
        explore: { enabled: true, minIntervalMs: 3600000 },
        idlePollMs: 60000,
        parallel: { worktreeDir, linkPaths: [SHARED_DIR_NAME] },
      }),
    );
  });

  afterEach(() => {
    // worktree はリポジトリ本体の外(worktreeDir)にあるが、リポジトリごと消せば残骸は残らない
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  });

  describe("不正な name", () => {
    // "." "..": 許可文字(A-Za-z0-9._-)だけでも "." ".." は親ディレクトリへ解決されるため、
    // path traversal 対策として明示的に拒否する必要がある(正規表現の文字許可だけでは防げない)
    const cases: Array<[string, unknown]> = [
      ['"."', "."],
      ['".."', ".."],
      ['"..."', "..."],
      ['"../evil"', "../evil"],
      ['"a/b"', "a/b"],
      ['"a b"', "a b"],
      ["空文字", ""],
      ["数値 123", 123],
    ];

    it.each(cases)("name=%s は exit 1 で拒否され、worktreeDir 配下に何も作られない", (_label, name) => {
      const result = runHook({ cwd: repo, claudeProjectDir: repo, input: { name } });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("不正な worktree 名");
      expect(fs.readdirSync(worktreeDir)).toEqual([]);
    });

    it("name キー自体が無い場合も exit 1 で拒否され、worktreeDir 配下に何も作られない", () => {
      const result = runHook({ cwd: repo, claudeProjectDir: repo, input: {} });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("不正な worktree 名");
      expect(fs.readdirSync(worktreeDir)).toEqual([]);
    });
  });

  it("CLAUDE_PROJECT_DIR 経由で worktree を作成し、パス・ブランチ・共有パスの symlink が期待通りになる", () => {
    const result = runHook({ cwd: repo, claudeProjectDir: repo, input: { name: "T-001" } });

    expect(result.status).toBe(0);
    const wtPath = result.stdout.trim();
    expect(wtPath).toBe(worktreePathFor(worktreeDir, "T-001"));
    expect(fs.statSync(wtPath).isDirectory()).toBe(true);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath })
      .toString()
      .trim();
    expect(branch).toBe(branchNameFor("T-001"));

    const linked = path.join(wtPath, SHARED_DIR_NAME);
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(linked, "marker.txt"), "utf8")).toBe("x");
  });

  it("CLAUDE_PROJECT_DIR も input.cwd も無いと worktree/ブランチを作らずに exit 1 で失敗する(fail-closed)", () => {
    // 子プロセスの実行時 cwd は repo に固定しているが、これは spawnSync の cwd であって
    // 「対象リポジトリ」の指定ではない。process.cwd() へフォールバックしていた旧実装なら
    // ここでも repo に worktree を作れてしまっていたが、fail-closed 化により拒否されるはず。
    const result = runHook({ cwd: repo, input: { name: "T-004" } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLAUDE_PROJECT_DIR");
    expect(result.stderr).toContain("cwd");
    expect(fs.readdirSync(worktreeDir)).toEqual([]);
  });

  it("CLAUDE_PROJECT_DIR が無くても入力の cwd から起点を解決できる(startDir のフォールバック)", () => {
    const result = runHook({ cwd: repo, input: { name: "T-002", cwd: repo } });

    expect(result.status).toBe(0);
    const wtPath = result.stdout.trim();
    expect(wtPath).toBe(worktreePathFor(worktreeDir, "T-002"));
    expect(fs.statSync(wtPath).isDirectory()).toBe(true);

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath })
      .toString()
      .trim();
    expect(branch).toBe(branchNameFor("T-002"));
  });

  it("同じ name で 2 回実行しても 2 回目も exit 0 で同じパスを返す(既存 worktree の再利用)", () => {
    const first = runHook({ cwd: repo, claudeProjectDir: repo, input: { name: "T-003" } });
    expect(first.status).toBe(0);

    const second = runHook({ cwd: repo, claudeProjectDir: repo, input: { name: "T-003" } });
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(first.stdout.trim());
  });

  it("`.agent/config.json` が無いとき、lib/config.ts の既定 worktreeDir(state ディレクトリ配下)を使う", () => {
    // hook は config.json 未設置時、Supervisor 本体と同じ config.ts の既定値解決
    // (defaultWorktreeDir: state ディレクトリ配下)にフォールバックする。ここが hook 側だけ
    // 独自の既定値を持ってしまうと、Supervisor と worktree の置き場が食い違って壊れる。
    fs.rmSync(path.join(repo, ".agent", "config.json"));
    const fallbackDir = defaultWorktreeDir(repo);

    try {
      const result = runHook({ cwd: repo, claudeProjectDir: repo, input: { name: "T-901" } });

      expect(result.status).toBe(0);
      const wtPath = result.stdout.trim();
      expect(wtPath).toBe(worktreePathFor(fallbackDir, "T-901"));
      expect(fs.statSync(wtPath).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});
