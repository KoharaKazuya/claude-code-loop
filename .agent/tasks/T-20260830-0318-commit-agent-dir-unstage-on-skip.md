---
title: ".agent 自動コミットのスキップ時にステージを元へ戻す"
status: completed
priority: 2
dependencies: []
retries: 0
note: "add の前にステージ状況を検査して早期 return する方式で修正。回帰テスト追加、typecheck/lint/test 通過"
createdAt: 2026-08-30T03:18:17.730Z
---

所属フェーズ: 現在フェーズ内の不具合修理。既に決まっている「人間の並行作業を保護する」挙動が
実現できていないため、人間の確認は不要
(`.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` の「確認を取らない」側)。

## 目的

`commitAgentDir`(`lib/supervisor.ts:664` 付近)が「.agent 以外の変更がステージされている」ことを
理由に自動コミットをスキップした際、自身が実行した `git add -A -- .agent` を取り消さないまま
return するため、人間のインデックスに `.agent/` の変更がステージされたまま残る。

## 現状(確認済みの事実)

- `lib/supervisor.ts` の `commitAgentDir` は次の順で動く。
  1. `git status --porcelain -- .agent` で差分の有無を確認
  2. `git add -A -- .agent` でステージ
  3. `git diff --cached --name-status -M -z HEAD`(pathspec なし)で全ステージ内容を検査
  4. `.agent/` 以外が混ざっていたら警告ログを出して return
- 4 の return パスに、2 で加えたステージを戻す処理がない。
- スキップの意図はコード内コメントで「人間の並行作業を保護」と明記されている。現状はむしろ
  人間が次に `git commit` したときに `.agent/` の自動生成物を巻き込ませてしまう。

## 完了条件

- スキップして return する前に、自身が加えた `.agent` 分のステージを元の状態へ戻す。
  人間が事前に `.agent/` 配下を意図的にステージしていた場合にそれを消してしまわないこと
  (2 の実行前に `.agent` 配下のステージ状態を記録し、差分だけ戻す等)。
- 戻す操作自体が失敗しても既存の try/catch と同様に警告ログで済ませ、ループを止めないこと。
- `lib/supervisor.test.ts` に回帰テストを追加する。最低限、
  「`.agent` 外のファイルを人間がステージ済みの状態で `commitAgentDir` を呼ぶと、
  コミットされず、かつ `.agent` 配下がステージされていない」ことを検証する。
- `npm run typecheck` / `npm run lint` / `npm test` が通ること。

## 注意

`gitOperationInProgress` による早期 return(ステージ前)は今回の対象外。
