#!/usr/bin/env node
/**
 * CHANGELOG.md の「## 未リリース」節を確定版の見出し(`## <version> — <date>`)へ繰り上げる。
 *
 * `npm version` ライフサイクルの `version` フックとして実行される想定
 * (package.json の version 更新後、コミット・タグ作成前に走る)。
 * リポジトリに CHANGELOG.md が無い場合は何もしない。書き換えた場合は自身で `git add CHANGELOG.md` を行う。
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readPackageVersion } from "./version-files.mjs";

const CHANGELOG_RELATIVE = "CHANGELOG.md";
const UNRELEASED_HEADING = "## 未リリース";

/**
 * CHANGELOG 全文から「## 未リリース」節の本文行の範囲(見出し行の次行から、次の `## ` 見出しの
 * 直前または末尾まで)を求める。見つからなければ null を返す。
 */
function findUnreleasedSection(lines) {
  const headingIndex = lines.findIndex((line) => line === UNRELEASED_HEADING);
  if (headingIndex === -1) {
    return null;
  }

  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      endIndex = i;
      break;
    }
  }

  return { headingIndex, bodyStart: headingIndex + 1, bodyEnd: endIndex };
}

/** 見出し `## <version> ` で始まる行がすでに存在するか */
function hasVersionHeading(lines, version) {
  const prefix = `## ${version} `;
  return lines.some((line) => line.startsWith(prefix));
}

/**
 * CHANGELOG.md の内容(content)に対し、「## 未リリース」節を `## <version> — <date>` 見出しへ
 * 繰り上げる。純粋関数(ファイル I/O は行わない)。
 *
 * 戻り値: { content, promoted, entryCount }
 *   - promoted: 繰り上げを行ったか
 *   - entryCount: 繰り上げた箇条書き(行頭が "- " の行)の数
 *
 * 未リリース節が空(空行以外の行が無い)なら何もせず promoted: false を返す(利用者向けの
 * 変更が無いリリースがあり得るため、これはエラーにしない)。
 * 「## 未リリース」見出しが見つからない場合、または既に同じバージョンの見出しが存在する場合は
 * Error を throw する。
 */
export function promoteUnreleased(content, version, date) {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  // content が末尾改行付きなら split 結果の最後は空文字列の要素になるので取り除く
  if (hasTrailingNewline) {
    lines.pop();
  }

  const section = findUnreleasedSection(lines);
  if (section === null) {
    throw new Error("CHANGELOG.md に `## 未リリース` 節が見つからない");
  }

  const bodyLines = lines.slice(section.bodyStart, section.bodyEnd);
  const hasContent = bodyLines.some((line) => line.trim() !== "");
  if (!hasContent) {
    return { content, promoted: false, entryCount: 0 };
  }

  if (hasVersionHeading(lines, version)) {
    throw new Error(`CHANGELOG.md に \`## ${version}\` の見出しが既に存在する`);
  }

  // 本文前後の空行を取り除いたうえで、見出し・空行1つを添えて新しい節として組み立てる。
  let bodyBegin = 0;
  while (bodyBegin < bodyLines.length && bodyLines[bodyBegin].trim() === "") {
    bodyBegin++;
  }
  let bodyEnd = bodyLines.length;
  while (bodyEnd > bodyBegin && bodyLines[bodyEnd - 1].trim() === "") {
    bodyEnd--;
  }
  const trimmedBody = bodyLines.slice(bodyBegin, bodyEnd);

  const entryCount = trimmedBody.filter((line) => line.startsWith("- ")).length;

  // 次の見出しが続く場合のみ、節の間の空行1行を補う(末尾の場合は不要)。
  const tailLines = lines.slice(section.bodyEnd);
  const newLines = [
    ...lines.slice(0, section.headingIndex + 1),
    "",
    `## ${version} — ${date}`,
    "",
    ...trimmedBody,
    ...(tailLines.length > 0 ? ["", ...tailLines] : []),
  ];

  const newContent = newLines.join("\n") + (hasTrailingNewline ? "\n" : "");

  return { content: newContent, promoted: true, entryCount };
}

/**
 * root/CHANGELOG.md を読み、promoteUnreleased を適用して変化があれば書き戻す。
 * CHANGELOG.md が存在しなければ何もせず { promoted: false, missing: true } を返す。
 */
export function promoteChangelog(root, { version, date }) {
  const filePath = path.join(root, CHANGELOG_RELATIVE);
  if (!fs.existsSync(filePath)) {
    return { promoted: false, missing: true };
  }

  const before = fs.readFileSync(filePath, "utf8");
  const { content: after, promoted, entryCount } = promoteUnreleased(before, version, date);

  if (after !== before) {
    fs.writeFileSync(filePath, after);
  }

  return { promoted, entryCount, version, date, missing: false };
}

/**
 * 書き込みを一切行わず、渡された version で繰り上げの可否(未リリース節が壊れていないか、
 * 同じバージョンの見出しが既に存在しないか)と件数だけを確認する。
 * CHANGELOG.md が無ければ { missing: true, entryCount: 0 }。
 * 「## 未リリース」節が見つからない場合・`## <version>` の見出しが既に存在する場合は
 * promoteUnreleased と同じ Error を throw する。
 */
export function previewPromotion(root, version) {
  const filePath = path.join(root, CHANGELOG_RELATIVE);
  if (!fs.existsSync(filePath)) {
    return { missing: true, entryCount: 0 };
  }

  const content = fs.readFileSync(filePath, "utf8");
  // 日付は検証に使わないのでダミー値で構わない。結果は書き戻さない。
  const { entryCount } = promoteUnreleased(content, version, "0000-00-00");

  return { missing: false, entryCount };
}

function main() {
  const root = process.cwd();
  const version = readPackageVersion(root);
  const date = new Date().toISOString().slice(0, 10);

  const result = promoteChangelog(root, { version, date });

  if (result.missing) {
    console.log("CHANGELOG.md が無いため何もしない");
    return;
  }

  if (!result.promoted) {
    console.log("CHANGELOG.md: 未リリース節が空のため繰り上げなし");
    return;
  }

  const gitAdd = spawnSync("git", ["add", CHANGELOG_RELATIVE], { stdio: "inherit" });
  if (gitAdd.status !== 0) {
    console.error("git add CHANGELOG.md に失敗しました");
    process.exitCode = 1;
    return;
  }

  console.log(`CHANGELOG.md: 未リリースの ${result.entryCount} 件を ${version} — ${date} へ繰り上げた`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
