---
title: "読み取り専用の git サブコマンドを禁止一覧から外す"
status: ready
priority: 3
dependencies: [T-20260830-1334-explore-assigns-conflict-metadata]
retries: 0
createdAt: 2026-08-30T14:07:09.352Z
---

所属フェーズ: 4(思いつく改善すべて)。人間の同意取得済み
(`HR-20260830-1403-topic-readonly-git-subcommands` の回答「ゆるめてよい」)。

## 目的

`lib/settings.template.json` の deny パターンが前方一致で書かれているため、意図していない
**読み取り専用のサブコマンドまで巻き添えで禁止**されている。これを、変更を伴うコマンドだけを
禁止するように狭める。

巻き添えになっている読み取り専用コマンド(deny パターン → 巻き添え):

- `Bash(git merge*)` → `git merge-base` / `git merge-tree`
- `Bash(git worktree*)` → `git worktree list`
- `Bash(git stash*)` → `git stash list` / `git stash show`

実害: ccloop 自身が `lib/worktree.ts:61`(`git worktree list --porcelain`)と
`lib/supervisor.ts:3591`(`git merge-base`)を使っているのに、その周辺を調べるセッションは
手元で同じコマンドを打てず、実機再現ができない。過去の探索セッションもこの点を
`.agent/OVERVIEW.md` に制約として記録している。

## 対象

3 箇所を**必ず同時に**直す(deny 一覧と PROMPT.md の一致は `lib/deny-consistency.test.ts` が
機械検証しているため、片方だけ直すとテストが落ちる)。

- `lib/settings.template.json` の `permissions.deny`
- `lib/prompt/PROMPT.md` の「Bash 実行の権限制約」節(deny 一覧の記述)。同節の allow の説明も
  実態に合わせる。冒頭「実行環境(worktree と自動マージ)」節にもブランチ操作の禁止の記述がある
  ので、食い違いが出ないか確認する
- `lib/deny-consistency.test.ts`(検証ロジックが 1 コマンド 1 パターン前提なら追従が必要)

`.agent/claude-settings.json` は**編集しない**(セッションが自分の権限を広げる操作に当たる)。
ここで直すのはツール本体が配る既定値である。

## 進め方の要点

- 狭め方の一例: `"Bash(git merge*)"` を `"Bash(git merge)"` と `"Bash(git merge *)"` の 2 本に
  分ける(空白を要求することで `merge-base` / `merge-tree` を外す)。worktree / stash も同様。
  ただし Claude Code の permission パターンの実際のマッチ規則を確認した上で採用すること。
  この方式が使えない場合は、サブコマンドを列挙して deny する形でもよい。
- **緩めすぎないことが本題の半分である。** `git merge <branch>` / `git merge --abort` /
  `git worktree add` / `git worktree remove` / `git stash` / `git stash pop` などの変更を伴う形が
  引き続き禁止されることを、テストで明示的に固めること。
- `git checkout` / `git switch` / `git reset` / `git clean` / `git push` / `git rebase` は今回の
  対象外(読み取り専用の兄弟サブコマンドが無い、または外部に出る)。触らない。

## 完了条件

- 上記 3 ファイルが揃って更新され、`npm test` / lint / typecheck が通る
- 読み取り専用の 5 コマンドが通り、変更を伴う形が引き続き禁止されることをテストが検証している
- `CHANGELOG.md` の「## 未リリース」節に利用者の言葉で 1 行追加(挙動の変更に当たる)
