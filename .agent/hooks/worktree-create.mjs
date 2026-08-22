// WorktreeCreate hook: Supervisor がタスクごとに使う、リポジトリ本体の外側の git worktree を作る。
// 依存ゼロの .mjs を維持するため .agent/supervisor/worktree.ts の該当ロジックをここに複製する
// (import はできない: 型付き TS モジュールであり、このスクリプトは単体で node 実行される)。
// 同名の worktree が既にあれば新規作成せず再利用する(コンフリクト解決の継続セッションで使う)。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");

const name = input.name;
// path traversal を避けるため、taskId として妥当な文字だけを許可する。
// 許可文字だけでも "." ".." は親ディレクトリへ解決されるため明示的に拒否する
if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) {
  process.stderr.write(`不正な worktree 名: ${JSON.stringify(name)}\n`);
  process.exit(1);
}

const root = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const wtPath = resolve(root, "..", `${basename(root)}-worktrees`, name);
const branch = `agent/${name}`;

if (existsSync(wtPath)) {
  // 既に存在するなら冪等に再利用する
  process.stdout.write(wtPath + "\n");
  process.exit(0);
}

try {
  mkdirSync(dirname(wtPath), { recursive: true });

  let branchExists = true;
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root });
  } catch {
    branchExists = false;
  }
  if (branchExists) {
    execFileSync("git", ["worktree", "add", wtPath, branch], { cwd: root });
  } else {
    execFileSync("git", ["worktree", "add", "-b", branch, wtPath, "HEAD"], { cwd: root });
  }

  const nodeModulesSrc = join(root, "node_modules");
  const nodeModulesDest = join(wtPath, "node_modules");
  if (existsSync(nodeModulesSrc) && !existsSync(nodeModulesDest)) {
    symlinkSync(nodeModulesSrc, nodeModulesDest);
  }

  process.stdout.write(wtPath + "\n");
  process.exit(0);
} catch (err) {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
}
