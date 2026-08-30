---
title: "ccloop list で各タスクの conflicts が見えるようにする"
status: completed
priority: 4
dependencies: []
conflicts: [T-20260830-1334-explore-assigns-conflict-metadata]
retries: 0
createdAt: 2026-08-30T14:03:45.383Z
---

所属フェーズ: 4(思いつく改善すべて)。

## 背景

タスク frontmatter の `conflicts`(同時に実行しないタスク ID)を
`T-20260830-1334-task-conflict-metadata-scheduling` で追加した。`ccloop status` には
「競合待ち」の行が出るが、`ccloop list` のテキスト表示には `dependencies` の `deps:` 行に相当する
`conflicts` の行が無い。そのため「どのタスクに何が設定されているか」を確かめる手段が
`ccloop list --json` か frontmatter の直読みに限られている。実装後のレビューで指摘された。

## やること

- `ccloop list` のテキスト表示(`lib/supervisor.ts` の `printTaskLine` 付近。`deps:` 行を出している
  箇所)に倣って、`conflicts` が空でないタスクにだけ 1 行足す。空のタスクでは何も出さない
  (既存の表示を増やさない)。
- 既存の `deps:` 行のテストがあれば、それに倣ってテストを 1 件足す。
- 利用者から見た表示が変わるので `CHANGELOG.md` の「## 未リリース」節を確認する。
  `conflicts` の 1 行が既にあるなら、そこに含める形にして重複させない。

## 完了条件

- `conflicts` を持つタスクが `ccloop list` で見えること。持たないタスクの表示が変わらないこと。
- 機械的検証(`npm test` / lint / typecheck)が通ること。

## 注意

`lib/supervisor.ts` は並列セッションのホットスポットである。同じ箇所を触る
`T-20260830-1334-explore-assigns-conflict-metadata` とは同時に実行しない(`conflicts` で指定済み)。
