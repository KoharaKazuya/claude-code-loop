---
title: "断念は status の新値ではなく abandonedAt マーカーで表す"
reversibility: medium
tasks: [T-20260830-1002-failed-task-abandon-flow]
createdAt: 2026-08-30T11:29:00.000Z
---

## 判断

`ccloop abandon <タスクID>` は `status` を変えず、タスク frontmatter に `abandonedAt`(ISO 日時)を
記録する。`status` は `failed` のまま。要対応一覧からの除外は `formatStatus` 側のフィルタ、
アーカイブ退避は `rotate()` の判定条件追加で実現する。

## 理由

- `status` の有効値に `abandoned` を足すと、バリデーション・プロンプトの説明・Supervisor の遷移処理・
  集計の全箇所に波及する。マーカー方式は 3 箇所(`Task` interface / `taskFromFile` / `taskFrontmatter`)と
  表示・rotate の判定だけで済む。
- `completed` への書き換えは進捗率の分子を歪めるため採らない。

## 影響範囲(受容したもの)

- **要対応からは即座に消えるが、`ccloop status` 冒頭の `✖ failed N` の集計には rotate されるまで残る。**
  一覧と件数が一時的に食い違うが、rotate は各ループ周回で走るため短時間で解消する。集計側まで
  フィルタを広げると進捗率の分母の意味が変わるため、今回は表示の除外に留めた。
- **rotate 後、断念タスクは進捗率の分母からも消える**(`archivedCompletedCount` は completed のみ集計)。
  completed が分母・分子に残り続けるのと非対称だが、断念は「もうやらないと決めた作業」であり
  分母に数え続ける意味が薄いと判断した。

## 関連する既知の穴(別タスク化済み)

- `saveTask` は `Task` 型に無い frontmatter フィールドを落とす。実際に abandon 実行時、対象ファイルの
  `updatedAt` が消えた(retry も同じ)。→ T-20260830-1132-task-frontmatter-unknown-fields-dropped
- worktree 内から `ccloop` を実行するとリポジトリ本体の `.agent/` を操作する。
  → T-20260830-1132-ccloop-in-worktree-targets-main-agent-dir
