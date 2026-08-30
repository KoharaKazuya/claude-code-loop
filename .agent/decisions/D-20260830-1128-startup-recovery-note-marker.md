---
title: "起動時復旧の削除と記録の間も、state のマーカーで塞ぐ"
reversibility: high
tasks: [T-20260830-0934-startup-recovery-crash-leaves-no-trace]
createdAt: 2026-08-30T11:28:00.000Z
---

## 判断

`recoverOrphanBranch` が worktree・ブランチを畳む(削除・改名する)直前に、**これから書く予定の
記録内容そのもの**を `state.json` の `pendingRecoveryNotes` へマーカーとして保存し、記録が済んだら
消す。次回起動時、マーカーが残っていて、かつ対象ブランチも worktree も存在しなければ、
その記録を再生する(`resumeInterruptedRecoveryNotes`)。

[[D-20260830-0945-finish-interrupt-recovery-approach]] と同じ方式(正常系の順序は変えず、
state に情報を残して次回起動時に検出する)に揃えた。

## 理由

代替は「記録を削除より先に済ませる(順序の入れ替え)」だが、採らなかった。記録に載せる情報の一部
(未コミット差分の退避結果)は削除の直前に確定し、記録の本文順序(試行履歴 → 未コミット差分の記録)も
決まっている。順序を入れ替えると、記録だけ書けて削除に失敗した場合に「退避したと書いてあるのに
ブランチが残っている」という食い違いが残り、次回起動時に同じブランチが再び回収されて記録が二重になる。
マーカー方式なら、削除の前に落ちた場合はブランチ・worktree の存在から判別でき、孤児ブランチ回収に
そのまま任せられる。

マーカーに記録内容を丸ごと入れているのは、再生時に merge の結果を再計算できないため。ブランチは
既に消えており、`nothing-to-merge` だったのか成果を回収したのかは、そのときにしか分からない。

## 残る窓と、それを許容する理由

記録が書けた直後・マーカーを消す前に強制終了されると、次回起動時に同じ記録がもう一度再生される
(試行履歴が 1 件余分に増え、`retries` を 1 回余分に消費する)。これは埋めない。痕跡が余分に残る
ほうが痕跡が消えるより安全という、[[D-20260830-0945-finish-interrupt-recovery-approach]] と同じ
判断による。マーカーを消してから記録すると逆に痕跡が消える窓ができるため、どちらかに倒すしかない。

## 二重計上の防止

再生したタスク ID は `recoverStartupIn` の `handled` に入れる。入れないと、同じ中断について
後段の後始末中断検出(`interruptedFinishes`)も発火し、1 回の中断で `retries` を 2 回消費する。

## 影響範囲

`lib/supervisor.ts` の `State` / `normalizeState` / `recordStartupRecoveryNote`(戻り値が
`boolean` になった)/ `recoverOrphanBranch` / `recoverStartupIn`。`StartupRecovery` に
`resumedRecoveryNotes` カウンタが増える。マージ衝突で worktree を残す分岐は、何も破壊しないため
対象外(ブランチも worktree も残るので次回起動時に改めて回収される)。
