---
title: "探索セッションの瞬時クラッシュは crash-backoff の対象に含めない"
reversibility: high
tasks: [T-20260830-0337-explore-session-crash-detection]
createdAt: 2026-08-30T04:10:00.000Z
---

## 判断

`fastCrashStreak`(瞬時クラッシュの連続回数)の更新対象は、これまでどおりタスクセッション
(`finishTaskSession`)と crash-backoff 待機明け(`mainLoop`)の 2 か所に限る。
`runExploreSession` は対象に含めない。実装は変更せず、理由を `lib/supervisor.ts` の
`fastCrashStreak` 宣言コメントに明記した。

## 理由

一次証拠(導入コミット 284e220 / 38a587f のメッセージ、`.agent/decisions/`、`docs/architecture.md`、
コード内コメント)のいずれにも「探索を対象外にする理由」を述べた記述は無く、当初の意図は
文書からは確定できなかった。そこで挙動を追い、現在の設計としてどちらが正しいかで判断した。

1. **含めても効かない。** crash-backoff(`scheduler.ts` 優先度 5)の発火条件は
   `fastCrashStreak >= 3 && runnableTaskIds.length > 0 && free > 0`。探索しか走らない状況とは
   実行可能タスクが 0 件の状況であり、加算しても抑制分岐に入らない。
2. **そもそも空回りしない。** 探索が瞬時クラッシュしても `runExploreSession` は開始時に
   `lastExploreAt` を、終了時に入力ハッシュ(`inputsHash` / `goalHash` / `answeredKeys`)を
   更新する。加えて `mainLoop` が `mainChangedSinceExplore = false` にする。結果として次周回は
   `dirty` も `neverExplored` も false になり探索条件が成立せず、ループは idle-exit
   (スヌーズ中タスクがあれば idle 待機)へ落ちる。無限に速く回る経路は存在しない。
   クラッシュ自体は `✖ 探索セッションが異常終了 (exitCode=…)` としてログに出るため、
   利用者から不可視にもならない。
3. **含めると害がある。** `fastCrashStreak` は停止分岐(`scheduler.ts` 優先度 1)でも読まれ、
   高いままだと停止前の衝突解消セッションの起動を諦める。探索固有の失敗を数えると、
   タスクセッションが健全でもタスク起動と衝突解消が抑制される誤検知になる。

## 検討した代替案

- **探索も加算する**: 上記 1 により効果が無く、3 の誤検知だけが残るため採らない。
- **crash-backoff の発火条件から `runnableTaskIds.length > 0` を外す**: 停止条件(利用者から見た
  `ccloop run` の挙動)の変更にあたり、タスクの制約で禁じられている。かつ 2 のとおり
  塞ぐべき空回りが存在しないため、変更する動機も無い。

## 影響範囲

実装の挙動変更なし。`lib/supervisor.ts` のコメントと `lib/scheduler.test.ts` のテスト 1 件
(実行可能タスクが無ければ streak が高くても crash-backoff が発火しないことの固定)のみ。

## 付随して見つかった別の欠陥

探索が異常終了しても入力ハッシュを「確認済み」として更新してしまうため、人間が書いた
GOAL の変更や Human Review の回答が、実際には読まれないまま消費される経路がある。
本判断の対象外として別タスク `T-20260830-0413-explore-crash-input-hash` に切り出した。
