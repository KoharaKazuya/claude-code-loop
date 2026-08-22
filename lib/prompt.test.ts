import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaths } from "./paths.ts";
import { buildSystemPrompt, commonPromptPath, generateSystemPrompt, LOCAL_RULES_HEADING } from "./prompt.ts";

describe("commonPromptPath", () => {
  it("CCLOOP_HOME 配下の prompt/PROMPT.md を指し、実体が同梱されている", () => {
    const file = commonPromptPath(import.meta.dirname);

    expect(file).toBe(path.join(import.meta.dirname, "prompt", "PROMPT.md"));
    expect(fs.readFileSync(file, "utf8")).toContain("自律実行セッション共通ルール");
  });
});

describe("buildSystemPrompt", () => {
  it("PROMPT.local.md が無ければ共通ルールだけを返す", () => {
    expect(buildSystemPrompt("共通ルール\n", null)).toBe("共通ルール\n");
  });

  it("空白だけの PROMPT.local.md は見出しごと足さない", () => {
    expect(buildSystemPrompt("共通ルール\n", "   \n\n")).toBe("共通ルール\n");
  });

  it("PROMPT.local.md があれば区切りの見出し付きで後ろに連結する", () => {
    const out = buildSystemPrompt("共通ルール\n", "# 追加\n\nこのリポジトリでは npm を使う\n");

    expect(out).toBe(
      ["共通ルール", "", "---", "", LOCAL_RULES_HEADING, "", "# 追加", "", "このリポジトリでは npm を使う", ""].join("\n"),
    );
    expect(out.indexOf("共通ルール")).toBeLessThan(out.indexOf(LOCAL_RULES_HEADING));
  });
});

describe("generateSystemPrompt", () => {
  let repo: string;
  let home: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-prompt-repo-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-prompt-home-"));
    fs.mkdirSync(path.join(home, "prompt"), { recursive: true });
    fs.writeFileSync(path.join(home, "prompt", "PROMPT.md"), "# 共通ルール\n");
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("state ディレクトリへ書き出し、そのパスを返す(リポジトリは汚さない)", () => {
    const paths = createPaths(repo);

    const out = generateSystemPrompt(paths, { home });

    expect(out).toBe(paths.generatedSystemPromptPath);
    expect(out.startsWith(paths.stateDir + path.sep)).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toBe("# 共通ルール\n");
    expect(fs.existsSync(path.join(repo, ".agent", "PROMPT.md"))).toBe(false);
  });

  it("PROMPT.local.md があれば連結される", () => {
    const paths = createPaths(repo);
    fs.writeFileSync(paths.promptLocalPath, "ローカル規約\n");

    const text = fs.readFileSync(generateSystemPrompt(paths, { home }), "utf8");

    expect(text).toContain("# 共通ルール");
    expect(text).toContain(LOCAL_RULES_HEADING);
    expect(text).toContain("ローカル規約");
  });

  it("生成し直すと前回の内容を残さない", () => {
    const paths = createPaths(repo);
    fs.writeFileSync(paths.promptLocalPath, "古い規約\n");
    generateSystemPrompt(paths, { home });

    fs.rmSync(paths.promptLocalPath);
    const text = fs.readFileSync(generateSystemPrompt(paths, { home }), "utf8");

    expect(text).not.toContain("古い規約");
  });
});
