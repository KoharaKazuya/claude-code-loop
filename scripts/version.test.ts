/**
 * scripts/version-files.mjs / check-version.mjs / sync-version.mjs のユニットテスト。
 *
 * 実リポジトリのファイルは書き換えず、一時ディレクトリに package.json /
 * features/ccloop/devcontainer-feature.json / README.md の最小構成を作って検証する。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkVersion } from "./check-version.mjs";
import { syncVersion } from "./sync-version.mjs";

let root: string;

function writeFixture(files: { packageVersion: string; featureVersion: string; readmeVersions: string[] }) {
  fs.writeFileSync(
    path.join(root, "package.json"),
    `{\n  "name": "fixture",\n  "version": "${files.packageVersion}"\n}\n`,
  );
  fs.mkdirSync(path.join(root, "features/ccloop"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "features/ccloop/devcontainer-feature.json"),
    `{\n  "id": "ccloop",\n  "version": "${files.featureVersion}"\n}\n`,
  );
  const readmeLines = files.readmeVersions.map(
    (v) => `- "ghcr.io/koharakazuya/claude-code-loop/ccloop:${v}": {}`,
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    ["# fixture", "", "他 feature の `ghcr.io/devcontainers/features/git:1` は対象外。", "", ...readmeLines, ""].join(
      "\n",
    ),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccloop-version-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("checkVersion", () => {
  it("3 箇所が一致していれば ok になる", () => {
    writeFixture({
      packageVersion: "0.1.0",
      featureVersion: "0.1.0",
      readmeVersions: ["0.1.0"],
    });

    const result = checkVersion(root);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("version OK: 0.1.0");
  });

  it("feature の version が package と異なれば不一致として各値を報告する", () => {
    writeFixture({
      packageVersion: "0.1.0",
      featureVersion: "0.2.0",
      readmeVersions: ["0.1.0"],
    });

    const result = checkVersion(root);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("package.json: 0.1.0");
    expect(result.message).toContain("features/ccloop/devcontainer-feature.json: 0.2.0");
    expect(result.message).toContain("README.md: 0.1.0");
  });

  it("README に ccloop feature 参照が無ければ不一致として報告する", () => {
    writeFixture({
      packageVersion: "0.1.0",
      featureVersion: "0.1.0",
      readmeVersions: [],
    });

    const result = checkVersion(root);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/README\.md/);
  });

  it("--expect と一致しなければ不一致として報告する", () => {
    writeFixture({
      packageVersion: "0.1.0",
      featureVersion: "0.1.0",
      readmeVersions: ["0.1.0"],
    });

    const result = checkVersion(root, { expect: "9.9.9" });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected 9.9.9 but found 0.1.0");
  });

  it("--expect と一致すれば ok になる", () => {
    writeFixture({
      packageVersion: "0.1.0",
      featureVersion: "0.1.0",
      readmeVersions: ["0.1.0"],
    });

    const result = checkVersion(root, { expect: "0.1.0" });

    expect(result.ok).toBe(true);
  });
});

describe("syncVersion", () => {
  it("package.json の version に feature / README を同期し、変更ファイルを報告する", () => {
    writeFixture({
      packageVersion: "0.2.0",
      featureVersion: "0.1.0",
      readmeVersions: ["0.1.0", "0.1.0"],
    });

    const { version, changed } = syncVersion(root);

    expect(version).toBe("0.2.0");
    expect(changed.sort()).toEqual(["README.md", "features/ccloop/devcontainer-feature.json"]);
    expect(checkVersion(root).ok).toBe(true);

    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("ghcr.io/koharakazuya/claude-code-loop/ccloop:0.2.0");
    expect(readme).not.toContain("ccloop:0.1.0");
    // 他 feature の参照は書き換えない
    expect(readme).toContain("ghcr.io/devcontainers/features/git:1");
  });

  it("既に同期済みなら冪等で変更ファイルが空になる", () => {
    writeFixture({
      packageVersion: "0.1.0",
      featureVersion: "0.1.0",
      readmeVersions: ["0.1.0"],
    });

    const { changed } = syncVersion(root);

    expect(changed).toEqual([]);
  });
});
