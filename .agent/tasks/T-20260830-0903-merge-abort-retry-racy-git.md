---
title: "マージ直後の巻き戻しが同一秒内の連続 git 操作で失敗し、自己修復も効かず supervisor が停止する"
status: ready
priority: 3
dependencies: []
retries: 0
createdAt: 2026-08-30T09:05:38.279Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので人間への確認は取らずに進めてよい。

## 何が起きたか

2026-08-30 08:31:36、同一秒内に main 上で「マージ abort → .agent commit → マージ成功
(HEAD 移動)→ 次のマージ開始 → conflict → abort」が直列に連続実行された。結果、git の
racy-git 挙動(ファイル mtime と index 書き込み時刻が同一秒になり stat 情報が信用できなくなる)
により `git merge --abort` が `lib/supervisor.ts` を「未保存の変更あり」と誤認して失敗した
(`error: Entry 'lib/supervisor.ts' not uptodate. Cannot merge.`)。

本線の `abortMerge`(`lib/merge.ts:261-277`)には `update-index -q --refresh` による緩和策が
あるが、同一秒バーストでは refresh 後も racy 状態が解消されず効かなかった。さらに mainLoop の
自己修復 `abortInterruptedAutoMerge`(`lib/supervisor.ts:1191-1211`)は素の `merge --abort` を
1 回試すだけで refresh もリトライも無く、失敗の直後(同一秒)に fatal 判定して supervisor が
停止した。

JS レベルの並行実行は `drainCompletedSessions` の FIFO 直列処理により構造的に不可能で、原因では
ない(調査済み)。

## 修正方針(スコープ)

1. `lib/merge.ts` の `abortMerge`: `merge --abort` が not uptodate で失敗したら約 1 秒待って
   (秒境界を跨いで racy 状態を解消してから) `update-index --refresh` → `merge --abort` を
   2〜3 回まで再試行する。
2. `lib/supervisor.ts` の `abortInterruptedAutoMerge`(1204 行付近): 素の `git merge --abort` を
   やめ、`merge.ts` の `abortMerge`(refresh + リトライ込み)を再利用して実装の重複・非対称を
   解消する。
3. mainLoop の自己修復→fatal 判定(`lib/supervisor.ts:3708-3724`): 自己修復失敗から fatal 停止
   までに短い待機+再試行を挟み、「人間の git 操作が進行中」の結論はリトライが尽きてから出す。
4. wedged ログの充実: abort に至った文脈(コンフリクト分類結果・失敗ステップ)をログに添える。
   今回のインシデントでは `resolveMechanically` のどの経路で abort に至ったか特定できなかった。
5. 回帰テスト: 「abort が 1 回失敗し再試行で成功する」ケースと、mainLoop 巡回中の自己修復パスの
   失敗ケース(既存テストは起動時復旧経路 `lib/supervisor.test.ts:4768` のみ)。

## 完了条件

上記 1〜5 が実装され、npm のテスト(該当するもの)が通ること。修正は利用者が踏んだ不具合の
修正なので、修正セッションは `CHANGELOG.md` の「## 未リリース」節へ 1 行追加すること
(このタスク登録時には CHANGELOG を触らない)。
