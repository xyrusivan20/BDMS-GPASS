-- =====================================================================
--  MIGRATION v2 — Equipment checkout lifecycle (OUT / RETURNED)
--  Para sa mga na-deploy na gamit ang unang schema.sql.
--  I-paste sa Supabase → SQL Editor → Run. Ligtas kahit ulit-ulitin.
-- =====================================================================

alter table public.records add column if not exists released_at timestamptz;
alter table public.records add column if not exists returned_at timestamptz;

-- Walang mababago sa dati mong data. Ang mga lumang record (imported) ay
-- ituturing na sarado (hindi "naka-labas"). Ang per-item na kondisyon at
-- remarks ay naka-store sa loob ng 'items' (jsonb) kaya walang ibang
-- kailangang baguhin sa table.
