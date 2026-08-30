---
title: "機械的マージ解決のログ文言を実際に解決した対象に合わせる"
status: completed
priority: 4
dependencies: []
retries: 0
note: "renumbered に resolved を持たせ、ログを解決対象に応じて書き分けた。test/typecheck/lint 通過"
createdAt: 2026-08-30T03:37:51.554Z
---

所属フェーズ: 4(思いつく改善すべて)。

## 目的

自動マージが衝突を機械的に解決したとき、`ccloop run` のログが実際に解決した対象と食い違う
説明を出している。ログを事実に合わせる。

## 現状(調査で確認済み)

`resolveMechanically`(`lib/merge.ts:290-357`)は own-task-file の衝突と
`.agent/decisions/index.md` の衝突を個別に解決するが、戻り値は一律 `{ result: "renumbered" }`
で、どちらを解決したかの情報を残さない。`.agent/decisions/index.md` だけが衝突し own-task-file は
衝突しなかったケースでも `renumbered` になる(`lib/merge.test.ts:420-450` がこの挙動を明示的に
検証している)。

一方 `describeMergeOutcome`(`lib/supervisor.ts:2806-2811`)は `renumbered` を一律
「機械的に解決: タスクファイルはブランチ側を採用」と表示する。index.md だけの解決だった場合、
タスクファイルは衝突すらしていないので説明が事実と異なる。

なお `mergeCommitMessage`(`lib/merge.ts:168-206`)は `resolved.ownTaskFile` /
`resolved.decisionsIndex` を個別に見て本文を書き分けており、コミットメッセージ側は正しい。
食い違っているのはログ表示だけである。

`MergeOutcome` の型コメント(`lib/merge.ts:214-222`)も「own-task-file の衝突を機械的に解決して
マージできたことを表す」と書いており、実装の実態とずれている。

## 完了条件

- `renumbered` の結果に「何を機械的に解決したか」(own-task-file / decisions index の別)が
  残り、`describeMergeOutcome` がそれに応じた説明を出す。
- `MergeOutcome` の該当型コメントを実態に合わせて更新する。
- 解決対象の組み合わせ(own-task-file のみ / index.md のみ / 両方)それぞれでログ文言が
  正しいことを確認する回帰テストを足す。
- `npm run` 経由の test / typecheck / lint が通る。

## 制約

- `result: "renumbered"` という値そのものは改名しない。`lib/merge.ts:214-222` のコメントに
  あるとおり、この文字列は `mergeLabel` 経由でメトリクス JSONL に記録されており、過去の値との
  継続性のためにあえて残されている。追加情報はフィールドとして持たせる。
