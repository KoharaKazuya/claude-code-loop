---
title: "ccloop retry は snoozeUntil も解除する"
reversibility: high
tasks: [T-20260830-0344-retry-subcommand]
createdAt: 2026-08-30T04:16:00.000Z
---

## 判断内容

`ccloop retry <タスクID>` は `status: ready` / `retries: 0` に戻すのに加え、`snoozeUntil` が
設定されていればそのフィールドを削除する(削除した場合のみその旨を出力する)。

## 理由

`snoozeUntil` が未来の時刻のまま残ると、ready に戻してもスケジューラがそのタスクを選ばない。
「やり直す」という明示的な指示に対して何も起きないように見えるのは意図に反する。
待機はセッション自身が「今実行しても空振りする」と判断して設定するものなので、人間が
retry を打った時点でその前提は失効していると解釈する。

## 検討した代替案

- snoozeUntil を残す: 手作業の frontmatter 編集(status と retries の 2 か所だけ)と挙動が
  揃うが、コマンドが黙って効かないケースを生むため採らない。
- 残すか消すかをオプションで選ばせる: このコマンドに固有オプションを増やすほどの需要が無い。
  必要になれば後から足せる。

## 影響範囲

`ccloop retry` の挙動のみ。手作業での frontmatter 編集は従来どおり使え、そちらの挙動は変えて
いない。解除が不都合なら retry 後に `snoozeUntil` を書き戻せばよく、可逆性は高い。
