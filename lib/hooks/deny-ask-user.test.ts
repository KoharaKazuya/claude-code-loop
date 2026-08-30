import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// この hook は「AskUserQuestion を必ず deny し、続行方法を示す」という一点だけが役割。
// キー名・値がわずかにずれると Claude Code に無視され、無音で無効化される
// (無人セッションが人間の回答待ちのまま停止する)ため、キー名と値を厳密に検証する。
const SCRIPT = path.join(import.meta.dirname, "deny-ask-user.ts");

const ASK_USER_PAYLOAD = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "続行しますか?", options: ["はい", "いいえ"] }] },
});

function runDenyAskUser(input: string): { status: number | null; stdout: string } {
  const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", SCRIPT], {
    input,
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout };
}

describe("deny-ask-user hook", () => {
  it.each([
    ["AskUserQuestion 相当の PreToolUse ペイロード", ASK_USER_PAYLOAD],
    ["空の stdin", ""],
  ])("%s でも exit 0 で、Claude Code が要求する PreToolUse deny の形を厳密に満たす", (_label, input) => {
    const { status, stdout } = runDenyAskUser(input);
    expect(status).toBe(0);

    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) throw new Error("stdout is not an object");
    const obj = parsed as Record<string, unknown>;

    // トップレベルに余計なキーが増える/減ると PreToolUse の解釈が変わりうるため厳密一致
    expect(Object.keys(obj)).toEqual(["hookSpecificOutput"]);

    const out = obj.hookSpecificOutput as Record<string, unknown>;
    expect(out.hookEventName).toBe("PreToolUse");
    expect(out.permissionDecision).toBe("deny");

    const reason = out.permissionDecisionReason;
    expect(typeof reason).toBe("string");
    expect((reason as string).length).toBeGreaterThan(0);
    // 継続方法(.agent/human-review/ への記録)が示されていないと、モデルが人間の回答待ちで
    // 停止する以外の選択肢を知らないままになる
    expect(reason as string).toContain(".agent/human-review/");
  });

  it("入力が変わっても出力(stdout)は完全に同一(この hook は入力に依存せず必ず deny する契約)", () => {
    const withAskUser = runDenyAskUser(ASK_USER_PAYLOAD);
    const withEmptyInput = runDenyAskUser("");
    expect(withAskUser.stdout).toBe(withEmptyInput.stdout);
  });
});
