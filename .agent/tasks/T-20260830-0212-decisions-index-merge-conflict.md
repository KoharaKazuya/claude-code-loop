---
title: "decisions/index.md の同時追記によるマージ衝突を機械的に解決する"
status: ready
priority: 3
dependencies: []
retries: 0
createdAt: 2026-08-30T02:12:00.000Z
---

## 目的

`.agent/decisions/index.md` が複数のタスクセッションから同時に追記されたときに起きるマージ衝突を、
人間判断へ回さず機械的に解決できるようにする。

## 背景

決定ファイルを作成したセッションは `.agent/decisions/index.md` のリスト先頭に 1 行追記する
(`lib/prompt/PROMPT.md` の「記録ファイルの形式」節)。並列に走る 2 つのタスクセッションが
それぞれ別ブランチで先頭に追記すると、同じ領域の modify/modify となり `git merge` が衝突する。

現在 `lib/merge.ts` の `classifyConflicts` は own-task-file 以外のコンフリクトをすべて
"substantive" として扱い、マージを abort して人間判断へ回す。`.agent/decisions/` 直下は
「同名になるのは二重起票のときだけ」という前提で意図的に substantive にしているが、
index.md はその前提が当てはまらない(同時編集が正常な運用で起きる)。

このままだと決定を記録するセッションが並走するたびにマージが止まり、自律性が落ちる。

## 想定する方針(実装時に再検討してよい)

- `.agent/decisions/index.md` を own-task-file と同様の「機械的に解決できるコンフリクト」として
  分類し、両側のリスト行の和集合を取って解決する(ID 降順に正規化、同一 ID はチェック済みを優先)。
- 行のパース・正規化ロジックは `lib/rotate.ts` の `parseDecisionsIndex` /
  `buildDecisionsIndexText` と重複するため、共有できる形に切り出すことを検討する。
- ヘッダ・フッタが両側で異なる場合の扱いを決める(片側優先か、衝突として人間へ回すか)。
- own-task-file との混在時の分類(現在は混在すれば substantive)をどうするか決める。

## 完了条件

- 上記の衝突が `lib/merge.ts` で機械的に解決され、その挙動を検証する単体テストがある。
- 解決結果がリコンサイル後も安定する(次回 `rotate` で書き換えが発生しない)ことを確認する。
- `npm test` / `npm run typecheck` / `npm run lint` が通る。
- 方針の判断を `.agent/decisions/` に記録する。

## 試行履歴
