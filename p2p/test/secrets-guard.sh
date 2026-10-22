#!/usr/bin/env bash
# Task 5 test: the bridge fails closed on missing credentials, never prints a
# secret value, and secrets.env is gitignored.
#
# PASS when: (1) without XIOT_CAM_PWD the bridge exits non-zero with a clear
# "missing credential" message; (2) with full (dummy) credentials it gets PAST
# the credential checks (no camera needed) without echoing the password; and
# (3) git ignores p2p/secrets.env.
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE=${BRIDGE_IMAGE:-xiot-bridge:latest}
DUMMY_PWD="s3cr3t-$$-DONOTPRINT"

echo "== 1) missing XIOT_CAM_PWD must fail closed =="
out=$(docker run --rm --network none -e XIOT_CAM_UID=TESTUID-000000-XXXXX "$IMAGE" 2>&1; echo "RC=$?")
echo "$out" | sed 's/^/   /'
if echo "$out" | grep -q 'RC=0'; then echo "FAIL: started without a password"; exit 1; fi
if ! echo "$out" | grep -qiE 'missing|XIOT_CAM_PWD'; then echo "FAIL: no clear missing-credential message"; exit 1; fi

echo "== 2) with full credentials, passes the guard without leaking the password =="
CN="xiot-guard-$$"
docker rm -f "$CN" >/dev/null 2>&1
docker run -d --rm --name "$CN" --network none \
  -e XIOT_CAM_UID=TESTUID-000000-XXXXX -e XIOT_CAM_USER=admin -e XIOT_CAM_PWD="$DUMMY_PWD" \
  "$IMAGE" >/dev/null 2>&1 || true
sleep 6
out2=$(docker logs "$CN" 2>&1 || true)
docker rm -f "$CN" >/dev/null 2>&1
echo "$out2" | sed 's/^/   /' | head -6
if echo "$out2" | grep -q "$DUMMY_PWD"; then echo "FAIL: password value leaked to output"; exit 1; fi
if ! echo "$out2" | grep -q '\[bridge\] camera='; then echo "FAIL: did not pass the credential guard with full creds"; exit 1; fi

echo "== 3) secrets.env is gitignored =="
if ! git check-ignore secrets.env >/dev/null 2>&1; then echo "FAIL: p2p/secrets.env is not gitignored"; exit 1; fi

echo "PASS: fails closed, no secret leak, secrets.env gitignored"
