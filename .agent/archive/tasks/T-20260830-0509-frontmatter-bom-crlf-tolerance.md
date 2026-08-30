---
title: "BOM/CRLF の記録ファイルが frontmatter 未パースになりタスクが消える"
status: completed
priority: 2
retries: 0
note: "parseFrontmatter 冒頭で BOM 除去と CRLF→LF 正規化。main とのマージ衝突も解消済み"
createdAt: 2026-08-30T05:09:36.602Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので人間の確認は取らない。

## 症状

`parseFrontmatter`(`lib/frontmatter.ts:26-27`)は `text.startsWith("---\n")` で frontmatter の
開始を判定している。そのため次のファイルは frontmatter が一切パースされず、`data={}`・全文が本文
という扱いになる。

- 先頭に BOM(U+FEFF)が付いたファイル
- 改行が CRLF(`\r\n`)のファイル

実挙動を確認済み: 先頭に U+FEFF を置いた `---\nstatus: ready\n---\nbody` も、
`---\r\nstatus: ready\r\n---\r\nbody` も、いずれも `data:{}` になる。

## 何が困るか

1. **タスクがスケジューラから消える。** `taskFromFile`(`lib/supervisor.ts:264-286`)は `status` を
   読めないため `null` を返し、そのタスクファイルは一覧に載らない。警告は 1 回出るだけで、
   `ccloop status` の総数からも外れるため、人間から見ると「登録したはずのタスクが無い」状態になる。
2. **依存関係の安全装置が効かなくなる。** `depSatisfied`(`lib/supervisor.ts:1557`)は
   「一覧に見つからない依存 = 充足済み」として扱う設計(アーカイブ済み依存で永久ブロックしないための
   意図的な仕様、`lib/supervisor.test.ts:168`)。消えたタスクに依存する後続タスクは、実際には
   未完了なのに実行可能と判定されて走り出す。
3. **Human Review を閉じるとフィールドが消える。** `closeHumanReview`(`lib/supervisor.ts:4124-4132`)は
   `parseFrontmatter` の `data` に `status: closed` を足して書き戻す。未パースだと `data={}` から
   始まるため `title` / `importance` / `createdAt` が frontmatter から失われ、壊れた元テキストが
   本文に埋め込まれた形で保存される(書き込みによる恒久的なデータ破損)。

## やること

`parseFrontmatter` の冒頭で入力を正規化する(先頭 BOM の除去と CRLF→LF の変換)。正常な LF
ファイルの挙動は変えないこと。3 は 1・2 と根本原因が同じなので、正規化で自動的に解消するはず
だが、そうなることをテストで確認する。

## 完了条件

- BOM 付き・CRLF のタスクファイルが正しくパースされ、スケジューラの一覧に載ることをテストで確認する
- CRLF の Human Review ファイルを close しても `title` / `importance` / `createdAt` が保持される
  ことをテストで確認する
- `npm run` 経由の typecheck / lint / test がすべて通る
- 利用者から見て「手で書いた記録ファイルが無視されなくなる」修正なので `CHANGELOG.md` の
  「## 未リリース」に 1 行足す

## 試行履歴

### 試行 2(2026-08-30T05:30:54.891Z, セッション記録)

- 確認済みの事実: 実装は試行 1 のコミット 071c8a5 で完了済みだった。このセッションは main との
  マージ衝突(CHANGELOG.md の「## 未リリース」に双方が別の項目を追記した加算的衝突)を解消し、
  マージコミット 6a7f6ea を作成した。衝突は両方の項目を残す形で解消し、捨てた変更はない
- 確認済みの事実: マージ後の作業ツリーで `npm run typecheck` / `npm run lint` / `npm run test`
  がすべて通過(テスト 968 件、31 ファイル)。reviewer サブエージェントのレビューも指摘なしで通過
