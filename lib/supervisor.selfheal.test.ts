import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selfHealGitOperationInProgress } from "./supervisor.ts";
import { branchNameFor, mergeInProgress } from "./worktree.ts";

/**
 * mainLoop 巡回中の自己修復パス(selfHealGitOperationInProgress)の回帰テスト。
 * 本番インシデントの再現手法(post-index-change フックによる作業ツリーの外部改変で
 * `merge --abort` を "not uptodate" で失敗させる)は lib/supervisor.test.ts の
 * recoverStartupIn 「M:」テストと同根。ここでは selfHealGitOperationInProgress 単体の
 * 再試行・打ち切り挙動を直接検証する。
 */
describe("selfHealGitOperationInProgress", () => {
  let dir: string;
  let hooksDir: string;

  function git(args: string[]): string {
    return execFileSync("git", args, { cwd: dir }).toString();
  }

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-selfheal-")));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-selfheal-hooks-"));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "base\n");
    fs.writeFileSync(path.join(dir, "extra.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  /** conflict.txt を main とブランチの双方で書き換えて実質コンフリクトを作る準備。ブランチを
   *  作って分岐コミットを積み、main 側にも別コミットを積んで main へ checkout し戻した状態で
   *  終わる(まだ merge は実行しない)。extra.txt はブランチ側だけが書き換えるため衝突なく
   *  自動マージされる(post-index-change フックのタンパー対象に使う)。 */
  function prepareConflictingBranch(branch: string): void {
    git(["checkout", "-b", branch]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "ブランチ側\n");
    fs.writeFileSync(path.join(dir, "extra.txt"), "ブランチ側の更新\n");
    git(["add", "-A"]);
    git(["commit", "-m", "ブランチ側で書き換える"]);
    git(["checkout", "main"]);
    fs.writeFileSync(path.join(dir, "conflict.txt"), "main 側\n");
    git(["commit", "-am", "main 側で書き換える"]);
  }

  /** 準備済みのブランチを main 上で `git merge` し、実質コンフリクトで MERGE_HEAD を残す。 */
  function mergeExpectingConflict(branch: string): void {
    try {
      git(["merge", branch]);
    } catch {
      // 実質コンフリクトによる非ゼロ終了は想定通り
    }
  }

  it("abort が not uptodate で失敗し続ける場合、再試行しても false を返し、マージは進行中のまま残る", async () => {
    const branch = branchNameFor("T-901");
    prepareConflictingBranch(branch);

    // フックは merge 実行の直前にだけ設置する(先に設置すると準備段階の add/commit にも
    // 反応してしまい、コミット内容自体が意図とずれてしまうため)。
    // extra.txt はフックが作業ツリー上だけで書き換える。index が保持する自動マージ後の内容と
    // 恒久的に食い違うため、`merge --abort` は(retry を重ねても)常に not uptodate で失敗する。
    fs.writeFileSync(
      path.join(hooksDir, "post-index-change"),
      `#!/bin/sh\nif [ "$(pwd)" = "${dir}" ]; then printf 'external tamper\\n' > "${path.join(dir, "extra.txt")}"; fi\n`,
    );
    fs.chmodSync(path.join(hooksDir, "post-index-change"), 0o755);

    mergeExpectingConflict(branch);
    expect(mergeInProgress(dir)).toBe(true);

    const ok = await selfHealGitOperationInProgress(dir, { attempts: 2, delayMs: 1 });

    expect(ok).toBe(false);
    expect(mergeInProgress(dir)).toBe(true);
    // 作業ツリーはフックが書いた内容のまま(自己修復側が上書き・削除していない)
    expect(fs.readFileSync(path.join(dir, "extra.txt"), "utf8")).toBe("external tamper\n");
  });

  it("MERGE_HEAD が agent/* ブランチ由来でない(人間のマージ途中)場合、再試行せず即座に false を返す", async () => {
    // agent/* でない通常ブランチとの実マージでコンフリクトさせる(フックは設置しない)
    prepareConflictingBranch("human-fix");
    mergeExpectingConflict("human-fix");
    expect(mergeInProgress(dir)).toBe(true);
    const mergeHeadBefore = git(["rev-parse", "MERGE_HEAD"]).trim();
    const headBefore = git(["rev-parse", "HEAD"]).trim();

    const before = Date.now();
    const ok = await selfHealGitOperationInProgress(dir, { attempts: 5, delayMs: 1000 });
    const elapsedMs = Date.now() - before;

    expect(ok).toBe(false);
    // 再試行(delayMs=1000 を最大 4 回分)していれば数秒かかるはずなので、十分小さい値で
    // 「待たずに即座に諦めた」ことを検証する
    expect(elapsedMs).toBeLessThan(500);
    // マージ状態には一切触れていない(MERGE_HEAD・HEAD ともに変化なし)
    expect(mergeInProgress(dir)).toBe(true);
    expect(git(["rev-parse", "MERGE_HEAD"]).trim()).toBe(mergeHeadBefore);
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  });

  it("agent/* ブランチ由来のマージが進行中で abort が成功する場合、true を返し MERGE_HEAD が消える", async () => {
    const branch = branchNameFor("T-902");
    // フックを設置しないので、abort は素直に成功する
    prepareConflictingBranch(branch);
    mergeExpectingConflict(branch);
    expect(mergeInProgress(dir)).toBe(true);

    const ok = await selfHealGitOperationInProgress(dir, { attempts: 2, delayMs: 1 });

    expect(ok).toBe(true);
    expect(mergeInProgress(dir)).toBe(false);
  });
});
