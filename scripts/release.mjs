#!/usr/bin/env node
/**
 * リリース自動化スクリプト。`npm run release <patch|minor|major> [--dry-run]` で呼ぶ。
 *
 * 手順(順に実行し、失敗した時点で停止する):
 *   1. 引数解析
 *   2. 状態チェック(main ブランチか / 作業ツリーがクリーンか / origin/main と同期しているか /
 *      CHANGELOG.md の「未リリース」節が繰り上げ可能な構造か)
 *   3. 検証(check:version / typecheck / lint / test)
 *   4. `npm version <bump>`(package.json 等の更新・コミット・タグ作成、および CHANGELOG.md の
 *      「未リリース」節の繰り上げは sync-version.mjs / promote-changelog.mjs 経由の
 *      `version` フックが行う)
 *   5. `git push --follow-tags origin main`
 *
 * --dry-run は 3. の検証まで実行し、4. 以降は行わない(何が実行される予定かを表示するのみ)。
 * 2. の CHANGELOG チェック・件数表示は読み取り専用なので dry-run でも通常実行でも行われる。
 */

import { spawnSync } from "node:child_process";
import { previewPromotion } from "./promote-changelog.mjs";
import { readPackageVersion } from "./version-files.mjs";

const COMMIT_MESSAGE = "build: バージョンを %s に更新";
const VERIFY_SCRIPTS = ["check:version", "typecheck", "lint", "test"];
const USAGE = "usage: npm run release <patch|minor|major> [--dry-run]";
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * "x.y.z" 形式のバージョンと bump 種別から、`npm version <bump>` が付ける次のバージョンを計算する
 * 純粋関数。プレリリース識別子付きなど x.y.z 形式でない入力は Error を throw する。
 */
export function nextVersion(currentVersion, bump) {
  const match = SEMVER_PATTERN.exec(currentVersion);
  if (!match) {
    throw new Error(`バージョン "${currentVersion}" は x.y.z 形式ではありません`);
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);

  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`不明な bump 種別 "${bump}"`);
  }
}

/** process.argv.slice(2) 相当の引数配列を解析する。成功時は { bump, dryRun }、失敗時は { error } を返す。 */
export function parseArgs(argv) {
  const bumps = new Set(["patch", "minor", "major"]);
  let bump;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (bumps.has(arg) && bump === undefined) {
      bump = arg;
    } else {
      return { error: USAGE };
    }
  }

  if (bump === undefined) {
    return { error: USAGE };
  }

  return { bump, dryRun };
}

/** `git rev-list --left-right --count origin/main...HEAD` の出力(`<behind>\t<ahead>`)を解析する */
export function parseAheadBehind(output) {
  const [behind, ahead] = output
    .trim()
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10));
  return { behind, ahead };
}

/**
 * リポジトリの状態からエラーメッセージの配列を組み立てる純粋関数。
 * branch: 現在のブランチ名, porcelain: `git status --porcelain` の出力, behind: origin/main から遅れているコミット数。
 * エラーがなければ空配列を返す。
 */
export function checkRepoState({ branch, porcelain, behind }) {
  const errors = [];

  if (branch !== "main") {
    errors.push(`現在のブランチは "${branch}" です。main ブランチで実行してください。`);
  }

  if (porcelain.trim() !== "") {
    errors.push(
      ["作業ツリーがクリーンではありません:", porcelain.trim(), "(.agent/ の変更はコミットしてから再実行してください)"].join(
        "\n",
      ),
    );
  }

  if (behind > 0) {
    errors.push(`origin/main から ${behind} コミット遅れています。git pull してから再実行してください。`);
  }

  return errors;
}

/**
 * previewPromotion の結果から、リリース前に表示する CHANGELOG 繰り上げ予告メッセージを組み立てる
 * 純粋関数。CHANGELOG.md が無い(missing: true)場合は表示するものが無いので null を返す。
 */
export function describeChangelogPreview({ missing, entryCount }) {
  if (missing) {
    return null;
  }

  return entryCount > 0
    ? `変更履歴: 未リリースの ${entryCount} 件がバージョン見出しへ繰り上がります`
    : "変更履歴: 未リリース節は空です";
}

/** コマンドを stdio inherit で実行し、成功したら true を返す */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  return result.status === 0;
}

/** `npm run <name>` を stdio inherit で実行し、成功したら true を返す */
function runNpmScript(name) {
  return run("npm", ["run", name]);
}

/** コマンドを実行し、標準出力(trim 済み)を返す。失敗時は例外を投げる。 */
function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function main() {
  const { bump, dryRun, error } = parseArgs(process.argv.slice(2));
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }

  // 2. 状態チェック(読み取り専用)
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = capture("git", ["status", "--porcelain"]);

  if (!run("git", ["fetch", "origin", "main"])) {
    console.error("git fetch origin main に失敗しました");
    process.exitCode = 1;
    return;
  }
  const aheadBehindOutput = capture("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"]);
  const { behind, ahead } = parseAheadBehind(aheadBehindOutput);

  const errors = checkRepoState({ branch, porcelain, behind });
  if (errors.length > 0) {
    for (const message of errors) {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  if (ahead > 0) {
    console.log(`info: 未 push の ${ahead} コミットも一緒に push されます`);
  }

  let changelogPreview;
  try {
    const currentVersion = readPackageVersion(process.cwd());
    const upcomingVersion = nextVersion(currentVersion, bump);
    changelogPreview = previewPromotion(process.cwd(), upcomingVersion);
  } catch (previewError) {
    console.error(previewError.message);
    process.exitCode = 1;
    return;
  }
  const changelogMessage = describeChangelogPreview(changelogPreview);
  if (changelogMessage) {
    console.log(changelogMessage);
  }

  // 3. 検証
  for (const script of VERIFY_SCRIPTS) {
    if (!runNpmScript(script)) {
      console.error(`${script} が失敗しました。リポジトリは未変更です`);
      process.exitCode = 1;
      return;
    }
  }

  if (dryRun) {
    console.log(`dry-run: ここで npm version ${bump} と git push --follow-tags を実行します`);
    return;
  }

  // 4. npm version
  if (!run("npm", ["version", bump, "-m", COMMIT_MESSAGE])) {
    console.error(
      [
        "version フックが途中で止まった場合は作業ツリーが書き換わっている可能性があります。",
        "git status を確認してください。コミット・タグは作成されていません。",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  // 5. push
  if (!run("git", ["push", "--follow-tags", "origin", "main"])) {
    const version = readPackageVersion(process.cwd());
    console.error(
      [
        `コミットと注釈付きタグ v${version} はローカルに作成済みです。ロールバックは不要です。`,
        "原因を解消して `git push --follow-tags origin main` を再実行してください。",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const version = readPackageVersion(process.cwd());
  console.log(`v${version} を push しました。GitHub Actions (release.yml) が GHCR へ publish します。`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
