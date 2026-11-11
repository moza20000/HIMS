-- MOZA Attendance schema for Supabase
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  code text unique,
  role text not null default 'student' check (role in ('owner','admin','student')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 100),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  active boolean not null default true,
  token_hash text not null
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id),
  student_name text not null,
  student_code text not null,
  session_id uuid not null references public.sessions(id),
  session_title text not null,
  status text not null default 'present' check (status in ('present')),
  timestamp timestamptz not null default now(),
  unique (session_id, student_id)
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  action text not null,
  admin_uid uuid not null references public.profiles(id),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists attendance_timestamp_idx on public.attendance(timestamp desc);
create index if not exists attendance_session_idx on public.attendance(session_id);
create index if not exists sessions_created_at_idx on public.sessions(created_at desc);
create index if not exists profiles_code_idx on public.profiles(code);

-- Every new Auth user starts as a student. Never trust user-editable metadata for role assignment.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id, name, code, role, active)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''),'@',1)),
    nullif(new.raw_user_meta_data->>'code',''),
    'student',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_moza on auth.users;
create trigger on_auth_user_created_moza
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.attendance enable row level security;
alter table public.audit_logs enable row level security;

-- SECURITY DEFINER helper avoids recursive RLS evaluation on profiles.
create or replace function public.moza_is_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('owner','admin') and p.active
  );
$$;

-- Profiles: a student can read only their own profile; admins can read all profiles.
drop policy if exists "profile self or admin read" on public.profiles;
create policy "profile self or admin read" on public.profiles for select to authenticated
using (id = auth.uid() or public.moza_is_admin());

-- No direct client writes. Mutations are performed by the Edge Function using its server-side secret.
drop policy if exists "no client profile writes" on public.profiles;
create policy "no client profile writes" on public.profiles for all to authenticated
using (false) with check (false);

drop policy if exists "admin sessions read" on public.sessions;
create policy "admin sessions read" on public.sessions for select to authenticated
using (public.moza_is_admin());

drop policy if exists "admin attendance read" on public.attendance;
create policy "admin attendance read" on public.attendance for select to authenticated
using (public.moza_is_admin());

drop policy if exists "admin audit read" on public.audit_logs;
create policy "admin audit read" on public.audit_logs for select to authenticated
using (public.moza_is_admin());

-- Enable realtime feeds used by the dashboard (safe because SELECT policies still apply).
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null; when undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.sessions;
exception when duplicate_object then null; when undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.attendance;
exception when duplicate_object then null; when undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.audit_logs;
exception when duplicate_object then null; when undefined_object then null;
end $$;
