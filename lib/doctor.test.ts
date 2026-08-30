import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CheckResult,
  checkClaudeAuth,
  collectChecks,
  type CommandProbe,
  formatCheck,
  hasRequiredFailure,
  probeCommand,
  type ProbeFn,
} from "./doctor.ts";
import { applyInit, planInit } from "./init.ts";
import { AGENT_DIR_NAME, createPaths, type Paths } from "./paths.ts";

const HOME = import.meta.dirname;

/** 全コマンドが存在する環境を模した probe(ログイン済みの `claude auth status --json` も含む) */
const okProbe: ProbeFn = (command, args) => {
  if (args[0] === "auth") {
    const stdout = JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
    return { ok: true, output: stdout, stdout };
  }
  return { ok: true, output: `${command} 1.2.3` };
};

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
    for (const name of [
      "対象リポジトリ",
      "git",
      "node",
      "claude",
      "claude ログイン状態",
      ".agent/",
      "state ディレクトリ",
      "CCLOOP_HOME",
    ]) {
      expect(find(results, name).ok).toBe(true);
    }
  });

  it("claude の --version probe が失敗すればログイン状態の項目は現れない", () => {
    applyInit(paths, planInit(paths, HOME));
    const probe: ProbeFn = (command) =>
      command === "git" ? { ok: true, output: "git version 2.43.0" } : { ok: false, output: "ENOENT" };

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe });

    expect(results.some((r) => r.name === "claude ログイン状態")).toBe(false);
  });

  it("claude の --version probe が成功すればログイン状態の項目が現れる", () => {
    applyInit(paths, planInit(paths, HOME));

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe, env: {} });

    expect(results.some((r) => r.name === "claude ログイン状態")).toBe(true);
  });

  it("claude が無ければ ✗ になり、終了コード 1 の条件を満たす", () => {
    applyInit(paths, planInit(paths, HOME));
    const probe: ProbeFn = (command) =>
      command === "git" ? { ok: true, output: "git version 2.43.0" } : { ok: false, output: "ENOENT" };

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe });

    expect(find(results, "claude").ok).toBe(false);
    expect(hasRequiredFailure(results)).toBe(true);
  });

  it("claude が起動できるが非ゼロ終了なら「見つからない」ではなく実行失敗として表示する", () => {
    applyInit(paths, planInit(paths, HOME));
    const probe: ProbeFn = (command) =>
      command === "git"
        ? { ok: true, output: "git version 2.43.0" }
        : { ok: false, output: "何か失敗した", failure: "exit", exitCode: 3 };

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe });

    const claude = find(results, "claude");
    expect(claude.ok).toBe(false);
    expect(claude.detail).toContain("実行できたが失敗した(exit 3)");
    expect(claude.detail).toContain("何か失敗した");
    expect(claude.detail).not.toContain("見つからない");
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

  it("config.json が壊れていれば「手で修正すること」の案内を出す", () => {
    applyInit(paths, planInit(paths, HOME));
    fs.writeFileSync(paths.configPath, "{ broken json");

    const agent = find(collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe }), ".agent/");

    expect(agent.ok).toBe(false);
    expect(agent.detail).toContain("読めない");
    expect(agent.detail).toContain("手で修正すること");
  });

  it("config.json の項目が不正でも doctor は落ちず、失敗したチェックとして表示する", () => {
    applyInit(paths, planInit(paths, HOME));
    const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(paths.configPath, JSON.stringify({ ...config, maxTurns: "not-a-number" }) + "\n");

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe });

    const configCheck = find(results, `${AGENT_DIR_NAME}/config.json`);
    expect(configCheck.ok).toBe(false);
    expect(configCheck.detail).toContain("maxTurns");
    // claudeCommand が読めないため既定の "claude" へフォールバックして他のチェックは続行する
    expect(find(results, "claude").name).toBe("claude (claude)");
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

  it(".agent/tasks が同名のファイルなら .agent/ チェックが ✗ になり detail にそのパスが出る", () => {
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agent", "tasks"), "");

    const agent = find(collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe }), ".agent/");

    expect(agent.ok).toBe(false);
    expect(agent.detail).toContain(".agent/tasks");
  });

  it("GOAL.md / config.json は揃っているが tasks/.gitkeep が無ければ ✗ になり detail に不足パスが出る", () => {
    applyInit(paths, planInit(paths, HOME));
    fs.rmSync(path.join(repo, ".agent", "tasks", ".gitkeep"));

    const agent = find(collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe }), ".agent/");

    expect(agent.ok).toBe(false);
    expect(agent.detail).toContain(".agent/tasks/.gitkeep");
  });

  it(".gitignore に必要な行が無ければ ✗ になる", () => {
    applyInit(paths, planInit(paths, HOME));
    fs.rmSync(path.join(repo, ".gitignore"));

    const agent = find(collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe: okProbe }), ".agent/");

    expect(agent.ok).toBe(false);
    expect(agent.detail).toContain(".gitignore");
  });

  it("config の claudeCommand を差し替えるとそのコマンドを診断する", () => {
    applyInit(paths, planInit(paths, HOME));
    // claudeCommand 以外の項目は雛形どおり(完全な config)を維持したまま 1 項目だけ差し替える。
    // normalizeConfig は必須項目が揃っていない config を例外にするため、部分的な config は書けない
    const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(paths.configPath, JSON.stringify({ ...config, claudeCommand: "my-claude" }) + "\n");
    const probed: string[] = [];
    const probe: ProbeFn = (command) => {
      probed.push(command);
      return { ok: true, output: "1.0.0" };
    };

    const results = collectChecks({ paths, home: HOME, nodeVersion: "24.0.0", probe });

    expect(probed).toContain("my-claude");
    expect(find(results, "claude").name).toBe("claude (my-claude)");
  });

  it("root と agentRoot が異なる場合、claudeCommand の診断には agentRoot 側の config.json を使う", () => {
    // linked worktree 内から実行した状況を模す: root(本体ワークツリー)と agentRoot(いま実行して
    // いる作業ツリー)を別ディレクトリにし、それぞれに異なる claudeCommand の config.json を置く
    const rootOnly = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-doctor-root-"));
    const agentRootOnly = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-doctor-agentroot-"));
    try {
      const p = createPaths(rootOnly, process.env, agentRootOnly);
      applyInit(p, planInit(p, HOME));
      const config = JSON.parse(fs.readFileSync(p.configPath, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(p.configPath, JSON.stringify({ ...config, claudeCommand: "agent-claude" }) + "\n");
      // root 側にも .agent/config.json を置き、diagnose が誤って root を読んでいないことを確認する
      fs.mkdirSync(path.join(rootOnly, AGENT_DIR_NAME), { recursive: true });
      fs.writeFileSync(
        path.join(rootOnly, AGENT_DIR_NAME, "config.json"),
        JSON.stringify({ ...config, claudeCommand: "root-claude" }) + "\n",
      );
      const probed: string[] = [];
      const probe: ProbeFn = (command) => {
        probed.push(command);
        return { ok: true, output: "1.0.0" };
      };

      const results = collectChecks({ paths: p, home: HOME, nodeVersion: "24.0.0", probe });

      expect(probed).toContain("agent-claude");
      expect(probed).not.toContain("root-claude");
      expect(find(results, "claude").name).toBe("claude (agent-claude)");
    } finally {
      fs.rmSync(rootOnly, { recursive: true, force: true });
      fs.rmSync(agentRootOnly, { recursive: true, force: true });
    }
  });
});

describe("checkClaudeAuth", () => {
  function probeOf(stdout: string): CommandProbe {
    return { ok: true, output: stdout.trim().split("\n")[0] ?? "", stdout: stdout.trim() };
  }

  it("JSON を parse できなければ判定できない扱いにし、必須にしない", () => {
    const result = checkClaudeAuth(probeOf("not json"), {});

    expect(result.name).toBe("claude ログイン状態");
    expect(result.ok).toBe(false);
    expect(result.required).toBe(false);
  });

  it("loggedIn が boolean でなければ判定できない扱いにし、必須にしない", () => {
    const result = checkClaudeAuth(probeOf(JSON.stringify({ loggedIn: "yes" })), {});

    expect(result.ok).toBe(false);
    expect(result.required).toBe(false);
  });

  it("loggedIn: true ならログイン済みとして ok/必須", () => {
    const result = checkClaudeAuth(probeOf(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })), {});

    expect(result.ok).toBe(true);
    expect(result.required).toBe(true);
    expect(result.detail).toContain("claude.ai");
  });

  it("loggedIn: false でも JSON の apiKeySource があれば問題として扱わない", () => {
    const result = checkClaudeAuth(
      probeOf(JSON.stringify({ loggedIn: false, apiKeySource: "ANTHROPIC_API_KEY" })),
      {},
    );

    expect(result.ok).toBe(true);
    expect(result.required).toBe(true);
    expect(result.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("loggedIn: false でも API キー系の環境変数があれば問題として扱わない", () => {
    const result = checkClaudeAuth(probeOf(JSON.stringify({ loggedIn: false })), {
      ANTHROPIC_API_KEY: "sk-xxx",
    });

    expect(result.ok).toBe(true);
    expect(result.required).toBe(true);
  });

  it("JSON として妥当だがオブジェクトでない出力でも例外を投げず判定できない扱いにする", () => {
    for (const raw of ["null", "[]", "42", '"text"']) {
      const result = checkClaudeAuth(probeOf(raw), {});

      expect(result.ok).toBe(false);
      expect(result.required).toBe(false);
    }
  });

  it("明示的に無効化された CLAUDE_CODE_USE_BEDROCK は手がかりとして数えない", () => {
    for (const value of ["0", "false", "False"]) {
      const result = checkClaudeAuth(probeOf(JSON.stringify({ loggedIn: false })), {
        CLAUDE_CODE_USE_BEDROCK: value,
      });

      expect(result.ok).toBe(false);
      expect(result.required).toBe(true);
    }
  });

  it("有効な CLAUDE_CODE_USE_BEDROCK は手がかりとして数える", () => {
    const result = checkClaudeAuth(probeOf(JSON.stringify({ loggedIn: false })), {
      CLAUDE_CODE_USE_BEDROCK: "1",
    });

    expect(result.ok).toBe(true);
  });

  it("loggedIn: false で手がかりが無ければ未ログインとして必須の ✗ にする", () => {
    const result = checkClaudeAuth(probeOf(JSON.stringify({ loggedIn: false })), {});

    expect(result.ok).toBe(false);
    expect(result.required).toBe(true);
    expect(result.detail).toContain("claude auth login");
  });

  it("output の 1 行目だけでは壊れる複数行 JSON でも stdout 全文から parse できる", () => {
    const json = JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }, null, 2);
    const probe: CommandProbe = { ok: true, output: json.split("\n")[0] ?? "", stdout: json };

    const result = checkClaudeAuth(probe, {});

    expect(result.ok).toBe(true);
    expect(result.required).toBe(true);
  });

  it("stdout が無ければ output(1 行目)を代わりに使う", () => {
    const probe: CommandProbe = { ok: true, output: JSON.stringify({ loggedIn: true }) };

    const result = checkClaudeAuth(probe, {});

    expect(result.ok).toBe(true);
  });
});

describe("probeCommand", () => {
  it("コマンド自体が存在しなければ failure: not-found", () => {
    const result = probeCommand("ccloop-doctor-command-that-does-not-exist-xyz", []);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("not-found");
  });

  it("コマンドは起動できるが非ゼロ終了なら failure: exit と終了コードを返す", () => {
    const result = probeCommand(process.execPath, ["-e", "process.stderr.write('boom\\n'); process.exit(3)"]);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("exit");
    expect(result.exitCode).toBe(3);
    expect(result.output).toBe("boom");
  });

  it("正常終了なら ok: true", () => {
    const result = probeCommand(process.execPath, ["-e", "console.log('1.0.0')"]);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("1.0.0");
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
