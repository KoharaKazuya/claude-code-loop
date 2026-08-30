/**
 * scripts/promote-changelog.mjs のユニットテスト。
 *
 * 実リポジトリの CHANGELOG.md は書き換えず、純粋関数 promoteUnreleased はインメモリの文字列で、
 * promoteChangelog / previewPromotion は一時ディレクトリで検証する。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewPromotion, promoteChangelog, promoteUnreleased } from "./promote-changelog.mjs";

const SAMPLE_CHANGELOG = [
  "# 変更履歴",
  "",
  "説明文。",
  "",
  "## 未リリース",
  "",
  "### 追加",
  "",
  "- 新機能1",
  "- 新機能2",
  "",
  "### 修正",
  "",
  "- 不具合1",
  "",
  "## 0.4.1 — 2026-08-29",
  "",
  "- 既存の記述。",
  "",
  "## 0.4.0 — 2026-08-29",
  "",
  "- もっと古い記述。",
  "",
].join("\n");

const EMPTY_UNRELEASED_CHANGELOG = [
  "# 変更履歴",
  "",
  "## 未リリース",
  "",
  "## 0.4.1 — 2026-08-29",
  "",
  "- 既存の記述。",
  "",
].join("\n");

describe("promoteUnreleased", () => {
  it("未リリース節をバージョン見出しへ繰り上げ、既存節はそのまま残す", () => {
    const { content, promoted, entryCount } = promoteUnreleased(SAMPLE_CHANGELOG, "0.5.0", "2026-08-30");

    expect(promoted).toBe(true);
    expect(entryCount).toBe(3);

    const lines = content.split("\n");
    expect(lines).toContain("## 未リリース");
    expect(lines).toContain("## 0.5.0 — 2026-08-30");
    expect(lines).toContain("## 0.4.1 — 2026-08-29");
    expect(lines).toContain("## 0.4.0 — 2026-08-29");

    // 空になった「未リリース」見出しの直後に、空行を挟んで新見出しが続く
    const unreleasedIndex = lines.indexOf("## 未リリース");
    expect(lines[unreleasedIndex + 1]).toBe("");
    expect(lines[unreleasedIndex + 2]).toBe("## 0.5.0 — 2026-08-30");
    expect(lines[unreleasedIndex + 3]).toBe("");
    expect(lines[unreleasedIndex + 4]).toBe("### 追加");

    // サブ見出し・箇条書きが整形し直されずにそのまま移動している
    expect(content).toContain(["### 追加", "", "- 新機能1", "- 新機能2", "", "### 修正", "", "- 不具合1"].join("\n"));

    // 新見出しと次の既存見出しの間に空行1行が保たれている
    const newHeadingIndex = lines.indexOf("## 0.5.0 — 2026-08-30");
    const existingHeadingIndex = lines.indexOf("## 0.4.1 — 2026-08-29");
    expect(lines[existingHeadingIndex - 1]).toBe("");
    expect(existingHeadingIndex).toBeGreaterThan(newHeadingIndex);

    // 既存節の中身は変わらない
    expect(content).toContain("## 0.4.1 — 2026-08-29\n\n- 既存の記述。");
    expect(content).toContain("## 0.4.0 — 2026-08-29\n\n- もっと古い記述。");

    // 末尾の改行を保つ
    expect(content.endsWith("\n")).toBe(true);
  });

  it("未リリース節が見出しだけ(空)なら内容を変えず promoted: false を返す", () => {
    const result = promoteUnreleased(EMPTY_UNRELEASED_CHANGELOG, "0.5.0", "2026-08-30");

    expect(result).toEqual({ content: EMPTY_UNRELEASED_CHANGELOG, promoted: false, entryCount: 0 });
  });

  it("「## 未リリース」が無ければ例外を投げる", () => {
    const content = ["# 変更履歴", "", "## 0.4.1 — 2026-08-29", "", "- 既存の記述。", ""].join("\n");

    expect(() => promoteUnreleased(content, "0.5.0", "2026-08-30")).toThrow(/未リリース/);
  });

  it("同じバージョンの見出しが既にあれば例外を投げる", () => {
    expect(() => promoteUnreleased(SAMPLE_CHANGELOG, "0.4.1", "2026-08-30")).toThrow(/0\.4\.1/);
  });
});

describe("promoteChangelog", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-promote-changelog-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("CHANGELOG.md が無ければ何もせず missing: true を返す", () => {
    const result = promoteChangelog(root, { version: "0.5.0", date: "2026-08-30" });

    expect(result).toEqual({ promoted: false, missing: true });
    expect(fs.existsSync(path.join(root, "CHANGELOG.md"))).toBe(false);
  });

  it("CHANGELOG.md があれば繰り上げて書き戻す", () => {
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), SAMPLE_CHANGELOG);

    const result = promoteChangelog(root, { version: "0.5.0", date: "2026-08-30" });

    expect(result).toEqual({ promoted: true, entryCount: 3, version: "0.5.0", date: "2026-08-30", missing: false });

    const after = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(after).toContain("## 0.5.0 — 2026-08-30");
  });

  it("未リリース節が空なら書き戻さず promoted: false を返す", () => {
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), EMPTY_UNRELEASED_CHANGELOG);

    const result = promoteChangelog(root, { version: "0.5.0", date: "2026-08-30" });

    expect(result.promoted).toBe(false);
    const after = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(after).toBe(EMPTY_UNRELEASED_CHANGELOG);
  });
});

describe("previewPromotion", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-preview-promotion-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("CHANGELOG.md が無ければ missing: true を返す", () => {
    expect(previewPromotion(root, "0.5.0")).toEqual({ missing: true, entryCount: 0 });
  });

  it("件数を返し、ファイルを一切書き換えない", () => {
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), SAMPLE_CHANGELOG);
    const before = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

    const result = previewPromotion(root, "0.5.0");

    expect(result).toEqual({ missing: false, entryCount: 3 });
    const after = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(after).toBe(before);
  });

  it("「## 未リリース」が無ければ例外を投げる", () => {
    fs.writeFileSync(
      path.join(root, "CHANGELOG.md"),
      ["# 変更履歴", "", "## 0.4.1 — 2026-08-29", "", "- 既存の記述。", ""].join("\n"),
    );

    expect(() => previewPromotion(root, "0.5.0")).toThrow(/未リリース/);
  });

  it("渡したバージョンの見出しが既に存在すれば例外を投げる", () => {
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), SAMPLE_CHANGELOG);

    expect(() => previewPromotion(root, "0.4.1")).toThrow(/0\.4\.1/);
  });
});
