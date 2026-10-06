#!/usr/bin/env bash
# Collects the licence texts of the PINNED solver stack from the feed-solver distro into one folder, with a SHA256SUMS file
# (F0 exit review, finding 9). Run as user "feed". It stops if the OFFBEAT commit or the OpenFOAM package version differs from
# solver/pins.env, so the texts always belong to the pinned versions.
# usage: collect-licences.sh <outDir (path visible in the distro, for example /mnt/c/.../docs/licences/third-party)>
# Nothing is deleted; existing files of the same names are overwritten.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/pins.env"
OUT="$1"
OFF="$HOME/OpenFOAM/feed-9/applications/solvers/offbeat"

got=$(git -C "$OFF" rev-parse HEAD)
if [ "$got" != "$OFFBEAT_COMMIT" ]; then
  echo "PIN MISMATCH: OFFBEAT is at $got, the pin is $OFFBEAT_COMMIT (solver/pins.env)" >&2
  exit 1
fi
have=$(dpkg-query -W -f='${Version}' "$OPENFOAM_PACKAGE" 2>/dev/null || true)
if [ "$have" != "$OPENFOAM_VERSION" ]; then
  echo "PIN MISMATCH: package $OPENFOAM_PACKAGE is '$have', the pin is '$OPENFOAM_VERSION' (solver/pins.env)" >&2
  exit 1
fi
# the working tree may differ from the commit only by the symlink OFFBEAT's build repoints to select the Foundation variant
other=$(git -C "$OFF" status --porcelain | grep -v 'offbeatLib/Make/files$' || true)
if [ -n "$other" ]; then
  echo "the OFFBEAT working tree has changes besides offbeatLib/Make/files:" >&2
  echo "$other" >&2
  exit 1
fi

mkdir -p "$OUT"
cp "$OFF/LICENSE" "$OUT/OFFBEAT-LICENSE.txt"
cp "$OFF/SCIANTIX/LICENSE" "$OUT/SCIANTIX-LICENSE.txt"
cp /opt/openfoam9/COPYING "$OUT/OpenFOAM-9-COPYING.txt"
cp /usr/share/doc/openfoam9/copyright "$OUT/openfoam9-debian-copyright.txt"
cp /opt/openfoam9/src/OpenFOAM/db/IOstreams/gzstream/COPYING.LIB "$OUT/openfoam9-gzstream-COPYING.LIB.txt"
(cd "$OUT" && sha256sum OFFBEAT-LICENSE.txt SCIANTIX-LICENSE.txt OpenFOAM-9-COPYING.txt openfoam9-debian-copyright.txt openfoam9-gzstream-COPYING.LIB.txt > SHA256SUMS)
echo "collected from OFFBEAT $got and $OPENFOAM_PACKAGE $have:"
cat "$OUT/SHA256SUMS"
