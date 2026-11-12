#!/bin/sh
# Runtime privilege-drop entrypoint (security audit A402-01).
#
# The container image installs as root and this script is PID 1 as root — but
# only long enough to fix up the runtime-mounted volume, then it hands off to
# the unprivileged `node` user so the server (and any renderer/media compromise)
# never runs as root.
#
# Why root-then-drop instead of a Dockerfile `USER node`: a persistent volume
# mounted at /data arrives owned by root:root at RUNTIME (it does not exist at
# build time, so a build-time chown can't touch it). A container that started as
# `USER node` could not write /data, and the memory/stats SQLite would fail its
# boot-fail-loud check. So when /data exists we chown it to node here, as root,
# then exec the server as node via gosu. The hosted service runs with no volume
# (state in Postgres and Redis): there /data is absent and this only drops root.
set -e

TARGET_USER=node

if [ -d /data ]; then
  # Only chown when ownership is wrong, so a large volume doesn't pay a full
  # recursive chown on every boot.
  if [ "$(stat -c '%U' /data 2>/dev/null || echo root)" != "$TARGET_USER" ]; then
    echo "[entrypoint] chowning /data to $TARGET_USER (first boot on this volume)"
    chown -R "$TARGET_USER:$TARGET_USER" /data || echo "[entrypoint] WARN: chown /data failed"
  fi
fi

# Drop root and run the app as node. exec so node becomes PID 1 and receives
# SIGTERM directly (the graceful-drain path in src/server.js depends on it).
echo "[entrypoint] started as $(id -un) ($(id -u)); dropping to $TARGET_USER and exec: $*"
exec gosu "$TARGET_USER" "$@"
