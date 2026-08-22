import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotate, rotateResultIsEmpty } from "./rotate.ts";

function fixture(status: string, body = "本文"): string {
  return `---\nstatus: ${status}\n---\n${body}`;
}

function writeFile(dir: string, fileName: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
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

  it("decisions が 10 件以下なら移動しない", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    for (let i = 1; i <= 10; i++) {
      const id = `D-20260812-${String(i).padStart(2, "0")}`;
      writeFile(decisionsDir, `${id}.md`, fixture("open"));
    }

    const result = rotate(agentDir);

    expect(result.decisions).toBe(0);
    expect(listNames(decisionsDir)).toHaveLength(10);
  });

  it("decisions が 12 件あるとき古い 2 件が移動し、新しい 10 件が残る", () => {
    const decisionsDir = path.join(agentDir, "decisions");
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const id = `D-20260812-${String(i).padStart(2, "0")}`;
      ids.push(id);
      writeFile(decisionsDir, `${id}.md`, fixture("open"));
    }

    const result = rotate(agentDir);

    expect(result.decisions).toBe(2);
    const archiveDir = path.join(agentDir, "archive", "decisions");
    expect(listNames(archiveDir)).toEqual([`${ids[0]}.md`, `${ids[1]}.md`]);
    expect(listNames(decisionsDir)).toEqual(ids.slice(2).map((id) => `${id}.md`));
  });

  it("冪等性: 2 回目の rotate は全カウント 0", () => {
    const tasksDir = path.join(agentDir, "tasks");
    writeFile(tasksDir, "T-001.md", fixture("completed"));
    const hrDir = path.join(agentDir, "human-review");
    writeFile(hrDir, "HR-20260812-01.md", fixture("closed"));
    const decisionsDir = path.join(agentDir, "decisions");
    for (let i = 1; i <= 12; i++) {
      writeFile(decisionsDir, `D-20260812-${String(i).padStart(2, "0")}.md`, fixture("open"));
    }

    rotate(agentDir);
    const second = rotate(agentDir);

    expect(second).toEqual({ tasks: 0, decisions: 0, humanReview: 0 });
    expect(rotateResultIsEmpty(second)).toBe(true);
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
});

function listNames(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}
