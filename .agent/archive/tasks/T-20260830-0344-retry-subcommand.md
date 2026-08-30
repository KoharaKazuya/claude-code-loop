---
title: "失敗タスクをやり直す ccloop retry サブコマンドを追加する"
status: completed
priority: 4
dependencies: []
retries: 0
note: "ccloop retry を実装。typecheck / lint / test(852 件)通過、reviewer は APPROVE"
createdAt: 2026-08-30T03:44:35.036Z
updatedAt: 2026-08-30T04:22:00.000Z
---

所属フェーズ: 4(思いつく改善すべて)。

## 経緯

`HR-20260830-0341-topic-retry-subcommand`(BLOCK)への回答は **「やる」**。
HR で提案した内容をそのまま実装する。

## 目的

失敗して止まったタスクをやり直すのに、いまは `.agent/tasks/<id>.md` の frontmatter を開いて
`status: ready` と `retries: 0` の 2 か所を手で書き換える必要がある(README.md:97-99)。
片方だけ直すと期待どおりに動かない。これを `ccloop retry <タスクID>` の一言で済むようにする。

## やること

- `ccloop retry <タスクID>` を追加する。指定したタスクの `status` を `ready` に、`retries` を
  `0` に戻す。
- 失敗していないタスク(completed / ready など)を指定した場合は、誤操作を防ぐため何も変更せず
  その旨を伝えて終了する。
- 直前の失敗理由(`note` や `## 試行履歴` の最新エントリ)が記録されていれば、戻す前に表示して
  何を再実行しようとしているかが分かるようにする。

## 設計上の注意

- 実行中のタスクを対象にできてしまうと、走っているセッションと状態が食い違う。実行中かどうかは
  タスクファイルには現れず ccloop が別途管理しているので、その情報を見て弾くこと。
- タスク ID の指定ミスは起こりやすい。存在しない ID には、近いものを提示するか、少なくとも
  「見つからない」と明確に伝える。`.agent/archive/tasks/` にあるものを指定された場合の扱いも
  決めること(黙って失敗しないこと)。
- ヘルプ(`lib/help.ts`)への追加を忘れないこと。使い方文言は `usageOf()` から再利用し、
  二重管理にしない(既存のサブコマンドと同じ作りに揃える)。
- 手で書き換える方法は今までどおり使える。README の該当箇所は、コマンドを推奨しつつ手作業の
  説明も残す形に更新する。

## 完了条件

- `ccloop retry` が動き、失敗タスク / 失敗していないタスク / 存在しない ID / 実行中のタスクの
  それぞれについて期待どおりに振る舞うことを確認する回帰テストがある。
- `lib/help.ts` と README.md が新しいコマンドを反映している。
- `npm run` 経由の test / typecheck / lint が通る。

## 試行履歴

### 試行 1(2026-08-30T04:22:00.000Z, セッション記録)
- 確認済みの事実: `ac489d0` で実装をコミット。`lib/supervisor.ts` に `cmdRetry`、`lib/cli.ts` の
  `REPO_COMMANDS` と switch、`lib/help.ts` の `TOP_LEVEL_HELP` / `SUBCOMMAND_HELP["retry"]`、
  README.md の再実行手順、CHANGELOG.md「未リリース」を更新。回帰テストは `lib/cli.test.ts`
  (failed / blocked / completed / 存在しない ID / 実行中 / 引数不正 / snoozeUntil 解除)と
  `lib/supervisor.test.ts`(`lastAttemptHistoryEntry` / `suggestSimilarTaskIds`)に追加。
  `npm run typecheck` / `npm run lint` / `npm test`(852 件)いずれも通過。reviewer は APPROVE。
- 未検証の推測: なし。
- 次の試行への提案: 完了済み。reviewer が挙げた残りのテスト補強(20 行切り詰めの境界、archive
  案内の統合テスト、「もしかして:」出力書式の統合テスト)は別タスク
  `T-20260830-0422-retry-test-coverage` に切り出した。
