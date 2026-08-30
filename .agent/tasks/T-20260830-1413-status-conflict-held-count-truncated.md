---
title: "status の競合待ち件数が 3 件で頭打ちになるのを直す"
status: ready
priority: 3
dependencies: []
conflicts: [T-20260830-1334-explore-assigns-conflict-metadata, T-20260830-1403-list-shows-task-conflicts, T-20260830-1407-narrow-readonly-git-deny-patterns]
retries: 0
createdAt: 2026-08-30T14:13:32.219Z
---

所属フェーズ: 4(思いつく改善すべて)。表示の不具合の修理なので人間の事前同意は不要
(`D-20260830-0303-phase4-consent-granularity` の線引きに従う)。

## 背景

`ccloop status` の「競合待ち」表示が、実際の件数ではなく **最大 3 件で頭打ちになった件数**を
出している。`conflicts` メタデータ(`T-20260830-1334-task-conflict-metadata-scheduling` で追加)の
直接の帰結であり、タスクが増えるほど顕在化する。

確認済みの事実(実際にファイルを読んで裏を取っている):

- `lib/supervisor.ts:6047` — `conflictHeldTasks(tasks, runningTaskIds, 3)` と上限 3 件で切り詰めている。
- `lib/supervisor.ts:5429-5434` — `conflictHeldTasks` は `planTaskSelection(...).conflictHeld` を
  `slice(0, limit)` して返す。よって呼び出し側に渡るのは切り詰め済みの配列のみで、
  **全体の件数はどこにも残っていない**。
- `lib/supervisor.ts:6334` — `競合待ち ${conflictHeld.length} 件` の `.length` が、その切り詰め済み
  配列を見ている。つまり表示される件数は `min(実際の件数, 3)`。
- `lib/supervisor.ts:6340-6342` — 一覧のループも切り詰め済み配列を回しており、
  超過分があることを知らせる行が無い。
- 対照として、兄弟の「スヌーズ中」表示は切り詰めない配列を使っており
  (`lib/supervisor.ts:5418-5421` / `6344`)、件数は正しく全件を出している。
- このリポジトリには切り詰め時に「ほか N 件」「…他 N 件」と明示する慣習が既にある
  (`lib/supervisor.ts:825-834` / `2025` / `5832` / `5902`)。競合待ちの表示だけがこれを踏襲していない。

## 実害

競合待ちのタスクが 4 件以上あるとき、`ccloop status` を見た人間・エージェントが「競合待ち 3 件」と
いう誤った件数を信じ、隠れているタスクの存在に気づけない。

## やること

- 全体の件数と表示用の切り詰め済み一覧を **両方**扱えるようにする(`conflictHeldTasks` の戻り値に
  総数を持たせる、`status` のデータ構造に総数のフィールドを足す、など。既存の設計に馴染む形を選ぶ)。
- `lib/supervisor.ts:6334` の件数が実際の件数を出すようにする。
- 一覧を切り詰めたときは、既存の慣習に倣って「ほか N 件」に相当する行を足す
  (`lib/supervisor.ts:825-834` 付近の書式に合わせる)。上限 3 件そのものは変えなくてよい。
- `--json` 出力の互換性に注意する。既存フィールド(`conflictHeldTasks`、`lib/supervisor.ts:5934` /
  `6112`)の意味を変えず、総数は新しいフィールドとして足すのが無難。

## 完了条件

- 競合待ちが 4 件以上のとき、`ccloop status` が正しい総数を表示し、一覧の切り詰めを明示する。
- 3 件以下のときの表示が今までと変わらない(回帰させない)。
- テストを足す。既存のテストは競合待ち 1 件のケースだけで
  (`lib/supervisor.status.test.ts:569-613`)、3 件超のケースが無いことを確認済み。
  4 件以上のケースを追加する。
- `npm test` / lint / typecheck が通る。
- `CHANGELOG.md` の「## 未リリース」節に利用者の言葉で 1 行足す(利用者が踏んでいた表示の誤り)。
  `conflicts` 関連の行が既にあれば、重複させず自然な形にまとめる。

## 注意

`lib/supervisor.ts` と `CHANGELOG.md` の「## 未リリース」節は並列セッションの取り合いが起きる。
同じ箇所を触るタスクとは `conflicts` で同時実行しないよう指定済み。
