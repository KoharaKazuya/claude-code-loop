---
title: "README の ccloop add の説明に --conflicts を足す"
status: ready
priority: 4
dependencies: []
conflicts: [T-20260830-1334-explore-assigns-conflict-metadata]
retries: 0
createdAt: 2026-08-30T14:13:32.219Z
---

所属フェーズ: 4(思いつく改善すべて)。実装済み機能とドキュメントの表記不一致の解消なので
人間の事前同意は不要(`D-20260830-0303-phase4-consent-granularity` の線引きに従う)。

## 背景

`ccloop add` は `--conflicts`(同時に実行しないタスク ID)を受け付けるのに、README にその記載が無い。

確認済みの事実(実際にファイルを読んで裏を取っている):

- `README.md:60` — `ccloop add "タイトル" [--desc ...] [--priority ...] [--deps ...] [--model ...] [--slug ...]`
  と書かれており `--conflicts` が無い。README 全体で `conflicts` の記述は **0 件**。
- `lib/help.ts:93-102` — `ccloop add --help` の出力には
  `[--conflicts <ID>,<ID>,...]` と、オプション説明
  `--conflicts <ID>,<ID>  同時に実行しないタスク ID(カンマ区切り)。既定は競合なし` が既にある。
- `lib/supervisor.ts:4805-4808` — `cmdAdd` は実際に `--conflicts` を解釈し、
  `assertDepsExist` で存在検証もしている。

## 実害

README だけを読んで `ccloop add` を使う利用者が `--conflicts` の存在に気づかず、
`--help` を叩かない限り「競合を設定するには frontmatter を手編集するしかない」と誤解する。

## やること

- `README.md:60` の synopsis 行に `--conflicts` を足す。既存の `--deps` の直後が自然。
- README のその周辺に各オプションの説明があるなら、`--deps` の説明に倣って `--conflicts` も
  1 行足す。説明の文言は `lib/help.ts` の記述と食い違わせないこと。
- README に `conflicts` の概念(同時に実行しないタスクの指定)を短く補う価値があるか判断する。
  ただし README を膨らませないこと。詳しい説明の置き場所として `docs/` が適切なら、
  そちらへのリンクで足りる。

## 完了条件

- README の `ccloop add` の説明が `lib/help.ts` の実際のオプションと一致する。
- lint / typecheck / `npm test` が通る(ドキュメントのみの変更でも一応通す)。
- `CHANGELOG.md` は触らない(利用者から見た挙動は変わらず、ドキュメントの記述改善に当たるため。
  運用ルール上、docs の記述改善は変更履歴に載せない)。

## 注意

`T-20260830-1334-explore-assigns-conflict-metadata` が `docs/` を触る可能性があるため
`conflicts` で同時実行しないよう指定してある。
