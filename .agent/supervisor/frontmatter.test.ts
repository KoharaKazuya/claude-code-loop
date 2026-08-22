import { describe, expect, it } from "vitest";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";

describe("parseFrontmatter", () => {
  it("スカラー・整数・配列・本文をパースする", () => {
    const text = [
      "---",
      "title: \"短いタイトル: 補足つき\"",
      "status: ready",
      "priority: 3",
      "dependencies: [T-001, T-002]",
      "createdAt: 2026-08-12T00:00:00.000Z",
      "---",
      "",
      "本文である。",
    ].join("\n");
    expect(parseFrontmatter(text)).toEqual({
      data: {
        title: "短いタイトル: 補足つき",
        status: "ready",
        priority: 3,
        dependencies: ["T-001", "T-002"],
        createdAt: "2026-08-12T00:00:00.000Z",
      },
      body: "本文である。",
    });
  });

  it("空配列と引用符内カンマを扱う", () => {
    const { data } = parseFrontmatter('---\ndeps: []\nitems: ["a, b", c]\n---\n');
    expect(data.deps).toEqual([]);
    expect(data.items).toEqual(["a, b", "c"]);
  });

  it("frontmatter がない・閉じられていない場合は全体を本文にする", () => {
    expect(parseFrontmatter("ただのテキスト")).toEqual({ data: {}, body: "ただのテキスト" });
    expect(parseFrontmatter("---\ntitle: x\n")).toEqual({ data: {}, body: "---\ntitle: x\n" });
  });

  it("不正な行は無視して残りをパースする", () => {
    const { data } = parseFrontmatter("---\n# コメント\nstatus: open\n  ネスト: 不可\n---\n");
    expect(data).toEqual({ status: "open" });
  });

  it("本文中の --- を閉じ記号と誤認しない(本文は素通し)", () => {
    const { data, body } = parseFrontmatter("---\nstatus: open\n---\n\n## 見出し\n\n---\n\n下段");
    expect(data.status).toBe("open");
    expect(body).toContain("下段");
  });
});

describe("serializeFrontmatter", () => {
  it("パースと往復できる", () => {
    const data = {
      title: "レビュー: permission 拒否(3 件)",
      status: "open",
      priority: 3,
      dependencies: ["T-001", "T-002"],
      note: "失敗のため ready に戻す(1/3)。理由: タイムアウト",
      createdAt: "2026-08-12T00:00:00.000Z",
    };
    const body = "本文\n\n## 回答\n\n(未記入)";
    expect(parseFrontmatter(serializeFrontmatter(data, body))).toEqual({ data, body });
  });

  it("undefined のキーは省く", () => {
    const text = serializeFrontmatter({ status: "ready", model: undefined }, "");
    expect(text).toBe("---\nstatus: ready\n---\n");
  });

  it("数値と紛れる文字列は引用して型を保つ", () => {
    const { data } = parseFrontmatter(serializeFrontmatter({ id: "007" }, ""));
    expect(data.id).toBe("007");
  });
});
