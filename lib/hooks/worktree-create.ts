// WorktreeCreate hook: Supervisor がタスクごとに使う、リポジトリ本体の外側の git worktree を作る。
// 置き場・ブランチ名・共有パスの symlink は Supervisor 本体と同じ lib/config.ts と lib/worktree.ts で
// 計算する(hook 側が独自の式を持つと config.parallel.worktreeDir の設定と食い違うため)。
// 同名の worktree が既にあれば新規作成せず再利用する(コンフリクト解決の継続セッションで使う)。
import { loadConfigFrom } from "../config.ts";
import { resolveRepoRoot } from "../paths.ts";
import { branchNameFor, createWorktree, linkSharedPaths, worktreePathFor } from "../worktree.ts";
import { readStdinJson } from "./stdin.ts";

const input = await readStdinJson();

const name = input.name;
// path traversal を避けるため、taskId として妥当な文字だけを許可する。
// 許可文字だけでも "." ".." は親ディレクトリへ解決されるため明示的に拒否する
if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) {
  process.stderr.write(`不正な worktree 名: ${JSON.stringify(name)}\n`);
  process.exit(1);
}

// process.cwd() へは意図的にフォールバックしない: worktree/ブランチを作る hook がここへ
// フォールバックすると、呼び出し側の cwd 引き渡し漏れが「静かに ccloop リポジトリ本体を汚す」
// 事故になる(過去に agent/T-001 〜 T-003 の残骸が本体に残った)。渡されていなければ即座に
// 失敗させ、事故を早期に検知できるようにする。
const claudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
const inputCwd = typeof input.cwd === "string" ? input.cwd : undefined;
const startDir = claudeProjectDir ?? inputCwd;

if (startDir === undefined) {
  process.stderr.write(
    "worktree 作成対象のリポジトリを特定できない: 環境変数 CLAUDE_PROJECT_DIR も" +
      " hook input の cwd も渡されていない。process.cwd() への無条件フォールバックは" +
      " 意図せずリポジトリ本体に worktree/ブランチを作ってしまう事故につながるため廃止した。" +
      " 呼び出し側(Claude Code 本体)が WorktreeCreate hook 呼び出し時に CLAUDE_PROJECT_DIR" +
      " または hook input の cwd のいずれかを渡すよう確認すること。\n",
  );
  process.exit(1);
}

try {
  const root = resolveRepoRoot({ cwd: startDir });
  const config = loadConfigFrom(root);
  const wtPath = worktreePathFor(config.parallel.worktreeDir, name);

  createWorktree(root, wtPath, branchNameFor(name));
  linkSharedPaths(root, wtPath, config.parallel.linkPaths);

  process.stdout.write(wtPath + "\n");
  process.exit(0);
} catch (err) {
  // config.json が壊れている場合などは Error のメッセージ(人間向けの複数行案内)だけを出す。
  // stack を出すと案内文の後ろにスタックトレースが続いてしまい読みにくいため
  process.stderr.write(String((err as Error)?.message ?? err) + "\n");
  process.exit(1);
}
