---
title: "停止直前の衝突解消はスヌーズを無視する(現行実装を正とする)"
reversibility: high
tasks: [T-20260830-0429-conflict-resume-snooze]
createdAt: 2026-08-30T04:35:58.275Z
---

## 判断

`planConflictResume` が `snoozeUntil` を参照しない現行実装を正とする。実装は変えず、意図を
コードコメント・`docs/architecture.md`・回帰テスト・`lib/prompt/PROMPT.md` に固定した。

## 前提の訂正

タスク登録時の見立て「衝突が残る限り次の周回で即座に再起動されうる」は成り立っていない。
`planConflictResume` の唯一の呼び出し元は clean 停止処理中の `selectConflictResumable`
(`stopMode === "clean" && runningCount === 0 && rateLimitedUntilMs === null` の条件下)であり、
通常周回の選定は `selectRunnable` → `planTaskSelection` を通るためスヌーズが尊重される。
起動時リカバリ `recoverOrphanBranch` も衝突中の worktree を保持するだけでセッションを起動しない。
つまりスヌーズが無視されるのは「停止直前・タスクごとに 1 回まで・同時 1 本まで」の経路に限られる。

## 理由

1. 無視は上記のとおり上限つきで、空振りセッションを繰り返す構造にはならない。
2. スヌーズは「そのタスクの本来の作業をしても空振りする」という申告だが、衝突解消セッションの
   仕事(マーカーの解消・検証・コミット)はスヌーズが待つ人間の入力とは独立に進められる。
3. 例外の目的(MERGE_HEAD 付きの worktree を抱えたままプロセスを終えない)は、スヌーズを
   尊重すると達成できない。

## 検討した代替案

`planConflictResume` から `snoozed` を外して待機を尊重する案。停止時に中断状態の worktree が
そのまま残り、「Ctrl+C 直後にたまたま衝突したかどうか」で停止後の状態が変わるという、例外を
設けた元の問題が戻るため採らなかった。

## 影響範囲

挙動の変更なし。利用者から見える変化がないため `CHANGELOG.md` には追記していない。
