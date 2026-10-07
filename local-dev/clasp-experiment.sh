#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
repo_root="$(CDPATH= cd -- "$script_dir/.." && pwd -P)"
experiment_root="$repo_root/taskhub-split/classroom-api-experiment"
clasp_bin="$repo_root/node_modules/.bin/clasp"

if ! command -v node >/dev/null 2>&1; then
  runtime_root="${TASKHUB_RUNTIME_ROOT:-${HOME:-}/.cache/codex-runtimes/codex-primary-runtime/dependencies}"
  if [ -n "${TASKHUB_NODE:-}" ] && [ -x "$TASKHUB_NODE" ]; then
    runtime_node_dir="$(CDPATH= cd -- "$(dirname -- "$TASKHUB_NODE")" && pwd -P)"
    PATH="$runtime_node_dir:$PATH"
    export PATH
  elif [ -x "$runtime_root/node/bin/node" ]; then
    PATH="$runtime_root/node/bin:$PATH"
    export PATH
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js が見つかりません。Node.jsをインストールするか、TASKHUB_NODE または TASKHUB_RUNTIME_ROOT を指定してください。' >&2
  exit 1
fi

if [ ! -x "$clasp_bin" ]; then
  echo 'clasp が未インストールです。リポジトリルートで pnpm install を実行してください。' >&2
  exit 1
fi

cd "$experiment_root"
exec "$clasp_bin" "$@"
