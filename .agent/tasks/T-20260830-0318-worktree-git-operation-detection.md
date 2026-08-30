---
title: "worktree 側の git 操作中断の検出範囲を揃える"
status: ready
priority: 4
dependencies: []
retries: 0
createdAt: 2026-08-30T03:18:17.730Z
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
