---
title: "ccloop status の出力全体に結合テストを追加する"
status: completed
priority: 3
dependencies: []
retries: 0
note: "lib/supervisor.status.test.ts を追加(3 ケース)。collectStatusData を export。test/lint/typecheck 通過"
createdAt: 2026-08-30T02:36:30.702Z
---

所属フェーズ: 現在フェーズ内の検証強化。機能追加ではない。

## 目的

`ccloop status` は人間がループの外から状況を把握するほぼ唯一の窓口だが、出力を組み立てる
`collectStatusData` / `formatStatus`(`lib/supervisor.ts` 4127 行付近〜)を直接検証するテストが
存在しない。構成要素(`loadPendingDecisions`、`classifyHumanReview`、
`pendingDecisionsSectionLines`、`summarizePermissionDenials` など)には単体テストがあるが、
それらを集約して 1 画面に整形する部分は無防備で、節の欠落・重複・条件分岐の取り違えが
テストをすり抜ける。

## 完了条件

- `collectStatusData` と `formatStatus` を対象に、fixture(一時ディレクトリに `.agent/` 一式を
  作る形でよい)を用いた結合テストを追加する。少なくとも次のケースを含める:
  - 何も無い状態 → 「要対応事項なし」が出る
  - open な BLOCK / REVIEW、failed / blocked タスク、未承認の決定が混在する状態 →
    それぞれの節が出て、「要対応事項なし」が出ない
  - 未承認の決定がプレビュー上限を超える件数 → 「…他 N 件」が出る
- スナップショット全文の固定ではなく、節の見出しやキーとなる語の有無で検証する
  (文言の細かな調整でテストが壊れ、検証を弱める方向の圧力がかからないようにするため)。
- 既存のテストの実行方法に合わせる(`npm run` のスクリプトを確認すること)。
- `npm run` で利用可能な検証(tests / lint / typecheck)を通す。
