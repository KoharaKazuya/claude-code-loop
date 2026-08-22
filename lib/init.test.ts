import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyInit,
  checkSchemaVersion,
  cmdInit,
  configReadErrorMessage,
  formatInitPlan,
  isAgentDirReady,
  isInitPlanEmpty,
  planInit,
} from "./init.ts";
import { CURRENT_SCHEMA_VERSION } from "./migrations.ts";
import { createPaths, type Paths } from "./paths.ts";

/** 本物の雛形(lib/templates/)を使う。同梱物そのものが配置対象として妥当かも同時に検査する */
const HOME = import.meta.dirname;

describe("planInit / applyInit", () => {
  let repo: string;
  let paths: Paths;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-init-"));
    paths = createPaths(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("空のリポジトリには雛形一式と .gitignore を作る計画になる", () => {
    const plan = planInit(paths, HOME);

    expect(plan.creates.map((c) => c.rel)).toEqual([
      ".agent/GOAL.md",
      ".agent/OVERVIEW.md",
      ".agent/config.json",
      ".agent/decisions/.gitkeep",
      ".agent/human-review/.gitkeep",
      ".agent/tasks/.gitkeep",
    ]);
    expect(plan.skips).toEqual([]);
    expect(plan.gitignore).toEqual({ action: "create", lines: [".agent/**/*.tmp"] });
    expect(isInitPlanEmpty(plan)).toBe(false);
  });

  it("配置すると .agent/ が使える状態になり、config.json は現行スキーマになる", () => {
    applyInit(paths, planInit(paths, HOME));

    expect(isAgentDirReady(paths)).toBe(true);
    const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as { schemaVersion: number };
    expect(config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe(".agent/**/*.tmp\n");
  });

  it("既存ファイルは絶対に上書きせずスキップする", () => {
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(paths.goalPath, "人間が書いた目標\n");

    const plan = planInit(paths, HOME);
    expect(plan.skips).toEqual([".agent/GOAL.md"]);
    expect(plan.creates.map((c) => c.rel)).not.toContain(".agent/GOAL.md");

    applyInit(paths, plan);
    expect(fs.readFileSync(paths.goalPath, "utf8")).toBe("人間が書いた目標\n");
  });

  it("計画後に実体ができていても上書きしない", () => {
    const plan = planInit(paths, HOME);
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(paths.goalPath, "割り込みで書かれた\n");

    applyInit(paths, plan);

    expect(fs.readFileSync(paths.goalPath, "utf8")).toBe("割り込みで書かれた\n");
  });

  it("既に必要な行がある .gitignore は触らない", () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n.agent/**/*.tmp\n");

    expect(planInit(paths, HOME).gitignore).toEqual({ action: "none", lines: [] });
  });

  it("不足行だけを .gitignore へ追記する(末尾改行が無くても壊さない)", () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules");

    const plan = planInit(paths, HOME);
    expect(plan.gitignore.action).toBe("append");
    applyInit(paths, plan);

    expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("node_modules\n.agent/**/*.tmp\n");
  });

  it(".gitignore が ENOENT 以外の理由で読めない場合は触らない(既存内容の破壊を避ける)", () => {
    // ディレクトリにして EISDIR を起こし、パーミッションエラー等の「ENOENT 以外」を模す
    fs.mkdirSync(path.join(repo, ".gitignore"));

    const plan = planInit(paths, HOME);

    expect(plan.gitignore).toEqual({ action: "none", lines: [] });
  });

  it("計画時には無かった .gitignore が適用時にできていても、素の writeFileSync のように truncate せず追記へ回る", () => {
    const plan = planInit(paths, HOME);
    expect(plan.gitignore.action).toBe("create");
    // 計画後、適用前に横から .gitignore ができたケースを模す
    fs.writeFileSync(path.join(repo, ".gitignore"), "existing-line\n");

    applyInit(paths, plan);

    const text = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
    expect(text).toContain("existing-line");
    expect(text).toContain(".agent/**/*.tmp");
  });

  it("2 回目の init は書くものが無い計画になる(冪等)", () => {
    applyInit(paths, planInit(paths, HOME));

    const plan = planInit(paths, HOME);

    expect(isInitPlanEmpty(plan)).toBe(true);
    expect(plan.creates).toEqual([]);
  });

  it("計画の一覧表示に作成・スキップ・.gitignore が出る", () => {
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(paths.goalPath, "既存\n");

    const lines = formatInitPlan(planInit(paths, HOME)).join("\n");

    expect(lines).toContain("作成: .agent/config.json");
    expect(lines).toContain("スキップ(既存のため触らない): .agent/GOAL.md");
    expect(lines).toContain(".gitignore");
  });
});

describe("cmdInit", () => {
  let repo: string;
  let paths: Paths;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-init-cmd-"));
    paths = createPaths(repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("--yes なら確認なしで配置し 0 を返す", async () => {
    expect(await cmdInit(paths, ["--yes"], HOME)).toBe(0);
    expect(isAgentDirReady(paths)).toBe(true);
  });

  it("非 TTY で --yes 無しなら何も書かず 1 を返す", async () => {
    expect(await cmdInit(paths, [], HOME)).toBe(1);
    expect(fs.existsSync(paths.goalPath)).toBe(false);
  });

  it("未知のオプションは 1 を返す", async () => {
    expect(await cmdInit(paths, ["--force"], HOME)).toBe(1);
    expect(fs.existsSync(paths.goalPath)).toBe(false);
  });

  it("--upgrade は schemaVersion 欠損の config を現行版数へ移行する", async () => {
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(paths.configPath, JSON.stringify({ model: "sonnet" }, null, 2) + "\n");

    expect(await cmdInit(paths, ["--upgrade", "--yes"], HOME)).toBe(0);

    const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as Record<string, unknown>;
    expect(config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(config.model).toBe("sonnet");
  });

  it("--upgrade は既に最新なら書き換えずに 0 を返す", async () => {
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    const text = JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION }, null, 2) + "\n";
    fs.writeFileSync(paths.configPath, text);

    expect(await cmdInit(paths, ["--upgrade"], HOME)).toBe(0);
    expect(fs.readFileSync(paths.configPath, "utf8")).toBe(text);
  });

  it("--upgrade は config が新しすぎれば 1 を返す(ツールの更新が要る)", async () => {
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(paths.configPath, JSON.stringify({ schemaVersion: 99 }) + "\n");

    expect(await cmdInit(paths, ["--upgrade", "--yes"], HOME)).toBe(1);
  });

  it("--upgrade は config.json が無ければ 1 を返す", async () => {
    expect(await cmdInit(paths, ["--upgrade", "--yes"], HOME)).toBe(1);
  });

  it("--upgrade は config.json が壊れていれば「手で修正すること」の案内で 1 を返す", async () => {
    fs.mkdirSync(path.join(repo, ".agent"), { recursive: true });
    fs.writeFileSync(paths.configPath, "{ broken json");

    expect(await cmdInit(paths, ["--upgrade", "--yes"], HOME)).toBe(1);
  });
});

describe("configReadErrorMessage", () => {
  it("エラー内容と手で修正する案内を含む", () => {
    const message = configReadErrorMessage(new SyntaxError("Unexpected token"));
    expect(message).toContain(".agent/config.json を読めない");
    expect(message).toContain("Unexpected token");
    expect(message).toContain("手で修正すること");
  });
});

describe("checkSchemaVersion", () => {
  it("一致していれば通す", () => {
    expect(checkSchemaVersion({ schemaVersion: CURRENT_SCHEMA_VERSION }, "run")).toEqual({
      ok: true,
      message: null,
    });
  });

  it("config が古いとき run は止め、他コマンドは警告のみ", () => {
    const forRun = checkSchemaVersion({}, "run");
    expect(forRun.ok).toBe(false);
    expect(forRun.message).toContain("ccloop init --upgrade");

    const forStatus = checkSchemaVersion({}, "status");
    expect(forStatus.ok).toBe(true);
    expect(forStatus.message).toContain("ccloop init --upgrade");
  });

  it("ツールが古いときは全コマンドを止める", () => {
    for (const cmd of ["run", "status", "list", "add", "watch"]) {
      const result = checkSchemaVersion({ schemaVersion: 99 }, cmd);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("ccloop が古い");
    }
  });
});
