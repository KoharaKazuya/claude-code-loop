---
title: "supervisor の破壊的操作が repoPaths() の暗黙デフォルトに依存している"
status: completed
priority: 3
dependencies: []
retries: 0
note: "破壊的操作(park/salvage/reproduceMergeConflict/skipMainWriteIfGitBusy)の root を必須引数化し、TaskSessionContext.root で持ち回す形にした"
createdAt: 2026-08-30T09:29:00.000Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れやすい設計の修理なので人間への確認は取らずに進めてよい。

## 何が問題か

`lib/supervisor.ts` のモジュールスコープに `repoPaths()`(89-98 行目付近)というシングルトンがあり、
未初期化なら `resolveRepoRoot()`(引数無し = `process.cwd()` 起点)でリポジトリルートを決める。
そしてブランチ・worktree を**破壊的に操作する**関数群が、これを引数のデフォルト値として使っている。

- `finishTaskSession`(3193 行目付近): `mergeAgentBranch(repoPaths().root, ...)` /
  `removeWorktree(repoPaths().root, ...)` / `deleteBranch(repoPaths().root, ...)`
- `parkTaskWorktree(taskId, worktree, branch, at)`(3116 行目付近): **`root` パラメータ自体が無い**。
  内部で `removeWorktree(repoPaths().root, ...)` / `renameBranch(repoPaths().root, ...)` を直呼びしており、
  呼び出し側から対象リポジトリを指定する手段がない。
- `salvageWorktreeDiff(..., root = repoPaths().root)`(3092 行目付近)
- `skipMainWriteIfGitBusy(taskId, root = repoPaths().root)`(3179 行目付近)

`lib/supervisor.finish.test.ts` は `beforeEach` で `useRepoRoot(dir)`、`afterEach` で
`setRepoPaths(originalPaths)` を呼んで隔離しており、現状は正しく動いている(実行して確認済み)。
つまり**いま壊れてはいない**。問題は、安全性が「テスト作者が毎回 `useRepoRoot` を呼び忘れないこと」に
依存している点である。呼び忘れ・`afterEach` 到達前の例外・同一ワーカー内での他テストとの干渉が
起きた瞬間、対象は**開発者のリポジトリ本体**になり、ブランチ削除や改名が実リポジトリに走る。

関連: T-20260830-0828-tests-create-real-branches(テストが本体にブランチを作る問題)。そちらでは
検出の仕組み(`lib/test-global-setup.ts`)とフック側の fail-closed を入れたが、この経路は手を付けていない。

## やること

破壊的操作を行う関数から「暗黙のデフォルト = プロセスの cwd」を取り除き、対象リポジトリを
呼び出し元が明示する設計に寄せる。

1. `parkTaskWorktree` に `root` パラメータを追加し、内部の `repoPaths().root` 直呼びをやめる。
2. `finishTaskSession` ほか、worktree/ブランチを作成・削除・改名・マージする経路について、
   `root` を引数として受け取る形に揃える。呼び出し元(CLI エントリ・フック)で明示的に渡す。
3. `repoPaths()` のデフォルト解決を残す場合でも、破壊的操作の経路からは切り離す。
   読み取り専用の用途に限るなら、そのことをコードコメントか docs/ に明記する。

範囲が広がりすぎる場合は 1 だけでも独立して価値がある。段階的に進めてよい。

## 完了条件

- 破壊的操作を行う関数が、対象リポジトリのルートを引数で受け取る(暗黙の cwd フォールバックに
  依存しない)こと。
- `npm run typecheck` / `npm run lint` / `npm run test` が通ること。
- テスト側の `useRepoRoot` による隔離は保険として残してよいが、それが唯一の防波堤ではなくなること。
