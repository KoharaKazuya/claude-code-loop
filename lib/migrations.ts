/**
 * `.agent/config.json` のスキーマ版数とマイグレーション
 *
 * config.json は利用側リポジトリで git 管理されるため、ccloop 本体だけを更新すると
 * 「新しいツール × 古い config」の組み合わせが必ず生じる。どちらが古いのかを機械的に
 * 判別できるよう `schemaVersion` を持たせ、次のように扱う。
 *
 * - config の版数 > ツールの版数: ツールが古い。config を書き換えても直らないので
 *   コンテナの再ビルド(ツールの更新)を促して止める。
 * - config の版数 < ツールの版数: config が古い。`ccloop init --upgrade` で移行する。
 *   移行前でも `normalizeConfig` が既定値で埋めるため読めはするが、`run` は
 *   意図しない既定値で長時間動き続けることになるので止める(他コマンドは警告のみ)。
 *
 * `schemaVersion` を持たない config(この仕組みの導入前に作られたもの)は 0 とみなす。
 */

/** ツール本体が理解する最新のスキーマ版数 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * schemaVersion 0 → 1 で「あるべき」top-level キーと既定値。
 * 0→1 はフィールド追加のみの移行であり、既存の値は決して書き換えない。
 * 値は `lib/templates/agent/config.json` と同じで、テストで一致を検査している。
 */
export const V1_DEFAULTS: Readonly<Record<string, unknown>> = {
  claudeCommand: "claude",
  model: "opus",
  escalation: { model: "claude-fable-5", afterRetries: 2 },
  permissionMode: "auto",
  maxRetries: 3,
  taskTimeoutMs: 2_400_000,
  maxTurns: 150,
  rateLimit: { backoffMs: 300_000 },
  explore: { enabled: true, minIntervalMs: 3_600_000 },
  triage: { enabled: true, model: "haiku" },
  idlePollMs: 60_000,
  parallel: { maxSessions: 4 },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * config の生データから schemaVersion を読む(純粋)。
 * 欠損・非数値・負値は 0(この仕組みの導入前の形式)とみなす。
 */
export function readSchemaVersion(raw: unknown): number {
  if (!isPlainObject(raw)) return 0;
  const v = raw.schemaVersion;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.trunc(v);
}

/** 版数の突き合わせ結果 */
export type SchemaCompat =
  /** ツールと config の版数が一致している */
  | "ok"
  /** config が古い(`ccloop init --upgrade` で移行できる) */
  | "config-outdated"
  /** ツールが古い(config を触っても直らない。ツールの更新が要る) */
  | "tool-outdated";

export function compareSchemaVersion(version: number, current: number = CURRENT_SCHEMA_VERSION): SchemaCompat {
  if (version > current) return "tool-outdated";
  if (version < current) return "config-outdated";
  return "ok";
}

/** 1 段分の移行 */
interface Migration {
  from: number;
  to: number;
  /** config を移行し、人間向けの変更内容(空なら「変更なし」)を返す */
  apply(config: Record<string, unknown>): { config: Record<string, unknown>; changes: string[] };
}

/** from の昇順で並べる。migrateConfig はこの配列を順に適用する */
const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    apply(config) {
      const changes: string[] = [];
      const next: Record<string, unknown> = { schemaVersion: 1, ...config };
      for (const [key, value] of Object.entries(V1_DEFAULTS)) {
        if (Object.hasOwn(config, key)) continue;
        next[key] = value;
        changes.push(`${key} を既定値で追加: ${JSON.stringify(value)}`);
      }
      next.schemaVersion = 1;
      changes.push("schemaVersion を 1 に設定");
      return { config: next, changes };
    },
  },
];

export interface MigrationResult {
  /** 移行後の config(移行不要なら入力と同じ内容) */
  config: Record<string, unknown>;
  from: number;
  to: number;
  /** 人間向けの変更内容。空なら書き換え不要 */
  changes: string[];
}

/**
 * config を現行のスキーマ版数まで順次移行する(純粋)。
 * 版数がツールより新しい場合は何もしない(呼び出し側が `compareSchemaVersion` で弾く)。
 */
export function migrateConfig(raw: unknown, current: number = CURRENT_SCHEMA_VERSION): MigrationResult {
  const from = readSchemaVersion(raw);
  let config = isPlainObject(raw) ? { ...raw } : {};
  const changes: string[] = [];
  let version = from;
  for (const migration of MIGRATIONS) {
    if (migration.from !== version || migration.to > current) continue;
    const result = migration.apply(config);
    config = result.config;
    changes.push(...result.changes);
    version = migration.to;
  }
  return { config, from, to: version, changes };
}
