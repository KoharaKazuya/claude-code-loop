---
title: "タスクファイルの衝突は main と同一内容 + status のみ変更で解消する"
reversibility: high
tasks: [T-20260830-0509-archive-move-overwrites-existing]
createdAt: 2026-08-30T05:44:44.679Z
---

## 判断内容

タスク T-20260830-0509-archive-move-overwrites-existing のマージ衝突(3 回目の試行)で、
タスクファイルは main(c6088ce)の内容と一字一句同一にし、`status: ready` → `completed` の
1 行だけを変更した。自分側にあった試行 2 のセッション記録(`## 試行履歴` への追記)と
完了 note は捨てた。

## 理由

- git の 3-way マージは「両側で同一の変更」と「片側だけの変更」は衝突しないが、
  末尾への追記は片側がもう片側のスーパーセットでも衝突する(git merge-file で実験確認済み)。
- main は Supervisor の機械記録でこのタスクファイルの note・retries・試行履歴末尾を
  セッション終了のたびに書き換えるため、同じ箇所に自分の記録を書くと必ず再衝突する。
  これが試行 1・2 のマージ失敗の直接原因(実装ではなく記録の書き込み位置の問題)。
- 今回は試行上限(3 回)のため、再衝突するとタスクが恒久失敗する。記録の完全さより
  マージ成立を優先した。

## 捨てた内容と代替の記録先

- 試行 2 セッション記録の事実(実装は 80d1485 でコミット済み、typecheck/lint/test 966 件通過、
  reviewer APPROVE)→ コミット ef162d7 のメッセージと本判断に記録済み。
- reviewer 検出の副作用(衝突でタスクが現役側と archive 側の両方に completed で残ると
  `ccloop status` の進捗が二重計上)→ タスク T-20260830-0531-status-progress-double-counts-conflicts
  として登録済み。
- 完了 note(frontmatter)は main 側の失敗 note のままになる。completed への status 変更と
  矛盾して見えるが、archive 行きの完了タスクなので実害はないと判断した。

## 影響範囲・教訓

セッションが自タスクのファイル末尾・note に書く内容は Supervisor の機械記録と衝突しやすい。
マージ衝突の解消セッションでは、タスクファイルは main 側の最新内容を土台にし、
status 以外の差分を持ち込まないのが安全。
