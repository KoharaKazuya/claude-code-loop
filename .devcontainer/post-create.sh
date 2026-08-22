#!/usr/bin/env bash
# devcontainer の postCreateCommand から呼ばれるセットアップスクリプト。
# 用途ごとにセクションを分けてあるので、増減するときは該当セクションだけを編集する。
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Claude Code の設定ボリューム ---
# /home/node/.claude は名前付きボリュームでマウントされ、初期状態では root 所有になるため
# コンテナ内の node ユーザーが書き込めるようにする。
sudo chown -R node: /home/node/.claude

# --- プロジェクトの依存関係 ---
# node_modules は名前付きボリュームでマウントされ、初期状態では root 所有になるため
# コンテナ内の node ユーザーが書き込めるようにする。
sudo chown node: node_modules
npm install

# --- このリポジトリの checkout を ccloop 本体として使えるようにする ---
# bin/ccloop は自分の実体(readlink -f)から見た ../lib を CCLOOP_HOME として解決するため、
# ここへのシンボリックリンクだけで feature 版と同じ動かし方(ccloop <subcommand>)ができる。
sudo ln -sfn "$(pwd)/bin/ccloop" /usr/local/bin/ccloop
