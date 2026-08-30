#!/usr/bin/env bash
# devcontainer の postCreateCommand から呼ばれるセットアップスクリプト。
# 用途ごとにセクションを分けてあるので、増減するときは該当セクションだけを編集する。
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# --- Claude Code の設定ボリューム ---
# /home/node/.claude は名前付きボリュームでマウントされ、初期状態では root 所有になるため
# コンテナ内の node ユーザーが書き込めるようにする。
sudo chown -R node: /home/node/.claude

# --- プロジェクトの依存関係 ---
# node_modules は名前付きボリュームでマウントされ、初期状態では root 所有になるため
# コンテナ内の node ユーザーが書き込めるようにする。
sudo chown node: node_modules
npm install

# --- ccloop コマンド ---
# この開発用 devcontainer では公開 feature をインストールせず、checkout の bin/ccloop を
# そのまま PATH 上の ccloop として使う。lib/ を編集すれば(新しく起動するプロセスから)即座に
# 反映される。/usr/local/bin は root 所有のため symlink 作成に sudo が要る。
sudo ln -sf "$repo_root/bin/ccloop" /usr/local/bin/ccloop
