---
title: "この開発 devcontainer は公開 feature をやめ checkout の bin/ccloop を使う"
reversibility: high
createdAt: 2026-08-30T10:08:11.000Z
---

## 判断

`.devcontainer/devcontainer.json` から ccloop feature (`ghcr.io/koharakazuya/claude-code-loop/ccloop`)
のエントリを削除し、`.devcontainer/post-create.sh` で `/usr/local/bin/ccloop` をこのリポジトリの
`bin/ccloop` への symlink として作るようにした。この開発用 devcontainer 内の PATH 上の `ccloop` は
以後、公開済みバージョンではなく checkout そのものを指す。

これは D-20260822-0846(devcontainer を公開版 ccloop feature で自己ホストする)と D-20260830-0355
(手元の ccloop 入れ替えは「リリース + 再ビルド」を唯一の推奨手順として文書化する)を意図的に覆す。
どちらも人間が対話セッションで明示的に指示した方針変更であり、既に承認済み。

## 理由

人間の明示指示による。release → devcontainer.json 更新 → 再ビルドという往復コストより、checkout に
直結して `lib/` の変更が新しく起動するプロセスから即座に反映されることを優先する。

エンドユーザー向けの feature 配布(`release.yml` による GHCR publish)と、install.sh / feature 定義の
検証(CI の `feature-test` ジョブ、`test/ccloop/test.sh`)は変更しない。今回変更したのは「この開発用
devcontainer がどの ccloop を使うか」だけであり、dogfooding(利用者と同じインストール経路の動作確認)は
引き続き CI の `feature-test` ジョブが担う。

## 受け入れたトレードオフ

- D-20260822-0846 が得ていた「自律ループの自己改変からの隔離」を失う。自律ループ(`ccloop run`)が
  このリポジトリの `lib/` を壊す変更を入れると、同じ symlink を通じて PATH 上の `ccloop` コマンド自身も
  壊れる。ただし `git` で戻せば復旧できる範囲であり、`./bin/ccloop` と実体が同一になることで
  「PATH の ccloop と `./bin/ccloop` の挙動が食い違う」混乱がむしろ消える。
- `ccloop status` のインストール済みソース乖離警告(D-20260830-0251 で常時点灯を許容していたもの)は、
  この devcontainer では PATH の `ccloop` がリポジトリの `lib/` そのものを指すため恒常的に「乖離なし」
  になり、実質的に発火しなくなる。判定ロジック自体は他の自己ホスト環境(devcontainer の外で公開
  feature を使う場合など)のために変更していない。

## 検討した代替案

- 現状維持(公開 feature のまま)。往復コストが人間の作業体験を損ねているとの明示指摘があり、
  再ビルド無しで最新の `lib/` を試せる利点を優先して却下。

## 影響範囲

`.devcontainer/devcontainer.json` / `.devcontainer/devcontainer-lock.json` / `.devcontainer/post-create.sh`
/ `README.md`(開発節)/ `docs/architecture.md`(該当節を書き換え)。`docs/architecture.md` の見出しを
変更したため、`lib/supervisor.ts` の乖離警告メッセージが参照する見出し文字列も追従修正した(この
メッセージはテストで文字列一致を検証していないため、変更時は手動で追従が必要)。エンドユーザー向けの
インストール方法・CHANGELOG は変更していない。
