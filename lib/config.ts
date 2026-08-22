/**
 * `.agent/config.json` の読み込みと正規化
 *
 * Supervisor 本体だけでなく WorktreeCreate hook からも読む必要があるため
 * (hook と Supervisor が別々に worktree の置き場を計算して食い違うのを避けるため)、
 * 独立したモジュールに切り出している。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stateDirFor } from "./paths.ts";

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
  /** minIntervalMs: 直前の探索が空振り(新規タスク 0 件)だった場合の再探索クールダウン
   * (空振り探索の即時連鎖を防ぐ)。直前の探索がタスクを生んでいれば間隔を待たずに探索する */
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
 * config.json の生の中身から Config を組み立てる。欠損・不正値は既定値で埋める。
 * parallel を持たない古い形式の config.json もそのまま読み込める。
 */
export function normalizeConfig(raw: unknown, root: string, env: NodeJS.ProcessEnv = process.env): Config {
  const r = isPlainObject(raw) ? raw : {};

  const escalation = isPlainObject(r.escalation)
    ? (r.escalation as unknown as Config["escalation"])
    : { model: "", afterRetries: Infinity };

  const p = isPlainObject(r.parallel) ? r.parallel : {};
  const maxSessionsRaw = p.maxSessions;
  const maxSessions =
    typeof maxSessionsRaw === "number" && Number.isFinite(maxSessionsRaw)
      ? Math.min(8, Math.max(1, Math.trunc(maxSessionsRaw)))
      : 1;
  const worktreeDir =
    typeof p.worktreeDir === "string" && p.worktreeDir !== "" ? p.worktreeDir : defaultWorktreeDir(root, env);
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
 * ファイルが無い・壊れている場合も既定値だけの Config を返す(hook から呼ばれるため、
 * 設定の不備でセッションの worktree 作成そのものを落とさない)。
 */
export function loadConfigFrom(root: string, env: NodeJS.ProcessEnv = process.env): Config {
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, ".agent", "config.json"), "utf8"));
  } catch {
    raw = {};
  }
  return normalizeConfig(raw, root, env);
}
