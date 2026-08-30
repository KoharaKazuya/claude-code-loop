---
title: "片付けの衝突で残ったタスクが進捗表示に二重計上される"
status: completed
priority: 4
dependencies: []
retries: 0
note: "進捗集計でアクティブ側と重複する ID を archive 側から除外。typecheck / lint / test 通過"
createdAt: 2026-08-30T05:31:41.879Z
---

所属フェーズ: 4(思いつく改善すべて)。表示の正確さの問題なので人間の確認は取らない。

## 症状

`ccloop status` の進捗表示は、アクティブ側 `.agent/tasks/` の completed 件数と
`.agent/archive/tasks/` の completed 件数を別々に数えて足している
(`lib/supervisor.ts:4676` と `lib/supervisor.ts:4770`, `4780-4781`)。

片付け(`rotate`)が移動先の同名ファイルとの衝突で移動を見送ると、同じ ID のタスクファイルが
アクティブ側と archive 側の両方に `status: completed` で残る。このとき分子・分母の両方で
同一タスクが二重に数えられ、実タスク数が変わっていないのに「完了 15/15」が「完了 16/16」と
表示される。

衝突時にスキップする挙動は `D-20260830-0523-archive-conflict-skip-not-rename` の判断によるもので、
記録を失わないことを優先した結果である。この二重計上はその副作用。

## やること

進捗の集計で、アクティブ側と archive 側に同じ ID がある場合に 1 件として数える
(ID で重複排除してから数える)。データ破損には繋がらないため、直すのは表示の集計だけでよい。

## 完了条件

- 同じ ID のタスクがアクティブ側と archive 側の両方に completed で存在する状態で、進捗表示の
  分子・分母がそれぞれ 1 件としてのみ数えられることをテストで確認する
- 衝突が無い通常のケースで、これまでと同じ件数が表示されることを既存テストで確認する
- `npm run` 経由の typecheck / lint / test がすべて通る
- 利用者から見た表示が変わるため、`CHANGELOG.md` の「## 未リリース」に 1 行足す
