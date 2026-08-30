---
title: "conflictRetries を共通ルールのタスク形式に追記する"
status: completed
priority: 3
dependencies: []
conflicts: [T-20260830-1407-narrow-readonly-git-deny-patterns]
retries: 0
createdAt: 2026-08-30T14:30:27.431Z
---

所属フェーズ: 4(思いつく改善すべて)。実装済み機能に対する共通ルールの記載漏れの解消であり、
利用者から見た挙動は変わらないため事前の確認(Human Review)は不要な範囲。

## 目的

ccloop がタスクファイルに書き込む `conflictRetries` フィールドが、自律セッションへ注入される
共通ルール `lib/prompt/PROMPT.md` のタスクファイル形式の説明に載っていない。載せて、`retries` と
同じ「ccloop が管理するので触らない」扱いであることを明示する。

## 現状(確認済みの事実)

- `lib/supervisor.ts:168` に `Task` の `conflictRetries: number` がある。
- `lib/supervisor.ts:2084-2091` の `recordFailure` は、マージ衝突(`kind === "merge-conflict"`)のとき
  `conflictRetries` を加算し、上限未満なら `ready` に戻して note に
  `マージ衝突が続くため ready に戻す(N/上限)` を書く。`retries` とは独立した枠である。
- `lib/supervisor.ts:547` の書き出しは `conflictRetries` が 0 以外のときだけキーを出力する。
  つまり衝突を経験したタスクのファイルには実際にこのフィールドが現れる
  (例: `.agent/archive/tasks/T-20260830-1334-explore-assigns-conflict-metadata.md`)。
- `lib/supervisor.ts:332` の `KNOWN_TASK_FIELDS` には `conflictRetries` が含まれており、
  `lib/supervisor.ts:5110-5111`(`ccloop list` の行表示)と `--json` 出力にも出る。
  `lib/help.ts:110-111`(`ccloop retry` のヘルプ)も「retries と conflictRetries を 0 にする」と書いている。
  `README.md` / `docs/architecture.md` も `maxConflictRetries` と衝突解消セッションを説明済み。
- 追随できていないのは `lib/prompt/PROMPT.md` だけである。
  - `lib/prompt/PROMPT.md:255-268` のタスク frontmatter 例に `conflictRetries` が無い。
  - `lib/prompt/PROMPT.md:295` は「ccloop が管理する `retries` は変更しない。」とだけ書いており、
    `conflictRetries` に言及がない。

## 実害の筋道

衝突再試行中のタスクを担当したセッションは、自分のタスクファイルに `conflictRetries: N` が
書かれているのを見る。共通ルールに説明が無く、かつ「変更しない」と名指しされているのが `retries`
だけなので、「書かれていないフィールドは触ってよい」と解釈して削除・リセットしうる。そうなると
衝突再試行の回数が巻き戻り、上限による打ち切り(`failed` への移行)が効かなくなる。

## 完了条件

- `lib/prompt/PROMPT.md` のタスク frontmatter の説明に `conflictRetries` が載っており、
  「マージ衝突による再試行の回数で、ccloop が管理するため変更しない」ことが分かる。
  書き方は既存の `retries` の扱いに揃える(frontmatter 例への追加と、末尾の注意書きの
  どちらで表現するかは実装者の判断でよい。両方に書く必要はない)。
- 併せて、`conflictRetries` が「0 のときはファイルに書き出されない」ことに触れておくと、
  フィールドが見えないタスクとの差を誤解しなくて済む(任意)。
- `npm test` / lint / typecheck が通る。`lib/prompt/PROMPT.md` の文言を検証するテスト
  (`lib/deny-consistency.test.ts` のようなプロンプト資産の突き合わせ)が存在する場合は、
  それも通ること。
- 利用者から見た挙動は変わらないため `CHANGELOG.md` には追記しない。

## 注意

- `lib/prompt/PROMPT.md` は `T-20260830-1407-narrow-readonly-git-deny-patterns` も
  「Bash 実行の権限制約」節を触る可能性が高いため `conflicts` を設定済み。同時実行はされない。
- 記載を増やしすぎない。既存の箇条書きの粒度に合わせ、1〜2 行で足りる。
