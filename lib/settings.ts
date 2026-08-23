/**
 * 自律実行セッションへ渡す claude settings の生成
 *
 * hooks と最低限の permissions は ccloop 自身が持つ(lib/settings.template.json)。
 * hooks のコマンドは `$CCLOOP_HOME/hooks/*.ts` を指しており、`claude` の子プロセスへ
 * `CCLOOP_HOME` を渡すことで、リポジトリの外に置かれた ccloop の hook を実行させる。
 *
 * 利用側リポジトリは `.agent/claude-settings.json` で permissions.allow / permissions.deny を
 * 追記できる(リポジトリ固有のコマンドを許可する等)。hooks は上書きさせない:
 * hooks は Supervisor の制御(AskUserQuestion の禁止、タスク更新の強制、worktree の作成)そのものであり、
 * 利用側が差し替えられるとループの前提が崩れるため。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ccloopHome, type Paths } from "./paths.ts";

export interface SettingsPermissions {
  allow?: string[];
  deny?: string[];
}

export interface Settings {
  permissions?: SettingsPermissions;
  hooks?: unknown;
  [key: string]: unknown;
}

/** テンプレートのファイルパス(CCLOOP_HOME 配下) */
export function settingsTemplatePath(home: string = ccloopHome()): string {
  return path.join(home, "settings.template.json");
}

/** 文字列だけを取り出した配列(不正な要素は捨てる) */
function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** base の後ろに extra のうち未収録のものを足す(順序は base 優先、重複なし) */
function appendUnique(base: string[], extra: string[]): string[] {
  const seen = new Set(base);
  const result = [...base];
  for (const item of extra) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/**
 * テンプレート由来の settings に、利用側リポジトリの追記分をマージする(純粋)。
 * permissions.allow / permissions.deny だけを追記し、hooks とその他のキーはテンプレートを保つ。
 */
export function mergeSettings(base: Settings, overlay: unknown): Settings {
  const o = typeof overlay === "object" && overlay !== null ? (overlay as Settings) : {};
  const op = typeof o.permissions === "object" && o.permissions !== null ? o.permissions : {};
  return {
    ...base,
    permissions: {
      ...base.permissions,
      allow: appendUnique(stringList(base.permissions?.allow), stringList(op.allow)),
      deny: appendUnique(stringList(base.permissions?.deny), stringList(op.deny)),
    },
  };
}

/**
 * 生成した settings 自身と生成した system prompt への自己改変を禁じる deny エントリ。
 *
 * これらはリポジトリの外(state ディレクトリ)にあるため git diff でレビューされない。
 * `.agent/claude-settings.json` の deny だけでは、そこに書かれた permissions.deny 自体を
 * 上書きする経路(生成 settings ファイルへの直接の Write/Edit)を塞げないため、絶対パスで
 * 個別に拒否する。`Edit(//abs/path)` は claude の permission 記法における絶対パス接頭辞
 * `/` + 絶対パス。Edit への deny だけで Write ツールによる書き込みも止まることを実機確認済みのため、
 * `Write(...)` は列挙しない(冗長)。
 */
function selfProtectDenyEntries(paths: Paths): string[] {
  return [paths.generatedSettingsPath, paths.generatedSystemPromptPath].map(
    (target) => `Edit(/${target})`,
  );
}

/** 利用側リポジトリの追記用 settings(`.agent/claude-settings.json`)。無ければ null */
export function readRepoSettings(paths: Paths): unknown {
  const file = path.join(paths.agentDir, "claude-settings.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * 自律実行セッション用の settings を生成し、`paths.generatedSettingsPath` へ書き出す。
 * 書き出したパスを返す。`ccloop run` の起動時に 1 回だけ呼べばよい。
 */
export function generateSettings(paths: Paths, opts: { home?: string } = {}): string {
  const templateText = fs.readFileSync(settingsTemplatePath(opts.home ?? ccloopHome()), "utf8");
  const base = JSON.parse(templateText) as Settings;
  const merged = mergeSettings(base, readRepoSettings(paths));
  merged.permissions = {
    ...merged.permissions,
    deny: appendUnique(stringList(merged.permissions?.deny), selfProtectDenyEntries(paths)),
  };
  fs.mkdirSync(path.dirname(paths.generatedSettingsPath), { recursive: true });
  const tmp = `${paths.generatedSettingsPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  fs.renameSync(tmp, paths.generatedSettingsPath);
  return paths.generatedSettingsPath;
}
