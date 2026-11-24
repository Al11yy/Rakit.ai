# TODO — Rakit.ai

Daftar tugas pengembangan berikutnya, diurutkan berdasarkan apa yang menghalangi langkah
selanjutnya. Setiap butir merujuk file nyata di repo ini.

**Legenda:** `[ ]` belum · `[~]` sebagian · `[x]` selesai
**Prioritas:** **P0** menghalangi · **P1** inti MVP · **P2** penting tapi bisa menyusul · **P3** pemolesan

> **Status ringkas (2026-11-24):** model LLM aktif **`gpt-6-luna`**; alur **generate + revisi
> sudah diverifikasi end-to-end secara lokal**; **288 unit test** lulus (231 orchestrator +
> 34 schema + 23 editor) dan `npm run typecheck` bersih di ketiga workspace. Konteks lengkap
> untuk AI lain: `docs/PROJECT_HANDOFF_CONTEXT.md`.

> **Perubahan prioritas (2026-11-24, keputusan meeting mentor):** **Auth digeser ke belakang**
> dan bukan lagi blocker P0. Prioritas utama sekarang adalah rantai produk:
> **Login (auth belakangan) → Editor → AI Chief of Staff → PRD + diagram Mermaid → generate
> website end-to-end dengan konten rich → integrasi deploy Cloudflare Pages/D1.**
> Alasannya: gerbang `RAKIT_SHARED_TOKEN` + `FEATURE_GENERATE_ENABLED` sudah menahan risiko
> selama deployment tidak dipublikasikan, sementara celah kualitas produk (preview hanya 3
> block kind, baris tabel hardcoded) justru yang membuat hasil generate terasa seperti demo.
> Auth kembali menjadi syarat **sebelum** platform dibuka ke pengguna nyata — bukan sebelum
> alur produknya ada.

> **Sudah tidak berlaku, jangan dihidupkan lagi:** sistem koin, ledger, saldo, Midtrans, dan
> top-up telah **dihapus dari produk**. Billing sepenuhnya ada di akun LLM-Kita; repo ini tidak
> menghitung atau menagih apa pun. Ini aturan non-negosiabel #2 di `CLAUDE.md`. Daftar ini
> sebelumnya masih memuat butir debit koin, refund, dan webhook Midtrans — semuanya dihapus
> pada 2026-11-18 karena menyesatkan.
>
> Backend **bukan Express** dan tidak pernah akan: orchestrator adalah Hono di Cloudflare
> Workers (`apps/orchestrator/`). Tidak ada `apps/api/`.

---

## P0 — Yang menghalangi (rantai produk, urutan berlaku)

- [ ] **AI Chief of Staff.** Belum ada sama sekali. Sesi tanya-jawab terstruktur yang menggali
      kebutuhan user (aturan maksimal 3–5 pertanyaan tajam per putaran) sebelum generate.
      Ini butir pertama rantai: tanpa kebutuhan yang tergali, prompt tetap satu kalimat dan
      hasil generate tetap generik. Spesifikasi perilaku ada di
      `docs/PROJECT_HANDOFF_CONTEXT.md` §5.
- [ ] **Output PRD + diagram Mermaid (user flow).** Belum ada. Artefak yang dilihat user
      setelah sesi Chief of Staff; menjadi bahan eksplisit untuk tahap generate. Belum ada
      dependensi Mermaid di repo — ini menambahkannya.
- [~] **Generate website end-to-end dengan konten rich.** Pipeline-nya sudah berjalan
      end-to-end dengan `gpt-6-luna` (generate + revisi terverifikasi lokal), tetapi
      **kontennya masih miskin**: `WHITELISTED_KINDS` hanya `navbar`, `stat`, `table`, dan
      `TableBlock` di `apps/editor/src/components/preview/Preview.tsx` merender konstanta
      `ROWS` yang di-hardcode (baris "Siti Rahmawati", dst.) alih-alih data proyek. Dua
      pekerjaan: (a) perluas whitelist + renderer (form, card, list, chart) mengikuti resep di
      `.amanah/atlas/quickstart.md`; (b) alirkan baris tabel dari dokumen proyek.
- [ ] **Integrasi deploy Cloudflare Pages/D1.** `runPublish` di
      `apps/editor/src/store/useBuilder.ts` masih `setTimeout` simulasi. Sambungkan ke API
      Cloudflare sungguhan: satu database D1 per proyek (aturan #4), jangan pernah menaruh data
      pengguna di `rakit-db`. Butuh `packages/generator/` (DDL) lebih dulu.

## P1 — Inti MVP

- [ ] **Generator DDL.** `packages/generator/` belum ada. Skema proyek belum bisa
      diterjemahkan menjadi `CREATE TABLE`, sehingga publish tidak punya bahan untuk dijalankan.
      Prasyarat butir deploy di P0.
- [ ] **Autentikasi — digeser ke belakang (2026-11-24).** Belum ada sama sekali. `owner_id` di
      `repositories/projects.ts` masih placeholder, sehingga setiap pemanggil melihat data yang
      sama. Bukan lagi blocker P0, tetapi **wajib ada sebelum platform dipublikasikan atau
      diisi pengguna nyata**; ia juga yang membuka blokir rate limiting per pengguna.

## P1b — Selama auth belum ada (penahan risiko)

- [x] **Pasang `RAKIT_SHARED_TOKEN` di production.** Selesai 2026-11-20 dan diverifikasi
      end-to-end: `/projects` tanpa token **401**, dengan token **200**, token salah **401**,
      `/generate` tetap **503** `FEATURE_DISABLED`, `/health` terbuka. Secret berlaku seketika
      tanpa deploy ulang. Ingat: ini pengekangan, bukan autentikasi — token tetap tertanam
      dalam bundle browser lewat `VITE_*`.
- [ ] **Jaga `FEATURE_GENERATE_ENABLED` tetap `"false"` sampai auth ada.** Saat ini `"false"`
      di `wrangler.toml` dengan sengaja. Membaliknya sebelum auth berarti siapa pun yang
      menemukan URL Worker dapat membelanjakan kuota LLM-Kita. Penggantinya butir P1.

## P2 — Kualitas & keandalan

- [ ] **Rate limiting & kuota** per pengguna pada endpoint LLM. Belum ada sama sekali; ini
      pengaman biaya yang sebenarnya setelah auth. Selama auth belum ada, satu-satunya penahan
      adalah `FEATURE_GENERATE_ENABLED`.
- [ ] **Penanganan error yang bisa dipulihkan.** Kegagalan saat ini hanya menjadi pesan;
      belum ada tombol "Coba lagi" yang memakai ulang prompt terakhir.
- [ ] **Log biaya LLM.** Catat token per permintaan supaya pemakaian bisa dilihat terhadap
      tagihan LLM-Kita yang sebenarnya.
- [ ] **Konfirmasi hapus proyek masih `window.confirm`.** `Rail.tsx` memakai dialog bawaan
      browser karena itu penjaga termurah yang tidak bisa dilewati salah klik. Gantinya dialog
      milik aplikasi sendiri ketika sudah ada komponen modal — jangan sampai penghapusan yang
      tidak bisa dibatalkan bergantung pada dialog yang bisa diblokir browser.
- [ ] **Audit aksesibilitas.** `:focus-visible` sudah ditata, tetapi belum ada uji keyboard
      menyeluruh maupun uji pembaca layar pada `Pipeline`, `Inspector`, dan `Preview`.

## P3 — Pemolesan

- [ ] **Mode gelap.** Token warna sudah semantik dan terpusat, jadi ini pekerjaan mendefinisikan
      satu set nilai lagi — bukan refactor.
- [ ] **Pratinjau responsif.** `Preview.tsx` merender satu lebar; tambahkan mobile/tablet.
- [ ] **Ekspor & impor proyek** sebagai JSON.
- [ ] **Landing page & alur onboarding** untuk pengguna baru.
- [ ] **Halaman status publik** untuk insiden deploy.

---

## Utang teknis yang diketahui

Diverifikasi terhadap kode pada 2026-11-18; diperbarui 2026-11-20 dan 2026-11-24. Butir yang
ternyata sudah beres dihapus, bukan dibiarkan menggantung.

| Item | Lokasi | Dampak |
|------|--------|--------|
| Baris tabel di preview adalah konstanta | `Preview.tsx` (`ROWS`) | Isi tabel tidak pernah mencerminkan prompt; semua aplikasi tampil dengan data klinik yang sama |
| Hanya 3 block kind yang render | `packages/schema/src/contract.ts` (`WHITELISTED_KINDS`) | Tidak ada form, card, list, atau chart — hasil generate terasa seperti demo |
| Pesan tahap generasi memakai timer, bukan progres server | `useBuilder.ts` (`setTimeout`) | Progres yang ditampilkan tidak mencerminkan pekerjaan nyata |
| Tidak ada router — navigasi lewat state | `App.tsx` | Tidak ada URL yang bisa dibagikan; reload kehilangan konteks |
| `hasGenerated` di-set tapi tidak pernah dibaca | `useBuilder.ts:68,135,295,339` | Dead state; aman dihapus, bukan bug perilaku |
| `.shots/` berisi harness ad-hoc | `apps/editor/.shots/` | Skrip verifikasi tidak terdaftar di `package.json` |
| Dokumen Confluence hanya sinkron ke depan | `scripts/sync-confluence.mjs` | Suntingan langsung di Confluence hilang pada sync berikutnya; ubah markdown di repo |

## Cara memakai daftar ini

1. Kerjakan P0 dari atas, sesuai urutan rantai produk: Chief of Staff → PRD + Mermaid →
   generate rich → deploy nyata. Auth (P1) menyusul, tetapi wajib selesai sebelum platform
   dipublikasikan.
2. Sebelum menyentuh kode fitur, baca `.amanah/atlas/*.md` dan blueprint terkait
   (`CLAUDE.md` mewajibkan ini). Atlas sudah diselaraskan dengan kode pada 2026-11-18, tetapi
kode tetap menang bila keduanya berbeda.
3. Jangan menambahkan butir yang memuat koin, ledger, saldo, atau Midtrans. Bila muncul
   dorongan ke sana, baca ulang aturan #2 di `CLAUDE.md` lebih dulu.
4. Jalankan `npm test` dan `npm run typecheck` sebelum commit. Jalur uang tidak lagi ada,
   jadi tidak ada invarian saldo yang perlu dijaga.
