---
title: "ターン上限で打ち切られたセッションが失敗として数えられない"
status: ready
priority: 2
retries: 0
createdAt: 2026-08-30T05:37:00.000Z
---

所属フェーズ: 4(思いつく改善すべて)。これは仕様の選択ではなく壊れているものの修理なので、
人間への確認は取らずに進めてよい。

## 何が起きているか

Claude Code のセッションがターン数上限(`--max-turns`)に達して打ち切られると、CLI は
**終了コード 0** で終わり、結果 JSON に `"is_error": true, "subtype": "error_max_turns",
"terminal_reason": "max_turns"` を出す(実機の claude CLI v2.1.220 で実測確認済み)。

ccloop 側はこの `is_error` / `subtype` を `metrics.jsonl` へ記録するだけで
(`lib/supervisor.ts:2163`)、セッション結果の分類には一切使っていない。
`is_error` / `isError` / `subtype` の参照箇所はコードベース全体でこの 1 箇所と型定義のみである。

`finishTaskSession` の分類ブロック(`lib/supervisor.ts:3094-3126`)は
`timedOut` → `rateLimited` → マージ結果 → `exitCode !== 0` → `!taskFileChanged && statusUnchanged`
の順にしか見ないため、ターン上限での打ち切りは `exitCode === 0` を通過し、
セッションがタスクファイルに何か書いていれば(`## 試行履歴` の追記・`note` の更新など)
最後の安全網もすり抜けて `logFinalStatus()` に落ちる。つまり **`fail()` が呼ばれない**。

## 実害

- `retries` が加算されないため、毎回ターン上限に達するタスクは `maxRetries` に到達せず
  `failed` にもならない。`ready` のまま何度でも選ばれ続け、時間と費用を使い続ける。
  時間切れ(タイムアウト)は 3 回で失敗になり人間の目に触れるが、ターン上限はこの安全網の
  外側にあり、いつまでも人間に見えない。
- 打ち切られた中途半端な作業が「異常なし」として扱われる。タスクファイルが
  `completed` に書き換わっていた場合(上限直前に status だけ更新して力尽きた場合)は
  未完了のまま完了として記録される。
- 気づく手段が `metrics.jsonl` の `isError` を自分で掘ることしかない。

## やること

1. セッション結果に結果 JSON の `is_error` / `subtype` を持ち上げ、`finishTaskSession` の
   分類で「ターン上限による打ち切り」を失敗として扱う。既存の `fail(理由, 種別)` の作法に
   合わせること(種別の文字列は既存の `timeout` / `crash` / `no-status-update` などに倣って
   新設する)。判定順序には意味があるとコメントにあるので、どこに挿すかを考えて入れる。
2. 失敗の理由文言は、時間切れ(`タイムアウト`)と区別できる表現にする。人間が
   `ccloop status` や `## 試行履歴` を見たときに「ターン数の上限で打ち切られた」と分かること。
3. `exitCode === 0` かつ `is_error: true` になる終了理由は `error_max_turns` 以外にもありうる。
   subtype で分岐しきれない場合は「`is_error: true` は失敗」を既定にしてよいが、その場合は
   レートリミット判定(`rateLimited`)より後ろに置き、レートリミットが失敗として数えられない
   現在の設計(`lib/supervisor.ts:3097-3100`)を壊さないこと。`lib/supervisor.ts:2058` の
   コメントが「成功扱いの is_error: true」に言及しているので、その前提が何だったかを
   確認してから決め、判断を `.agent/decisions/` に残す。
4. `lib/supervisor.finish.test.ts` にテストを足す。既存の成功ケース(a)(167-198 行付近)が
   `stdout: ""` で成功判定される構造なので、それを壊さずにターン上限のケースを追加する。
5. 利用者から見た挙動が変わるので `CHANGELOG.md` の「## 未リリース」に 1 行足す。

## 関連

`HR-20260830-0429-topic-oversized-task-timeout`(回答待ち)は**時間切れ**が 3 回続く
タスクの扱いを変えるかという別の話である。こちらはそもそも失敗として数えられていないという
安全網の穴なので、その回答を待たずに直してよい。ただし失敗として数えるようになると、
ターン上限のタスクも 3 回で `failed` になる。あの HR の議論対象に含まれてくる点は
実装後に OVERVIEW へ書き添えること。

## 試行履歴
