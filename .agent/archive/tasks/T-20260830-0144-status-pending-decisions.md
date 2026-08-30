---
title: "ccloop status に未承認の決定の件数とプレビューを表示"
status: completed
priority: 3
dependencies: [T-20260830-0144-decision-approval-archive]
retries: 0
createdAt: 2026-08-30T01:44:34.747Z
---

## 目的

`ccloop status` に、まだアーカイブされていない(= 人間が未承認の)決定の件数と、
新しい順に最大 3 件のプレビューを表示する。人間が「読むべき決定が溜まっているか」を
status だけで把握できるようにする。

## 前提

依存タスク T-20260830-0144-decision-approval-archive により、decisions のアーカイブは
「人間が `.agent/decisions/index.md` でチェックした決定のみアーカイブ」になっている。
したがって `.agent/decisions/` に残っている決定ファイル(`D-*.md`)= 未承認の決定である。

## 仕様

- `lib/supervisor.ts` の `collectStatusData` に未承認決定の情報を追加する:
  - 件数
  - 新しい順(ID 降順)に最大 3 件の `{ id, title }`(title は frontmatter から)
  - `--json` 出力にキー `pendingDecisions`(例: `{ count, preview: [{ id, title }] }`)
    として含める。
- `formatStatus` の `[確認推奨]` セクションに表示を追加する:
  - 「未承認の決定: N 件」+ プレビュー最大 3 行(ID と title)
  - 承認方法の案内 1 行(`.agent/decisions/index.md` のチェックボックスにチェックを
    付けるとアーカイブされる旨)
  - 0 件のときは何も表示しない(既存セクションの流儀に合わせる)。
- レイアウトは既存の単一カラム・プレーンテキストのまま。新しいレイアウト機構や
  依存ライブラリは追加しない。

## 完了条件

- `ccloop status` で未承認決定の件数・プレビュー・案内が表示される(0 件時は非表示)。
- `ccloop status --json` に `pendingDecisions` が含まれ、`lib/cli.test.ts` の
  必須キー検証が更新されている。
- 表示部分(セクション行生成)の単体テストが追加されている。
- `npm test`(vitest)が通る。

## 試行履歴
