#!/bin/sh
# Starts as root only long enough to hand the proof-of-work replay record
# (TOLLBOOTH_REPLAY_SQLITE) to the node user, then runs the proxy as node.
#
# Why: an image that ran as root left that file, and its directory on a
# mounted volume, owned by root. A process started as node opens such a file
# read-only without complaint, and then every claim fails with "attempt to
# write a readonly database", so solved proof-of-work and Tempo credentials
# are refused. A volume's ownership is fixed at run time, never at build time,
# so the fix happens here. su-exec execs the proxy in place: it stays PID 1
# and receives SIGTERM directly.
set -e

TARGET_USER=node

if [ "$(id -u)" = "0" ]; then
  if [ -n "$TOLLBOOTH_REPLAY_SQLITE" ]; then
    dir=$(dirname -- "$TOLLBOOTH_REPLAY_SQLITE")
    # Created as node wherever node may write (the image's /var/lib/tollbooth
    # is node's, so a subdirectory of it comes out node's, with nothing to
    # hand over). Only where node cannot create it does root create it, and
    # then the own-place rule below decides whether it is handed over.
    if [ ! -e "$dir" ]; then
      su-exec "$TARGET_USER" mkdir -p -- "$dir" 2>/dev/null || mkdir -p -- "$dir" || echo "[entrypoint] WARN: could not create $dir"
    fi
    # The directory too (SQLite writes its -wal and -shm files beside the
    # database), but only where it is the record's own place: the image's
    # /var/lib/tollbooth, or a directory on a mounted volume or bind mount.
    # A directory that is part of the image (/app, /tmp, /) is never handed
    # over, so the packages stay out of node's reach. The place is judged on
    # the directory's resolved path, and a directory that is itself a link is
    # never handed over, so a link on a volume (/vol/sub -> /usr/local/bin)
    # cannot point the chown into the image. The record's files follow the
    # same rule. Only the directory itself and only when it is not already
    # node's: no recursive walk of a volume on every boot.
    is_mount() { awk -v d="$1" '{ m = $5; gsub(/\\040/, " ", m) } m == d { found = 1 } END { exit !found }' /proc/self/mountinfo 2>/dev/null; }
    on_volume() {
      d=$1
      while [ "$d" != "/" ] && [ "$d" != "." ]; do
        is_mount "$d" && return 0
        d=$(dirname -- "$d")
      done
      return 1
    }
    own_place=no
    real=$(readlink -f -- "$dir" 2>/dev/null || true)
    if [ -d "$dir" ] && [ ! -L "$dir" ] && [ -n "$real" ]; then
      case "$real" in
        /proc|/proc/*|/sys|/sys/*|/dev|/dev/*) ;;
        *) if [ "$real" = "/var/lib/tollbooth" ] || on_volume "$real"; then own_place=yes; fi ;;
      esac
    fi
    if [ -d "$dir" ] && [ "$(stat -c '%U' -- "$dir")" != "$TARGET_USER" ]; then
      if [ "$own_place" = yes ]; then
        echo "[entrypoint] handing $dir to $TARGET_USER (the replay record's directory)"
        chown -h "$TARGET_USER:$TARGET_USER" -- "$real" || echo "[entrypoint] WARN: chown $dir failed"
      elif ! su-exec "$TARGET_USER" test -w "$dir"; then
        echo "[entrypoint] WARN: the proxy runs as $TARGET_USER and cannot write $dir; put TOLLBOOTH_REPLAY_SQLITE in /var/lib/tollbooth or on a mounted volume"
      fi
    fi
    for f in "$TOLLBOOTH_REPLAY_SQLITE" "$TOLLBOOTH_REPLAY_SQLITE-wal" "$TOLLBOOTH_REPLAY_SQLITE-shm" "$TOLLBOOTH_REPLAY_SQLITE-journal"; do
      if [ -e "$f" ] && [ "$(stat -c '%U' -- "$f")" != "$TARGET_USER" ]; then
        if [ "$own_place" = yes ]; then
          echo "[entrypoint] handing $f to $TARGET_USER"
          chown -h "$TARGET_USER:$TARGET_USER" -- "$f" || echo "[entrypoint] WARN: chown $f failed"
        elif ! su-exec "$TARGET_USER" test -w "$f"; then
          echo "[entrypoint] WARN: the proxy runs as $TARGET_USER and cannot write $f; put TOLLBOOTH_REPLAY_SQLITE in /var/lib/tollbooth or on a mounted volume"
        fi
      fi
    done
  fi
  exec su-exec "$TARGET_USER" "$@"
fi

# Already started as a non-root user (docker run --user): run as that user.
exec "$@"
