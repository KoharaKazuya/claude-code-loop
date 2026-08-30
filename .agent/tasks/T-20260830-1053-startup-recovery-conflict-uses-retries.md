---
title: "起動時の回収でマージ衝突を検知したとき、衝突専用の枠ではなく通常の再試行回数を消費する"
status: ready
priority: 3
dependencies: [T-20260830-0934-startup-recovery-crash-leaves-no-trace]
retries: 0
createdAt: 2026-08-30T10:53:39.546Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので人間への確認は取らずに進めてよい。

## 何が起きているか

`D-20260830-0745-conflict-retry-separate-budget` の判断により、マージ衝突による失敗は
タスク本来の再試行回数(`retries`, 上限 `maxRetries`)ではなく衝突専用の枠
(`conflictRetries`, 上限 `maxConflictRetries`)で数えることになっている。

`finishTaskSession` 経由の通常のマージはこの通りに動いている。**しかし起動時の孤児ブランチ回収は
そうなっていない。**

調査で確定した事実(いずれも現時点の main。行番号は変わりうるので着手時に確認すること):

- 分岐の入口は `recordFailure`(`lib/supervisor.ts:1652`)。`kind === "merge-conflict"` なら
  `conflictRetries` を増やし(`:1660`)、それ以外は `retries` を増やす(`:1671`)。
  `retries` を直に書き換えている箇所は他に無い。
- `recoverOrphanBranch` は起動時に「中断されたセッションのブランチを回収したらマージが衝突した」
  ケースを正しく検出している(`lib/supervisor.ts:1343-1368`、`outcome.result === "conflict"` の分岐、
  理由文言「セッションが中断され、main へのマージが衝突した」)。
- ところがそこから呼ばれる `recordStartupRecoveryNote`(`lib/supervisor.ts:1264-1288`)は
  **`kind: "recovery"` をハードコードして** `recordFailure` に渡している(`:1280`)。
  `kind` を外から受け取る引数が無い。

結果、**現象としては通常の衝突とまったく同じなのに、この経路だけ `retries` を消費する。**
判断記録の意図と矛盾しており、衝突が続くとタスクが本来の再試行回数を使い切って `failed` に落ちる。
このリポジトリではマージ衝突で `failed` になったタスクの成果が退避ブランチに取り残される事故が
既に 3 件起きており、その事故を招く経路が 1 本残っている状態である。

## やること

1. `recordStartupRecoveryNote` に `kind: FailureKind`(既定は `"recovery"`)の引数を足す。
2. `recoverOrphanBranch` の衝突検知分岐(`lib/supervisor.ts:1348`, `:1359` の 2 箇所の呼び出し)から
   `kind: "merge-conflict"` を渡す。衝突以外の回収経路は従来どおり `"recovery"` のままにすること。
3. 回帰テストを足す。起動時の回収が衝突を検知したケースで `conflictRetries` だけが増え
   `retries` が変わらないことを検証する。`lib/supervisor.finish.test.ts:209-243`(`finishTaskSession`
   経由の同趣旨のテスト)が書き方の手本になる。
4. 利用者から見た挙動(衝突が続いたときにタスクが失敗扱いになるまでの回数)が変わるので
   `CHANGELOG.md` の「## 未リリース」に 1 行足す。

## 完了条件

起動時の回収で検知したマージ衝突が `conflictRetries` 側で数えられ、通常の再試行回数を
消費しないこと。回帰テストが入っていること。機械的検証が通ること。

## 調査済みで再確認不要な事項

- `conflictRetries` はタスクファイルの frontmatter に永続化される(`lib/supervisor.ts:150-152` 型定義、
  `:291` 読み込み、`:375` 書き込み。値が 0 のときは書かない)。実行時ファイル側ではないので
  ループ再起動でリセットされることはない。
- `recordFailure` の呼び出し元は `lib/supervisor.ts:1276`, `:1455`, `:3500` の 3 箇所のみ。
- `classifyTaskSessionResult`(`lib/supervisor.ts:3302-3372`)は `conflict` / `blocked` を
  正しく `merge-conflict` として分類している。ここは直す必要が無い。
- `recordFailure` 自体の分岐は `lib/supervisor.test.ts:1110-1177` でテスト済み。

## 補足: 別枠化そのものは効いている

`T-20260830-0829-finish-crash-leaves-no-trace` が別枠化の変更が main に入った後
(2026-08-30T09:24:29Z)にもかかわらず `retries: 3` で `failed` になっているが、これは
**当時動いていたループプロセスが起動時点の古いコードのまま動き続けていたため**と考えるのが
最も整合的である(`note` の文言が別枠化前の分岐のものと一致する)。当時のプロセスの起動時刻は
記録が残っておらず断定はできない。いずれにせよ**現行コードの通常経路は正しく動いており**、
直すべきは上記の起動時回収経路だけである。

## 注意

`recoverOrphanBranch` は依存先タスク `T-20260830-0934-startup-recovery-crash-leaves-no-trace` も
触る。衝突を避けるため依存関係で直列化してある(`D-20260830-1053-serialize-supervisor-hotspot-tasks`)。
着手時には依存先の変更が main に入っているので、行番号は必ず現物で確認し直すこと。
