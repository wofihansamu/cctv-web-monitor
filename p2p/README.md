# Kamera X-IOT P2P (jembatan di server)

Menjalankan library P2P vendor X-IOT (`libobject_jni.so`, arm64) di server x86
lewat emulasi, login ke akun vendor agar memakai relay (tembus NAT), lalu
menyalurkan H.264 ke go2rtc. Lihat
`../docs/superpowers/specs/2026-10-22-xiot-p2p-server-bridge-design.md` dan
`../docs/superpowers/plans/2026-10-22-xiot-p2p-server-bridge.md`.

## Prasyarat

- Docker, dan binfmt arm64 (didaftarkan otomatis oleh `build-runtime.sh`).
- Android NDK r26d. Set `ANDROID_NDK` ke root NDK sebelum `build-harness.sh`.
- Library vendor di `p2p/libs/` (dari split APK arm64_v8a): `libobject_jni.so`,
  `libav*.so`, `libsw*.so`, `libpostproc.so`, `libc++_shared.so`. Ini artefak
  vendor; tidak di-commit ke git (lihat `.gitignore`).

## Build

```bash
./p2p/build-runtime.sh          # bikin image xiot-bionic:arm64 (sekali, besar)
ANDROID_NDK=/path/ke/ndk ./p2p/build-harness.sh   # kompilasi p2p/out/harness
```

## Kredensial

Salin `secrets.example.env` → `secrets.env` (di-gitignore) dan isi:

- `XIOT_CAM_UID` — UID kamera (mis. `XIOTB-021580-TJBSS`)
- `XIOT_CAM_USER` — default `admin`
- `XIOT_CAM_PWD` — password kamera
- `XIOT_ACC_USER` / `XIOT_ACC_PWD` — login akun aplikasi X-IOT CAM (dibutuhkan
  untuk jalur relay; lihat gerbang go/no-go di plan Task 1)

## Gerbang go/no-go

```bash
./p2p/test/gate-online.sh       # PASS bila status kamera mencapai ON_LINE(2)
```

Status pra-login mentok di `CONNECT_TIMEOUT(7)` dari host ber-NAT — itulah
alasan login akun diperlukan (Task 1 Step 3). Jangan lanjut ke bridge/go2rtc
sebelum gerbang ini PASS.

## Batasan

Bergantung pada cloud/relay vendor tetap hidup; bukan solusi offline. Berjalan
lewat emulasi arm64 (boros CPU untuk stream kontinu).
