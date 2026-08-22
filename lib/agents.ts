/**
 * 自律実行セッションへ渡すサブエージェント定義の生成
 *
 * サブエージェント(現状は reviewer)はツール本体が `lib/agents/*.md` として持ち、
 * claude 起動時に `--agents <JSON>` で注入する。利用側リポジトリに `.claude/agents/` を
 * 置かせない(ccloop は `.agent/` だけを利用側へ要求する)ための仕組み。
 *
 * ファイル形式はファイルベースのサブエージェント定義と同じ「YAML frontmatter + 本文」。
 * frontmatter の name / description / tools / model を読み、`--agents` の JSON へ変換する。
 * `--agents` の JSON は name をオブジェクトのキーとして表すため、フィールドとしては渡さない。
 * `tools` は JSON では配列だが、frontmatter ではカンマ区切り文字列で書かれるのが通例なので
 * どちらの表記でも受け取って配列へ正規化する。
 *
 * 仕様: https://code.claude.com/docs/en/sub-agents.md の「--agents」節。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { ccloopHome } from "./paths.ts";

/** `--agents` の JSON 1 件分(このリポジトリが使うフィールドだけ) */
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

/** 名前付きのサブエージェント定義一式(`--agents` に渡す JSON と同じ形) */
export type AgentDefinitions = Record<string, AgentDefinition>;

/** サブエージェント定義の置き場(CCLOOP_HOME 配下の `agents/`) */
export function agentsDir(home: string = ccloopHome()): string {
  return path.join(home, "agents");
}

/** frontmatter の tools を配列へ正規化する。カンマ区切り文字列・配列のどちらでも受ける */
function normalizeTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string").map((v) => v.trim());
    return items.length === 0 ? undefined : items;
  }
  if (typeof value !== "string") return undefined;
  const items = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return items.length === 0 ? undefined : items;
}

/**
 * サブエージェント定義ファイル 1 件をパースする(純粋)。
 * description か本文が欠けているものは定義として成立しないため null を返す
 * (`--agents` の必須フィールド)。name は frontmatter 優先、無ければ fallbackName。
 */
export function parseAgentFile(text: string, fallbackName: string): { name: string; definition: AgentDefinition } | null {
  const { data, body } = parseFrontmatter(text);
  const description = typeof data.description === "string" ? data.description.trim() : "";
  const prompt = body.trim();
  if (description === "" || prompt === "") return null;

  const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : fallbackName;
  const tools = normalizeTools(data.tools);
  const model = typeof data.model === "string" && data.model.trim() !== "" ? data.model.trim() : undefined;
  return {
    name,
    definition: {
      description,
      prompt,
      ...(tools === undefined ? {} : { tools }),
      ...(model === undefined ? {} : { model }),
    },
  };
}

/**
 * ディレクトリ内の全 `.md` を読んでサブエージェント定義を組み立てる。
 * ディレクトリが無い・読めない場合は空(サブエージェント無しで起動する)。
 */
export function loadAgentDefinitions(dir: string = agentsDir()): AgentDefinitions {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return {};
  }
  const defs: AgentDefinitions = {};
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseAgentFile(text, file.slice(0, -".md".length));
    if (parsed === null) continue;
    defs[parsed.name] = parsed.definition;
  }
  return defs;
}

/**
 * `--agents` に渡す引数(定義が 1 件も無ければ空配列 = フラグごと付けない)。
 * 読み込みはプロセス内で 1 度だけ行い、セッションを起動するたびのファイル I/O を避ける
 * (`lib/agents/` はツール本体の一部であり、稼働中に書き換わることはない)。
 */
const cache = new Map<string, string[]>();

export function agentsArgs(home: string = ccloopHome()): string[] {
  const dir = agentsDir(home);
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;
  const defs = loadAgentDefinitions(dir);
  const args = Object.keys(defs).length === 0 ? [] : ["--agents", JSON.stringify(defs)];
  cache.set(dir, args);
  return args;
}

/** テスト用: agentsArgs のキャッシュを捨てる */
export function clearAgentsCache(): void {
  cache.clear();
}
