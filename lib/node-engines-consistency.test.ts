import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { checkNodeVersion } from "./doctor.ts";

/**
 * Node バージョン要件は package.json の engines.node と lib/doctor.ts の checkNodeVersion に
 * 独立してハードコードされている。両者が食い違うと、npm/corepack が案内する要件と実際に
 * ccloop が受け入れる Node バージョンがズレてしまう。このテストはその食い違いを検知する。
 */

interface PackageJson {
  engines?: { node?: string };
}

const packageJsonPath = path.join(import.meta.dirname, "..", "package.json");
const packageJsonText = fs.readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonText) as PackageJson;
const enginesNode = packageJson.engines?.node ?? "";

interface ParsedEngines {
  caretMajor: number;
  caretMinor: number;
  caretPatch: number;
  gteMajor: number;
}

/**
 * package.json の engines.node が想定する厳密な書式(`^X.Y.Z || >=A.0.0`)にのみマッチする
 * 正規表現。意図的に厳しくしている: 緩いフォールバックを書くと、将来 engines.node の書式が
 * この形から外れたときにテストが静かに素通りしてしまう。
 */
const ENGINES_NODE_PATTERN = /^\^(\d+)\.(\d+)\.(\d+) \|\| >=(\d+)\.0\.0$/;

/**
 * engines.node の文字列を解析する(純粋)。想定書式に一致しなければ null を返し、
 * 呼び出し側で明確に失敗させる。
 */
function parseEngines(raw: string): ParsedEngines | null {
  const m = ENGINES_NODE_PATTERN.exec(raw);
  if (m === null) return null;
  return {
    caretMajor: Number.parseInt(m[1], 10),
    caretMinor: Number.parseInt(m[2], 10),
    caretPatch: Number.parseInt(m[3], 10),
    gteMajor: Number.parseInt(m[4], 10),
  };
}

/** "22.18.0" のようなバージョン文字列を分解する。checkNodeVersion と同じ流儀(NaN は 0 扱い) */
function parseVersionParts(version: string): { major: number; minor: number; patch: number } {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  const major = Number.isNaN(parts[0]) ? 0 : parts[0];
  const minor = Number.isNaN(parts[1]) ? 0 : parts[1];
  const patch = Number.isNaN(parts[2]) ? 0 : parts[2];
  return { major, minor, patch };
}

/**
 * parseEngines() の結果とバージョン文字列から、engines.node の範囲(`^X.Y.Z` 側と
 * `>=A.0.0` 側の OR)を満たすかを判定する純粋関数。
 */
function satisfies(range: ParsedEngines, version: string): boolean {
  const { major, minor, patch } = parseVersionParts(version);
  const caretOk =
    major === range.caretMajor &&
    (minor > range.caretMinor || (minor === range.caretMinor && patch >= range.caretPatch));
  const gteOk = major >= range.gteMajor;
  return caretOk || gteOk;
}

/**
 * parseEngines() の結果から検証すべき境界バージョンを機械的に生成する。候補をハードコード
 * すると engines.node の値を変えたときに候補が追随せずテストが素通りしてしまうため、
 * 必ずパース結果から導出する。
 */
function generateBoundaryVersions(range: ParsedEngines): string[] {
  const { caretMajor: X, caretMinor: Y, caretPatch: Z, gteMajor: A } = range;
  const versions: string[] = [`${X}.${Y}.${Z}`]; // caret 側の下限ちょうど(許容されるはず)
  if (Z !== 0) versions.push(`${X}.${Y}.${Z - 1}`); // 下限の 1 つ下(拒否されるはず)
  if (Y !== 0) versions.push(`${X}.${Y - 1}.0`); // 下限の 1 つ下(拒否されるはず)
  versions.push(`${X}.${Y + 1}.0`); // caret 側で 1 つ上(許容)
  versions.push(`${X - 1}.999.0`); // caret 側の major が 1 つ下(拒否)
  versions.push(`${A}.0.0`); // >= 側の下限ちょうど(許容)
  versions.push(`${A - 1}.0.0`); // >= 側の 1 つ下(拒否。caret 側にも当たらない想定)
  versions.push(`${A + 1}.0.0`); // >= 側で 1 つ上(許容)
  return versions;
}

const parsedEngines = parseEngines(enginesNode);
const boundaryVersions = parsedEngines === null ? [] : generateBoundaryVersions(parsedEngines);

describe("engines.node と checkNodeVersion の整合", () => {
  it("package.json の engines.node を厳格な正規表現で解析できる(解析に失敗すると後続のテストがすべて空振りするため)", () => {
    expect(parsedEngines, `"${enginesNode}" を想定書式 "^X.Y.Z || >=A.0.0" で解析できない`).not.toBeNull();
    expect(boundaryVersions.length).toBeGreaterThan(0);
  });

  it.each(boundaryVersions)(
    "バージョン %s で satisfies(engines.node) と checkNodeVersion() の判定が一致する(要件の食い違いを検知する)",
    (version) => {
      if (parsedEngines === null) throw new Error("engines.node を解析できていないため到達しないはず");
      const expected = satisfies(parsedEngines, version);
      const actual = checkNodeVersion(version) === null;
      expect(
        actual,
        `Node ${version}: engines.node ("${enginesNode}") から導いた期待値は ${String(expected)} だが、` +
          `checkNodeVersion() は ${actual ? "OK(null)" : "NG(案内文字列)"} を返した`,
      ).toBe(expected);
    },
  );

  it("checkNodeVersion の案内文言に package.json の engines.node の値がそのまま含まれる(文言の書き換え忘れを検知するため)", () => {
    expect(enginesNode, "package.json に engines.node が無い").not.toBe("");
    const message = checkNodeVersion("1.0.0");
    expect(message, "1.0.0 は必ず NG になるはずだが null が返った").not.toBeNull();
    expect(message).toContain(enginesNode);
  });
});

describe("ドリフト検知の自己テスト(検査自体が機能していることの確認)", () => {
  it("parseEngines: 想定書式に一致しない文字列は null を返す", () => {
    expect(parseEngines("^22.18.0")).toBeNull(); // >= 側が無い
    expect(parseEngines(">=24.0.0")).toBeNull(); // caret 側が無い
    expect(parseEngines("22.18.0 || >=24.0.0")).toBeNull(); // caret の ^ が無い
    expect(parseEngines("^22.18.0 || >=24.0")).toBeNull(); // >= 側が X.Y ではなく X
    expect(parseEngines("")).toBeNull();
  });

  it("parseEngines: 想定書式は各数値を正しく取り出せる", () => {
    expect(parseEngines("^22.18.0 || >=24.0.0")).toEqual({
      caretMajor: 22,
      caretMinor: 18,
      caretPatch: 0,
      gteMajor: 24,
    });
  });

  it("satisfies: caret 範囲(^X.Y.Z)の境界判定が正しい", () => {
    const range: ParsedEngines = { caretMajor: 22, caretMinor: 18, caretPatch: 0, gteMajor: 24 };
    expect(satisfies(range, "22.18.0")).toBe(true); // 下限ちょうど
    expect(satisfies(range, "22.18.5")).toBe(true); // 下限より patch が上
    expect(satisfies(range, "22.19.0")).toBe(true); // minor が上
    expect(satisfies(range, "22.17.999")).toBe(false); // minor が下
    expect(satisfies(range, "21.999.0")).toBe(false); // major が下(gte にも当たらない)
  });

  it("satisfies: >= 範囲(>=A.0.0)の境界判定が正しい", () => {
    const range: ParsedEngines = { caretMajor: 22, caretMinor: 18, caretPatch: 0, gteMajor: 24 };
    expect(satisfies(range, "24.0.0")).toBe(true); // 下限ちょうど
    expect(satisfies(range, "25.0.0")).toBe(true); // 上回る
    expect(satisfies(range, "23.0.0")).toBe(false); // 1 つ下(caret 側にも当たらない)
  });
});
