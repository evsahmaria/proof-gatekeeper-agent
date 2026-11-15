# Proof Gatekeeper Agent — Agent Games Season 01

Agen HTTPS untuk track **Proof Gatekeeper** di [Agent Games](https://agentgames.zkverify.io/) (zkVerify).
Agen menerima tugas pembayaran berbasis bukti ZK, memutuskan **APPROVE** atau **REJECT**
secara deterministik dalam 60 detik, dan (opsional) melampirkan bukti Groth16.

> Dibuat untuk Queen. Akun Agent Games sudah dibuat lewat X pada 15 Nov 2026.
> Kompetisi berakhir 21 Nov 2026. Jangan pernah mengirim kata sandi, seed phrase,
> private key, atau HMAC secret lewat chat — semua secret hanya di pengaturan
> environment hosting.

## Yang sudah jadi

- [x] **7 cek jebakan lengkap** dari halaman event, fail-closed (ragu = REJECT):
  `VALID_CONDITION`, `VK_SUBSTITUTION`, `THRESHOLD_MISMATCH`, `PROOF_REUSED`,
  `EXPIRED_CONDITION`, `RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`.
  Perbandingan angka memakai BigInt (aman di atas 2^53), alamat/VK dibandingkan
  tanpa peduli huruf besar/kecil dan prefix `0x`.
- [x] **Verifikasi HMAC** atas raw body sebelum parsing, header
  `x-agent-games-signature`. Respons juga ditandatangani dengan header yang sama.
  Mendukung secret hex 64 karakter, base64 32-byte, atau string UTF-8.
- [x] **Idempotensi**: `task_id` dipakai sebagai kunci. Retry dari platform
  mengembalikan respons persis yang sama.
- [x] **Seen-set persisten**: hanya `proof_tx` yang pernah di-APPROVE yang
  dicatat, untuk mendeteksi `PROOF_REUSED` walau server restart.
- [x] **Fail-closed + cepat**: keputusan murni < 5 ms. Error tak terduga
  tetap mengembalikan REJECT, bukan timeout. Budget total 50 detik (di bawah
  batas 60 detik platform) untuk kerja proof/Kurier.
- [x] **Health check**: `GET /health`, `GET /healthz`, `GET /`. Preflight
  dijawab cepat dengan `200 {"status":"ok"}`.
- [x] **14 unit test lolos** (semua 7 jebakan + batas + BigInt + parsing) dan
  uji server end-to-end lolos (health, APPROVE, replay idempoten, PROOF_REUSED,
  VK_SUBSTITUTION, HMAC 401/200).
- [x] Endpoint fleksibel: `POST /`, `/agent`, `/task`, `/decide`, `/api/task`,
  `/api/agent` — semuanya handler yang sama. Daftarkan satu URL persis yang
  kamu deploy (disarankan `https://domain-kamu/agent`).

## Yang BELUM bisa dipastikan dari halaman publik — wajib cek di dashboard

Halaman publik tidak menuliskan semua detail kabel (wire format). Kode ini
membuat pilihan yang paling masuk akal dan mendokumentasikannya, tapi kamu
**wajib** memverifikasi lewat Practice Mode sebelum ronde berbobot:

1. **Nama field respons untuk bukti.** Contoh di halaman event hanya menampilkan
   `{decision, reason_code, proof_tx}`. Halaman Build menyuruh "include the proof
   in your response". Kode ini melampirkan `proof`, `publicSignals`, `vkHash`,
   dan `proofReference` (bila ada) — jika Practice Mode menolak field tersebut,
   ubah di `src/server.js` bagian "Field names below" dan uji lagi.
2. **Nama 13 sinyal input circuit.** Halaman Build tidak mencantumkan nama
   sinyal input circuit gatekeeper di teks halaman. Modul proof (`src/proof.js`)
   **menolak menebak** nama sinyal: proof hanya dibuat bila kamu mengisi
   `circuits/inputs.json` dari starter prompt dashboard / dokumentasi circuit.
   Tanpa itu, agen tetap menjawab keputusan (+12/-3) tapi tanpa bonus reliabilitas
   dan kena -2 tambahan per tugas provable. Lihat bagian "Bukti Groth16" di bawah.
3. **Format Kurier.** Kurier adalah jalur yang direkomendasikan, tapi URL dan
   bentuk request persisnya harus disalin dari dokumentasi/dashboard Kurier.
   Kode ini tidak menebak URL Kurier. Tanpa konfigurasi Kurier, proof lokal
   tetap dilampirkan bila berhasil dibuat, tanpa referensi on-chain Finalized.
4. **Encoding kunci HMAC.** Dokumentasi publik tidak menyatakan encoding kunci
   secara tegas. Kode ini mencoba hex, base64, dan UTF-8. Bila preflight gagal
   auth, cek log dan format secret yang ditampilkan sekali saat registrasi agen.

## Cara jalan lokal

Butuh Node.js 20+ (disarankan 22/24).

```bash
npm install
npm test
# Mode uji lokal TANPA HMAC (jangan dipakai di production):
PORT=3000 ALLOW_UNVERIFIED=true PROOF_ENABLED=false npm start
# Di terminal lain:
curl http://localhost:3000/health
```

Uji satu tugas (contoh valid dari `examples/sample-tasks.json`):

```bash
curl -X POST http://localhost:3000/agent \
  -H 'content-type: application/json' \
  -d '{"task_id":"gk_local_1","mode":"competition","input":{"registered_vk":"0x7d3a111111111111111111111111111111111111111111111111111111f291","proof_vk":"0x7d3a111111111111111111111111111111111111111111111111111111f291","minimum":"1000","public_balance":"1460","expiry_block":19842201,"current_block":19832000,"recipient":"0xDe42000000000000000000000000000000009f01","condition_recipient":"0xDe42000000000000000000000000000000009f01","amount":"500","max_transfer":"1000","proof_tx":"0xlocal00000000000000000000000000000000000000000000000000000001"}}'
```

Harapan: `{"decision":"APPROVE","reason_code":"VALID_CONDITION",...}`.

## Deploy (HTTPS publik, tanpa localhost, tanpa custom port)

Aturan platform ([/rules](https://agentgames.zkverify.io/rules)): agen harus di alamat
HTTPS publik, port standar. Platform tidak menjalankan kodemu — kamu yang hosting.
Bila agen offline saat tugas dikirim, tugas itu hangus. **Hati-hati hosting gratis
yang "tidur" saat idle: itu akan membuatmu kehilangan tugas.** Pakai instance
always-on selama ronde berbobot, dan disk persisten untuk folder `./data`
(seen-set + cache idempotensi) bila host sering restart.

### Opsi A: Render (disarankan untuk mulai)

1. Push repo ini ke GitHub (repo yang terhubung ke akun Agent Games kamu —
   satu akun GitHub per akun kompetisi).
2. Di Render, buat Web Service baru dari repo ini, atau pakai `render.yaml`
   (Blueprint). Build: `npm install`. Start: `npm start`. Health check: `/health`.
3. Di dashboard Render, set environment variable (jangan commit):
   `AGENT_GAMES_HMAC_SECRET` = secret 32-byte dari registrasi agen (ditampilkan
   sekali saja — simpan baik-baik), `ALLOW_UNVERIFIED=false`.
4. Buka `https://nama-app-kamu.onrender.com/health` — harus `{"status":"ok",...}`.
5. Daftarkan endpoint `https://nama-app-kamu.onrender.com/agent` di dashboard
   Agent Games, lalu jalankan Practice Mode.

### Opsi B: Docker / VPS / Fly.io / Railway

```bash
docker build -t proof-gatekeeper-agent .
docker run -p 3000:3000 \
  -e AGENT_GAMES_HMAC_SECRET='isi-dari-dashboard' \
  -e ALLOW_UNVERIFIED=false \
  -v "$PWD/data:/app/data" \
  proof-gatekeeper-agent
```

Pasang di balik HTTPS (reverse proxy / platform) di port standar 443. Jangan
mengekspos `ALLOW_UNVERIFIED=true` ke internet.

### Catatan Vercel / serverless

Endpoint bisa jalan, tapi file `./data` tidak persisten antar-invocation di
serverless — seen-set dan cache idempotensi bisa hilang saat restart, sehingga
`PROOF_REUSED` bisa lolos. Bila memakai serverless, ganti `SeenStore` /
`ResponseCache` dengan database (mis. Postgres/Redis/Upstash) sebelum ronde
berbobot. Untuk kesederhanaan, Render/Railway/Fly always-on lebih aman.

## Daftar agen + Practice Mode

1. Di dashboard Agent Games, daftarkan agen dengan URL HTTPS publik di atas.
   Platform membuat secret HMAC 32-byte dan menampilkannya **sekali saja**.
   Salin ke environment hosting. Jangan commit ke repo. Bila bocor, rotate
   dari halaman pengaturan agen — secret lama langsung tidak berlaku.
2. Jalankan **Practice Mode** (tugas latihan formatnya identik dengan tugas
   berbobot, tidak memengaruhi leaderboard, dibatasi 10 dispatch per agen aktif
   per jam). Uji sampai: preflight Healthy, semua jenis jebakan dijawab benar,
   dan (bila proof diaktifkan) proof ditandai verified.
3. Daftar ke event Proof Gatekeeper. Satu agen per pemilik di event ini;
   entri terkunci saat ronde dibuka.

Jadwal ronde berbobot (halaman event): 8 ronde harian 13–20 Nov 2026,
16.00–02.00 IST setiap hari, 8 tugas per agen per ronde, skor kumulatif.
Saat README ini ditulis (15 Nov 2026), Ronde 01–02 sudah selesai (RESULTS),
Ronde 03 (15 Nov) berstatus UPCOMING. Kompetisi tutup 21 Nov 2026.

## Bukti Groth16 (bonus reliabilitas)

Skor keputusan: APPROVE benar +12, REJECT benar +12, APPROVE salah -6,
REJECT salah -3, timeout -2. Tugas provable yang dijawab tanpa proof Groth16
yang valid kena -2 tambahan dan tidak mendapat bonus reliabilitas (+0 s.d. +5,
pro-rata). Tugas `PROOF_REUSED` tidak punya proof untuk dikirim dan dikecualikan.

Artifak resmi (dari `https://agentgames.zkverify.io/api/circuit-info`, mainnet):

- `vkHash` gatekeeper:
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- WASM: `https://agentgames.zkverify.io/circuits/gatekeeper.wasm`
- zkey: `https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey`
- Sirkuit: Groth16/BN128, dikompilasi dengan Circom 2.x. Proof dibuat lokal
  dengan `snarkjs`.

Langkah mengaktifkan:

```bash
npm run download-circuits
# Lalu isi circuits/inputs.json dari starter prompt dashboard.
# Template: circuits/inputs.example.json (JANGAN dipakai apa adanya).
# Format: { "namaSinyalAsli": "{namaField}" atau literal }
# Field merujuk ke extractFields(): registeredVk, proofVk, minimum,
# publicBalance, expiryBlock, currentBlock, recipient,
# conditionRecipient, amount, maxTransfer, proofTx, plus "{decision}" (1/0).
```

Lalu (opsional, jalur yang direkomendasikan) konfigurasi Kurier:

```bash
KURIER_ENABLED=true
KURIER_API_KEY=<dari dashboard Kurier>
KURIER_API_URL=<dari dokumentasi/dashboard Kurier — jangan ditebak>
```

Alur Kurier menurut halaman Build: dapatkan API key mainnet, daftarkan
verification key sekali, kirim proof dengan `vk_hash`-nya, lalu poll sampai
`Finalized`. Kode ini mem-poll dengan sisa budget 50 detik; bila budget habis,
keputusan + proof lokal tetap dikembalikan (lebih baik daripada timeout).

Bila kamu tidak mengaktifkan proof, agen tetap kompetitif di skor keputusan,
tapi kehilangan bonus reliabilitas. Itu jauh lebih baik daripada proof
ngawur yang ditolak (-2 per tugas) atau timeout (-2). **Jangan menebak nama
sinyal.**

## Logika keputusan (urutan cek)

1. `PROOF_REUSED` — `proof_tx` sudah pernah di-APPROVE sebelumnya.
2. `VK_SUBSTITUTION` — `proof_vk` != `registered_vk` (atau salah satu hilang).
3. `THRESHOLD_MISMATCH` — `public_balance` < `minimum` (atau tak terbaca).
4. `RECIPIENT_MISMATCH` — `recipient` != `condition_recipient`.
5. `EXPIRED_CONDITION` — `current_block` > `expiry_block`.
6. `AMOUNT_OVERFLOW` — `amount` > `max_transfer`.
7. Jika semua lolos → `APPROVE` / `VALID_CONDITION`.

Urutan ini deterministik. Tugas-tugas di kompetisi umumnya hanya berisi satu
jebakan, jadi urutan hanya berpengaruh bila satu tugas mengandung banyak
jebakan sekaligus. Bila Practice Mode menunjukkan `reason_code` yang diharapkan
berbeda untuk kasus multi-jebakan, sesuaikan urutan di `src/decide.js` dan
tulis alasannya di commit.

## Struktur file

```
package.json                  Node 20+, snarkjs untuk proof
src/server.js                 Server HTTP (tanpa framework), HMAC, idempotensi
src/decide.js                 Logika keputusan murni + parsing payload
src/hmac.js                   Verifikasi/penandatanganan HMAC-SHA256
src/seenStore.js              Seen-set + cache respons (JSON persisten)
src/proof.js                  snarkjs + Kurier (best-effort, tak pernah blokir)
src/config.js                 Semua konfigurasi dari environment
scripts/download-circuits.js  Unduh .wasm/.zkey resmi
test/decide.test.js           14 test (node --test)
examples/sample-tasks.json    Contoh payload valid + 2 jebakan
circuits/inputs.example.json  TEMPLATE mapping input circuit (isi dari dashboard)
Dockerfile, render.yaml       Deploy
.env.example, .gitignore      Secret tidak pernah di-commit
```

## Troubleshooting

- **Preflight gagal / 401 terus**: secret di hosting tidak cocok dengan secret
  dari Rotate Secret di dashboard, atau header tidak sampai (proxy menghapus
  header?). Cek log `[auth]`. Jangan menaruh secret di kode/repo.
- **Timeout di Practice**: cek hosting tidak tidur, endpoint merespons
  `GET /health` < 1 detik, dan log menunjukkan durasi tugas 1–5 ms untuk
  keputusan (proof/Kurier dibatasi budget 50 detik).
- **Proof ditandai invalid**: hampir pasti nama sinyal input atau field respons
  salah. Matikan proof sementara (`PROOF_ENABLED=false`), pastikan keputusan
  4/4 benar di Practice, lalu perbaiki mapping dari starter prompt dashboard.
- **PROOF_REUSED padahal proof baru**: `proof_tx` di tugas latihan mungkin
  memakai ulang referensi dari tugas sebelumnya, atau file `data/seen.json`
  berisi entri dari uji lokal. Untuk uji lokal, hapus folder `data/` dan
  restart. Jangan hapus `data/` di tengah ronde berbobot.
- **Respons duplikat / retry**: normal. Platform boleh retry; agen
  mengembalikan respons yang sama untuk `task_id` yang sama.

## Referensi resmi

- Event: <https://agentgames.zkverify.io/events/proof-gatekeeper>
- Build guide: <https://agentgames.zkverify.io/build>
- Rules: <https://agentgames.zkverify.io/rules>
- Circuit info (JSON): <https://agentgames.zkverify.io/api/circuit-info>
- zkVerify docs (zkVerifyJS): <https://docs.zkverify.io/overview/zkverifyjs>

## Lisensi

MIT. Kode ini ditulis dari nol berdasarkan dokumentasi publik Agent Games /
zkVerify. Circuit `.wasm`/`.zkey` dan `vkHash` adalah milik penyelenggara
(zkVerify Foundation / Horizen Labs) dan diunduh dari URL resmi mereka.
