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
TZ=Asia/Tokyo "$taskhub_node" audit/run-tests.cjs
if NODE_PATH="${NODE_PATH:-}" "$taskhub_node" -e "require.resolve('@oai/artifact-tool')" >/dev/null 2>&1; then
  taskhub_test_data_dir="$(mktemp -d)"
  trap 'rm -rf "$taskhub_test_data_dir"' EXIT
  TZ=Asia/Tokyo TASKHUB_LOCAL_DATA_DIR="$taskhub_test_data_dir" "$taskhub_node" local-dev/server.cjs --smoke-workbook
else
  echo 'SKIP workbook smoke: install @oai/artifact-tool or set TASKHUB_NODE_MODULES/TASKHUB_RUNTIME_ROOT.'
fi
