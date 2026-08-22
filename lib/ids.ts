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

/** 新形式の ID 全体。衝突回避で付く `-2` などは slug 側の語として吸収される */
export const ID_RE = /^(?:T|D|HR)-\d{8}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 旧形式の ID(読み取り互換のためだけに認める) */
export const LEGACY_ID_RE = /^(?:T-\d+|(?:D|HR)-\d{8}-\d+)$/;

/** 外から渡された slug(`--slug` や triage の応答)が使える形か。長さ上限も含めて判定する */
export function isValidSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && SLUG_RE.test(slug);
}

/** 新形式の ID か */
export function isNewFormatId(id: string): boolean {
  return ID_RE.test(id);
}

/** 旧形式の ID か */
export function isLegacyId(id: string): boolean {
  return LEGACY_ID_RE.test(id);
}

/** ID として妥当か(新形式・旧形式のどちらでも真) */
export function isValidId(id: string): boolean {
  return isNewFormatId(id) || isLegacyId(id);
}

/**
 * 任意のテキストから slug を作る。ASCII 英数字以外は区切りとして落とすため、
 * 日本語だけのタイトルなど slug に残る文字が無い入力では null を返す
 * (呼び出し側で既定値へフォールバックする)。上限を超える場合は語境界で切り詰める
 * (1 語だけで上限を超える場合に限り、語の途中で切る)。
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
  if (normalized.length <= SLUG_MAX_LENGTH) return normalized;

  // 上限の 1 文字先まで見ることで、境界がちょうど区切りに当たる場合に語を落とさずに済ませる
  const window = normalized.slice(0, SLUG_MAX_LENGTH + 1);
  const lastSep = window.lastIndexOf("-");
  const truncated = lastSep > 0 ? window.slice(0, lastSep) : normalized.slice(0, SLUG_MAX_LENGTH);
  return truncated === "" ? null : truncated;
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
