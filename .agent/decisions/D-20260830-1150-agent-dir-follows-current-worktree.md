---
title: ".agent/ の基準は実行中の作業ツリー、git 操作と state は本体ワークツリー"
reversibility: high
tasks: [T-20260830-1132-ccloop-in-worktree-targets-main-agent-dir]
createdAt: 2026-08-30T11:50:00.000Z
---

## 判断内容

`lib/paths.ts` のパス解決を `root`(本体ワークツリー)と `agentRoot`(実行中の作業ツリー)の
2 系統に分け、`.agent/` 配下は `agentRoot`、git 操作と state ディレクトリは `root` を基準にした。
`ccloop run` は linked worktree 内から起動されたらエラーで止める。

## 理由

worktree 内から `ccloop abandon` 等を実行すると本体の `.agent/tasks/*.md` が書き換わり、
セッションの成果がブランチに乗らず、本体の作業ツリーが誰のコミットにも紐づかない差分で汚れ、
自動マージが「ローカルの変更が上書きされる」で止まる恐れがあった。

`mainWorktreeRoot()` による本体への読み替えは repoId 安定化と git 操作のために必要なので廃止できない。
「読み替えるべきか」の答えが `.agent/` と git/state で逆になるため、1 つの root で両方を賄えない。

## 検討した代替案

- worktree 内での書き込み系サブコマンドを禁止する: セッションが `ccloop add` すら使えなくなり、
  タスク登録の導線が失われる。
- 本体を対象にしたまま実行時に警告する: 警告しても本体が汚れる害は消えない。

## 影響範囲

`createPaths` に第 3 引数 `agentRoot`、`resolveRepoRoots()` を追加。`resolveRepoRoot()` は
従来どおり本体を返す(シグネチャ不変)。`.agent/` を触る処理を新しく足すときは `paths.root` では
なく `paths.agentRoot` を使う(docs/architecture.md に記載)。
