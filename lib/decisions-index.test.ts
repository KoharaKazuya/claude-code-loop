import { describe, expect, it } from "vitest";
import { mergeDecisionsIndexText, parseDecisionsIndex } from "./decisions-index.ts";

const HEADER = "# 決定インデックス\n\n本文の説明。\n\n";

function indexText(header: string, lines: string[]): string {
  if (lines.length === 0) return header;
  return header + lines.join("\n") + "\n";
}

describe("mergeDecisionsIndexText", () => {
  it("両側が別々の新規エントリを先頭に追加すると、両方が ID 降順で残る", () => {
    const base = indexText(HEADER, [
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);
    const ours = indexText(HEADER, [
      "- [ ] [D-003](D-003.md) — c",
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);
    const theirs = indexText(HEADER, [
      "- [ ] [D-004](D-004.md) — d",
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);

    const merged = mergeDecisionsIndexText(base, ours, theirs);
    expect(merged).not.toBeNull();
    const { entries } = parseDecisionsIndex(merged!);
    expect(entries.map((e) => e.id)).toEqual(["D-004", "D-003", "D-002", "D-001"]);
  });

  it("片側が既存エントリを削除(アーカイブ)し他方が新規追加すると、削除は維持され新規は残る(削除されたエントリは復活しない)", () => {
    const base = indexText(HEADER, [
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);
    // ours 側で D-001 がアーカイブされ index から消えた
    const ours = indexText(HEADER, ["- [ ] [D-002](D-002.md) — b"]);
    // theirs 側は D-001 に触れず、新規に D-003 を追加した
    const theirs = indexText(HEADER, [
      "- [ ] [D-003](D-003.md) — c",
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);

    const merged = mergeDecisionsIndexText(base, ours, theirs);
    expect(merged).not.toBeNull();
    const { entries } = parseDecisionsIndex(merged!);
    expect(entries.map((e) => e.id)).toEqual(["D-003", "D-002"]);
  });

  it("同一 ID で checked が食い違えばチェック済みが優先される", () => {
    const base = indexText(HEADER, ["- [ ] [D-001](D-001.md) — a"]);
    const ours = indexText(HEADER, ["- [x] [D-001](D-001.md) — a"]);
    const theirs = indexText(HEADER, ["- [ ] [D-001](D-001.md) — a"]);

    const merged = mergeDecisionsIndexText(base, ours, theirs);
    expect(merged).not.toBeNull();
    const { entries } = parseDecisionsIndex(merged!);
    expect(entries).toEqual([{ id: "D-001", checked: true, summary: "a" }]);
  });

  it("同一 ID で summary が片側だけ base から変更されていれば変更側が採用される", () => {
    const base = indexText(HEADER, ["- [ ] [D-001](D-001.md) — old"]);
    const ours = indexText(HEADER, ["- [ ] [D-001](D-001.md) — old"]);
    const theirs = indexText(HEADER, ["- [ ] [D-001](D-001.md) — new"]);

    const merged = mergeDecisionsIndexText(base, ours, theirs);
    expect(merged).not.toBeNull();
    const { entries } = parseDecisionsIndex(merged!);
    expect(entries).toEqual([{ id: "D-001", checked: false, summary: "new" }]);
  });

  it("header が両側で別々に変更されていれば機械的に解決できず null を返す", () => {
    const base = indexText(HEADER, ["- [ ] [D-001](D-001.md) — a"]);
    const oursHeader = "# 決定インデックス\n\nours が書き換えた説明。\n\n";
    const theirsHeader = "# 決定インデックス\n\ntheirs が書き換えた説明。\n\n";
    const ours = indexText(oursHeader, ["- [ ] [D-001](D-001.md) — a"]);
    const theirs = indexText(theirsHeader, ["- [ ] [D-001](D-001.md) — a"]);

    expect(mergeDecisionsIndexText(base, ours, theirs)).toBeNull();
  });

  it("base が null(add/add)で header が一致すれば和集合が返る", () => {
    const ours = indexText(HEADER, ["- [ ] [D-001](D-001.md) — a"]);
    const theirs = indexText(HEADER, ["- [ ] [D-002](D-002.md) — b"]);

    const merged = mergeDecisionsIndexText(null, ours, theirs);
    expect(merged).not.toBeNull();
    const { entries } = parseDecisionsIndex(merged!);
    expect(entries.map((e) => e.id)).toEqual(["D-002", "D-001"]);
  });

  it("base が null で header が一致しなければ null を返す", () => {
    const ours = indexText(HEADER, ["- [ ] [D-001](D-001.md) — a"]);
    const theirs = indexText("# 決定インデックス\n\n別の説明。\n\n", ["- [ ] [D-002](D-002.md) — b"]);

    expect(mergeDecisionsIndexText(null, ours, theirs)).toBeNull();
  });

  it("出力は parseDecisionsIndex で再パースでき、ID 降順で安定している(冪等)", () => {
    const base = indexText(HEADER, [
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);
    const ours = indexText(HEADER, [
      "- [ ] [D-003](D-003.md) — c",
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);
    const theirs = indexText(HEADER, [
      "- [ ] [D-004](D-004.md) — d",
      "- [ ] [D-002](D-002.md) — b",
      "- [ ] [D-001](D-001.md) — a",
    ]);

    const merged1 = mergeDecisionsIndexText(base, ours, theirs);
    expect(merged1).not.toBeNull();

    // 同じ入力で 2 回マージしても同じ結果になる
    const merged2 = mergeDecisionsIndexText(base, ours, theirs);
    expect(merged2).toBe(merged1);

    // マージ結果を ours・theirs 両方に与えて(base も merged1 として)再マージしても不変
    const merged3 = mergeDecisionsIndexText(merged1, merged1!, merged1!);
    expect(merged3).toBe(merged1);

    const { entries } = parseDecisionsIndex(merged1!);
    const ids = entries.map((e) => e.id);
    const sortedDesc = [...ids].sort().reverse();
    expect(ids).toEqual(sortedDesc);
  });
});
