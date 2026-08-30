---
title: "ターン上限で打ち切られたセッションが失敗として数えられない"
status: failed
priority: 2
dependencies: []
retries: 3
note: "失敗回数が上限(3)に達した。最後の失敗: main へのマージが衝突した(.agent/tasks/T-20260830-0537-max-turns-not-failure.md, CHANGELOG.md)(元: 失敗のため ready に戻す(2/3)。理由: main へのマージが衝突した(.agent/tasks/T-20260830-0537-max-turns-…)"
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

### 試行 1(2026-08-30T05:50:56.082Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(CHANGELOG.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 2(2026-08-30T06:05:53.183Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/tasks/T-20260830-0537-max-turns-not-failure.md, CHANGELOG.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない

### 試行 3(2026-08-30T06:13:27.438Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/tasks/T-20260830-0537-max-turns-not-failure.md, CHANGELOG.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
- 未コミット差分を `/home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0537-max-turns-not-failure-20260830T061327Z.patch` へ退避した(`CHANGELOG.md`, `docs/architecture.md`, `lib/config.test.ts`, `lib/config.ts`, `lib/doctor.test.ts`, `lib/doctor.ts`, `lib/hooks/worktree-create.test.ts`, `lib/hooks/worktree-create.ts`, `lib/supervisor.ts`)。復元は `git apply /home/node/.local/state/ccloop/claude-code-loop-cd26cd26/patches/T-20260830-0537-max-turns-not-failure-20260830T061327Z.patch`
- コミット済みの成果はブランチ `agent/conflict/T-20260830-0537-max-turns-not-failure-20260830T061327Z` に退避した(削除していない)
