import { describe, expect, it } from "vitest";
import {
  buildTriagePrompt,
  extractAnswerSection,
  hasFreeTextAnswer,
  hasNoActionMarker,
  isAnsweredEntry,
  parseTriageResponse,
  readAnswerCheckboxes,
  selectDeterministicCloses,
  selectLightTriageCandidates,
  stripAnswerTemplate,
  type TriageCandidate,
  type TriageDecision,
} from "./triage.ts";

/** action="task" の decision であることを型的にも確認して取り出す(priority/title/body の読み出し用) */
function asTaskDecision(d: TriageDecision | undefined): Extract<TriageDecision, { action: "task" }> {
  if (d === undefined || d.action !== "task") throw new Error(`task decision を期待したが ${JSON.stringify(d)}`);
  return d;
}

/** 既定値は旧方式(status: answered + 行頭マーカー)。新方式を検証する箇所は status/body を上書きする */
function candidate(over: Partial<TriageCandidate> = {}): TriageCandidate {
  return {
    id: "HR-20260818-01",
    title: "確認事項",
    importance: "REVIEW",
    status: "answered",
    body: ["## 確認事項", "", "内容。", "", "## 回答", "", "対応不要。"].join("\n"),
    ...over,
  };
}

/** 新方式のチェックボックステンプレート 2 行(未チェック) */
const CHECKBOX_TEMPLATE = ["- [ ] 対応不要(このままクローズしてよい)", "- [ ] 回答を下に書いた"].join("\n");

describe("extractAnswerSection", () => {
  it("`## 回答` 以降の本文を取り出す", () => {
    const body = ["## 確認事項", "", "内容。", "", "## 回答", "", "了解した。"].join("\n");
    expect(extractAnswerSection(body)).toBe("了解した。");
  });

  it("`## 回答` の後に別セクションがあればそこまでで打ち切る", () => {
    const body = ["## 回答", "", "対応不要。", "", "## 試行履歴", "", "無関係な内容"].join("\n");
    expect(extractAnswerSection(body)).toBe("対応不要。");
  });

  it("`## 回答` が無ければ空文字", () => {
    expect(extractAnswerSection("## 確認事項\n\n内容のみ。")).toBe("");
  });
});

describe("hasNoActionMarker", () => {
  it.each(["対応不要。", "対応不要", "対応不要:理由", "対応不要：理由", "対応: 不要", "対応：不要。理由"])(
    "正例: %s",
    (answer) => {
      expect(hasNoActionMarker(answer)).toBe(true);
    },
  );

  it.each([
    "対応不要ではない。追加で調査してほしい。",
    "対応が不要",
    "特に対応不要と思うが念のため確認",
    // 区切り文字が続かない「不要です」等は Stage 1 では検出しない(Stage 2 の判定に委ねる)
    "対応:不要です",
    "",
  ])("負例: %s", (answer) => {
    expect(hasNoActionMarker(answer)).toBe(false);
  });

  it("行頭以外に現れても、別の行の行頭なら検出する", () => {
    expect(hasNoActionMarker("了解した。\n対応不要。")).toBe(true);
  });
});

describe("readAnswerCheckboxes", () => {
  it("未チェックなら noAction/answered は false、present は true", () => {
    expect(readAnswerCheckboxes(CHECKBOX_TEMPLATE)).toEqual({ noAction: false, answered: false, present: true });
  });

  it("「対応不要」だけチェック", () => {
    const section = ["- [x] 対応不要(このままクローズしてよい)", "- [ ] 回答を下に書いた"].join("\n");
    expect(readAnswerCheckboxes(section)).toEqual({ noAction: true, answered: false, present: true });
  });

  it("「回答」だけチェック", () => {
    const section = ["- [ ] 対応不要(このままクローズしてよい)", "- [x] 回答を下に書いた"].join("\n");
    expect(readAnswerCheckboxes(section)).toEqual({ noAction: false, answered: true, present: true });
  });

  it("両方チェック", () => {
    const section = ["- [x] 対応不要(このままクローズしてよい)", "- [x] 回答を下に書いた"].join("\n");
    expect(readAnswerCheckboxes(section)).toEqual({ noAction: true, answered: true, present: true });
  });

  it("大文字 X もチェック済みとして扱う", () => {
    expect(readAnswerCheckboxes("- [X] 対応不要(このままクローズしてよい)").noAction).toBe(true);
  });

  it("全角スペースを許容する", () => {
    expect(readAnswerCheckboxes("-　[x]　対応不要(このままクローズしてよい)").noAction).toBe(true);
  });

  it("太字ラベル(**対応不要**)でも前方一致で認識する", () => {
    expect(readAnswerCheckboxes("- [x] **対応不要**(このままクローズしてよい)").noAction).toBe(true);
  });

  it("操作用チェックボックス行が 1 つも無ければ present は false", () => {
    expect(readAnswerCheckboxes("回答本文だけ書いた。")).toEqual({ noAction: false, answered: false, present: false });
  });

  it("ラベルが前方一致しない無関係なチェックボックス行は無視する", () => {
    const section = ["- [x] 対応不要(このままクローズしてよい)", "- [x] 無関係な確認項目"].join("\n");
    expect(readAnswerCheckboxes(section)).toEqual({ noAction: true, answered: false, present: true });
  });

  it("extractAnswerSection と組み合わせたとき、`## 回答` 以外のセクションの同名チェックボックスは見ない", () => {
    const body = [
      "## 対応不要のメモ",
      "",
      "- [x] 対応不要(このままクローズしてよい)",
      "",
      "## 回答",
      "",
      CHECKBOX_TEMPLATE,
    ].join("\n");
    expect(readAnswerCheckboxes(extractAnswerSection(body)).noAction).toBe(false);
  });
});

describe("stripAnswerTemplate", () => {
  it("操作用チェックボックス行だけを除去し、本文は残す", () => {
    const text = [CHECKBOX_TEMPLATE, "", "詳細な回答内容。"].join("\n");
    const stripped = stripAnswerTemplate(text);
    expect(stripped).not.toContain("対応不要");
    expect(stripped).not.toContain("回答を下に書いた");
    expect(stripped).toContain("詳細な回答内容。");
  });

  it("操作用チェックボックス行が無ければ全体をそのまま返す", () => {
    expect(stripAnswerTemplate("自由記述のみ。")).toBe("自由記述のみ。");
  });
});

describe("hasFreeTextAnswer", () => {
  it("チェックボックスのみ(未チェック)なら自由記述なし", () => {
    const body = ["## 回答", "", CHECKBOX_TEMPLATE].join("\n");
    expect(hasFreeTextAnswer(body)).toBe(false);
  });

  it("チェックボックスの下に本文があれば自由記述あり", () => {
    const body = ["## 回答", "", CHECKBOX_TEMPLATE, "", "詳細を書いた。"].join("\n");
    expect(hasFreeTextAnswer(body)).toBe(true);
  });

  it("`## 回答` が無ければ false", () => {
    expect(hasFreeTextAnswer("## 確認事項\n\n内容のみ。")).toBe(false);
  });
});

describe("isAnsweredEntry", () => {
  it("closed なら、チェックが残っていても常に false", () => {
    const body = ["## 回答", "", "- [x] 対応不要(このままクローズしてよい)", "- [ ] 回答を下に書いた"].join("\n");
    expect(isAnsweredEntry({ status: "closed", body })).toBe(false);
  });

  it("旧方式: status が answered なら true", () => {
    expect(isAnsweredEntry({ status: "answered", body: "## 回答\n\n対応不要。" })).toBe(true);
  });

  it("新方式: 「対応不要」のみチェックで true", () => {
    const body = ["## 回答", "", "- [x] 対応不要(このままクローズしてよい)", "- [ ] 回答を下に書いた"].join("\n");
    expect(isAnsweredEntry({ status: "open", body })).toBe(true);
  });

  it("新方式: 「回答」のみチェックで true", () => {
    const body = [
      "## 回答",
      "",
      "- [ ] 対応不要(このままクローズしてよい)",
      "- [x] 回答を下に書いた",
      "",
      "詳細。",
    ].join("\n");
    expect(isAnsweredEntry({ status: "open", body })).toBe(true);
  });

  it("両方チェックで true", () => {
    const body = ["## 回答", "", "- [x] 対応不要(このままクローズしてよい)", "- [x] 回答を下に書いた"].join("\n");
    expect(isAnsweredEntry({ status: "open", body })).toBe(true);
  });

  it("チェックボックスが残っていて未チェック+本文だけある → false(チェック忘れ)", () => {
    const body = ["## 回答", "", CHECKBOX_TEMPLATE, "", "書きかけの回答。"].join("\n");
    expect(isAnsweredEntry({ status: "open", body })).toBe(false);
  });

  it("操作用チェックボックスを消して本文だけ書いた場合は true", () => {
    const body = ["## 回答", "", "対応します。詳細はこちら。"].join("\n");
    expect(isAnsweredEntry({ status: "open", body })).toBe(true);
  });

  it("操作用チェックボックスが無く本文も無ければ false", () => {
    expect(isAnsweredEntry({ status: "open", body: "## 回答\n\n" })).toBe(false);
  });

  it("未チェックのテンプレートだけでは true にならない(誤爆退行防止)", () => {
    const body = ["## 回答", "", CHECKBOX_TEMPLATE].join("\n");
    expect(isAnsweredEntry({ status: "open", body })).toBe(false);
  });
});

describe("selectDeterministicCloses", () => {
  it("「対応不要」マーカーのある回答(旧方式)を closed 対象として返す", () => {
    const c = candidate();
    expect(selectDeterministicCloses([c])).toEqual([c.id]);
  });

  it("マーカーが無ければ対象にしない", () => {
    const c = candidate({ body: ["## 回答", "", "調査してほしい。"].join("\n") });
    expect(selectDeterministicCloses([c])).toEqual([]);
  });

  it("BLOCK は対象から除外する(マーカーがあっても機械的に closed にしない)", () => {
    const c = candidate({ importance: "BLOCK" });
    expect(selectDeterministicCloses([c])).toEqual([]);
  });

  it("新方式: 「対応不要」のみチェックで close 対象", () => {
    const body = ["## 回答", "", "- [x] 対応不要(このままクローズしてよい)", "- [ ] 回答を下に書いた"].join("\n");
    const c = candidate({ status: "open", body });
    expect(selectDeterministicCloses([c])).toEqual([c.id]);
  });

  it("新方式: 両方チェックは close 対象にしない(Stage 2/3 へ回す)", () => {
    const body = ["## 回答", "", "- [x] 対応不要(このままクローズしてよい)", "- [x] 回答を下に書いた"].join("\n");
    const c = candidate({ status: "open", body });
    expect(selectDeterministicCloses([c])).toEqual([]);
  });

  it("新方式でも BLOCK は対象から除外する", () => {
    const body = ["## 回答", "", "- [x] 対応不要(このままクローズしてよい)", "- [ ] 回答を下に書いた"].join("\n");
    const c = candidate({ status: "open", importance: "BLOCK", body });
    expect(selectDeterministicCloses([c])).toEqual([]);
  });

  it("未チェックのテンプレートだけでは close されない(誤爆退行検出)", () => {
    const body = ["## 回答", "", CHECKBOX_TEMPLATE].join("\n");
    const c = candidate({ status: "open", body });
    expect(selectDeterministicCloses([c])).toEqual([]);
  });

  it("status: open のまま旧方式マーカーだけがあっても close 対象にしない(旧方式は status: answered 限定)", () => {
    const c = candidate({ status: "open", body: "## 回答\n\n対応不要。" });
    expect(selectDeterministicCloses([c])).toEqual([]);
  });
});

describe("selectLightTriageCandidates", () => {
  it("Stage 1 で closed 済みの ID を除く", () => {
    const a = candidate({ id: "HR-20260818-01" });
    const b = candidate({ id: "HR-20260818-02", body: "## 回答\n\n調査してほしい。" });
    expect(selectLightTriageCandidates([a, b], new Set(["HR-20260818-01"]))).toEqual([b]);
  });

  it("BLOCK は closedIds に無くても除外する", () => {
    const c = candidate({ importance: "BLOCK", body: "## 回答\n\n調査してほしい。" });
    expect(selectLightTriageCandidates([c], new Set())).toEqual([]);
  });
});

describe("buildTriagePrompt", () => {
  it("対象の Human Review の id・title・本文を含む", () => {
    const c = candidate({ id: "HR-20260818-03", title: "確認したいこと" });
    const prompt = buildTriagePrompt([c], []);
    expect(prompt).toContain("HR-20260818-03");
    expect(prompt).toContain("確認したいこと");
    expect(prompt).toContain("対応不要。");
  });

  it("現行タスク一覧を含める", () => {
    const prompt = buildTriagePrompt([], [{ id: "T-001", title: "既存タスク", status: "ready", priority: 2 }]);
    expect(prompt).toContain("T-001");
    expect(prompt).toContain("既存タスク");
  });

  it("タスクが無ければ「なし」と書く", () => {
    expect(buildTriagePrompt([], [])).toContain("(なし)");
  });

  it("JSON 契約(```json フェンス)を含む", () => {
    const prompt = buildTriagePrompt([], []);
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"decisions"');
  });

  it("task の応答項目として slug を説明する", () => {
    const prompt = buildTriagePrompt([], []);
    expect(prompt).toContain("`slug`");
    expect(prompt).toContain('"slug"');
  });

  it("操作用チェックボックス行はノイズとしてプロンプトに含めない", () => {
    const body = ["## 回答", "", "- [ ] 対応不要(このままクローズしてよい)", "- [x] 回答を下に書いた", "", "詳細な回答内容。"].join(
      "\n",
    );
    const c = candidate({ status: "open", body });
    const prompt = buildTriagePrompt([c], []);
    expect(prompt).not.toContain("このままクローズしてよい");
    expect(prompt).not.toContain("回答を下に書いた");
    expect(prompt).toContain("詳細な回答内容。");
  });

  it("回答本文が空なら escalate する指示を含む", () => {
    const prompt = buildTriagePrompt([], []);
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("回答本文が空");
  });
});

describe("parseTriageResponse", () => {
  const validIds = new Set(["HR-20260818-01", "HR-20260818-02"]);

  it("close の判定を返す", () => {
    const text = '```json\n{"decisions":[{"id":"HR-20260818-01","action":"close","reason":"対応不要のため"}]}\n```';
    expect(parseTriageResponse(text, validIds)).toEqual([
      { id: "HR-20260818-01", action: "close", reason: "対応不要のため" },
    ]);
  });

  it("task の判定を返し、priority をクランプする", () => {
    const text =
      '```json\n{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"新規対応が必要",' +
      '"title":"新規タスク","slug":"add-retry-limit","priority":99,"body":"詳細"}]}\n```';
    expect(parseTriageResponse(text, validIds)).toEqual([
      {
        id: "HR-20260818-01",
        action: "task",
        reason: "新規対応が必要",
        title: "新規タスク",
        slug: "add-retry-limit",
        priority: 5,
        body: "詳細",
      },
    ]);
  });

  it("slug が欠落していればタイトルから生成する", () => {
    const text =
      '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"r","title":"Fix login retry"}]}';
    expect(asTaskDecision(parseTriageResponse(text, validIds)[0]).slug).toBe("fix-login-retry");
  });

  it("slug もタイトルも slug 化できなければ既定の task にする", () => {
    const text = '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"r","title":"日本語のタイトル"}]}';
    expect(asTaskDecision(parseTriageResponse(text, validIds)[0]).slug).toBe("task");
  });

  it("slug が不正な形でも正規化して活かす", () => {
    const text =
      '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"r","title":"t","slug":"Fix Login Retry!"}]}';
    expect(asTaskDecision(parseTriageResponse(text, validIds)[0]).slug).toBe("fix-login-retry");
  });

  it("slug が文字列でなければタイトルから生成する", () => {
    const text =
      '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"r","title":"Add cache layer","slug":42}]}';
    expect(asTaskDecision(parseTriageResponse(text, validIds)[0]).slug).toBe("add-cache-layer");
  });

  it("priority が下限未満でも 1 にクランプする", () => {
    const text = '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"r","title":"t","priority":-3}]}';
    expect(asTaskDecision(parseTriageResponse(text, validIds)[0]).priority).toBe(1);
  });

  it("priority が欠落・不正値なら既定 3 にする", () => {
    const text = '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"r","title":"t"}]}';
    expect(asTaskDecision(parseTriageResponse(text, validIds)[0]).priority).toBe(3);
  });

  it("escalate の判定を返す(title/priority/body は付かない)", () => {
    const text = '{"decisions":[{"id":"HR-20260818-01","action":"escalate","reason":"影響範囲が大きい"}]}';
    expect(parseTriageResponse(text, validIds)).toEqual([
      { id: "HR-20260818-01", action: "escalate", reason: "影響範囲が大きい" },
    ]);
  });

  it("不正な JSON はパース不能として空配列", () => {
    expect(parseTriageResponse("```json\nnot json\n```", validIds)).toEqual([]);
  });

  it("decisions が配列でなければ空配列", () => {
    expect(parseTriageResponse('{"decisions":"close"}', validIds)).toEqual([]);
  });

  it("JSON フェンスも本文も無ければ空配列", () => {
    expect(parseTriageResponse("", validIds)).toEqual([]);
  });

  it("未知の id は個別に無視する", () => {
    const text =
      '{"decisions":[{"id":"HR-99999999-99","action":"close","reason":"r"},' +
      '{"id":"HR-20260818-01","action":"close","reason":"r2"}]}';
    expect(parseTriageResponse(text, validIds)).toEqual([{ id: "HR-20260818-01", action: "close", reason: "r2" }]);
  });

  it("不正な action は個別に無視する", () => {
    const text = '{"decisions":[{"id":"HR-20260818-01","action":"delete","reason":"r"}]}';
    expect(parseTriageResponse(text, validIds)).toEqual([]);
  });

  it("action が task で title 欠落なら個別に無視する", () => {
    const text = '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"r","priority":2}]}';
    expect(parseTriageResponse(text, validIds)).toEqual([]);
  });

  it("同一 id で task が 2 件返っても最初の 1 件しか採用しない(重複タスク登録を防ぐ)", () => {
    const text =
      '{"decisions":[{"id":"HR-20260818-01","action":"task","reason":"1件目","title":"タスクA","priority":1},' +
      '{"id":"HR-20260818-01","action":"task","reason":"2件目","title":"タスクB","priority":5}]}';
    const decisions = parseTriageResponse(text, validIds);
    expect(decisions).toHaveLength(1);
    expect(asTaskDecision(decisions[0]).title).toBe("タスクA");
  });

  it("同一 id に close と task が混在しても最初の 1 件しか採用しない(重複した 対応: 追記を防ぐ)", () => {
    const text =
      '{"decisions":[{"id":"HR-20260818-01","action":"close","reason":"対応不要"},' +
      '{"id":"HR-20260818-01","action":"task","reason":"やっぱり必要","title":"タスクA","priority":2}]}';
    const decisions = parseTriageResponse(text, validIds);
    expect(decisions).toEqual([{ id: "HR-20260818-01", action: "close", reason: "対応不要" }]);
  });

  it("重複除去は id ごとに独立している(別 id は両方採用される)", () => {
    const text =
      '{"decisions":[{"id":"HR-20260818-01","action":"close","reason":"r1"},' +
      '{"id":"HR-20260818-02","action":"close","reason":"r2"}]}';
    expect(parseTriageResponse(text, validIds)).toEqual([
      { id: "HR-20260818-01", action: "close", reason: "r1" },
      { id: "HR-20260818-02", action: "close", reason: "r2" },
    ]);
  });

  it("reason が欠落していても空文字で受け付ける", () => {
    const text = '{"decisions":[{"id":"HR-20260818-01","action":"close"}]}';
    expect(parseTriageResponse(text, validIds)).toEqual([{ id: "HR-20260818-01", action: "close", reason: "" }]);
  });
});
