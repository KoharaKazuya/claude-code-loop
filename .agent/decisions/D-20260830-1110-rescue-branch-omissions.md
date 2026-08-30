---
title: "退避ブランチから取り込まなかった差分とその理由"
reversibility: high
tasks: [T-20260830-1053-rescue-finish-interrupt-recovery-work, T-20260830-0829-finish-crash-leaves-no-trace]
createdAt: 2026-08-30T11:10:21.366Z
---

## 判断

退避ブランチ `agent/conflict/T-20260830-0829-finish-crash-leaves-no-trace-20260830T101839Z` の差分のうち、
実装・テスト・判断記録・変更履歴はすべて main へ取り込んだ。取り込まなかったのは次の 1 ファイルだけである。

- `.agent/tasks/T-20260830-0829-finish-crash-leaves-no-trace.md`

ブランチ側はこれを `status: completed` / `retries: 0` に書き換えていたが、採らなかった。実際には
ブランチのマージが 3 回とも衝突し、ccloop は上限到達として `failed` を記録している。ブランチ側の値を
そのまま持ち込むと「衝突で失敗した」という運用上の事実が消える。代わりに `note` だけを
「成果は救出タスクが main へ取り込み済み」に書き換え、`status: failed` は維持した。failed からの
復帰の扱いは `T-20260830-1002-failed-task-abandon-flow` の担当範囲である。

## 当て直し時の意図的な逸脱

単純なマージではなく差分を手で当て直したため、ブランチの内容と 2 点だけ異なる。どちらも main 側が
正しい。

- `finishTaskSession` の `taskFileChangedOnBranch` の第 1 引数は `repoPaths().root` ではなく
  `ctx` 由来の `root` を使う(main で破壊的操作の対象リポジトリを `ctx.root` に統一済みのため)
- `lib/supervisor.finish.test.ts` の新規テストの `ctx` に `root: dir` を足した
  (main で `TaskSessionContext.root` が必須になっており、ブランチ側テストが追随していなかった)

上記以外に差異が無いことは、`git diff main...<branch>` と `git diff main`(当て直し後)を
テキスト比較して確認した。

## 退避パッチについて

同じ試行の作業ツリー差分として案内されていたパッチ
(`<state>/patches/T-20260830-0829-...-20260830T101839Z.patch`)は、`patches/` ディレクトリごと
存在しなかった。二次資料として突き合わせるはずだったが確認できていない。ただし一次資料である
ブランチのコミットは取り残しなく取り込めており、実装・テスト・判断記録・変更履歴は揃っている。
