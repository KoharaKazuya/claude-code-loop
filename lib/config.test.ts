import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorktreeDir, loadConfigFrom, normalizeConfig } from "./config.ts";
import { stateDirFor } from "./paths.ts";

/** このリポジトリのルート(lib/ の 1 つ上) */
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("defaultWorktreeDir", () => {
  it("state ディレクトリ配下の worktrees を指す(リポジトリの隣には作らない)", () => {
    const root = REPO_ROOT;
    expect(defaultWorktreeDir(root)).toBe(path.join(stateDirFor(root), "worktrees"));
  });
});

describe("normalizeConfig", () => {
  const root = REPO_ROOT;

  it("parallel が無い既存の config.json 形式は既定値で埋める", () => {
    const raw = {
      claudeCommand: "claude",
      model: "opus",
      escalation: { model: "claude-fable-5", afterRetries: 2 },
      permissionMode: "auto",
      maxRetries: 3,
      taskTimeoutMs: 2400000,
      maxTurns: 150,
      rateLimit: { backoffMs: 300000 },
      explore: { enabled: true, minIntervalMs: 3600000 },
      idlePollMs: 60000,
    };

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
    const config = normalizeConfig({ parallel: { maxSessions: 100 } }, root);
    expect(config.parallel.maxSessions).toBe(8);
  });

  it("maxSessions は 1..8 にクランプする(下限未満)", () => {
    const config = normalizeConfig({ parallel: { maxSessions: 0 } }, root);
    expect(config.parallel.maxSessions).toBe(1);
  });

  it("maxSessions が数値でなければ既定の1にする", () => {
    const config = normalizeConfig({ parallel: { maxSessions: "3" } }, root);
    expect(config.parallel.maxSessions).toBe(1);
  });

  it("escalation が欠損していれば無効化した既定値を使う", () => {
    const config = normalizeConfig({}, root);
    expect(config.escalation).toEqual({ model: "", afterRetries: Infinity });
  });

  it("worktreeDir / linkPaths を明示すればそれを使う", () => {
    const config = normalizeConfig(
      { parallel: { maxSessions: 2, worktreeDir: "/custom/dir", linkPaths: ["node_modules", ".venv"] } },
      root,
    );
    expect(config.parallel).toEqual({
      maxSessions: 2,
      worktreeDir: "/custom/dir",
      linkPaths: ["node_modules", ".venv"],
    });
  });

  it("worktreeDir が相対パスなら root 基準で正規化する(hook と本体で解決結果を一致させるため)", () => {
    const config = normalizeConfig({ parallel: { worktreeDir: "../sibling-worktrees" } }, root);

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
    const config = normalizeConfig({}, root);
    expect(config.triage).toEqual({ enabled: true, model: "haiku" });
  });

  it("triage.enabled / triage.model を明示すればそれを使う", () => {
    const config = normalizeConfig({ triage: { enabled: false, model: "opus" } }, root);
    expect(config.triage).toEqual({ enabled: false, model: "opus" });
  });

  it("triage.model が空文字・非文字列なら既定の haiku にする", () => {
    expect(normalizeConfig({ triage: { model: "" } }, root).triage.model).toBe("haiku");
    expect(normalizeConfig({ triage: { model: 1 } }, root).triage.model).toBe("haiku");
  });
});

describe("loadConfigFrom", () => {
  it("リポジトリの .agent/config.json を読んで正規化する(hook と Supervisor が同じ値を得る)", () => {
    const config = loadConfigFrom(REPO_ROOT);

    expect(config.parallel.maxSessions).toBe(4);
    expect(config.parallel.worktreeDir).toBe(defaultWorktreeDir(REPO_ROOT));
  });

  it("config.json が無いリポジトリでも例外を投げず既定値を返す(hook を落とさない)", () => {
    const root = path.join(REPO_ROOT, "does-not-exist");

    const config = loadConfigFrom(root);

    expect(config.parallel.maxSessions).toBe(1);
    expect(config.parallel.linkPaths).toEqual(["node_modules"]);
  });
});
