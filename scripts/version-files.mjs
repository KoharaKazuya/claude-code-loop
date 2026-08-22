/**
 * バージョン整合性チェック(check-version.mjs)とバージョン同期(sync-version.mjs)が共有する
 * 「どのファイルのどこにバージョンが書かれているか」の知識。
 *
 * 真実は package.json の version のみ。features/ccloop/devcontainer-feature.json の version と
 * README.md 中の `ghcr.io/koharakazuya/claude-code-loop/ccloop:<version>` 参照は、
 * すべてそれと同じ値であるべき派生値として扱う。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const PACKAGE_JSON_RELATIVE = "package.json";
export const FEATURE_JSON_RELATIVE = "features/ccloop/devcontainer-feature.json";
export const README_RELATIVE = "README.md";

// devcontainer-feature.json / package.json はどちらもトップレベルに "version" キーを 1 つだけ持つ
// (devDependencies 等のバージョン範囲は別のキー名の値であり "version" というキー名では現れない)。
const JSON_VERSION_PATTERN = /("version"\s*:\s*")([^"]+)(")/;

// README.md 中の ccloop feature 参照。git/node/claude-code など他 feature の `:1` タグは
// パス部分が異なるため対象にならない。
const GHCR_CCLOOP_PATTERN = /(ghcr\.io\/koharakazuya\/claude-code-loop\/ccloop:)([^\s"'`]+)/g;

function readFile(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

/** JSON ファイル(package.json 等)の内容からトップレベルの "version" 値を取り出す */
export function extractJsonVersion(content, relativePath) {
  const match = JSON_VERSION_PATTERN.exec(content);
  if (!match) {
    throw new Error(`${relativePath}: "version" フィールドが見つかりません`);
  }
  return match[2];
}

/** README.md の内容から ccloop feature 参照のバージョン一覧を取り出す(出現順、重複含む) */
export function extractReadmeVersions(content) {
  return [...content.matchAll(GHCR_CCLOOP_PATTERN)].map((match) => match[2]);
}

/** package.json の version を読む */
export function readPackageVersion(root) {
  return extractJsonVersion(readFile(root, PACKAGE_JSON_RELATIVE), PACKAGE_JSON_RELATIVE);
}

/** features/ccloop/devcontainer-feature.json の version を読む */
export function readFeatureVersion(root) {
  return extractJsonVersion(readFile(root, FEATURE_JSON_RELATIVE), FEATURE_JSON_RELATIVE);
}

/** README.md 中の ccloop feature 参照バージョン一覧を読む */
export function readReadmeVersions(root) {
  return extractReadmeVersions(readFile(root, README_RELATIVE));
}

/**
 * JSON ファイルのトップレベル "version" 値を書き換える。インデントや末尾改行など、
 * 対象フィールド以外の整形は一切変更しない。
 */
export function replaceJsonVersion(content, newVersion, relativePath) {
  if (!JSON_VERSION_PATTERN.test(content)) {
    throw new Error(`${relativePath}: "version" フィールドが見つかりません`);
  }
  return content.replace(JSON_VERSION_PATTERN, (_full, before, _old, after) => `${before}${newVersion}${after}`);
}

/** README.md 中の ccloop feature 参照をすべて newVersion に書き換える */
export function replaceReadmeVersions(content, newVersion) {
  return content.replace(GHCR_CCLOOP_PATTERN, (_full, before) => `${before}${newVersion}`);
}

/**
 * package.json / devcontainer-feature.json / README.md それぞれのバージョン(README は配列)を
 * まとめて読む。いずれかのファイルが存在しない・"version" が見つからない場合は例外を投げる。
 */
export function readAllVersions(root) {
  return {
    packageVersion: readPackageVersion(root),
    featureVersion: readFeatureVersion(root),
    readmeVersions: readReadmeVersions(root),
  };
}
