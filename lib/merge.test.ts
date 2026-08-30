import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyConflicts,
  mergeAgentBranch,
  mergeCommitMessage,
  parseUnmergedStages,
  resolveMechanically,
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
  const TASK_ID = "T-20260816-1030-sample-task";

  it("`.agent/decisions/` 直下の同名 add/add は substantive(同名になるのは二重起票のときだけで、どちらを残すかは人間が決める)", () => {
    const stages = new Map([[".agent/decisions/D-20260816-1030-adopt-slug-ids.md", new Set([2, 3])]]);

    const result = classifyConflicts(stages, TASK_ID);

    if (result.kind !== "substantive") throw new Error("unreachable");
    expect(result.paths).toEqual([".agent/decisions/D-20260816-1030-adopt-slug-ids.md"]);
  });

  it("`.agent/human-review/` 直下の同名 add/add も substantive", () => {
    const stages = new Map([[".agent/human-review/HR-20260816-1030-check-merge.md", new Set([2, 3])]]);

    expect(classifyConflicts(stages, TASK_ID).kind).toBe("substantive");
  });

  it("decisions が stage {1,2,3}(modify/modify)なら substantive", () => {
    const stages = new Map([[".agent/decisions/D-20260816-1030-adopt-slug-ids.md", new Set([1, 2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID).kind).toBe("substantive");
  });

  it("マージ中タスク自身の .agent/tasks/<taskId>.md が add/add(stage {2,3})なら ownTaskFile として mechanical", () => {
    const stages = new Map([[`.agent/tasks/${TASK_ID}.md`, new Set([2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      ownTaskFile: `.agent/tasks/${TASK_ID}.md`,
      decisionsIndex: null,
    });
  });

  it("マージ中タスク自身の .agent/tasks/<taskId>.md が modify/modify(stage {1,2,3})でも ownTaskFile として mechanical", () => {
    const stages = new Map([[`.agent/tasks/${TASK_ID}.md`, new Set([1, 2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      ownTaskFile: `.agent/tasks/${TASK_ID}.md`,
      decisionsIndex: null,
    });
  });

  it(".agent/decisions/index.md が add/add(stage {2,3})なら decisionsIndex として mechanical、hasBase は false", () => {
    const stages = new Map([[".agent/decisions/index.md", new Set([2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      ownTaskFile: null,
      decisionsIndex: { path: ".agent/decisions/index.md", hasBase: false },
    });
  });

  it(".agent/decisions/index.md が modify/modify(stage {1,2,3})でも decisionsIndex として mechanical、hasBase は true", () => {
    const stages = new Map([[".agent/decisions/index.md", new Set([1, 2, 3])]]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      ownTaskFile: null,
      decisionsIndex: { path: ".agent/decisions/index.md", hasBase: true },
    });
  });

  it("own-task-file と decisions/index.md の両方が衝突しても mechanical(両方は排他ではなく併存しうる)", () => {
    const stages = new Map([
      [`.agent/tasks/${TASK_ID}.md`, new Set([2, 3])],
      [".agent/decisions/index.md", new Set([1, 2, 3])],
    ]);
    expect(classifyConflicts(stages, TASK_ID)).toEqual({
      kind: "mechanical",
      ownTaskFile: `.agent/tasks/${TASK_ID}.md`,
      decisionsIndex: { path: ".agent/decisions/index.md", hasBase: true },
    });
  });

  it("own-task-file と decisions の同名 add/add が混在すれば substantive(混在は機械的に解決しない)", () => {
    const stages = new Map([
      [".agent/decisions/D-20260816-1030-adopt-slug-ids.md", new Set([2, 3])],
      [`.agent/tasks/${TASK_ID}.md`, new Set([1, 2, 3])],
    ]);

    const result = classifyConflicts(stages, TASK_ID);

    if (result.kind !== "substantive") throw new Error("unreachable");
    expect(result.paths).toHaveLength(2);
  });

  it("別タスクのタスクファイル(.agent/tasks/T-20260816-1100-other.md)が衝突すれば substantive", () => {
    const stages = new Map([[".agent/tasks/T-20260816-1100-other.md", new Set([2, 3])]]);
    const result = classifyConflicts(stages, TASK_ID);
    if (result.kind !== "substantive") throw new Error("unreachable");
    expect(result.paths).toEqual([".agent/tasks/T-20260816-1100-other.md"]);
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

  it("resolved.ownTaskFile があれば本文にタスクファイル採用の記録を入れる", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
    });
    expect(message).toBe(
      "Merge branch 'agent/T-001' (T-001 タイトル)\n\n" +
        "タスクファイルはブランチ側を採用: .agent/tasks/T-001.md\n\n" +
        TRAILER,
    );
  });

  it("resolved.decisionsIndex があれば本文に決定インデックス統合の記録を入れる", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      decisionsIndex: ".agent/decisions/index.md",
    });
    expect(message).toBe(
      "Merge branch 'agent/T-001' (T-001 タイトル)\n\n" +
        "決定インデックスは両ブランチの項目を統合: .agent/decisions/index.md\n\n" +
        TRAILER,
    );
  });

  it("resolved に両方あれば本文に両方の記録を入れる", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
      decisionsIndex: ".agent/decisions/index.md",
    });
    expect(message).toBe(
      "Merge branch 'agent/T-001' (T-001 タイトル)\n\n" +
        "タスクファイルはブランチ側を採用: .agent/tasks/T-001.md\n" +
        "決定インデックスは両ブランチの項目を統合: .agent/decisions/index.md\n\n" +
        TRAILER,
    );
  });

  it("resolved.ownTaskFileDiscarded があれば本文に main 側の破棄差分を含める", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
      ownTaskFileDiscarded: "@@ -1 +1 @@\n-main content\n+ours content",
    });
    expect(message).toContain("タスクファイルはブランチ側を採用: .agent/tasks/T-001.md");
    expect(message).toContain("この解消で main 側の以下の変更を破棄した(ブランチ側の内容で確定した):");
    expect(message).toContain("@@ -1 +1 @@\n-main content\n+ours content");
  });

  it("ownTaskFileDiscarded が 61 行超えなら 60 行で切り詰め、省略の注記を付ける", () => {
    const lines = Array.from({ length: 61 }, (_, i) => `line ${i}`);
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
      ownTaskFileDiscarded: lines.join("\n"),
    });
    expect(message).toContain("line 59");
    expect(message).not.toContain("line 60");
    expect(message).toContain("... (残り 1 行は省略。git diff で確認できる)");
  });

  it("ownTaskFileDiscarded に制御文字が含まれると <U+XXXX> 形式へ置換され、改行は保持される(表示と実際の内容が食い違う紛れ込みを防ぐ)", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
      ownTaskFileDiscarded: "line1\x07line2\nline3",
    });
    expect(message).not.toContain("\x07");
    expect(message).toContain("line1<U+0007>line2\nline3");
  });

  it("ownTaskFileDiscarded の双方向制御文字・ゼロ幅文字も <U+XXXX> 形式へ置換される", () => {
    // RLO(表示順を反転させる)と ZWSP(見えないまま語を分断する)。テストソース自体に
    // 不可視文字を書き込まないよう、コードポイントから組み立てる
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
      ownTaskFileDiscarded: `-priority: 3${rlo}${zwsp}+priority: 1`,
    });
    expect(message).not.toContain(rlo);
    expect(message).not.toContain(zwsp);
    expect(message).toContain("-priority: 3<U+202E><U+200B>+priority: 1");
  });

  it("ownTaskFileDiscarded の 1 行が 200 文字を超えると 200 文字で切り詰め、省略の注記が付く", () => {
    const longLine = "a".repeat(250);
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
      ownTaskFileDiscarded: longLine,
    });
    expect(message).toContain(`${"a".repeat(200)}…(この行はここまで)`);
    expect(message).not.toContain("a".repeat(201));
  });

  it("ownTaskFileDiscarded が無ければ破棄の記述は出ない", () => {
    const message = mergeCommitMessage("agent/T-001", "T-001", "タイトル", TRAILER, {
      ownTaskFile: ".agent/tasks/T-001.md",
    });
    expect(message).not.toContain("破棄した");
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

  it("`.agent/decisions/` 直下で同名ファイルの add/add が起きたら substantive として abort する(二重起票は人間判断へ回す)", () => {
    const decisionsDir = ".agent/decisions";
    writeFile(`${decisionsDir}/.gitkeep`, "");
    commitAll("init: decisions ディレクトリを用意する");

    // branch を base(このコミット)から分岐させる
    git(["branch", "agent/T-20260816-1030-dup"]);

    // main 側と branch 側が独立に同じ ID(= 同じ分・同じ slug)の決定記録を追加する
    writeFile(`${decisionsDir}/D-20260816-1030-adopt-slug-ids.md`, "main content X\n");
    commitAll("docs(agent): main 側の決定記録");

    git(["checkout", "agent/T-20260816-1030-dup"]);
    writeFile(`${decisionsDir}/D-20260816-1030-adopt-slug-ids.md`, "branch content Y\n");
    commitAll("docs(agent): branch 側の決定記録");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(
      dir,
      "agent/T-20260816-1030-dup",
      "T-20260816-1030-dup",
      "同じ ID の決定記録",
      TRAILER,
    );

    expect(outcome).toEqual({
      result: "conflict",
      paths: [`${decisionsDir}/D-20260816-1030-adopt-slug-ids.md`],
      conflictKind: "substantive",
    });
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(["status", "--porcelain"]).trim()).toBe("");
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

  it("own-task-file だけの衝突は機械的に解決し、ブランチ側の内容を採用する(T-171 本番インシデントの再現)", () => {
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
    // main 側にも実質的な変更(base "base\n" → "main(Supervisor)が書いた失敗記録\n")があるため、
    // ownTaskFileDiscarded にその差分が残る(具体的な差分本文は discardedOursDiff/
    // mergeCommitMessage 側のテストで別途検証する)。
    expect(outcome.resolved).toEqual({
      ownTaskFile: ".agent/tasks/T-042.md",
      decisionsIndex: null,
      ownTaskFileDiscarded: expect.any(String),
    });
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-042.md"), "utf8")).toBe(
      "branch(セッション)が書いた最終状態\n",
    );
    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    expect(git(["log", "-1", "--pretty=%B"])).toContain("タスクファイルはブランチ側を採用: .agent/tasks/T-042.md");
  });

  it("own-task-file の衝突で main 側だけにあった変更を破棄しても、マージコミットのメッセージに差分として残る(人間の手編集が黙って消えないことの確認)", () => {
    writeFile(".agent/tasks/T-043.md", "base\n");
    commitAll("init: 基点タスクファイルを追加する");
    git(["branch", "agent/T-043"]);

    writeFile(".agent/tasks/T-043.md", "人間が main 側で直接編集した内容\n");
    commitAll("docs(agent): main 側の編集(人間による手編集を模す)");

    git(["checkout", "agent/T-043"]);
    writeFile(".agent/tasks/T-043.md", "branch(セッション)が書いた最終状態\n");
    commitAll("docs(agent): branch 側の最終状態");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-043", "T-043", "own-task-file の破棄記録", TRAILER);

    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");

    // 既存挙動は維持: ファイル内容はブランチ側のまま
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-043.md"), "utf8")).toBe(
      "branch(セッション)が書いた最終状態\n",
    );

    // main 側にだけあった行が破棄記録としてマージコミットのメッセージに残る
    const message = git(["log", "-1", "--pretty=%B"]);
    expect(message).toContain("人間が main 側で直接編集した内容");
    expect(message).toContain("この解消で main 側の以下の変更を破棄した(ブランチ側の内容で確定した):");
  });

  it("own-task-file が add/add(共通祖先なし)でも機械的に解決し、ブランチ側の内容を採用しつつ main 側の内容を破棄記録として残す", () => {
    // beforeEach の初期コミット(init)には .agent/tasks/T-060.md が存在しない = 共通祖先なし
    git(["branch", "agent/T-060"]);

    writeFile(".agent/tasks/T-060.md", "main 側が独立に追加した内容\n");
    commitAll("docs(agent): main 側でタスクファイルを新規追加する");

    git(["checkout", "agent/T-060"]);
    writeFile(".agent/tasks/T-060.md", "branch 側が独立に追加した内容\n");
    commitAll("docs(agent): branch 側でタスクファイルを新規追加する");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-060", "T-060", "own-task-file の add/add(共通祖先なし)", TRAILER);

    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    expect(outcome.resolved.ownTaskFile).toBe(".agent/tasks/T-060.md");
    expect(outcome.resolved.decisionsIndex).toBeNull();
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-060.md"), "utf8")).toBe(
      "branch 側が独立に追加した内容\n",
    );
    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");

    const message = git(["log", "-1", "--pretty=%B"]);
    expect(message).toContain("タスクファイルはブランチ側を採用: .agent/tasks/T-060.md");
    expect(message).toContain("main 側が独立に追加した内容");
    expect(message).toContain("この解消で main 側の以下の変更を破棄した(ブランチ側の内容で確定した):");
  });

  const DECISIONS_HEADER =
    "# 決定インデックス\n\nチェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。\n\n";

  it("main 側と branch 側が .agent/decisions/index.md の先頭にそれぞれ別の行を追記すると機械的に解決し、両方の行が ID 降順で入る", () => {
    const indexPath = ".agent/decisions/index.md";
    writeFile(indexPath, `${DECISIONS_HEADER}- [ ] [D-001](D-001.md) — 既存の決定\n`);
    commitAll("init: 決定インデックスの基点を追加する");
    git(["branch", "agent/T-020"]);

    writeFile(
      indexPath,
      `${DECISIONS_HEADER}- [ ] [D-002](D-002.md) — main 側で追加した決定\n- [ ] [D-001](D-001.md) — 既存の決定\n`,
    );
    commitAll("docs(agent): main 側の決定記録を追加する");

    git(["checkout", "agent/T-020"]);
    writeFile(
      indexPath,
      `${DECISIONS_HEADER}- [ ] [D-003](D-003.md) — branch 側で追加した決定\n- [ ] [D-001](D-001.md) — 既存の決定\n`,
    );
    commitAll("docs(agent): branch 側の決定記録を追加する");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-020", "T-020", "index.md のみの衝突", TRAILER);

    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    expect(outcome.resolved).toEqual({ ownTaskFile: null, decisionsIndex: indexPath });
    const text = fs.readFileSync(path.join(dir, indexPath), "utf8");
    const lines = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual([
      "- [ ] [D-003](D-003.md) — branch 側で追加した決定",
      "- [ ] [D-002](D-002.md) — main 側で追加した決定",
      "- [ ] [D-001](D-001.md) — 既存の決定",
    ]);
    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    expect(git(["log", "-1", "--pretty=%B"])).toContain(
      "決定インデックスは両ブランチの項目を統合: .agent/decisions/index.md",
    );
  });

  it("index.md が真の add/add(共通祖先に存在しない)でも機械的に解決し、両方の行が ID 降順で入る(hasBase===false の経路)", () => {
    const indexPath = ".agent/decisions/index.md";
    // 分岐前のコミットには index.md が存在しない(base に無い = 真の add/add)
    writeFile(".gitkeep", "");
    commitAll("init: index.md 無しの基点を追加する");
    git(["branch", "agent/T-050"]);

    // header は両側で同一にする(食い違うと機械的解決を諦める仕様のため)
    writeFile(indexPath, `${DECISIONS_HEADER}- [ ] [D-101](D-101.md) — main 側で新規追加した決定\n`);
    commitAll("docs(agent): main 側の決定記録を追加する");

    git(["checkout", "agent/T-050"]);
    writeFile(indexPath, `${DECISIONS_HEADER}- [ ] [D-102](D-102.md) — branch 側で新規追加した決定\n`);
    commitAll("docs(agent): branch 側の決定記録を追加する");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-050", "T-050", "index.md の真の add/add", TRAILER);

    expect(outcome).toEqual({
      result: "renumbered",
      resolved: { ownTaskFile: null, decisionsIndex: indexPath },
    });
    const text = fs.readFileSync(path.join(dir, indexPath), "utf8");
    const lines = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual([
      "- [ ] [D-102](D-102.md) — branch 側で新規追加した決定",
      "- [ ] [D-101](D-101.md) — main 側で新規追加した決定",
    ]);
    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");
  });

  it("own-task-file と index.md が同時に衝突しても機械的に解決される", () => {
    const indexPath = ".agent/decisions/index.md";
    writeFile(".agent/tasks/T-030.md", "base\n");
    writeFile(indexPath, `${DECISIONS_HEADER}- [ ] [D-001](D-001.md) — 既存の決定\n`);
    commitAll("init: 基点ファイルを追加する");
    git(["branch", "agent/T-030"]);

    writeFile(".agent/tasks/T-030.md", "main(Supervisor)が書いた失敗記録\n");
    writeFile(
      indexPath,
      `${DECISIONS_HEADER}- [ ] [D-002](D-002.md) — main 側で追加した決定\n- [ ] [D-001](D-001.md) — 既存の決定\n`,
    );
    commitAll("docs(agent): main 側の変更");

    git(["checkout", "agent/T-030"]);
    writeFile(".agent/tasks/T-030.md", "branch(セッション)が書いた最終状態\n");
    writeFile(
      indexPath,
      `${DECISIONS_HEADER}- [ ] [D-003](D-003.md) — branch 側で追加した決定\n- [ ] [D-001](D-001.md) — 既存の決定\n`,
    );
    commitAll("docs(agent): branch 側の変更");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-030", "T-030", "own-task-file と index.md の同時衝突", TRAILER);

    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    // main 側にも実質的な変更があるため ownTaskFileDiscarded が付く(差分本文は別テストで検証)
    expect(outcome.resolved).toEqual({
      ownTaskFile: ".agent/tasks/T-030.md",
      decisionsIndex: indexPath,
      ownTaskFileDiscarded: expect.any(String),
    });
    expect(fs.readFileSync(path.join(dir, ".agent/tasks/T-030.md"), "utf8")).toBe(
      "branch(セッション)が書いた最終状態\n",
    );
    const text = fs.readFileSync(path.join(dir, indexPath), "utf8");
    const lines = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual([
      "- [ ] [D-003](D-003.md) — branch 側で追加した決定",
      "- [ ] [D-002](D-002.md) — main 側で追加した決定",
      "- [ ] [D-001](D-001.md) — 既存の決定",
    ]);
    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");
    const message = git(["log", "-1", "--pretty=%B"]);
    expect(message).toContain("タスクファイルはブランチ側を採用: .agent/tasks/T-030.md");
    expect(message).toContain("決定インデックスは両ブランチの項目を統合: .agent/decisions/index.md");
  });

  it("index.md と個別の決定ファイル(.agent/decisions/D-xxx.md)が同時に衝突したら substantive になり merge が abort される", () => {
    const indexPath = ".agent/decisions/index.md";
    writeFile(indexPath, DECISIONS_HEADER);
    commitAll("init: 決定インデックスの基点を追加する");
    git(["branch", "agent/T-040"]);

    // main 側は index.md へ独自に追記し、同じ ID(= 同じ分・同じ slug)の決定ファイルも追加する
    writeFile(indexPath, `${DECISIONS_HEADER}- [ ] [D-020-dup](D-020-dup.md) — main 側の決定\n`);
    writeFile(".agent/decisions/D-020-dup.md", "main content\n");
    commitAll("docs(agent): main 側の決定記録");

    // branch 側は独立に同じ ID の決定ファイルを別内容で追加し、index.md へも別内容を追記する
    git(["checkout", "agent/T-040"]);
    writeFile(indexPath, `${DECISIONS_HEADER}- [ ] [D-020-dup](D-020-dup.md) — branch 側の決定\n`);
    writeFile(".agent/decisions/D-020-dup.md", "branch content\n");
    commitAll("docs(agent): branch 側の決定記録");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, "agent/T-040", "T-040", "index.md と個別決定ファイルの同時衝突", TRAILER);

    expect(outcome.result).toBe("conflict");
    if (outcome.result !== "conflict") throw new Error("unreachable");
    expect([...outcome.paths].sort()).toEqual([".agent/decisions/D-020-dup.md", indexPath]);
    expect(outcome.conflictKind).toBe("substantive");
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

  // このリポジトリ実物の .gitattributes と同じ内容(コメントを含む)。CHANGELOG.md の
  // union マージ属性が実運用と同じ形で効くことを確かめるため、要旨だけの再現にせず
  // そのまま複製する。
  const GITATTRIBUTES_CONTENT = [
    "# 変更履歴は「## 未リリース」節へ各ブランチが独立に 1 行足す運用のため、同じ箇所への",
    "# 追記同士が必ず衝突する。両側の項目をどちらも残すのが常に正しい解消(捨てる理由が無い)",
    "# なので、union マージで自動的にそうする。",
    "#",
    "# 注意: union は「内容が対立していない追記」を無条件に両方残す方式で、衝突を報告しない。",
    "# リリースで「## 未リリース」が版番号の見出しへ繰り上がった直後にブランチ側の追記が",
    "# union されると、行が意図しない節に入りうる。その場合は静かに間違うため、リリース直後は",
    "# 変更履歴の並びを目視で確認する。",
    "/CHANGELOG.md merge=union",
    "",
  ].join("\n");

  const CHANGELOG_BASE = ["# 変更履歴", "", "## 未リリース", "", "### 追加", "", "- 既存の機能\n"].join("\n");

  const TASK_FILE_BASE = [
    "---",
    'title: "サンプルタスク"',
    "status: in_progress",
    "priority: 2",
    "dependencies: []",
    "retries: 0",
    "---",
    "",
    "タスク本文。",
    "",
    "## 試行履歴",
    "",
    "### 試行 1(初回)",
    "- 実装を開始した。\n",
  ].join("\n");

  it("CHANGELOG.md の union マージとタスクファイルの試行履歴追記が同時に衝突しても手作業行きの conflict にならない(T-20260830-0621 の再現)", () => {
    const taskId = "T-20260830-0999-sample";
    const taskPath = `.agent/tasks/${taskId}.md`;

    writeFile(".gitattributes", GITATTRIBUTES_CONTENT);
    writeFile("CHANGELOG.md", CHANGELOG_BASE);
    writeFile(taskPath, TASK_FILE_BASE);
    commitAll("init: 基点ファイル一式を追加する");
    git(["branch", `agent/${taskId}`]);

    // main 側: 衝突で失敗した試行を Supervisor が記録した状況を再現する
    // (CHANGELOG.md の未リリース節先頭にも 1 行、タスクファイルの試行履歴末尾にも 1 エントリ)
    writeFile(
      "CHANGELOG.md",
      ["# 変更履歴", "", "## 未リリース", "", "### 追加", "", "- main 側で追加した機能", "- 既存の機能\n"].join("\n"),
    );
    writeFile(
      taskPath,
      [
        TASK_FILE_BASE,
        "### 試行 2(main が記録した衝突失敗)",
        "- 前回の試行はマージ衝突で失敗した。\n",
      ].join("\n"),
    );
    commitAll("docs(agent): main 側の失敗記録");

    // branch 側: 独立に実装を完了し、同じ箇所へ追記する
    git(["checkout", `agent/${taskId}`]);
    writeFile(
      "CHANGELOG.md",
      ["# 変更履歴", "", "## 未リリース", "", "### 追加", "", "- branch 側で追加した機能", "- 既存の機能\n"].join(
        "\n",
      ),
    );
    writeFile(
      taskPath,
      [
        TASK_FILE_BASE,
        "### 試行 2 の続き(branch セッションが記録)",
        "- 衝突を解消し実装を完了した。\n",
      ].join("\n"),
    );
    commitAll("docs(agent): branch 側の実装完了記録");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, `agent/${taskId}`, taskId, "union と試行履歴の同時衝突", TRAILER);

    // 真因の再発防止そのもの: 手作業行きの conflict になってはならない
    if (outcome.result === "conflict") {
      throw new Error(`手作業行きの conflict に戻ってしまった: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.result).toBe("renumbered");
    if (outcome.result !== "renumbered") throw new Error("unreachable");
    // main 側の失敗記録にも実質的な差分があるため ownTaskFileDiscarded が付く(差分本文は別テストで検証)
    expect(outcome.resolved).toEqual({
      ownTaskFile: taskPath,
      decisionsIndex: null,
      ownTaskFileDiscarded: expect.any(String),
    });

    // CHANGELOG.md は union マージにより両側の追記行がどちらも残る
    const changelog = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("- main 側で追加した機能");
    expect(changelog).toContain("- branch 側で追加した機能");
    expect(changelog).toContain("- 既存の機能");

    // タスクファイルは own-task-file 解決によりブランチ側の内容を丸ごと採用する
    const taskFile = fs.readFileSync(path.join(dir, taskPath), "utf8");
    expect(taskFile).toContain("### 試行 2 の続き(branch セッションが記録)");
    expect(taskFile).not.toContain("### 試行 2(main が記録した衝突失敗)");

    expect(git(["ls-files", "-u"]).trim()).toBe("");
    expect(git(["status", "--porcelain"]).trim()).toBe("");
  });

  it("対照: .gitattributes(union 属性)が無ければ同じ状況は手作業行きの conflict になる(union 属性が効いていることの証明)", () => {
    const taskId = "T-20260830-0998-sample-no-union";
    const taskPath = `.agent/tasks/${taskId}.md`;

    // .gitattributes を用意しない点だけが上のテストと異なる
    writeFile("CHANGELOG.md", CHANGELOG_BASE);
    writeFile(taskPath, TASK_FILE_BASE);
    commitAll("init: 基点ファイル一式を追加する(.gitattributes 無し)");
    git(["branch", `agent/${taskId}`]);

    writeFile(
      "CHANGELOG.md",
      ["# 変更履歴", "", "## 未リリース", "", "### 追加", "", "- main 側で追加した機能", "- 既存の機能\n"].join("\n"),
    );
    writeFile(
      taskPath,
      [
        TASK_FILE_BASE,
        "### 試行 2(main が記録した衝突失敗)",
        "- 前回の試行はマージ衝突で失敗した。\n",
      ].join("\n"),
    );
    commitAll("docs(agent): main 側の失敗記録");

    git(["checkout", `agent/${taskId}`]);
    writeFile(
      "CHANGELOG.md",
      ["# 変更履歴", "", "## 未リリース", "", "### 追加", "", "- branch 側で追加した機能", "- 既存の機能\n"].join(
        "\n",
      ),
    );
    writeFile(
      taskPath,
      [
        TASK_FILE_BASE,
        "### 試行 2 の続き(branch セッションが記録)",
        "- 衝突を解消し実装を完了した。\n",
      ].join("\n"),
    );
    commitAll("docs(agent): branch 側の実装完了記録");
    git(["checkout", "main"]);

    const outcome = mergeAgentBranch(dir, `agent/${taskId}`, taskId, "union なしの同時衝突", TRAILER);

    expect(outcome.result).toBe("conflict");
    if (outcome.result !== "conflict") throw new Error("unreachable");
    expect(outcome.conflictKind).toBe("substantive");
    expect([...outcome.paths].sort()).toEqual([taskPath, "CHANGELOG.md"].sort());
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(["status", "--porcelain"]).trim()).toBe("");
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
