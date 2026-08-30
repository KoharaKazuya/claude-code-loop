---
title: "worktree 側の git 操作中断の検出範囲を揃える"
status: completed
priority: 4
dependencies: []
retries: 0
note: "worktree 側 5 箇所を worktreeConflictPending へ統一。main 側 2 箇所は merge 固有のため据え置き"
createdAt: 2026-08-30T03:18:17.730Z
updatedAt: 2026-08-30T03:35:41.997Z
---

所属フェーズ: 現在フェーズ内の不具合修理。利用者から見た正常時の挙動は変わらないため
人間の確認は不要(`.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` の
「確認を取らない」側)。

## 目的

worktree 側で「git 操作が中断されたまま残っているか」を判定している箇所が、
リポジトリ本体側の判定より狭く、かつ判定不能時の安全側倒しも効いていない。揃えるべきか調べ、
揃えるのが妥当なら揃える。

## 現状(確認済みの事実)

- `lib/worktree.ts` には判定関数が 2 つある。
  - `mergeInProgress`(186 行付近): MERGE_HEAD のみを見る
  - `gitOperationInProgress`(196 行付近): MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD /
    BISECT_LOG / rebase-merge / rebase-apply を見る
- `lib/supervisor.ts` には判定不能を「進行中でない」に倒す `mergeInProgressSafe`(1058 行付近)もある。
- 使い分けが揃っていない。
  - リポジトリ本体側(`commitAgentDir` 665 行、`mainLoop` 3206/3213 行、2826 行)は
    `gitOperationInProgress`
  - 復旧系(1083 / 1175 / 1277 / 1612 行)は `mergeInProgressSafe`
  - セッション起動時の衝突解消判定(2626 行 `resuming`)、終了時の判定(2885 行 `mergeStuck`)、
    3992 行は素の `mergeInProgress`

## 完了条件

- 3 箇所(2626 / 2885 / 3992 行付近)それぞれについて、次のどちらかに決着している。
  - 広い判定(`gitOperationInProgress` 相当)と例外の安全側倒しへ揃える
  - 現状のままが正しいと判断する。その場合はなぜ狭い判定でよいのかをコードコメントとして残す
- 判断の根拠を `.agent/decisions/` に記録する(揃えた場合・据え置いた場合のどちらでも)。
- 変更した場合は該当分岐のテストを `lib/supervisor.test.ts` に足す。
- `npm run typecheck` / `npm run lint` / `npm test` が通ること。

## 注意

`resuming` / `mergeStuck` の判定を広げると、衝突解消セッションとして再開される条件が変わる。
通常フローでは worktree に merge 以外の中断状態は生まれない想定なので影響は限定的だが、
挙動が変わる方向の変更であることを意識し、判断を記録に残すこと。

## 試行履歴

### 試行 1(2026-08-30T03:35:41.997Z, セッション記録)

- 確認済みの事実: 3 箇所を広げるだけでは不整合が残ることが判明したため、worktree 側 5 箇所へ拡張して
  統一した。判定は同一ライフサイクルの各段階(残す = `finishTaskSession` の `mergeStuck` /
  起動時に保持する = `recoverOrphanBranch` / 再開対象に選ぶ = `selectConflictResumable` の
  `hasConflict` / 再開指示を注入する = `startTaskSession` の `resuming` / status 表示 =
  `collectPendingConflicts`)に散っており、一部だけ広げると「worktree は残されたのに再開対象として
  選ばれない」不整合が生まれる。タスク記述が挙げていた `mergeInProgressSafe` の 2 箇所のうち
  1176 / 1613 行は worktree 対象だったため統一対象に含めた。
- 確認済みの事実: 新ヘルパー `worktreeConflictPending`(`gitOperationInProgress` + 例外時 false)を
  `lib/supervisor.ts` に追加。main 側の 2 箇所(`abortInterruptedAutoMerge` 1106 行付近、
  `recoverStartupIn` 1300 行付近)は `MERGE_HEAD` の中身を読んで agent 由来か人間のマージかを
  見分ける merge 固有処理のため `mergeInProgressSafe` のまま据え置いた。
- 確認済みの事実: 判定を広げたため `conflictResolutionSection` の merge 前提の文言 2 行を
  操作中立な表現へ変更した。`collectPendingConflicts` の内側の try/catch は述語が例外を
  投げなくなったため削除(外側は維持)。
- 確認済みの事実: `lib/supervisor.test.ts` にテスト K(実 git で CHERRY_PICK_HEAD を作り、
  `mergeInProgress` が false でも保持されることを検証)とテスト L(非 git ディレクトリで
  例外を投げず false)を追加。`npm run typecheck` / `npm run lint` / `npm test`(811 件)すべて成功。
- 確認済みの事実: コミット d95551f。判断は
  `.agent/decisions/D-20260830-0333-worktree-conflict-predicate-unification.md` に、
  横断的な不変条件は `docs/architecture.md` に記録した。
- 未検証の推測: タスク記述の「通常フローでは worktree に merge 以外の中断状態は生まれない想定」は、
  権限 deny リストが cherry-pick / revert を禁じていないため保証されていないと判断した。
  実際にセッションが cherry-pick を中断したまま終了した事例は観測していない。
