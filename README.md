# 반도체 뉴스 자동 수집 → Supabase 저장

매일 지정한 시간에 반도체 관련 뉴스를 구글 뉴스 RSS로 모아서 Supabase에 저장하는 Cloudflare Worker입니다.

## 1. Supabase 테이블 만들기

1. Supabase 프로젝트 대시보드 → SQL Editor
2. `schema.sql` 내용 전체 붙여넣고 실행

## 2. 필요한 값 2가지 확인

Supabase 프로젝트 → Settings → API 에서:

- `Project URL` → `SUPABASE_URL`
- `service_role` 키 (secret, anon 키 아님!) → `SUPABASE_SERVICE_ROLE_KEY`

service_role 키는 RLS를 무시하고 쓰기 권한을 갖는 키라 **절대 프론트엔드나 공개 저장소에 노출되면 안 됩니다.**
Worker의 secret으로만 등록하세요.

## 3. 로컬 설정 및 배포

```bash
npm install -g wrangler   # 이미 있으면 생략
cd semi-news-worker
wrangler login

# 시크릿 등록 (프롬프트가 뜨면 값 붙여넣기)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# 배포
wrangler deploy
```

## 4. 동작 확인

배포되면 나오는 URL(예: `https://semi-news-worker.<your-subdomain>.workers.dev`)로
브라우저에서 직접 접속하면 즉시 1회 실행되고 결과가 JSON으로 보입니다.
크론이 도는 걸 기다릴 필요 없이 바로 테스트 가능해요.

정상이라면 이런 응답이 옵니다:
```json
{ "ok": true, "candidates": 37, "inserted": 37 }
```

Supabase 대시보드 → Table Editor → `semiconductor_news` 에서 저장된 데이터를 바로 확인하세요.

## 5. 스케줄 시간 바꾸기

`wrangler.toml`의 `crons` 값은 UTC 기준입니다. 현재는 매일 KST 08:00(UTC 23:00 전날)로 설정되어 있어요.
다른 시간으로 바꾸려면 `crontab.guru`에서 원하는 시간을 UTC로 변환해서 넣으면 됩니다.

## 6. 검색 키워드 바꾸기

`src/worker.js` 상단의 `KEYWORDS` 배열을 원하는 검색어로 수정하면 됩니다.
지금은 취업 준비 타겟(반도체 공정/파운드리/HBM/디스플레이 소재)에 맞춰 5개로 잡아뒀어요.

## 참고: 무료 티어로 충분한가?

- 하루 1번 실행 기준 Cloudflare Workers 무료 티어(하루 10만 요청, 계정당 크론 5개)로 여유 있게 커버됩니다.
- Supabase 무료 티어도 이 정도 데이터량(하루 수십 건)이면 용량 걱정 없습니다.
