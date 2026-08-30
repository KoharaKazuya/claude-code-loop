---
title: "設定ファイルが古いことを ccloop status の「要対応」に出す"
status: ready
priority: 3
dependencies: [T-20260830-1007-status-respect-decision-checkbox]
retries: 0
createdAt: 2026-08-30T10:53:39.546Z
---

所属フェーズ: 4(思いつく改善すべて)。
`HR-20260830-0934-topic-schema-version-in-status` で人間の承認済み(2026-08-30)。

## 背景

`.agent/config.json` の `schemaVersion` が本体の `CURRENT_SCHEMA_VERSION`
(`lib/migrations.ts:18`)より古いと `ccloop run` は起動を拒否する(`status` などは動く)。
止める判断そのものは意図した設計で、変えない。

問題は知らせ方である。食い違いの案内はコマンド実行時に 1 行出るだけで、`ccloop status` の
「要対応」一覧には入らない。普段の状況把握は `status` で行うため、**実際に起動しようとして
止まるまで気づけない。** 現に、版番号を上げる変更が main に入った直後、次の起動が
人間の操作待ちになる事象が発生した。

## やること

1. `ccloop status` の「要対応」に「設定ファイルが古い。`ccloop init --upgrade` を実行する」の
   1 項目を足す。判定は `compareSchemaVersion`(`lib/migrations.ts:73`)の結果を使う。
2. 逆向きの食い違い(`tool-outdated`: 設定のほうが新しく、本体が古い)も同関数が返すので、
   そちらも「要対応」に出すか検討する。出す場合は案内文を分けること(この場合の対処は
   `init --upgrade` ではなく本体の更新である)。
3. テストを足す。
4. `CHANGELOG.md` の「## 未リリース」に利用者の言葉で 1 行足す。

## 完了条件

設定ファイルの版が本体と食い違っているとき、`ccloop status` の「要対応」に対処コマンド付きで
表示されること。食い違いが無いときは何も出ないこと。機械的検証が通ること。

## 注意

「要対応」は放っておけない事柄を並べる場所であり、項目を増やすほど 1 件あたりの重みが薄まる。
表示は 1 項目・簡潔に留め、食い違いが無いときに出さないことを徹底する。
