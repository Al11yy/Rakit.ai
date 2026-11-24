# Knowledge Base — Rakit.ai

Ringkasan arsitektur yang **benar-benar terpasang** saat ini: pipeline PRD-to-UI, kontrak
Zod bersama, orchestrator di Cloudflare Workers, dan persistensi D1. Ditulis dari kode di
`apps/` dan `packages/`, bukan dari rencana.

> **Status (2026-11-24):** monorepo berjalan, pra-MVP. Editor punya 2 view, orchestrator
> menyajikan CRUD proyek lewat `/api/v1/projects` dengan persistensi D1, dan output LLM
> divalidasi Zod terhadap whitelist komponen.
>
> - **Model LLM aktif: `gpt-6-luna`** (`LLM_KITA_MODEL`) — menggantikan `auto`, dan alur
>   **generate + revisi sudah diverifikasi end-to-end secara lokal** terhadap provider asli.
> - **288 unit test** di 17 file lulus: 231 orchestrator + 34 schema + 23 editor.
>   `npm run typecheck` bersih di ketiga workspace.
> - **Belum ada:** autentikasi (ditunda sesuai keputusan meeting mentor 2026-11-24),
>   generator DDL, dan provisioning per proyek. Publish masih simulasi.
> - **Billing (koin/Midtrans) ditunda** ke fase berikutnya — lihat
>   `prd_ai_first_app_builder.md` untuk model yang dituju.

---

## 1. Gambaran Umum

Rakit.ai adalah app builder yang mengubah satu kalimat deskripsi menjadi skema database
plus aplikasi full-stack yang berjalan, lalu diterbitkan ke Cloudflare. Pengguna tidak
menulis kode dan tidak mengonfigurasi infrastruktur.

Tiga hal yang membedakannya, dan harus tetap berjalan bersama:

1. **PRD-to-UI pipeline** — satu prompt menghasilkan skema + layar, bukan kanvas kosong.
2. **Edit visual gratis** — jalur keluar yang tidak pernah menghitung biaya.
3. **Generasi terbatas** — LLM tidak pernah mengeluarkan HTML/JS; hanya JSON yang lolos
   validasi Zod dan dipetakan ke komponen whitelist.

Sasaran pengguna tersebar lebar: pemilik UMKM yang belum pernah menyentuh database sampai
freelancer yang menyentuhnya tiap minggu. Rentang literasi teknis itulah batasan utama
antarmuka.

### Struktur repository

```
D:\PKL\Project
├── apps/editor/              # Frontend editor (Vite + React + Tailwind + Zustand)
│   ├── src/
│   │   ├── App.tsx               # Komposisi shell; navigasi lewat state
│   │   ├── components/
│   │   │   ├── shell/            # TopBar, Pipeline, PromptRow, Rail
│   │   │   ├── preview/          # Preview — kanvas hasil generate
│   │   │   ├── inspector/        # Inspector — editor visual gratis
│   │   │   ├── views/            # SchemaView
│   │   │   └── ui/               # Button, Icons, Toasts
│   │   ├── lib/
│   │   │   ├── api.ts            # Klien HTTP ke orchestrator
│   │   │   ├── contract.ts       # Shim re-export @rakit/schema
│   │   │   ├── parse.ts          # Shim re-export @rakit/schema
│   │   │   ├── seed.ts           # Data demo sintetis
│   │   │   └── types.ts          # Tipe domain editor
│   │   ├── store/useBuilder.ts   # Seluruh state + aksi
│   │   └── index.css             # Token turunan Tailwind + base layer
│   ├── .shots/               # Harness verifikasi Playwright + screenshot
│   └── tailwind.config.js        # Token desain
├── apps/orchestrator/        # Hono — LLM-Kita, rute, layanan, D1
│   └── src/
│       ├── app.ts                # Satu app, dua entry point
│       ├── worker.ts             # Entry Cloudflare Worker (target deploy)
│       ├── server.ts             # Entry Node + tsx watch (inner loop)
│       ├── node-handler.ts       # Membungkus app dengan env untuk Node
│       ├── auth.ts               # Gerbang token bersama
│       ├── config.ts             # Semua env dibaca di satu tempat
│       ├── errors.ts             # Bentuk error API
│       ├── llm/                  # Klien OpenAI-compatible + ekstraksi JSON
│       ├── prompt/               # Pembangun system prompt
│       ├── repositories/         # projects.ts — CRUD + revisi D1
│       ├── routes/               # Permukaan HTTP
│       └── services/             # generation.ts — orkestrasi generate/revise
├── packages/schema/          # @rakit/schema — kontrak Zod bersama
│   └── src/                      # contract, parse, assemble, index
├── .claude/                  # Slash commands, skills, agents
├── .amanah/                  # Atlas (peta arsitektur) + blueprint
├── docs/
│   └── PROJECT_HANDOFF_CONTEXT.md   # Konteks master lintas-AI (Bahasa Indonesia)
├── CLAUDE.md                 # Instruksi agen + aturan non-negosiabel
├── PRODUCT.md                # Definisi produk
└── prd_ai_first_app_builder.md   # Sumber kebenaran kebutuhan (termasuk billing)
```

**Tidak ada router.** Navigasi sepenuhnya lewat field `view` di store
(`'builder' | 'schema'`). Konsekuensi praktis: tidak ada URL langsung ke satu view, dan
state tidak bertahan setelah reload.

---

## 2. Dua Entry Point, Satu App

Orchestrator punya dua entry point ke `createApp()` yang sama:

| Entry | Runtime | Port | Kegunaan |
|-------|---------|------|----------|
| `src/worker.ts` | Cloudflare Workers | — | Target deploy production |
| `src/server.ts` | Node + `tsx watch` | 5181 | Inner loop cepat |

Keduanya **tidak** memuat routing atau logika bisnis. Konfigurasi masuk lewat objek `Env`
eksplisit, bukan `process.env` — inilah yang membuat kode sama bisa jalan di dua runtime
tanpa polyfill `nodejs_compat`.

> **Jebakan yang pernah menggigit:** `server.ts` dulu memanggil `serve({ fetch: app.fetch })`.
> `@hono/node-server` tidak memasok `env`, sehingga `c.env` selalu `undefined` dan **gerbang
> token tidak pernah berjalan** di jalur Node — sementara seluruh test tetap hijau karena test
> memberi `env` sendiri. Sekarang `createNodeHandler(env)` menutup `env` ke dalam handler, dan
> `node-handler.test.ts` menjaganya.

---

## 3. Permukaan HTTP

| Rute | Keterangan |
|------|------------|
| `GET /api/v1/health` | Terbuka tanpa token. Melaporkan `llmConfigured` saja. |
| `GET /api/v1/projects` | Daftar proyek |
| `POST /api/v1/projects` | Buat proyek |
| `GET /api/v1/projects/:id` | Baca satu proyek |
| `PUT /api/v1/projects/:id` | Perbarui proyek |
| `DELETE /api/v1/projects/:id` | Hapus proyek |
| `POST /api/v1/generate` | Prompt → proyek baru |
| `POST /api/v1/revise` | Instruksi → revisi proyek (id dipertahankan) |

### Kendali akses

Dua lapis, **tidak satu pun autentikasi sungguhan**:

- **`FEATURE_GENERATE_ENABLED`** — `/generate` dan `/revise` membalas **503
  `FEATURE_DISABLED`** kecuali nilainya persis `"true"`. **Mati secara default**,
  termasuk bila tidak di-set. Ini lapis yang benar-benar bekerja: hidup di environment
  Worker dan tidak bisa dibaca klien.
- **`RAKIT_SHARED_TOKEN`** — semua rute kecuali `/health` dan preflight CORS memerlukan
  `X-Rakit-Token` yang cocok. Ini **pengekangan, bukan autentikasi**: editor adalah aplikasi
  browser, jadi Vite menanam tokennya ke bundle dan terbaca di DevTools. Ia menghalangi
  crawler dan scanner, tidak lebih.

`CORS_ALLOWED_ORIGINS` adalah aturan browser, bukan kontrol akses — `curl` mengabaikannya.
Jangan pernah menggantinya dengan `*`.

---

## 4. Persistensi

Satu database D1 (`rakit-db`) menyimpan **metadata platform saja**:

- `projects` — `id`, `owner_id` (placeholder), `name`, `slug`, `prompt`, `status`,
  `document` (JSON), `revision`, `created_at`, `updated_at`
- `project_revisions` — riwayat; setiap baris mencatat keadaan *setelah* satu revisi

Aturan yang tidak boleh dilanggar:

- **Revisi mempertahankan `id` proyek.** `reviseProject` tidak pernah membuat id baru;
  id menandai baris yang diperbarui dan riwayat miliknya.
- **Satu database D1 per proyek pengguna.** Tidak ada tabel lintas-tenant. Data aplikasi
  pengguna tidak pernah masuk `rakit-db`.

Migrasi ada di `apps/orchestrator/migrations/`. Terapkan dengan `npm run db:migrate:local`
atau `npm run db:migrate:remote` dari `apps/orchestrator/`.

---

## 5. Kontrak Bersama (`@rakit/schema`)

`packages/schema` adalah satu-satunya rumah whitelist komponen. Ia diimpor sebagai sumber
(`"main": "./src/index.ts"`), bukan dibangun ke `dist/`, jadi tidak ada langkah build antar
paket.

`apps/editor/src/lib/contract.ts` dan `parse.ts` adalah **shim re-export**, bukan salinan.
Duplikasi akan memberi whitelist dua rumah dan membuatnya melenceng — kegagalan yang justru
ingin dicegah `WHITELISTED_KINDS`. Hapus shim setelah seluruh import editor menunjuk
`@rakit/schema` langsung.

Aturan #1 ditegakkan di sini: `kind` adalah `refine` atas whitelist (bukan `z.enum`, agar
pesan galat bisa menyebut nilai yang ditolak), dan `parse.ts` menyebut nilai yang diterima
dari payload mentah.

---

## 6. Alur yang Berjalan

**Generate** (`runGeneration` di `store/useBuilder.ts` → `POST /api/v1/generate`):

1. Prompt dikirim ke orchestrator.
2. `services/generation.ts` memanggil LLM-Kita dengan timeout eksplisit.
3. Balasan diekstrak JSON-nya, lalu divalidasi Zod terhadap kontrak.
4. Proyek baru ditulis ke D1 dan dikembalikan; editor menampilkannya.

Pesan tahap di UI dimajukan oleh timer, bukan progres server. Ini **diketahui dan dicatat**
sebagai utang teknis di `TODO.md` — bukan kebetulan yang perlu ditemukan ulang.

**Revisi** (`runRevision` → `POST /api/v1/revise`): instruksi diterapkan ke dokumen yang ada,
`id` dipertahankan, `revision` dinaikkan, dan baris riwayat ditulis.

**Publish** (`runPublish`): masih **simulasi `setTimeout`**. Belum ada generator DDL maupun
provinsi Cloudflare.

---

## 6a. Peta Jalan — Urutan Prioritas (keputusan meeting mentor 2026-11-24)

**Auth digeser ke belakangan.** Ia bukan lagi blocker P0: gerbang token bersama dan
`FEATURE_GENERATE_ENABLED` sudah menahan risiko selama deployment tidak dipublikasikan. Urutan
pengerjaan yang berlaku sekarang:

| # | Tahap | Status |
|---|-------|--------|
| 1 | Login / autentikasi | **Ditunda** — dikerjakan setelah rantai di bawah, sebelum platform dibuka ke pengguna nyata |
| 2 | Editor | **Berjalan** — kanvas, inspector, 2 view, persistensi D1 |
| 3 | **AI Chief of Staff** | **Belum ada** — sesi tanya-jawab terstruktur untuk menggali kebutuhan user |
| 4 | Output PRD + diagram Mermaid (user flow) | **Belum ada** — artefak yang terlihat dari tahap 3 |
| 5 | Generate website end-to-end dengan konten rich | **Sebagian** — lihat keterbatasan di bawah |
| 6 | Integrasi deploy Cloudflare Pages/D1 | **Masih simulasi** |

### Mengapa tahap 5 disebut "keterbatasan preview"

`WHITELISTED_KINDS` hanya berisi tiga kind: **`navbar`, `stat`, `table`**. Dua akibatnya
terlihat langsung oleh pengguna:

- Aplikasi hasil generate selalu berbentuk sama — tidak ada form, card, list, atau chart.
- `TableBlock` di `apps/editor/src/components/preview/Preview.tsx` merender **konstanta `ROWS`
  yang di-hardcode** (baris "Siti Rahmawati", dst.), bukan data dari dokumen proyek. Jadi isi
  tabel tidak pernah mencerminkan prompt.

"Mengatasi keterbatasan preview" berarti: memperlebar whitelist beserta renderer-nya, dan
mengalirkan baris tabel dari dokumen proyek alih-alih konstanta.

### Peran AI Chief of Staff

Tujuannya menutup celah antara "satu kalimat deskripsi" dan "kebutuhan yang sebenarnya".
Pengguna datang dengan ide, bukan design brief; Chief of Staff menggali lewat pertanyaan
terarah, lalu menghasilkan PRD + diagram Mermaid user flow yang menjadi bahan tahap generate.
Spesifikasi perilakunya (aturan 3–5 pertanyaan per putaran, format PRD, standar output rich)
ada di `docs/PROJECT_HANDOFF_CONTEXT.md` §5 — dokumen itu adalah konteks portabel lintas-AI dan
ikut diperbarui setiap prioritas/arsitektur berubah.

---

## 7. Yang Sengaja Tidak Ada

Jangan bangun ulang tanpa keputusan eksplisit:

- **Sistem koin, ledger, saldo, Midtrans.** Dihapus sebagai kode mati. Model bisnisnya
  **ditunda**, bukan dibatalkan — masih ada di PRD. Untuk MVP, kuota dan biaya sepenuhnya
  ada di akun LLM-Kita. Jangan tampilkan saldo, harga, atau tombol "top up" di antarmuka,
  karena tidak ada yang menagih.
- **Express.js / `apps/api/`.** Backend adalah Hono di Workers. Tidak akan ada `apps/api/`.
- **View `ledger`.** Hanya `builder` dan `schema` yang ada.

---

## 8. Menjalankan

```bash
npm run dev:all        # editor + orchestrator bersama
npm test               # vitest di semua workspace
npm run typecheck      # tsc --noEmit di semua workspace
npm run fake-llm       # provider LLM palsu, tanpa API key
npm run smoke          # smoke end-to-end terhadap provider palsu
```

Dari `apps/orchestrator/`: `npm run dev` (:5181), `npm run dev:worker` (:8787),
`npm run deploy`.

Editor juga bisa berdiri sendiri: `cd apps/editor && npm run dev` (:5180, `strictPort` —
instance kedua gagal, bukan memilih port lain).
