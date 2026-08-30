---
title: "決定の一覧に載らない記録があり、人間の承認を素通りしてしまう"
status: ready
priority: 3
dependencies: []
retries: 1
note: "失敗のため ready に戻す(1/3)。理由: main へのマージが衝突した(.agent/decisions/index.md)(元: -)"
createdAt: 2026-08-30T08:10:03.708Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので人間への確認は取らずに進めてよい。

## 何が起きているか

`.agent/decisions/index.md` は「人間がチェックを付けた決定だけをアーカイブへ移す」という
承認の導線の中心にあるファイルである。しかし決定記録ファイル(`D-*.md`)を作った
セッションが index.md への追記を忘れると、その決定は**一覧に一度も現れないまま**になる。
人間はチェックを付ける機会が無く、承認の仕組みを素通りする。

2026-08-30 時点で `.agent/decisions/` に未掲載の記録が 9 件ある(以下は発見時点の一覧。
着手時には増減しているはずなので、必ず実物を数え直すこと):

- D-20260830-0435-conflict-resume-ignores-snooze
- D-20260830-0453-startup-guard-refusal-policy
- D-20260830-0523-archive-conflict-skip-not-rename
- D-20260830-0531-changelog-merge-keep-both-entries
- D-20260830-0544-task-file-conflict-match-main
- D-20260830-0621-foreground-run-is-the-supported-usage
- D-20260830-0622-init-conflict-no-rollback
- D-20260830-0749-doctor-auth-check-design
- D-20260830-0752-salvage-failure-keeps-worktree

未掲載を機械的に洗い出すには、`.agent/decisions/` の `D-*.md` それぞれについて
ファイル名(拡張子を除いた ID)が index.md 内に現れるかを見ればよい。

## なぜ起きるのか(仮説。裏を取ること)

index.md への追記が**セッションの手作業に委ねられている**ためと考えられる。決定記録を書く
手順(`lib/prompt/PROMPT.md` の「記録ファイルの形式」節)は `D-*.md` の作成しか求めておらず、
index.md への追記を明示していない可能性がある。人間の承認という仕組みの成立が、
毎回セッションが忘れないことに依存している状態である。

## やること

1. 上の仮説を裏取りする。`lib/prompt/PROMPT.md` と `.claude/CLAUDE.md` が index.md への
   追記を求めているかを確認する。求めていないなら、それが原因である。
2. **取りこぼしを機械的に塞ぐ**。手順書に一文足すだけでは同じ忘れが再発するので、
   仕組みで担保することを優先する。案は複数ありうる:
   - `ccloop status` が未掲載の決定を「要対応」として出す(既に未承認決定の件数を出す
     仕組みがあるので、そこへ寄せられる可能性がある)
   - Supervisor が `.agent/` を自動コミットするタイミングで未掲載分を index.md へ
     追記する(タイトルは記録ファイルの frontmatter の `title` から取れる)
   どれを選ぶかは実装時に判断し、理由を `.agent/decisions/` に記録する。
   なお index.md は追記が並走しやすいファイルだが、その衝突は既に機械的解決の対象
   (`lib/merge.ts` の `classifyConflicts`)なので、自動追記を選んでも衝突は増えない。
3. 現時点で未掲載になっている分を index.md へ追記して解消する。並び順は既存の慣習
   (ID の降順)に合わせ、チェックは未チェック `[ ]` で入れる。
4. テストを足す。未掲載の検出、または自動追記のどちらを選んだ場合でも、その挙動を
   自動で確かめられる形にする。
5. 利用者から見た挙動が変わる場合は `CHANGELOG.md` の「## 未リリース」に 1 行足す
   (`ccloop status` の表示が変わる案を選んだ場合は該当する)。

## 完了条件

決定記録を作ったのに一覧へ載らない状態が、セッションの注意力に頼らず防がれていること。
現時点の未掲載分が解消されていること。機械的検証が通ること。

## 関連

- 承認・アーカイブの仕組みそのものは `D-20260830-0209-decisions-index-approval-archive` の判断による。
- index.md の衝突の機械的解決は `D-20260830-0221-decisions-index-mechanical-merge` の判断による。

## 試行履歴

### 試行 1(2026-08-30T09:53:02.573Z, Supervisor 記録: マージ衝突)

- 結果: main へのマージが衝突した(.agent/decisions/index.md)
- このタスクのブランチを main へ統合できなかった。次の試行は衝突が再現した状態の worktree で起動される。`git status` で衝突ファイルを確認し、解消してコミットすることから始めること
- この記録は機械的検出のみで、失敗原因の分析ではない
