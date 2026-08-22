import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "stop-check.ts");

/**
 * dir に git リポジトリを初期化する(branch は呼び出し側が指定)。
 * core.hooksPath を空ディレクトリに向け、グローバルの commit-msg フックから隔離する
 * (worktree.test.ts のフィクスチャと同じ手法)。
 */
function initRepo(dir: string, branch: string, hooksDir: string): void {
  execFileSync("git", ["init", "-b", branch], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  fs.mkdirSync(path.join(dir, ".agent", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agent", "tasks", "T-001.md"), "status: ready\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

interface RunResult {
  status: number | null;
  stderr: string;
}

function runStopCheck(opts: {
  cwd: string;
  ccloopRepo: string;
  taskId?: string;
  input?: Record<string, unknown>;
}): RunResult {
  const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", SCRIPT], {
    cwd: opts.cwd,
    input: JSON.stringify({ cwd: opts.cwd, ...opts.input }),
    encoding: "utf8",
    env: {
      ...process.env,
      CCLOOP_REPO: opts.ccloopRepo,
      CLAUDE_AGENT_TASK_ID: opts.taskId ?? "T-001",
    },
  });
  return { status: res.status, stderr: res.stderr };
}

describe("stop-check hook", () => {
  let main: string;
  let worktree: string;
  let hooksDir: string;

  beforeEach(() => {
    main = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-stop-check-main-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-stop-check-hooks-"));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-stop-check-wt-"));
    fs.rmdirSync(worktree); // git worktree add はパスが存在しないことを要求する
  });

  afterEach(() => {
    fs.rmSync(main, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("既定ブランチが master のリポジトリでも、タスクファイル未変更なら exit 2 でブロックする", () => {
    // 修正前は `git merge-base HEAD main` を決め打ちしており、master しか無いリポジトリでは
    // merge-base が求まらず fail-open(exit 0)していた。これがこの hook の存在意義そのものを
    // 無効化するバグであり、ここで再発を防ぐ。
    initRepo(main, "master", hooksDir);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-001", worktree, "master"], { cwd: main });

    const result = runStopCheck({ cwd: worktree, ccloopRepo: main });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(".agent/tasks/T-001.md");
  });

  it("既定ブランチが master でも、タスクファイルをコミット済みなら exit 0 で終了を許可する", () => {
    initRepo(main, "master", hooksDir);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-001", worktree, "master"], { cwd: main });
    fs.writeFileSync(path.join(worktree, ".agent", "tasks", "T-001.md"), "status: completed\n");
    execFileSync("git", ["commit", "-am", "update task"], { cwd: worktree });

    const result = runStopCheck({ cwd: worktree, ccloopRepo: main });

    expect(result.status).toBe(0);
  });

  it("タスクファイルに未コミットの変更があれば exit 0 で終了を許可する", () => {
    initRepo(main, "master", hooksDir);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-001", worktree, "master"], { cwd: main });
    fs.writeFileSync(path.join(worktree, ".agent", "tasks", "T-001.md"), "status: completed\n");

    const result = runStopCheck({ cwd: worktree, ccloopRepo: main });

    expect(result.status).toBe(0);
  });

  it("main ブランチのリポジトリでも従来どおり機能する", () => {
    initRepo(main, "main", hooksDir);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-001", worktree, "main"], { cwd: main });

    const result = runStopCheck({ cwd: worktree, ccloopRepo: main });

    expect(result.status).toBe(2);
  });

  it("CCLOOP_REPO が不正なパスでも upstream フォールバック経由で判定を試みる(それも無ければ fail-open)", () => {
    initRepo(main, "master", hooksDir);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-001", worktree, "master"], { cwd: main });

    const result = runStopCheck({ cwd: worktree, ccloopRepo: path.join(os.tmpdir(), "does-not-exist-xyz") });

    // upstream も無いため fail-open(exit 0)。stderr に理由が出る。
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("失敗したため終了を許可する");
  });

  it("stop_hook_active が true なら判定せず exit 0", () => {
    initRepo(main, "master", hooksDir);
    execFileSync("git", ["worktree", "add", "-b", "agent/T-001", worktree, "master"], { cwd: main });

    const result = runStopCheck({ cwd: worktree, ccloopRepo: main, input: { stop_hook_active: true } });

    expect(result.status).toBe(0);
  });
});
