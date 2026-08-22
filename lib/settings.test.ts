import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaths, type Paths } from "./paths.ts";
import {
  generateSettings,
  mergeSettings,
  renderSettingsTemplate,
  settingsTemplatePath,
  type Settings,
} from "./settings.ts";

const TEMPLATE_TEXT = fs.readFileSync(settingsTemplatePath(import.meta.dirname), "utf8");

describe("renderSettingsTemplate", () => {
  it("{{HOME}} をホームディレクトリで置き換える(絶対パス接頭辞 // になる)", () => {
    const s = renderSettingsTemplate(TEMPLATE_TEXT, "/home/someone");

    expect(s.permissions?.deny).toContain("Read(//home/someone/.claude/**)");
    expect(JSON.stringify(s)).not.toContain("{{HOME}}");
  });

  it("JSON として壊れる文字を含むホームでもパースできる", () => {
    const s = renderSettingsTemplate(TEMPLATE_TEXT, '/home/a"b\\c');

    expect(s.permissions?.deny).toContain('Read(//home/a"b\\c/.claude/**)');
  });
});

describe("settings.template.json", () => {
  it("hooks のコマンドは $CCLOOP_HOME 配下の .ts を指す(リポジトリ外のツールを実行するため)", () => {
    const s = renderSettingsTemplate(TEMPLATE_TEXT, "/home/x");
    const commands = JSON.stringify(s.hooks);

    for (const hook of ["deny-ask-user", "stop-check", "worktree-create"]) {
      expect(commands).toContain(`$CCLOOP_HOME/hooks/${hook}.ts`);
    }
  });

  it("`.agent/claude-settings.json` 自身への Write/Edit を拒否する(セッション自身による権限拡大を防ぐ)", () => {
    const s = renderSettingsTemplate(TEMPLATE_TEXT, "/home/x");

    expect(s.permissions?.deny).toContain("Write(./.agent/claude-settings.json)");
    expect(s.permissions?.deny).toContain("Edit(./.agent/claude-settings.json)");
  });

  it("hooks のコマンドは ExperimentalWarning を抑制する", () => {
    const s = renderSettingsTemplate(TEMPLATE_TEXT, "/home/x");
    const commands = JSON.stringify(s.hooks);

    expect(commands).toContain("node --no-warnings=ExperimentalWarning");
  });

  it("テンプレートが参照する hook スクリプトが実在する", () => {
    for (const hook of ["deny-ask-user", "stop-check", "worktree-create"]) {
      expect(fs.existsSync(path.join(import.meta.dirname, "hooks", `${hook}.ts`))).toBe(true);
    }
  });
});

describe("mergeSettings", () => {
  const base: Settings = {
    permissions: { allow: ["Read"], deny: ["Bash(sudo *)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node a.ts" }] }] },
  };

  it("利用側の allow / deny を追記する", () => {
    const merged = mergeSettings(base, {
      permissions: { allow: ["Bash(cargo *)"], deny: ["Bash(rm -rf /*)"] },
    });

    expect(merged.permissions?.allow).toEqual(["Read", "Bash(cargo *)"]);
    expect(merged.permissions?.deny).toEqual(["Bash(sudo *)", "Bash(rm -rf /*)"]);
  });

  it("重複は増やさない", () => {
    const merged = mergeSettings(base, { permissions: { allow: ["Read", "Read"] } });

    expect(merged.permissions?.allow).toEqual(["Read"]);
  });

  it("hooks は上書きさせない(ループの前提が崩れるため)", () => {
    const merged = mergeSettings(base, {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
    });

    expect(merged.hooks).toEqual(base.hooks);
  });

  it("permissions 以外のキーも利用側からは足せない", () => {
    const merged = mergeSettings(base, { model: "opus" });

    expect(merged.model).toBeUndefined();
  });

  it("overlay が無い・壊れていてもテンプレートをそのまま返す", () => {
    expect(mergeSettings(base, null).permissions).toEqual(base.permissions);
    expect(mergeSettings(base, "壊れた値").permissions).toEqual(base.permissions);
  });

  it("allow / deny の要素のうち文字列でないものは捨てる", () => {
    const merged = mergeSettings(base, { permissions: { allow: [1, "Bash(ls *)"] } });

    expect(merged.permissions?.allow).toEqual(["Read", "Bash(ls *)"]);
  });
});

describe("generateSettings", () => {
  let dir: string;
  let paths: Paths;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-settings-test-"));
    paths = createPaths(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(paths.stateDir, { recursive: true, force: true });
  });

  function read(file: string): Settings {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  }

  it("state ディレクトリへ書き出し、そのパスを返す", () => {
    const out = generateSettings(paths, { home: import.meta.dirname, homeDir: "/home/x" });

    expect(out).toBe(paths.generatedSettingsPath);
    expect(read(out).permissions?.deny).toContain("Read(//home/x/.claude/**)");
  });

  it("利用側リポジトリの .agent/claude-settings.json の allow / deny を追記する", () => {
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.agentDir, "claude-settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(cargo *)"], deny: ["Bash(curl *)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "乗っ取り" }] }] },
      }),
    );

    const s = read(generateSettings(paths, { home: import.meta.dirname, homeDir: "/home/x" }));

    expect(s.permissions?.allow).toContain("Bash(cargo *)");
    expect(s.permissions?.deny).toContain("Bash(curl *)");
    // hooks は ccloop 側のテンプレートのまま
    expect(JSON.stringify(s.hooks)).not.toContain("乗っ取り");
    expect(JSON.stringify(s.hooks)).toContain("$CCLOOP_HOME/hooks/stop-check.ts");
  });

  it("利用側の追記ファイルが無くても生成できる", () => {
    expect(() => generateSettings(paths, { home: import.meta.dirname, homeDir: "/home/x" })).not.toThrow();
  });

  it("生成した settings 自身と system prompt への Write/Edit を deny に追加する(自己改変の禁止)", () => {
    const s = read(generateSettings(paths, { home: import.meta.dirname, homeDir: "/home/x" }));

    expect(s.permissions?.deny).toContain(`Write(/${paths.generatedSettingsPath})`);
    expect(s.permissions?.deny).toContain(`Edit(/${paths.generatedSettingsPath})`);
    expect(s.permissions?.deny).toContain(`Write(/${paths.generatedSystemPromptPath})`);
    expect(s.permissions?.deny).toContain(`Edit(/${paths.generatedSystemPromptPath})`);
  });

  it("利用側リポジトリが同じ deny エントリを追記しても重複しない", () => {
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.agentDir, "claude-settings.json"),
      JSON.stringify({ permissions: { deny: [`Write(/${paths.generatedSettingsPath})`] } }),
    );

    const s = read(generateSettings(paths, { home: import.meta.dirname, homeDir: "/home/x" }));
    const occurrences = (s.permissions?.deny ?? []).filter((d) => d === `Write(/${paths.generatedSettingsPath})`);

    expect(occurrences).toHaveLength(1);
  });
});
