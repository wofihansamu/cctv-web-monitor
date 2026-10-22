#!/usr/bin/env bash
# Cross-compile the P2P harness for arm64 Android (bionic) with the NDK.
# Output: p2p/out/harness
#
# Prereq: Android NDK r26d (or compatible) installed; set ANDROID_NDK to its
# root, or place it so $ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
# exists. See p2p/README.md.
set -euo pipefail
cd "$(dirname "$0")"

NDK=${ANDROID_NDK:?set ANDROID_NDK to the NDK root (see p2p/README.md)}
CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android21-clang"
[ -x "$CC" ] || { echo "clang not found: $CC"; exit 1; }

mkdir -p out
"$CC" -O1 -fPIC -pie -include stddef.h -o out/harness harness.c -ldl
echo "[build-harness] built out/harness"
file out/harness | sed 's/^/[build-harness] /'
