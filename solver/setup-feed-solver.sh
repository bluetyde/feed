#!/usr/bin/env bash
# Builds the FEED solver stack inside a dedicated WSL distro named feed-solver (Ubuntu 22.04). Run as root.
# Pinned pair: OpenFOAM Foundation 9 (apt, dl.openfoam.org) at the exact package version in solver/pins.env, plus OFFBEAT at the
# pinned commit (build-offbeat.sh). It creates the run user (feed, uid 1000) and stops if the installed package differs from the pin.
# Never run this in another agent's distro or in openmc-mcnp.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/pins.env"

echo "== $(date -Is) apt prerequisites"
apt-get update
apt-get install -y software-properties-common wget ca-certificates git build-essential flex bison cmake zlib1g-dev python3 python3-pip

echo "== $(date -Is) OpenFOAM Foundation repository"
wget -O - https://dl.openfoam.org/gpg.key > /etc/apt/trusted.gpg.d/openfoam.asc
add-apt-repository -y http://dl.openfoam.org/ubuntu
apt-get update

echo "== $(date -Is) install $OPENFOAM_PACKAGE $OPENFOAM_VERSION"
apt-get install -y "$OPENFOAM_PACKAGE=$OPENFOAM_VERSION"
have=$(dpkg-query -W -f='${Version}' "$OPENFOAM_PACKAGE")
if [ "$have" != "$OPENFOAM_VERSION" ]; then
  echo "PIN MISMATCH: package $OPENFOAM_PACKAGE is '$have', the pin is '$OPENFOAM_VERSION' (solver/pins.env)" >&2
  exit 1
fi

echo "== $(date -Is) run user $FEED_USER ($FEED_UID)"
if id "$FEED_USER" >/dev/null 2>&1; then
  [ "$(id -u "$FEED_USER")" = "$FEED_UID" ] || { echo "user $FEED_USER exists with another uid" >&2; exit 1; }
else
  useradd -m -u "$FEED_UID" -s /bin/bash "$FEED_USER"
fi

echo "== $(date -Is) done"
ls /opt | grep -i openfoam || true
dpkg -l | grep -i '^ii  openfoam' | awk '{print $2, $3}'
df -h / | tail -1
