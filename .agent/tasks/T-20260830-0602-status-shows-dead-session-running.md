---
title: "ループが死んでいると判定済みでも「実行中のタスク」が生きているように表示され続ける"
status: ready
priority: 2
dependencies: []
retries: 2
note: "失敗のため ready に戻す(2/3)。理由: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0602-status-shows-dead-session-running.md)(元: 失敗のため ready に戻す(1/3)。理由: main へのマージが衝突した(.agent/decisions/index.md, CHANGELOG.md…)"
createdAt: 2026-08-30T06:02:18.660Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので、フェーズ 4 の個別確認は不要。

## 目的

`ccloop status` / `ccloop watch` が、既に死んでいると判定済みのループのタスクを
「実行中」として表示し続ける問題を直す。人間がループの外から状況を把握する唯一の窓が
「まだ動いている」という誤った安心感を与え、再起動の判断が遅れる。

## 現象(調査で実挙動確認済み)

`ccloop run` が異常終了(kill -9 など)して `state.json` の `runningSessions` に
エントリが残った状態で `ccloop status` を実行すると:

- 死活判定 `loopLiveness` は `{status: "stopped", reason: "process-gone"}` を正しく返す
- にもかかわらず「実行中のタスク」節は当該タスクを経過時間つきで淡々と表示し、
  警告を一切出さない。タスクのタイムアウト(既定 40 分)に達するまでは
  「※ タイムアウトを超過」の注記すら出ない
- `ccloop watch` では毎フレーム `now - startMs` を再計算するため経過時間が
  1 秒ごとに増え続け、「動いている感」だけが強まる

原因は、`runningSessionLines`(`lib/supervisor.ts:4308` 付近)が `loopLiveness` を
一切参照しておらず、`collectStatusData`(同 `4771` 付近)も両者を別々に計算するだけで
結びつけていないこと。稼働状態の節を下まで読めば「停止している」と分かるが、
上部の「実行中のタスク」節と矛盾したことを同じ画面で言っている。

## 完了条件

- 死活判定が `running` 以外(特に `process-gone`)のときに「実行中のタスク」節が
  誤解を招かない表示になっている。表示の具体(警告を添えるか、見出しを変えるか、
  経過時間の増加を止めるか)は実装者が決めてよいが、**画面内で矛盾したことを言わない**
  ことを満たすこと。判断の理由は `.agent/decisions/` に短く記録する
- `loopLiveness` が `process-gone` かつ `runningSessions` が非空、という組み合わせを
  再現する回帰テストを追加する(既存テストにこの組み合わせは無い)
- typecheck / lint / test が通る
- 利用者から見た表示が変わるので `CHANGELOG.md` の「## 未リリース」節に 1 行足す

## 補足

`.agent/OVERVIEW.md` の「確認トピックの在庫」3 番(ループが致命的な理由で自分から止まっても
`ccloop status` に何も残らない件)と隣接するが、別件である。在庫 3 は「稼働記録が消えるため
一度も起動していない場合と区別が付かない」という情報の欠落で、人間の確認待ち。
こちらは「稼働記録が残っていて停止と判定できているのに、別の節が矛盾したことを言う」という
表示の不整合であり、確認を待たずに直してよい。

## 試行履歴

### 試行 1(2026-08-30T06:19:07.112Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, CHANGELOG.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 2(2026-08-30T06:29:39.036Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0602-status-shows-dead-session-running.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
