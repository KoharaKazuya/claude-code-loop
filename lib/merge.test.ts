import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyConflicts,
  collectUsedIds,
  mergeAgentBranch,
  mergeCommitMessage,
  parseUnmergedStages,
  planIdRenumber,
  preResolveIdCollisions,
  resolveMechanically,
  rewriteIdReferences,
} from "./merge.ts";

const TRAILER = "Agent-Auto: merge-test";

// ---------- 純粋関数 ----------

describe("parseUnmergedStages", () => {
  it("パスごとに出現した stage を集合として畳み込む", () => {
    const out =
      "100644 aaa 2\tfile1.md\0" +
      "100644 bbb 3\tfile1.md\0" +
      "100644 ccc 1\tfile2.md\0" +
      "100644 ddd 2\tfile2.md\0" +
      "100644 eee 3\tfile2.md\0";
    const result = parseUnmergedStages(out);
    expect(result).toEqual(
      new Map([
        ["file1.md", new Set([2, 3])],
        ["file2.md", new Set([1, 2, 3])],
      ]),
    );
  });

  it("空文字列は空の Map になる", () => {
    expect(parseUnmergedStages("")).toEqual(new Map());
  });
});

describe("classifyConflicts", () => {
  const TASK_ID = "T-042";

  it("decisions/human-review 直下・stage {2,3}・ID 形式ならすべて idCollisions", () => {
    const stages = new Map([
      [".agent/decisions/D-20260816-08.md", new Set([2, 3])],
      [".agent/human-review/HR-20260816-03.md", new Set([2, 3])],
    ]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      idCollisions: [".agent/decisions/D-20260816-08.md", ".agent/human-review/HR-20260816-03.md"],
      ownTaskFile: null,
    });
  });

  it("ID 採番衝突と対象外ディレクトリ(src/)が混在すれば partial(idCollisions と substantivePaths を分離)", () => {
    const stages = new Map([
      [".agent/decisions/D-20260816-08.md", new Set([2, 3])],
      ["src/a.ts", new Set([2, 3])],
    ]);
    const result = classifyConflicts(stages, TASK_ID);
    expect(result).toEqual({
      kind: "partial",
      idCollisions: [".agent/decisions/D-20260816-08.md"],
      substantivePaths: ["src/a.ts"],
    });
  });

  it("ID 採番衝突・own-task-file・src が混在すれば partial(substantivePaths に own-task-file と src の両方が入る)", () => {
    const stages = new Map([
      [".agent/decisions/D-20260816-08.md", new Set([2, 3])],
      [`.agent/tasks/${TASK_ID}.md`, new Set([2, 3])],
      ["src/a.ts", new Set([2, 3])],
    ]);
    const result = classifyConflicts(stages, TASK_ID);
    expect(result).toEqual({
      kind: "partial",
      idCollisions: [".agent/decisions/D-20260816-08.md"],
      substantivePaths: [`.agent/tasks/${TASK_ID}.md`, "src/a.ts"],
    });
  });

  it("decisions が stage {1,2,3}(modify/modify)なら substantive", () => {
    const stages = new Map([[".agent/decisions/D-20260816-08.md", new Set([1, 2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID).kind).toBe("substantive");
  });

  it("id-collision 条件を満たすパスと満たさないパスが混在すれば idCollisions 側だけ切り出した partial になる", () => {
    const stages = new Map([
      [".agent/decisions/D-20260816-08.md", new Set([2, 3])],
      [".agent/decisions/sub/D-20260816-09.md", new Set([2, 3])], // 直下ではない
    ]);
    const result = classifyConflicts(stages, TASK_ID);
    expect(result).toEqual({
      kind: "partial",
      idCollisions: [".agent/decisions/D-20260816-08.md"],
      substantivePaths: [".agent/decisions/sub/D-20260816-09.md"],
    });
  });

  it("マージ中タスク自身の .agent/tasks/<taskId>.md が add/add(stage {2,3})なら ownTaskFile として mechanical", () => {
    const stages = new Map([[`.agent/tasks/${TASK_ID}.md`, new Set([2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      idCollisions: [],
      ownTaskFile: `.agent/tasks/${TASK_ID}.md`,
    });
  });

  it("マージ中タスク自身の .agent/tasks/<taskId>.md が modify/modify(stage {1,2,3})でも ownTaskFile として mechanical", () => {
    const stages = new Map([[`.agent/tasks/${TASK_ID}.md`, new Set([1, 2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      idCollisions: [],
      ownTaskFile: `.agent/tasks/${TASK_ID}.md`,
    });
  });

  it("idCollisions と ownTaskFile が両方あれば両方まとめて mechanical", () => {
    const stages = new Map([
      [".agent/decisions/D-20260816-08.md", new Set([2, 3])],
      [`.agent/tasks/${TASK_ID}.md`, new Set([1, 2, 3])],
    ]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      idCollisions: [".agent/decisions/D-20260816-08.md"],
      ownTaskFile: `.agent/tasks/${TASK_ID}.md`,
    });
  });

  it("別タスクのタスクファイル(.agent/tasks/T-999.md)が衝突すれば substantive", () => {
    const stages = new Map([[".agent/tasks/T-999.md", new Set([2, 3])]]);
    const result = classifyConflicts(stages, TASK_ID);
    if (result.kind !== "substantive") throw new Error("unreachable");
    expect(result.paths).toEqual([".agent/tasks/T-999.md"]);
  });

  it("own-task-file と src ファイルが混在すれば substantive", () => {
    const stages = new Map([
      [`.agent/tasks/${TASK_ID}.md`, new Set([2, 3])],
      ["src/a.ts", new Set([2, 3])],
    ]);
    const result = classifyConflicts(stages, TASK_ID);
    if (result.kind !== "substantive") throw new Error("unreachable");
    expect(result.paths).toHaveLength(2);
  });
});

describe("planIdRenumber", () => {
  it("単一の衝突を used の最大値 + 1 へ振る", () => {
    const renames = planIdRenumber(["D-20260816-07", "D-20260816-08"], ["D-20260816-08"]);
    expect(renames).toEqual(new Map([["D-20260816-08", "D-20260816-09"]]));
  });

  it("同一グループ内の複数衝突は昇順に連番を割り当てる", () => {
    const renames = planIdRenumber(["D-20260816-01"], ["D-20260816-05", "D-20260816-03"]);
    expect(renames).toEqual(
      new Map([
        ["D-20260816-03", "D-20260816-02"],
        ["D-20260816-05", "D-20260816-03"],
      ]),
    );
  });

  it("D と HR は別グループとして独立に採番する", () => {
    const renames = planIdRenumber(
      ["D-20260816-01", "HR-20260816-09"],
      ["D-20260816-05", "HR-20260816-05"],
    );
    expect(renames).toEqual(
      new Map([
        ["D-20260816-05", "D-20260816-02"],
        ["HR-20260816-05", "HR-20260816-10"],
      ]),
    );
  });

  it("ゼロ埋め桁数を維持し、繰り上がる場合は自然に桁が増える", () => {
    const normal = planIdRenumber(["D-20260816-07", "D-20260816-08"], ["D-20260816-08"]);
    expect(normal.get("D-20260816-08")).toBe("D-20260816-09");

    const overflow = planIdRenumber(["D-20260816-99"], ["D-20260816-99"]);
    expect(overflow.get("D-20260816-99")).toBe("D-20260816-100");
  });

  it("ID 形式に合わない collidingIds があれば空の Map を返す", () => {
    expect(planIdRenumber(["D-20260816-07"], ["D-bad-id"])).toEqual(new Map());
  });

  it("usedIds に ID 形式でないものが混ざっていても無視して続行する(.gitkeep 等が collectUsedIds 経由で混入しても振り直しが機能し続けることの回帰確認)", () => {
    const renames = planIdRenumber(
      [".gitkeep", "not-an-id", "D-20260816-07", "D-20260816-08"],
      ["D-20260816-08"],
    );
    expect(renames).toEqual(new Map([["D-20260816-08", "D-20260816-09"]]));
  });
});

describe("rewriteIdReferences", () => {
  it("前後を英数字・ハイフンで区切られていない ID だけを置換する(部分一致を避ける)", () => {
    const text = "D-20260816-1 and D-20260816-10 and XD-20260816-1";
    const renames = new Map([["D-20260816-1", "D-20260816-99"]]);
    expect(rewriteIdReferences(text, renames)).toBe("D-20260816-99 and D-20260816-10 and XD-20260816-1");
  });

  it("複数の renames を 1 回の走査で同時に置換する(連鎖置換を起こさない)", () => {
    const text = "D-20260816-1 D-20260816-2";
    const renames = new Map([
      ["D-20260816-1", "D-20260816-2"],
      ["D-20260816-2", "D-20260816-3"],
    ]);
    // D-20260816-1 は D-20260816-2 になるが、その結果が更に D-20260816-3 へ
    // 連鎖して置換されてはいけない
    expect(rewriteIdReferences(text, renames)).toBe("D-20260816-2 D-20260816-3");
  });

  it("frontmatter 風の `review: HR-...` 行でも置換できる", () => {
    const text = "---\nreview: HR-20260816-05\nstatus: open\n---\n";
    const renames = new Map([["HR-20260816-05", "HR-20260816-06"]]);
    expect(rewriteIdReferences(text, renames)).toBe("---\nreview: HR-20260816-06\nstatus: open\n---\n");
  });

  it("インライン配列 `[D-..., D-...]` 内でも置換できる", () => {
    const text = "related: [D-20260816-01, D-20260816-02]";
    const renames = new Map([["D-20260816-01", "D-20260816-03"]]);
    expect(rewriteIdReferences(text, renames)).toBe("related: [D-20260816-03, D-20260816-02]");
  });

  it("renames が空なら text をそのまま返す", () => {
    expect(rewriteIdReferences("D-20260816-01", new Map())).toBe("D-20260816-01");
  });
});

describe("mergeCommitMessage", () => {
  it("通常時は subject にタスク情報を含め、末尾に trailer を付ける", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER);
    const lines = message.split("\n");
    expect(lines[0]).toBe("Merge branch 'agent/T-001' (T-001 タイトル)");
    expect(message.endsWith(`\n\n${TRAILER}`)).toBe(true);
  });

  it("subject が長すぎる場合は定型 subject へフォールバックする", () => {
    const longTitle = "非常に長いタイトル".repeat(10);
    const message = mergeCommitMessage("agent/T-001", "T-001", longTitle, TRAILER);
    expect(message.split("\n")[0]).toBe("Merge branch 'agent/T-001'");
  });

  it("title に制御文字が混ざる場合は定型 subject へフォールバックする", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "改行\n混入", TRAILER);
    expect(message.split("\n")[0]).toBe("Merge branch 'agent/T-001'");
  });

  it("renames があれば本文に改番の記録を 1 行ずつ入れる", () => {
    const renames = new Map([
      ["D-20260816-08", "D-20260816-09"],
      ["HR-20260816-03", "HR-20260816-04"],
    ]);
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, renames);
    expect(message).toBe(
      "Merge branch 'agent/T-001' (T-001 タイトル)\n\n" +
        "D-20260816-08 -> D-20260816-09\nHR-20260816-03 -> HR-20260816-04\n\n" +
        TRAILER,
    );
  });

  it("Merge で始まる subject は commit-msg フックの Conventional Commits 検査対象外になる形式である", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER);
    expect(message.split("\n")[0]).toMatch(/^Merge /);
  });
});

// ---------- mergeAgentBranch(git 実リポジトリを使った結合テスト) ----------

describe("mergeAgentBranch", () => {
  let dir: string;
  let hooksDir: string;

  function git(args: string[], cwd: string = dir): string {
    return execFileSync("git", args, { cwd }).toString();
  }

  function headHash(): string {
    return git(["rev-parse", "HEAD"]).trim();
  }

  function writeFile(relPath: string, content: string): void {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function commitAll(message: string): void {
    git(["add", "-A"]);
    git(["commit", "-m", message]);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-"));
    // core.hooksPath を空ディレクトリに向け、グローバルの commit-msg フックから隔離する
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-hooks-"));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it("branch に新規コミットがあれば --no-ff でマージし、マージコミットに trailer が付く", () => {
    git(["branch", "agent/T-001"]);
    git(["checkout", "agent/T-001"]);
    writeFile("src/a.ts", "export const a = 1;\n");
    commitAll("feat: a を追加する");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-001", "T-001", "a を追加する", TRAILER);

    expect(outcome).toEqual({ result: "merged" });
    const subject = git(["log", "-1", "--pretty=%s"]).trim();
    expect(subject).toBe("Merge branch 'agent/T-001' (T-001 a を追加する)");
    const message = git(["log", "-1", "--pretty=%B"]);
    expect(message).toContain(TRAILER);
    const parents = git(["log", "-1", "--pretty=%P"]).trim().split(" ");
    expect(parents).toHaveLength(2);
  });

  it("branch が main の tip と同じなら nothing-to-merge で HEAD は変わらない", () => {
    git(["branch", "agent/T-empty"]);
    const before = headHash();

    const outcome = mergeAgentBranch(dir, "agent/T-empty", "T-empty", "空タスク", TRAILER);

    expect(outcome).toEqual({ result: "nothing-to-merge" });
    expect(headHash()).toBe(before);
  });

  it("id-collision: 衝突した ID を振り直して解決コミットを作る", () => {
    const decisionsDir = ".agent/decisions";
    writeFile(`${decisionsDir}/D-20260816-07.md`, "既存の判断記録\n");
    commitAll("docs(agent): D-20260816-07 を追加する");

    // branch を base(このコミット)から分岐させる
    git(["branch", "agent/T-100"]);

    // main 側は D-20260816-08 を追加する
    writeFile(`${decisionsDir}/D-20260816-08.md`, "main content X\n");
    commitAll("docs(agent): D-20260816-08 を追加する");

    // branch 側は独立に、内容の異なる D-20260816-08 と、それを参照するタスクファイルを追加する
    git(["checkout", "agent/T-100"]);
    writeFile(`${decisionsDir}/D-20260816-08.md`, "branch content Y\n");
    writeFile(".agent/tasks/T-100.md", "参照: D-20260816-08 を踏まえて実装した\n");
    commitAll("docs(agent): D-20260816-08 を追加する(branch 側)");
    git(["checkout", "main"]);

    // 解決コミット(git commit -F -)は pre-commit フックを通る。GIT_HOOKS_IGNORE_DETECT_TODO
    // が正しく渡っていることを確認するため、それが無ければ失敗する pre-commit フックに
    // 差し替えてから実行する(渡っていなければ例外を捕捉して "conflict" を返してしまい、
    // 以下の "renumbered" 期待値が満たされずテストが落ちる)
    const strictPreCommit = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(strictPreCommit, '#!/bin/sh\n[ -n "$GIT_HOOKS_IGNORE_DETECT_TODO" ] || exit 1\n');
    fs.chmodSync(strictPreCommit, 0o755);

    const outcome = mergeAgentBranch(dir, "agent/T-100", "T-100", "D-20260816-08 を解決する", TRAILER);

    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    expect(outcome.renames).toEqual(new Map([["D-20260816-08", "D-20260816-09"]]));
    expect(outcome.resolvedTaskFile).toBe(false);

    // 旧パスは main の内容のまま
    expect(fs.readFileSync(path.join(dir, decisionsDir, "D-20260816-08.md"), "utf8")).toBe("main content X\n");
    // 新パスに branch の内容が入る
    expect(fs.readFileSync(path.join(dir, decisionsDir, "D-20260816-09.md"), "utf8")).toBe("branch content Y\n");
    // branch が追加した参照ファイルの ID 参照も書き換わっている
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-100.md"), "utf8")).toBe(
      "参照: D-20260816-09 を踏まえて実装した\n",
    );

    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");

    const message = git(["log", "-1", "--pretty=%B"]);
    expect(message).toContain("D-20260816-08 -> D-20260816-09");
    expect(message).toContain(TRAILER);
    expect(message.split("\n")[0]).toMatch(/^Merge branch 'agent\/T-100'/);
  });

  it("substantive: 同一ファイルの内容が対立する場合は conflict を返し abort する", () => {
    writeFile("src/a.ts", "original\n");
    commitAll("feat: a を追加する");
    git(["branch", "agent/T-fail"]);

    writeFile("src/a.ts", "main version\n");
    commitAll("fix: main 側の変更");

    git(["checkout", "agent/T-fail"]);
    writeFile("src/a.ts", "branch version\n");
    commitAll("fix: branch 側の変更");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-fail", "T-fail", "対立するタスク", TRAILER);

    expect(outcome).toEqual({ result: "conflict", paths: ["src/a.ts"], conflictKind: "substantive" });
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    // branch はそのまま残っている(呼び出し側が後で参照できる)
    expect(() => git(["rev-parse", "--verify", "agent/T-fail"])).not.toThrow();
  });

  it("blocked: ローカルの未コミット変更を上書きしてしまう場合はマージを開始せず blocked を返す", () => {
    writeFile("src/a.ts", "original\n");
    commitAll("feat: a を追加する");
    git(["branch", "agent/T-blocked"]);

    git(["checkout", "agent/T-blocked"]);
    writeFile("src/a.ts", "branch version\n");
    commitAll("fix: branch 側の変更");
    git(["checkout", "main"]);

    // main の作業ツリーに未コミットの変更を残す(マージで上書きされてしまう状態)
    writeFile("src/a.ts", "dirty local version (uncommitted)\n");

    const outcome = mergeAgentBranch(dir, "agent/T-blocked", "T-blocked", "ブロックされるタスク", TRAILER);

    expect(outcome.result).toBe("blocked");
    if (outcome.result !== "blocked") throw new Error("unreachable");
    expect(outcome.reason.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("回帰: .agent/decisions|human-review に .gitkeep が居ても id-collision の振り直しは機能する(本番インシデントの再現)", () => {
    const decisionsDir = ".agent/decisions";
    const hrDir = ".agent/human-review";
    writeFile(`${decisionsDir}/.gitkeep`, "");
    writeFile(`${hrDir}/.gitkeep`, "");
    commitAll("chore: decisions/human-review を空ディレクトリとして用意する");

    // branch を base(このコミット)から分岐させる
    git(["branch", "agent/T-19"]);

    // main 側は D-20260816-19 を追加する
    writeFile(`${decisionsDir}/D-20260816-19.md`, "main content\n");
    commitAll("docs(agent): D-20260816-19 を追加する");

    // branch 側は独立に、同じ ID で内容の異なる決定記録を追加する(実際の add/add 衝突)
    git(["checkout", "agent/T-19"]);
    writeFile(`${decisionsDir}/D-20260816-19.md`, "branch content\n");
    commitAll("docs(agent): D-20260816-19 を追加する(branch 側)");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-19", "T-19", "D-20260816-19 の衝突", TRAILER);

    // 修正前は collectUsedIds が ".gitkeep" を used ID として拾い、planIdRenumber が
    // 「ID 形式に合わない要素が 1 つでもあれば空の Map」という安全側の判定に引っかかって
    // renames.size === 0 → 常に "conflict" になっていた(自動振り直しが機能したことがなかった)
    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    expect(outcome.renames).toEqual(new Map([["D-20260816-19", "D-20260816-20"]]));
    expect(outcome.resolvedTaskFile).toBe(false);
    expect(git(["ls-files", "-u"]).trim()).toBe("");
  });

  it("回帰: マージ中タスク自身のタスクファイルが main/branch 双方で modify/modify コンフリクトしても、ID 採番の衝突と合わせて機械的に解決する(T-171 本番インシデントの再現)", () => {
    const decisionsDir = ".agent/decisions";
    writeFile(`${decisionsDir}/D-20260816-04.md`, "既存の判断記録\n");
    writeFile(".agent/tasks/T-042.md", "original\n");
    commitAll("init: 基点ファイルを追加する");
    git(["branch", "agent/T-042"]);

    // main 側: 衝突解消待ちのブランチに対して Supervisor が失敗記録を直接タスクファイルへ
    // コミットしたのと同じ状況 + 独立に採番した別内容の decision
    writeFile(`${decisionsDir}/D-20260816-05.md`, "main content\n");
    writeFile(".agent/tasks/T-042.md", "main(Supervisor)が書いた失敗記録\n");
    commitAll("docs(agent): main 側の変更");

    // branch 側: セッションが実際に書いた最終状態 + 独立に採番した(main と衝突する ID の)decision
    git(["checkout", "agent/T-042"]);
    writeFile(`${decisionsDir}/D-20260816-05.md`, "branch content\n");
    writeFile(".agent/tasks/T-042.md", "branch(セッション)が書いた最終状態\n");
    commitAll("docs(agent): branch 側の変更");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-042", "T-042", "T-171 の再現", TRAILER);

    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    expect(outcome.renames).toEqual(new Map([["D-20260816-05", "D-20260816-06"]]));
    expect(outcome.resolvedTaskFile).toBe(true);

    // タスクファイルは branch 側の内容がそのまま採用される
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-042.md"), "utf8")).toBe(
      "branch(セッション)が書いた最終状態\n",
    );
    // decision は通常通り振り直される
    expect(fs.readFileSync(path.join(dir, decisionsDir, "D-20260816-05.md"), "utf8")).toBe("main content\n");
    expect(fs.readFileSync(path.join(dir, decisionsDir, "D-20260816-06.md"), "utf8")).toBe("branch content\n");

    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");

    const message = git(["log", "-1", "--pretty=%B"]);
    expect(message).toContain("D-20260816-05 -> D-20260816-06");
    expect(message).toContain("タスクファイルはブランチ側を採用: .agent/tasks/T-042.md");
  });

  it("マージ中タスクと異なる taskId のタスクファイル(.agent/tasks/T-999.md)が衝突すれば substantive として abort する", () => {
    writeFile(".agent/tasks/T-999.md", "base\n");
    commitAll("init: 基点タスクファイルを追加する");
    git(["branch", "agent/T-042"]);

    writeFile(".agent/tasks/T-999.md", "main version\n");
    commitAll("fix: main 側の変更");

    git(["checkout", "agent/T-042"]);
    writeFile(".agent/tasks/T-999.md", "branch version\n");
    commitAll("fix: branch 側の変更");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-042", "T-042", "他タスクのファイルと衝突", TRAILER);

    expect(outcome).toEqual({ result: "conflict", paths: [".agent/tasks/T-999.md"], conflictKind: "substantive" });
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("own-task-file の衝突に無関係な src ファイルの衝突が混ざれば substantive として abort する", () => {
    writeFile(".agent/tasks/T-042.md", "base\n");
    writeFile("src/a.ts", "base\n");
    commitAll("init: 基点ファイルを追加する");
    git(["branch", "agent/T-042"]);

    writeFile(".agent/tasks/T-042.md", "main task version\n");
    writeFile("src/a.ts", "main version\n");
    commitAll("fix: main 側の変更");

    git(["checkout", "agent/T-042"]);
    writeFile(".agent/tasks/T-042.md", "branch task version\n");
    writeFile("src/a.ts", "branch version\n");
    commitAll("fix: branch 側の変更");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-042", "T-042", "混在の衝突", TRAILER);

    expect(outcome.result).toBe("conflict");
    if (outcome.result !== "conflict") throw new Error("unreachable");
    expect([...outcome.paths].sort()).toEqual([".agent/tasks/T-042.md", "src/a.ts"]);
    expect(outcome.conflictKind).toBe("substantive");
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("own-task-file だけの衝突(ID 採番の衝突なし)は renames 0 件で renumbered になる", () => {
    writeFile(".agent/tasks/T-042.md", "base\n");
    commitAll("init: 基点タスクファイルを追加する");
    git(["branch", "agent/T-042"]);

    writeFile(".agent/tasks/T-042.md", "main(Supervisor)が書いた失敗記録\n");
    commitAll("docs(agent): main 側の失敗記録");

    git(["checkout", "agent/T-042"]);
    writeFile(".agent/tasks/T-042.md", "branch(セッション)が書いた最終状態\n");
    commitAll("docs(agent): branch 側の最終状態");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-042", "T-042", "own-task-file のみの衝突", TRAILER);

    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    expect(outcome.renames.size).toBe(0);
    expect(outcome.resolvedTaskFile).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-042.md"), "utf8")).toBe(
      "branch(セッション)が書いた最終状態\n",
    );
    expect(git(["ls-files", "-u"]).trim()).toBe("");
  });

  it("partial: ID 採番衝突と src/ の内容衝突が混在すれば、ID 採番の改番計画だけを preResolvedRenames に添えて conflict を返す(実質衝突は先行解決しない)", () => {
    const decisionsDir = ".agent/decisions";
    writeFile("src/foo.ts", "original\n");
    commitAll("init: 基点ファイルを追加する");
    git(["branch", "agent/T-partial"]);

    // main 側: 新規に D-20260816-01 を追加し、src/foo.ts も変更する
    writeFile(`${decisionsDir}/D-20260816-01.md`, "main content\n");
    writeFile("src/foo.ts", "main version\n");
    commitAll("docs(agent): main 側の変更");

    // branch 側: 独立に同じ ID (D-20260816-01) を追加し、src/foo.ts も別内容で変更する
    git(["checkout", "agent/T-partial"]);
    writeFile(`${decisionsDir}/D-20260816-01.md`, "branch content\n");
    writeFile("src/foo.ts", "branch version\n");
    commitAll("docs(agent): branch 側の変更");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-partial", "T-partial", "partial の再現", TRAILER);

    expect(outcome.result).toBe("conflict");
    if (outcome.result !== "conflict") throw new Error("unreachable");
    expect(outcome.paths).toEqual(["src/foo.ts"]);
    expect(outcome.preResolvedRenames).toEqual(new Map([["D-20260816-01", "D-20260816-02"]]));
    // 観測用の分類。混在は "substantive" ではなく "partial" として metrics に残る
    expect(outcome.conflictKind).toBe("partial");

    // main 側はクリーンに戻っている(衝突マーカーは残さない)
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(["status", "--porcelain"]).trim()).toBe("");
  });

  it("entry guard: main が既に別の git 操作の途中なら、その衝突に触れず即座に blocked を返す", () => {
    // 無関係な substantive コンフリクトを直接 git で作り、main を意図的に mid-merge のままにする
    writeFile("src/stale.ts", "original\n");
    commitAll("feat: stale を追加する");
    git(["branch", "agent/T-stale"]);
    writeFile("src/stale.ts", "main version\n");
    commitAll("fix: main 側の変更");
    git(["checkout", "agent/T-stale"]);
    writeFile("src/stale.ts", "branch version\n");
    commitAll("fix: branch 側の変更");
    git(["checkout", "main"]);
    expect(() => git(["merge", "agent/T-stale", "-m", "stale merge"])).toThrow();
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    const staleUnmerged = git(["ls-files", "-u"]);
    expect(staleUnmerged).not.toBe("");

    // 別の(今回とは無関係な)ブランチに対してマージを試みる
    git(["branch", "agent/T-other"]);
    // T-other 用の worktree はここでは使わないので、コミットは checkout せず作れないため
    // 代わりに main 側から直接コミットを作ってブランチを進める手段を取れないので、
    // stale と同じ手順の代わりに単純な新規コミットを作る
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-other-wt-"));
    git(["worktree", "add", other, "agent/T-other"]);
    fs.writeFileSync(path.join(other, "other.txt"), "other content\n");
    git(["add", "-A"], other);
    git(["commit", "-m", "feat: other を追加する"], other);
    git(["worktree", "remove", "--force", other]);

    const outcome = mergeAgentBranch(dir, "agent/T-other", "T-other", "無関係なタスク", TRAILER);

    expect(outcome.result).toBe("blocked");
    if (outcome.result !== "blocked") throw new Error("unreachable");
    expect(outcome.reason.length).toBeGreaterThan(0);

    // stale だった衝突は一切手を加えられていない(新しいマージも試みられていない)
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    expect(git(["ls-files", "-u"])).toBe(staleUnmerged);
  });
});

describe("resolveMechanically(abort 失敗の再現)", () => {
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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-wedge-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-wedge-hooks-"));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-m", "init"]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it("merge-staged なファイルが abort 直前に作業ツリー上だけで書き換わっていると、abort 失敗を wedged として報告する(本番インシデントの実機構の再現)", () => {
    // f.txt は main/branch 両方が違う内容へ変更する(substantive コンフリクトの種)
    // .agent/tasks/T-172.md は branch だけが変更する(コンフリクトなく自動マージ・ステージされる)
    writeFile("f.txt", "base\n");
    writeFile(".agent/tasks/T-172.md", "original\n");
    commitAll("init: 基点ファイルを追加する");
    git(["branch", "agent/T-172"]);

    writeFile("f.txt", "main version\n");
    commitAll("fix: main 側の変更(f.txt のみ)");

    git(["checkout", "agent/T-172"]);
    writeFile("f.txt", "branch version\n");
    writeFile(".agent/tasks/T-172.md", "branch が更新した内容\n");
    commitAll("fix: branch 側の変更(f.txt と T-172.md)");
    git(["checkout", "main"]);

    // mergeAgentBranch を経由せず、生の git merge で「実際に本番で起きた状態」を再現する:
    // f.txt はコンフリクトするが、T-172.md は branch の内容がコンフリクトなく index/working
    // tree の両方へ反映される(自動マージ)
    expect(() => git(["merge", "agent/T-172", "-m", "merge"])).toThrow();
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-172.md"), "utf8")).toBe("branch が更新した内容\n");

    // ここが本番インシデントの引き金: finishTaskSession の fail()/saveTask がタスクファイルへ
    // git を経由せず直接書き込む(index は branch の内容のまま、working tree だけがずれる)
    fs.writeFileSync(path.join(dir, ".agent/tasks/T-172.md"), "supervisor が直接上書きした内容\n");

    const outcome = resolveMechanically(dir, "agent/T-172", "T-172", "対立するタスク", TRAILER);

    expect(outcome.result).toBe("wedged");
    if (outcome.result !== "wedged") throw new Error("unreachable");
    expect(outcome.stderr.length).toBeGreaterThan(0);
    expect(outcome.stderr).toContain("T-172.md");

    // abort が失敗しているので MERGE_HEAD は残ったまま(main は固まった状態)
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(true);
  });
});

describe("collectUsedIds", () => {
  let dir: string;
  let hooksDir: string;

  function git(args: string[], cwd: string = dir): string {
    return execFileSync("git", args, { cwd }).toString();
  }

  function writeFile(relPath: string, content: string): void {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function commitAll(message: string): void {
    git(["add", "-A"]);
    git(["commit", "-m", message]);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-usedids-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-usedids-hooks-"));
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it(".gitkeep 等 ID 形式でないファイル名を除外し、ID 形式のものだけを返す", () => {
    writeFile(".agent/decisions/.gitkeep", "");
    writeFile(".agent/human-review/.gitkeep", "");
    writeFile(".agent/decisions/D-20260816-07.md", "決定記録\n");
    writeFile(".agent/human-review/HR-20260816-03.md", "レビュー\n");
    commitAll("init");

    const ids = collectUsedIds(dir);

    expect(ids.sort()).toEqual(["D-20260816-07", "HR-20260816-03"]);
  });
});

// ---------- preResolveIdCollisions(worktree 上での先行解決の統合テスト) ----------

describe("preResolveIdCollisions", () => {
  let dir: string;
  let hooksDir: string;
  let worktreeDir: string | null;
  let worktreeParent: string | null;

  function git(args: string[], cwd: string = dir): string {
    return execFileSync("git", args, { cwd }).toString();
  }

  function writeFile(relPath: string, content: string, cwd: string = dir): void {
    const abs = path.join(cwd, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function commitAll(message: string, cwd: string = dir): void {
    git(["add", "-A"], cwd);
    git(["commit", "-m", message], cwd);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-preresolve-"));
    hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-preresolve-hooks-"));
    worktreeDir = null;
    worktreeParent = null;
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test User"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", hooksDir]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-m", "init"]);
  });

  afterEach(() => {
    if (worktreeDir !== null) {
      try {
        git(["worktree", "remove", "--force", worktreeDir]);
      } catch {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
      try {
        git(["worktree", "prune"]);
      } catch {
        // 無視(掃除できなくてもテスト結果には影響しない)
      }
    }
    if (worktreeParent !== null) fs.rmSync(worktreeParent, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(hooksDir, { recursive: true, force: true });
  });

  it("ID 採番衝突だけを index へ解決済みとして載せ、実質衝突のマーカーは残す(ブランチが持ち込んだ他の .md の ID 参照も書き換える)", () => {
    const decisionsDir = ".agent/decisions";
    writeFile("src/foo.ts", "original\n");
    commitAll("init: 基点ファイルを追加する");
    git(["branch", "agent/T-pre"]);

    // main 側: 新規に D-20260816-01 を追加し、src/foo.ts も変更する
    writeFile(`${decisionsDir}/D-20260816-01.md`, "main content\n");
    writeFile("src/foo.ts", "main version\n");
    commitAll("docs(agent): main 側の変更");
    const mainHead = git(["rev-parse", "HEAD"]).trim();

    // branch 側の作業は専用の worktree で行う(reproduceMergeConflict と同じ状況を再現するため)
    worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-preresolve-wt-"));
    worktreeDir = path.join(worktreeParent, "wt");
    git(["worktree", "add", worktreeDir, "agent/T-pre"]);
    writeFile(`${decisionsDir}/D-20260816-01.md`, "branch content\n", worktreeDir);
    writeFile("src/foo.ts", "branch version\n", worktreeDir);
    // ブランチが持ち込む、衝突しない .md ファイル(ID 参照込み)。preResolveIdCollisions が
    // これも書き換える対象になることを確認する
    writeFile(".agent/tasks/T-pre.md", "参照: D-20260816-01 を踏まえて実装した\n", worktreeDir);
    commitAll("docs(agent): branch 側の変更", worktreeDir);

    // main の HEAD を worktree へマージし直し、衝突を再現する(非ゼロ終了するので try/catch)
    try {
      git(["merge", mainHead], worktreeDir);
    } catch {
      // 衝突による非ゼロ終了が期待動作
    }
    expect(git(["ls-files", "-u"], worktreeDir).trim()).not.toBe("");

    const renames = new Map([["D-20260816-01", "D-20260816-02"]]);
    const resolved = preResolveIdCollisions(worktreeDir, renames);

    expect(resolved).toEqual([`${decisionsDir}/D-20260816-01.md`]);

    // 未マージパスは src/foo.ts だけになっている
    const unmergedPaths = new Set(
      git(["ls-files", "-u"], worktreeDir)
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => l.slice(l.indexOf("\t") + 1)),
    );
    expect(unmergedPaths).toEqual(new Set(["src/foo.ts"]));

    // 新 ID のファイルが存在しブランチ側の内容を持つ
    expect(fs.readFileSync(path.join(worktreeDir, decisionsDir, "D-20260816-02.md"), "utf8")).toBe(
      "branch content\n",
    );
    // 旧 ID のパスは main 側の内容で staged(working tree・index 両方)
    expect(fs.readFileSync(path.join(worktreeDir, decisionsDir, "D-20260816-01.md"), "utf8")).toBe(
      "main content\n",
    );
    expect(git(["show", `:${decisionsDir}/D-20260816-01.md`], worktreeDir)).toBe("main content\n");

    // ブランチが持ち込んだ他の .agent 配下 .md の ID 参照が書き換わっている
    expect(fs.readFileSync(path.join(worktreeDir, ".agent/tasks/T-pre.md"), "utf8")).toBe(
      "参照: D-20260816-02 を踏まえて実装した\n",
    );
  });

  it("renames が空なら何もせず空配列を返す", () => {
    expect(preResolveIdCollisions(dir, new Map())).toEqual([]);
  });

  it("MERGE_HEAD が無ければ何もせず空配列を返す", () => {
    expect(preResolveIdCollisions(dir, new Map([["D-20260816-01", "D-20260816-02"]]))).toEqual([]);
  });
});
