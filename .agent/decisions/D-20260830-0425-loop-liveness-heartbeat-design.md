---
title: "ループ生存判定は PID 存在確認と心拍の併用にし、迷ったら「不明」と出す"
reversibility: high
tasks: [T-20260830-0342-status-loop-liveness]
createdAt: 2026-08-30T04:25:00.000Z
---

## 判断

`ccloop run` が状態ディレクトリの `runner.json` に PID・起動時刻・心拍時刻・ホスト名・心拍間隔を書き、
`ccloop status` は次の順で生死を判定する(`lib/liveness.ts` の `evaluateLoopLiveness`)。

1. 記録なし → 動いていません
2. ホスト名が不一致 → 不明(別マシン・別コンテナの状態ディレクトリでは PID が別物を指すため)
3. PID が存在しない → 動いていません(異常終了で記録だけ残ったケース)
4. 心拍が古い(しきい値 `max(心拍間隔 * 3, 5 分)`)→ 不明
5. それ以外 → 動いています

## 理由

最も避けたい誤りは「動いていないのに動いていると出す」こと。記録の有無だけでは異常終了と区別できず、
PID の存在確認だけでは PID の使い回しを排除できない。両方が揃ったときだけ「動いています」と言い、
片方でも当てにならない状況(別ホスト、心拍が途絶)では正直に「不明」と出す。

## 心拍をタイマー駆動にした理由

心拍をメインループの周回に紐づけると、探索・triage セッションが `await` で最大 `taskTimeoutMs`
(既定 40 分)ブロックする間ループ先頭へ戻らず、正常稼働中に「不明」と誤表示される。
`setInterval`(`unref()` 済み)で `idlePollMs` ごとに打つことで、ループが何を待っていても
プロセスが生きている限り心拍が続く。

## 検討した代替案

- `state.json` の `updatedAt` を心拍として流用する: 却下。`saveState` は状態が変化したときだけ
  呼ばれ、idle 待機中は更新されないため鮮度が生存を表さない。
- `/proc/<pid>` の起動時刻と突き合わせて PID 使い回しを排除する: 却下。Linux 依存が増える割に、
  心拍の鮮度と組み合わせれば実用上の誤判定は防げる。

## 影響範囲

`lib/paths.ts`(`runnerPath` 追加)、`lib/liveness.ts`(新規)、`lib/supervisor.ts`(`mainLoop` の
心拍・`StatusData.loopLiveness`・`formatStatus`)。`ccloop status --json` には `loopLiveness` が
末尾に加わるだけで既存キーは変わらない。
