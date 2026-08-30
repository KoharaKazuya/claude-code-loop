---
title: "decisions/index.md のマージ衝突を 3-way マージで機械的に解決する"
reversibility: high
tasks: [T-20260830-0212-decisions-index-merge-conflict]
createdAt: 2026-08-30T02:21:00.000Z
---

## 判断内容

`.agent/decisions/index.md` の衝突を `lib/merge.ts` の `classifyConflicts` で own-task-file と同様の
「機械的に解決可能」に分類し、`resolveMechanically` が 3-way マージで解決するようにした。
own-task-file と index.md が同時に衝突しても機械的に解決する(両者は独立に解決できるため)。

パース・整形ロジックは `lib/decisions-index.ts` に切り出し、`lib/rotate.ts` と共有する。

## 3-way マージの規則

- エントリは ID をキーに突き合わせる。
  - 両側にある → 採用。`checked` は OR(チェック済みを優先)、`summary` は base と異なる側を優先。
  - 片側のみ、かつ base に**ある** → もう片方で削除されたと解釈し落とす。
  - 片側のみ、かつ base に**ない** → 新規追加として採用。
- 並び順は ID 降順。
- header/footer が両側で base から別々に変更されていたら機械的解決を諦め、substantive として abort する。

## 理由

- 削除を優先するのは、rotate がアーカイブ済みエントリを index から消すため。和集合を取ると
  アーカイブ済みの決定が index に復活してしまう。
- ID 降順にするのは `rotateDecisions` のリコンサイル(`[...ids].sort().reverse()`)と同じ順序にするため。
  順序が違うと解決直後の index.md が次回 rotate で毎回書き換えられる。
- `summary` の食い違いを衝突扱いにしないのは、どちらを採っても情報が失われないため。
  逆に header/footer は人間が書いた文章なので、両側の変更を機械的に統合できず人間へ回す。

## 検討した代替案

- **単純な和集合**: 実装は簡単だが、rotate がアーカイブしたエントリが復活する。採らない。
- **常に片側(ours か theirs)を採用**: どちらかのセッションの決定が index から消える。採らない。
- **index.md をやめて decisions ディレクトリの実体から毎回生成する**: 衝突自体が消えるが、
  人間のチェック `[x]`(アーカイブ承認)の置き場が失われる。変更範囲も大きい。採らない。

## 影響範囲

`lib/merge.ts` / `lib/rotate.ts` / `lib/decisions-index.ts`(新規)。
`classifyConflicts` の戻り値は `{ kind: "mechanical"; ownTaskFile: string | null; decisionsIndex: string | null }`
に変わった。`mergeCommitMessage` の第 5 引数はオブジェクトになった。いずれも `lib/` 内のみで使われている。
