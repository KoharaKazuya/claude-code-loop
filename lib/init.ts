/**
 * `ccloop init`(`.agent/` の雛形配置)と、その自動案内
 *
 * ccloop は利用側リポジトリに `.agent/` だけを要求する(`.claude/` は置かない)。
 * その `.agent/` を人手で作らせるとキーの取りこぼしが起きるため、ツール本体が持つ雛形
 * (`lib/templates/agent/`)を配置する経路を用意する。
 *
 * 設計上の約束:
 *
 * - **既存ファイルは絶対に上書きしない。** 人間が書いた GOAL.md を消す事故が最悪なので、
 *   衝突したものはスキップとして表示するだけにする。差分マージも行わない。
 * - 実行前に必ず「これから作るファイル」を一覧表示する。TTY なら y/N で確認し、
 *   確認できない環境(非 TTY)では黙って書かず、`--yes` を促して終了する。
 * - `run` 等の他コマンドも `.agent/` が無ければ同じ一覧・確認を通す。初回利用者が
 *   「何を置けばいいのか」を調べずに始められるようにするため。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { usageOf } from "./help.ts";
import { CURRENT_SCHEMA_VERSION, compareSchemaVersion, migrateConfig, readSchemaVersion } from "./migrations.ts";
import { AGENT_DIR_NAME, ccloopHome, type Paths } from "./paths.ts";

/** 雛形の置き場(CCLOOP_HOME 配下) */
export function templatesAgentDir(home: string = ccloopHome()): string {
  return path.join(home, "templates", "agent");
}

/** `.gitignore` へ足す行を並べたファイル(CCLOOP_HOME 配下) */
export function templatesGitignorePath(home: string = ccloopHome()): string {
  return path.join(home, "templates", "gitignore.txt");
}

/** 配置する 1 ファイル。rel はリポジトリルートからの相対パス(表示にもそのまま使う) */
export interface PlannedFile {
  rel: string;
  source: string;
}

export interface GitignorePlan {
  /** "none": 既に全行ある / "create": ファイルごと作る / "append": 不足行を足す */
  action: "none" | "create" | "append";
  /** 追記する行(action が "none" なら空) */
  lines: string[];
}

/** 配置先のパスに、期待と違う種別の実体がある */
export interface PathConflict {
  /** リポジトリルートからの相対パス */
  rel: string;
  expected: "file" | "directory";
  actual: "file" | "directory" | "other";
}

export interface InitPlan {
  creates: PlannedFile[];
  /** 既存のため触らないファイル(リポジトリ相対) */
  skips: string[];
  gitignore: GitignorePlan;
  /** 配置先の種別が食い違っていて安全に配置できないパス(rel の昇順・重複なし) */
  conflicts: PathConflict[];
}

type EntryKind = "missing" | "file" | "directory" | "other";

/**
 * p の実体の種別。symlink は追う。
 *
 * `throwIfNoEntry: false` が握りつぶすのは ENOENT だけで、それ以外(祖先が非ディレクトリなら
 * ENOTDIR、循環 symlink なら ELOOP、権限不足なら EACCES)は投げてくる。ここで例外が素通りすると、
 * この関数が防ごうとしている「素のスタックトレースで落ちる」状態を検出側で再発させるため、
 * 両方の stat を捕まえて次のように倒す:
 *
 * - lstat が失敗 → "missing"。祖先が非ディレクトリのケースで、祖先自身の衝突として別途検出される
 * - lstat は成功したが stat が失敗・不能 → "other"。実体はあるが素性を確かめられない
 *   (壊れた symlink・循環 symlink・権限不足)。書き込み先としては使えないので衝突として扱う
 */
function entryKind(p: string): EntryKind {
  let l: fs.Stats | undefined;
  try {
    l = fs.lstatSync(p, { throwIfNoEntry: false });
  } catch {
    return "missing";
  }
  if (l === undefined) return "missing";
  try {
    const s = fs.statSync(p, { throwIfNoEntry: false });
    if (s === undefined) return "other";
    return s.isDirectory() ? "directory" : s.isFile() ? "file" : "other";
  } catch {
    return "other";
  }
}

/** rel（スラッシュ区切り）の祖先ディレクトリを、ルートに近い順で列挙する(rel 自身は含まない) */
function ancestorDirs(rel: string): string[] {
  const parts = rel.split("/");
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}

/** dir 配下の全ファイルを、dir からの相対パスで列挙する(再帰・ソート済み) */
function walkFiles(dir: string, prefix = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) files.push(...walkFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) files.push(rel);
  }
  return files;
}

/** gitignore.txt から、コメントと空行を除いた「必要な行」を読む */
function requiredGitignoreLines(home: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(templatesGitignorePath(home), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

function planGitignore(root: string, required: string[]): GitignorePlan {
  if (required.length === 0) return { action: "none", lines: [] };
  let existing: string[];
  try {
    existing = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { action: "create", lines: required };
    // ENOENT 以外(権限エラー等)は「読めないなら書かない」を優先し、既存内容を破壊しない側へ倒す
    console.error(`.gitignore を読めないため触らない: ${String((err as Error).message)}`);
    return { action: "none", lines: [] };
  }
  const missing = required.filter((l) => !existing.includes(l));
  return missing.length === 0 ? { action: "none", lines: [] } : { action: "append", lines: missing };
}

/** 何を作り、何をスキップするかを決める(ファイルシステムは読むだけで書かない) */
export function planInit(paths: Paths, home: string = ccloopHome()): InitPlan {
  const templateDir = templatesAgentDir(home);
  const templateRels = walkFiles(templateDir);
  const repoRels = templateRels.map((rel) => `${AGENT_DIR_NAME}/${rel}`);

  // 「ディレクトリを期待するパス」(雛形ファイルの祖先ディレクトリ。リポジトリルート自体は含まない)
  const dirExpected = new Set<string>();
  for (const repoRel of repoRels) for (const d of ancestorDirs(repoRel)) dirExpected.add(d);

  // 「ファイルを期待するパス」(配置先ファイル自身、および足す行があるなら .gitignore も)。
  // .gitignore の種別検査は planGitignore より先に行う。planGitignore は読めないファイルを
  // 「触らない」(action: "none")へ倒すため、後から action を見て判断すると、ディレクトリが
  // 置かれている衝突を検出できないまま「正常」と表示してしまう。
  const gitignoreRequired = requiredGitignoreLines(home);
  const fileExpected = [...repoRels];
  if (gitignoreRequired.length > 0) fileExpected.push(".gitignore");

  const conflicts: PathConflict[] = [];
  for (const d of dirExpected) {
    const kind = entryKind(path.join(paths.agentRoot, d));
    if (kind !== "missing" && kind !== "directory") conflicts.push({ rel: d, expected: "directory", actual: kind });
  }
  for (const f of fileExpected) {
    const kind = entryKind(path.join(paths.agentRoot, f));
    if (kind === "directory" || kind === "other") conflicts.push({ rel: f, expected: "file", actual: kind });
  }
  conflicts.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // .gitignore が衝突しているなら中身を読みに行かない(EISDIR の警告を重ねて出しても混乱するだけ)
  const gitignoreConflict = conflicts.some((c) => c.rel === ".gitignore");
  const gitignore = gitignoreConflict
    ? { action: "none" as const, lines: [] }
    : planGitignore(paths.agentRoot, gitignoreRequired);

  const creates: PlannedFile[] = [];
  const skips: string[] = [];
  for (let i = 0; i < templateRels.length; i++) {
    const rel = templateRels[i];
    const repoRel = repoRels[i];
    if (rel === undefined || repoRel === undefined) continue;
    const kind = entryKind(path.join(paths.agentRoot, repoRel));
    if (kind === "file") skips.push(repoRel);
    else if (kind === "missing") creates.push({ rel: repoRel, source: path.join(templateDir, rel) });
    // それ以外(directory/other)は上で conflicts に積んでいるため、skips にも creates にも入れない
  }

  return { creates, skips, gitignore, conflicts };
}

/** 実際に書き込むものが何も無いか */
export function isInitPlanEmpty(plan: InitPlan): boolean {
  return plan.creates.length === 0 && plan.gitignore.action === "none";
}

/** 一覧表示用の行(先頭の見出しは含まない) */
export function formatInitPlan(plan: InitPlan): string[] {
  const lines: string[] = [];
  for (const f of plan.creates) lines.push(`  作成: ${f.rel}`);
  for (const s of plan.skips) lines.push(`  スキップ(既存のため触らない): ${s}`);
  if (plan.gitignore.action === "create") {
    lines.push(`  作成: .gitignore (${plan.gitignore.lines.join(", ")})`);
  } else if (plan.gitignore.action === "append") {
    lines.push(`  追記: .gitignore (${plan.gitignore.lines.join(", ")})`);
  }
  if (lines.length === 0) lines.push("  (配置するものはない)");
  return lines;
}

function kindLabel(kind: "file" | "directory" | "other"): string {
  return kind === "directory" ? "ディレクトリ" : kind === "file" ? "ファイル" : "ディレクトリでもファイルでもない実体";
}

/** 衝突を人間向けに説明する行(先頭の見出しは含まない) */
export function formatInitConflicts(plan: InitPlan): string[] {
  return plan.conflicts.map((c) => `  ${c.rel}: ${kindLabel(c.expected)}であるべきだが${kindLabel(c.actual)}がある`);
}

/** 衝突があるときの案内(見出し + 各行 + 対処) */
export function initConflictMessage(plan: InitPlan): string {
  return [
    `${AGENT_DIR_NAME}/ の雛形を配置できない(パスの種別が食い違っている):`,
    ...formatInitConflicts(plan),
    "衝突しているパスを退避または削除してから再実行すること(ccloop は既存のパスを消さない)",
  ].join("\n");
}

/**
 * plan の通りに書き込む。既存ファイルには一切触れない。
 * 配置先は `agentRoot`(実行中の作業ツリー)であり、linked worktree 内で実行したときに
 * リポジトリ本体を書き換えない(`.agent/` は git 管理下なので、置いた worktree の
 * ブランチに乗せてマージするのが正しい)。
 */
export function applyInit(paths: Paths, plan: InitPlan): void {
  if (plan.conflicts.length > 0) throw new Error(initConflictMessage(plan));
  for (const f of plan.creates) {
    const dest = path.join(paths.agentRoot, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // wx: 計画時から実体ができていた場合に上書きしない(既存ファイル保護の最後の砦)
    try {
      fs.writeFileSync(dest, fs.readFileSync(f.source), { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (plan.gitignore.action === "none") return;
  const file = path.join(paths.agentRoot, ".gitignore");
  const block = plan.gitignore.lines.join("\n") + "\n";
  if (plan.gitignore.action === "create") {
    try {
      // wx: 計画時に無かった .gitignore が実行までの間にできていても、素の writeFileSync のように
      // truncate して既存内容を破壊しない(既存ファイル保護の最後の砦)。できていた場合は追記へ回す。
      fs.writeFileSync(file, block, { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const current = fs.readFileSync(file, "utf8");
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(file, `${separator}${block}`);
}

// ---------- 確認プロンプト ----------

/** 対話的に確認できる端末か(入力・出力の両方が TTY のときだけ) */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** y/N の確認。既定は No(取り違えたときに書き込まない側へ倒す) */
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---------- サブコマンド ----------

/**
 * `.agent/` が使える状態か(雛形一式が揃っているか)。
 * gitignore の不足は含めない(`.gitignore` の 1 行不足で `run` を止めたくないため)。
 */
export function isAgentDirReady(paths: Paths, home: string = ccloopHome()): boolean {
  const plan = planInit(paths, home);
  return plan.conflicts.length === 0 && plan.creates.length === 0;
}

function printPlan(plan: InitPlan): void {
  console.log(`${AGENT_DIR_NAME}/ の雛形を配置する:`);
  for (const line of formatInitPlan(plan)) console.log(line);
}

/**
 * `ccloop init [--yes] [--upgrade]`。戻り値はプロセスの終了コード。
 * home はテストから雛形の置き場を差し替えるための引数。
 */
export async function cmdInit(paths: Paths, argv: string[], home: string = ccloopHome()): Promise<number> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const upgrade = argv.includes("--upgrade");
  const unknown = argv.find((a) => a.startsWith("-") && !["--yes", "-y", "--upgrade"].includes(a));
  if (unknown !== undefined) {
    console.error(`未知のオプション: ${unknown}\n${usageOf("init")}`);
    return 1;
  }
  return upgrade ? await runUpgrade(paths, yes) : await runInit(paths, yes, home);
}

async function runInit(paths: Paths, yes: boolean, home: string): Promise<number> {
  const plan = planInit(paths, home);
  if (plan.conflicts.length > 0) {
    console.error(initConflictMessage(plan));
    return 1;
  }
  printPlan(plan);
  if (isInitPlanEmpty(plan)) return 0;
  if (!yes) {
    if (!isInteractive()) {
      console.error("確認できない環境(非 TTY)のため配置しない。`ccloop init --yes` を実行すること");
      return 1;
    }
    if (!(await confirm("配置してよいか?"))) {
      console.log("中止した(何も書き込んでいない)");
      return 1;
    }
  }
  applyInit(paths, plan);
  console.log("配置した");
  return 0;
}

async function runUpgrade(paths: Paths, yes: boolean): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(paths.configPath, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`${AGENT_DIR_NAME}/config.json を読めない。先に \`ccloop init\` を実行すること`);
    } else {
      console.error(configReadErrorMessage(err));
    }
    return 1;
  }
  const version = readSchemaVersion(raw);
  const compat = compareSchemaVersion(version);
  if (compat === "tool-outdated") {
    console.error(toolOutdatedMessage(version));
    return 1;
  }
  if (compat === "ok") {
    console.log(`${AGENT_DIR_NAME}/config.json は最新 (schemaVersion ${version})`);
    return 0;
  }

  const result = migrateConfig(raw);
  console.log(`${AGENT_DIR_NAME}/config.json を schemaVersion ${result.from} → ${result.to} へ移行する:`);
  for (const change of result.changes) console.log(`  ${change}`);
  if (!yes) {
    if (!isInteractive()) {
      console.error("確認できない環境(非 TTY)のため移行しない。`ccloop init --upgrade --yes` を実行すること");
      return 1;
    }
    if (!(await confirm("移行してよいか?"))) {
      console.log("中止した(何も書き込んでいない)");
      return 1;
    }
  }
  const tmp = `${paths.configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(result.config, null, 2) + "\n");
  fs.renameSync(tmp, paths.configPath);
  console.log("移行した");
  return 0;
}

/**
 * `init` 以外のコマンドの前段。`.agent/` が未配置なら init と同じ一覧・確認を通して配置する。
 * 戻り値は「処理を続けてよいか」。false のとき呼び出し側は終了コード 1 で終わる。
 */
export async function ensureAgentDir(paths: Paths, home: string = ccloopHome()): Promise<boolean> {
  if (isAgentDirReady(paths, home)) return true;
  console.error(`${AGENT_DIR_NAME}/ が未配置(または不完全)のため、ccloop を実行できない`);
  const plan = planInit(paths, home);
  if (plan.conflicts.length > 0) {
    console.error(initConflictMessage(plan));
    return false;
  }
  printPlan(plan);
  if (!isInteractive()) {
    console.error("確認できない環境(非 TTY)のため配置しない。`ccloop init --yes` を実行すること");
    return false;
  }
  if (!(await confirm("配置して続行してよいか?"))) {
    console.error("中止した(何も書き込んでいない)");
    return false;
  }
  applyInit(paths, plan);
  console.error("配置した。処理を続行する");
  return true;
}

/**
 * `.agent/config.json` を読めた・パースできたときの案内文(doctor / init --upgrade / cli.ts の
 * 各サブコマンドで共通)。JSON パース失敗を握りつぶして既定値へ倒すと「schemaVersion 0 が古い →
 * init --upgrade → やっぱり読めない → init → スキップ」という出口の無いループに陥るため、
 * パース失敗は必ずここで人間に伝えて止める。
 */
export function configReadErrorMessage(err: unknown): string {
  return `${AGENT_DIR_NAME}/config.json を読めない: ${String((err as Error)?.message ?? err)}。手で修正すること`;
}

/** ツールが古い(config のほうが新しい)ときの案内 */
export function toolOutdatedMessage(version: number): string {
  return (
    `${AGENT_DIR_NAME}/config.json の schemaVersion (${version}) が ccloop の対応版数 ` +
    `(${CURRENT_SCHEMA_VERSION}) より新しい。ccloop が古いので更新すること` +
    "(DevContainer feature の場合はコンテナを再ビルドする)"
  );
}

/** config が古いときの案内 */
export function configOutdatedMessage(version: number): string {
  return (
    `${AGENT_DIR_NAME}/config.json の schemaVersion (${version}) が古い ` +
    `(ccloop の対応版数は ${CURRENT_SCHEMA_VERSION})。\`ccloop init --upgrade\` を実行すること`
  );
}

/**
 * 読み込んだ config の schemaVersion を検査する(純粋)。
 * `run` は既定値のまま長時間動くのを避けるため古い config でも止めるが、他コマンドは
 * 状況を見るためのものなので警告に留める。
 */
export function checkSchemaVersion(
  raw: unknown,
  command: string,
): { ok: boolean; message: string | null } {
  const version = readSchemaVersion(raw);
  switch (compareSchemaVersion(version)) {
    case "tool-outdated":
      return { ok: false, message: toolOutdatedMessage(version) };
    case "config-outdated":
      return { ok: command !== "run", message: configOutdatedMessage(version) };
    default:
      return { ok: true, message: null };
  }
}
