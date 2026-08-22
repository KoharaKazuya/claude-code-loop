#!/usr/bin/env bash
# devcontainer の postCreateCommand から呼ばれるセットアップスクリプト。
# 用途ごとにセクションを分けてあるので、増減するときは該当セクションだけを編集する。
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Claude Code の設定ボリューム ---
# /home/node/.claude は名前付きボリュームでマウントされ、初期状態では root 所有になるため
# コンテナ内の node ユーザーが書き込めるようにする。
sudo chown -R node: /home/node/.claude

# --- Supervisor の worktree 置き場 ---
# /workspaces は root 所有で node ユーザーは兄弟ディレクトリを作れないため、Supervisor の
# タスク用 worktree 置き場をここで用意する。
WORKTREE_DIR="$(dirname "$PWD")/$(basename "$PWD")-worktrees"
sudo mkdir -p "$WORKTREE_DIR"
sudo chown node: "$WORKTREE_DIR"

# --- プロジェクトの依存関係 ---
# node_modules は名前付きボリュームでマウントされ、初期状態では root 所有になるため
# コンテナ内の node ユーザーが書き込めるようにする。
sudo chown node: node_modules
npm install
