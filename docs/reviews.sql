-- ============================================================
-- 마커 리뷰/댓글 테이블 (Supabase)
-- 실행 방법: Supabase 대시보드 → SQL Editor → New query → 붙여넣기 → Run
-- 읽기는 공개, 작성/수정/삭제는 로그인 사용자 본인만 (RLS)
-- ============================================================

create table if not exists public.reviews (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  map_id     text not null,          -- 예: "teyvat"
  marker_id  text not null,          -- 예: "h100174"
  name       text,                   -- 표시 이름 (이메일 앞부분)
  text       text not null check (char_length(text) between 1 and 500),
  created_at timestamptz not null default now()
);

-- 마커별 최신순 조회 인덱스
create index if not exists reviews_marker_idx
  on public.reviews (map_id, marker_id, created_at desc);

-- RLS 활성화
alter table public.reviews enable row level security;

-- 정책 (재실행 대비 drop 후 create)
drop policy if exists "reviews_select_all" on public.reviews;
create policy "reviews_select_all"
  on public.reviews for select
  using (true);                              -- 누구나 읽기(공개)

drop policy if exists "reviews_insert_own" on public.reviews;
create policy "reviews_insert_own"
  on public.reviews for insert
  with check (auth.uid() = user_id);         -- 로그인 본인만 작성

drop policy if exists "reviews_update_own" on public.reviews;
create policy "reviews_update_own"
  on public.reviews for update
  using (auth.uid() = user_id);              -- 본인 것만 수정

drop policy if exists "reviews_delete_own" on public.reviews;
create policy "reviews_delete_own"
  on public.reviews for delete
  using (auth.uid() = user_id);              -- 본인 것만 삭제
