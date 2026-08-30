---
title: "後始末の中断は順序入れ替えではなく起動時復旧で塞ぐ"
reversibility: high
tasks: [T-20260830-0829-finish-crash-leaves-no-trace]
createdAt: 2026-08-30T09:45:26.089Z
---

## 判断

`finishTaskSession` が worktree・ブランチを削除した後、結果の分類をする前に強制終了されると
痕跡が残らない問題を、**`finishTaskSession` の処理順序は変えず、起動時復旧
(`recoverStartupIn`)に新しい段階を足して塞ぐ**。

実行中の記録(`state.json` の `runningSessions`)は既に `phase: "finishing"` を持っていたが、
起動時は中身を検査せず無条件に捨てられていた。ここを検査して、`phase` が `finishing` の
まま残っているのにブランチも worktree も無いタスクを「後始末が中断された」として拾う。

## 理由

検討した代替は「削除より前に分類とタスクファイル更新を済ませる(順序の入れ替え)」だが、
採らなかった。分類経路の `fail()` はリトライ上限到達時に `parkTaskWorktree` を呼び、
そこで退避・worktree 削除・ブランチの退避名への改名までを行う。分類を前に出すと、
後続の削除処理が既に片付いた worktree・ブランチを相手にすることになり、
「失敗経路では worktree を残す」という既存の扱いと二重管理になる。中断への耐性を得るために
正常系の後始末を組み替える割に合わない。

起動時復旧側で塞ぐ方式は、正常系のコードに一切手を入れず、中断が起きた回の次の起動でだけ
追加の判定が走る。実行中の記録は元から中断検知のための情報なので、置き場所としても素直である。

## 誤検知を避けるための追加情報

「セッションが status を更新しなかった」を起動時に判定するには、通常経路の分類が使う
`taskFileChanged`(ブランチ上でタスクファイルが更新されたか)が要る。プロセスは既に無く
再計算もできないため、`finishTaskSession` が値を確定した直後・削除より前に、実行中の記録へ
`taskFileChanged` として書き残す。起動時はこれを見て、`true` なら記録を残さない
(セッションが進捗なり結論なりを書いており、通常経路でも失敗計上されない)。

未設定(旧バージョンが書いた記録、値の確定前に中断された記録)は不明として、記録を残す側へ倒す。
痕跡が余分に 1 件残るほうが、痕跡が消えるより安全なため。

## 影響範囲

`lib/supervisor.ts` の `RunningSessionState` / `finishTaskSession` / `recoverStartupIn`。
`StartupRecovery` に `interruptedFinishes` カウンタが増える。
`status` が `completed` / `failed` / `blocked` のタスクには触れない(セッションが自分で決着を
書けているため。特に `blocked` を `ready` へ戻すと人間の判断待ちの状態を壊す)。
