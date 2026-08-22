#!/bin/sh
# ccloop devcontainer feature installer.
#
# 前提:
# - root で実行される (devcontainer feature の実行契約)
# - このスクリプトと同じディレクトリに、リリースワークフローがコピーした
#   lib/ と bin/ と package.json が同梱されている
#   (ローカル開発でコピー前の状態では失敗する)
#
# git / Node.js / claude CLI の存在確認はここでは行わない。実行時に
# `ccloop doctor` が担う想定。
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_ROOT="/usr/local/share/ccloop"

if [ ! -d "${SCRIPT_DIR}/lib" ] || [ ! -d "${SCRIPT_DIR}/bin" ] || [ ! -f "${SCRIPT_DIR}/package.json" ]; then
  echo "error: ${SCRIPT_DIR}/lib, ${SCRIPT_DIR}/bin, ${SCRIPT_DIR}/package.json のいずれかが見つかりません。" >&2
  echo "       このディレクトリはリリースビルド (.github/workflows/release.yml) が" >&2
  echo "       リポジトリの lib/ と bin/ と package.json をコピーして生成する想定のもので、" >&2
  echo "       feature をローカル開発版のまま (コピー前に) インストールしようとしています。" >&2
  exit 1
fi

rm -rf "${INSTALL_ROOT}"
mkdir -p "${INSTALL_ROOT}"
cp -R "${SCRIPT_DIR}/lib" "${INSTALL_ROOT}/lib"
cp -R "${SCRIPT_DIR}/bin" "${INSTALL_ROOT}/bin"
# package.json は `ccloop version` が lib/ の 1 つ上から読む (lib/cli.ts の readVersion)
cp "${SCRIPT_DIR}/package.json" "${INSTALL_ROOT}/package.json"
chmod -R a+rX "${INSTALL_ROOT}"
chmod a+rx "${INSTALL_ROOT}/bin/ccloop"

mkdir -p /usr/local/bin
ln -sf "${INSTALL_ROOT}/bin/ccloop" /usr/local/bin/ccloop

echo "ccloop installed: /usr/local/bin/ccloop -> ${INSTALL_ROOT}/bin/ccloop"

if command -v node >/dev/null 2>&1; then
  echo "node: $(node --version) ($(command -v node))"
else
  echo "note: node was not found on PATH at install time; ccloop requires Node.js >=22.18 or >=24 at runtime."
fi
