---
title: "共通ルールの「拒否は記録される」という記述を実態に合わせる"
status: ready
priority: 3
dependencies: []
retries: 0
createdAt: 2026-08-30T11:36:40.000Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れている記述の修理であり、人間の確認は不要
(`.claude/CLAUDE.md` の「不具合の修正は確認を取らない」に該当)。

## 背景

`lib/prompt/PROMPT.md`(自律セッションへ注入される共通ルール)は、権限で拒否された操作について
「拒否の事実は ccloop が記録し `ccloop status` に要約が出る」と一律に書いている。しかし実装は
`permissions.deny` にあらかじめ一致する拒否を**意図的に記録していない**(`lib/supervisor.ts` の
`recordPermissionDenials` が `partitionDeniedByRules` で deny リスト一致分を除外し、除外分は
ログ 1 行を残すだけで `permission-denials.jsonl` にも `ccloop status` にも出さない)。

実装が正しく、記述が不正確である。記録されるのは「その場の classifier 判定による拒否」だけで、
「人間があらかじめ禁止と決めた操作の拒否」は記録されない。この区別が共通ルールに書かれていないため、
セッションは「deny 一致の拒否も人間に見えている」と誤解しうる。

## やること

`lib/prompt/PROMPT.md` の記述を実態に合わせる。**表示・記録の挙動は変えない**(記録範囲を広げるか
どうかは `HR-20260830-1057-topic-denied-operation-audit` で人間に確認中であり、その回答を先取りしない)。

対象は少なくとも次の 2 箇所。文言を直す前に周辺を読み、同趣旨の記述が他にもないか grep で確認する。

- 「Bash 実行の権限制約」節の末尾(`lib/prompt/PROMPT.md:109-111` 付近)
- 「絶対ルール 6」の「拒否された事実は ccloop が自動記録し、`ccloop status` に要約が出る」相当の記述

修正の方向は「classifier 判定による拒否は記録・表示される / `permissions.deny` に一致する拒否は
人間が既に禁止と決めた操作なので記録されない」の区別を入れること。結論(セッションが取るべき行動 =
迂回せず代替に切り替え、成立しないときだけ BLOCK にする)は変えない。

`.claude/CLAUDE.md` にも権限制約の節があり `lib/prompt/PROMPT.md` を参照する形になっている。
そちらに実態と食い違う記述があれば併せて直す。

## 完了条件

- `lib/prompt/PROMPT.md` の記述が実装の挙動と一致している(記録される拒否・されない拒否の区別が書かれている)
- 実装(`lib/supervisor.ts`)には手を入れていない
- `npm run lint` / `npm run typecheck` / `npm test` が通る
- `CHANGELOG.md` には載せない(利用者から見た挙動は変わらないため)
