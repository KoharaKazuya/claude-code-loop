import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, defaultWorktreeDir, loadConfigFrom, normalizeConfig, validateConfig } from "./config.ts";
import { V1_DEFAULTS } from "./migrations.ts";
import { stateDirFor } from "./paths.ts";

/** このリポジトリのルート(lib/ の 1 つ上) */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * `validateConfig` / `normalizeConfig` が要求する項目をすべて満たした raw を作る。
 * escalation / triage / parallel は検査対象外(escalation はキー自体が無いのが正常、
 * triage / parallel は既存の寛容な既定値埋めのまま)なので含めない。個々のテストで
 * 上書きしたい項目だけ overrides で渡す。
 */
function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claudeCommand: "claude",
    model: "opus",
    permissionMode: "auto",
    maxRetries: 3,
    taskTimeoutMs: 2400000,
    maxTurns: 150,
    rateLimit: { backoffMs: 300000 },
    explore: { enabled: true, minIntervalMs: 3600000 },
    idlePollMs: 60000,
    ...overrides,
  };
}

describe("defaultWorktreeDir", () => {
  it("state ディレクトリ配下の worktrees を指す(リポジトリの隣には作らない)", () => {
    const root = REPO_ROOT;
    expect(defaultWorktreeDir(root)).toBe(path.join(stateDirFor(root), "worktrees"));
  });
});

describe("defaultConfig", () => {
  it("V1_DEFAULTS と食い違わない(parallel.worktreeDir / linkPaths は root 依存のため除く)", () => {
    const config = defaultConfig(REPO_ROOT);

    expect(config.claudeCommand).toEqual(V1_DEFAULTS.claudeCommand);
    expect(config.model).toEqual(V1_DEFAULTS.model);
    expect(config.escalation).toEqual(V1_DEFAULTS.escalation);
    expect(config.permissionMode).toEqual(V1_DEFAULTS.permissionMode);
    expect(config.maxRetries).toEqual(V1_DEFAULTS.maxRetries);
    expect(config.taskTimeoutMs).toEqual(V1_DEFAULTS.taskTimeoutMs);
    expect(config.maxTurns).toEqual(V1_DEFAULTS.maxTurns);
    expect(config.rateLimit).toEqual(V1_DEFAULTS.rateLimit);
    expect(config.explore).toEqual(V1_DEFAULTS.explore);
    expect(config.triage).toEqual(V1_DEFAULTS.triage);
    expect(config.idlePollMs).toEqual(V1_DEFAULTS.idlePollMs);
    expect(config.parallel.maxSessions).toEqual((V1_DEFAULTS.parallel as { maxSessions: number }).maxSessions);
  });

  it("雛形 config.json とも食い違わない", () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "lib", "templates", "agent", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const config = defaultConfig(REPO_ROOT);

    expect(config.claudeCommand).toEqual(template.claudeCommand);
    expect(config.model).toEqual(template.model);
    expect(config.escalation).toEqual(template.escalation);
    expect(config.permissionMode).toEqual(template.permissionMode);
    expect(config.maxRetries).toEqual(template.maxRetries);
    expect(config.taskTimeoutMs).toEqual(template.taskTimeoutMs);
    expect(config.maxTurns).toEqual(template.maxTurns);
    expect(config.rateLimit).toEqual(template.rateLimit);
    expect(config.explore).toEqual(template.explore);
    expect(config.triage).toEqual(template.triage);
    expect(config.idlePollMs).toEqual(template.idlePollMs);
    expect(config.parallel.maxSessions).toEqual((template.parallel as { maxSessions: number }).maxSessions);
  });
});

describe("validateConfig", () => {
  it("正常な config なら空配列", () => {
    expect(validateConfig(validRaw())).toEqual([]);
  });

  it("escalation キーが無くても問題にしない(無効化した既定値を使う既存挙動を維持するため)", () => {
    expect(validateConfig(validRaw())).toEqual([]);
  });

  it("raw がオブジェクトでなければその旨 1 件だけ返す", () => {
    expect(validateConfig(null)).toHaveLength(1);
    expect(validateConfig("nope")).toHaveLength(1);
    expect(validateConfig([1, 2])).toHaveLength(1);
  });

  it("文字列項目が欠損していれば問題として挙がる", () => {
    const raw = validRaw();
    delete raw.claudeCommand;
    const issues = validateConfig(raw);
    expect(issues.some((m) => m.includes("claudeCommand"))).toBe(true);
    expect(issues.some((m) => m.includes("項目が無い"))).toBe(true);
  });

  it("文字列項目が空文字なら問題として挙がる", () => {
    const issues = validateConfig(validRaw({ model: "" }));
    expect(issues.some((m) => m.includes("model"))).toBe(true);
  });

  it("数値項目が文字列なら問題として挙がる", () => {
    const issues = validateConfig(validRaw({ maxTurns: "150" }));
    expect(issues.some((m) => m.includes("maxTurns"))).toBe(true);
  });

  it("数値項目が範囲外(0 や負数)なら問題として挙がる", () => {
    expect(validateConfig(validRaw({ maxTurns: 0 })).some((m) => m.includes("maxTurns"))).toBe(true);
    expect(validateConfig(validRaw({ maxRetries: -1 })).some((m) => m.includes("maxRetries"))).toBe(true);
    expect(validateConfig(validRaw({ taskTimeoutMs: 0 })).some((m) => m.includes("taskTimeoutMs"))).toBe(true);
    expect(validateConfig(validRaw({ idlePollMs: 0 })).some((m) => m.includes("idlePollMs"))).toBe(true);
  });

  it("数値項目が非整数(小数)なら問題として挙がる", () => {
    expect(validateConfig(validRaw({ maxRetries: 1.5 })).some((m) => m.includes("maxRetries"))).toBe(true);
  });

  it("真偽値項目が文字列なら問題として挙がる", () => {
    const issues = validateConfig(validRaw({ explore: { enabled: "yes", minIntervalMs: 3600000 } }));
    expect(issues.some((m) => m.includes("explore.enabled"))).toBe(true);
  });

  it("ネストしたオブジェクト項目が欠損していれば問題として挙がる", () => {
    const raw = validRaw();
    delete raw.rateLimit;
    const issues = validateConfig(raw);
    expect(issues.some((m) => m.includes("rateLimit"))).toBe(true);
  });

  it("ネストしたオブジェクト項目の中身が不正なら問題として挙がる", () => {
    const issues = validateConfig(validRaw({ rateLimit: { backoffMs: -1 } }));
    expect(issues.some((m) => m.includes("rateLimit.backoffMs"))).toBe(true);
  });

  it("escalation の内側の型が不正なら問題として挙がる", () => {
    const issues = validateConfig(validRaw({ escalation: { model: 1, afterRetries: -1 } }));
    expect(issues.some((m) => m.includes("escalation.model"))).toBe(true);
    expect(issues.some((m) => m.includes("escalation.afterRetries"))).toBe(true);
  });

  it("escalation.model は空文字を許可する(エスカレーション無効の意味)", () => {
    const issues = validateConfig(validRaw({ escalation: { model: "", afterRetries: 2 } }));
    expect(issues).toEqual([]);
  });

  it("escalation がオブジェクトでなければ問題として挙がる", () => {
    const issues = validateConfig(validRaw({ escalation: "opus" }));
    expect(issues.some((m) => m.includes("escalation"))).toBe(true);
  });

  it("triage / parallel / schemaVersion は検査しない(既存の寛容な正規化に任せる)", () => {
    const issues = validateConfig(validRaw({ triage: "broken", parallel: 123, schemaVersion: "x" }));
    expect(issues).toEqual([]);
  });
});

describe("normalizeConfig", () => {
  const root = REPO_ROOT;

  it("parallel が無い既存の config.json 形式は既定値で埋める", () => {
    const raw = validRaw({ escalation: { model: "claude-fable-5", afterRetries: 2 } });

    const config = normalizeConfig(raw, root);

    expect(config.parallel).toEqual({
      maxSessions: 1,
      worktreeDir: defaultWorktreeDir(root),
      linkPaths: ["node_modules"],
    });
    // 既存フィールドは変更されない
    expect(config.claudeCommand).toBe("claude");
    expect(config.model).toBe("opus");
    expect(config.escalation).toEqual({ model: "claude-fable-5", afterRetries: 2 });
    expect(config.maxRetries).toBe(3);
  });

  it("maxSessions は 1..8 にクランプする(上限超過)", () => {
    const config = normalizeConfig(validRaw({ parallel: { maxSessions: 100 } }), root);
    expect(config.parallel.maxSessions).toBe(8);
  });

  it("maxSessions は 1..8 にクランプする(下限未満)", () => {
    const config = normalizeConfig(validRaw({ parallel: { maxSessions: 0 } }), root);
    expect(config.parallel.maxSessions).toBe(1);
  });

  it("maxSessions が数値でなければ既定の1にする", () => {
    const config = normalizeConfig(validRaw({ parallel: { maxSessions: "3" } }), root);
    expect(config.parallel.maxSessions).toBe(1);
  });

  it("escalation が欠損していれば無効化した既定値を使う", () => {
    const config = normalizeConfig(validRaw(), root);
    expect(config.escalation).toEqual({ model: "", afterRetries: Infinity });
  });

  it("worktreeDir / linkPaths を明示すればそれを使う", () => {
    const config = normalizeConfig(
      validRaw({ parallel: { maxSessions: 2, worktreeDir: "/custom/dir", linkPaths: ["node_modules", ".venv"] } }),
      root,
    );
    expect(config.parallel).toEqual({
      maxSessions: 2,
      worktreeDir: "/custom/dir",
      linkPaths: ["node_modules", ".venv"],
    });
  });

  it("worktreeDir が相対パスなら root 基準で正規化する(hook と本体で解決結果を一致させるため)", () => {
    const config = normalizeConfig(validRaw({ parallel: { worktreeDir: "../sibling-worktrees" } }), root);

    expect(config.parallel.worktreeDir).toBe(path.resolve(root, "../sibling-worktrees"));
    expect(path.isAbsolute(config.parallel.worktreeDir)).toBe(true);
  });

  // 実ファイルを通す。config.json の書き間違い(parallel の位置ずれ・型違い)は
  // 既定値 1 に落ちて静かに並列実行が無効化されるため、ここで検出する
  it("実際の .agent/config.json から並列度を読み取れる", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".agent", "config.json"), "utf8")) as unknown;

    const config = normalizeConfig(raw, REPO_ROOT);

    expect(config.parallel.maxSessions).toBe(4);
  });

  it("triage が無い既存の config.json 形式は既定値(enabled: true, model: haiku)で埋める", () => {
    const config = normalizeConfig(validRaw(), root);
    expect(config.triage).toEqual({ enabled: true, model: "haiku" });
  });

  it("triage.enabled / triage.model を明示すればそれを使う", () => {
    const config = normalizeConfig(validRaw({ triage: { enabled: false, model: "opus" } }), root);
    expect(config.triage).toEqual({ enabled: false, model: "opus" });
  });

  it("triage.model が空文字・非文字列なら既定の haiku にする", () => {
    expect(normalizeConfig(validRaw({ triage: { model: "" } }), root).triage.model).toBe("haiku");
    expect(normalizeConfig(validRaw({ triage: { model: 1 } }), root).triage.model).toBe("haiku");
  });

  it("不正な config は例外を投げ、メッセージに問題の項目名を含む", () => {
    const raw = validRaw({ maxTurns: "150", claudeCommand: "" });
    expect(() => normalizeConfig(raw, root)).toThrow(/maxTurns/);
    expect(() => normalizeConfig(raw, root)).toThrow(/claudeCommand/);
  });

  it("raw がオブジェクトでなければ例外を投げる", () => {
    expect(() => normalizeConfig(null, root)).toThrow();
    expect(() => normalizeConfig("broken", root)).toThrow();
  });

  it("例外メッセージは複数行で .agent/config.json のパスを含む", () => {
    try {
      normalizeConfig(validRaw({ maxTurns: 0 }), root);
      expect.unreachable("normalizeConfig が例外を投げなかった");
    } catch (err) {
      const message = String((err as Error).message);
      expect(message).toContain(".agent/config.json");
      expect(message.split("\n").length).toBeGreaterThan(1);
    }
  });
});

describe("loadConfigFrom", () => {
  it("リポジトリの .agent/config.json を読んで正規化する(hook と Supervisor が同じ値を得る)", () => {
    const config = loadConfigFrom(REPO_ROOT);

    expect(config.parallel.maxSessions).toBe(4);
    expect(config.parallel.worktreeDir).toBe(defaultWorktreeDir(REPO_ROOT));
  });

  it("config.json が無いリポジトリでも例外を投げず既定値(defaultConfig)を返す(hook を落とさない)", () => {
    const root = path.join(REPO_ROOT, "does-not-exist");

    const config = loadConfigFrom(root);

    expect(config).toEqual(defaultConfig(root));
    expect(config.parallel.linkPaths).toEqual(["node_modules"]);
  });

  it("config.json が JSON として壊れている場合は例外を投げる", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-config-test-"));
    fs.mkdirSync(path.join(dir, ".agent"));
    fs.writeFileSync(path.join(dir, ".agent", "config.json"), "{ broken json");

    try {
      expect(() => loadConfigFrom(dir)).toThrow(/JSON として読めない/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
