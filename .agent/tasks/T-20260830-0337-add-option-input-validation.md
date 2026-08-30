---
title: "ccloop add のオプション入力の検証漏れを塞ぐ"
status: completed
priority: 3
dependencies: []
retries: 0
note: "resolvePriority / parseDeps を純粋関数として切り出し検証を追加。test / typecheck / lint 通過"
createdAt: 2026-08-30T03:37:51.554Z
---

所属フェーズ: 4(思いつく改善すべて)。

## 目的

`ccloop add` が受け取ったオプション値を検証せずタスクファイルへ書くため、不正な値が
黙って通る。特に `--deps` の空白混じり指定は、存在しない依存 ID を登録してしまい気付けない。

## 現状(調査で確認済み)

`cmdAdd`(`lib/supervisor.ts:3525` 付近)に次の 2 つの問題がある。

1. `priority: Number(opt("priority") ?? 3)` に数値検証が無い。`--priority abc` のような非数値を
   渡すと `NaN` になり、そのまま `.agent/tasks/<id>.md` へ `priority: NaN` と書き出される。
   確認メッセージにも `priority=NaN` と出る。次回読み込み時に `taskFromFile`
   (`lib/supervisor.ts:251`)が `typeof data.priority === "number"` で弾いて既定値 3 へ
   自己修復するため実害は残らないが、ファイルに仕様外の値が一時的に残り、人間には
   「priority が勝手に 3 になった」と見える。

2. `--deps` をカンマ分割した後 `trim()` していない。`--deps "T-a, T-b"` と書くと `" T-b"` という
   先頭に空白を含む ID が登録される。この ID に一致するタスクファイルは存在しないため、
   依存充足判定(`depSatisfied`)が「依存先が存在しない = 充足済み」として扱い、意図した
   依存関係が黙って無効になる。カンマ区切りに空白を入れるのは自然な書き方なので踏みやすい。

2 のほうが影響が大きい(スケジューリングが意図と変わるのに何のエラーも出ない)。

## 完了条件

- `--priority` に数値として解釈できない値・整数でない値が渡されたとき、`NaN` を書き込まず
  エラーメッセージを出して終了する(既存の他オプションのエラー処理と同じ体裁に揃える)。
- `--deps` は分割後に各要素を `trim()` し、空要素は捨てる。
- 上記 2 点の回帰テストを `lib/supervisor.test.ts`(または `cmdAdd` のテストがある既存ファイル)に
  足す。空白入り `--deps` が正しい ID として登録されることを確認する。
- `npm run` 経由の test / typecheck / lint が通る。

## 補足

`--priority` の扱いを「エラー終了」ではなく「既定値へフォールバック」にしたくなった場合、
どちらを選んだか・理由を `.agent/decisions/` に記録すること。黙って値が変わるより
エラーで気付ける方がよい、というのがこのタスク登録時点の想定である。
