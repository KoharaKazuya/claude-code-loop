/**
 * `git merge --abort` の racy-git 起因の失敗が再試行で解消することを検証する回帰テスト。
 *
 * 実 git では racy 状態(index 書き込みと後続の stat が同一秒になり stat 情報が信用され
 * ない状態)を決定的に再現できないため、node:child_process の execFileSync をモックし、
 * 最初の `git merge --abort` 呼び出しだけ `not uptodate` エラーを注入する。それ以外の
 * すべての git コマンド(2 回目以降の `merge --abort` を含む)は本物の execFileSync へ
 * 委譲する。vi.mock はファイル単位で効くため、他のテストに影響しないようこのファイルへ
 * 隔離している(lib/merge.test.ts には入れない)。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 「1 回目の merge --abort だけ racy-git エラーで失敗させる」を制御するフラグ。
 * vi.mock はファイル先頭へ巻き上げられるため vi.hoisted で先に用意する必要がある
 * (lib/supervisor.test.ts の spawn モックと同じパターン)。
 */
const abortControl = vi.hoisted(() => ({ failuresRemaining: 0, abortCallCount: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const [file, cmdArgs] = args;
      const isAbort = file === "git" && Array.isArray(cmdArgs) && cmdArgs[0] === "merge" && cmdArgs[1] === "--abort";
      if (isAbort) {
        abortControl.abortCallCount++;
        if (abortControl.failuresRemaining > 0) {
          abortControl.failuresRemaining--;
          const err = new Error("Command failed: git merge --abort") as Error & { stderr?: Buffer };
          err.stderr = Buffer.from("error: Entry 'x' not uptodate. Cannot merge.\n");
          throw err;
        }
      }
      return actual.execFileSync(...args);
    },
  };
});

// vi.mock はモジュール解決時に巻き上げられるため、この import は上のモック定義より後に
// 書いても(書いても書かなくても)モック済みの node:child_process 経由で動作する。
import { abortMerge, resolveMechanically } from "./merge.ts";
import { execFileSync } from "node:child_process";

const TRAILER = "Agent-Auto: merge-abort-retry-test";

describe("abortMerge / resolveMechanically(abort 再試行)", () => {
  let dir: string;
  let hooksDir: string;

  function git(args: string[], cwd: string = dir): string {
    return execFileSync("git", args, { cwd }).toString();
  }

  function writeFile(relPath: string, content: string, cwd: string = dir): void {
    const abs = path.join(cwd, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function commitAll(message: string): void {
    git(["add", "-A"]);
    git(["commit", "-m", message]);
  }

  /** main と agent/<taskId> の両方が f.txt を別々に書き換える、substantive コンフリクトを作る */
  function makeSubstantiveConflict(taskId: string): void {
    writeFile("f.txt", "base\n");
    commitAll("init: 基点ファイルを追加する");
    git(["branch", `agent/${taskId}`]);

    writeFile("f.txt", "main version\n");
    commitAll("fix: main 側の変更");

    git(["checkout", `agent/${taskId}`]);
    writeFile("f.txt", "branch version\n");
    commitAll("fix: branch 側の変更");
    git(["checkout", "main"]);

    expect(() => git(["merge", `agent/${taskId}`, "-m", "merge"])).toThrow();
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-abort-retry-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-abort-retry-hooks-"));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-m", "init"]);
    abortControl.failuresRemaining = 0;
    abortControl.abortCallCount = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it(
    "racy-git による 1 回目の abort 失敗は既定ポリシーの再試行で解消し、resolveMechanically は wedged ではなく conflict を返す",
    () => {
      const taskId = "T-abort-retry-e2e";
      makeSubstantiveConflict(taskId);
      abortControl.failuresRemaining = 1;

      const outcome = resolveMechanically(dir, `agent/${taskId}`, taskId, "abort 再試行のテスト", TRAILER);

      expect(outcome.result).toBe("conflict");
      // abort が最終的に成功しているので MERGE_HEAD は残っていない
      expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
      // 1 回目の失敗 + 2 回目の成功で、merge --abort は 2 回呼ばれている
      expect(abortControl.abortCallCount).toBe(2);
    },
    10_000,
  );

  it("abortMerge を短いポリシーで直接呼ぶと、1 回目の racy-git 失敗後すぐ再試行して成功する", () => {
    const taskId = "T-abort-retry-direct";
    makeSubstantiveConflict(taskId);
    abortControl.failuresRemaining = 1;

    const result = abortMerge(dir, { attempts: 3, delayMs: 1 });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(abortControl.abortCallCount).toBe(2);
  });
});
