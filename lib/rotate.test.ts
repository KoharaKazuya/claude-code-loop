import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECISIONS_INDEX_DEFAULT_HEADER, mergeDecisionsIndexText } from "./decisions-index.ts";
import { rotate, rotateResultIsEmpty } from "./rotate.ts";

function fixture(status: string, body = "本文"): string {
  return `---\nstatus: ${status}\n---\n${body}`;
}

/** title 付きの decisions フィクスチャ */
function decisionFixture(title: string, body = "本文"): string {
  return `---\ntitle: "${title}"\n---\n${body}`;
}

function writeFile(dir: string, fileName: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
}

function readIndex(decisionsDir: string): string {
  return fs.readFileSync(path.join(decisionsDir, "index.md"), "utf8");
}

let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-test-"));
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("rotate", () => {
  it("completed タスクだけが archive/tasks/ へ移動し、ready タスクは残る", () => {
    const tasksDir = path.join(agentDir, "tasks");
    writeFile(tasksDir, "T-001.md", fixture("completed"));
    writeFile(tasksDir, "T-002.md", fixture("ready"));

    const result = rotate(agentDir);

    expect(result.tasks).toBe(1);
    expect(fs.existsSync(path.join(agentDir, "archive", "tasks", "T-001.md"))).toBe(true);
    expect(fs.existsSync(path.join(tasksDir, "T-001.md"))).toBe(false);
    expect(fs.existsSync(path.join(tasksDir, "T-002.md"))).toBe(true);
  });

  it("closed な human-review だけが移動する", () => {
    const hrDir = path.join(agentDir, "human-review");
    writeFile(hrDir, "HR-20260812-01.md", fixture("closed"));
    writeFile(hrDir, "HR-20260812-02.md", fixture("open"));

    const result = rotate(agentDir);

    expect(result.humanReview).toBe(1);
    expect(fs.existsSync(path.join(agentDir, "archive", "human-review", "HR-20260812-01.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(hrDir, "HR-20260812-01.md"))).toBe(false);
    expect(fs.existsSync(path.join(hrDir, "HR-20260812-02.md"))).toBe(true);
  });

  it("index.md が無い状態からリコンサイルすると、未チェック行付き index.md が生成される", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-old.md", decisionFixture("古い判断"));
    writeFile(decisionsDir, "D-20260201-0000-new.md", decisionFixture("新しい判断"));

    const result = rotate(agentDir);

    expect(result.decisions).toBe(0);
    const text = readIndex(decisionsDir);
    const lines = text.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines).toEqual([
      "- [ ] [D-20260201-0000-new](D-20260201-0000-new.md) — 新しい判断",
      "- [ ] [D-20260101-0000-old](D-20260101-0000-old.md) — 古い判断",
    ]);
    // 実体ファイルは移動していない
    expect(fs.existsSync(path.join(decisionsDir, "D-20260101-0000-old.md"))).toBe(true);
    expect(fs.existsSync(path.join(decisionsDir, "D-20260201-0000-new.md"))).toBe(true);
  });

  it("[x] を付けた決定だけが archive/decisions/ へ移動し、その行が index.md から消える", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-keep.md", decisionFixture("残す判断"));
    writeFile(decisionsDir, "D-20260102-0000-drop.md", decisionFixture("消える判断"));
    writeFile(
      decisionsDir,
      "index.md",
      [
        "# 決定インデックス",
        "",
        "チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。",
        "",
        "- [ ] [D-20260101-0000-keep](D-20260101-0000-keep.md) — 残す判断",
        "- [x] [D-20260102-0000-drop](D-20260102-0000-drop.md) — 消える判断",
        "",
      ].join("\n"),
    );

    const result = rotate(agentDir);

    expect(result.decisions).toBe(1);
    expect(fs.existsSync(path.join(agentDir, "archive", "decisions", "D-20260102-0000-drop.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(decisionsDir, "D-20260102-0000-drop.md"))).toBe(false);
    expect(fs.existsSync(path.join(decisionsDir, "D-20260101-0000-keep.md"))).toBe(true);

    const text = readIndex(decisionsDir);
    expect(text).not.toContain("drop");
    expect(text).toContain("- [ ] [D-20260101-0000-keep](D-20260101-0000-keep.md) — 残す判断");
  });

  it("未チェックの決定はアーカイブされない", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));

    const result = rotate(agentDir);

    expect(result.decisions).toBe(0);
    expect(fs.existsSync(path.join(decisionsDir, "D-20260101-0000-a.md"))).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "archive", "decisions"))).toBe(false);
  });

  it("index.md 自身はリコンサイル対象・アーカイブ対象にならない", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));

    rotate(agentDir);

    const text = readIndex(decisionsDir);
    expect(text).not.toContain("index.md](index.md)");
    expect(fs.existsSync(path.join(agentDir, "archive", "decisions", "index.md"))).toBe(false);
  });

  it("実体ファイルが無い行が index.md から削除される", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));
    writeFile(
      decisionsDir,
      "index.md",
      [
        "# 決定インデックス",
        "",
        "チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。",
        "",
        "- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A",
        "- [ ] [D-20251231-0000-gone](D-20251231-0000-gone.md) — もう無い判断",
        "",
      ].join("\n"),
    );

    rotate(agentDir);

    const text = readIndex(decisionsDir);
    expect(text).not.toContain("gone");
    expect(text).toContain("D-20260101-0000-a");
  });

  it("既存のチェック状態と人間が書いた要約が維持される", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("frontmatter のタイトル"));
    writeFile(
      decisionsDir,
      "index.md",
      [
        "# 決定インデックス",
        "",
        "チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。",
        "",
        "- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 人間が書いた要約",
        "",
      ].join("\n"),
    );

    rotate(agentDir);

    const text = readIndex(decisionsDir);
    expect(text).toContain("- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 人間が書いた要約");
    expect(text).not.toContain("frontmatter のタイトル");
  });

  it("既存ヘッダ(人間が編集した説明文)が維持される", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));
    const customHeader = ["# カスタムヘッダ", "", "人間が追記した注意書き。", ""].join("\n");
    writeFile(
      decisionsDir,
      "index.md",
      [
        ...customHeader.split("\n"),
        "- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A",
        "",
      ].join("\n"),
    );

    rotate(agentDir);

    const text = readIndex(decisionsDir);
    expect(text.startsWith(customHeader)).toBe(true);
  });

  it("リストより後に人間が書いた文章(フッタ)が維持される", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));
    writeFile(decisionsDir, "D-20260102-0000-b.md", decisionFixture("判断 B"));
    const original =
      "# 決定インデックス\n\n説明\n\n" +
      "- [x] [D-20260102-0000-b](D-20260102-0000-b.md) — 判断 B\n" +
      "- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A\n" +
      "\n## 注記\n\nアーカイブ済みは archive/decisions/ を参照。\n";
    writeFile(decisionsDir, "index.md", original);

    expect(rotate(agentDir).decisions).toBe(1);

    const text = readIndex(decisionsDir);
    expect(text).toContain("## 注記\n\nアーカイブ済みは archive/decisions/ を参照。\n");
    expect(text).not.toContain("D-20260102-0000-b");
    // 2 回目は無変更(往復一致)
    expect(rotate(agentDir).decisions).toBe(0);
    expect(readIndex(decisionsDir)).toBe(text);
  });

  it("全件アーカイブしてリスト行が空になっても、次回以降ヘッダを書き換えない", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));
    const customHeader = "# カスタムヘッダ\n\n人間が追記した注意書き。\n\n";
    writeFile(
      decisionsDir,
      "index.md",
      customHeader + "- [x] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A\n",
    );

    expect(rotate(agentDir).decisions).toBe(1);
    const afterArchive = readIndex(decisionsDir);
    expect(afterArchive).toBe(customHeader);

    // リスト行が 1 行も無い状態でもう一度回してもヘッダは既定ヘッダに差し替えられない
    expect(rotate(agentDir).decisions).toBe(0);
    expect(readIndex(decisionsDir)).toBe(customHeader);
  });

  it("決定ファイルも index.md も無いとき index.md を作らない", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    fs.mkdirSync(decisionsDir, { recursive: true });

    const result = rotate(agentDir);

    expect(result.decisions).toBe(0);
    expect(fs.existsSync(path.join(decisionsDir, "index.md"))).toBe(false);
  });

  it("冪等性: 2 回目の rotate は全カウント 0、index.md も無変更", () => {
    const tasksDir = path.join(agentDir, "tasks");
    writeFile(tasksDir, "T-001.md", fixture("completed"));
    const hrDir = path.join(agentDir, "human-review");
    writeFile(hrDir, "HR-20260812-01.md", fixture("closed"));
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));
    writeFile(decisionsDir, "D-20260102-0000-b.md", decisionFixture("判断 B"));

    rotate(agentDir);
    const textAfterFirst = readIndex(decisionsDir);
    const mtimeAfterFirst = fs.statSync(path.join(decisionsDir, "index.md")).mtimeMs;

    const second = rotate(agentDir);
    const textAfterSecond = readIndex(decisionsDir);
    const mtimeAfterSecond = fs.statSync(path.join(decisionsDir, "index.md")).mtimeMs;

    expect(second).toEqual({ tasks: 0, decisions: 0, humanReview: 0 });
    expect(rotateResultIsEmpty(second)).toBe(true);
    expect(textAfterSecond).toBe(textAfterFirst);
    expect(mtimeAfterSecond).toBe(mtimeAfterFirst);
  });

  it("読めないエントリがあっても例外を投げず、そのファイルを対象外として続行する", () => {
    const tasksDir = path.join(agentDir, "tasks");
    writeFile(tasksDir, "T-001.md", fixture("completed"));
    // readFileSync が EISDIR で throw するように、同名の「ディレクトリ」を混ぜる
    fs.mkdirSync(path.join(tasksDir, "T-002.md"));

    const result = rotate(agentDir);

    expect(result.tasks).toBe(1);
    expect(fs.existsSync(path.join(agentDir, "archive", "tasks", "T-001.md"))).toBe(true);
    expect(fs.existsSync(path.join(tasksDir, "T-002.md"))).toBe(true);
  });

  it("ディレクトリが存在しない agentDir でも例外を投げず全カウント 0", () => {
    const emptyDir = path.join(agentDir, "does-not-exist");

    const result = rotate(emptyDir);

    expect(result).toEqual({ tasks: 0, decisions: 0, humanReview: 0 });
    expect(rotateResultIsEmpty(result)).toBe(true);
  });

  it("mergeDecisionsIndexText が生成した index.md は、実体と矛盾が無ければ rotate で書き換えられない", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    writeFile(decisionsDir, "D-20260101-0000-a.md", decisionFixture("判断 A"));
    writeFile(decisionsDir, "D-20260102-0000-b.md", decisionFixture("判断 B"));
    writeFile(decisionsDir, "D-20260103-0000-c.md", decisionFixture("判断 C"));

    // base(共通祖先)には a のみ。ours は b を新規追加、theirs は c を新規追加した状況を再現する。
    const base =
      DECISIONS_INDEX_DEFAULT_HEADER + "- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A\n";
    const ours =
      DECISIONS_INDEX_DEFAULT_HEADER +
      "- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A\n" +
      "- [ ] [D-20260102-0000-b](D-20260102-0000-b.md) — 判断 B\n";
    const theirs =
      DECISIONS_INDEX_DEFAULT_HEADER +
      "- [ ] [D-20260101-0000-a](D-20260101-0000-a.md) — 判断 A\n" +
      "- [ ] [D-20260103-0000-c](D-20260103-0000-c.md) — 判断 C\n";

    const merged = mergeDecisionsIndexText(base, ours, theirs);
    if (merged === null) throw new Error("この base/ours/theirs はコンフリクトせずマージできるはず");

    writeFile(decisionsDir, "index.md", merged);

    const result = rotate(agentDir);

    expect(result.decisions).toBe(0);
    expect(readIndex(decisionsDir)).toBe(merged);
    expect(fs.existsSync(path.join(agentDir, "archive", "decisions"))).toBe(false);
  });
});
