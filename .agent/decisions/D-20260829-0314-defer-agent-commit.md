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
- 孤児ブランチのマージ直前(`recoverOrphanBranch`。既存)
- mainLoop 起動直後(既存)
- mainLoop 終了時の `finally`(既存、無条件)

理由: 回答直後の即コミットはそもそも意図した設計ではなく、Ctrl-C による中断前や、
次のステップ(タスク起動・マージ)で差分が実際に邪魔になる前にコミットされていれば十分。
緊急停止(Ctrl-C 2 回目)で未コミットの差分が残っても、次回起動時の
起動直後コミット(`mainLoop` 冒頭)が拾う。

## 変更点

- `agentDirty` フラグ(mainLoop 内ローカル変数)と、`wait` アクション直前の
  `if (agentDirty) { commitAgentDir(); agentDirty = false; }` を削除した。
- `finishTaskSession` で `mergeAgentBranch(root, ...)` を呼ぶ直前に `commitAgentDir()`
  (root 側、引数省略のデフォルト)を追加した。main 側 `.agent/` に未コミットの差分が
  残ったまま `git merge --no-ff` を呼ぶと、取り込み側の変更と衝突して
  「ローカル変更の上書き」検知により `blocked` になりうるため。

## 確認した前提

- `inputsDirty`(triage・探索の起動判定に使う HR/GOAL 変化検知)は `hashInputs()` が
  ファイル内容を直接読んで算出しており、git のコミット状態には依存しない。
  コミットを間引いても誤って dirty が残り続けたり誤検知したりすることはない。
- `commitAgentDir()` はステージ対象が無ければ早期 return する no-op 安全な実装
  (`git status --porcelain -- .agent` が空、または `git diff --cached --name-status`
  が空なら何もせず戻る)。`finally` などで無条件に呼んでも副作用は無い。

## 見送った案

- 起動前・マージ前以外の追加のコミットポイント: 上記 5 箇所で「差分が邪魔になる直前」を
  すべて押さえられているため、これ以上細かく増やす必要はないと判断した。
