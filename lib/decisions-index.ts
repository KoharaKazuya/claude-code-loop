/**
 * `.agent/decisions/index.md` のパース・整形・3-way マージ。
 *
 * この index.md は `rotate.ts`(単一プロセス内でのリコンサイル)と `merge.ts`
 * (並列セッションが同時に追記したときのコンフリクト機械解決)の両方から使われるため、
 * 共有ロジックをここへ集約する。rotate.ts はエントリの並び順を ID 降順(新しい順)に
 * 正規化しており、`mergeDecisionsIndexText` もそれに合わせて出力を安定させる(次回
 * rotate 実行時に無用な差分が出ないようにするため)。
 */

/** `- [ ] [<ID>](<ID>.md) — <要約>` 形式の行にマッチ。要約は省略可 */
export const DECISIONS_INDEX_LINE_RE = /^- \[( |x|X)\] \[([^\]]+)\]\([^)]*\)(?:\s*—\s*(.*))?\s*$/;

export const DECISIONS_INDEX_DEFAULT_HEADER =
  "# 決定インデックス\n\nチェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。\n\n";

export interface DecisionIndexEntry {
  id: string;
  checked: boolean;
  summary: string;
}

/**
 * index.md のテキストを、リスト行より前(header)・リスト行(entries)・リスト行より後(footer)に
 * 分解する。人間が書き足した前後の文章を書き換えで失わないよう、header / footer はそのまま持ち回る。
 */
export function parseDecisionsIndex(text: string): {
  header: string;
  entries: DecisionIndexEntry[];
  footer: string;
} {
  const lines = text.split("\n");
  const entries: DecisionIndexEntry[] = [];
  let firstListLineIdx = -1;
  let lastListLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = DECISIONS_INDEX_LINE_RE.exec(lines[i]!);
    if (!m) continue;
    if (firstListLineIdx === -1) firstListLineIdx = i;
    lastListLineIdx = i;
    entries.push({ id: m[2]!, checked: m[1]!.toLowerCase() === "x", summary: (m[3] ?? "").trim() });
  }
  if (firstListLineIdx === -1) {
    // リスト行が 1 行も無い(全件アーカイブ済みなど)場合、本文全体がヘッダ部である。
    // ここで既定ヘッダに差し替えると人間が編集したヘッダを毎回上書きしてしまう。
    if (text === "") return { header: DECISIONS_INDEX_DEFAULT_HEADER, entries: [], footer: "" };
    return { header: text.endsWith("\n") ? text : text + "\n", entries: [], footer: "" };
  }
  const headLines = lines.slice(0, firstListLineIdx);
  const header = headLines.length === 0 ? "" : headLines.join("\n") + "\n";
  const footer = lines.slice(lastListLineIdx + 1).join("\n");
  return { header, entries, footer };
}

export function formatDecisionsIndexLine(entry: DecisionIndexEntry): string {
  return `- [${entry.checked ? "x" : " "}] [${entry.id}](${entry.id}.md) — ${entry.summary}`;
}

export function buildDecisionsIndexText(
  header: string,
  entries: DecisionIndexEntry[],
  footer: string,
): string {
  // リストが空になったらヘッダとフッタを連結する(次回は全体がヘッダ扱いになり、以降安定する)
  if (entries.length === 0) return header + footer.replace(/^\n+/, "");
  // ヘッダとリストの間は必ず空行 1 行にする(再パース時にヘッダが往復一致するため)
  const separated = header === "" || header.endsWith("\n\n") ? header : header + "\n";
  return separated + entries.map(formatDecisionsIndexLine).join("\n") + "\n" + footer;
}

/** エントリを ID 降順(rotate のリコンサイルと同じ順序)に整列する */
export function sortDecisionIndexEntries(entries: DecisionIndexEntry[]): DecisionIndexEntry[] {
  return [...entries].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * index.md の 3-way マージ。解決できないときは null を返す。
 * base は共通祖先の内容(add/add で祖先が無い場合は null)。
 *
 * エントリは ID をキーに 3-way マージする:
 * - ours/theirs 両方にあれば採用する。checked は「どちらかがチェック済みなら採用」、
 *   summary は base と異なる側を優先する(両方 base と異なり互いに異なる場合は ours を採用。
 *   要約の差異は情報の欠落を招かないため衝突扱いにしない)。
 * - 片側にのみあり、base にも存在する ID は「もう片方で削除された」と解釈して落とす
 *   (rotate によるアーカイブ済みエントリが復活しないようにするため)。
 * - 片側にのみあり、base に無い ID は「その側で新規追加された」と解釈して採用する。
 * - base にのみあり ours/theirs のどちらにも無い ID は落とす。
 *
 * header/footer は ours・theirs それぞれについて、一致していればそれを採用し、
 * 一致しなければ base と異なる側を採用する。両方が base と異なる(= 両側で別々に
 * 書き換えられた)場合は機械的に解決できないため、この関数全体として null を返す
 * (base が null のときも、ours と theirs の header/footer が一致しなければ null)。
 */
export function mergeDecisionsIndexText(base: string | null, ours: string, theirs: string): string | null {
  const baseParsed = base === null ? null : parseDecisionsIndex(base);
  const oursParsed = parseDecisionsIndex(ours);
  const theirsParsed = parseDecisionsIndex(theirs);

  const mergedPart = mergeTextPart(baseParsed?.header ?? null, oursParsed.header, theirsParsed.header);
  if (mergedPart === null) return null;
  const mergedFooter = mergeTextPart(baseParsed?.footer ?? null, oursParsed.footer, theirsParsed.footer);
  if (mergedFooter === null) return null;

  // 同じ側に同一 ID の行が複数あるのは手編集で壊れた index.md の場合のみで、その場合は
  // Map の構築により無警告で最後の行が採用される(壊れた入力に対しては最後の行を採る、という
  // 意図した挙動)。
  const baseById = new Map((baseParsed?.entries ?? []).map((e) => [e.id, e] as const));
  const oursById = new Map(oursParsed.entries.map((e) => [e.id, e] as const));
  const theirsById = new Map(theirsParsed.entries.map((e) => [e.id, e] as const));

  const allIds = new Set<string>([...baseById.keys(), ...oursById.keys(), ...theirsById.keys()]);

  const merged: DecisionIndexEntry[] = [];
  for (const id of allIds) {
    const baseEntry = baseById.get(id);
    const oursEntry = oursById.get(id);
    const theirsEntry = theirsById.get(id);

    if (oursEntry !== undefined && theirsEntry !== undefined) {
      merged.push(mergeEntry(baseEntry, oursEntry, theirsEntry));
      continue;
    }
    if (oursEntry !== undefined && theirsEntry === undefined) {
      if (baseEntry !== undefined) continue; // theirs 側で削除された → 削除を優先
      merged.push(oursEntry); // ours で新規追加
      continue;
    }
    if (oursEntry === undefined && theirsEntry !== undefined) {
      if (baseEntry !== undefined) continue; // ours 側で削除された → 削除を優先
      merged.push(theirsEntry); // theirs で新規追加
      continue;
    }
    // 両方に無い(base にのみあった) → 落とす
  }

  const sorted = sortDecisionIndexEntries(merged);
  return buildDecisionsIndexText(mergedPart, sorted, mergedFooter);
}

/** header/footer など「エントリでないテキスト断片」を 3-way マージする。解決不能なら null */
function mergeTextPart(base: string | null, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours;
  if (base !== null && ours === base) return theirs;
  if (base !== null && theirs === base) return ours;
  return null;
}

/** 両側に存在するエントリをマージする */
function mergeEntry(
  base: DecisionIndexEntry | undefined,
  ours: DecisionIndexEntry,
  theirs: DecisionIndexEntry,
): DecisionIndexEntry {
  const checked = ours.checked || theirs.checked;

  let summary: string;
  if (ours.summary === theirs.summary) {
    summary = ours.summary;
  } else if (base !== undefined && ours.summary === base.summary) {
    summary = theirs.summary;
  } else if (base !== undefined && theirs.summary === base.summary) {
    summary = ours.summary;
  } else {
    // 両方が base と異なり、かつ互いに異なる(または base が無い) → ours を採用
    summary = ours.summary;
  }

  return { id: ours.id, checked, summary };
}
