-- =====================================================================
--  MIGRATION v4 — Login + Roles + Units + Asset Lifespan
--  I-paste sa Supabase -> SQL Editor -> Run. Ligtas kahit ulitin.
--
--  MAHALAGA: pagkatapos nito, KAILANGAN NA ANG LOG-IN. Titigil ang
--  open link. Basahin ang "STEP 2" sa dulo para gawing admin ang sarili mo.
-- =====================================================================

-- ---------- 1) PROFILES (kaakibat ng auth.users) ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text default '',
  position   text default '',
  unit       text default 'AV',            -- 'AV' | 'DOSTv' | iba pa
  role       text default 'staff',         -- 'staff' | 'admin'
  created_at timestamptz default now()
);

-- auto-gawa ng profile pag may bagong sign-up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, position, unit)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'position', ''),
    coalesce(new.raw_user_meta_data->>'unit', 'AV')
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 2) BAGONG COLUMNS ----------
-- ownership + unit ng bawat gate pass
alter table public.records   add column if not exists owner_id uuid references auth.users(id);
alter table public.records   add column if not exists section text default 'AV';

-- asset lifecycle ng bawat gamit
alter table public.inventory add column if not exists section           text default 'AV';
alter table public.inventory add column if not exists category          text default '';
alter table public.inventory add column if not exists acquired_date     date;
alter table public.inventory add column if not exists useful_life_years integer default 5;
alter table public.inventory add column if not exists asset_status      text default 'serviceable';
  -- 'serviceable' | 'for_repair' | 'unserviceable' | 'disposed'
alter table public.inventory add column if not exists property_no       text default '';
alter table public.inventory add column if not exists acquisition_cost  numeric;
alter table public.inventory add column if not exists notes             text default '';

-- ---------- 3) HELPER (para sa RLS) ----------
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- 4) TANGGALIN ANG LUMANG BUKAS-SA-LAHAT NA POLICIES ----------
drop policy if exists anon_all_records   on public.records;
drop policy if exists anon_all_inventory on public.inventory;
drop policy if exists anon_all_people    on public.people;
drop policy if exists anon_all_settings  on public.app_settings;
drop policy if exists anon_all_counters  on public.counters;

revoke all on all tables in schema public from anon;
revoke execute on function public.next_control(text) from anon;

alter table public.profiles enable row level security;

-- ---------- 5) BAGONG POLICIES (naka-login lang) ----------
-- PROFILES: mababasa ng lahat (pangalan sa UI); sariling profile lang ang ma-e-edit
drop policy if exists p_profiles_read   on public.profiles;
drop policy if exists p_profiles_upsert on public.profiles;
drop policy if exists p_profiles_update on public.profiles;
create policy p_profiles_read   on public.profiles for select to authenticated using (true);
create policy p_profiles_upsert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy p_profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- RECORDS: nakikita ng lahat (kailangan ng conflict-check at ng guard),
--          pero ANG MAY-ARI LANG (o admin) ang pwedeng mag-edit / mag-return / mag-delete.
drop policy if exists p_records_read   on public.records;
drop policy if exists p_records_insert on public.records;
drop policy if exists p_records_update on public.records;
drop policy if exists p_records_delete on public.records;
create policy p_records_read   on public.records for select to authenticated using (true);
create policy p_records_insert on public.records for insert to authenticated
  with check (owner_id = auth.uid());
create policy p_records_update on public.records for update to authenticated
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());
create policy p_records_delete on public.records for delete to authenticated
  using (owner_id = auth.uid() or public.is_admin());

-- INVENTORY: nakikita ng lahat; ma-e-edit ng naka-login; admin lang ang makakabura
drop policy if exists p_inv_read   on public.inventory;
drop policy if exists p_inv_insert on public.inventory;
drop policy if exists p_inv_update on public.inventory;
drop policy if exists p_inv_delete on public.inventory;
create policy p_inv_read   on public.inventory for select to authenticated using (true);
create policy p_inv_insert on public.inventory for insert to authenticated with check (true);
create policy p_inv_update on public.inventory for update to authenticated using (true) with check (true);
create policy p_inv_delete on public.inventory for delete to authenticated using (public.is_admin());

-- PEOPLE (autocomplete list)
drop policy if exists p_people_read on public.people;
drop policy if exists p_people_write on public.people;
create policy p_people_read  on public.people for select to authenticated using (true);
create policy p_people_write on public.people for insert to authenticated with check (true);

-- APP SETTINGS: mababasa ng lahat, ADMIN LANG ang makakapagpalit ng format
drop policy if exists p_settings_read   on public.app_settings;
drop policy if exists p_settings_insert on public.app_settings;
drop policy if exists p_settings_update on public.app_settings;
create policy p_settings_read   on public.app_settings for select to authenticated using (true);
create policy p_settings_insert on public.app_settings for insert to authenticated with check (public.is_admin());
create policy p_settings_update on public.app_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- COUNTERS (control number)
drop policy if exists p_counters_all on public.counters;
create policy p_counters_all on public.counters for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;
grant execute on function public.next_control(text) to authenticated;
grant execute on function public.is_admin() to authenticated;

-- ---------- 6) DEFAULT NA USEFUL LIFE (pwedeng palitan kada item) ----------
-- Sa GAM, ang EUL ay management prerogative ng ahensya (hindi na COA-prescribed).
-- Ito ay panimulang default lang — i-adjust ayon sa aktwal na karanasan ninyo,
-- at i-coordinate sa Property/Supply Officer at COA Resident Auditor.
update public.inventory set useful_life_years = 5 where useful_life_years is null;

-- =====================================================================
--  STEP 2 — PAGKATAPOS MAG-RUN NITO:
--  1) Sa app, mag-Sign up gamit ang email mo (ikaw ang unang user).
--  2) Balik dito sa SQL Editor, palitan ang email sa baba, tapos Run:
--
--     update public.profiles set role = 'admin'
--     where id = (select id from auth.users where email = 'ILAGAY-EMAIL-MO@dost.gov.ph');
--
--  3) Ang lumang 67 records (walang owner) ay ADMIN LANG ang makaka-edit.
--     Normal ito — archive na sila.
--
--  OPTIONAL (mas mahigpit): sa Supabase -> Authentication -> Providers -> Email,
--  i-OFF ang "Enable sign-ups" pagkatapos makapag-register ang buong team,
--  para walang basta-basta makagawa ng account.
-- =====================================================================
