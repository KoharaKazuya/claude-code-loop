import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentsArgs, agentsDir, clearAgentsCache, loadAgentDefinitions, parseAgentFile } from "./agents.ts";

describe("parseAgentFile", () => {
  it("frontmatter と本文から --agents の 1 件分を組み立てる", () => {
    const text = [
      "---",
      "name: reviewer",
      "description: レビュー担当",
      "tools: Read, Glob, Grep, Bash",
      "model: sonnet",
      "---",
      "",
      "あなたはレビュアーである。",
    ].join("\n");

    expect(parseAgentFile(text, "fallback")).toEqual({
      name: "reviewer",
      definition: {
        description: "レビュー担当",
        prompt: "あなたはレビュアーである。",
        tools: ["Read", "Glob", "Grep", "Bash"],
        model: "sonnet",
      },
    });
  });

  it("tools がインライン配列でも配列へ正規化する", () => {
    const text = ["---", "description: d", "tools: [Read, Bash]", "---", "", "本文"].join("\n");

    expect(parseAgentFile(text, "x")?.definition.tools).toEqual(["Read", "Bash"]);
  });

  it("tools / model が無ければフィールドごと省く(claude 側の既定に委ねる)", () => {
    const text = ["---", "description: d", "---", "", "本文"].join("\n");

    expect(parseAgentFile(text, "x")?.definition).toEqual({ description: "d", prompt: "本文" });
  });

  it("name が無ければファイル名を使う", () => {
    const text = ["---", "description: d", "---", "", "本文"].join("\n");

    expect(parseAgentFile(text, "helper")?.name).toBe("helper");
  });

  it("description か本文が欠けているものは定義として採らない", () => {
    expect(parseAgentFile(["---", "description: d", "---", ""].join("\n"), "x")).toBeNull();
    expect(parseAgentFile(["---", "name: x", "---", "", "本文"].join("\n"), "x")).toBeNull();
    expect(parseAgentFile("frontmatter なし", "x")).toBeNull();
  });
});

describe("loadAgentDefinitions", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-agents-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ディレクトリ内の全 .md を読む(将来の追加に対応する)", () => {
    fs.writeFileSync(path.join(dir, "a.md"), ["---", "description: A", "---", "", "本文 A"].join("\n"));
    fs.writeFileSync(path.join(dir, "b.md"), ["---", "description: B", "---", "", "本文 B"].join("\n"));
    fs.writeFileSync(path.join(dir, "README.txt"), "無視される");

    expect(Object.keys(loadAgentDefinitions(dir)).sort()).toEqual(["a", "b"]);
  });

  it("ディレクトリが無ければ空(サブエージェント無しで起動する)", () => {
    expect(loadAgentDefinitions(path.join(dir, "missing"))).toEqual({});
  });

  it("壊れたファイルは飛ばし、残りは読む", () => {
    fs.writeFileSync(path.join(dir, "broken.md"), "description も本文も無い");
    fs.writeFileSync(path.join(dir, "ok.md"), ["---", "description: OK", "---", "", "本文"].join("\n"));

    expect(Object.keys(loadAgentDefinitions(dir))).toEqual(["ok"]);
  });
});

describe("同梱の lib/agents/reviewer.md", () => {
  it("reviewer が定義として成立している", () => {
    const defs = loadAgentDefinitions(agentsDir(import.meta.dirname));

    expect(defs.reviewer).toBeDefined();
    expect(defs.reviewer!.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(defs.reviewer!.model).toBe("sonnet");
  });
});

describe("agentsArgs", () => {
  beforeEach(() => {
    clearAgentsCache();
  });

  afterEach(() => {
    clearAgentsCache();
  });

  it("定義があれば --agents と JSON を返す", () => {
    const args = agentsArgs(import.meta.dirname);

    expect(args[0]).toBe("--agents");
    expect(JSON.parse(args[1]!)).toHaveProperty("reviewer");
  });

  it("定義が 1 件も無ければフラグごと付けない", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-agents-empty-"));
    try {
      expect(agentsArgs(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
