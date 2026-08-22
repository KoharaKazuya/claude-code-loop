/**
 * Human Review 回答の段階的処理(triage)を担う純粋関数。
 *
 * scheduler.ts と同じ「純粋関数のみ、IO・claude 起動は supervisor.ts」の分担。
 * Stage 1(決定論判定)と Stage 2(軽量モデル判定)の材料選定・プロンプト組み立て・
 * レスポンス解釈だけをここに持ち、ファイルの読み書きや claude の起動は持たない。
 */

/** triage 対象の Human Review 1 件(supervisor.ts の HrEntry から必要な項目だけを渡す) */
export interface TriageCandidate {
  id: string;
  title: string;
  importance: string;
  /** frontmatter の status(closed 判定・旧方式互換判定に使う) */
  status: string;
  /** frontmatter 以降の本文全体 */
  body: string;
}

/** buildTriagePrompt に渡す現行タスクの要約(重複登録を避けるための参照用) */
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  priority: number;
}

/** action で判別可能な union にし、"task" のときだけ title/priority/body を要求する */
export type TriageDecision =
  | { id: string; action: "close" | "escalate"; reason: string }
  | { id: string; action: "task"; reason: string; title: string; priority: number; body: string };

/** 本文から `## 回答` セクションの中身だけを取り出す。無ければ空文字 */
export function extractAnswerSection(body: string): string {
  const idx = body.search(/^## 回答\s*$/m);
  if (idx === -1) return "";
  const afterHeading = body.slice(idx).replace(/^## 回答\s*\n?/, "");
  const nextHeading = afterHeading.match(/\n## /);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  return section.trim();
}

/**
 * 回答が「対応不要」の行頭マーカーで始まるか。
 * 「対応不要ではない」のような否定を誤検出しないよう、マーカー直後が区切り文字であることを求める
 * (`\b` は仮名漢字を単語構成文字として扱わないため、代わりに区切り文字集合を明示している)。
 * 旧方式(`status: answered` 手書き)専用の互換ロジック。新方式はチェックボックスで判定する
 * (`isAnsweredEntry` / `isNoActionAnswer` を参照)。
 */
const NO_ACTION_MARKER = /^対応不要(?:[:：。]|\s|$)|^対応[:：]\s*不要(?:[:：。]|\s|$)/m;

export function hasNoActionMarker(answer: string): boolean {
  return NO_ACTION_MARKER.test(answer);
}

/** `## 回答` 節の操作用チェックボックス 1 行分の解釈結果 */
interface CheckboxLineMatch {
  checked: boolean;
  /** 前方一致判定用に太字記法(`**`/`__`)を先頭だけ剥がしたラベル文字列 */
  label: string;
}

/** `-`/`*`/`+` マーカー、半角・全角スペース、`[ ]`/`[x]`/`[X]` を許容するチェックボックス行 */
const CHECKBOX_LINE_RE = /^[ \t]*[-*+][ \t　]*\[([ xX])\][ \t　]*(.*)$/;

function matchCheckboxLine(line: string): CheckboxLineMatch | null {
  const m = line.match(CHECKBOX_LINE_RE);
  if (m === null) return null;
  const label = (m[2] ?? "").trim().replace(/^\*\*|^__/, "");
  return { checked: m[1] !== " ", label };
}

/**
 * `## 回答` 節から操作用チェックボックス(「対応不要」/「回答を下に書いた」)の状態を読み取る。
 * `present` は操作用チェックボックス行が 1 つでもあったか(人間がテンプレートごと消して
 * 回答を書いたケースの判定に使う)。ラベルが前方一致しない無関係なチェックボックス行は無視する。
 */
export function readAnswerCheckboxes(answerSection: string): {
  noAction: boolean;
  answered: boolean;
  present: boolean;
} {
  let noAction = false;
  let answered = false;
  let present = false;
  for (const line of answerSection.split("\n")) {
    const match = matchCheckboxLine(line);
    if (match === null) continue;
    if (match.label.startsWith("対応不要")) {
      present = true;
      if (match.checked) noAction = true;
    } else if (match.label.startsWith("回答")) {
      present = true;
      if (match.checked) answered = true;
    }
    // 前方一致しないラベルのチェックボックス行(人間の自由記述内のもの等)は無視する
  }
  return { noAction, answered, present };
}

/** 操作用チェックボックス行(「対応不要」/「回答を下に書いた」)だけを取り除く。Stage 2 プロンプトのノイズ対策用 */
export function stripAnswerTemplate(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const match = matchCheckboxLine(line);
      if (match === null) return true;
      return !(match.label.startsWith("対応不要") || match.label.startsWith("回答"));
    })
    .join("\n");
}

/** `## 回答` 節から操作用チェックボックスを除いた自由記述が残っているか */
export function hasFreeTextAnswer(body: string): boolean {
  return stripAnswerTemplate(extractAnswerSection(body)).trim() !== "";
}

/**
 * Human Review 1 件が「回答済み」か(fail-safe: 迷う場合は未回答側=false に倒す)。
 * 判定順: closed → false / 旧方式(`status: answered`)→ true / 操作用チェックボックスに
 * チェックあり(対応不要・回答のどちらか一方でも)→ true / 操作用チェックボックス行が無く
 * 自由記述が残っている(テンプレートごと消して回答した)→ true / それ以外 → false。
 */
export function isAnsweredEntry({ status, body }: { status: string; body: string }): boolean {
  if (status === "closed") return false;
  if (status === "answered") return true; // 旧方式(手書き)互換
  const checkboxes = readAnswerCheckboxes(extractAnswerSection(body));
  if (checkboxes.noAction || checkboxes.answered) return true;
  if (!checkboxes.present && hasFreeTextAnswer(body)) return true;
  return false;
}

/**
 * Stage 1 で機械的に closed にできるか(「対応不要」だけが選ばれている状態。「回答」も
 * 同時にチェックされている場合は対象外にし Stage 2/3 へ回す)。
 * 新方式のチェックボックスを優先し、操作用チェックボックス行が無いときに限り
 * 旧方式マーカー(`status: answered` のときのみ有効)にフォールバックする。
 */
export function isNoActionAnswer({ status, body }: { status: string; body: string }): boolean {
  const section = extractAnswerSection(body);
  const checkboxes = readAnswerCheckboxes(section);
  if (checkboxes.present) return checkboxes.noAction && !checkboxes.answered;
  return status === "answered" && hasNoActionMarker(section);
}

/** Stage 1: 「対応不要」のみが選ばれたエントリを機械的に closed にできる ID を返す(BLOCK は対象外) */
export function selectDeterministicCloses(candidates: TriageCandidate[]): string[] {
  return candidates
    .filter((c) => c.importance !== "BLOCK")
    .filter((c) => isNoActionAnswer({ status: c.status, body: c.body }))
    .map((c) => c.id);
}

/** Stage 2: 軽量モデル判定に回す候補(Stage 1 で closed 済みのものと BLOCK を除く) */
export function selectLightTriageCandidates(
  candidates: TriageCandidate[],
  closedIds: ReadonlySet<string>,
): TriageCandidate[] {
  return candidates.filter((c) => c.importance !== "BLOCK" && !closedIds.has(c.id));
}

/** Stage 2 の判定プロンプト。ツール権限なしで判定 JSON のみを出力させる */
export function buildTriagePrompt(candidates: TriageCandidate[], tasks: TaskSummary[]): string {
  const candidateText = candidates
    .map((c) => `### ${c.id}: ${c.title} (importance: ${c.importance})\n\n${stripAnswerTemplate(c.body)}`)
    .join("\n\n---\n\n");
  const taskText =
    tasks.length === 0
      ? "(なし)"
      : tasks.map((t) => `- ${t.id} [${t.status}] priority=${t.priority}: ${t.title}`).join("\n");

  return [
    "あなたは Human Review への回答を仕分ける triage 担当。判定のみを行い、ファイルは一切変更しない",
    "(ツール権限もない)。",
    "",
    "## 対象の Human Review",
    "",
    candidateText,
    "",
    "## 現行タスク一覧(重複登録を避けるための参照)",
    "",
    taskText,
    "",
    "## 判定方法",
    "",
    "各エントリについて `## 回答` の内容から次のいずれかを判定し、対象エントリすべてを 1 件ずつ",
    "decisions に含めること(判定を保留するものは escalate)。",
    "",
    "- `close`: 回答の内容が対応不要、または既に対応済みで新規作業が不要。`reason` に理由を書く。",
    "- `task`: 回答の内容から新規タスクを 1 件登録すべき。`title`(短いタイトル)・`priority`",
    "  (1〜5、数字が小さいほど優先度が高い)・`body`(担当セッションが読んで作業を開始できる",
    "  程度のタスク本文)を書く。上の現行タスク一覧と重複する場合は `close` にする。",
    "- `escalate`: 判定に自信が持てない、影響範囲が大きい、複数タスクにまたがる等、人間の意図を",
    "  読み違えるリスクがある場合。何もせずフル探索セッションへ判断を委ねる。迷ったら必ずこちらを選ぶ。",
    "  回答本文が空(判定材料が無い)場合も必ず escalate にする。",
    "",
    "出力は次の JSON 契約のみ。説明文は不要。",
    "",
    "```json",
    '{"decisions":[{"id":"HR-YYYYMMDD-NN","action":"close|task|escalate","reason":"...","title":"...","priority":3,"body":"..."}]}',
    "```",
  ].join("\n");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** ```json フェンスの中身を取り出す。無ければ全体をそのまま JSON 候補として返す */
function extractJsonPayload(text: string): string | null {
  const fenced = text.match(/```json\s*\n([\s\S]*?)```/);
  if (fenced !== null) return fenced[1]!;
  return text.trim() === "" ? null : text;
}

/**
 * Stage 2 のレスポンスを解釈する(fail-closed)。
 * パース不能なら空配列。個々の decision は 未知 id・不正 action・(action=task で)title 欠落・
 * 同一 id の重複(2 件目以降)を個別に無視する。priority は 1〜5 にクランプする(欠落・不正値は既定 3)。
 */
export function parseTriageResponse(text: string, validIds: ReadonlySet<string>): TriageDecision[] {
  const payload = extractJsonPayload(text);
  if (payload === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.decisions)) return [];

  const decisions: TriageDecision[] = [];
  const seenIds = new Set<string>();
  for (const raw of parsed.decisions) {
    if (!isPlainObject(raw)) continue;
    if (typeof raw.id !== "string" || !validIds.has(raw.id)) continue;
    if (seenIds.has(raw.id)) continue; // 同一 id の 2 件目以降は個別無視(重複適用を防ぐ)
    seenIds.add(raw.id); // 以降で action/title が不正と分かっても、この id の枠は消費済みにする
    if (raw.action !== "close" && raw.action !== "task" && raw.action !== "escalate") continue;

    const reason = typeof raw.reason === "string" ? raw.reason : "";

    if (raw.action === "task") {
      if (typeof raw.title !== "string" || raw.title.trim() === "") continue; // title 欠落は個別無視
      const priority = typeof raw.priority === "number" && Number.isFinite(raw.priority) ? raw.priority : 3;
      decisions.push({
        id: raw.id,
        action: "task",
        reason,
        title: raw.title,
        priority: Math.min(5, Math.max(1, priority)),
        body: typeof raw.body === "string" ? raw.body : "",
      });
      continue;
    }

    decisions.push({ id: raw.id, action: raw.action, reason });
  }
  return decisions;
}
