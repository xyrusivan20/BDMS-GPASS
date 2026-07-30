# Gate Pass System — Deployment Guide

React + Supabase na gate pass system para sa DOST-STII / FR-FAD-GSPS No.002 form.
**Setup:** team, iisang shared database, walang login. Kahit sino sa team na may link, iisang records ang nakikita at ina-update.

Naka-seed na dito ang totoong data mo mula sa `GATEPASS_form.xlsx`: **67 records, 182 inventory items, 9 requestors.**

---

## Ano ang laman

```
gatepass-app/
├── schema.sql          ← i-run sa Supabase (tables + RLS + seed data)
├── index.html
├── package.json
├── vite.config.js
├── .env.example        ← template ng keys
└── src/
    ├── App.jsx         ← buong app + print form (FR-FAD-GSPS 002)
    ├── db.js           ← Supabase data layer
    ├── letterhead.js   ← naka-embed na DOST-STII letterhead
    └── main.jsx
```

---

## Hakbang 1 — I-setup ang database (Supabase)

1. Buksan ang Supabase project mo → **SQL Editor** → **New query**.
2. Buksan ang `schema.sql`, kopyahin lahat, i-paste, tapos **Run**.
   - Gagawa ito ng 5 tables (`records`, `inventory`, `people`, `app_settings`, `counters`), ng `next_control()` function (para sa auto control numbers), ng RLS policies, at ipa-pasok ang lahat ng na-import mong data.
3. Sa **Table Editor**, tingnan ang `records` — dapat naroon na ang 67 rows mo.

## Hakbang 2 — Kunin ang API keys

Sa Supabase: **Project Settings → API**. Kopyahin ang dalawa:
- **Project URL** (hal. `https://abcd1234.supabase.co`)
- **anon public** key (mahabang `eyJ...`)

## Hakbang 3 — Patakbuhin muna sa local (test)

Kailangan ng Node.js (v18+). Sa loob ng folder:

```bash
npm install
cp .env.example .env
```

Buksan ang `.env`, ilagay ang dalawang value mula Hakbang 2:

```
VITE_SUPABASE_URL=https://abcd1234.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

Tapos:

```bash
npm run dev
```

Buksan ang `http://localhost:5173`. Dapat lumitaw na ang records mo. Subukan: mag-add ng bagong pass, i-print (piliin ang **Save as PDF** sa print dialog kung PDF ang gusto).

## Hakbang 4 — I-deploy (Vercel — libre)

1. I-push ang folder na ito sa isang GitHub repo (huwag isasama ang `.env` — naka-ignore na).
2. Sa [vercel.com](https://vercel.com): **Add New → Project → Import** ang repo. Auto-detect nito na Vite.
3. Bago mag-Deploy: **Environment Variables**, idagdag ang parehong dalawa:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. **Deploy.** Bibigyan ka ng URL, hal. `https://gatepass-stii.vercel.app`.

> Netlify din pwede: drag-and-drop ang folder, tapos Site settings → Environment variables ang keys, o `netlify deploy`.

## Hakbang 5 — Gamitin sa phone

Buksan ang Vercel URL sa cellphone → **Add to Home Screen**. Parang app na tatakbo, kahit nasa field ka basta may internet. Ibahagi ang link sa team; iisang database ang lahat.

---

## Seguridad — basahin ito

Dahil **walang login** (ito ang pinili mo), ang app ay gumagamit ng *anon public key* na nasa frontend. Ibig sabihin: **kahit sino na may URL ay kayang magbasa at mag-edit ng lahat ng records.** Katanggap-tanggap ito kung ang link ay pang-team lang at hindi mo pinu-publish sa publiko.

Para maiwasang ma-index ng Google, huwag ilagay ang link sa kahit anong public na page. Ang RLS policies ay sadyang permissive (`anon` full access) para gumana nang walang login.

**Kung kailangan ng tunay na proteksyon** (login per user, roles na requestor/guard/admin, audit trail kung sino nag-edit) — iyon ang susunod na bersyon: Supabase Auth + row-level security by user. Sabihin mo lang.

## Backup

Ang Supabase na ang durable store, pero mag-**Backup** (JSON download) ka pa rin paminsan-minsan mula sa Records tab bilang off-site copy. Pwede ring i-download ang buong database mula sa Supabase dashboard.

---

## Pag-babago ng format (white-label)

Sa **Format** tab: mapapalitan ang letterhead (upload ng sariling image, o text lang), form code, lahat ng labels, instructions, signatories, laki ng papel. Naka-store ang format sa `app_settings` kaya iisa ang nakikita ng buong team. May "Ibalik sa DOST default" din.

## Print

Nakatakda sa Legal (8.5 × 14 in), 2 kopya kada page (original + duplicate). Napapalitan sa Format tab (Folio/A4/Letter). Vinerify na kasya sa isang page sa Legal at Folio.
