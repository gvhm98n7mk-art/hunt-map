-- Run once in Supabase → SQL Editor → New query → Run.
create extension if not exists pgcrypto;
create table if not exists pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  gmu int not null, kind text not null, note text default '', lat double precision not null, lng double precision not null,
  date date, created_at timestamptz not null default now());
create table if not exists hunts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  gmu int not null, date date not null, hours text, species text, weapon text, saw text, harvest text, notes text, weather text,
  created_at timestamptz not null default now());
create table if not exists settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  home_addr text, home_lat double precision, home_lng double precision, created_at timestamptz not null default now());
alter table pins enable row level security; alter table hunts enable row level security; alter table settings enable row level security;
create policy "own pins" on pins for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own hunts" on hunts for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own settings" on settings for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
