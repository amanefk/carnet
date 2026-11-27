-- ============================================================
-- Carnet ESIEE — schéma Supabase
-- À coller tel quel dans : Supabase > SQL Editor > New query > Run
-- Chaque table est protégée par RLS : un utilisateur ne voit
-- que ses propres lignes, même avec la clé "anon" publique.
-- ============================================================

create extension if not exists pgcrypto;

-- Semestres ---------------------------------------------------
create table if not exists semesters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  position    int  not null default 0,
  start_date  date,
  end_date    date,
  created_at  timestamptz not null default now()
);

-- Matières ----------------------------------------------------
create table if not exists subjects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  semester_id  uuid not null references semesters on delete cascade,
  code         text,
  name         text not null,
  ue           text,
  ects         numeric,
  coef         numeric,
  teacher      text,
  description  text,
  position     int  not null default 0,
  created_at   timestamptz not null default now()
);

-- Séances / chapitres (la progression vit ici) ----------------
create table if not exists units (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id  uuid not null references subjects on delete cascade,
  kind        text not null default 'Chapitre',
  title       text not null,
  position    int  not null default 0,
  status      text not null default 'todo' check (status in ('todo','doing','review','done')),
  confidence  int  check (confidence between 0 and 5),
  date        date,
  notes       text,
  created_at  timestamptz not null default now()
);

-- Ressources (fichiers uploadés ou liens) ---------------------
create table if not exists resources (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id    uuid not null references subjects on delete cascade,
  unit_id       uuid references units on delete set null,
  title         text not null,
  kind          text not null check (kind in ('file','link')),
  storage_path  text,
  url           text,
  mime          text,
  size          bigint,
  created_at    timestamptz not null default now()
);

-- Examens -----------------------------------------------------
create table if not exists exams (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id  uuid references subjects on delete set null,
  title       text not null,
  kind        text,
  starts_at   timestamptz not null,
  location    text,
  coef        numeric,
  grade       numeric,
  notes       text,
  created_at  timestamptz not null default now()
);

-- Accès importants --------------------------------------------
create table if not exists links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null,
  url         text not null,
  category    text,
  notes       text,
  position    int not null default 0,
  created_at  timestamptz not null default now()
);

-- Coffre : un seul blob chiffré par utilisateur ---------------
-- Le serveur ne stocke QUE du chiffré (AES-256-GCM, clé dérivée
-- du mot de passe maître via PBKDF2-SHA256 dans le navigateur).
create table if not exists vault (
  user_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  salt        text not null,
  iv          text not null,
  ciphertext  text not null,
  iterations  int  not null,
  updated_at  timestamptz not null default now()
);

-- RLS ---------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['semesters','subjects','units','resources','exams','links','vault'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "own rows" on %I', t);
    execute format(
      'create policy "own rows" on %I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Stockage des fichiers (bucket privé) ------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('resources', 'resources', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "own files" on storage.objects;
create policy "own files" on storage.objects for all to authenticated
  using (bucket_id = 'resources' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'resources' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Index ------------------------------------------------------
create index if not exists subjects_semester_idx on subjects(semester_id);
create index if not exists units_subject_idx on units(subject_id);
create index if not exists resources_subject_idx on resources(subject_id);
create index if not exists resources_unit_idx on resources(unit_id);
create index if not exists exams_subject_idx on exams(subject_id);
create index if not exists semesters_user_idx on semesters(user_id);
create index if not exists subjects_user_idx on subjects(user_id);
create index if not exists units_user_idx on units(user_id);
create index if not exists resources_user_idx on resources(user_id);
create index if not exists exams_user_idx on exams(user_id);
create index if not exists links_user_idx on links(user_id);

-- Droits d'accès à l'API --------------------------------------
-- Les projets Supabase récents n'exposent plus les nouvelles tables
-- par défaut : sans ces GRANT, l'API répond 403 même connectée.
grant usage on schema public to authenticated;
grant select, insert, update, delete on semesters, subjects, units, resources, exams, links, vault to authenticated;
revoke all on semesters, subjects, units, resources, exams, links, vault from anon;
revoke truncate, references, trigger on semesters, subjects, units, resources, exams, links, vault from authenticated;

-- Réglages (lien iCal du planning) --------------------------
create table if not exists settings (
  user_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  ics_url     text,
  updated_at  timestamptz not null default now()
);
alter table settings enable row level security;
drop policy if exists "own rows" on settings;
create policy "own rows" on settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on settings to authenticated;
revoke all on settings from anon;

-- Double authentification ------------------------------------
-- Dès qu'un facteur TOTP vérifié existe, toute requête exige une
-- session aal2 (mot de passe + code). Sans facteur, rien ne change.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
create or replace function private.mfa_ok()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((auth.jwt()->>'aal') = 'aal2', false)
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;
revoke all on function private.mfa_ok() from public, anon;
grant execute on function private.mfa_ok() to authenticated;
do $$
declare t text;
begin
  foreach t in array array['semesters','subjects','units','resources','exams','links','vault','settings'] loop
    execute format('drop policy if exists "mfa si active" on %I', t);
    execute format('create policy "mfa si active" on %I as restrictive for all to authenticated
      using ((select private.mfa_ok())) with check ((select private.mfa_ok()))', t);
  end loop;
end $$;
drop policy if exists "mfa si active (fichiers)" on storage.objects;
create policy "mfa si active (fichiers)" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'resources' or (select private.mfa_ok()))
  with check (bucket_id <> 'resources' or (select private.mfa_ok()));

-- Révision (quiz et flashcards générés) -----------------------
create table if not exists quiz_pools (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id uuid not null references subjects on delete cascade,
  difficulty text not null check (difficulty in ('facile','moyen','difficile')),
  content_hash text not null, items jsonb not null, item_count int not null,
  sources jsonb, model text, created_at timestamptz not null default now(),
  unique (user_id, subject_id, difficulty)
);
create table if not exists quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id uuid not null references subjects on delete cascade,
  difficulty text not null, mode text not null check (mode in ('quiz','flashcards')),
  content_hash text not null, score int not null, total int not null,
  created_at timestamptz not null default now()
);
-- (RLS « own rows » + « mfa si active » et droits identiques aux autres tables)
