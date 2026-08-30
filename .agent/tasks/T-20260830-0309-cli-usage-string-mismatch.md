---
title: "add サブコマンドのエラー文言と help.ts のコメントの不一致を解消する"
status: ready
priority: 3
dependencies: []
retries: 0
createdAt: 2026-08-30T03:09:29.734Z
---

所属フェーズ: 4(思いつく改善すべて)。表記不一致の解消なので人間の確認は不要
(`.agent/decisions/D-20260830-0303-phase4-consent-granularity.md` の「確認を取らない」側)。

仕様書・ヘルプ定義と実装の表記が食い違っている箇所が 2 件ある。どちらも小さいので 1 タスクで扱う。

## 対象 1: `ccloop add` のエラー文言が内部モジュール名を名乗る

`lib/supervisor.ts:3501` の `cmdAdd` は、タイトル未指定時に

```
使い方: supervisor.ts add "タイトル" [--desc 説明] [--priority N] [--deps a,b] [--model 名] [--slug slug]
```

を出力する。利用者が打つコマンド名は `ccloop` であり、`lib/help.ts` の `SUBCOMMAND_HELP.add`
(`使い方: ccloop [--repo <path>] add "タイトル" ...`)とも、他サブコマンドのエラー出力
(`lib/init.ts:202`、`lib/watch.ts:42` はいずれも `ccloop <sub>` 形式)とも食い違う。

対応: `ccloop` を主語にした文言へ揃える。可能なら `SUBCOMMAND_HELP.add` の使い方行を再利用し、
二重管理をなくす。このエラーパスは既存テストで固定されていないため、回帰テストも併せて足す。

## 対象 2: `lib/help.ts` の先頭コメントが存在しないファイルを参照している

`lib/help.ts:8` に「テストから参照できるよう、文字列は定数としてエクスポートする
(cli.test.ts / help.test.ts)」とあるが、`lib/help.test.ts` は存在しない。実際のカバーは
`lib/cli.test.ts` が子プロセス経由で行っている。

対応: コメントを実態に合わせる。対象 1 の回帰テストを `help.test.ts` として新設するなら、
コメントはそのままで実体を作る形でもよい(どちらでもよい。片方に揃えること)。

## 完了条件

- `ccloop add`(タイトル省略時)のエラー出力に `supervisor.ts` が現れない
- `lib/help.ts` のコメントが参照するテストファイルが実在する
- `npm test` / `npm run typecheck` / `npm run lint` が通る
