-- ============================================================
-- 리뷰 투표(유용함/비추천) + 신고
-- 실행: Supabase 대시보드 → SQL Editor → New query → 붙여넣기 → Run
-- (reviews 테이블은 docs/reviews.sql 로 이미 만든 상태여야 함)
-- ============================================================

-- 1) 투표 테이블 (한 리뷰당 한 사람 1표, 값 변경/취소 가능)
create table if not exists public.review_votes (
  id         uuid primary key default gen_random_uuid(),
  review_id  uuid not null references public.reviews(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  vote       smallint not null check (vote in (-1, 1)),   -- 1 유용, -1 비추천
  created_at timestamptz not null default now(),
  unique (review_id, user_id)
);
create index if not exists review_votes_review_idx on public.review_votes(review_id);

alter table public.review_votes enable row level security;

drop policy if exists "votes_select_all" on public.review_votes;
create policy "votes_select_all" on public.review_votes
  for select using (true);                         -- 집계용 공개 읽기

drop policy if exists "votes_insert_own" on public.review_votes;
create policy "votes_insert_own" on public.review_votes
  for insert with check (auth.uid() = user_id);

drop policy if exists "votes_update_own" on public.review_votes;
create policy "votes_update_own" on public.review_votes
  for update using (auth.uid() = user_id);

drop policy if exists "votes_delete_own" on public.review_votes;
create policy "votes_delete_own" on public.review_votes
  for delete using (auth.uid() = user_id);

-- 2) 신고 테이블 (본인이 넣기만; 읽기는 관리자용이라 정책 없음 = 비공개)
create table if not exists public.review_reports (
  id         uuid primary key default gen_random_uuid(),
  review_id  uuid not null references public.reviews(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now()
);
alter table public.review_reports enable row level security;

drop policy if exists "reports_insert_own" on public.review_reports;
create policy "reports_insert_own" on public.review_reports
  for insert with check (auth.uid() = user_id);
