# Rancangan: Jembatan P2P X-IOT di server (Opsi A)

Tanggal: 2026-10-22
Status: draft untuk ditinjau
Konteks terkait: `memory/xiot-cam-p2p-protocol.md`, `memory/xiot-p2p-spike.md`, `memory/cctv-web-monitor-project.md`

## 1. Maksud & alasan (intent & why)

Pemilik ingin memantau kamera X-IOT CAM (`shix.go.zoom`, SDK `object.p2pipcam` / CS2 PPCS) lewat web-app sendiri (`cctv-web-monitor`) yang berjalan di **server mereka**. Kamera **tidak satu jaringan** dengan server, dan APK tidak mengekspos RTSP/ONVIF — satu-satunya jalur dari internet adalah **P2P milik vendor** memakai ID kamera + password. Maka satu-satunya cara memperoleh video tanpa menyentuh firmware kamera adalah **menjalankan library P2P vendor (`libobject_jni.so`, arm64) di server** dan menyalurkan video H.264 yang keluar ke mesin media open-standard (`go2rtc`) yang sudah dipakai proyek ini.

Kenapa sekarang: proyek `cctv-web-monitor` sudah punya live view (WebRTC via go2rtc), rekaman, snapshot, dan hapus-rekaman untuk kamera RTSP/ONVIF. Kamera X-IOT pengguna belum bisa masuk karena hanya P2P. Rancangan ini menambal satu lubang itu.

Sukses (definition of done untuk v1): kamera X-IOT `XIOTB-021580-TJBSS` tampil **live** di dashboard `cctv-web-monitor` dari server yang berbeda jaringan, dengan kestabilan yang cukup untuk dipantau (reconnect otomatis saat putus), memakai fitur live/rekam/snapshot yang sudah ada.

## 2. Temuan spike yang menjadi dasar (fakta, bukan asumsi)

Dari spike 2026-10-22 (lihat `memory/xiot-p2p-spike.md`):

- Library vendor **berhasil dijalankan di host x86 ini** lewat emulasi ARM (qemu-user via binfmt) + runtime bionic Android 9 (image `redroid:9.0.0` diratakan), dengan **harness ber-JNIEnv tiruan** (tanpa Android/ART penuh).
- Urutan `PPPPInitial → Init → PPPPNetworkDetect → PPPPSetCallbackContext → StartPPPP → StartPPPPLivestream` berjalan; `StartPPPP` mengembalikan handle sesi.
- Setelah bug pointer JNIEnv diperbaiki (`g_env` harus menunjuk langsung ke tabel fungsi), **19 callback terdaftar** dan callback status perangkat mengalir ke kode kita.
- Cloud vendor **mengenali ID kamera** (bukan `INVALID_ID`). Status yang diterima: `PPPPMsgNotify(type=0, param=0→7)` = `CONNECTING → CONNECT_TIMEOUT`.
- Pengguna mengonfirmasi kamera **live di app HP** saat itu → kamera & cloud sehat.
- Host berada **di belakang NAT** (sumber `10.0.2.15`, pola VirtualBox NAT). Dugaan kuat: hole-punch P2P langsung gagal karena NAT; app HP berhasil karena jaringan lebih ramah dan/atau sudah **login akun** sehingga memakai **relay** vendor (lewat server, tembus NAT).
- Enum status (dari `ContentCommon`): 0 CONNECTING, 1 INITIALING, **2 ON_LINE**, 3 CONNECT_FAILED, 4 DISCONNECT, 5 INVALID_ID, 6 DEVICE_NOT_ON_LINE, 7 CONNECT_TIMEOUT, 8 CONNECT_ERRER, 110 OTHER_LOGIN, 255 UNKNOWN. Video (callback `VideoData`/`CallBack_H264Data`/`CallBack_VideoTrans_H264H265`) baru mengalir setelah status **ON_LINE(2)**.

Implikasi utama untuk rancangan: **jalur andal adalah relay vendor**, dan relay kemungkinan **butuh token login akun** aplikasi (cloud `cyczcam.com`, via `BZUserLogin` + `SHIXGetAPPKey/Ser`). Ini mengubah lingkup: v1 bukan sekadar "UID+pwd", tapi "login akun → relay → stream".

## 3. Goals / Non-goals / Anti-goals

Goals (v1):
- Kamera X-IOT tampil live di dashboard dari server beda-jaringan, melalui relay vendor sehingga tahan NAT.
- Integrasi memakai ulang go2rtc + UI + status dot yang sudah ada; kamera P2P didaftarkan sebagai satu stream go2rtc biasa.
- Reconnect otomatis & pelaporan status (CONNECTING/ON_LINE/TIMEOUT/…) ke UI.
- Kredensial (password kamera + login akun) disimpan sebagai secret, **tidak** masuk repo/git.
- Build runtime (image bionic + harness) **reproducible** lewat skrip, bukan langkah manual.

Non-goals (v1, bisa menyusul):
- Audio, two-way talk, PTZ, playback SD kamera, format SD untuk kamera P2P. (Rekaman server-side bisa otomatis ikut begitu ada stream RTSP internal, tapi tidak dijanjikan di v1.)
- Mendukung semua prefix DID / semua model kamera vendor; fokus ke prefix XIOTB milik pengguna, dengan desain yang tidak menutup prefix lain.
- Menggantikan P2P dengan reimplementasi protokol CS2 murni (itu Opsi B yang ditolak sebelumnya).

Anti-goals (tanda kegagalan walau "jalan"):
- Menaruh password/kredensial akun di dalam image atau git.
- Solusi yang hanya jalan sekali secara manual dan tidak bisa bangkit sendiri setelah restart/putus.
- Bergantung pada "tambalan" rapuh (mis. handler SIGSEGV yang menambal null-env) sebagai mekanisme produksi, bukan sekadar alat diagnosa spike.
- Menyentuh/menulis ke firmware atau SD kamera sebagai efek samping hanya untuk menampilkan live.

## 4. Kendala (constraints)

- Host: x86_64, tanpa KVM, apt terblokir, tapi Docker registry + https egress jalan, dan binfmt qemu-user bisa didaftarkan. Di belakang NAT.
- Library vendor: arm64 Android (bionic), butuh JNIEnv/JavaVM; closed-source; mengandung ffmpeg bundel + modul analitik (tidak dibutuhkan).
- Jalur jaringan: P2P langsung kemungkinan gagal karena NAT → wajib relay. Relay kemungkinan butuh login akun.
- Legal/etika: kamera & akun milik pengguna sendiri; kredensial diberikan pengguna; hanya untuk interoperabilitas perangkat sendiri.
- Ketergantungan cloud vendor: solusi ini **tidak** sepenuhnya offline — bergantung pada server/relay vendor tetap hidup. Ini diterima sebagai konsekuensi Opsi A.

## 5. Arsitektur (keputusan yang sudah diambil)

Komponen baru, semuanya di dalam `cctv-web-monitor`:

1. **Image runtime `xiot-bionic` (build artifact).** Skrip `p2p/build-runtime.sh` menarik `redroid:9.0.0` (arm64), meratakannya (export→import) menjadi image berisi bionic linker64 + `/system/lib64`. Didokumentasikan + dapat diulang. (Alasan Android 9: linker64 file nyata, bukan symlink APEX yang hanya ter-mount saat boot.)

2. **Harness P2P `p2p/harness.c` (produksi, dari versi spike).** Memuat `libobject_jni.so` dengan JNIEnv/JavaVM tiruan yang lengkap dan benar (pointer env menunjuk tabel; env per-thread disimpan dengan benar sehingga tidak perlu handler SIGSEGV penambal). Alur: login akun → set callback → `StartPPPP` → tunggu status **ON_LINE(2)** → `StartPPPPLivestream(stream)` → tangkap byte[] H.264 dari callback video → tulis Annex-B ke stdout. Callback status dicetak sebagai baris terstruktur ke stderr untuk dibaca pengawas.

3. **Modul login akun (wajib v1; cara = investigasi).** Pemilik memakai akun, jadi langkah-1 implementasi adalah mereplikasi login cloud vendor (`cyczcam.com`, `BZUserLogin`/`RegistAppInfo`/`SHIXGetAPPKey/Ser`) agar sesi P2P diotorisasi memakai relay. Ini gerbang go/no-go: jika setelah login status mencapai ON_LINE(2) dari host ber-NAT ini, lanjut; jika tidak, hentikan & tinjau (§8) sebelum membangun sisanya. Bentuk pastinya (HTTP tiruan vs panggil fungsi `BZUserLogin` JNI) ditentukan saat implementasi (§7). Kredensial akun lewat env/secret.

4. **Container jembatan `p2p-bridge` (satu proses, per kamera untuk v1).** Menjalankan harness di image `xiot-bionic` via qemu, stdout H.264 dialirkan ke `ffmpeg` yang membungkus menjadi RTSP/RTP dan **menerbitkannya ke go2rtc**. Mekanisme penerbitan: sumber `exec:` go2rtc dengan placeholder `{output}` (go2rtc menyediakan URL RTSP tujuan), atau sidecar yang `ffmpeg … -f rtsp rtsp://<go2rtc>:8554/<id>`. Default yang disarankan: **go2rtc `exec:` source** agar siklus hidup stream dikelola go2rtc (start saat ada penonton, restart saat mati).

5. **Pendaftaran stream + konfigurasi kamera.** Tipe kamera baru di `cameras.json`, mis.:
   ```json
   { "id": "teras", "name": "Teras", "p2p": { "uid": "XIOTB-021580-TJBSS", "user": "admin", "streamType": 1 }, "record": true }
   ```
   Password kamera & kredensial akun **tidak** di sini — lewat secret (env/file). Server (`server/go2rtc.js` + `server/index.js`) mendaftarkan stream P2P ini ke go2rtc memakai `registerStream(id, src)` yang sudah ada, dengan `src` berupa `exec:` ke jembatan. UI, status dot, snapshot, rekaman memakai jalur yang sudah ada tanpa perubahan besar.

6. **Pengawas status.** Server membaca baris status harness (ON_LINE/TIMEOUT/…) dan memetakannya ke status dot UI; reconnect otomatis dengan backoff saat DISCONNECT/TIMEOUT.

Aliran data: `kamera ⇄ relay vendor ⇄ harness (di server, via qemu) → H.264 stdout → ffmpeg → go2rtc → WebRTC → browser`.

## 6. Keputusan "bagaimana" yang saya ambil (sebagai penulis rancangan, bukan disetujui pengguna)

- Runtime bionic lewat redroid 9 yang diratakan (bukan NDK sysroot yang tak punya linker; bukan Android penuh/redroid-boot yang butuh binder).
- Satu container jembatan **per kamera** di v1 (lebih sederhana & terisolasi); multipleks banyak kamera dalam satu proses ditunda (lihat §7).
- Video dibawa ke go2rtc sebagai sumber `exec:` (hidup saat ditonton), bukan selalu-on, untuk hemat sumber daya emulasi.
- Harness produksi **tidak** memakai handler SIGSEGV penambal; env di-wire benar sejak awal.
- Kredensial via secret/env; tidak pernah di repo atau image. Konkret: file `p2p/secrets.env` (di-`.gitignore`) berisi password kamera + login akun, di-inject ke container jembatan sebagai env; tidak pernah ditulis ke image atau log.
- Target deploy = **host ini** (sesuai arahan pengguna), yang ber-NAT; karena itu relay wajib. Ketergantungan pada cloud/relay vendor diterima sebagai konsekuensi Opsi A (keputusan pengguna sebelumnya).
- Gating: `StartPPPPLivestream` hanya dipanggil setelah status ON_LINE(2); sebelum itu hanya reconnect.
- Bahasa & lokasi dokumen mengikuti konvensi proyek; semua kode baru di bawah `cctv-web-monitor/p2p/` + sedikit sentuhan di `server/`.

## 7. Diserahkan ke pembangun (investigasi + detail implementasi)

1. **Reverse + implementasi login akun cloud.** Tentukan endpoint & kripto `cyczcam.com` (atau host dari `SHIXGetAPPSer`), alur `BZUserLogin`/`RegistAppInfo`, dan token/daftar-server per-akun & per-DID yang membuat relay dipakai. Konfirmasi hipotesis: setelah login, status mencapai ON_LINE(2) dari host ber-NAT ini. Jika login via library (fungsi `BZUserLogin` JNI) lebih mudah daripada meniru HTTP, pakai itu.
2. **Paksa mode relay bila perlu.** Jika login akun saja belum cukup menembus NAT, cari sakelar relay/supernode di SDK (string `..._se_chg_svr_tcp`, relay) dan paksa jalur relay.
3. **Wiring go2rtc `exec:` final.** Bentuk perintah tepat (placeholder `{output}`, `-rtsp_transport tcp`, `-c copy`), penanganan SPS/PPS/keyframe H.264 agar go2rtc bisa mulai memutar (sisipkan parameter set bila kamera tidak mengirim rutin).
4. **Per-kamera vs multipleks.** Jika pengguna akan menambah banyak kamera, pertimbangkan satu proses harness multi-sesi (SDK mendukung banyak `StartPPPP`), menimbang biaya emulasi.
5. **Hardening harness:** penyimpanan env per-thread yang benar, penanganan `TransferMessage` bila stream butuh perintah mulai eksplisit, pemetaan `streamType` (0/1) ke kualitas.
6. **Siklus hidup & boot:** systemd/compose agar jembatan bangkit saat boot & reconnect; pembersihan image besar (~5 GB) atau pengecilan runtime.

## 8. Risiko & rencana cadangan

- **Relay tetap gagal / butuh lebih dari login.** Kemungkinan terbesar penghambat. Mitigasi: uji login akun secepatnya sebagai langkah pertama implementasi (gerbang go/no-go) sebelum membangun sisanya.
- **Emulasi rapuh/berat.** qemu-user untuk stream kontinu bisa boros CPU. Mitigasi: ukur; bila berat, pertimbangkan host ARM atau akselerasi.
- **Ketergantungan cloud vendor.** Bila vendor mengubah server/kripto, solusi bisa rusak. Diterima untuk Opsi A; dicatat sebagai utang.
- **Stabilitas jangka panjang.** Jika terbukti terlalu rapuh, pertimbangkan ulang (mis. perangkat jembatan kecil di sisi kamera yang mengekspor RTSP ke VPN) — di luar lingkup v1.

## 9. Pertanyaan untuk pemilik (hanya pemilik yang bisa menjawab)

1. **Login akun aplikasi (gerbang go/no-go).** Login apa yang dipakai di app X-IOT CAM (nomor HP / email + password), dan apakah bersedia menyediakannya saat implementasi langkah-1? Tanpa ini, jalur relay (yang menembus NAT) tidak bisa diuji. Nilai kredensial diberikan nanti saat dibutuhkan, bukan sekarang, dan disimpan sebagai secret.
2. **Lingkup v1.** Cukup live view dulu, atau sekaligus rekaman untuk kamera ini sejak awal? (PTZ, audio, two-way, playback SD = di luar v1 kecuali diminta.)
3. **Jumlah kamera.** Hanya kamera ini, atau akan ada beberapa kamera X-IOT lagi? (Menentukan desain per-kamera vs multipleks.)

Jawaban pemilik (2026-10-22):
1. **Login akun: pakai akun, siap diberikan.** Pemilik login di app dengan akun dan bersedia menyediakannya saat langkah implementasi login. → Jalur relay berbasis login akun adalah jalur resmi v1; kredensial diberikan saat langkah-1 dan disimpan sebagai secret.
2. **Lingkup v1: live view dulu.** Rekaman, PTZ, audio, two-way, playback SD = di luar v1 (boleh menyusul).
3. **Jumlah kamera: hanya kamera ini** (`XIOTB-021580-TJBSS`). → Desain per-kamera sederhana; multipleks tidak perlu untuk v1.
