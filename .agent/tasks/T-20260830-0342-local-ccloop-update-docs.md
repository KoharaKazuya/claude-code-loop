---
title: "手元の ccloop を最新の中身へ入れ替える手順を文書化する"
status: completed
priority: 2
dependencies: []
retries: 0
note: "docs/architecture.md に入れ替え手順を書き README からリンクした。推奨はリリース + 再ビルド"
createdAt: 2026-08-30T03:42:50.737Z
---

所属フェーズ: 4(思いつく改善すべて)。

## 経緯

`HR-20260830-0303-topic-local-ccloop-update`(BLOCK)で、手元の `ccloop` を最新の中身へ
入れ替える手段として次の 2 案を示した。

1. 入れ替え手順を文書に書く
2. 一発で入れ替えるコマンドを用意する

人間の回答は **「1」**。つまり **文書化のみ** を行う。入れ替え用のサブコマンドは作らない。

## 目的

`ccloop` の実体はインストール先(DevContainer feature が展開したコピー)であり、リポジトリの
`lib/` を直しても入れ替えるまで人間の手元の挙動は変わらない。この入れ替え手順が README にも
docs にも書かれていないため、改善が手元に届かない状態が続いている。手順を書いて解消する。

## やること

- 実際にインストール先がどこで、リポジトリの中身をどう反映させるのが正しいかを調べる。
  `features/ccloop/` の install スクリプト、`package.json` の scripts、`lib/doctor.ts` が
  持つ「インストール元との乖離検出」の実装(`.agent/decisions/D-20260830-0251-installed-source-drift-always-on.md`
  も参照)が手掛かりになる。
- 調べた手順を docs/ の適切な箇所に書き、README からたどり着けるようにする。
- 「なぜ入れ替えが必要なのか」(リポジトリを直しただけでは手元に反映されないこと)も
  一言添える。手順だけ書いても、いつ実行すべきか分からないと使われない。

## 判断が必要な点

- 開発環境の作り直し(DevContainer のリビルド)が必要な方式しか無いと判明した場合、
  HR 本文でも「その旨を添えて改めて相談する」と伝えてある。その場合は手順として素直に
  そう書いたうえで、判断を `.agent/decisions/` に記録すること。相談のための新しい HR は、
  確認トピックの枠(同時 4 件程度)に空きがあるときだけ開く。
- 手順が複数ある場合(リビルド / ローカルビルドの差し替え等)は、推奨を 1 つ明示する。
  読者が選べないまま終わるのが最悪である。

## 完了条件

- docs/ に入れ替え手順があり、README からリンクされている。
- 手順を実際に検証できた範囲と、検証できなかった範囲が区別して書かれている
  (環境の作り直しを伴う手順はこのセッションでは実行できない。推測で「動く」と書かない)。
- `npm run` 経由の lint / typecheck / test が通る。

## やらないこと

入れ替え用のサブコマンドは作らない(回答が「1」であるため)。`npm run release` による公開も
行わない。

## 試行履歴

### 試行 1(2026-08-30T03:55:59.827Z, セッション記録)
- 確認済みの事実(実機で検証): `/usr/local/bin/ccloop` は `/usr/local/share/ccloop/bin/ccloop` への
  symlink、インストール先は root 所有で `test -w` が失敗(作業ユーザーは書き込み不可)。`ccloop --version`
  と `./bin/ccloop --version` はどちらも `0.4.1` だが `diff -rq` で 20 ファイル以上が食い違い、インストール
  済み `lib/supervisor.ts` に `isInstalledSourceDrifted` は存在しない(バージョン番号が同じでも中身が
  違いうることの実例)。
- 確認済みの事実(実装読解): install.sh はリリースワークフローによるコピー後を前提としローカル checkout
  には使えない。ビルド工程は存在せず(`build` スクリプト無し)ソースをそのまま配布している。
- 未検証(推測で「動く」と書かなかった範囲): 推奨手順そのもの、すなわち `npm run release` →
  GHCR publish → `.devcontainer/devcontainer.json` の参照更新 → コンテナ再ビルド。push・タグ作成・
  リビルドを伴うためこのセッションでは実行できない。`devcontainer features test` も未実行。
- 変更: `docs/architecture.md` の当該節を手順形式に書き換え(見出しを「手元の ccloop をリポジトリの
  最新の中身へ入れ替える」に変更)、README「開発」節からアンカーリンクを追加、見出し変更に追従して
  `lib/supervisor.ts:2301` の乖離警告メッセージの参照文言を修正。
- 検証: `npm run typecheck` / `npm run lint` / `npm test`(814 tests)すべて通過。
- reviewer 指摘: 見出し変更で `lib/supervisor.ts` の警告文が実在しない見出しを指す件(必須)→ 修正済み。
  日本語の不自然さ(軽微)→ 修正済み。
