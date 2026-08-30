---
title: "衝突解消セッションが時間切れになると、失敗理由が「時間切れ」と記録され衝突が原因だと分からなくなる"
status: failed
priority: 3
dependencies: []
retries: 3
note: "失敗回数が上限(3)に達した。最後の失敗: main へのマージが衝突した(.agent/tasks/T-20260830-0808-conflict-session-timeout-mislabeled.md, CHANGELOG.md)(元: 失敗のため ready に戻す(2/3)。理由: セッションが中断され、main へのマージが衝突した(.agent/decisions/index.md, .…)"
createdAt: 2026-08-30T08:08:20.118Z
---

所属フェーズ: 4(思いつく改善すべて)。人間の確認は不要な修理として登録する。

## 症状

前回のマージが衝突したタスクは、衝突解消セッションとして同じ作業場所で再開される。
このセッションが衝突を解消しきれないまま制限時間で打ち切られると、失敗理由が
「衝突が未解消のまま終わった」ではなく単なる「時間切れ」として記録される。

その結果:

- タスクの `note` と `## 試行履歴` に事実と違う失敗理由が残る
- 次の試行に渡される申し送りが「時間切れなのでタスクを小さく割れ」という的外れな助言になる
  (本当に必要なのは「衝突を解消せよ」)
- やり直し上限に達したときの最終記録も誤った理由になる

利用上限が時間切れに隠れる `T-20260830-0621-ratelimit-hidden-by-timeout` と同じ構造
(複数の失敗種別が同時に成立するのに、分岐が排他だと仮定して先に評価した方を採用している)。

## 原因(調査済み)

`lib/supervisor.ts` の `finishTaskSession` は 3219-3272 行付近で
`mergeStuck = worktreeConflictPending(worktree)` を正しく計算している。しかし結果の分類では
`res.timedOut` の判定(3324 行付近)が `mergeStuck` の判定(3335 行付近、else 側)より
先に評価されるため、両方成立すると時間切れが勝つ。

確認済みの事実: 上記の評価順序と、`recordFailure` / `FAILURE_KIND_ADVICE` が失敗種別から
申し送り文言を決めていることをコード読解で確認済み。`timedOut` と `mergeStuck` を
組み合わせたテストが存在しないことも確認済み。
未検証の推測: 実機での再現は未実施。

## 補足

やり直し回数の増え方自体は変わらないため、成果の消失や費用の増加は起きない。
直すべきは「記録される失敗理由」と「次の試行への申し送り」である。

同じ else 分岐にある終了コード異常・ターン上限・エラー種別は `mergeStuck` より後ろにあるため
正しく分類される。利用上限は失敗として数えないため影響しない。

## 完了条件

- 衝突未解消と時間切れが同時に成立したとき、衝突を理由として記録し、衝突解消を促す申し送りを渡す
  (時間切れであったことも併せて伝わるとなおよい)
- 両方成立するケースのテストがある
- typecheck / lint / test が通る

## 試行履歴

### 試行 1(2026-08-30T08:22:33.149Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(CHANGELOG.md, lib/supervisor.ts)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 2(2026-08-30T09:14:55.178Z, Supervisor 記録: 中断復旧)

- 結果: セッションが中断され、main へのマージが衝突した(.agent/decisions/index.md, .agent/tasks/T-20260830-0808-conflict-session-timeout-mislabeled.md)
- セッションは終了処理を実行できていない。作業がコミット済み・未コミットのまま残っている可能性がある。`git log --oneline -10` と `git status` で現状を確認してから再開すること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 3(2026-08-30T09:23:22.304Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/tasks/T-20260830-0808-conflict-session-timeout-mislabeled.md, CHANGELOG.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
- 未コミット差分を `/home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0808-conflict-session-timeout-mislabeled-20260830T092322Z.patch` へ退避した(`CHANGELOG.md`, `lib/cli.test.ts`, `lib/supervisor.status.test.ts`, `lib/supervisor.test.ts`, `lib/supervisor.ts`)。復元は `git apply /home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0808-conflict-session-timeout-mislabeled-20260830T092322Z.patch`
- コミット済みの成果はブランチ `agent/conflict/T-20260830-0808-conflict-session-timeout-mislabeled-20260830T092322Z` に退避した(削除していない)
