#!/usr/bin/env bash
# Clones and builds OFFBEAT at the EXACT commit in solver/pins.env against the pinned OpenFOAM Foundation 9 package inside the
# feed-solver distro. Run as user "feed". It stops if the commit or the installed package differs from the pins.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/pins.env"
# The OpenFOAM bashrc is not safe under set -e / set -u.
set +eu
source /opt/openfoam9/etc/bashrc
set -eu

echo "== $(date -Is) environment"
echo "WM_PROJECT_VERSION=$WM_PROJECT_VERSION FOAM_APPBIN=$FOAM_APPBIN FOAM_USER_APPBIN=$FOAM_USER_APPBIN"
gcc --version | head -1
have=$(dpkg-query -W -f='${Version}' "$OPENFOAM_PACKAGE" 2>/dev/null || true)
if [ "$have" != "$OPENFOAM_VERSION" ]; then
  echo "PIN MISMATCH: package $OPENFOAM_PACKAGE is '$have', the pin is '$OPENFOAM_VERSION' (solver/pins.env)" >&2
  exit 1
fi
echo "package $OPENFOAM_PACKAGE $have matches the pin"

DIR="$WM_PROJECT_USER_DIR/applications/solvers"
mkdir -p "$DIR"
cd "$DIR"
if [ ! -d offbeat ]; then
  echo "== $(date -Is) clone"
  git clone "$OFFBEAT_REPO"
fi
cd offbeat
git cat-file -e "$OFFBEAT_COMMIT^{commit}" 2>/dev/null || git fetch origin
git checkout --detach "$OFFBEAT_COMMIT"
got=$(git rev-parse HEAD)
if [ "$got" != "$OFFBEAT_COMMIT" ]; then
  echo "PIN MISMATCH: OFFBEAT is at $got, the pin is $OFFBEAT_COMMIT (solver/pins.env)" >&2
  exit 1
fi
echo "OFFBEAT commit: $got (the pin)"
git log -1 --format='%cd %s'
ls

echo "== $(date -Is) make"
make -j8

echo "== $(date -Is) done"
which offbeat
du -sh "$DIR/offbeat" "$FOAM_USER_APPBIN" "$FOAM_USER_LIBBIN" 2>/dev/null || true
