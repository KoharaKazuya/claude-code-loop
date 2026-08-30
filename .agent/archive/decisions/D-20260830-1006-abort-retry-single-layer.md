---
title: "merge --abort の再試行は同期待機を最小限にし、待機の層を 1 つに保つ"
reversibility: high
tasks: [T-20260830-0903-merge-abort-retry-racy-git]
createdAt: 2026-08-30T10:06:00.265Z
---

## 判断

`git merge --abort` の racy-git 失敗(`not uptodate`)に対する再試行を実装するにあたり、次を守る。

- `abortMerge`(lib/merge.ts)の待機は同期(`Atomics.wait`)にする。呼び出し元 `resolveMechanically`
  が同期関数で、非同期化はマージ経路全体に波及するため。
- 待機の層は呼び出し経路ごとに 1 つに保つ。非同期文脈から呼べる `selfHealGitOperationInProgress`
  (lib/supervisor.ts)は `abortMerge` を `attempts: 1` で呼び、待機は自分の非同期 `sleep` で行う。

## 理由

同期待機はイベントループ全体を止める。`abortMerge` はタスク完了時のマージ処理からも呼ばれ、
そのとき他の子セッションは動いたままなので、止める時間は短いほどよい。再試行を内外で二重に
掛けると待ち時間が掛け算で伸び、しかも伸びた分がすべて同期待機になる(実際、レビュー前の実装では
テストが `delayMs: 1` を指定しても内側の既定ポリシーが効いて 4.5 秒かかっていた)。

再試行の条件を `not uptodate` に限るのは、無関係な失敗(進行中の merge が無い等)で数秒待たない
ため。ただし racy な一時的失敗と、作業ツリーが本当に index とズレている恒久的失敗は git の
メッセージ上区別できないため、後者では wedged の確定が最大 2 秒あまり遅れる。固まった main を
放置するより遅れて確定する方が安全なので許容する。

## 検討した代替案

- マージ経路全体を非同期化して待機をすべて非同期にする: 影響範囲が大きく、今回の不具合修正に
  対して割に合わない。
- 待機なしで `update-index --refresh` だけを繰り返す: 実運用で効かなかったのが今回の発端。
  racy 状態の解消には秒境界を跨ぐ必要がある。
