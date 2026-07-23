-- Supabase SQL Editor에서 실행하세요.

create table if not exists public.semiconductor_news (
  id bigint generated always as identity primary key,
  title text not null,
  link text not null unique,          -- 중복 저장 방지용 유니크 키
  source text,                        -- 언론사 (구글 뉴스 RSS에서 추출)
  keyword text,                       -- 어떤 검색어로 수집됐는지
  description text,                   -- 한줄 요약용 (RSS description, HTML 태그 제거 후 저장)
  published_at timestamptz,
  collected_at timestamptz default now()
);

-- 이미 테이블을 만든 상태라면 아래 한 줄만 SQL Editor에서 추가로 실행하세요.
-- alter table public.semiconductor_news add column if not exists description text;

-- 최신순 조회를 빠르게 하기 위한 인덱스
create index if not exists idx_semiconductor_news_published_at
  on public.semiconductor_news (published_at desc);

-- (선택) 나중에 사이트에서 읽을 때 RLS 켜고 읽기 전용 정책 추가하고 싶으면:
-- alter table public.semiconductor_news enable row level security;
-- create policy "public read" on public.semiconductor_news
--   for select using (true);
