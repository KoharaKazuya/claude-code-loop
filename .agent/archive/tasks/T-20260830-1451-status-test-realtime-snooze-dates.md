---
title: "status のスヌーズ表示テストが実時刻依存で 2026-09-01 に壊れる"
status: completed
priority: 3
note: "formatStatus(NOW) に修正。時刻を 2027-06-15 に偽装した全 35 ファイルのテスト実行でも全件通ることを実測で確認"
dependencies: []
conflicts: []
retries: 0
createdAt: 2026-08-30T14:51:17.426Z
---

所属フェーズ: 4(思いつく改善すべて)。テストの修正であり利用者から見た挙動は変わらないため、
事前の確認(Human Review)は不要な範囲。

## 目的

`lib/supervisor.status.test.ts` の「note がある snoozed タスクは note を表示し、無いタスクは
`[snoozed until ...]` のみ表示する」テスト(283 行付近)が実時刻に依存しており、
システム時刻が 2026-09-01 を過ぎると失敗する。固定時刻ベースに直す。

## 現状(確認済みの事実)

- 当該テストは `formatStatus()` を引数なしで呼んでおり、`formatStatus` の既定引数により
  実時刻で状態が組み立てられる。一方 `snoozeUntil` は `"2026-09-01T00:00:00.000Z"`(287 行)/
  `"2026-09-02T00:00:00.000Z"`(293 行)とハードコードされている。実時刻がこれを過ぎると
  スヌーズが解除され、`[snoozed until ...]` の表示が消えてテストが失敗する。
- `formatStatus(now?: Date)` は任意引数で時刻を受け取れる(既定は実時刻)。同ファイルには固定時刻
  `NOW = new Date("2026-08-30T00:00:00.000Z")` があり、他のスヌーズ関連テストは
  `formatStatus(NOW)` で固定時刻化済み。
- システム時刻を 2027-06-15 に偽装して `lib/supervisor.status.test.ts` を実行し、
  61 テスト中このテスト 1 件だけが失敗することを実測で確認済み。

## 完了条件

- 当該テストが `formatStatus(NOW)` を使い、固定時刻ベースで通るようにする。
  `collectStatusData` の呼び出しも `NOW` に揃える。
- 同ファイル内に他にも実時刻依存で将来壊れるテストが残っていないか確認する
  (システム時刻を未来にずらして当該ファイルを実行するのが確実)。見つかれば併せて直す。
- テストの検証内容を弱めない(note の表示・非表示、`[snoozed until ...]` の表記の検証は維持する)。
- `npm test` / `npm run lint` / `npm run typecheck` が通る。

## 注意

`ccloop status` の実際の出力は変わらない。利用者から見た挙動は変わらないので `CHANGELOG.md` には載せない。
