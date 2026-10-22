# Jembatan P2P X-IOT di Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menampilkan kamera X-IOT `XIOTB-021580-TJBSS` live di dashboard `cctv-web-monitor` dari server beda-jaringan, dengan menjalankan library P2P vendor di server lewat jalur relay dan menyalurkan H.264-nya ke go2rtc.

**Architecture:** Satu container "jembatan" menjalankan `libobject_jni.so` (arm64) via emulasi qemu-user + runtime bionic, dengan harness ber-JNIEnv tiruan. Harness login ke akun vendor (agar relay dipakai, tembus NAT), menunggu status `ON_LINE(2)`, menangkap byte[] H.264 dari callback, menulis Annex-B ke stdout; ffmpeg membungkus ke RTSP dan menerbitkannya ke go2rtc; stream didaftarkan lewat REST yang sudah ada sehingga UI/rekaman/snapshot memakai jalur eksisting.

**Tech Stack:** C (harness, NDK r26d clang arm64), Docker + qemu-user binfmt, redroid 9 (bionic runtime), ffmpeg, go2rtc, Node/Express (integrasi), shell (skrip build).

**Spec:** `docs/superpowers/specs/2026-10-22-xiot-p2p-server-bridge-design.md`

## Global Constraints

- Target host: x86_64 tanpa KVM, di belakang NAT; arm64 dijalankan via `docker run` + binfmt qemu-user-static (`docker run --privileged multiarch/qemu-user-static --reset -p yes`).
- Runtime bionic: redroid **9.0.0** arm64 yang diratakan (export→import); Android 10+ TIDAK boleh (linker64 = symlink APEX yang hanya ter-mount saat boot).
- Harness dikompilasi dengan NDK r26d `aarch64-linux-android21-clang -include stddef.h`; JNIEnv value HARUS menunjuk langsung ke tabel fungsi (`g_env = &g_iface`), bukan satu tingkat di atasnya.
- Semua kode baru di bawah `cctv-web-monitor/p2p/` + sentuhan minimal di `server/`. Tidak mengubah kontrak REST/ UI yang ada.
- Kredensial (password kamera + login akun) HANYA lewat `p2p/secrets.env` yang di-`.gitignore`; tidak pernah di repo, image, atau log.
- Git: akhiri commit dengan trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` HANYA bila memory `no-claude-git-attribution` tidak berlaku — memory itu berlaku, jadi JANGAN tambahkan trailer atribusi apa pun.
- Enum status PPPP: 0 CONNECTING, 1 INITIALING, **2 ON_LINE**, 3 CONNECT_FAILED, 4 DISCONNECT, 5 INVALID_ID, 6 DEVICE_NOT_ON_LINE, 7 CONNECT_TIMEOUT, 8 CONNECT_ERRER, 110 OTHER_LOGIN, 255 UNKNOWN. Video hanya mengalir setelah ON_LINE(2).
- UID kamera: `XIOTB-021580-TJBSS`; user `admin`; prefix DID = `XIOTB`.

## Review Focus

- **Login akun gagal/expired** → harness harus melaporkan jelas & berhenti anggun (bukan crash-loop, bukan membocorkan kredensial ke log). Diuji di Task 1.
- **Kamera offline / status DISCONNECT/TIMEOUT di tengah jalan** → bridge reconnect dengan backoff dan status dot UI jadi offline, bukan menggantung. Diuji di Task 4.
- **H.264 tiba tanpa SPS/PPS di awal** → go2rtc tak bisa mulai decode; parameter set harus disisipkan/ditunggu sampai keyframe. Diuji di Task 2.
- **`p2p/secrets.env` hilang/tak lengkap** → startup gagal dengan pesan jelas, tidak jalan tanpa kredensial dan tidak menulis nilai ke stdout. Diuji di Task 5.
- **go2rtc belum siap / restart** saat bridge mulai → bridge menunggu (pakai `waitForGo2rtc`) dan tidak mendaftarkan stream rusak. Diuji di Task 4.

---

## Task 1 — GERBANG GO/NO-GO: login akun → status ON_LINE(2), reproducible

Membuktikan hipotesis inti spec sebelum membangun apa pun di atasnya: dengan login akun, sesi P2P dari host ber-NAT ini mencapai `ON_LINE(2)`. Task ini memfinalkan harness + skrip build yang reproducible (bukan artefak scratchpad spike).

**Files:**
- Create: `p2p/harness.c` (dari harness spike, dibersihkan: JNIEnv benar, env per-thread disimpan, tanpa handler SIGSEGV penambal; tambah pemanggilan login)
- Create: `p2p/stubs.h` (tabel stub JNIEnv ber-indeks, dari spike)
- Create: `p2p/build-runtime.sh` (tarik+ratakan redroid9 → image `xiot-bionic:arm64`)
- Create: `p2p/build-harness.sh` (kompilasi `harness.c` dengan NDK → `p2p/out/harness`)
- Create: `p2p/README.md` (prasyarat: NDK path, binfmt reset, lokasi lib vendor)
- Create: `p2p/libs/` (← tempat 8 .so vendor: `libobject_jni.so` + ffmpeg bundel + `libc++_shared.so`, disalin dari APK split; dicatat di README, di-`.gitignore` bila dianggap artefak redistribusi)
- Test: `p2p/test/gate-online.sh`

**Interfaces:**
- Produces: image docker `xiot-bionic:arm64`; binary `p2p/out/harness` yang menerima arg `UID USER PWD` dan membaca env `XIOT_ACC_USER`, `XIOT_ACC_PWD` (login akun); mencetak baris status `STATUS <uid> <type> <param>` ke stderr dan `ONLINE`/`TIMEOUT` ringkas; keluar 0 bila ON_LINE tercapai, non-0 bila tidak.
- Produces: urutan panggilan login yang terbukti (dipakai Task 2+).

- [ ] **Step 1: Tulis test gerbang (checkable result)**

`p2p/test/gate-online.sh`: jalankan harness di image `xiot-bionic:arm64` dengan `--network host`, kredensial dari `p2p/secrets.env`, selama ≤90 dtk; LULUS bila stderr memuat baris status dengan `param=2` (ON_LINE) untuk UID target. Cetak status tertinggi yang dicapai.

```sh
# inti assertion
grep -qE "STATUS .*XIOTB-021580-TJBSS .* 2$" "$LOG" && echo PASS || { echo "FAIL (max status: $(grep -oE 'STATUS .* [0-9]+$' "$LOG" | tail -1))"; exit 1; }
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL dulu**

Run: `bash p2p/test/gate-online.sh`
Expected: FAIL dengan status tertinggi 7 (CONNECT_TIMEOUT) — kondisi pra-login dari spike.

- [ ] **Step 3: Investigasi + implementasi login akun di `harness.c`**

Tentukan jalur termudah dari dua ini dan implementasikan:
(a) panggil fungsi JNI login yang sudah ada di lib — `Java_..._BZUserLogin(user,pwd)` / `BZUserLoginThree`, didahului `RegistAppInfo`/`SHIXGetAPPKey`/`SHIXGetAPPSer` sesuai yang dibutuhkan; atau
(b) replikasi HTTP ke host dari `SHIXGetAPPSer` (cyczcam.com) lalu suntik token.
Panggil login SEBELUM `StartPPPP`. Baca kredensial dari env `XIOT_ACC_USER`/`XIOT_ACC_PWD`. Pakai REA (`reverse-engineer-anything`) untuk membongkar urutan + argumen `BZUserLogin` bila perlu. Jangan cetak nilai kredensial ke log.

- [ ] **Step 4: Jalankan test, pastikan LULUS (GERBANG)**

Run: `bash p2p/test/gate-online.sh`
Expected: PASS (`param=2`). **Jika tetap gagal** setelah login (mis. mentok 7/6): BERHENTI, catat status tertinggi + temuan di `p2p/README.md`, dan kembali ke pemilik untuk tinjauan (§8 spec) sebelum Task 2. Jangan lanjut membangun bridge di atas gerbang yang belum lolos.

- [ ] **Step 5: Commit**

```bash
git add p2p/ && git commit -m "p2p: reproducible arm64 harness + account login reaching ON_LINE (go/no-go gate)"
```

---

## Task 2 — Tangkap H.264 jadi stream Annex-B yang valid & bisa didecode

**Files:**
- Modify: `p2p/harness.c` (setelah ON_LINE → `StartPPPPLivestream(uid, streamType)`; dispatch callback `VideoData`/`CallBack_H264Data`/`CallBack_VideoTrans_H264H265` → tulis Annex-B ke stdout; pastikan mulai pada keyframe + SPS/PPS)
- Test: `p2p/test/capture-valid.sh`

**Interfaces:**
- Consumes: harness yang ON_LINE (Task 1).
- Produces: harness menulis H.264 Annex-B mentah ke **stdout** (fd 1); baris status/log ke stderr (fd 2) saja. Arg `streamType` (0/1) dari env `XIOT_STREAM` (default 1).

- [ ] **Step 1: Tulis test**

`p2p/test/capture-valid.sh`: jalankan harness, redirect stdout ke `cap.h264` selama ~25 dtk, lalu `ffprobe` harus mengenali video H.264 dengan ≥1 frame dan resolusi > 0.

```sh
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv "$CAP" | grep -qE '^stream,h264,[1-9][0-9]+,[1-9][0-9]+' && echo PASS || exit 1
```

- [ ] **Step 2: Jalankan test, pastikan GAGAL** (stdout belum berisi video). Expected: ffprobe gagal/0 frame.

- [ ] **Step 3: Implementasi penulisan Annex-B**

Di dispatch callback video: ambil arg `byte[]`, tulis apa adanya ke stdout (SDK sudah Annex-B). Buffer sampai keyframe pertama (NAL IDR `0x65` / tipe 5) sebelum mulai menulis; bila kamera tak mengirim SPS/PPS rutin, simpan dari paket awal dan sisipkan sebelum keyframe. Pisahkan log ke stderr.

- [ ] **Step 4: Jalankan test, pastikan LULUS** (ffprobe mengenali H.264 berdimensi). 

- [ ] **Step 5: Commit** `git commit -m "p2p: stream live H.264 Annex-B to stdout, start on keyframe"`

---

## Task 3 — Container jembatan → terbitkan ke go2rtc

**Files:**
- Create: `p2p/Dockerfile.bridge` (base `xiot-bionic:arm64`; salin `p2p/libs/` + `p2p/out/harness` + `entrypoint.sh`; butuh ffmpeg — sediakan ffmpeg arm64 atau jalankan ffmpeg di luar container lewat pipe, lihat Step 3)
- Create: `p2p/entrypoint.sh` (`harness … | ffmpeg -f h264 -i - -c copy -rtsp_transport tcp -f rtsp "$GO2RTC_PUBLISH"`)
- Test: `p2p/test/bridge-go2rtc.sh`

**Interfaces:**
- Consumes: harness stdout H.264 (Task 2).
- Produces: sebuah stream RTSP yang diterbitkan ke go2rtc pada nama `<id>`; dapat didaftarkan via `registerStream(id, src)` dengan `src` = `exec:` yang menjalankan entrypoint ini dan memakai placeholder `{output}` go2rtc sebagai tujuan publish.

- [ ] **Step 1: Tulis test**

`p2p/test/bridge-go2rtc.sh`: start go2rtc (compose service yang ada), daftarkan stream P2P via REST, tunggu, lalu `GET /api/frame.jpeg?src=<id>` harus mengembalikan JPEG > 1KB.

- [ ] **Step 2: Jalankan test, pastikan GAGAL** (stream belum terdaftar). Expected: 404/kosong.

- [ ] **Step 3: Implementasi bridge + wiring go2rtc**

Putuskan mekanisme ffmpeg (keputusan implementasi; default: go2rtc `exec:` source menjalankan entrypoint, ffmpeg mem-`-f rtsp {output}` ke go2rtc). Tangani: container butuh `--network host` + binfmt; hidup saat ada penonton. Bangun `Dockerfile.bridge` + `entrypoint.sh`.

- [ ] **Step 4: Jalankan test, pastikan LULUS** (frame.jpeg valid).

- [ ] **Step 5: Commit** `git commit -m "p2p: bridge container publishes camera to go2rtc"`

---

## Task 4 — Integrasi server Node + cameras.json + status dot + reconnect

**Files:**
- Create: `p2p/status.js` (parse baris `STATUS <uid> <type> <param>` → {state, code}; map ke label UI)
- Modify: `server/go2rtc.js` atau baru `server/p2p.js` (daftarkan kamera `p2p` ke go2rtc dgn `src` exec bridge; kelola reconnect/backoff)
- Modify: `server/index.js` (muat kamera tipe `p2p` dari `cameras.json`; sertakan status P2P ke endpoint status yang dipakai dot UI)
- Modify: `cameras.example.json` (contoh entri `p2p`)
- Test: `server/test/p2p-status.test.mjs` (atau pola test yang dipakai proyek)

**Interfaces:**
- Consumes: bridge (Task 3); `registerStream`/`streamInfo` eksisting.
- Produces: kamera dengan field `p2p:{uid,user,streamType}` tampil sebagai stream go2rtc `<id>`; status P2P terpetakan ke dot (online/connecting/offline).

- [ ] **Step 1: Tulis unit test parser status**

`parseStatus("STATUS XIOTB-021580-TJBSS 0 2")` → `{code:2, state:"online"}`; `… 0 7` → `{state:"timeout"}`; `… 0 4` → `{state:"offline"}`. Dan test reconnect: saat state offline/timeout, penjadwal memanggil ulang start dengan backoff (pakai fake timer).

- [ ] **Step 2: Jalankan test, pastikan GAGAL** (modul belum ada).

- [ ] **Step 3: Implementasi `parseStatus()` + registrasi kamera p2p + reconnect/backoff**

`parseStatus(line: string) -> {code:number, state:"online"|"connecting"|"timeout"|"offline"|"invalid"|"unknown"}`. Registrasi: untuk tiap kamera `p2p`, `registerStream(id, execSrc(cam))`. Reconnect: saat status bukan online dalam N dtk atau drop, re-register/restart dgn backoff eksponensial bertopi.

- [ ] **Step 4: Jalankan test, pastikan LULUS.**

- [ ] **Step 5: Commit** `git commit -m "p2p: node integration, cameras.json p2p type, status mapping + reconnect"`

---

## Task 5 — Secret, lifecycle (compose/boot), dokumentasi

**Files:**
- Modify: `docker-compose.yml` (service `p2p-bridge` / atau go2rtc exec; `--network host`, `restart: always`, binfmt prasyarat didokumentasikan; mount `p2p/secrets.env`)
- Create: `p2p/secrets.example.env` (`XIOT_ACC_USER=`, `XIOT_ACC_PWD=`, `XIOT_CAM_PWD=`)
- Modify: `.gitignore` (tambah `p2p/secrets.env`, `p2p/out/`, `p2p/libs/*.so`)
- Modify: `README.md` (bagian "Kamera X-IOT P2P": prasyarat binfmt, build runtime/harness, isi secrets, batasan: bergantung relay/cloud vendor)
- Test: `p2p/test/secrets-guard.sh`

**Interfaces:**
- Consumes: semua task sebelumnya.
- Produces: sistem yang bangkit saat boot, baca secret dari file, dan gagal-anggun bila secret kurang.

- [ ] **Step 1: Tulis test**

`p2p/test/secrets-guard.sh`: jalankan bridge tanpa `XIOT_ACC_PWD` → keluar non-0 dengan pesan "missing credential" dan TIDAK mencetak nilai apa pun; dengan secret lengkap → lanjut. Dan: `git check-ignore p2p/secrets.env` harus cocok.

- [ ] **Step 2: Jalankan test, pastikan GAGAL.**

- [ ] **Step 3: Implementasi guard kredensial + compose + gitignore + README.**

- [ ] **Step 4: Jalankan test, pastikan LULUS.**

- [ ] **Step 5: Commit** `git commit -m "p2p: secrets guard, compose lifecycle, docs"`

---

## Catatan eksekusi

Task 1 adalah gerbang. Jangan mulai Task 2–5 sebelum Task 1 Step 4 PASS. Bila gerbang gagal walau login sudah benar, berhenti dan tinjau bersama pemilik (kemungkinan perlu host jaringan lain atau pendekatan lain — §8 spec).
