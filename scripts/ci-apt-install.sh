#!/usr/bin/env bash
# Bounded apt install for CI runners: ci-apt-install.sh <package>...
# or ci-apt-install.sh --playwright-chromium (Playwright's Chromium with its
# system deps, whose `--with-deps` runs apt-get against the same mirrors).
# The runner's first mirror (azure.archive.ubuntu.com) can stall with no
# output until the job's own timeout. Each attempt is bounded, apt fails over
# on an idle transfer, a lost attempt drops that mirror, and a mirror set that
# is dead for three attempts fails loudly.
set -u
[ "$#" -gt 0 ] || { echo "usage: ci-apt-install.sh <package>... | --playwright-chromium"; exit 2; }
PLAYWRIGHT=0
if [ "$1" = "--playwright-chromium" ]; then
  [ "$#" -eq 1 ] || { echo "--playwright-chromium takes no packages"; exit 2; }
  PLAYWRIGHT=1
fi
attempt() {
  if [ "$PLAYWRIGHT" = 1 ]; then
    timeout 170 npx playwright install --with-deps chromium
  else
    sudo timeout 170 apt-get update -q >"$LOG" 2>&1 && sudo timeout 170 apt-get install -y -q "$@" >>"$LOG" 2>&1
  fi
}
# apt's own output goes to a log that is printed (last lines, with the time
# taken) when an attempt fails, so a failed install names its cause.
LOG=$(mktemp)
printf 'Acquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAcquire::Retries "2";\n' \
  | sudo tee /etc/apt/apt.conf.d/99-ci-mirror-timeouts >/dev/null
set_mirrors() {  # $1 = with-azure | no-azure
  [ -f /etc/apt/apt-mirrors.txt ] || return 0
  {
    printf 'https://archive.ubuntu.com/ubuntu/\tpriority:1\n'
    [ "$1" = "with-azure" ] && printf 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:2\n'
    printf 'https://security.ubuntu.com/ubuntu/\tpriority:3\n'
  } | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
}
set_mirrors with-azure
# When the runner's resolver cannot find the Ubuntu archive hosts (seen
# 2026-11-11: "Temporary failure resolving 'archive.ubuntu.com'" while other
# hosts resolved), look them up through public resolvers and pin the answer
# in /etc/hosts for this job only. Nothing is pinned when the runner resolves.
pin_ubuntu_hosts() {
  for h in archive.ubuntu.com security.ubuntu.com; do
    getent hosts "$h" >/dev/null 2>&1 && continue
    ip=""
    for r in 1.1.1.1 8.8.8.8; do
      ip=$(dig +short +time=3 +tries=1 @"$r" "$h" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
      [ -n "$ip" ] && break
    done
    if [ -n "$ip" ]; then
      echo "runner resolver cannot find $h; pinning $h to $ip (public resolver) for this job"
      echo "$ip $h" | sudo tee -a /etc/hosts >/dev/null
    else
      echo "runner resolver cannot find $h, and the public resolvers gave no answer"
    fi
  done
}
pin_ubuntu_hosts
for i in 1 2 3; do
  t0=$(date +%s)
  if attempt "$@"; then
    exit 0
  fi
  echo "apt install attempt $i failed or stalled after $(( $(date +%s) - t0 )) s - retrying without the azure mirror; apt's last lines:"
  tail -n 25 "$LOG" 2>/dev/null | sed 's/^/  | /'
  [ -f /etc/apt/apt-mirrors.txt ] && sed 's/^/  mirror: /' /etc/apt/apt-mirrors.txt
  # A stalled apt-get may outlive the killed parent (sudo can detach it from
  # the group); clear it so the retry is not blocked on its lock.
  sudo pkill -TERM -f 'apt-get' 2>/dev/null || true
  set_mirrors no-azure
  pin_ubuntu_hosts
  sleep 10
done
echo "apt install of $* failed 3x - the runner's apt mirror is likely down"
exit 1
