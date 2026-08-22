#!/usr/bin/env node
/**
 * package.json の version を唯一の真実として、
 * - features/ccloop/devcontainer-feature.json の version
 * - README.md 中の ghcr.io/koharakazuya/claude-code-loop/ccloop:<version> 参照
 * を同期する。
 *
 * `npm version` ライフサイクルの `version` フックとして実行される想定
 * (package.json の version 更新後、コミット・タグ作成前に走る)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  FEATURE_JSON_RELATIVE,
  README_RELATIVE,
  readPackageVersion,
  replaceJsonVersion,
  replaceReadmeVersions,
} from "./version-files.mjs";

/**
 * root 配下の feature JSON / README を package.json の version に同期する。
 * 変更があったファイルの相対パスの配列を返す。
 */
export function syncVersion(root) {
  const version = readPackageVersion(root);
  const changed = [];

  for (const relativePath of [FEATURE_JSON_RELATIVE, README_RELATIVE]) {
    const filePath = path.join(root, relativePath);
    const before = fs.readFileSync(filePath, "utf8");
    const after =
      relativePath === README_RELATIVE
        ? replaceReadmeVersions(before, version)
        : replaceJsonVersion(before, version, relativePath);

    if (after !== before) {
      fs.writeFileSync(filePath, after);
      changed.push(relativePath);
    }
  }

  return { version, changed };
}

function main() {
  const root = process.cwd();
  const { version, changed } = syncVersion(root);

  if (changed.length === 0) {
    console.log(`version ${version} already in sync (no changes)`);
    return;
  }

  console.log(`synced to version ${version}:`);
  for (const relativePath of changed) {
    console.log(`  ${relativePath}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
