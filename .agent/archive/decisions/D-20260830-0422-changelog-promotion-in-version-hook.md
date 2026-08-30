---
title: "変更履歴の繰り上げは npm version のフックで自動化する"
reversibility: high
tasks: [T-20260830-0357-changelog-release-promotion]
createdAt: 2026-08-30T04:22:00.000Z
---

## 判断

リリース時に `CHANGELOG.md` の `## 未リリース` 節を `## <バージョン> — <日付>` 見出しへ繰り上げる処理を
自動化した(タスクの選択肢 A)。ただし書き込みは `scripts/release.mjs` の中では行わず、
`npm version` のライフサイクルフック(`package.json` の `version` script)から
`scripts/promote-changelog.mjs` を走らせる形にした。

## 理由

- `release.mjs` は現状ファイル書き込みを一切せず、`--dry-run` は `npm version` を呼ぶ手前で
  早期 return することで「dry-run は何も書き換えない」性質を構造的に保証している。
  書き込みを `release.mjs` に足すと、この保証が「dry-run 分岐を正しく書いたか」に依存する形へ後退する。
  `version` フック側に置けば、dry-run では `npm version` 自体が呼ばれないため性質を触らずに済む。
- `version` フックで `git add` したファイルはバージョンコミットに含まれる。既に
  `sync-version.mjs` が同じ仕組みで feature JSON と README を更新しており、それに揃えた。
- 手順の明文化(選択肢 B)を採らなかったのは、繰り上げが機械的な切り貼りで済み、人間の推敲を
  必要としないため。節の内容自体は変更を入れたセッションが利用者の言葉で書き終えている。

## 機械的な自動化の見えにくさへの対処

自動化の弱点は、切り貼りが意図と食い違ったときに気づきにくいこと。これを次の 2 つで補った。

- `release.mjs` が検証を走らせる前に、読み取り専用の `previewPromotion` で構造(未リリース節が
  あるか、これから付けるバージョンの見出しが既にないか)を確認し、繰り上げ対象の件数を表示する。
  `npm version` 実行中に失敗して package.json だけ更新された中途半端な状態になるのを防ぐ。
- 未リリース節が空のときはエラーにせず何もしない。利用者から見た変更が無いリリースがありうるため。

## 影響範囲

`scripts/promote-changelog.mjs`(新規)、`scripts/release.mjs`、`package.json` の `version` script。
運用ルールは `.claude/CLAUDE.md` と `lib/prompt/PROMPT.md` の両方に
「バージョン見出しを手で作らない」を追記した。
