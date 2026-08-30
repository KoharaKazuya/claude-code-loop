---
title: "status のタスク選定が now 引数を無視して実時刻を使う"
status: ready
priority: 4
dependencies: []
conflicts: []
retries: 0
createdAt: 2026-08-30T14:35:30.372Z
---

所属フェーズ: 4(思いつく改善すべて)。内部の作り替えであり利用者から見た挙動は変わらないため、
事前の確認(Human Review)は不要な範囲。

## 目的

`collectStatusData(now)` は `now` を引数で受け取るのに、タスク選定系のヘルパーがそれを使わず
実時刻を直に読んでいる。時刻を注入できないため、スヌーズが絡む表示のテストが実時刻に依存する。

## 現状(確認済みの事実)

`lib/supervisor.ts` の以下 3 箇所が `planTaskSelection(tasks, new Date(), runningIds)` と実時刻を
ハードコードしている。

- `lib/supervisor.ts:5423` (`nextRunnableTasks`)
- `lib/supervisor.ts:5432` (`snoozedTasksByUntil`)
- `lib/supervisor.ts:5448` (`conflictHeldTasks`)

`collectStatusData` は `lib/supervisor.ts:6062-6064` でこの 3 つを呼ぶが、引数で受けた `now` は
渡していない。そのため `collectStatusData(NOW)` に固定時刻を渡してもスヌーズ判定だけは実時刻で
行われる。なお `planTaskSelection` 自体は第 2 引数で時刻を受け取る設計になっており
(`lib/supervisor.ts:2260`)、`lib/supervisor.ts:2378` の呼び出しは `opts.now` を渡している。

この影響で `lib/supervisor.status.test.ts` の待ち理由表示のテストは、スヌーズ解除時刻を固定値では
なく実時刻からの相対(`futureIso` ヘルパー)で作る必要がある。固定日時を書くとその日時を過ぎた
時点でスヌーズが解除されテストが壊れるため。

## 完了条件

- 上記 3 ヘルパーが時刻を引数で受け取り、`collectStatusData` が自身の `now` を渡すようにする。
- `lib/supervisor.status.test.ts` の `futureIso` を使っているテストを、固定時刻(`NOW` 基準)で
  書けるように直す。`futureIso` が不要になれば削除する。
- 既存テストの検証内容を弱めない。`npm test` / `npm run lint` / `npm run typecheck` が通る。

## 注意

`ccloop status` の実際の出力は変わらない(本番では `now` に実時刻が渡るため)。利用者から見た
挙動は変わらないので `CHANGELOG.md` には載せない。
