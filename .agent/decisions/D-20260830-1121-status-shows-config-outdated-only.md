---
title: "status の要対応に出すのは「設定が古い」向きのみとする"
reversibility: high
tasks: [T-20260830-1053-status-config-schema-outdated]
createdAt: 2026-08-30T11:21:32.893Z
---

## 判断内容

`ccloop status` の「要対応」に出す schemaVersion の食い違いは `config-outdated`
(設定ファイルが本体より古い)だけとする。逆向きの `tool-outdated`(設定のほうが新しく本体が古い)は
表示しない。

## 理由

`cli.ts` の schemaVersion ゲート(`checkSchemaVersion`)は `tool-outdated` のとき `status` を含む
全コマンドを exit(1) で止める。これは既存の意図した設計(`lib/init.test.ts` にテストがある)で、
そのとき人間は既に専用の 1 行案内(ccloop 本体を更新せよ)を受け取っている。したがって
`formatStatus` に `tool-outdated` の分岐を書いても実運用では到達せず、単体テストでしか観測できない
デッドコードになる。

## 検討した代替案

`status` / `watch` のような観察系コマンドは `tool-outdated` でもゲートを通して継続させ、要対応に
出す案。情報としては筋が良いが、既存の「本体が古いなら何もさせない」設計を変えることになり
影響範囲が広い。今回のタスクの目的(食い違いに早く気づけるようにする)は `config-outdated` 側の
表示だけで達成できるため見送った。

## 影響範囲

`StatusData.configSchema` は突き合わせ結果をそのまま保持しており、`status --json` では
`tool-outdated` も観測できる。将来ゲートの仕様を変えるなら、`formatStatus` に分岐を足すだけで済む。
