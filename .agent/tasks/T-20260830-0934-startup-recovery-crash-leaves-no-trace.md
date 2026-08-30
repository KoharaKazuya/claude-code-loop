---
title: "起動時復旧が削除と記録の間で強制終了されると、成果が「未着手」のまま痕跡なく消える"
status: ready
priority: 3
dependencies: []
retries: 0
createdAt: 2026-08-30T09:34:06.873Z
---

所属フェーズ: 4(思いつく改善すべて)。

## 目的

`T-20260830-0829-finish-crash-leaves-no-trace` が指摘しているのと**同型の欠陥が、別の関数にも
独立して存在する**。そちらのタスクは `finishTaskSession` だけを対象にしているため、
起動時復旧の側は手当てされない。ここを塞ぐ。

## 何が起きるか

`lib/supervisor.ts` の `recoverOrphanBranch`(1279 行付近)は、ループ起動時に取り残された
ブランチ・作業場所を回収する。その中で:

- `merged` / `renumbered` / `nothing-to-merge` の分岐(1350-1372 行付近)は
  `removeWorktree` → `deleteBranch` を**先に**実行し、その**後**で `recordStartupRecoveryNote` を
  呼んでタスクファイルへ記録する。
- `conflict` 分岐(1330-1344 行付近)も `renameBranch` で退避した**後**に記録する。

この「削除・改名 → 記録」の間でプロセスが強制終了(`kill -9` / OOM / ホスト再起動)されると、
作業場所もブランチも消えているのにタスクファイルの `status` / `note` / `## 試行履歴` は
未更新のままになる。main には成果が入っているのに、`ccloop status` 上そのタスクは
「次に実行予定」としか見えない。次の周回で未着手として再選定され、二重実装や
自己矛盾する変更につながる。

## やること

`T-20260830-0829-finish-crash-leaves-no-trace` と同じ方針(記録を削除より先に済ませる、または
「削除済みだが記録前」を後から検出できる形で残す)を `recoverOrphanBranch` の同型区間へ適用する。

## 着手時にまず確認すること

`T-20260830-0829-finish-crash-leaves-no-trace` は本タスク登録時点で実行中だった。その修正が
`recoverOrphanBranch` まで巻き取っている可能性がある。**着手時に main の現状を確認し、
既に手当て済みなら本タスクは `completed` にして `note` にその旨を書く**(重複実装しない)。
方針が既に確立していれば、それに合わせること(独自の方式を作らない)。

## 完了条件

- 起動時復旧の各分岐で、削除・改名の前後どちらでプロセスが落ちてもタスクの状態が復元できる。
- 回帰テストがある(既存の起動時復旧テストの近くに置く)。
- `npm run` の typecheck / lint / test が通る。
- 利用者から見た挙動が変わるので `CHANGELOG.md` の「## 未リリース」に 1 行足す。

## 試行履歴
