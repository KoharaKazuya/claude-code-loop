---
title: "worktree 側の中断 git 操作の判定を 1 つの述語へ統一する"
reversibility: high
tasks: [T-20260830-0318-worktree-git-operation-detection]
createdAt: 2026-08-30T03:33:34.916Z
---

## 判断

worktree に「前回の git 操作が中断されたまま残っているか」を判定する箇所を、
`worktreeConflictPending`(広い判定 = merge / cherry-pick / revert / rebase / bisect、
判定不能時は false)へ統一した。リポジトリ本体(main)側の判定は `mergeInProgressSafe`
(MERGE_HEAD のみ)のまま据え置いた。

## 理由

worktree 側の判定は、同じライフサイクルの各段階に散っていた:

- 残す: `finishTaskSession` の `mergeStuck`
- 起動時に保持する: `recoverOrphanBranch`
- 再開対象に選ぶ: `selectConflictResumable` の `hasConflict`、`startTaskSession` の `resuming`
- status に表示する: `collectPendingConflicts`

これらは同一の状態を指していなければならない。判定がずれると、worktree は残されたのに
再開対象として選ばれない(あるいはその逆で、保持されるべき worktree が統合処理へ進んで
破棄される)状態が生まれる。したがって「3 箇所だけ広げる」は選べず、worktree 側は
全箇所を同時に揃える必要があった。

広い判定を選んだのは、セッションの権限 deny リストが merge / rebase / reset 等を禁じている
一方、cherry-pick と revert は禁じていないためである。セッションがこれらを中断したまま
終了する経路が実在し、そのとき狭い判定では衝突解消セッションとして再開されず、
中断状態の worktree で通常セッションが起動してしまう。

main 側を据え置いたのは、あちらが `MERGE_HEAD` の中身を読んで「Supervisor 自身の自動マージの
中断か、人間が手で始めたマージか」を見分ける処理であり、merge 固有の意味を持つため。
広げても読む先が無く、判定を広げる利得がない。

## 検討した代替案

- **現状維持(狭い判定のまま、コメントで理由を残す)**: 通常フローでは worktree に merge 以外の
  中断は生まれない、という前提に依存する。しかし cherry-pick / revert が権限上許可されている
  以上この前提は保証されておらず、破れたときの症状(中断状態のまま通常セッションが起動する)が
  分かりにくいため採らなかった。
- **例外を握りつぶさず投げたままにする**: `startTaskSession` の判定は外側に try/catch が無く、
  git が一時的に使えないだけでタスク起動そのものが落ちる。既存の `mergeInProgressSafe` が
  「判定不能は進行中でないに倒す」方針を採っているため、それに揃えた。

## 影響範囲

- 衝突解消セッションとして再開される条件が広がる(merge 以外の中断でも再開される)。
  再開セッションへ注入する `conflictResolutionSection` の文言が merge 前提だったため、
  「前回の git 操作(main とのマージなど)が中断された」という操作中立な表現へ直した。
- `collectPendingConflicts` の内側の try/catch は述語が例外を投げなくなったため削除した
  (`listWorktrees` の失敗を握りつぶす外側の try/catch は残している)。
- 回帰テストとして CHERRY_PICK_HEAD が残る worktree を実際に作り、保持されることを検証する
  テストを `lib/supervisor.test.ts` に追加した。狭い判定のままなら落ちるテストになっている。
