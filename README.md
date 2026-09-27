# 반도체 뉴스 자동 수집 → Supabase 저장

1시간마다 반도체 관련 뉴스를 모아서 Supabase에 저장하는 Cloudflare Worker입니다.

수집 소스는 3가지이고, 하나가 죽어도 나머지가 계속 돕니다.

| 소스 | 설명 | 안정성 |
|---|---|---|
| 네이버 검색 API | 커버리지는 가장 넓지만 2026년 6월 NAVER API HUB로 이관됨 (아래 3-1 참고) | 키가 있을 때만 동작 |
| 언론사 공식 RSS 17개 | 디일렉·KIPOST·전자신문(4개 섹션)·연합·한경·조선비즈·머니투데이·뉴시스·이데일리·ZDNet·아이뉴스24·IT조선·블로터 | 차단 없음 |
| 구글 뉴스 RSS | 검색어 8개. 날짜 지정(`after:`/`before:`)으로 지난 날짜도 다시 받아올 수 있음 | Cloudflare IP를 자주 503으로 막아서 0건일 수 있음 (실패해도 무시하고 진행) |

제목·링크·한 줄 요약만 저장하고 본문은 언론사 원문으로 링크합니다.

## 1. Supabase 테이블 만들기

1. Supabase 프로젝트 대시보드 → SQL Editor
2. `schema.sql` 내용 전체 붙여넣고 실행

## 2. 필요한 값 확인

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

# (선택이지만 강력 추천) 네이버 검색 API 키 - 없으면 이 소스만 건너뜁니다
wrangler secret put NAVER_CLIENT_ID
wrangler secret put NAVER_CLIENT_SECRET

# 배포
wrangler deploy
```

## 3-1. 네이버 검색 API 키 (선택)

> **주의 (2026년 기준)**: 네이버 검색 API는 2026년 6월 **NAVER API HUB**(네이버 클라우드 플랫폼)로 이관됐습니다.
> 기존 developers.naver.com의 애플리케이션 등록 화면에서는 **사용 API 목록에 `검색`이 더 이상 보이지 않습니다.**
> 새로 쓰려면 네이버 클라우드 플랫폼에 가입해서 API HUB 이용 신청을 해야 하고,
> 현재는 한시적 무료(NAVER 검색 카테고리 월 775,000건)이지만 유료 전환 예정이라고 공지돼 있습니다.
>
> 즉 **네이버는 이제 "완전 무료로 계속"이 보장되지 않습니다.**
> 이 워커는 네이버 키가 없어도 언론사 RSS 17개 + 구글 뉴스만으로 동작하니, 키는 선택 사항입니다.

이미 발급받은 (또는 API HUB에서 새로 발급받은) Client ID/Secret이 있으면
`NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` 시크릿에 넣으면 자동으로 소스에 추가됩니다.
없으면 해당 소스만 건너뛰고 나머지는 그대로 돕니다.

## 3-2. 배포하지 않고 로컬에서 돌려보기

```bash
cp .dev.vars.example .dev.vars   # 파일을 열어 Supabase 값 2개를 직접 붙여넣기
npx wrangler dev
```

`http://localhost:8787` 에서 배포된 것과 똑같이 동작합니다.

알아둘 점 두 가지:

- **로컬도 진짜 Supabase에 씁니다.** `.dev.vars`에 실제 service_role 키를 넣으니
  로컬에서 `/collect`나 `/backfill`을 부르면 실제 DB에 그대로 저장됩니다.
  즉 지난 날짜 메우기는 배포 없이 로컬에서 해도 됩니다.
- **크론은 로컬에서 자동으로 안 돕니다.** 수동으로 부르세요.

  ```bash
  curl "http://localhost:8787/cdn-cgi/local/scheduled"                    # 1시간마다 수집
  curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=30+21+*+*+*"   # 어제 백필
  ```

  자동 수집을 계속 돌리려면 결국 `npx wrangler deploy`로 배포해야 합니다.
  (로컬은 컴퓨터가 켜져 있고 dev 서버가 떠 있을 때만 동작)

## 4. 동작 확인

배포되면 나오는 URL(예: `https://seminews.<your-subdomain>.workers.dev`)로 접속하면
저장된 뉴스 목록 페이지가 뜹니다. 날짜를 바꿔 보려면 `/?date=2026-09-17` 형식으로 붙이면 돼요.

`/collect`로 접속하면 즉시 1회 수집하고, **어느 소스가 몇 건 가져왔는지**까지 같이 보여줍니다.
구글이 막혔는지, 어떤 RSS가 죽었는지 여기서 바로 확인하면 됩니다.

```json
{
  "ok": true,
  "candidates": 120,
  "summary": { "naver": 95, "press": 52, "google": 0, "merged": 120 },
  "sources": [
    { "source": "네이버:반도체(1)", "status": "ok", "count": 100 },
    { "source": "디일렉(RSS)", "status": "ok", "count": 8, "scanned": 50 },
    { "source": "구글:반도체", "status": "HTTP 503", "count": 0 }
  ]
}
```

### 과거 날짜 메우기

언론사 RSS는 최근 기사만 들고 있어서 지나간 날짜를 못 채웁니다. 대신 **구글 뉴스의 날짜 검색**을 씁니다.

```
/backfill?date=2026-09-17                # 하루만
/backfill?from=2026-09-25&to=2026-09-26  # 여러 날 (한 번에 최대 2일)
```

매일 **KST 06:30**에 어제 하루치를 자동으로 다시 훑는 크론이 따로 돌기 때문에,
평소에는 직접 부를 일이 거의 없습니다. 더 예전 날짜를 메울 때만 쓰세요.

구글 뉴스 검색어에 `after:` / `before:` 연산자를 붙여서 그 날짜 기사를 다시 받아옵니다.
여러 번 실행해도 중복은 자동으로 걸러지니 안전합니다.
응답의 `구글수집` 값이 0이면 구글이 Cloudflare IP를 막고 있다는 뜻입니다.

네이버 키가 있다면 `/collect?deep=1`로도 며칠 전까지 거슬러 올라갈 수 있습니다.

Supabase 대시보드 → Table Editor → `semiconductor_news` 에서 저장된 데이터를 바로 확인하세요.

## 5. 스케줄 바꾸기

`wrangler.toml`의 `crons` 값은 UTC 기준입니다. 현재는 1시간마다(`0 * * * *`) 실행됩니다.
ZDNet 같은 일부 피드는 기사가 1~2시간이면 목록에서 밀려나가서, 2시간 주기로는 놓치는 기사가 생깁니다.
다른 주기/시간으로 바꾸려면 `crontab.guru`에서 원하는 표현식을 만들어서 넣으면 됩니다.

## 6. 검색 키워드 바꾸기

- `KEYWORDS` — 구글 뉴스 검색어
- `NAVER_QUERIES` — 네이버 검색 API 검색어
- `PRESS_FEEDS` — 언론사 RSS 목록 (죽은 주소는 `/collect` 응답에 HTTP 404/403으로 찍힘)
- `FILTER_KEYWORDS` — 언론사 RSS에서 반도체 기사를 골라낼 키워드 (제목 우선, 없으면 요약까지 검사)
- `EXCLUDE_KEYWORDS` — 갤럭시 등 완제품 기사 제외 목록

## 7. 수집 엔드포인트 잠그기 (선택)

`/collect`와 `/backfill`은 DB에 쓰는 주소라, 주소를 아는 사람은 누구나 호출할 수 있습니다.
신경 쓰인다면 아무 문자열이나 토큰으로 등록해 두세요.

```bash
npx wrangler secret put COLLECT_TOKEN
```

등록하면 `?token=...`이 맞을 때만 동작하고, 등록하지 않으면 지금처럼 공개 상태로 둡니다.
크론 자동 수집은 토큰과 무관하게 계속 돕니다.

## 참고: 무료 티어로 충분한가?

- Cloudflare Workers 무료 티어(하루 10만 요청)로 1시간마다 실행해도 여유 있습니다.
- 다만 무료 플랜은 **요청 1건당 외부 호출 50개** 제한이 있어서, 평소 수집은 36개(네이버 10 + RSS 17 + 구글 8 + 저장 1), `deep=1`은 41개, `/backfill`은 최대 33개(검색어 8 × 4일 + 저장 1)로 한도 안쪽에 맞춰뒀습니다. 소스를 더 늘릴 땐 이 숫자를 넘지 않게 주의하세요.
- 무료 플랜은 **요청당 CPU 10ms** 제한도 있습니다. 이게 실제로 제일 빡빡한 한도라 아래를 맞춰뒀습니다.
  - RSS 파싱: 언론사 피드는 반도체 키워드가 없는 기사를 디코딩 전에 걸러내고, 구글은 검색어당 50건까지만 파싱
  - 중복 기사 그룹핑: 단어 색인을 써서 200건 기준 약 20ms → 4ms로 단축
  - 중복 그룹핑 최적화 덕분에 한 페이지 500건까지 그려도 렌더 4.8ms (예전 방식은 그룹핑에만 50ms)
  - 페이지 응답에 캐시 헤더를 붙이고 Cloudflare 캐시에도 저장 (오늘 5분 / 지난 날짜 1시간).
    캐시 저장은 커스텀 도메인에서 확실히 동작하고, workers.dev 주소에서는 보장되지 않습니다.
    다만 브라우저 캐시는 어느 쪽이든 먹습니다.
- 네이버 검색 API 무료 한도는 하루 25,000회로, 현재 사용량은 하루 240회입니다.
- Supabase 무료 티어도 이 정도 데이터량(하루 수십 건)이면 용량 걱정 없습니다.
