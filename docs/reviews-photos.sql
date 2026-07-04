-- ============================================================
-- 리뷰 사진 첨부 (Supabase Storage)
-- 실행: Supabase 대시보드 → SQL Editor → New query → 붙여넣기 → Run
-- (reviews 테이블은 docs/reviews.sql 로 이미 만든 상태여야 함)
-- ============================================================

-- 1) reviews 테이블에 사진 URL 컬럼 추가
alter table public.reviews
  add column if not exists image_url text;

-- 2) 사진 저장용 Storage 버킷 생성 (공개 읽기)
insert into storage.buckets (id, name, public)
values ('review-photos', 'review-photos', true)
on conflict (id) do nothing;

-- 3) Storage 접근 정책 (storage.objects)
-- 누구나 읽기(공개 URL)
drop policy if exists "review_photos_read" on storage.objects;
create policy "review_photos_read"
  on storage.objects for select
  using (bucket_id = 'review-photos');

-- 로그인 사용자는 이 버킷에 업로드 가능
drop policy if exists "review_photos_upload" on storage.objects;
create policy "review_photos_upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'review-photos');

-- 본인이 올린 사진만 삭제 가능
drop policy if exists "review_photos_delete_own" on storage.objects;
create policy "review_photos_delete_own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'review-photos' and owner = auth.uid());
