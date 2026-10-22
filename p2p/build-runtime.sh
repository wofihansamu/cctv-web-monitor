#!/usr/bin/env bash
# Build the arm64 bionic runtime image `xiot-bionic:arm64` used to run the
# vendor P2P library under qemu-user emulation on an x86_64 host.
#
# Why Android 9: its /system/bin/linker64 is a real file. Android 10+ makes it
# an APEX symlink that only mounts when Android boots, so a non-booted container
# fails with "Could not open /system/bin/linker64".
#
# Idempotent: skips the (large) pull/flatten if the image already exists.
set -euo pipefail

IMAGE=${IMAGE:-xiot-bionic:arm64}
SRC=${SRC:-redroid/redroid:9.0.0-latest}

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[build-runtime] $IMAGE already present; skipping. (set FORCE=1 to rebuild)"
  [ "${FORCE:-0}" = "1" ] || exit 0
fi

echo "[build-runtime] registering arm64 binfmt (qemu-user-static)"
docker run --privileged --rm multiarch/qemu-user-static --reset -p yes >/dev/null

echo "[build-runtime] pulling $SRC (arm64, large)"
docker pull --platform linux/arm64 "$SRC"

echo "[build-runtime] flattening to $IMAGE (drops APEX/volume indirection)"
cid=$(docker create --platform linux/arm64 "$SRC")
trap 'docker rm "$cid" >/dev/null 2>&1 || true' EXIT
docker export "$cid" | docker import -c 'ENV LD_LIBRARY_PATH=/work:/system/lib64' - "$IMAGE" >/dev/null
echo "[build-runtime] done: $IMAGE"
