import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CheckResult, collectChecks, formatCheck, hasRequiredFailure, type ProbeFn } from "./doctor.ts";
import { applyInit, planInit } from "./init.ts";
import { createPaths, type Paths } from "./paths.ts";

const HOME = import.meta.dirname;

/** 全コマンドが存在する環境を模した probe */
const okProbe: ProbeFn = (command) => ({ ok: true, output: `${command} 1.2.3` });

function find(results: CheckResult[], prefix: string): CheckResult {
  const hit = results.find((r) => r.name.startsWith(prefix));
  if (hit === undefined) throw new Error(`項目が無い: ${prefix}`);
  return hit;
}

describe("collectChecks", () => {
  let repo: string;
  let paths: Paths;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-doctor-"));
    paths = createPaths(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("整った環境では全項目が ✓ になる", () => {
    applyInit(paths, planInit(paths, HOME));

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe });

    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(hasRequiredFailure(results)).toBe(false);
    for (const name of ["対象リポジトリ", "git", "node", "claude", ".agent/", "state ディレクトリ", "CCLOOP_HOME"]) {
      expect(find(results, name).ok).toBe(true);
    }
  });

  it("claude が無ければ ✗ になり、終了コード 1 の条件を満たす", () => {
    applyInit(paths, planInit(paths, HOME));
    const probe: ProbeFn = (command) =>
      command === "git" ? { ok: true, output: "git version 2.43.0" } : { ok: false, output: "ENOENT" };

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe });

    expect(find(results, "claude").ok).toBe(false);
    expect(hasRequiredFailure(results)).toBe(true);
  });

  it("Node が古ければ ✗ になる", () => {
    applyInit(paths, planInit(paths, HOME));

    const results = collectChecks({ paths, home: HOME, nodeVersion: "22.17.1", probe: okProbe });

    expect(find(results, "node").ok).toBe(false);
    expect(find(results, "node").detail).toContain("22.18");
  });

  it(".agent/ が未配置なら ✗ と ccloop init の案内を出し、勝手に配置しない", () => {
    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe });

    const agent = find(results, ".agent/");
    expect(agent.ok).toBe(false);
    expect(agent.detail).toContain("ccloop init");
    expect(fs.existsSync(paths.goalPath)).toBe(false);
  });

  it("schemaVersion がツールより新しければ ✗ と更新の案内を出す", () => {
    applyInit(paths, planInit(paths, HOME));
    fs.writeFileSync(paths.configPath, JSON.stringify({ schemaVersion: 99 }) + "\n");

    const agent = find(collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe }), ".agent/");

    expect(agent.ok).toBe(false);
    expect(agent.detail).toContain("ccloop を更新");
  });

  it("schemaVersion が古ければ ✗ と --upgrade の案内を出す", () => {
    applyInit(paths, planInit(paths, HOME));
    fs.writeFileSync(paths.configPath, JSON.stringify({ model: "opus" }) + "\n");

    const agent = find(collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe }), ".agent/");

    expect(agent.ok).toBe(false);
    expect(agent.detail).toContain("ccloop init --upgrade");
  });

  it("config.json が無くても claude を診断できる(claudeCommand の既定へ落ちる)", () => {
    const probed: string[] = [];
    const probe: ProbeFn = (command) => {
      probed.push(command);
      return { ok: true, output: "1.0.0" };
    };

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe });

    expect(probed).toContain("claude");
    expect(find(results, "claude").name).toBe("claude (claude)");
  });

  it("CCLOOP_HOME に cli.ts が無ければ ✗ になる", () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-doctor-home-"));
    try {
      const results = collectChecks({ paths, home: broken, nodeVersion: "24.0.0", probe: okProbe });
      expect(find(results, "CCLOOP_HOME").ok).toBe(false);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
  });

  it("リポジトリを特定できなくても診断結果を返す", () => {
    const results = collectChecks({
      paths: null,
      repoError: ".git が見つからない",
      home: HOME,
      nodeVersion: "24.0.0",
      probe: okProbe,
    });

    expect(find(results, "対象リポジトリ").ok).toBe(false);
    expect(find(results, "対象リポジトリ").detail).toBe(".git が見つからない");
    expect(find(results, "git").ok).toBe(true);
    expect(hasRequiredFailure(results)).toBe(true);
  });

  it("config の claudeCommand を差し替えるとそのコマンドを診断する", () => {
    applyInit(paths, planInit(paths, HOME));
    fs.writeFileSync(paths.configPath, JSON.stringify({ schemaVersion: 1, claudeCommand: "my-claude" }) + "\n");
    const probed: string[] = [];
    const probe: ProbeFn = (command) => {
      probed.push(command);
      return { ok: true, output: "1.0.0" };
    };

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe });

    expect(probed).toContain("my-claude");
    expect(find(results, "claude").name).toBe("claude (my-claude)");
  });
});

describe("formatCheck", () => {
  it("✓ / ✗ と一言を並べる", () => {
    expect(formatCheck({ name: "git", ok: true, detail: "git version 2.43.0", required: true })).toBe(
      "✓ git: git version 2.43.0",
    );
    expect(formatCheck({ name: "claude", ok: false, detail: "見つからない", required: true })).toBe(
      "✗ claude: 見つからない",
    );
  });
});

describe("hasRequiredFailure", () => {
  it("必須でない項目の ✗ は終了コードに影響しない", () => {
    expect(hasRequiredFailure([{ name: "x", ok: false, detail: "", required: false }])).toBe(false);
  });
});
