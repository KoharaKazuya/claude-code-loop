import { describe, expect, it } from "vitest";
import { buildId, disambiguateId, idTimestamp, isValidSlug, slugify, SLUG_MAX_LENGTH } from "./ids.ts";

describe("slugify", () => {
  it("英語の語句をハイフン区切りの小文字にする", () => {
    expect(slugify("Fix login retry")).toBe("fix-login-retry");
  });

  it("記号・連続する区切りを 1 つのハイフンにまとめ、前後の区切りは落とす", () => {
    expect(slugify("  Fix the CI/CD pipeline!! ")).toBe("fix-the-ci-cd-pipeline");
  });

  it("数字は残す", () => {
    expect(slugify("Bump node to 24")).toBe("bump-node-to-24");
  });

  it("アクセント記号付きの文字は ASCII に落とす", () => {
    expect(slugify("Café menu")).toBe("cafe-menu");
  });

  it("日本語だけのタイトルは slug にできず null", () => {
    expect(slugify("タスクの整理")).toBeNull();
  });

  it("英数字を含まない入力は null", () => {
    expect(slugify("---")).toBeNull();
    expect(slugify("")).toBeNull();
  });

  it("日本語混じりでも英数字部分だけを拾う", () => {
    expect(slugify("triage の slug 対応")).toBe("triage-slug");
  });

  it("上限を超える場合は語境界で切り詰める", () => {
    const slug = slugify("supervisor triage response slug field fallback handling rules");
    expect(slug).toBe("supervisor-triage-response-slug-field");
    expect((slug ?? "").length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  it("境界がちょうど区切りに当たる場合は語を落とさない", () => {
    // "aaaa-" の 8 回で 40 文字ちょうど、41 文字目が区切り
    const slug = slugify(`${"aaaa ".repeat(8)}bbbb`);
    expect(slug).toBe("aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa");
  });

  it("1 語だけで上限を超える場合は語の途中で切る", () => {
    const slug = slugify("a".repeat(60));
    expect(slug).toBe("a".repeat(SLUG_MAX_LENGTH));
  });

  it("語境界での切り詰めが極端に短くなる場合はハード切り詰めにフォールバックする", () => {
    // 語境界だと先頭の "x" 1 文字しか残らない(短すぎる)ため、40 文字でのハード切り詰めになる
    const slug = slugify(`x ${"a".repeat(45)}`);
    expect(slug).toBe(`x-${"a".repeat(38)}`);
    expect((slug ?? "").length).toBe(SLUG_MAX_LENGTH);
  });

  it("付随的な ASCII 断片だけが残り意味を持たない場合は null", () => {
    expect(slugify("ひらがな2")).toBeNull();
  });

  it("生成結果は必ず妥当な slug になる", () => {
    for (const text of ["Fix login retry", "  Fix the CI/CD pipeline!! ", "a".repeat(60), "Café menu"]) {
      expect(isValidSlug(slugify(text) ?? "")).toBe(true);
    }
  });
});

describe("isValidSlug", () => {
  it("小文字英数字とハイフンのみを認める", () => {
    expect(isValidSlug("fix-login-retry")).toBe(true);
    expect(isValidSlug("v2")).toBe(true);
  });

  it("大文字・空白・記号・前後や連続のハイフンは認めない", () => {
    expect(isValidSlug("Fix-Login")).toBe(false);
    expect(isValidSlug("fix login")).toBe(false);
    expect(isValidSlug("fix_login")).toBe(false);
    expect(isValidSlug("-fix")).toBe(false);
    expect(isValidSlug("fix-")).toBe(false);
    expect(isValidSlug("fix--login")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });

  it("上限を超える長さは認めない", () => {
    expect(isValidSlug("a".repeat(SLUG_MAX_LENGTH))).toBe(true);
    expect(isValidSlug("a".repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("idTimestamp", () => {
  it("ISO 文字列から YYYYMMDD-HHMM を作る", () => {
    expect(idTimestamp("2026-08-22T09:05:31.123Z")).toBe("20260822-0905");
  });

  it("ローカルタイムゾーンによらず UTC で組み立てる", () => {
    expect(idTimestamp("2026-08-22T23:30:00.000+09:00")).toBe("20260822-1430");
  });

  it("解釈できない文字列でも形式の揃った値を返す", () => {
    expect(idTimestamp("not a date")).toMatch(/^\d{8}-\d{4}$/);
  });
});

describe("buildId", () => {
  it("prefix・日時・slug を繋いだ ID を作る", () => {
    expect(buildId("T", "fix-login-retry", "2026-08-22T09:05:31.123Z")).toBe("T-20260822-0905-fix-login-retry");
    expect(buildId("HR", "review-merge-policy", "2026-08-22T09:05:31.123Z")).toBe(
      "HR-20260822-0905-review-merge-policy",
    );
  });
});

describe("disambiguateId", () => {
  it("衝突しなければそのまま返す", () => {
    expect(disambiguateId("T-20260822-0905-a-b", () => false)).toBe("T-20260822-0905-a-b");
  });

  it("衝突する場合は -2 を付ける", () => {
    const taken = new Set(["T-20260822-0905-a-b"]);
    expect(disambiguateId("T-20260822-0905-a-b", (id) => taken.has(id))).toBe("T-20260822-0905-a-b-2");
  });

  it("連続して衝突する場合は空いている番号まで進める", () => {
    const taken = new Set(["T-20260822-0905-a-b", "T-20260822-0905-a-b-2", "T-20260822-0905-a-b-3"]);
    expect(disambiguateId("T-20260822-0905-a-b", (id) => taken.has(id))).toBe("T-20260822-0905-a-b-4");
  });
});
