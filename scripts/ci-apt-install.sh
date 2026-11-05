#!/usr/bin/env bash
# Bounded apt install for CI runners: ci-apt-install.sh <package>...
# The runner's first mirror (azure.archive.ubuntu.com) can stall with no
# output until the job's own timeout. Each attempt is bounded, apt fails over
# on an idle transfer, a lost attempt drops that mirror, and a mirror set that
# is dead for three attempts fails loudly. Same handling as the browser install
# step in deploy.yml.
set -u
[ "$#" -gt 0 ] || { echo "usage: ci-apt-install.sh <package>..."; exit 2; }
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
for i in 1 2 3; do
  if sudo timeout 170 apt-get update -qq && sudo timeout 170 apt-get install -y -qq "$@" >/dev/null; then
    exit 0
  fi
  echo "apt install attempt $i failed or stalled (apt mirror?) - retrying without the azure mirror"
  sudo pkill -TERM -f 'apt-get' 2>/dev/null || true
  set_mirrors no-azure
  sleep 10
done
echo "apt install of $* failed 3x - the runner's apt mirror is likely down"
exit 1
