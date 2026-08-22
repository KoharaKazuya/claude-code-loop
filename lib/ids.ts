/**
 * `.agent/` の ID(tasks / decisions / human-review)の形式を一箇所に集約する。
 *
 * 新規 ID は `<prefix>-<YYYYMMDD>-<HHMM>-<slug>`(prefix は T / D / HR、時刻は UTC)。
 * 連番採番をやめたのは、複数の worktree で同時に採番しても衝突せず、マージ時の改番が
 * 不要になるため。slug を必須にしているのは、ファイル名の一覧だけで内容の見当が付くようにするため。
 *
 * 旧形式(`T-NNN` / `D-YYYYMMDD-NN` / `HR-YYYYMMDD-NN`)のファイルは既存の資産として
 * 読めなければならないので、判定は新旧の両方を受け付ける。新規作成に旧形式は使わない。
 */

export type IdPrefix = "T" | "D" | "HR";

/** slug の最大長(語境界で切り詰める上限) */
export const SLUG_MAX_LENGTH = 40;

/** slug 単体の形。小文字英数字の語をハイフンで繋いだもの(先頭・末尾・連続のハイフンなし) */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 外から渡された slug(`--slug` や triage の応答)が使える形か。長さ上限も含めて判定する */
export function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && SLUG_RE.test(slug);
}

/** slug として意味を持つとみなす最小の長さ。これ未満は「たまたま拾えた断片」とみなし null にする */
const MIN_MEANINGFUL_SLUG_LENGTH = 3;

/** 語境界での切り詰め結果をこの長さ未満とみなしたら、ハード切り詰めへフォールバックする */
const WORD_BOUNDARY_TRUNCATION_MIN_LENGTH = 8;

/**
 * 任意のテキストから slug を作る。ASCII 英数字以外は区切りとして落とすため、
 * 日本語だけのタイトルなど slug に残る文字が無い入力では null を返す
 * (呼び出し側で既定値へフォールバックする)。上限を超える場合は語境界で切り詰める
 * (1 語だけで上限を超える場合に限り、語の途中で切る)。ただし語境界での切り詰めが
 * 極端に短い結果(例: 短い先頭語の直後に上限を超える 1 語が続く場合)を生むときは、
 * 語境界を無視した上限までのハード切り詰めにフォールバックする(末尾のハイフンは除去する)。
 * また、日本語混じりの入力から付随的な ASCII 断片だけが残ったような、内容の見当が
 * 付かない短すぎる結果(3 文字未満)は null にする。
 */
export function slugify(text: string): string | null {
  const normalized = text
    .normalize("NFKD")
    // NFKD で分解された結合文字(アクセント記号)は落とし、"café" を "cafe" として拾えるようにする
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized === "") return null;

  let result: string;
  if (normalized.length <= SLUG_MAX_LENGTH) {
    result = normalized;
  } else {
    // 上限の 1 文字先まで見ることで、境界がちょうど区切りに当たる場合に語を落とさずに済ませる
    const window = normalized.slice(0, SLUG_MAX_LENGTH + 1);
    const lastSep = window.lastIndexOf("-");
    const wordBoundaryTruncated = lastSep > 0 ? window.slice(0, lastSep) : normalized.slice(0, SLUG_MAX_LENGTH);
    result =
      wordBoundaryTruncated.length >= WORD_BOUNDARY_TRUNCATION_MIN_LENGTH
        ? wordBoundaryTruncated
        : normalized.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
  }

  return result.length < MIN_MEANINGFUL_SLUG_LENGTH ? null : result;
}

/**
 * ISO 8601 の日時文字列(`new Date().toISOString()` を想定)から ID の `YYYYMMDD-HHMM` 部分を作る。
 * 実行環境のタイムゾーンで ID が揺れないよう常に UTC で組み立てる。解釈できない文字列は現在時刻で
 * 代替する(ID を作れずに落ちるより、多少ずれた時刻で採番するほうが害が小さい)。
 */
export function idTimestamp(createdAt: string): string {
  const parsed = new Date(createdAt);
  const iso = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** 新形式の ID を組み立てる(既存 ID との衝突回避は disambiguateId が担う) */
export function buildId(prefix: IdPrefix, slug: string, createdAt: string): string {
  return `${prefix}-${idTimestamp(createdAt)}-${slug}`;
}

/**
 * 既に使われている ID を避けて `-2`, `-3`, ... を付ける。
 * taken には active と archive の両方を見る判定を渡すこと(ローテーション後の ID 再利用を防ぐため)。
 */
export function disambiguateId(baseId: string, taken: (id: string) => boolean): string {
  if (!taken(baseId)) return baseId;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${baseId}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`ID の衝突を回避できなかった: ${baseId}`);
}
