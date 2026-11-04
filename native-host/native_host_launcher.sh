#!/bin/zsh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_PATH="$(<"$SCRIPT_DIR/python_path")"
exec "$PYTHON_PATH" "$SCRIPT_DIR/host.py"
