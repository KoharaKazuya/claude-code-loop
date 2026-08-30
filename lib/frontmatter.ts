/**
 * YAML frontmatter の最小サブセットのパースとシリアライズ。
 *
 * .agent/ の記録ファイル(tasks / decisions / human-review)は
 * 「1 トピック 1 ファイル + frontmatter」で表現される。依存ゼロを保つため
 * 汎用 YAML は扱わず、次のフラットな形式のみ対応する:
 *
 *   - スカラー: 文字列(必要なら二重引用符 = JSON 文字列)・整数
 *   - インライン配列: [a, b, "c, d"]
 *
 * ネスト・複数行の値は非対応。長い内容は frontmatter ではなく本文に書く運用とする。
 * 本文(2 つ目の "---" 以降)は前後の空行を除いてそのまま保持する。
 */

export type FrontmatterValue = string | number | string[];

export interface ParsedFile {
  data: Record<string, FrontmatterValue>;
  body: string;
}

/**
 * frontmatter 付きテキストをパースする。frontmatter がない・閉じられていない場合は
 * 全体を本文として返す(壊れたファイルで例外を投げない)。不正な行は無視する。
 */
export function parseFrontmatter(text: string): ParsedFile {
  // 先頭 BOM(エディタ・一部ツールが付与する)と CRLF 改行を、判定・パースの前に正規化する
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  const afterEnd = end === -1 ? -1 : end + "\n---".length;
  // 閉じ "---" は行として独立していること(直後がファイル末尾または改行)
  if (end === -1 || (text[afterEnd] !== undefined && text[afterEnd] !== "\n")) {
    return { data: {}, body: text };
  }

  const data: Record<string, FrontmatterValue> = {};
  for (const line of text.slice("---\n".length, end).split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):(?:\s+(.*))?$/);
    if (!m) continue;
    data[m[1]!] = parseValue((m[2] ?? "").trim());
  }
  const body = text.slice(afterEnd).replace(/^\n+/, "").replace(/\s+$/, "");
  return { data, body };
}

/** data と本文からファイル全体のテキストを組み立てる。value が undefined のキーは省く */
export function serializeFrontmatter(
  data: Record<string, FrontmatterValue | undefined>,
  body: string,
): string {
  const lines = Object.entries(data)
    .filter((e): e is [string, FrontmatterValue] => e[1] !== undefined)
    .map(([key, value]) => `${key}: ${serializeValue(value)}`);
  const trimmedBody = body.trim();
  return ["---", ...lines, "---", ...(trimmedBody === "" ? [] : ["", trimmedBody])].join("\n") + "\n";
}

// ---------- 値のパース ----------

function parseValue(raw: string): FrontmatterValue {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return splitItems(inner).map((item) => String(parseScalar(item)));
  }
  return parseScalar(raw);
}

function parseScalar(raw: string): string | number {
  if (raw.startsWith('"')) {
    try {
      return String(JSON.parse(raw));
    } catch {
      return raw; // 壊れた引用符はそのまま文字列として扱う
    }
  }
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** インライン配列の中身を、二重引用符内のカンマを区切りとみなさずに分割する */
function splitItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '"' && inner[i - 1] !== "\\") inQuote = !inQuote;
    if (ch === "," && !inQuote) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") items.push(current.trim());
  return items;
}

// ---------- 値のシリアライズ ----------

function serializeValue(value: FrontmatterValue): string {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(serializeScalar).join(", ")}]`;
  return serializeScalar(value);
}

/**
 * 引用符なしで安全に往復できる文字列(英数と ._:/+- のみ、かつ数値と紛れない)だけを
 * 素のまま出力し、それ以外(日本語・空白・記号を含む文字列)は JSON 文字列にする。
 */
function serializeScalar(value: string): string {
  if (/^[\w.:/+-]+$/.test(value) && !/^-?\d+$/.test(value)) return value;
  return JSON.stringify(value);
}
