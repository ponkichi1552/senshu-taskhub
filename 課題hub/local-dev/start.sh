#!/bin/sh
set -eu

taskhub_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
taskhub_node="${TASKHUB_NODE:-}"
taskhub_runtime_root="${TASKHUB_RUNTIME_ROOT:-${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies}"
if [ -z "$taskhub_node" ]; then taskhub_node="$(command -v node || true)"; fi
if [ -z "$taskhub_node" ] && [ -x "$taskhub_runtime_root/node/bin/node" ]; then
  taskhub_node="$taskhub_runtime_root/node/bin/node"
fi
if [ -z "$taskhub_node" ] || [ ! -x "$taskhub_node" ]; then
  echo 'Node.js が見つかりません。Node.jsをインストールするか、TASKHUB_NODEに実行ファイルを指定してください。' >&2
  exit 1
fi
cd "$taskhub_root"
taskhub_modules="${TASKHUB_NODE_MODULES:-$taskhub_runtime_root/node/node_modules}"
if [ -d "$taskhub_modules" ]; then NODE_PATH="$taskhub_modules${NODE_PATH:+:$NODE_PATH}"; export NODE_PATH; fi
TZ=Asia/Tokyo; export TZ
exec "$taskhub_node" "$taskhub_root/local-dev/server.cjs"
