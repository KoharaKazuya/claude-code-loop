import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkNodeVersion, readConfigRaw, readVersion, splitGlobalOptions } from "./cli.ts";
import { serializeFrontmatter } from "./frontmatter.ts";
import { SUBCOMMAND_HELP, TOP_LEVEL_HELP, usageOf } from "./help.ts";
import { createPaths, type Paths } from "./paths.ts";
import { statePathOf } from "./supervisor.ts";

describe("splitGlobalOptions", () => {
  it("--repo <path> を取り除きサブコマンド以降を残す", () => {
    expect(splitGlobalOptions(["--repo", "/w/x", "list", "--full"])).toEqual({
      repo: "/w/x",
      rest: ["list", "--full"],
    });
  });

  it("--repo=<path> 形式も受け付ける", () => {
    expect(splitGlobalOptions(["--repo=/w/x", "status"])).toEqual({ repo: "/w/x", rest: ["status"] });
  });

  it("--repo が無ければ repo は付かない", () => {
    expect(splitGlobalOptions(["status"])).toEqual({ rest: ["status"] });
  });

  it("サブコマンドより後ろの --repo も抽出する(前後どちらでも指定できる)", () => {
    expect(splitGlobalOptions(["add", "タイトル", "--repo", "/w/x"])).toEqual({
      repo: "/w/x",
      rest: ["add", "タイトル"],
    });
  });

  it("サブコマンドより後ろの --repo=<path> 形式も抽出する", () => {
    expect(splitGlobalOptions(["status", "--repo=/w/x"])).toEqual({ repo: "/w/x", rest: ["status"] });
  });

  it("複数指定された場合は最後の指定を使う", () => {
    expect(splitGlobalOptions(["--repo", "/a", "status", "--repo", "/b"])).toEqual({
      repo: "/b",
      rest: ["status"],
    });
  });

  it("--repo に値が無ければエラー", () => {
    expect(() => splitGlobalOptions(["--repo"])).toThrow();
  });

  it("引数なしなら空", () => {
    expect(splitGlobalOptions([])).toEqual({ rest: [] });
  });
});

describe("checkNodeVersion", () => {
  it("22.18 以降の 22 系は使える", () => {
    expect(checkNodeVersion("22.18.0")).toBeNull();
    expect(checkNodeVersion("22.20.3")).toBeNull();
  });

  it("24 以降は使える", () => {
    expect(checkNodeVersion("24.0.0")).toBeNull();
    expect(checkNodeVersion("25.1.0")).toBeNull();
  });

  it("22.18 未満と 23 系は案内メッセージを返す", () => {
    expect(checkNodeVersion("22.17.1")).toContain("22.18");
    expect(checkNodeVersion("23.11.0")).toContain("22.18");
    expect(checkNodeVersion("20.19.0")).toContain("22.18");
  });

  it("実行中の Node は要件を満たす(package.json の engines と整合する)", () => {
    expect(checkNodeVersion()).toBeNull();
  });
});

describe("readVersion", () => {
  it("lib/ の 1 つ上の package.json の version を返す", () => {
    // 開発中のチェックアウトでは lib/../package.json がリポジトリの package.json。
    // インストール先(/usr/local/share/ccloop/)でも同じ配置になるよう install.sh が同梱する
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("package.json が無い場所を渡しても落ちず unknown を返す", () => {
    expect(readVersion(path.join(import.meta.dirname, "prompt"))).toBe("unknown");
  });

  it("devcontainer-feature.json の version と package.json の version が一致する", () => {
    const root = path.join(import.meta.dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    const feature = JSON.parse(
      fs.readFileSync(path.join(root, "features", "ccloop", "devcontainer-feature.json"), "utf8"),
    ) as { version: string };

    expect(feature.version).toBe(pkg.version);
  });
});

describe("main: --repo をサブコマンドの後ろに置いても効く(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-repo-postfix-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("`ccloop doctor --repo <path>` は前置と同じリポジトリを診断する", () => {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "doctor", "--repo", repo], {
      encoding: "utf8",
    });

    expect(res.stdout).toContain(`対象リポジトリ: ${fs.realpathSync(repo)}`);
  });
});

describe("readConfigRaw", () => {
  let repo: string;
  let paths: Paths;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-config-"));
    paths = createPaths(repo);
    fs.mkdirSync(paths.agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(paths.stateDir, { recursive: true, force: true });
  });

  it("正常な JSON はそのまま返す", () => {
    fs.writeFileSync(paths.configPath, JSON.stringify({ schemaVersion: 1 }));
    expect(readConfigRaw(paths)).toEqual({ schemaVersion: 1 });
  });

  it("壊れた JSON は既定値へ倒さず投げる(出口の無いループを防ぐ)", () => {
    fs.writeFileSync(paths.configPath, "{ this is not json");
    expect(() => readConfigRaw(paths)).toThrow();
  });
});

describe("main: 壊れた config.json の扱い(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-main-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    // isAgentDirReady は雛形一式が揃っているかで判定するため、config.json 以外は雛形どおりに揃える
    // (揃っていないと「未配置(または不完全)」の案内が先に出て、壊れた config.json の検証にならない)
    fs.mkdirSync(path.join(repo, ".agent", "tasks"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".agent", "decisions"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".agent", "human-review"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agent", "GOAL.md"), "# GOAL\n");
    fs.writeFileSync(path.join(repo, ".agent", "OVERVIEW.md"), "# OVERVIEW\n");
    fs.writeFileSync(path.join(repo, ".agent", "tasks", ".gitkeep"), "");
    fs.writeFileSync(path.join(repo, ".agent", "decisions", ".gitkeep"), "");
    fs.writeFileSync(path.join(repo, ".agent", "human-review", ".gitkeep"), "");
    fs.writeFileSync(path.join(repo, ".agent", "config.json"), "{ broken json");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stderr: string } {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, ...args], {
      encoding: "utf8",
    });
    return { status: res.status, stderr: res.stderr };
  }

  it("status は doctor と同じ案内で exit 1 になる", () => {
    const result = run(["status"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".agent/config.json を読めない");
    expect(result.stderr).toContain("手で修正すること");
  });

  it("list / add / watch / run も同じ経路で exit 1 になる", () => {
    for (const args of [["list"], ["add", "タイトル"], ["watch"], ["run"]]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("手で修正すること");
    }
  });

  it("init --upgrade も同じ案内で exit 1 になる", () => {
    const result = run(["init", "--upgrade", "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("手で修正すること");
  });
});

describe("--help / -h(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  // リポジトリの外(git 管理外・.agent/ 無し)からでも --help が答えられることを確認するため、
  // cwd を空の一時ディレクトリに固定して実行する
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-help-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, ...args], {
      encoding: "utf8",
      cwd,
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it.each(["--help", "-h", "help"])("ccloop %s はトップレベルのヘルプを表示して exit 0", (flag) => {
    const result = run([flag]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${TOP_LEVEL_HELP}\n`);
  });

  it("トップレベルのヘルプは全サブコマンドと --repo を含む", () => {
    for (const cmd of ["run", "status", "watch", "list", "add", "retry", "init", "doctor", "version"]) {
      expect(TOP_LEVEL_HELP).toContain(cmd);
    }
    expect(TOP_LEVEL_HELP).toContain("--repo");
  });

  const SUBCOMMANDS = ["run", "status", "watch", "list", "add", "retry", "init", "doctor", "version"] as const;

  it.each(SUBCOMMANDS)("ccloop %s --help はサブコマンドのヘルプを表示して exit 0(リポジトリが無くても動く)", (cmd) => {
    const result = run([cmd, "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${SUBCOMMAND_HELP[cmd]}\n`);
    expect(result.stderr).toBe("");
  });

  it.each(SUBCOMMANDS)("ccloop %s -h も同じ内容を表示する", (cmd) => {
    const result = run([cmd, "-h"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${SUBCOMMAND_HELP[cmd]}\n`);
  });

  it("add --help はオプション --desc/--priority/--deps/--conflicts/--model/--slug を含む", () => {
    const result = run(["add", "--help"]);
    for (const opt of ["--desc", "--priority", "--deps", "--conflicts", "--model", "--slug"]) {
      expect(result.stdout).toContain(opt);
    }
  });

  it("retry --help は使い方に <タスクID> を含む", () => {
    const result = run(["retry", "--help"]);
    expect(result.stdout).toContain("retry <タスクID>");
  });

  it("init --help はオプション --yes/--upgrade を含む", () => {
    const result = run(["init", "--help"]);
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain("--upgrade");
  });

  it("watch --help はオプション --interval を含む", () => {
    const result = run(["watch", "--help"]);
    expect(result.stdout).toContain("--interval");
  });

  it("list --help はオプション --full を含む", () => {
    const result = run(["list", "--help"]);
    expect(result.stdout).toContain("--full");
  });
});

describe("usageOf", () => {
  it("add の使い方ブロックは ccloop を含み supervisor.ts を含まない", () => {
    const usage = usageOf("add");
    expect(usage).toContain("ccloop");
    expect(usage).not.toContain("supervisor.ts");
  });

  it("add の使い方ブロックはオプション行(--slug)まで含む複数行になる", () => {
    const usage = usageOf("add");
    const lines = usage.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(usage).toContain("--slug");
  });

  it("未知のサブコマンドを渡すと例外を投げる", () => {
    expect(() => usageOf("no-such-subcommand")).toThrow();
  });
});

describe("main: add はタイトル未指定でエラー(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-add-usage-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "init", "--yes"]);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("`ccloop add`(タイトル無し)は exit 1 で、stderr は `使い方: ccloop` で始まり supervisor.ts を含まない", () => {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "add"], {
      encoding: "utf8",
    });

    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain("supervisor.ts");
    expect(res.stderr.startsWith("使い方: ccloop")).toBe(true);
  });
});

describe("status --json / list --json(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-json-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "init", "--yes"]);
    execFileSync(process.execPath, [
      "--no-warnings=ExperimentalWarning",
      CLI_ENTRY,
      "--repo",
      repo,
      "add",
      "サンプルタスク",
      "--desc",
      "説明",
      "--priority",
      "2",
    ]);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, ...args], {
      encoding: "utf8",
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  it("status --json は parse 可能な JSON を 1 オブジェクトで出力する", () => {
    const result = run(["status", "--json"]);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const data = JSON.parse(lines[0]!) as Record<string, unknown>;
    for (const key of [
      "tasks",
      "archivedCompletedCount",
      "state",
      "humanReview",
      "overview",
      "pendingConflicts",
      "permissionDenials",
      "pendingDecisions",
      "nextRunnableTasks",
      "snoozedTasks",
      "metrics",
      "inputsChanged",
      "taskTimeoutMs",
      "maxSessions",
      "supervisorSourceStale",
      "installedSourceDrifted",
    ]) {
      expect(data).toHaveProperty(key);
    }
    const tasks = data.tasks as { title: string; status: string; priority: number }[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "サンプルタスク", status: "ready", priority: 2 });
  });

  it("status --json は既存のテキスト出力(--json 無し)に影響しない", () => {
    const text = run(["status"]).stdout;
    expect(text).toContain("== 自律実行ステータス ==");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("list --json は parse 可能な JSON でタスクの全フィールドを含む", () => {
    const result = run(["list", "--json"]);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout.trim()) as { tasks: Record<string, unknown>[] };
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ title: "サンプルタスク", status: "ready", priority: 2, body: "説明" });
    expect(data.tasks[0]).toHaveProperty("id");
    expect(data.tasks[0]).toHaveProperty("createdAt");
  });

  it("list --json --full は list --json と同じ出力になる(併用してもエラーにならない)", () => {
    const withFull = run(["list", "--json", "--full"]);
    const withoutFull = run(["list", "--json"]);
    expect(withFull.status).toBe(0);
    expect(withFull.stdout).toBe(withoutFull.stdout);
  });

  it("list --json は既存のテキスト出力(--json 無し)に影響しない", () => {
    const text = run(["list"]).stdout;
    expect(text).toContain("サンプルタスク");
    expect(() => JSON.parse(text)).toThrow();
  });
});

describe("ccloop list の deps 行の淡色表示(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;
  let tasksDir: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-list-deps-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "init", "--yes"]);
    tasksDir = path.join(repo, ".agent", "tasks");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  /** .agent/tasks/<id>.md を frontmatter + 本文で直接書く(存在しない依存 ID は `ccloop add --deps` で
   * 弾かれるため cmdAdd を経由せず直接書く) */
  function writeTask(id: string, fields: Record<string, string | number | string[]>): void {
    fs.writeFileSync(path.join(tasksDir, `${id}.md`), serializeFrontmatter(fields, "本文"));
  }

  // list の淡色(dim)は util.styleText が TTY かどうかで出し分けるため、パイプ経由の子プロセスでは
  // 既定で ANSI が付かず「淡色にならない」が常に真になってしまう。FORCE_COLOR=1 を渡して色出力を
  // 強制することで、dim エスケープの有無を実際に検証できるようにする。
  /** 淡色(dim)の ANSI エスケープ。生の ESC 文字はコミットフックに弾かれるためコード点で書く */
  const DIM = "\u001B[2m";

  function run(args: string[]): { status: number | null; stdout: string } {
    const res = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, ...args],
      { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "1" } },
    );
    return { status: res.status, stdout: res.stdout };
  }

  it("依存先が現役にも archive にも無い(missing)場合、deps 行は淡色にならない", () => {
    writeTask("T-child", {
      title: "打ち間違いの依存を持つタスク",
      status: "ready",
      dependencies: ["T-typo"],
    });

    const result = run(["list"]);
    expect(result.status).toBe(0);
    const depsLine = result.stdout.split("\n").find((l) => l.includes("deps:"));
    expect(depsLine).toContain("(missing)");
    expect(depsLine).not.toContain(DIM);
  });

  it("依存がすべて満たされている場合、deps 行は淡色になる", () => {
    writeTask("T-parent", {
      title: "完了済みの依存先",
      status: "completed",
      dependencies: [],
    });
    writeTask("T-child", {
      title: "依存が満たされたタスク",
      status: "ready",
      dependencies: ["T-parent"],
    });

    const result = run(["list"]);
    expect(result.status).toBe(0);
    const depsLine = result.stdout.split("\n").find((l) => l.includes("deps:"));
    expect(depsLine).toContain(DIM);
  });

  it("conflicts を持つタスクは list に conflicts 行が出る", () => {
    writeTask("T-other", {
      title: "競合相手のタスク",
      status: "ready",
    });
    writeTask("T-child", {
      title: "競合を持つタスク",
      status: "ready",
      conflicts: ["T-other"],
    });

    const result = run(["list"]);
    expect(result.status).toBe(0);
    const conflictsLine = result.stdout.split("\n").find((l) => l.includes("conflicts:"));
    expect(conflictsLine).toContain("T-other");
    expect(conflictsLine).toContain(DIM);
  });

  it("競合先が現役にも archive にも無い(missing)場合、conflicts 行は淡色にならない", () => {
    writeTask("T-child", {
      title: "打ち間違いの競合を持つタスク",
      status: "ready",
      conflicts: ["T-typo"],
    });

    const result = run(["list"]);
    expect(result.status).toBe(0);
    const conflictsLine = result.stdout.split("\n").find((l) => l.includes("conflicts:"));
    expect(conflictsLine).toContain("T-typo(missing)");
    expect(conflictsLine).not.toContain(DIM);
  });

  it("conflicts を持たないタスクには conflicts 行が出ない", () => {
    writeTask("T-child", {
      title: "競合の無いタスク",
      status: "ready",
    });

    const result = run(["list"]);
    expect(result.status).toBe(0);
    const conflictsLine = result.stdout.split("\n").find((l) => l.includes("conflicts:"));
    expect(conflictsLine).toBeUndefined();
  });
});

describe("ccloop retry(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;
  let tasksDir: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-retry-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "init", "--yes"]);
    tasksDir = path.join(repo, ".agent", "tasks");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, ...args], {
      encoding: "utf8",
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  /** .agent/tasks/<id>.md を frontmatter + 本文で直接書く(cmdAdd を経由せず任意の status を作るため) */
  function writeTask(id: string, fields: Record<string, string | number>, body = "本文"): string {
    const lines = Object.entries(fields).map(
      ([k, v]) => `${k}: ${typeof v === "number" ? String(v) : JSON.stringify(String(v))}`,
    );
    const text = ["---", ...lines, "---", "", body, ""].join("\n");
    const file = path.join(tasksDir, `${id}.md`);
    fs.writeFileSync(file, text);
    return file;
  }

  /** .agent/archive/tasks/<id>.md を直接書く(rotate を経由せず completed 退避済みの状態を作るため) */
  function writeArchivedTask(id: string, fields: Record<string, string | number>, body = "本文"): string {
    const archiveTasksDir = path.join(repo, ".agent", "archive", "tasks");
    fs.mkdirSync(archiveTasksDir, { recursive: true });
    const lines = Object.entries(fields).map(
      ([k, v]) => `${k}: ${typeof v === "number" ? String(v) : JSON.stringify(String(v))}`,
    );
    const text = ["---", ...lines, "---", "", body, ""].join("\n");
    const file = path.join(archiveTasksDir, `${id}.md`);
    fs.writeFileSync(file, text);
    return file;
  }

  /** 「## 試行履歴」に `### 試行 1` サブセクション(見出し + 空行 + n 行)を持つ本文 */
  function historyBody(n: number): string {
    const items = Array.from({ length: n }, (_, i) => `- 行${i + 1}`);
    return [
      "本文",
      "",
      "## 試行履歴",
      "",
      "### 試行 1(2026-01-01T00:00:00.000Z, ccloop 記録: タイムアウト)",
      "",
      ...items,
    ].join("\n");
  }

  it("failed タスクを retry すると status: ready / retries: 0 になり exit 0", () => {
    const id = "T-20260101-0000-fail-task";
    writeTask(id, {
      title: "失敗タスク",
      status: "failed",
      priority: 3,
      retries: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      note: "直前の失敗",
    });

    const result = run(["retry", id]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `タスク ${id} を再実行対象に戻しました(status: ready / retries: 0 / conflictRetries: 0)。`,
    );
    const text = fs.readFileSync(path.join(tasksDir, `${id}.md`), "utf8");
    expect(text).toContain("status: ready");
    expect(text).toContain("retries: 0");
  });

  it("blocked タスクも retry でき、直前の note を表示してから戻す", () => {
    const id = "T-20260101-0000-blocked-task";
    writeTask(id, {
      title: "ブロックタスク",
      status: "blocked",
      priority: 3,
      retries: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      note: "依存タスク待ち",
    });

    const result = run(["retry", id]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("直前の記録: 依存タスク待ち");
  });

  it("snoozeUntil が設定されていれば retry で解除する", () => {
    const id = "T-20260101-0000-snoozed-task";
    writeTask(id, {
      title: "待機タスク",
      status: "failed",
      priority: 3,
      retries: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      snoozeUntil: "2999-01-01T00:00:00.000Z",
    });

    const result = run(["retry", id]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("待機指定(snoozeUntil)を解除しました。");
    const text = fs.readFileSync(path.join(tasksDir, `${id}.md`), "utf8");
    expect(text).not.toContain("snoozeUntil");
  });

  it("試行履歴のサブセクションが20行を超える場合は先頭20行に切り詰め「(以下略)」を付ける", () => {
    const id = "T-20260101-0000-long-history-task";
    writeTask(
      id,
      {
        title: "履歴の長いタスク",
        status: "failed",
        priority: 3,
        retries: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      historyBody(25),
    );

    const result = run(["retry", id]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("### 試行 1(2026-01-01T00:00:00.000Z, ccloop 記録: タイムアウト)");
    expect(result.stdout).toContain("- 行1");
    expect(result.stdout).toContain("(以下略)");
    // 見出し行(1) + 空行(1) + 本文 18 行 = 20 行までしか表示しない
    expect(result.stdout).toContain("- 行18");
    expect(result.stdout).not.toContain("- 行19");
    expect(result.stdout).not.toContain("- 行25");
  });

  it("試行履歴のサブセクションが20行以内ならそのまま表示し「(以下略)」は付けない", () => {
    const id = "T-20260101-0000-short-history-task";
    writeTask(
      id,
      {
        title: "履歴の短いタスク",
        status: "failed",
        priority: 3,
        retries: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      historyBody(5),
    );

    const result = run(["retry", id]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("- 行5");
    expect(result.stdout).not.toContain("(以下略)");
  });

  it("completed など failed/blocked でないタスクは exit 1 でファイル無変更", () => {
    const id = "T-20260101-0001-done-task";
    const file = writeTask(id, {
      title: "完了タスク",
      status: "completed",
      priority: 3,
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(file, "utf8");

    const result = run(["retry", id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed / blocked のみやり直せます");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("存在しない ID は exit 1 で stderr に「見つかりません」が含まれる", () => {
    const result = run(["retry", "T-no-such-id"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("見つかりません");
  });

  it("archive にのみ存在する ID を指定すると exit 1 で .agent/archive/tasks/ への退避を案内する", () => {
    const id = "T-20260101-0000-archived-task";
    writeArchivedTask(id, {
      title: "完了済みタスク",
      status: "completed",
      priority: 3,
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = run(["retry", id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`タスク ${id} は完了済みとして .agent/archive/tasks/ へ退避されています。`);
    expect(result.stderr).toContain(".agent/tasks/ へ戻してから再実行してください。");
  });

  it("存在しない ID に似たタスクがあれば stderr に「もしかして:」と候補 ID を示す", () => {
    const similarId = "T-20260101-0000-fix-retry-bug";
    writeTask(similarId, {
      title: "似た ID のタスク",
      status: "ready",
      priority: 3,
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = run(["retry", "T-20260101-0000-fix-retry-typo"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("見つかりません");
    expect(result.stderr).toContain("もしかして:");
    // インデント付き(先頭 2 スペース)で候補 ID 単独の行になっていることを確認する
    expect(result.stderr.split("\n")).toContain(`  ${similarId}`);
  });

  it("実行中のタスク(state.json の runningSessions に登録済み)は exit 1 でファイル無変更", () => {
    const id = "T-20260101-0002-running-task";
    const file = writeTask(id, {
      title: "実行中タスク",
      status: "failed",
      priority: 3,
      retries: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(file, "utf8");
    // XDG_STATE_HOME は lib/test-setup.ts が一時ディレクトリへ差し替え済みで、
    // spawnSync は env を明示指定していないため process.env(この差し替え後の値)をそのまま
    // 子プロセスへ継承する(既存の他テストと同じ前提)。よって親プロセスの statePathOf(repo) と
    // 子プロセスが実際に読む state.json は同じパスになる。
    fs.writeFileSync(
      statePathOf(repo),
      JSON.stringify({
        runningSessions: [{ kind: "task", taskId: id, startedAt: "2026-01-01T00:00:00.000Z" }],
      }),
    );

    const result = run(["retry", id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("実行中です");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("引数なし・2 個以上・-- で始まる引数は usageOf(\"retry\") を stderr へ出して exit 1", () => {
    for (const args of [[], ["a", "b"], ["--bogus"]]) {
      const result = run(["retry", ...args]);
      expect(result.status).toBe(1);
      expect(result.stderr.startsWith("使い方: ccloop")).toBe(true);
    }
  });
});

describe("ccloop abandon(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;
  let tasksDir: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-abandon-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "init", "--yes"]);
    tasksDir = path.join(repo, ".agent", "tasks");
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, ...args], {
      encoding: "utf8",
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  /** .agent/tasks/<id>.md を frontmatter + 本文で直接書く(cmdAdd を経由せず任意の status を作るため) */
  function writeTask(id: string, fields: Record<string, string | number>, body = "本文"): string {
    const lines = Object.entries(fields).map(
      ([k, v]) => `${k}: ${typeof v === "number" ? String(v) : JSON.stringify(String(v))}`,
    );
    const text = ["---", ...lines, "---", "", body, ""].join("\n");
    const file = path.join(tasksDir, `${id}.md`);
    fs.writeFileSync(file, text);
    return file;
  }

  /** .agent/archive/tasks/<id>.md を直接書く(rotate を経由せず退避済みの状態を作るため) */
  function writeArchivedTask(id: string, fields: Record<string, string | number>, body = "本文"): string {
    const archiveTasksDir = path.join(repo, ".agent", "archive", "tasks");
    fs.mkdirSync(archiveTasksDir, { recursive: true });
    const lines = Object.entries(fields).map(
      ([k, v]) => `${k}: ${typeof v === "number" ? String(v) : JSON.stringify(String(v))}`,
    );
    const text = ["---", ...lines, "---", "", body, ""].join("\n");
    const file = path.join(archiveTasksDir, `${id}.md`);
    fs.writeFileSync(file, text);
    return file;
  }

  it("failed タスクを abandon すると abandonedAt が書かれ exit 0", () => {
    const id = "T-20260101-0000-fail-task";
    const file = writeTask(id, {
      title: "失敗タスク",
      status: "failed",
      priority: 3,
      retries: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = run(["abandon", id]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`タスク ${id} を断念として記録しました。`);
    expect(result.stdout).toContain(".agent/archive/tasks/");
    expect(result.stdout).toContain(`ccloop retry ${id}`);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("status: failed");
    expect(text).toMatch(/abandonedAt: \d{4}-\d{2}-\d{2}T/);
  });

  it("ready など failed でないタスクは exit 1 でファイル無変更", () => {
    const id = "T-20260101-0001-ready-task";
    const file = writeTask(id, {
      title: "未着手タスク",
      status: "ready",
      priority: 3,
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(file, "utf8");

    const result = run(["abandon", id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed タスクにのみ使えます");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("completed タスクは exit 1 でファイル無変更", () => {
    const id = "T-20260101-0002-done-task";
    const file = writeTask(id, {
      title: "完了タスク",
      status: "completed",
      priority: 3,
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(file, "utf8");

    const result = run(["abandon", id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed タスクにのみ使えます");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("存在しない ID は exit 1 で stderr に「見つかりません」が含まれる", () => {
    const result = run(["abandon", "T-no-such-id"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("見つかりません");
  });

  it("archive にのみ存在する ID を指定すると exit 1 で退避済みを案内する", () => {
    const id = "T-20260101-0000-archived-task";
    writeArchivedTask(id, {
      title: "退避済みタスク",
      status: "failed",
      priority: 3,
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = run(["abandon", id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`タスク ${id} はすでに .agent/archive/tasks/ へ退避されています。`);
  });

  it("実行中のタスク(state.json の runningSessions に登録済み)は exit 1 でファイル無変更", () => {
    const id = "T-20260101-0003-running-task";
    const file = writeTask(id, {
      title: "実行中タスク",
      status: "failed",
      priority: 3,
      retries: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const before = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      statePathOf(repo),
      JSON.stringify({
        runningSessions: [{ kind: "task", taskId: id, startedAt: "2026-01-01T00:00:00.000Z" }],
      }),
    );

    const result = run(["abandon", id]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("実行中です");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("二重に abandon すると exit 1 でファイル無変更", () => {
    const id = "T-20260101-0004-twice-task";
    const file = writeTask(id, {
      title: "二重断念タスク",
      status: "failed",
      priority: 3,
      retries: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const first = run(["abandon", id]);
    expect(first.status).toBe(0);
    const afterFirst = fs.readFileSync(file, "utf8");

    const second = run(["abandon", id]);

    expect(second.status).toBe(1);
    expect(second.stderr).toContain("すでに断念済みです");
    expect(fs.readFileSync(file, "utf8")).toBe(afterFirst);
  });

  it("abandon 済みタスクに retry すると abandonedAt が消え status: ready に戻る", () => {
    const id = "T-20260101-0005-retry-after-abandon";
    const file = writeTask(id, {
      title: "断念後にやり直すタスク",
      status: "failed",
      priority: 3,
      retries: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const abandonResult = run(["abandon", id]);
    expect(abandonResult.status).toBe(0);

    const retryResult = run(["retry", id]);

    expect(retryResult.status).toBe(0);
    expect(retryResult.stdout).toContain("断念(abandonedAt)を解除しました。");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("status: ready");
    expect(text).not.toContain("abandonedAt");
  });

  it("引数なし・2 個以上・-- で始まる引数は usageOf(\"abandon\") を stderr へ出して exit 1", () => {
    for (const args of [[], ["a", "b"], ["--bogus"]]) {
      const result = run(["abandon", ...args]);
      expect(result.status).toBe(1);
      expect(result.stderr.startsWith("使い方: ccloop")).toBe(true);
    }
  });
});

describe("git worktree 内からの実行(子プロセスで検証): .agent/ は agentRoot(worktree 自身)基準", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;
  let worktreeDir: string;

  /** .agent/tasks/<id>.md を dir 配下に直接書く(cmdAdd を経由せず任意の status を作るため) */
  function writeTaskAt(tasksDir: string, id: string, fields: Record<string, string | number>, body = "本文"): string {
    fs.mkdirSync(tasksDir, { recursive: true });
    const lines = Object.entries(fields).map(
      ([k, v]) => `${k}: ${typeof v === "number" ? String(v) : JSON.stringify(String(v))}`,
    );
    const text = ["---", ...lines, "---", "", body, ""].join("\n");
    const file = path.join(tasksDir, `${id}.md`);
    fs.writeFileSync(file, text);
    return file;
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-worktree-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "init", "--yes"]);
    // worktree add にはコミットが 1 つ必要。.agent/ を含めてコミットし、worktree 側にも
    // config.json 等が checkout された状態を作る(paths.test.ts の addWorktree に倣う)
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: repo },
    );
    worktreeDir = path.join(repo, "wt");
    execFileSync("git", ["worktree", "add", "-b", "wt-branch", worktreeDir, "main"], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("worktree の cwd で ccloop abandon すると worktree 側の .agent/tasks/ だけが更新され、本体側は変わらない", () => {
    const id = "T-20260101-0000-worktree-task";
    const fields = {
      title: "worktree タスク",
      status: "failed",
      priority: 3,
      retries: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const mainFile = writeTaskAt(path.join(repo, ".agent", "tasks"), id, fields);
    const worktreeFile = writeTaskAt(path.join(worktreeDir, ".agent", "tasks"), id, fields);
    const mainBefore = fs.readFileSync(mainFile, "utf8");

    // --repo は付けず、worktree の中を cwd にして実行する(実際の利用シーンの再現)
    const result = spawnSync(
      process.execPath,
      ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "abandon", id],
      { cwd: worktreeDir, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    // worktree 側は abandonedAt が書かれる
    expect(fs.readFileSync(worktreeFile, "utf8")).toMatch(/abandonedAt: \d{4}-\d{2}-\d{2}T/);
    // 本体側は一切変更されない
    expect(fs.readFileSync(mainFile, "utf8")).toBe(mainBefore);
  });
});

describe("ccloop run を git worktree 内から実行(子プロセスで検証)", () => {
  const CLI_ENTRY = path.join(import.meta.dirname, "cli.ts");
  let repo: string;
  let worktreeDir: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-cli-run-worktree-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "--repo", repo, "init", "--yes"]);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init"],
      { cwd: repo },
    );
    worktreeDir = path.join(repo, "wt");
    execFileSync("git", ["worktree", "add", "-b", "wt-branch", worktreeDir, "main"], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("worktree の cwd で ccloop run すると本体での実行を促すメッセージで exit 1 になる", () => {
    const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", CLI_ENTRY, "run"], {
      cwd: worktreeDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ccloop run はリポジトリ本体のワーキングツリーで実行すること");
    expect(result.stderr).toContain(fs.realpathSync(worktreeDir));
    expect(result.stderr).toContain(fs.realpathSync(repo));
  });
});
