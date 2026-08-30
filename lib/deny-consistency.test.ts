import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { commonPromptPath } from "./prompt.ts";
import { settingsTemplatePath, type Settings } from "./settings.ts";

const TEMPLATE_TEXT = fs.readFileSync(settingsTemplatePath(import.meta.dirname), "utf8");
const PROMPT_TEXT = fs.readFileSync(commonPromptPath(import.meta.dirname), "utf8");

const SECTION_HEADING = "## Bash 実行の権限制約";
const DENY_BLOCK_START = "- deny で拒否される操作";

/**
 * PROMPT.md 全文から `SECTION_HEADING` の行以降、次に現れる `^## ` の行の直前までを
 * 「節」として切り出す。見つからなければ null を返す(呼び出し側で明確に失敗させるため)。
 */
function extractSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * 節の中から `DENY_BLOCK_START` で始まる行から、次に現れるトップレベル箇条書き
 * (`^- ` で始まる行)の直前までを「deny ブロック」として切り出す。
 * 見つからなければ null を返す。
 */
function extractDenyBlock(section: string): string | null {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => line.startsWith(DENY_BLOCK_START));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** deny ブロック中の inline code span(バッククォートで囲まれた文字列)を全部集める */
function extractMentions(denyBlock: string): Set<string> {
  const mentions = new Set<string>();
  for (const m of denyBlock.matchAll(/`([^`]+)`/g)) {
    mentions.add(m[1]);
  }
  return mentions;
}

/**
 * テンプレートの deny エントリのうち、マッピング表にキーが無いものを返す。
 * (deny を足したのに対応表への追記を忘れた、を検知する)
 */
function findUnmappedDeny(
  templateDeny: readonly string[],
  table: Record<string, readonly string[]>,
): string[] {
  return templateDeny.filter((pattern) => !(pattern in table));
}

/**
 * マッピング表のキーのうち、テンプレートの deny に存在しないものを返す。
 * (deny を削除したのに対応表のエントリを消し忘れた、表の陳腐化を検知する)
 */
function findStaleMappings(
  templateDeny: readonly string[],
  table: Record<string, readonly string[]>,
): string[] {
  return Object.keys(table).filter((pattern) => !templateDeny.includes(pattern));
}

/**
 * マッピング表に載っている各パターンの期待トークンのうち、mentions に現れていないものを
 * `"<pattern> -> <token>"` の形で返す。表に無いパターンは(不備は findUnmappedDeny が検知するため)
 * スキップする。
 */
function findMissingMentions(
  templateDeny: readonly string[],
  table: Record<string, readonly string[]>,
  mentions: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  for (const pattern of templateDeny) {
    const tokens = table[pattern];
    if (!tokens) continue; // マッピング表への不備は findUnmappedDeny で検知する
    for (const token of tokens) {
      if (!mentions.has(token)) missing.push(`${pattern} -> ${token}`);
    }
  }
  return missing;
}

/**
 * mentions のうち、マッピング表の値の集合にも `free`(テンプレートに対応物を持たない
 * 明示的な許容リスト)にも含まれないものを返す(逆方向の検知: PROMPT.md がテンプレートに
 * 無い deny をあるかのように書いていないか)。
 */
function findUnexpectedMentions(
  mentions: ReadonlySet<string>,
  table: Record<string, readonly string[]>,
  free: readonly string[],
): string[] {
  const allowed = new Set<string>([...Object.values(table).flat(), ...free]);
  return [...mentions].filter((token) => !allowed.has(token));
}

const section = extractSection(PROMPT_TEXT, SECTION_HEADING);
const denyBlock = section === null ? null : extractDenyBlock(section);
const mentions = denyBlock === null ? new Set<string>() : extractMentions(denyBlock);

/**
 * テンプレートの deny パターン → PROMPT.md の deny ブロックに現れるべき inline code トークン、
 * の対応表。PROMPT.md は deny パターン文字列(`Bash(git push*)` 等)をそのまま列挙しておらず
 * 散文で説明しているため、テンプレートの deny エントリと PROMPT.md の記述を文字列完全一致では
 * 突き合わせられない。そのためこの表で「このパターンなら少なくともこの語が言及されているはず」
 * という対応を明示する。
 */
const EXPECTED_MENTIONS: Record<string, readonly string[]> = {
  "Read(~/.claude/**)": ["~/.claude/"],
  "Read(~/.ssh/**)": ["~/.ssh/"],
  "Read(~/.aws/**)": ["~/.aws/"],
  "Read(~/.config/gh/**)": ["~/.config/gh/"],
  "Read(./.env)": [".env"],
  "Read(./.env.*)": [".env.*"],
  "Edit(./.agent/claude-settings.json)": [".agent/claude-settings.json"],
  "Edit(./.agent/config.json)": [".agent/config.json"],
  "Bash(git push*)": ["git push"],
  "Bash(git checkout*)": ["checkout"],
  "Bash(git switch*)": ["switch"],
  "Bash(git merge)": ["git merge"],
  "Bash(git merge *)": ["git merge"],
  "Bash(git rebase*)": ["rebase"],
  "Bash(git reset*)": ["reset"],
  "Bash(git clean*)": ["clean"],
  "Bash(git stash)": ["git stash"],
  "Bash(git stash -*)": ["-u"],
  "Bash(git stash push*)": ["push"],
  "Bash(git stash save*)": ["save"],
  "Bash(git stash pop*)": ["pop"],
  "Bash(git stash apply*)": ["apply"],
  "Bash(git stash drop*)": ["drop"],
  "Bash(git stash clear*)": ["clear"],
  "Bash(git stash branch*)": ["branch"],
  "Bash(git stash create*)": ["create"],
  "Bash(git stash store*)": ["store"],
  "Bash(git worktree add*)": ["git worktree", "add"],
  "Bash(git worktree remove*)": ["remove"],
  "Bash(git worktree move*)": ["move"],
  "Bash(git worktree prune*)": ["prune"],
  "Bash(git worktree lock*)": ["lock"],
  "Bash(git worktree unlock*)": ["unlock"],
  "Bash(git worktree repair*)": ["repair"],
  "Bash(git branch -D *)": ["git branch -d/-D/-m/-M"],
  "Bash(git branch -d *)": ["git branch -d/-D/-m/-M"],
  "Bash(git branch -m *)": ["git branch -d/-D/-m/-M"],
  "Bash(git branch -M *)": ["git branch -d/-D/-m/-M"],
  "Bash(sudo *)": ["sudo"],
};

// テンプレートの deny エントリに対応しない inline code トークンの明示的な許容リスト。用途は 2 つ:
//   1. テンプレートに書けない deny(lib/settings.ts が state ディレクトリの絶対パスに対して実行時に
//      追加する自己改変禁止の Edit deny)を PROMPT.md 側で inline code で言及した場合。現状その言及は
//      散文で書かれており inline code ではないため該当なし。
//   2. 「禁止されない読み取り専用コマンド」として deny ブロック内に併記しているもの。deny を接頭辞から
//      狭めた結果どれが通るようになったかは deny の説明の一部なので、同じブロックに書いている。
const TEMPLATE_FREE_MENTIONS: readonly string[] = [
  "git merge-base",
  "git merge-tree",
  "git stash list",
  "git stash show",
  "git worktree list",
];

const templateDeny: string[] = (JSON.parse(TEMPLATE_TEXT) as Settings).permissions?.deny ?? [];

describe("deny リストと PROMPT.md の一致", () => {
  it("PROMPT.md から deny ブロックを抽出できる(抽出に失敗すると後続のテストがすべて空振りするため)", () => {
    expect(section, `見出し "${SECTION_HEADING}" が PROMPT.md に見つからない`).not.toBeNull();
    expect(
      denyBlock,
      `"${DENY_BLOCK_START}" から始まる箇条書きが節の中に見つからない`,
    ).not.toBeNull();
    expect(mentions.size).toBeGreaterThan(0);
  });

  it("テンプレートの deny エントリはすべてマッピング表に載っている(表に無いエントリを素通りさせない)", () => {
    expect(findUnmappedDeny(templateDeny, EXPECTED_MENTIONS)).toEqual([]);
  });

  it("マッピング表にテンプレートへ存在しないキーが残っていない(表の陳腐化を防ぐ)", () => {
    expect(findStaleMappings(templateDeny, EXPECTED_MENTIONS)).toEqual([]);
  });

  it("テンプレートの各 deny エントリが PROMPT.md の deny ブロックで言及されている(説明が追随しない deny を検知するため)", () => {
    expect(findMissingMentions(templateDeny, EXPECTED_MENTIONS, mentions)).toEqual([]);
  });

  it("PROMPT.md の deny ブロックにテンプレート由来でない言及が混ざっていない(逆方向の検知)", () => {
    expect(findUnexpectedMentions(mentions, EXPECTED_MENTIONS, TEMPLATE_FREE_MENTIONS)).toEqual([]);
  });
});

/**
 * Claude Code の Bash permission パターン照合の**保守的な近似**。
 *
 * 本家の規則(claude-code 2.1.220 の実装を確認したもの)は次の 3 型に分かれる:
 *   - `*` を含まない  → 完全一致(大文字小文字は無視)
 *   - `<prefix>:*`    → 語境界つきの前方一致
 *   - それ以外の `*`  → `*` を `.*` に開いた全体 anchor つき正規表現(語境界を強制しない)
 * ここでは本家が wildcard 型に持っている「末尾が半角スペース + `*` なら、その部分を丸ごと
 * 省略可能として扱う」特例を**あえて再現しない**。特例に依存しない分だけ判定が厳しくなる
 * (= deny の範囲を狭く見積もる)ため、このテストが「禁止されている」と言えるものは本家でも
 * 確実に禁止される。引数なしの `git merge` / `git stash` はこの特例に頼らず、専用の完全一致
 * エントリで禁止していることの確認も兼ねる。
 */
function matchesDenyPattern(pattern: string, command: string): boolean {
  const normalize = (s: string) => s.trim().replace(/[ \t]+/g, " ");
  const p = normalize(pattern);
  const c = normalize(command);
  if (!p.includes("*")) return p.toLowerCase() === c.toLowerCase();

  const source = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${source}$`, "i").test(c);
}

/** deny 一覧のいずれかのパターンに command が一致するか */
function isDenied(command: string, deny: readonly string[]): boolean {
  return deny.some((entry) => {
    const m = /^Bash\((.+)\)$/.exec(entry);
    return m !== null && matchesDenyPattern(m[1], command);
  });
}

// 読み取り専用のため通したいコマンド。ccloop 自身が lib/worktree.ts と lib/supervisor.ts で
// `git worktree list --porcelain` と `git merge-base` を使っており、その周辺を調べるセッションが
// 手元で同じコマンドを打てないと実機再現ができない、というのがこれらを外した理由である。
const MUST_BE_ALLOWED = [
  "git merge-base HEAD main",
  "git merge-base --is-ancestor a b",
  "git merge-tree main topic",
  "git worktree list",
  "git worktree list --porcelain",
  "git stash list",
  "git stash show -p stash@{0}",
];

// 変更を伴うため引き続き禁止し続けたいコマンド。deny を狭めた結果ここが通ってしまう
// (緩めすぎ)ことを防ぐのがこのリストの役割。
const MUST_STAY_DENIED = [
  "git merge main",
  "git merge --abort",
  "git merge",
  "git worktree add ../wt topic",
  "git worktree remove ../wt",
  "git worktree prune",
  "git worktree move ../a ../b",
  "git worktree lock ../wt",
  "git worktree unlock ../wt",
  "git worktree repair",
  "git stash",
  "git stash -u",
  'git stash push -u -m "tag"',
  "git stash pop",
  "git stash apply stash@{0}",
  "git stash drop stash@{0}",
  "git stash clear",
  "git stash branch topic",
  "git push origin main",
  "git checkout main",
  "git switch -c topic",
  "git rebase main",
  "git reset --hard HEAD",
  "git clean -fd",
];

describe("deny パターンの粒度(読み取り専用の巻き添えを防ぎ、変更系は禁止し続ける)", () => {
  it.each(MUST_BE_ALLOWED)("読み取り専用の `%s` は deny に一致しない", (command) => {
    expect(isDenied(command, templateDeny)).toBe(false);
  });

  it.each(MUST_STAY_DENIED)("変更を伴う `%s` は deny に一致する", (command) => {
    expect(isDenied(command, templateDeny)).toBe(true);
  });
});

describe("ドリフト検知の自己テスト(検査自体が機能していることの確認)", () => {
  it("findUnmappedDeny: テンプレートにあって表に無いパターンを検知する(deny 追加時の書き忘れの一次検知)", () => {
    const table = { "Bash(sudo *)": ["sudo"] };

    expect(findUnmappedDeny(["Bash(sudo *)", "Bash(new-thing *)"], table)).toEqual([
      "Bash(new-thing *)",
    ]);
  });

  it("findStaleMappings: 表にあってテンプレートに無いキーを検知する(表の陳腐化の検知)", () => {
    const table = { "Bash(sudo *)": ["sudo"], "Bash(gone *)": ["gone"] };

    expect(findStaleMappings(["Bash(sudo *)"], table)).toEqual(["Bash(gone *)"]);
  });

  it("findMissingMentions: 表に載っているが mentions に無いトークンを検知する", () => {
    const table = { "Bash(sudo *)": ["sudo"] };

    expect(findMissingMentions(["Bash(sudo *)"], table, new Set())).toEqual([
      "Bash(sudo *) -> sudo",
    ]);
  });

  it("findMissingMentions: 表に無いパターンはスキップする(findUnmappedDeny の担当のため二重検知しない)", () => {
    const table = {};

    expect(findMissingMentions(["Bash(new-thing *)"], table, new Set())).toEqual([]);
  });

  it("findUnexpectedMentions: 表にも free にも無い mention を検知し、free に入れれば検知されない", () => {
    const table = { "Bash(sudo *)": ["sudo"] };
    const mentions = new Set(["sudo", "unexpected-token"]);

    expect(findUnexpectedMentions(mentions, table, [])).toEqual(["unexpected-token"]);
    expect(findUnexpectedMentions(mentions, table, ["unexpected-token"])).toEqual([]);
  });

  it("matchesDenyPattern: 空白を挟まない `git merge*` は `git merge-base` まで巻き込む(狭める前の状態の再現)", () => {
    expect(matchesDenyPattern("git merge*", "git merge-base HEAD main")).toBe(true);
    expect(matchesDenyPattern("git merge *", "git merge-base HEAD main")).toBe(false);
    expect(matchesDenyPattern("git merge *", "git merge main")).toBe(true);
  });

  it("matchesDenyPattern: `*` を含まないパターンは完全一致(前方一致にしない)", () => {
    expect(matchesDenyPattern("git merge", "git merge")).toBe(true);
    expect(matchesDenyPattern("git merge", "git merge main")).toBe(false);
  });

  it("extractSection: 見出しが無ければ null を返す", () => {
    expect(extractSection("# a\n\nfoo\n", "## Bash 実行の権限制約")).toBeNull();
  });

  it("extractSection: 次の `## ` 見出しの手前で切れる", () => {
    const text = ["## A", "line1", "line2", "## B", "line3"].join("\n");

    expect(extractSection(text, "## A")).toBe(["## A", "line1", "line2"].join("\n"));
  });

  it("extractDenyBlock: 開始行が無ければ null を返す", () => {
    expect(extractDenyBlock(["## A", "foo", "bar"].join("\n"))).toBeNull();
  });

  it("extractDenyBlock: 次のトップレベル箇条書きの手前で切れ、サブ箇条書きは含まれる", () => {
    const section = [
      "## A",
      "- deny で拒否される操作",
      "  - サブ項目1",
      "  - サブ項目2",
      "- allow は読み取り専用のコマンドに限る",
      "  - 別のサブ項目",
    ].join("\n");

    expect(extractDenyBlock(section)).toBe(
      ["- deny で拒否される操作", "  - サブ項目1", "  - サブ項目2"].join("\n"),
    );
  });

  it("extractMentions: バッククォート内の文字列だけを拾う", () => {
    expect([...extractMentions("- `a` と b と `c d` について")]).toEqual(["a", "c d"]);
  });
});
