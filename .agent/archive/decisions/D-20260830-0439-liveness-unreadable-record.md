---
title: "生存記録の壊れた JSON・型不正は「読めなかった」側に寄せる"
reversibility: high
tasks: [T-20260830-0424-liveness-unreadable-record]
createdAt: 2026-08-30T04:39:23.609Z
---

## 判断内容

`lib/liveness.ts` の `readRunnerRecord` の戻り値を `RunnerRecord | null` から判別共用体
`RunnerRecordRead`(`{kind:"record"}` / `{kind:"absent"}` / `{kind:"unreadable", detail}`)へ変え、
ファイルが無い(ENOENT)場合だけを `absent`(= `stopped/no-record`「動いていません」)とした。

**ENOENT 以外の読み取りエラー・JSON パース失敗・必須フィールドの型不正は、すべて `unreadable`
(= `unknown/record-unreadable`「不明」)に寄せた。**

## 理由

- 生存表示で最も避けたい誤りは「動いていないのに動いていると出す」ことだが、その逆(動いているのに
  動いていないと出す)も人間の判断を誤らせる。記録が判読できない状態から言えるのは「判定できない」
  だけであり、「起動していない」とは言えない。
- `writeRunnerRecord` は tmp へ書いてから rename するアトミック書き込みなので、書き込み途中の
  中途半端な JSON が観測されることは通常ない。したがって「壊れた JSON = 正常な過渡状態」とは
  みなせず、素直に異常(判定不能)として扱ってよい。
- 型不正も同じく「ファイルはあるが記録として使えない」であり、無いこととは意味が違う。

## 検討した代替案

壊れた JSON・型不正を `absent` 側に寄せる案。実装は単純になるが、「記録が壊れている」という
異常が「起動していない」という正常な状態と同じ文言に埋もれ、人間が異常に気づけない。採らなかった。

## 影響範囲

- `LoopLiveness` に `{ status: "unknown"; reason: "record-unreadable"; detail: string }` を追加。
  `ccloop status --json` の `loopLiveness` は既存フィールドを変えず variant が増えただけ。
- `evaluateLoopLiveness` の第 1 引数が `RunnerRecordRead` になった。呼び出しは
  `lib/supervisor.ts` の 1 箇所のみで、`readRunnerRecord` の結果をそのまま渡している。
