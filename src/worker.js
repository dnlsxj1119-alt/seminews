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

// 반도체 전용 검색 RSS가 없는 언론사는 전체 기사 피드를 받아서 키워드로 걸러낸다.
const PRESS_FEEDS = [
  { source: "전자신문", url: "https://rss.etnews.com/Section901.xml" },
  { source: "한국경제 IT", url: "https://www.hankyung.com/feed/it" },
  { source: "ZDNet Korea", url: "https://zdnet.co.kr/feed/" },
];

const FILTER_KEYWORDS = [
  "반도체",
  "파운드리",
  "HBM",
  "고대역폭메모리",
  "EUV",
  "노광",
  "삼성전자",
  "SK하이닉스",
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

function buildGoogleRssUrl(keyword) {
  const q = encodeURIComponent(keyword);
  // hl/gl/ceid = 한국어, 한국 지역 설정
  return `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function safeIsoDate(raw) {
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function matchFilterKeyword(text) {
  return FILTER_KEYWORDS.find((kw) => text.includes(kw)) || null;
}

// RSS(XML)는 언론사마다 구조가 대체로 비슷해서 정규식으로 안전하게 파싱 가능
function parseItemBlocks(xml) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1); // 첫 조각은 head라 버림

  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/);

    if (!titleMatch || !linkMatch) continue;

    items.push({
      title: decode(titleMatch[1]),
      link: decode(linkMatch[1]),
      description: descMatch ? decode(descMatch[1]) : "",
      source: sourceMatch ? decode(sourceMatch[1]) : null,
      published_at: pubDateMatch ? safeIsoDate(pubDateMatch[1]) : null,
    });
  }

  return items;
}

// 구글 뉴스: 검색어별로 호출, 실패해도 다른 검색어/소스에 영향 없게 개별 처리
async function fetchGoogleNews() {
  const results = await Promise.all(
    KEYWORDS.map(async (keyword) => {
      try {
        const res = await fetch(buildGoogleRssUrl(keyword), {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!res.ok) {
          console.error(`구글 뉴스 RSS 실패 "${keyword}": ${res.status}`);
          return [];
        }
        const xml = await res.text();
        return parseItemBlocks(xml).map((item) => ({
          title: item.title,
          link: item.link,
          source: item.source || "Google News",
          keyword,
          published_at: item.published_at,
        }));
      } catch (err) {
        console.error(`구글 뉴스 RSS 에러 "${keyword}": ${err.message}`);
        return [];
      }
    })
  );
  return results.flat();
}

// 언론사 자체 RSS: 전체 기사 피드를 받아서 반도체 관련 키워드가 있는 기사만 통과
async function fetchPressNews() {
  const results = await Promise.all(
    PRESS_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!res.ok) {
          console.error(`언론사 RSS 실패 [${feed.source}]: ${res.status}`);
          return [];
        }
        const xml = await res.text();
        const items = parseItemBlocks(xml);

        const matched = [];
        for (const item of items) {
          const keyword = matchFilterKeyword(`${item.title} ${item.description}`);
          if (!keyword) continue;
          matched.push({
            title: item.title,
            link: item.link,
            source: feed.source,
            keyword,
            published_at: item.published_at,
          });
        }
        return matched;
      } catch (err) {
        console.error(`언론사 RSS 에러 [${feed.source}]: ${err.message}`);
        return [];
      }
    })
  );
  return results.flat();
}

async function fetchAllNews() {
  const [googleItems, pressItems] = await Promise.all([
    fetchGoogleNews(),
    fetchPressNews(),
  ]);

  // 여러 소스에서 겹치는 기사(같은 link)는 여기서 1차로 중복 제거
  const seen = new Set();
  const merged = [];
  for (const item of [...googleItems, ...pressItems]) {
    if (seen.has(item.link)) continue;
    seen.add(item.link);
    merged.push(item);
  }
  return merged;
}

async function saveToSupabase(env, items) {
  if (items.length === 0) return { inserted: 0 };

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/semiconductor_news?on_conflict=link`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        // link가 unique 컬럼이라, 이미 있는 기사는 에러 없이 조용히 무시됨
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(items),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} ${text}`);
  }

  return { inserted: items.length };
}

async function fetchLatestNews(env, limit = 200) {
  const params = new URLSearchParams({
    select: "title,link,source,keyword,published_at,collected_at",
    order: "published_at.desc.nullslast",
    limit: String(limit),
  });
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

// 주요 매체 가중치 (Top 스코어링용). 목록에 없으면 기본값 1.5,
// 포털 미러(v.daum.net, 네이트 등 원 언론사가 아닌 배포 경로)는 0.5로 낮게.
const SOURCE_WEIGHT = {
  "연합뉴스": 5,
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

// 같은 기사를 여러 매체가 받아쓴 경우 하나로 묶는다.
// 대표 기사는 매체 가중치가 높은 쪽을 우선 선택.
function groupSimilarNews(news) {
  const groups = [];
  const keyToIndex = new Map();

  for (const raw of news) {
    const cleanTitle = splitTitleSource(raw.title);
    const norm = normalizeForDedup(cleanTitle);
    const key = norm.length >= 10 ? norm.slice(0, 18) : norm;

    const entry = { ...raw, cleanTitle };
    if (keyToIndex.has(key)) {
      groups[keyToIndex.get(key)].push(entry);
    } else {
      keyToIndex.set(key, groups.length);
      groups.push([entry]);
    }
  }

  return groups.map((items) => {
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

    return {
      representative,
      relatedCount: items.length,
      relatedSources,
      sortTime,
    };
  });
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

function renderCard(group) {
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

  return `
        <li class="card">
          <div class="meta">
            <span class="source">${escapeHtml(item.source || "출처 미상")}</span>
            <span class="keyword">${escapeHtml(item.keyword || "")}</span>
            ${relatedBadge}
            <span class="time">${escapeHtml(relativeTime(item.published_at || item.collected_at))}</span>
          </div>
          <div class="title">${titleHtml}</div>
        </li>`;
}

function renderNewsPage(news) {
  const groups = groupSimilarNews(news).sort((a, b) => b.sortTime - a.sortTime);
  const topGroups = [...groups].sort((a, b) => scoreGroup(b) - scoreGroup(a)).slice(0, 5);

  const topRows = topGroups.map(renderCard).join("\n");
  const rows = groups.map(renderCard).join("\n");

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
  a { color: #2952cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { text-align: center; color: #6b7280; padding: 60px 20px; }
  .section-title { font-size: 0.95rem; font-weight: 700; margin: 24px 0 10px; }
  .section-title:first-child { margin-top: 0; }
  @media (prefers-color-scheme: dark) { .related { color: #d9a441 !important; } }
</style>
</head>
<body>
  <header>
    <h1>반도체 뉴스</h1>
    <div class="sub">최신 ${news.length}건 (${groups.length}개 이슈) · 매일 오전 8시 자동 수집</div>
  </header>
  <main>
    ${
      topGroups.length
        ? `<div class="section-title">오늘의 Top ${topGroups.length}</div><ul>${topRows}</ul>`
        : ""
    }
    ${
      groups.length
        ? `<div class="section-title">전체 뉴스</div><ul>${rows}</ul>`
        : `<div class="empty">아직 수집된 기사가 없어요.</div>`
    }
  </main>
</body>
</html>`;
}

export default {
  // 크론 트리거로 매일 자동 실행되는 부분
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const items = await fetchAllNews();
        const result = await saveToSupabase(env, items);
        console.log(`수집 완료: 후보 ${items.length}건 (신규만 저장됨)`);
      })()
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 수동 수집 트리거 (테스트/디버깅용): /collect 로 접속
    if (url.pathname === "/collect") {
      try {
        const items = await fetchAllNews();
        const result = await saveToSupabase(env, items);
        return new Response(
          JSON.stringify({ ok: true, candidates: items.length, ...result }, null, 2),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 기본 화면: 저장된 뉴스 목록 보기
    try {
      const news = await fetchLatestNews(env);
      return new Response(renderNewsPage(news), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch (err) {
      return new Response(`<pre>${escapeHtml(err.message)}</pre>`, {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  },
};
