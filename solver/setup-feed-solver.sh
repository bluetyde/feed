#!/usr/bin/env bash
# Builds the FEED solver stack inside a dedicated WSL distro named feed-solver (Ubuntu 22.04). Run as root.
# Pinned pair: OpenFOAM Foundation 9 (apt, dl.openfoam.org) + OFFBEAT master (see solver/PINS.md for the commit).
# Never run this in another agent's distro or in openmc-mcnp.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== $(date -Is) apt prerequisites"
apt-get update
apt-get install -y software-properties-common wget ca-certificates git build-essential flex bison cmake zlib1g-dev python3 python3-pip

echo "== $(date -Is) OpenFOAM Foundation repository"
wget -O - https://dl.openfoam.org/gpg.key > /etc/apt/trusted.gpg.d/openfoam.asc
add-apt-repository -y http://dl.openfoam.org/ubuntu
apt-get update

echo "== $(date -Is) install openfoam9"
apt-get install -y openfoam9

echo "== $(date -Is) done"
ls /opt | grep -i openfoam || true
dpkg -l | grep -i '^ii  openfoam' | awk '{print $2, $3}'
df -h / | tail -1
