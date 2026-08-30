---
title: "探索セッションが競合しそうなタスクに conflicts を付けるようにする"
status: completed
priority: 3
dependencies: [T-20260830-1334-task-conflict-metadata-scheduling]
retries: 0
conflictRetries: 1
note: "マージ衝突が続くため ready に戻す(1/5)。理由: main へのマージが衝突した(.agent/tasks/T-20260830-1407-narrow-readonly-git-deny-patterns.md)(元: -)"
createdAt: 2026-08-30T13:34:03.651Z
---

所属フェーズ: 4(思いつく改善すべて)。人間の同意取得済み
(`HR-20260830-1053-topic-conflict-prone-parallelism`)。

## 背景

人間の回答は「**探索セッションが競合しそうなタスクを判断し**、タスクに(依存と同じようにして)
競合のメタデータを持たせ、タスク選択時に競合を同時に実行しないようにしたい」だった。

ツール側の仕組み(`conflicts` フィールドとタスク選択)は
`T-20260830-1334-task-conflict-metadata-scheduling` が実装する。このタスクは残りの半分、
**誰がいつ `conflicts` を書くのか**をセッションへの指示として定着させる。指示が無ければ
フィールドは空のままで、仕組みは何も抑止しない。

## やること

1. `lib/prompt/PROMPT.md`(全セッションに注入される共通ルール)を更新する。
   - 「記録ファイルの形式」節のタスク frontmatter の例と説明に `conflicts` を加える。
     `dependencies` が順序の制約であるのに対し、`conflicts` は**同時に走らせない**制約であることを
     一言で書き分ける。
   - 走行中タスクのファイルを編集しない旨の記述(`lib/supervisor.ts:3314` 付近が注入する文言)は
     `priority`・`dependencies`・`status` を列挙している。`conflicts` も同じ扱いなので加える。
2. 探索セッションのプロンプト(`lib/supervisor.ts:3352` 付近の手順 2)を更新する。
   - 既存タスクの `priority`・`dependencies` の見直しと並べて、**競合しそうなタスクの組に
     `conflicts` を付ける**ことを手順に入れる。
   - 競合の判断材料(どのファイルを触る見込みか。特に変更が集中している大きなファイルを
     複数タスクが触る場合)を短く示す。長い説明は入れないこと。プロンプトは全セッションの
     コンテキストを消費する。
   - 応急処置として `dependencies` で直列化してきたやり方(`D-20260830-1053-serialize-supervisor-hotspot-tasks`)は
     `conflicts` に置き換わる。**衝突回避のためだけに `dependencies` を張らない**旨を明記する
     (依存は本当に順序が必要なときに使う)。
3. `docs/` の該当箇所を更新し、README からたどれる状態を保つ。既に
   `T-20260830-1334-task-conflict-metadata-scheduling` が書いた説明と重複させないこと。
4. 既存の ready タスクに、衝突回避目的で張られた `dependencies` が残っていれば `conflicts` へ
   置き換えるかどうかを判断する。走行中のタスクのファイルは編集しないこと。
5. 利用者から見た挙動が変わる部分があれば `CHANGELOG.md` の「## 未リリース」節に 1 行足す
   (仕組み側の 1 行が既にあるなら重複させない)。

## 完了条件

- 探索セッションが `conflicts` を付ける手順として読める指示になっていること。
- `lib/prompt/PROMPT.md` のタスク frontmatter の説明に `conflicts` があること。
- 機械的検証(`npm test` / lint / typecheck)が通ること。プロンプトの内容を固定している
  テストがあれば併せて更新する。

## 注意

- `T-20260830-1334-task-conflict-metadata-scheduling` の実装で決まった仕様(存在しない ID の扱い、
  対称性など)に説明を合わせること。着手時にそのタスクの成果と `.agent/decisions/` を読む。
- `lib/prompt/PROMPT.md` と `lib/settings.template.json` の deny 一覧の一致は
  `lib/deny-consistency.test.ts` が機械検証している。今回は deny を触らないが、
  PROMPT.md を編集するので `npm test` で確認すること。

## 試行履歴

### 試行 1(2026-08-30T14:16:43.591Z, ccloop 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/tasks/T-20260830-1407-narrow-readonly-git-deny-patterns.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
