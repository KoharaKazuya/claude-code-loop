import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  migrateConfig,
  readSchemaVersion,
  V1_DEFAULTS,
  V2_DEFAULTS,
} from "./migrations.ts";

describe("readSchemaVersion", () => {
  it("schemaVersion があればその値", () => {
    expect(readSchemaVersion({ schemaVersion: 1 })).toBe(1);
  });

  it("欠損・非数値・負値・非オブジェクトは 0 とみなす", () => {
    expect(readSchemaVersion({})).toBe(0);
    expect(readSchemaVersion({ schemaVersion: "1" })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: -1 })).toBe(0);
    expect(readSchemaVersion(null)).toBe(0);
    expect(readSchemaVersion([1])).toBe(0);
  });
});

describe("compareSchemaVersion", () => {
  it("一致・config が古い・ツールが古いを判別する", () => {
    expect(compareSchemaVersion(1, 1)).toBe("ok");
    expect(compareSchemaVersion(0, 1)).toBe("config-outdated");
    expect(compareSchemaVersion(99, 1)).toBe("tool-outdated");
  });
});

describe("migrateConfig", () => {
  it("schemaVersion 欠損の config を最新版数へ移行する", () => {
    const result = migrateConfig({ model: "sonnet" });

    expect(result.from).toBe(0);
    expect(result.to).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("既存の値は書き換えない(フィールド追加のみ)", () => {
    const result = migrateConfig({ model: "sonnet", maxTurns: 7, parallel: { maxSessions: 1 } });

    expect(result.config.model).toBe("sonnet");
    expect(result.config.maxTurns).toBe(7);
    expect(result.config.parallel).toEqual({ maxSessions: 1 });
  });

  it("欠けているフィールドを既定値で補い、その内訳を返す", () => {
    const result = migrateConfig({});

    for (const key of Object.keys(V1_DEFAULTS)) {
      expect(result.config[key]).toEqual(V1_DEFAULTS[key]);
      expect(result.changes.some((c) => c.startsWith(`${key} `))).toBe(true);
    }
  });

  it("schemaVersion 1 の config を 2 へ移行し maxConflictRetries を補う", () => {
    const raw = { schemaVersion: 1, model: "sonnet" };

    const result = migrateConfig(raw);

    expect(result.from).toBe(1);
    expect(result.to).toBe(2);
    expect(result.config.schemaVersion).toBe(2);
    for (const key of Object.keys(V2_DEFAULTS)) {
      expect(result.config[key]).toEqual(V2_DEFAULTS[key]);
      expect(result.changes.some((c) => c.startsWith(`${key} `))).toBe(true);
    }
  });

  it("既に最新なら何も変えない", () => {
    const raw = { schemaVersion: CURRENT_SCHEMA_VERSION, model: "opus" };

    const result = migrateConfig(raw);

    expect(result.from).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.changes).toEqual([]);
    expect(result.config).toEqual(raw);
  });

  it("入力オブジェクトを破壊しない", () => {
    const raw = { model: "opus" };

    migrateConfig(raw);

    expect(raw).toEqual({ model: "opus" });
  });
});

describe("V1_DEFAULTS/V2_DEFAULTS と雛形 config.json", () => {
  it("キー集合が一致する(雛形だけにフィールドが増えて移行から漏れるのを防ぐ)", () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "templates", "agent", "config.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(Object.keys(template).sort()).toEqual(
      ["schemaVersion", ...Object.keys(V1_DEFAULTS), ...Object.keys(V2_DEFAULTS)].sort(),
    );
    expect(template.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("既定値の中身も雛形と一致する", () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "templates", "agent", "config.json"), "utf8"),
    ) as Record<string, unknown>;

    for (const [key, value] of Object.entries({ ...V1_DEFAULTS, ...V2_DEFAULTS })) {
      expect(template[key]).toEqual(value);
    }
  });
});
