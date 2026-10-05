#!/usr/bin/env bash
# Clones and builds OFFBEAT (master) against OpenFOAM Foundation 9 inside the feed-solver distro. Run as user "feed".
set -euo pipefail
# The OpenFOAM bashrc is not safe under set -e / set -u.
set +eu
source /opt/openfoam9/etc/bashrc
set -eu

echo "== $(date -Is) environment"
echo "WM_PROJECT_VERSION=$WM_PROJECT_VERSION FOAM_APPBIN=$FOAM_APPBIN FOAM_USER_APPBIN=$FOAM_USER_APPBIN"
gcc --version | head -1

DIR="$WM_PROJECT_USER_DIR/applications/solvers"
mkdir -p "$DIR"
cd "$DIR"
if [ ! -d offbeat ]; then
  echo "== $(date -Is) clone"
  git clone https://gitlab.com/foam-for-nuclear/offbeat.git
fi
cd offbeat
git checkout master
echo "OFFBEAT commit: $(git rev-parse HEAD)"
git log -1 --format='%cd %s'
ls

echo "== $(date -Is) make"
make -j8

echo "== $(date -Is) done"
which offbeat
du -sh "$DIR/offbeat" "$FOAM_USER_APPBIN" "$FOAM_USER_LIBBIN" 2>/dev/null || true
