---
title: "`.agent/` の自動コミットを wait 時の即時実行からタイミング集約(JIT)へ変更"
reversibility: high
createdAt: 2026-08-29T03:14:22.000Z
---

Human Review 回答の triage による状態変化(判定・closed 化)自体は従来どおり即時に行うが、
`.agent/` の git コミットは mainLoop が `wait` アクションへ落ちるたびには行わない。
コミットは「差分が実際に邪魔になる直前」(タスクセッション起動前・main へのマージ前)と、
mainLoop 終了時の `finally` に集約する。

## 背景

`.agent/` のコミットはもともと「アイドル・rate limit 待機に入る周回まで毎回コミットすると
内容を語らない定型コミットが積み上がる」ことを避ける目的で `agentDirty` フラグにより
wait 直前へ間引いていた。しかし triage は HR への回答があった直後に即座に 1 回走るため、
その結果を持って次の wait に落ちるタイミングでほぼ即座にコミットされてしまい、
「回答直後に自動コミットされる」という体感になっていた。これは意図した挙動ではない。

## 判断

wait 時の即時コミットをやめ、`.agent/` のコミットは以下のタイミングにのみ集約する。

- タスクセッション起動前(`startTaskSession` 冒頭)
- main へのマージ直前(`finishTaskSession` が `mergeAgentBranch` を呼ぶ直前。追加した)
- 起動時復旧(`recoverStartup`、孤児ブランチのマージを含む)を呼ぶ直前(`mainLoop` 冒頭。追加した)
- mainLoop 終了時の `finally`(既存、無条件)

理由: 回答直後の即コミットはそもそも意図した設計ではなく、Ctrl-C による中断前や、
次のステップ(タスク起動・マージ・起動時復旧)で差分が実際に邪魔になる前にコミットされて
いれば十分。緊急停止(Ctrl-C 2 回目、`finally` を通らない終了)で root 側 `.agent/` に
未コミットの差分が残っても、次回起動時に `recoverStartup` を呼ぶ前のコミットが拾う。

## 変更点

- `agentDirty` フラグ(mainLoop 内ローカル変数)と、`wait` アクション直前の
  `if (agentDirty) { commitAgentDir(); agentDirty = false; }` を削除した。
- `finishTaskSession` で `mergeAgentBranch(root, ...)` を呼ぶ直前に `commitAgentDir()`
  (root 側、引数省略のデフォルト)を追加した。main 側 `.agent/` に未コミットの差分が
  残ったまま `git merge --no-ff` を呼ぶと、取り込み側の変更と衝突して
  「ローカル変更の上書き」検知により `blocked` になりうるため。
- `mainLoop` が `recoverStartup(config)` を呼ぶ前にも `commitAgentDir()`(root 側)を
  追加した。`recoverStartup` は内部で孤児ブランチを `recoverOrphanBranch` 経由で
  `mergeAgentBranch(root, ...)` へマージするが、`recoverOrphanBranch` 自身が事前に
  コミットするのは worktree 側(`commitAgentDir(undefined, worktree)`)のみで、
  root 側は保護されていなかった。緊急停止で root 側 `.agent/` が未コミットのまま
  残っていると、次回起動時にこのマージが `blocked` になり孤児ブランチの回収が
  丸ごと次回 run まで遅延しうるため、`recoverStartup` の手前で root 側を
  先にコミットするようにした。

## 確認した前提

- `inputsDirty`(triage・探索の起動判定に使う HR/GOAL 変化検知)は `hashInputs()` が
  ファイル内容を直接読んで算出しており、git のコミット状態には依存しない。
  コミットを間引いても誤って dirty が残り続けたり誤検知したりすることはない。
- `commitAgentDir()` はステージ対象が無ければ早期 return する no-op 安全な実装
  (`git status --porcelain -- .agent` が空、または `git diff --cached --name-status`
  が空なら何もせず戻る)。`finally` などで無条件に呼んでも副作用は無い。

## 見送った案

- 起動前・マージ前以外の追加のコミットポイント: 上記 4 箇所で「差分が邪魔になる直前」を
  すべて押さえられているため、これ以上細かく増やす必要はないと判断した。
