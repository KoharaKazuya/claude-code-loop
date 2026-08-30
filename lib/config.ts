/**
 * `.agent/config.json` の読み込みと正規化
 *
 * Supervisor 本体だけでなく WorktreeCreate hook からも読む必要があるため
 * (hook と Supervisor が別々に worktree の置き場を計算して食い違うのを避けるため)、
 * 独立したモジュールに切り出している。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { V1_DEFAULTS } from "./migrations.ts";
import { AGENT_DIR_NAME, stateDirFor } from "./paths.ts";

export interface Config {
  claudeCommand: string;
  model: string;
  /** 同一タスクの失敗が afterRetries 回に達したら、以降の再試行を model で実行(model 空文字で無効) */
  escalation: { model: string; afterRetries: number };
  permissionMode: string;
  maxRetries: number;
  taskTimeoutMs: number;
  maxTurns: number;
  rateLimit: { backoffMs: number };
  /** 探索セッション(次の作業を探し、GOAL とタスク全体を突き合わせ直すセッション)の設定。
   * 探索は parallel.maxSessions の枠を 1 つ消費し、走っている間は新しいタスクセッションを起動しない。
   * minIntervalMs は 2 つの用途を兼ねる:
   *   - 実行可能タスクがある間の「定期見直し」探索の最小間隔
   *   - 直前の探索が空振り(新規タスク 0 件)だった場合の再探索クールダウン
   * 実行可能タスクが無く、前回探索以降に main / 入力が変化していれば、間隔を待たずに探索する */
  explore: { enabled: boolean; minIntervalMs: number };
  /** Human Review 回答の段階的処理(Stage 1: 決定論判定 / Stage 2: 軽量モデル判定)の設定。
   * enabled=false なら Stage 1/2 を飛ばし、従来どおり毎回フル探索(Stage 3)へ回す */
  triage: { enabled: boolean; model: string };
  idlePollMs: number;
  /** 並列セッション実行の設定 */
  parallel: {
    /** 同時タスクセッション数上限 */
    maxSessions: number;
    /** worktree 置き場のディレクトリ */
    worktreeDir: string;
    /** worktree へ symlink する gitignore 済みパス(既定は node_modules)。
     * 実運用の worktree 作成は WorktreeCreate hook(lib/hooks/worktree-create.ts)が行うが、
     * hook もこの config を読むため、ここの設定が hook 経路にも効く */
    linkPaths: string[];
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 既定の worktree 置き場。リポジトリの外(state ディレクトリ配下)に置く。
 * 利用者のリポジトリの隣にディレクトリを勝手に作らず、実行時状態を 1 か所へまとめるため。
 */
export function defaultWorktreeDir(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDirFor(root, env), "worktrees");
}

/**
 * config.json が全く無い場合に使う完全な既定値。`lib/migrations.ts` の `V1_DEFAULTS`
 * (= `lib/templates/agent/config.json` と同じ値)をそのまま使う。
 * parallel.worktreeDir / parallel.linkPaths だけは root(・env)依存のためここで計算する。
 * ネストしたオブジェクトは複製して返す。`V1_DEFAULTS` の実体を共有すると、呼び出し側が
 * 返り値を書き換えたときに以降の既定値まで変わってしまうため。
 */
export function defaultConfig(root: string, env: NodeJS.ProcessEnv = process.env): Config {
  return {
    claudeCommand: V1_DEFAULTS.claudeCommand as string,
    model: V1_DEFAULTS.model as string,
    escalation: { ...(V1_DEFAULTS.escalation as Config["escalation"]) },
    permissionMode: V1_DEFAULTS.permissionMode as string,
    maxRetries: V1_DEFAULTS.maxRetries as number,
    taskTimeoutMs: V1_DEFAULTS.taskTimeoutMs as number,
    maxTurns: V1_DEFAULTS.maxTurns as number,
    rateLimit: { ...(V1_DEFAULTS.rateLimit as Config["rateLimit"]) },
    explore: { ...(V1_DEFAULTS.explore as Config["explore"]) },
    triage: { ...(V1_DEFAULTS.triage as Config["triage"]) },
    idlePollMs: V1_DEFAULTS.idlePollMs as number,
    parallel: {
      maxSessions: (V1_DEFAULTS.parallel as { maxSessions: number }).maxSessions,
      worktreeDir: defaultWorktreeDir(root, env),
      linkPaths: ["node_modules"],
    },
  };
}

/** raw の中で key を持っているかどうかも込みで「現在の値」の表示文字列を作る */
function currentText(hasValue: boolean, value: unknown): string {
  if (!hasValue) return "項目が無い";
  const json = JSON.stringify(value);
  let text = json === undefined ? String(value) : json;
  if (text.length > 60) text = `${text.slice(0, 60)}…`;
  return text;
}

function issue(field: string, requirement: string, hasValue: boolean, value: unknown): string {
  return `${field}: ${requirement}(現在: ${currentText(hasValue, value)})`;
}

function checkNonEmptyString(obj: Record<string, unknown>, key: string, issues: string[], label = key): void {
  const has = Object.hasOwn(obj, key);
  const v = obj[key];
  if (!has || typeof v !== "string" || v === "") {
    issues.push(issue(label, "空でない文字列を指定すること", has, v));
  }
}

function checkInt(obj: Record<string, unknown>, key: string, min: number, issues: string[], label = key): void {
  const has = Object.hasOwn(obj, key);
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v < min) {
    issues.push(issue(label, `${min} 以上の整数を指定すること`, has, v));
  }
}

function checkBoolean(obj: Record<string, unknown>, key: string, issues: string[], label = key): void {
  const has = Object.hasOwn(obj, key);
  const v = obj[key];
  if (typeof v !== "boolean") {
    issues.push(issue(label, "true か false を指定すること", has, v));
  }
}

/**
 * config.json の生データを検査し、人間の言葉で問題点を列挙する(純粋)。
 * 問題が無ければ空配列を返す。ここで検査していない項目(triage / parallel / schemaVersion)は
 * 既存どおり寛容に正規化するため、ここでは検査しない。
 */
export function validateConfig(raw: unknown): string[] {
  if (!isPlainObject(raw)) {
    return [issue("config", "オブジェクトを指定すること", true, raw)];
  }
  const r = raw;
  const issues: string[] = [];

  checkNonEmptyString(r, "claudeCommand", issues);
  checkNonEmptyString(r, "model", issues);
  checkNonEmptyString(r, "permissionMode", issues);
  checkInt(r, "maxRetries", 0, issues);
  checkInt(r, "taskTimeoutMs", 1, issues);
  checkInt(r, "maxTurns", 1, issues);
  checkInt(r, "idlePollMs", 1, issues);

  {
    const has = Object.hasOwn(r, "rateLimit");
    const v = r.rateLimit;
    if (!isPlainObject(v)) {
      issues.push(issue("rateLimit", "オブジェクトを指定すること", has, v));
    } else {
      checkInt(v, "backoffMs", 0, issues, "rateLimit.backoffMs");
    }
  }

  {
    const has = Object.hasOwn(r, "explore");
    const v = r.explore;
    if (!isPlainObject(v)) {
      issues.push(issue("explore", "オブジェクトを指定すること", has, v));
    } else {
      checkBoolean(v, "enabled", issues, "explore.enabled");
      checkInt(v, "minIntervalMs", 0, issues, "explore.minIntervalMs");
    }
  }

  // escalation はキー自体が無いのは正常(無効化された既定値を使う既存挙動)。
  // キーがある場合だけ形を検査する。
  if (Object.hasOwn(r, "escalation")) {
    const v = r.escalation;
    if (!isPlainObject(v)) {
      issues.push(issue("escalation", "オブジェクトを指定すること", true, v));
    } else {
      const hasModel = Object.hasOwn(v, "model");
      // 空文字は「エスカレーション無効」の意味なので許可する
      if (typeof v.model !== "string") {
        issues.push(issue("escalation.model", "文字列を指定すること(空文字で無効化)", hasModel, v.model));
      }
      checkInt(v, "afterRetries", 0, issues, "escalation.afterRetries");
    }
  }

  return issues;
}

/**
 * config.json の生の中身から Config を組み立てる。
 * 上記 `validateConfig` が検査する項目は不正なら例外を投げて止める(既定値では埋めない。
 * 誤った設定のまま気付かず走り続けるのを避けるため)。triage / parallel は既存どおり
 * 欠損・型違いを既定値で埋める(古い形式の config.json もそのまま読み込めるようにするため)。
 */
export function normalizeConfig(raw: unknown, root: string, env: NodeJS.ProcessEnv = process.env): Config {
  const issues = validateConfig(raw);
  if (issues.length > 0) {
    const lines = issues.map((m) => `  - ${m}`).join("\n");
    throw new Error(`${AGENT_DIR_NAME}/config.json の内容がおかしい。次の項目を手で修正すること:\n${lines}`);
  }
  const r = raw as Record<string, unknown>;

  const escalation = isPlainObject(r.escalation)
    ? (r.escalation as unknown as Config["escalation"])
    : { model: "", afterRetries: Infinity };

  const p = isPlainObject(r.parallel) ? r.parallel : {};
  const maxSessionsRaw = p.maxSessions;
  const maxSessions =
    typeof maxSessionsRaw === "number" && Number.isFinite(maxSessionsRaw)
      ? Math.min(8, Math.max(1, Math.trunc(maxSessionsRaw)))
      : 1;
  // 相対パスは root 基準で正規化する。hook(WorktreeCreate)と Supervisor 本体が独立に
  // この config を読むため、cwd 依存のまま相対解決すると両者で違うパスに解決されうる。
  const worktreeDir =
    typeof p.worktreeDir === "string" && p.worktreeDir !== ""
      ? path.resolve(root, p.worktreeDir)
      : defaultWorktreeDir(root, env);
  const linkPaths = Array.isArray(p.linkPaths) ? (p.linkPaths as string[]) : ["node_modules"];

  const tr = isPlainObject(r.triage) ? r.triage : {};
  const triage: Config["triage"] = {
    enabled: typeof tr.enabled === "boolean" ? tr.enabled : true,
    model: typeof tr.model === "string" && tr.model !== "" ? tr.model : "haiku",
  };

  return {
    ...(r as unknown as Config),
    escalation,
    parallel: { maxSessions, worktreeDir, linkPaths },
    triage,
  };
}

/**
 * root 配下の `.agent/config.json` を読んで正規化する。
 * - ファイルが無い(ENOENT): 例外を投げず、完全な既定値の Config を返す(hook からも呼ばれるため、
 *   `.agent/` 未配置でもセッションの worktree 作成そのものを落とさない)。
 * - ファイルはあるが JSON として読めない: 例外を投げる(握りつぶして既定値へ倒すと、
 *   利用者が壊した設定に誰も気付けないまま既定値で走り続けることになるため)。
 * - JSON としては読めるが項目が不正: `normalizeConfig` が例外を投げる。
 */
export function loadConfigFrom(root: string, env: NodeJS.ProcessEnv = process.env): Config {
  const configPath = path.join(root, ".agent", "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return defaultConfig(root, env);
    throw new Error(
      `${AGENT_DIR_NAME}/config.json を JSON として読めない: ${String((err as Error)?.message ?? err)}。手で修正すること`,
    );
  }
  return normalizeConfig(raw, root, env);
}
