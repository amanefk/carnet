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
