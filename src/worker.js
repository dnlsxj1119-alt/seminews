// 반도체 뉴스 수집 -> Supabase 저장 (Cloudflare Workers Cron)
//
// 흐름:
// 1. 구글 뉴스 RSS (검색어 기반) + 언론사 자체 RSS (전체 기사 + 키워드 필터링) 둘 다 시도
//    - 구글 뉴스는 Cloudflare 등 데이터센터 IP를 자주 차단(503)해서 안 될 수 있음 -> 실패해도 무시하고 계속 진행
//    - 언론사 RSS는 IP 차단이 없어 훨씬 안정적이라 메인 소스로 사용
// 2. RSS(XML)를 파싱해서 기사 목록 추출
// 3. Supabase REST API로 insert (link가 unique라서 중복 기사는 자동 무시됨)

const KEYWORDS = [
  "반도체",
  "삼성전자 (반도체 OR 파운드리)",
  "SK하이닉스",
  "HBM OR 고대역폭메모리",
  "파운드리",
  "EUV OR 노광",
  "첨단 패키징 OR Advanced Packaging",
  "반도체 장비 OR ASML OR Applied Materials OR Lam Research",
];

// 네이버 검색 API용 검색어. 구글 뉴스와 달리 공식 API라 IP 차단이 없어서 메인 소스로 쓴다.
// NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 시크릿이 없으면 이 소스는 통째로 건너뛴다.
const NAVER_QUERIES = [
  "반도체",
  "HBM",
  "파운드리",
  "SK하이닉스 반도체",
  "삼성전자 파운드리",
  "D램 메모리",
  "낸드플래시",
  "EUV 노광",
  "반도체 장비",
  "첨단 패키징",
];

// 반도체 전용 검색 RSS가 없는 언론사는 전체 기사 피드를 받아서 키워드로 걸러낸다.
// 모두 2026-09-18 기준으로 응답을 확인한 주소. 죽은 피드(404/403)는 한 번 실패해도
// 다른 피드에 영향이 없도록 개별 처리되지만, 애초에 살아있는 것만 넣어둠.
const PRESS_FEEDS = [
  // 반도체/전자 전문지 - 기사 밀도가 가장 높음
  { source: "디일렉", url: "https://www.thelec.kr/rss/allArticle.xml" },
  { source: "KIPOST", url: "https://www.kipost.net/rss/allArticle.xml" },
  // 전자신문 섹션별 (901 전체, 902~904 산업/IT)
  { source: "전자신문", url: "https://rss.etnews.com/Section901.xml" },
  { source: "전자신문", url: "https://rss.etnews.com/Section902.xml" },
  { source: "전자신문", url: "https://rss.etnews.com/Section903.xml" },
  { source: "전자신문", url: "https://rss.etnews.com/Section904.xml" },
  // 종합/경제지
  { source: "연합뉴스", url: "https://www.yna.co.kr/rss/economy.xml" },
  { source: "한국경제", url: "https://www.hankyung.com/feed/economy" },
  { source: "한국경제 IT", url: "https://www.hankyung.com/feed/it" },
  { source: "조선비즈", url: "https://biz.chosun.com/arc/outboundfeeds/rss/?outputType=xml" },
  { source: "머니투데이", url: "https://rss.mt.co.kr/mt_news.xml" },
  { source: "뉴시스", url: "https://newsis.com/RSS/industry.xml" },
  // 이데일리는 https 인증서가 구형 알고리즘이라 TLS 연결이 실패해서 http로 받는다 (공개 RSS라 무방)
  { source: "이데일리", url: "http://rss.edaily.co.kr/edaily_news.xml" },
  // IT 전문
  { source: "ZDNet Korea", url: "https://zdnet.co.kr/feed/" },
  { source: "아이뉴스24", url: "https://www.inews24.com/rss/news_it.xml" },
  { source: "IT조선", url: "https://it.chosun.com/rss/allArticle.xml" },
  { source: "블로터", url: "https://www.bloter.net/rss/allArticle.xml" },
];

// 회사명은 일부러 뺐음: 삼성전자/SK하이닉스 단독 언급만으로 매칭하면
// 갤럭시 스마트폰 같은 완제품(DX) 기사까지 걸려서 아래 키워드로만 판단
const FILTER_KEYWORDS = [
  "반도체",
  "파운드리",
  "HBM",
  "고대역폭메모리",
  "EUV",
  "노광",
  "낸드",
  "D램",
  "디램",
  "웨이퍼",
  "패키징",
  "ASML",
  "Applied Materials",
  "Lam Research",
  "TSMC",
];

// 제목에 키워드가 없고 요약에만 있는 기사도 건지되, 오탐이 잦은 단어는 뺀다.
// ("패키징"은 식품/물류 기사, "노광"은 일반 기사 본문에 섞여 들어오는 경우가 있음)
const DESCRIPTION_FILTER_KEYWORDS = FILTER_KEYWORDS.filter(
  (kw) => kw !== "패키징" && kw !== "노광"
);

// 완제품 브랜드/모델명처럼 확실한 경우만 제외. "가전"/"아이폰" 같은 범용 단어는
// TSMC 가격 인상, 반도체 부문 성과급 기사 등에도 흔히 같이 나와서 오탐이 많아 제외
const EXCLUDE_KEYWORDS = [
  "갤럭시",
  "갤Z",
  "갤S",
  "갤워치",
  "갤탭",
  "갤노트",
  "트라이폴드",
  "이어버드",
  "에어팟",
];

// 네이버 검색 결과는 원문 링크만 오고 언론사명이 없어서 도메인으로 역추적한다.
const SOURCE_BY_HOST = [
  ["yna.co.kr", "연합뉴스"],
  ["hankyung.com", "한국경제"],
  ["mk.co.kr", "매일경제"],
  ["etnews.com", "전자신문"],
  ["thelec.kr", "디일렉"],
  ["kipost.net", "KIPOST"],
  ["sedaily.com", "서울경제"],
  ["edaily.co.kr", "이데일리"],
  ["mt.co.kr", "머니투데이"],
  ["ddaily.co.kr", "디지털데일리"],
  ["zdnet.co.kr", "ZDNet Korea"],
  ["biz.chosun.com", "조선비즈"],
  ["it.chosun.com", "IT조선"],
  ["chosun.com", "조선일보"],
  ["newsis.com", "뉴시스"],
  ["inews24.com", "아이뉴스24"],
  ["fnnews.com", "파이낸셜뉴스"],
  ["heraldcorp.com", "헤럴드경제"],
  ["bloter.net", "블로터"],
  ["seoul.co.kr", "서울신문"],
  ["donga.com", "동아일보"],
  ["hani.co.kr", "한겨레"],
  ["khan.co.kr", "경향신문"],
  ["joongang.co.kr", "중앙일보"],
  ["news.naver.com", "네이버뉴스"],
];

function sourceFromLink(link) {
  try {
    const host = new URL(link).hostname.replace(/^www\./, "");
    const hit = SOURCE_BY_HOST.find(([h]) => host === h || host.endsWith(`.${h}`) || host.includes(h));
    return hit ? hit[1] : host;
  } catch {
    return null;
  }
}

function buildGoogleRssUrl(keyword, dateStr = null) {
  // 구글 뉴스는 검색어에 after:/before: 연산자를 지원해서 지난 날짜도 다시 받아올 수 있다.
  // (구글 기준 시간대라 앞뒤 날짜가 조금 섞여 들어오지만, 저장은 실제 published_at 기준이라 무방)
  const query = dateStr
    ? `${keyword} after:${shiftDateStr(dateStr, -1)} before:${shiftDateStr(dateStr, 1)}`
    : keyword;
  const q = encodeURIComponent(query);
  // hl/gl/ceid = 한국어, 한국 지역 설정
  return `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
}

// 무료 플랜은 요청당 CPU가 10ms뿐이라 문자열을 여러 번 훑지 않는다.
// 예전엔 replace를 7번 연속으로 돌려서 기사 하나당 문자열을 7번 스캔했음.
const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decode(s) {
  if (s.indexOf("<![CDATA[") !== -1) {
    s = s.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
  }
  if (s.indexOf("&") !== -1) {
    s = s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m]);
  }
  return s.trim();
}

function safeIsoDate(raw) {
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// 1순위는 제목, 제목에 없으면 요약(description)까지 본다.
// 제목만 보던 시절엔 피드당 1~2건밖에 안 걸려서 하루 수집량이 5건 수준으로 떨어졌음.
// 제외 키워드는 제목 기준으로만 적용 (요약 끝에 스친 완제품 언급까지 버리면 오히려 손해)
function matchFilterKeyword(title, description = "") {
  if (EXCLUDE_KEYWORDS.some((kw) => title.includes(kw))) return null;
  const byTitle = FILTER_KEYWORDS.find((kw) => title.includes(kw));
  if (byTitle) return byTitle;
  if (!description) return null;
  return DESCRIPTION_FILTER_KEYWORDS.find((kw) => description.includes(kw)) || null;
}

// 한줄 요약용: HTML 태그 제거 + 공백 정리 + 길이 제한
function cleanDescription(raw, maxLen = 110) {
  if (!raw) return "";
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxLen ? `${text.slice(0, maxLen).trim()}…` : text;
}

// 태그 하나만 꺼낸다. `<tag ...>` 형태의 속성도 같이 처리.
// 정규식 /<tag>([\s\S]*?)<\/tag>/ 보다 indexOf가 눈에 띄게 싸다.
function pickTag(block, tag) {
  const open = block.indexOf(`<${tag}`);
  if (open === -1) return null;
  const contentStart = block.indexOf(">", open);
  if (contentStart === -1) return null;
  const close = block.indexOf(`</${tag}>`, contentStart);
  if (close === -1) return null;
  return block.slice(contentStart + 1, close);
}

// RSS(XML)는 언론사마다 구조가 대체로 비슷해서 태그 위치만 찾아도 안전하게 파싱된다.
//   limit     - 앞에서부터 이 건수만 파싱 (구글은 검색어당 100건씩 오는데 매시간 도니 그만큼 필요 없음)
//   preFilter - 디코딩 전에 원문 블록을 한 번 걸러낸다. 언론사 전체 피드는 90% 이상이
//               반도체와 무관해서, 이걸 통과 못 한 기사는 파싱 자체를 건너뛴다.
function parseItemBlocks(xml, { limit = Infinity, preFilter = null } = {}) {
  const items = [];
  const blocks = xml.split("<item>");

  for (let i = 1; i < blocks.length && items.length < limit; i++) {
    const block = blocks[i];
    if (preFilter && !preFilter.test(block)) continue;

    const rawTitle = pickTag(block, "title");
    const rawLink = pickTag(block, "link");
    if (rawTitle === null || rawLink === null) continue;

    const rawSource = pickTag(block, "source");
    const rawPubDate = pickTag(block, "pubDate");
    const rawDesc = pickTag(block, "description");

    items.push({
      title: decode(rawTitle),
      link: decode(rawLink),
      description: rawDesc === null ? "" : decode(rawDesc),
      source: rawSource === null ? null : decode(rawSource),
      published_at: rawPubDate === null ? null : safeIsoDate(rawPubDate),
    });
  }

  return items;
}

// 언론사 전체 피드에서 반도체 후보 기사만 1차로 추려내는 정규식.
// 정규식 객체는 한 번만 만들어 재사용 (매 기사마다 new RegExp 하면 그게 더 비쌈)
const PRE_FILTER_RE = new RegExp(
  [...new Set([...FILTER_KEYWORDS, ...DESCRIPTION_FILTER_KEYWORDS])]
    .map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
);

// 구글 뉴스는 검색어당 최대 100건을 주는데, 1시간마다 도는 지금은 그만큼 필요 없다.
// 과거 날짜를 메우는 /backfill 은 하루치를 통째로 받아야 해서 상한을 따로 둔다.
const GOOGLE_ITEM_LIMIT = 50;
const GOOGLE_BACKFILL_ITEM_LIMIT = 100;

// 네트워크가 느린 피드 하나 때문에 전체 수집이 멈추지 않도록 타임아웃을 건다.
async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url.url || url, {
      headers: { "User-Agent": "Mozilla/5.0", ...(url.headers || {}) },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// 구글 뉴스: 검색어별로 호출, 실패해도 다른 검색어/소스에 영향 없게 개별 처리.
// Cloudflare 데이터센터 IP는 구글이 자주 503으로 막기 때문에 0건이 정상일 수 있다.
// 어느 소스가 몇 건 가져왔는지 stats로 같이 돌려줘서 /collect에서 바로 확인 가능하게 함.
async function fetchGoogleNews(dateStr = null) {
  const stats = [];
  const label = dateStr ? `구글[${dateStr}]` : "구글";
  const results = await Promise.all(
    KEYWORDS.map(async (keyword) => {
      try {
        const res = await fetchWithTimeout(buildGoogleRssUrl(keyword, dateStr));
        if (!res.ok) {
          stats.push({ source: `${label}:${keyword}`, status: `HTTP ${res.status}`, count: 0 });
          console.error(`구글 뉴스 RSS 실패 "${keyword}": ${res.status}`);
          return [];
        }
        const xml = await res.text();
        const items = parseItemBlocks(xml, {
          limit: dateStr ? GOOGLE_BACKFILL_ITEM_LIMIT : GOOGLE_ITEM_LIMIT,
        })
          .filter((item) => !EXCLUDE_KEYWORDS.some((kw) => item.title.includes(kw)))
          .map((item) => ({
            title: item.title,
            link: item.link,
            source: item.source || "Google News",
            keyword,
            description: cleanDescription(item.description),
            published_at: item.published_at,
          }));
        stats.push({ source: `${label}:${keyword}`, status: "ok", count: items.length });
        return items;
      } catch (err) {
        stats.push({ source: `${label}:${keyword}`, status: `에러 ${err.message}`, count: 0 });
        console.error(`구글 뉴스 RSS 에러 "${keyword}": ${err.message}`);
        return [];
      }
    })
  );
  return { items: results.flat(), stats };
}

// 네이버 검색 API: 공식 API라 IP 차단이 없고 전 언론사를 검색어로 훑을 수 있어 커버리지가 가장 넓다.
// 무료 한도 하루 25,000회 (지금 설정: 검색어 10개 x 1페이지 x 24회 = 하루 240회로 여유 있음)
async function fetchNaverNews(env, { pages = 1 } = {}) {
  const clientId = env.NAVER_CLIENT_ID;
  const clientSecret = env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      items: [],
      stats: [{ source: "네이버 API", status: "건너뜀 (NAVER_CLIENT_ID/SECRET 미설정)", count: 0 }],
    };
  }

  const stats = [];
  const jobs = [];
  for (const query of NAVER_QUERIES) {
    for (let page = 0; page < pages; page++) {
      jobs.push({ query, start: page * 100 + 1 });
    }
  }

  const results = await Promise.all(
    jobs.map(async ({ query, start }) => {
      const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(
        query
      )}&display=100&start=${start}&sort=date`;
      try {
        const res = await fetchWithTimeout({
          url,
          headers: { "X-Naver-Client-Id": clientId, "X-Naver-Client-Secret": clientSecret },
        });
        if (!res.ok) {
          stats.push({ source: `네이버:${query}(${start})`, status: `HTTP ${res.status}`, count: 0 });
          return [];
        }
        const json = await res.json();
        const items = (json.items || [])
          .map((raw) => {
            // 검색어 하이라이트용 <b> 태그가 섞여 오므로 제거
            const title = decode(raw.title.replace(/<[^>]*>/g, ""));
            const link = raw.originallink || raw.link;
            return {
              title,
              link,
              source: sourceFromLink(link) || "네이버뉴스",
              keyword: query,
              description: cleanDescription(decode(raw.description || "")),
              published_at: safeIsoDate(raw.pubDate),
            };
          })
          .filter((item) => item.link && !EXCLUDE_KEYWORDS.some((kw) => item.title.includes(kw)));
        stats.push({ source: `네이버:${query}(${start})`, status: "ok", count: items.length });
        return items;
      } catch (err) {
        stats.push({ source: `네이버:${query}(${start})`, status: `에러 ${err.message}`, count: 0 });
        return [];
      }
    })
  );

  return { items: results.flat(), stats };
}

// 언론사 자체 RSS: 전체 기사 피드를 받아서 반도체 관련 키워드가 있는 기사만 통과
async function fetchPressNews() {
  const stats = [];
  const results = await Promise.all(
    PRESS_FEEDS.map(async (feed) => {
      try {
        const res = await fetchWithTimeout(feed.url);
        if (!res.ok) {
          stats.push({ source: `${feed.source}(RSS)`, status: `HTTP ${res.status}`, count: 0 });
          console.error(`언론사 RSS 실패 [${feed.source}]: ${res.status}`);
          return [];
        }
        const xml = await res.text();
        // 반도체 키워드가 원문에 아예 없는 기사는 파싱 전에 버린다 (전체 피드의 90% 이상)
        const items = parseItemBlocks(xml, { preFilter: PRE_FILTER_RE });

        const matched = [];
        for (const item of items) {
          const description = cleanDescription(item.description, 200);
          const keyword = matchFilterKeyword(item.title, description);
          if (!keyword) continue;
          matched.push({
            title: item.title,
            link: item.link,
            source: feed.source,
            keyword,
            description: cleanDescription(item.description),
            published_at: item.published_at,
          });
        }
        stats.push({
          source: `${feed.source}(RSS)`,
          status: "ok",
          count: matched.length,
          candidates: items.length, // 사전 필터를 통과해 실제로 파싱된 건수
        });
        return matched;
      } catch (err) {
        stats.push({ source: `${feed.source}(RSS)`, status: `에러 ${err.message}`, count: 0 });
        console.error(`언론사 RSS 에러 [${feed.source}]: ${err.message}`);
        return [];
      }
    })
  );
  return { items: results.flat(), stats };
}

// 지난 날짜 다시 긁어오기.
// RSS는 최근 기사만 들고 있어서 과거를 못 메우지만, 구글 뉴스는 after:/before: 연산자로
// 특정 날짜를 지정할 수 있어서 "어제/엊그제가 몇 건밖에 없는" 구멍을 메울 수 있다.
// 한 번에 최대 2일까지만. 서브리퀘스트(검색어 8개 x 2일 = 16)보다 CPU 10ms 한도가 먼저 걸린다.
// 하루치가 검색어당 100건이라 2일이면 1,600건을 파싱하게 되는데 이게 대략 4~5ms.
const MAX_BACKFILL_DAYS = 2;

// wrangler.toml의 크론 표현식과 반드시 같아야 한다 (어느 트리거인지 구분하는 값)
const DAILY_BACKFILL_CRON = "30 21 * * *";

async function backfillNews(env, fromStr, toStr) {
  const dates = [];
  let cursor = toStr;
  while (cursor >= fromStr && dates.length < MAX_BACKFILL_DAYS) {
    dates.push(cursor);
    cursor = shiftDateStr(cursor, -1);
  }

  const days = await Promise.all(dates.map((d) => fetchGoogleNews(d)));

  const seen = new Set();
  const items = [];
  for (const day of days) {
    for (const item of day.items) {
      if (!item.link || seen.has(item.link)) continue;
      seen.add(item.link);
      items.push(item);
    }
  }
  return { items, stats: days.flatMap((d) => d.stats), dates };
}

// Cloudflare 무료 플랜은 요청 1건당 외부 호출(서브리퀘스트)이 50개로 제한된다.
// 평소 수집: 네이버 10 + 언론사 RSS 17 + 구글 8 + Supabase 1 = 36개로 한도 안쪽.
// 과거 메우기(deep): 네이버만 10개 검색어 x 4페이지 = 40 + 1 = 41개로 역시 한도 안쪽.
async function fetchAllNews(env, options = {}) {
  const { naverOnly = false, pages = 1 } = options;

  const [naver, press, google] = await Promise.all([
    fetchNaverNews(env, { pages }),
    naverOnly ? { items: [], stats: [] } : fetchPressNews(),
    naverOnly ? { items: [], stats: [] } : fetchGoogleNews(),
  ]);

  // 여러 소스에서 겹치는 기사(같은 link)는 여기서 1차로 중복 제거.
  // 네이버를 먼저 두는 이유: 언론사명/요약 품질이 가장 좋아서 대표값으로 남기려고.
  const seen = new Set();
  const merged = [];
  for (const item of [...naver.items, ...press.items, ...google.items]) {
    if (!item.link || seen.has(item.link)) continue;
    seen.add(item.link);
    merged.push(item);
  }

  const summary = {
    naver: naver.items.length,
    press: press.items.length,
    google: google.items.length,
    merged: merged.length,
  };
  const stats = [...naver.stats, ...press.stats, ...google.stats];
  return { items: merged, stats, summary };
}

// 한 번에 보내는 최대 건수. 백필하면 700건이 넘게 나오는데, 한 요청에 다 실으면
// 행 하나만 문제가 생겨도 전부 실패한다. 나눠 보내면 실패해도 나머지는 살아남는다.
const SAVE_CHUNK_SIZE = 250;

async function saveToSupabase(env, items) {
  if (items.length === 0) return { inserted: 0 };

  if (items.length > SAVE_CHUNK_SIZE) {
    let inserted = 0;
    const failures = [];
    for (let i = 0; i < items.length; i += SAVE_CHUNK_SIZE) {
      const chunk = items.slice(i, i + SAVE_CHUNK_SIZE);
      try {
        await saveChunk(env, chunk);
        inserted += chunk.length;
      } catch (err) {
        failures.push(err.message);
      }
    }
    if (inserted === 0) throw new Error(failures[0] || "Supabase 저장 실패");
    return failures.length ? { inserted, saveErrors: failures } : { inserted };
  }

  await saveChunk(env, items);
  return { inserted: items.length };
}

async function saveChunk(env, items) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/semiconductor_news?on_conflict=link`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        // link가 unique 컬럼. 이미 있는 기사는 새 값으로 갱신(upsert)해서
        // description처럼 나중에 추가된 필드도 재수집 시 기존 행에 채워지게 함
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(items),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} ${text}`);
  }
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// KST 기준 오늘 날짜 문자열 (YYYY-MM-DD)
function kstDateString(date = new Date()) {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// KST 캘린더 날짜 하루의 UTC 시작/끝 시각
function kstDayRangeUtc(dateStr) {
  const startUtc = new Date(`${dateStr}T00:00:00+09:00`);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

function shiftDateStr(dateStr, days) {
  const { startUtc } = kstDayRangeUtc(dateStr);
  return kstDateString(new Date(startUtc.getTime() + days * 24 * 60 * 60 * 1000 + KST_OFFSET_MS));
}

function isValidDateStr(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

// 해당 KST 날짜 하루치 기사만 조회.
// 한 페이지 상한. 그룹핑을 단어 색인으로 바꾼 뒤로는 500건을 그려도 그룹핑 4.6ms,
// 전체 렌더 4.8ms라 무료 플랜 CPU 한도(요청당 10ms) 안에 들어온다.
// (색인 전 방식은 같은 500건에서 그룹핑에만 50ms가 들었다)
const MAX_ITEMS_PER_PAGE = 500;

async function fetchNewsForDate(env, dateStr, limit = MAX_ITEMS_PER_PAGE) {
  const { startUtc, endUtc } = kstDayRangeUtc(dateStr);
  const params = new URLSearchParams({
    select: "title,link,source,keyword,description,published_at,collected_at",
    order: "published_at.desc.nullslast",
    limit: String(limit),
  });
  params.append("published_at", `gte.${startUtc.toISOString()}`);
  params.append("published_at", `lt.${endUtc.toISOString()}`);

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/semiconductor_news?${params}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase 조회 실패: ${res.status} ${text}`);
  }
  return res.json();
}

// 날짜 구간 조회 (오늘 기사가 모자랄 때 과거를 한 번에 가져오는 용도)
async function fetchNewsInRange(env, fromStr, toStr, limit = MAX_ITEMS_PER_PAGE) {
  const { startUtc } = kstDayRangeUtc(fromStr);
  const { endUtc } = kstDayRangeUtc(toStr);
  const params = new URLSearchParams({
    select: "title,link,source,keyword,description,published_at,collected_at",
    order: "published_at.desc.nullslast",
    limit: String(limit),
  });
  params.append("published_at", `gte.${startUtc.toISOString()}`);
  params.append("published_at", `lt.${endUtc.toISOString()}`);

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/semiconductor_news?${params}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase 조회 실패: ${res.status} ${text}`);
  }
  return res.json();
}

// 오늘 기사가 너무 적으면(이른 아침 등) 최소 개수를 채울 때까지 하루씩 과거로 확장해서 합치되,
// 과거 하루치가 통째로 들어와 리스트가 너무 길어지지 않도록 최근 cap건으로 자른다.
// cap이 40이던 시절엔 하루 수집량 자체가 적어서 문제가 없었는데, 소스를 늘린 뒤로는
// 하루 200건 넘게 들어와서 오늘 화면이 40건에서 잘려 보였다.
async function fetchNewsWithMinimum(env, dateStr, minCount = 10, cap = 100, maxLookbackDays = 14) {
  // 오늘치부터 먼저 본다. 대부분은 여기서 끝나고 쿼리 1번으로 충분하다.
  let news = await fetchNewsForDate(env, dateStr, cap);

  // 모자랄 때만 과거를 본다. 예전엔 하루씩 최대 14번을 순차로 물어봤는데,
  // 어차피 최신순 정렬이라 14일 범위를 한 번에 물어보면 결과가 같고 왕복이 1번으로 끝난다.
  if (news.length < minCount) {
    const seen = new Set(news.map((item) => item.link));
    const lookbackStart = shiftDateStr(dateStr, -maxLookbackDays);
    const past = await fetchNewsInRange(env, lookbackStart, shiftDateStr(dateStr, -1), cap);
    for (const item of past) {
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      news.push(item);
    }
  }

  news.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
  if (news.length > cap) news = news.slice(0, cap);

  const oldestDateUsed = news.reduce((min, it) => {
    if (!it.published_at) return min;
    const d = kstDateString(new Date(it.published_at));
    return d < min ? d : min;
  }, dateStr);

  return { news, oldestDateUsed };
}

// 주요 매체 가중치 (Top 스코어링용). 목록에 없으면 기본값 1.5,
// 포털 미러(v.daum.net, 네이트 등 원 언론사가 아닌 배포 경로)는 0.5로 낮게.
const SOURCE_WEIGHT = {
  "연합뉴스": 5,
  "뉴시스": 4,
  "동아일보": 3,
  "중앙일보": 3,
  "조선일보": 3,
  "한겨레": 3,
  "경향신문": 3,
  "서울신문": 3,
  "파이낸셜뉴스": 3,
  "헤럴드경제": 3,
  "블로터": 2.5,
  "KIPOST": 3,
  "아이뉴스24": 3,
  "한국경제": 4,
  "한국경제 IT": 4,
  "전자신문": 4,
  "조선비즈": 4,
  "매일경제": 4,
  "서울경제": 3,
  "이데일리": 3,
  "머니투데이": 3,
  "디지털데일리": 3,
  "ZDNet Korea": 3,
  "디일렉": 3,
  "IT조선": 3,
};
const PORTAL_MIRROR_SOURCES = new Set([
  "v.daum.net",
  "news.nate.com",
  "네이트",
  "다음",
  "m.blog.naver.com",
  "네이버뉴스",
  "n.news.naver.com",
  "news.naver.com",
]);

function sourceWeight(source) {
  if (!source) return 1;
  if (SOURCE_WEIGHT[source] != null) return SOURCE_WEIGHT[source];
  if (PORTAL_MIRROR_SOURCES.has(source)) return 0.5;
  return 1.5;
}

// 구글 뉴스 등에서 "실제 제목 - 언론사명" 형태로 오는 title에서 언론사 접미사를 제거
function splitTitleSource(rawTitle) {
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx === -1) return rawTitle;
  const candidate = rawTitle.slice(idx + 3).trim();
  const clean = rawTitle.slice(0, idx).trim();
  // 접미사가 너무 길거나 비어있으면 실제 제목의 일부일 가능성이 높아 자르지 않음
  if (!clean || !candidate || candidate.length > 25) return rawTitle;
  return clean;
}

// 유사 제목 그룹핑용 정규화: 대괄호 태그/공백/기호 제거
function normalizeForDedup(title) {
  return title
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\s()「」『』<>·,.!?"'\-–—:;]/g, "")
    .toLowerCase();
}

// 구글 뉴스 description이 "제목 + 언론사명" 재조합일 뿐 실제 요약이 아닌 경우 걸러내기
function isRedundantSummary(desc, title) {
  const normDesc = normalizeForDedup(desc);
  const normTitle = normalizeForDedup(title);
  if (!normDesc) return true;
  if (normDesc === normTitle) return true;
  if (normDesc.startsWith(normTitle) && normDesc.length - normTitle.length <= 20) return true;
  return false;
}

// 제목을 의미 단위(단어) 토큰으로 분리. 앞부분만 비교하는 방식은 "2년 연속 1위" vs
// "1위...삼성전자는 2위"처럼 순위 표현이 앞쪽에서 갈리는 경우를 못 잡아서 단어 집합으로 비교한다.
function extractTokens(title) {
  return title
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[,.!?"'“”()「」『』<>·\-–—:;…]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

const SIMILARITY_THRESHOLD = 0.5;

// 같은 기사를 여러 매체가 받아쓴 경우 하나로 묶는다.
// 대표 기사는 매체 가중치가 높은 쪽을 우선 선택.
//
// 예전엔 기사마다 기존 클러스터를 전부 훑으면서 그때그때 Set을 두 개씩 새로 만들었다.
// 과거 날짜를 백필하면 하루 200건이 넘는데, 그러면 그룹핑에만 20ms 넘게 써서
// 무료 플랜 CPU 한도(요청당 10ms)를 혼자 다 먹어버린다.
// 그래서 단어 -> 클러스터 색인을 만들어 두고, 단어를 하나라도 공유하는 클러스터만 비교한다.
// 어차피 공통 단어가 0개면 자카드 유사도도 0이라 결과는 같다.
function groupSimilarNews(news) {
  const clusters = []; // { items, tokenSet }
  const tokenIndex = new Map(); // 단어 -> 그 단어를 가진 클러스터 번호 목록

  for (const raw of news) {
    const cleanTitle = splitTitleSource(raw.title);
    const tokenSet = new Set(extractTokens(cleanTitle));
    const entry = { ...raw, cleanTitle };

    // 후보 클러스터별로 공통 단어 수를 세어 둔다 (자카드 분자)
    const overlaps = new Map();
    for (const token of tokenSet) {
      const owners = tokenIndex.get(token);
      if (!owners) continue;
      for (const idx of owners) overlaps.set(idx, (overlaps.get(idx) || 0) + 1);
    }

    // 먼저 만들어진 클러스터를 우선 (기존 동작과 동일하게 유지).
    // 후보를 정렬하지 않고 한 번만 훑으면서 조건을 만족하는 가장 작은 번호를 고른다.
    let matchIdx = -1;
    for (const [idx, overlap] of overlaps) {
      if (matchIdx !== -1 && idx > matchIdx) continue;
      const unionSize = clusters[idx].tokenSet.size + tokenSet.size - overlap;
      if (unionSize > 0 && overlap / unionSize >= SIMILARITY_THRESHOLD) matchIdx = idx;
    }

    if (matchIdx !== -1) {
      clusters[matchIdx].items.push(entry);
      continue;
    }

    const newIdx = clusters.length;
    clusters.push({ items: [entry], tokenSet });
    for (const token of tokenSet) {
      const owners = tokenIndex.get(token);
      if (owners) owners.push(newIdx);
      else tokenIndex.set(token, [newIdx]);
    }
  }

  return clusters.map(({ items }) => {
    const sorted = [...items].sort((a, b) => {
      const w = sourceWeight(b.source) - sourceWeight(a.source);
      if (w !== 0) return w;
      return new Date(b.published_at || 0) - new Date(a.published_at || 0);
    });
    const representative = sorted[0];
    const sortTime = items.reduce((max, it) => {
      const t = it.published_at ? new Date(it.published_at).getTime() : 0;
      return Math.max(max, t);
    }, 0);
    const relatedSources = [...new Set(items.map((it) => it.source).filter(Boolean))].filter(
      (s) => s !== representative.source
    );

    // 요약이 제목을 그대로 반복하는 경우(구글 뉴스 등)는 의미가 없어 제외하고,
    // 그룹 안에서 가중치 순으로 실제 요약 문장이 있는 첫 항목을 사용
    const summary =
      sorted.map((it) => it.description).find((d) => d && !isRedundantSummary(d, representative.cleanTitle)) || "";

    return {
      representative,
      relatedCount: items.length,
      relatedSources,
      sortTime,
      summary,
    };
  });
}

// Top5처럼 요약이 꼭 필요한 소수 기사에 한해, 원문 페이지의 og:description(또는 description 메타태그)을 가져온다.
// 느리거나 차단된 사이트 때문에 전체 페이지가 지연되지 않도록 타임아웃을 둠.
async function fetchOgDescription(link, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(link, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match =
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);
    if (!match) return null;
    return cleanDescription(decode(match[1]));
  } catch (err) {
    console.error(`og:description 가져오기 실패 [${link}]: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Top5 그룹 중 요약이 없는 것만 원문에서 보완
async function fillMissingSummaries(topGroups) {
  await Promise.all(
    topGroups.map(async (group) => {
      if (group.summary) return;
      const fetched = await fetchOgDescription(group.representative.link);
      if (fetched && !isRedundantSummary(fetched, group.representative.cleanTitle)) {
        group.summary = fetched;
      }
    })
  );
}

function scoreGroup(group) {
  const base = sourceWeight(group.representative.source);
  const dupBonus = Math.min(group.relatedCount - 1, 5) * 2;
  const hoursAgo = group.sortTime ? (Date.now() - group.sortTime) / 3600000 : 999;
  const recencyBonus = hoursAgo < 6 ? 3 : hoursAgo < 24 ? 1 : 0;
  return base + dupBonus + recencyBonus;
}

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// javascript: 등 위험한 스킴 방지, http(s)만 실제 링크로 렌더링
function safeHref(link) {
  return /^https?:\/\//i.test(link) ? escapeHtml(link) : null;
}

function relativeTime(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  return `${day}일 전`;
}

function renderCard(group, { showSummary = false } = {}) {
  const item = group.representative;
  const href = safeHref(item.link);
  const title = escapeHtml(item.cleanTitle);
  const titleHtml = href
    ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : title;
  const relatedBadge =
    group.relatedCount > 1
      ? `<span class="related" title="${escapeHtml(group.relatedSources.join(", "))}">관련기사 ${group.relatedCount}건</span>`
      : "";
  const summaryHtml =
    showSummary && group.summary ? `<div class="summary">${escapeHtml(group.summary)}</div>` : "";

  return `
        <li class="card">
          <div class="meta">
            <span class="source">${escapeHtml(item.source || "출처 미상")}</span>
            <span class="keyword">${escapeHtml(item.keyword || "")}</span>
            ${relatedBadge}
            <span class="time">${escapeHtml(relativeTime(item.published_at || item.collected_at))}</span>
          </div>
          <div class="title">${titleHtml}</div>
          ${summaryHtml}
        </li>`;
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  // UTC로 취급해서 계산해도 날짜 자체(y-m-d)는 KST 캘린더 날짜 그대로라 무방
  const weekday = WEEKDAY_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 (${weekday})`;
}

function formatDateRangeLabel(oldestDateUsed, dateStr) {
  if (oldestDateUsed === dateStr) return formatDateLabel(dateStr);
  const [, om, od] = oldestDateUsed.split("-").map(Number);
  const [, dm] = dateStr.split("-").map(Number);
  const startLabel = om === dm ? `${od}일` : `${om}월 ${od}일`;
  return `${startLabel} ~ ${formatDateLabel(dateStr)}`;
}

async function renderNewsPage(news, dateStr, todayStr, oldestDateUsed) {
  const groups = groupSimilarNews(news).sort((a, b) => b.sortTime - a.sortTime);
  const rankedByScore = [...groups].sort((a, b) => scoreGroup(b) - scoreGroup(a));
  const topGroups = rankedByScore.slice(0, 5);
  const nextGroups = rankedByScore.slice(5, 10);

  await fillMissingSummaries(topGroups);

  const topRows = topGroups.map((g) => renderCard(g, { showSummary: true })).join("\n");
  const nextRows = nextGroups.map((g) => renderCard(g)).join("\n");

  // Top 10에 이미 나온 기사는 전체 뉴스에서 중복 노출하지 않음
  const shownLinks = new Set(
    [...topGroups, ...nextGroups].map((g) => g.representative.link)
  );
  const restGroups = groups.filter((g) => !shownLinks.has(g.representative.link));
  const rows = restGroups.map((g) => renderCard(g)).join("\n");

  const prevDate = shiftDateStr(dateStr, -1);
  const nextDate = shiftDateStr(dateStr, 1);
  const isToday = dateStr === todayStr;
  const nextLinkHtml = isToday
    ? `<span class="nav-btn disabled">다음 날 ▶</span>`
    : `<a class="nav-btn" href="/?date=${nextDate}">다음 날 ▶</a>`;
  const todayLinkHtml = isToday
    ? ""
    : `<a class="nav-btn today" href="/">오늘로</a>`;
  const expandedNoteHtml =
    oldestDateUsed !== dateStr
      ? `<div class="expanded-note">해당 날짜 기사가 적어 이전 날짜까지 포함했어요</div>`
      : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>반도체 뉴스</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", sans-serif;
    background: #f6f7f9;
    color: #1a1a1a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #14161a; color: #e8e8e8; }
    .card { background: #1e2126 !important; border-color: #2b2f36 !important; }
    .source { background: #2a3a52 !important; color: #9cc4f5 !important; }
    .keyword { color: #8a8f98 !important; }
    .time { color: #6b7078 !important; }
    a { color: #7db4f7 !important; }
    header { border-color: #2b2f36 !important; }
  }
  header {
    padding: 24px 20px 16px;
    max-width: 760px;
    margin: 0 auto;
    border-bottom: 1px solid #e5e7eb;
  }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  .sub { font-size: 0.85rem; color: #6b7280; }
  main { max-width: 760px; margin: 0 auto; padding: 16px 20px 60px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    padding: 14px 16px;
  }
  .meta { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; font-size: 0.78rem; flex-wrap: wrap; }
  .source { background: #eef2ff; color: #3b5bdb; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .keyword { color: #6b7280; }
  .related { color: #b45309; }
  .time { color: #9ca3af; margin-left: auto; }
  .title { font-size: 0.98rem; line-height: 1.4; }
  .summary { font-size: 0.85rem; color: #6b7280; line-height: 1.4; margin-top: 6px; }
  a { color: #2952cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { text-align: center; color: #6b7280; padding: 60px 20px; }
  .section-title { font-size: 0.95rem; font-weight: 700; margin: 24px 0 10px; }
  .section-title:first-child { margin-top: 0; }
  .date-nav { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .date-label { font-weight: 600; font-size: 0.95rem; margin-right: auto; }
  .nav-btn {
    font-size: 0.82rem;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid #e5e7eb;
    color: #374151;
    text-decoration: none;
  }
  .nav-btn:hover { background: #f3f4f6; text-decoration: none; }
  .nav-btn.disabled { color: #c7cbd1; pointer-events: none; }
  .nav-btn.today { border-color: #3b5bdb; color: #3b5bdb; }
  .expanded-note { font-size: 0.78rem; color: #9ca3af; margin-top: 4px; }
  .date-picker {
    font: inherit;
    font-size: 0.82rem;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid #e5e7eb;
    color: #374151;
    background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    .related { color: #d9a441 !important; }
    .summary { color: #9aa0a8 !important; }
    .nav-btn { border-color: #2b2f36 !important; color: #c7ccd4 !important; }
    .nav-btn:hover { background: #23262c !important; }
    .nav-btn.disabled { color: #4a4f57 !important; }
    .nav-btn.today { border-color: #7db4f7 !important; color: #7db4f7 !important; }
    .expanded-note { color: #6b7078 !important; }
    .date-picker { background: #1e2126 !important; border-color: #2b2f36 !important; color: #c7ccd4 !important; }
  }
</style>
</head>
<body>
  <header>
    <h1>반도체 뉴스</h1>
    <div class="sub">${news.length}건 (${groups.length}개 이슈) · 1시간마다 자동 수집</div>
    <div class="date-nav">
      <span class="date-label">${formatDateRangeLabel(oldestDateUsed, dateStr)}</span>
      <a class="nav-btn" href="/?date=${prevDate}">◀ 이전 날</a>
      ${nextLinkHtml}
      ${todayLinkHtml}
      <input
        type="date"
        class="date-picker"
        value="${escapeHtml(dateStr)}"
        max="${escapeHtml(todayStr)}"
        onchange="if(this.value)location.href='/?date='+this.value"
        aria-label="날짜 선택"
      />
    </div>
    ${expandedNoteHtml}
  </header>
  <main>
    ${
      topGroups.length
        ? `<div class="section-title">오늘의 Top ${topGroups.length}</div><ul>${topRows}</ul>`
        : ""
    }
    ${
      nextGroups.length
        ? `<div class="section-title">Top 6~${5 + nextGroups.length}</div><ul>${nextRows}</ul>`
        : ""
    }
    ${
      groups.length === 0
        ? `<div class="empty">아직 수집된 기사가 없어요.</div>`
        : restGroups.length
        ? `<div class="section-title">전체 뉴스</div><ul>${rows}</ul>`
        : ""
    }
  </main>
</body>
</html>`;
}

// 페이지 응답 캐싱.
// 저장된 뉴스는 1시간에 한 번만 바뀌는데 방문할 때마다 Supabase를 조회하고 200건을
// 다시 그룹핑하는 건 낭비다. Cloudflare 캐시는 무료 플랜에서도 쓸 수 있고,
// 이게 CPU 10ms 한도에 걸릴 확률을 실질적으로 가장 크게 낮춰준다.
const PAGE_CACHE_SECONDS_TODAY = 300; // 5분 - 수집 주기가 1시간이라 이 정도면 충분히 최신
const PAGE_CACHE_SECONDS_PAST = 3600; // 지난 날짜는 거의 안 바뀐다

// 수집 직후엔 오늘 페이지 캐시를 버려서 새 기사가 바로 보이게 한다
async function purgeTodayPageCache(url, todayStr) {
  const cache = caches.default;
  const origin = `${url.protocol}//${url.host}`;
  await Promise.all([
    cache.delete(new Request(`${origin}/`)),
    cache.delete(new Request(`${origin}/?date=${todayStr}`)),
  ]);
}

// /collect, /backfill 은 DB에 쓰는 엔드포인트라 주소를 아는 사람이면 누구나 호출할 수 있다.
// COLLECT_TOKEN 시크릿을 등록해 두면 ?token= 이 맞을 때만 동작한다 (등록 안 하면 그대로 공개)
function checkWriteToken(env, url) {
  if (!env.COLLECT_TOKEN) return null;
  if (url.searchParams.get("token") === env.COLLECT_TOKEN) return null;
  return new Response(JSON.stringify({ ok: false, error: "토큰이 필요합니다 (?token=...)" }, null, 2), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  // 크론 트리거
  //   "0 * * * *"  - 1시간마다 평소 수집
  //   "30 21 * * *" - KST 06:30, 어제 하루치를 구글 날짜검색으로 다시 훑어서 구멍 메우기
  // 백필을 별도 크론으로 뺀 이유: 서브리퀘스트(50)와 CPU(10ms) 한도가 호출 1건 단위라
  // 같은 실행에 몰아넣으면 한도에 닿는다. 트리거를 나누면 각자 예산을 따로 쓴다.
  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_BACKFILL_CRON) {
      ctx.waitUntil(
        (async () => {
          const yesterday = shiftDateStr(kstDateString(), -1);
          const { items, stats } = await backfillNews(env, yesterday, yesterday);
          const result = await saveToSupabase(env, items);
          const failed = stats.filter((st) => st.status !== "ok");
          console.log(
            `어제(${yesterday}) 백필: 후보 ${items.length}건 저장 ${result.inserted}건` +
              (failed.length ? ` · 실패 ${failed.length}건 (구글 차단 가능성)` : "")
          );
        })()
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        const { items, summary, stats } = await fetchAllNews(env);
        await saveToSupabase(env, items);
        const failed = stats.filter((st) => st.status !== "ok" && !st.status.startsWith("건너뜀"));
        console.log(
          `수집 완료: 후보 ${items.length}건 (네이버 ${summary.naver} / 언론사RSS ${summary.press} / 구글 ${summary.google})` +
            (failed.length ? ` · 실패 ${failed.length}건: ${failed.map((f) => `${f.source}=${f.status}`).join(", ")}` : "")
        );
      })()
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 수동 수집 트리거 (테스트/디버깅용): /collect 로 접속
    // /collect?deep=1 은 네이버 API만 검색어당 400건까지 거슬러 올라가 과거 날짜를 메운다.
    // (서브리퀘스트 한도 때문에 deep일 때는 RSS/구글을 같이 돌리지 않음. 여러 번 눌러도 안전)
    if (url.pathname === "/collect") {
      const denied = checkWriteToken(env, url);
      if (denied) return denied;
      try {
        const deep = url.searchParams.get("deep") === "1";
        const { items, stats, summary } = await fetchAllNews(
          env,
          deep ? { naverOnly: true, pages: 4 } : {}
        );
        const result = await saveToSupabase(env, items);
        ctx.waitUntil(purgeTodayPageCache(url, kstDateString()));
        return new Response(
          JSON.stringify(
            {
              ok: true,
              deep,
              candidates: items.length,
              ...result,
              summary,
              // 어느 소스가 살아있고 몇 건 가져왔는지 한눈에 보려고 같이 내려줌
              sources: stats.sort((a, b) => b.count - a.count),
            },
            null,
            2
          ),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 지난 날짜 메우기: /backfill?date=2026-09-17 또는 /backfill?from=2026-09-16&to=2026-09-17
    // 구글 뉴스의 날짜 검색으로 그 날짜 기사를 다시 받아온다. 여러 번 눌러도 중복은 걸러짐.
    if (url.pathname === "/backfill") {
      const denied = checkWriteToken(env, url);
      if (denied) return denied;
      try {
        const todayStr = kstDateString();
        const single = url.searchParams.get("date");
        let toStr = single || url.searchParams.get("to") || shiftDateStr(todayStr, -1);
        let fromStr = single || url.searchParams.get("from") || toStr;
        if (!isValidDateStr(fromStr) || !isValidDateStr(toStr)) {
          throw new Error("날짜 형식은 YYYY-MM-DD 여야 합니다 (예: /backfill?from=2026-09-16&to=2026-09-17)");
        }
        if (fromStr > toStr) [fromStr, toStr] = [toStr, fromStr];

        const { items, stats, dates } = await backfillNews(env, fromStr, toStr);
        const result = await saveToSupabase(env, items);
        ctx.waitUntil(purgeTodayPageCache(url, todayStr));
        const collected = stats.reduce((sum, st) => sum + st.count, 0);
        return new Response(
          JSON.stringify(
            {
              ok: true,
              범위: `${fromStr} ~ ${toStr}`,
              실제조회날짜: dates,
              candidates: items.length,
              ...result,
              // 구글이 막혀 있으면 여기가 전부 HTTP 503으로 찍힌다
              구글수집: collected,
              sources: stats.sort((a, b) => b.count - a.count),
            },
            null,
            2
          ),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }, null, 2), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 기본 화면: 날짜별로 저장된 뉴스 목록 보기 (기본값: 오늘, KST 기준)
    try {
      const todayStr = kstDateString();
      const requested = url.searchParams.get("date");
      const dateStr = requested && isValidDateStr(requested) ? requested : todayStr;

      const cache = caches.default;
      const cacheKey = new Request(url.toString());
      if (request.method === "GET") {
        const hit = await cache.match(cacheKey);
        if (hit) return hit;
      }

      const { news, oldestDateUsed } =
        dateStr === todayStr
          ? await fetchNewsWithMinimum(env, dateStr)
          : { news: await fetchNewsForDate(env, dateStr), oldestDateUsed: dateStr };

      const maxAge = dateStr === todayStr ? PAGE_CACHE_SECONDS_TODAY : PAGE_CACHE_SECONDS_PAST;
      const response = new Response(await renderNewsPage(news, dateStr, todayStr, oldestDateUsed), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": `public, max-age=${maxAge}`,
        },
      });
      if (request.method === "GET") {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    } catch (err) {
      return new Response(`<pre>${escapeHtml(err.message)}</pre>`, {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  },
};
