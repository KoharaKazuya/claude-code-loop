---
title: "watch / init のエラー時使い方文言を help.ts から再利用して二重管理をなくす"
status: completed
priority: 4
dependencies: []
retries: 0
note: "watch / init のエラー文言を usageOf() 経由に置き換え、回帰テストを 2 件追加。test/typecheck/lint 通過"
createdAt: 2026-08-30T03:17:10.313Z
---

所属フェーズ: 4(思いつく改善すべて)。既存文言に誤りは無く、将来の表記ズレを防ぐ予防的な整理なので
人間の確認は不要(`.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` の「確認を取らない」側)。

## 背景

`lib/help.ts` に `usageOf(sub)`(サブコマンドヘルプの先頭「使い方:」ブロックを返す純粋関数)を
追加し、`lib/supervisor.ts` の `cmdAdd` はこれを再利用するようになった。一方で次の 2 箇所は
使い方文言を手書きでハードコードしたままで、`SUBCOMMAND_HELP` と二重管理になっている。

- `lib/init.ts:202` … `使い方: ccloop init [--yes] [--upgrade]`
- `lib/watch.ts:42` … `使い方: ccloop watch [--interval <秒>]`

現時点でこれらの表記自体に誤りは無い(`ccloop` を主語にしている)。問題は、`SUBCOMMAND_HELP` 側の
オプションを増減したときに追随漏れが起きうること。

## 対応

- 上記 2 箇所を `usageOf("init")` / `usageOf("watch")` に置き換える。
- `usageOf` の戻り値には `[--repo <path>]` が含まれる点に注意する(既存の手書き文言には無い)。
  エラー出力として不自然でなければそのまま採用してよい。不自然なら `usageOf` 側で対応するのではなく、
  文言をそのまま受け入れるか、置き換えを見送って理由を `.agent/decisions/` に記録する。
- `lib/init.ts` は `使い方:` の前に `未知のオプション: ...` を付けている。この前置きは維持する。
- 置き換えた 2 経路について、出力に `SUBCOMMAND_HELP` 由来の文言が使われることを確認する回帰テストを
  既存のテストファイル(`lib/init.test.ts` / `lib/watch.test.ts`)に追加する。

## 完了条件

- `lib/init.ts` / `lib/watch.ts` に使い方文言のハードコードが残っていない
- `npm test` / `npm run typecheck` / `npm run lint` が通る
