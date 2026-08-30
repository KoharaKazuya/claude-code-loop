---
title: "status の未承認決定カウントで index.md のチェック済みを除外する"
status: ready
priority: 3
dependencies: []
retries: 0
createdAt: 2026-08-30T10:07:16.000Z
---

## 何が起きているか

`ccloop status` の「確認推奨」に出る「未承認の決定 N 件」は、`lib/supervisor.ts` の
`loadPendingDecisions`(5119 行付近)が `.agent/decisions/` 内の `D-*.md` 実体ファイルの
存在だけで判定している。`.agent/decisions/index.md` のチェックボックスは読んでいない。

チェック `[x]` を付けても、実際にファイルが archive へ移動するのは `rotateDecisions`
(`lib/rotate.ts:103-159`)が次回実行されたときであり、それまでの間、人間が確認済みの
決定が「確認推奨」に出続ける。人間から見ると「チェックしたのに催促され続ける」体験になる。

## やること

1. `loadPendingDecisions` を、`.agent/decisions/index.md` のチェックボックス状態も参照する
   ように変更する。index.md で `[x]` が付いている決定 ID は「未承認」のカウント・プレビュー
   から除外する。
2. index.md に行が無い実体ファイル(未リコンサイルの新規決定)は従来どおり未承認として
   扱う(リコンサイルは `rotateDecisions` の責務のままとし、status 側では書き換えない。
   status は読み取り専用を維持する)。
3. index.md のパース方法は `rotateDecisions` のチェックボックス解釈と一致させる。ロジックを
   共有できる形(既存のパース関数の再利用や小さな共通関数への切り出し)が自然ならそうする。
   一致しないと「チェックしたのに status に残る/チェックしていないのに消える」ずれが生じる。
4. テストを追加する: (a) 実体ファイルありかつ index.md でチェック済み → カウントに含まれ
   ない、(b) 実体ファイルありかつ未チェック → 含まれる、(c) index.md に行が無い実体
   ファイル → 含まれる、(d) 全件チェック済みで 0 件になった場合の表示(「確認推奨」節の
   未承認決定行が出ないこと)。
5. 利用者から見た挙動の変更(status の表示が変わる)なので、CHANGELOG.md の「## 未リリース」
   に 1 行追加する。

## やらないこと

- `rotateDecisions` のアーカイブ移動ロジックの変更(チェック → 移動の仕組みは現状維持)。
- status コマンドから rotate を実行する等、status に書き込み副作用を持たせること。
- Human Review(HR)側の「確認推奨」表示の変更(このタスクは決定 = D-* のみが対象)。

## 完了条件

- `.agent/decisions/index.md` で `[x]` を付けた決定が、rotate 前でも `ccloop status` の
  「未承認の決定」カウントとプレビューに出なくなる。
- 未チェックの決定・index.md 未登録の決定は従来どおり表示される。
- 上記のテストが追加され、既存テストと合わせて通る。
- CHANGELOG.md の「## 未リリース」に利用者向けの 1 行が追加されている。
