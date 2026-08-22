#!/usr/bin/env node
/**
 * package.json / features/ccloop/devcontainer-feature.json / README.md の
 * ccloop feature 参照バージョンがすべて一致していることを検査する。
 *
 * `--expect <version>` を渡すと、一致した値がその version とも一致することまで検査する
 * (release.yml がタグ名から `v` を除いた値を渡し、タグと 3 ファイルの一致を検証する)。
 */

import {
  FEATURE_JSON_RELATIVE,
  PACKAGE_JSON_RELATIVE,
  README_RELATIVE,
  readAllVersions,
} from "./version-files.mjs";

/**
 * root 配下の 3 箇所のバージョンを検査する。
 * 戻り値の ok が false の場合、message にエラー内容(複数行)が入る。
 * ok が true の場合、message に成功メッセージ(1 行)が入る。
 */
export function checkVersion(root, { expect } = {}) {
  let packageVersion;
  let featureVersion;
  let readmeVersions;
  try {
    ({ packageVersion, featureVersion, readmeVersions } = readAllVersions(root));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (readmeVersions.length === 0) {
    return {
      ok: false,
      message: `${README_RELATIVE}: ghcr.io/koharakazuya/claude-code-loop/ccloop:<version> の参照が見つかりません`,
    };
  }

  const allValues = [packageVersion, featureVersion, ...readmeVersions];
  const uniqueValues = [...new Set(allValues)];

  if (uniqueValues.length > 1) {
    const readmeSummary = [...new Set(readmeVersions)].join(", ");
    return {
      ok: false,
      message: [
        "version mismatch:",
        `  ${PACKAGE_JSON_RELATIVE}: ${packageVersion}`,
        `  ${FEATURE_JSON_RELATIVE}: ${featureVersion}`,
        `  ${README_RELATIVE}: ${readmeSummary}`,
      ].join("\n"),
    };
  }

  const version = uniqueValues[0];

  if (expect !== undefined && version !== expect) {
    return {
      ok: false,
      message: [
        `version mismatch: expected ${expect} but found ${version}`,
        `  ${PACKAGE_JSON_RELATIVE}: ${packageVersion}`,
        `  ${FEATURE_JSON_RELATIVE}: ${featureVersion}`,
        `  ${README_RELATIVE}: ${[...new Set(readmeVersions)].join(", ")}`,
      ].join("\n"),
    };
  }

  return { ok: true, message: `version OK: ${version}` };
}

function parseArgs(argv) {
  const expectIndex = argv.indexOf("--expect");
  if (expectIndex === -1) {
    return {};
  }
  const expect = argv[expectIndex + 1];
  if (expect === undefined || expect === "") {
    return { error: "usage: check-version.mjs [--expect <version>]" };
  }
  return { expect };
}

function main() {
  const { expect, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  const result = checkVersion(process.cwd(), { expect });

  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
    return;
  }

  console.log(result.message);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
