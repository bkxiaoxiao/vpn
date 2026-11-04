#!/bin/sh
# Credentials are read from the protected config file, never from process arguments.
"$1" run -c "$2" >/dev/null 2>&1 &
core_pid=$!
trap 'kill "$core_pid" 2>/dev/null; wait "$core_pid" 2>/dev/null; exit 0' TERM INT HUP
while kill -0 "$3" 2>/dev/null && kill -0 "$core_pid" 2>/dev/null; do
  sleep 1
done
kill "$core_pid" 2>/dev/null
wait "$core_pid" 2>/dev/null
