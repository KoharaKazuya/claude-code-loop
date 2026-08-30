---
title: "二重起動ガードは heartbeat-stale でも拒否し、判定不能なときは許可する"
reversibility: high
tasks: [T-20260830-0443-double-run-guard]
createdAt: 2026-08-30T04:53:25.323Z
---

## 判断内容

`ccloop run` の起動時ガード(`evaluateStartupGuard`)の判定を、`LoopLiveness` の variant ごとに次のとおりとした。

- `running` / `unknown/heartbeat-stale` → **拒否**
- `stopped/no-record` / `stopped/process-gone` → 許可(process-gone は警告のみ)
- `unknown/record-unreadable` / `unknown/foreign-host` → 許可(警告のみ)

逃げ道として `ccloop run --force` を用意した。

## 理由

誤りの代償が非対称である。許可を誤ると先発プロセスの `state.runningSessions` が
`recoverStartupIn` に空へ書き戻され、走っているセッションの追跡情報が失われる(復旧が難しい)。
一方、拒否を誤っても人間が状況を確認して起動し直せばよく、`--force` もある。よって
「判定できるが疑わしい」場合は拒否側へ倒す。

`heartbeat-stale` は PID が存在し、Linux では起動時刻トークンの照合も通っている状態なので、
「同じプロセスが生きているが心拍だけ止まっている」可能性を排除できない。したがって拒否する。

ただし `record-unreadable` と `foreign-host` は**先発の生死そのものが判定できない**ケースであり、
性質が違う。ここで拒否すると、記録ファイルが壊れただけ・別ホストの記録が残っただけで
ループを二度と起動できなくなる(自力で復旧できない詰み)。判定不能は許可側へ倒す。

## 検討した代替案

- 拒否は `running` のみにする: `heartbeat-stale` の実体は多くの場合「生きている先発」であり、
  最も守りたいケースを取りこぼす。
- 判定不能(unreadable / foreign-host)も拒否する: 詰みを生むため却下。
- ロックファイル(flock)で排他する: 生存記録という既存の仕組みで足りるうえ、
  異常終了時のロック残骸という別の詰みを生むため採らなかった。

## 影響範囲

`mainLoop` は先頭でガードを評価し、拒否時は `generateSettings` / `touchRunnerRecord` /
`recoverStartup` のいずれも呼ばずに `process.exitCode = 1` で戻る。状態は一切書き換わらない。
