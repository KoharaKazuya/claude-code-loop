---
title: "worktree 内で ccloop を実行するとリポジトリ本体の .agent を書き換える"
status: completed
priority: 2
dependencies: []
retries: 0
note: "paths を root(git・state)と agentRoot(.agent/)の 2 系統に分離。run は worktree 内でエラー終了"
createdAt: 2026-08-30T11:32:00.000Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので人間への確認は取らずに進めてよい。

## 何が起きたか(確認済みの事実)

T-20260830-1002 のセッション(worktree `agent/T-20260830-1002-failed-task-abandon-flow` 内)で、
worktree 内から `./bin/ccloop abandon <ID>` を 2 回実行した。結果:

- 標準出力は成功を報告し、`./bin/ccloop status` の出力からも対象タスクが要対応から消えた
- しかし **worktree 側の `.agent/tasks/` は一切変更されず**、代わりに
  `/workspaces/claude-code-loop/.agent/tasks/`(リポジトリ本体のワーキングツリー)の 2 ファイルが
  書き換わっていた(`git -C /workspaces/claude-code-loop status --porcelain .agent` で確認)

つまり worktree 内で実行した書き込み系サブコマンドが、そのセッションのブランチではなく
リポジトリ本体の作業ツリーを直接汚す。

## なぜ問題か

- セッションの成果がブランチに乗らず、自動マージの経路を通らない。人間の作業ツリーに
  誰のコミットにも紐づかない差分が残る
- 同じファイルをブランチ側でも変更していると、`git merge` が「ローカルの変更が上書きされる」で
  中断し、そのセッションの成果全体がマージできなくなる恐れがある
- セッションからは成功したように見えるため、気づかずに完了報告される

## やること

- リポジトリルート・`.agent` ディレクトリの解決方法を調べ、`git rev-parse --show-toplevel` 相当の
  「実行中の作業ツリー」基準になっているか確認する(現状は本体側に解決されている)
- worktree 内実行時の期待挙動を決めて実装する。少なくとも次のどちらか:
  - 実行中の worktree の `.agent/` を対象にする(自然な期待)
  - 本体を対象にすると決めるなら、その旨を実行時に明示し、docs に書く
- 自律セッションが誤って本体を汚さないよう、worktree 内での書き込み系サブコマンド実行時の
  扱いを docs へ記載する

## 完了条件

- worktree 内から書き込み系サブコマンド(abandon / retry など)を実行したときの対象ディレクトリが
  テストで固定されていること
- 挙動が docs に記載されていること
