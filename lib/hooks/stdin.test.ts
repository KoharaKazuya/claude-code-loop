import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// readStdinJson は process.stdin を読むため in-process では検証しづらい。
// 子プロセスを起動し、戻り値を JSON で標準出力へ書き出す小さなフィクスチャ経由で検証する。
const STDIN_MODULE_URL = pathToFileURL(path.join(import.meta.dirname, "stdin.ts")).href;

function runReadStdinJson(input: string): { status: number | null; result: unknown } {
  const code = [
    `const { readStdinJson } = await import(${JSON.stringify(STDIN_MODULE_URL)});`,
    "const result = await readStdinJson();",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const res = spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", code],
    { input, encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`readStdinJson フィクスチャが異常終了した: status=${res.status} stderr=${res.stderr}`);
  }
  return { status: res.status, result: JSON.parse(res.stdout) };
}

describe("readStdinJson", () => {
  it("正常な JSON オブジェクトはネストした値も保ったまま返る", () => {
    const payload = { name: "T-001", nested: { a: [1, 2, 3], b: null }, flag: true };
    const { result } = runReadStdinJson(JSON.stringify(payload));
    expect(result).toEqual(payload);
  });

  it("空入力は {}", () => {
    const { result } = runReadStdinJson("");
    expect(result).toEqual({});
  });

  it("空白のみ(改行含む)は {}", () => {
    const { result } = runReadStdinJson("   \n\t\n  ");
    expect(result).toEqual({});
  });

  it("パース不能な文字列は {}", () => {
    const { result } = runReadStdinJson("{not json");
    expect(result).toEqual({});
  });

  // null は typeof "object" のため素通しすると呼び出し側が input.name 等で TypeError を起こす。
  // その事故を防ぐ契約(null は明示的に {} 扱いにする)の回帰検知
  it('"null" は {}(null を素通しさせない契約)', () => {
    const { result } = runReadStdinJson("null");
    expect(result).toEqual({});
  });

  it.each(["123", '"str"', "true"])("スカラー JSON (%s) は {}", (scalar) => {
    const { result } = runReadStdinJson(scalar);
    expect(result).toEqual({});
  });

  it("前後に空白・改行が付いた JSON でも trim されて正しくパースされる", () => {
    const { result } = runReadStdinJson('\n\n  { "a": 1 }  \n');
    expect(result).toEqual({ a: 1 });
  });
});
