// 반도체 뉴스 수집 -> Supabase 저장 (Cloudflare Workers Cron)
//
// 흐름:
// 1. 아래 KEYWORDS 배열의 검색어마다 구글 뉴스 RSS를 호출 (API 키 불필요)
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

function buildRssUrl(keyword) {
  const q = encodeURIComponent(keyword);
  // hl/gl/ceid = 한국어, 한국 지역 설정
  return `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
}

// 구글 뉴스 RSS는 구조가 단순해서 정규식으로 안전하게 파싱 가능
function parseRssItems(xml, keyword) {
  const items = [];
  const itemBlocks = xml.split("<item>").slice(1); // 첫 조각은 head라 버림

  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);

    if (!titleMatch || !linkMatch) continue;

    const decode = (s) =>
      s
        .replace(/<!\[CDATA\[/g, "")
        .replace(/\]\]>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

    items.push({
      title: decode(titleMatch[1]),
      link: decode(linkMatch[1]),
      source: sourceMatch ? decode(sourceMatch[1]) : null,
      keyword,
      published_at: pubDateMatch
        ? new Date(pubDateMatch[1]).toISOString()
        : null,
    });
  }

  return items;
}

async function fetchAllNews() {
  const results = await Promise.all(
    KEYWORDS.map(async (keyword) => {
      const res = await fetch(buildRssUrl(keyword), {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) {
        console.error(`RSS fetch failed for "${keyword}": ${res.status}`);
        return [];
      }
      const xml = await res.text();
      return parseRssItems(xml, keyword);
    })
  );

  // 여러 검색어에서 겹치는 기사(같은 link)는 여기서 1차로 중복 제거
  const seen = new Set();
  const merged = [];
  for (const item of results.flat()) {
    if (seen.has(item.link)) continue;
    seen.add(item.link);
    merged.push(item);
  }
  return merged;
}

async function saveToSupabase(env, items) {
  if (items.length === 0) return { inserted: 0 };

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/semiconductor_news`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      // link가 unique 컬럼이라, 이미 있는 기사는 에러 없이 조용히 무시됨
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(items),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} ${text}`);
  }

  return { inserted: items.length };
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

  // 브라우저로 직접 접속해서 수동 실행 + 결과 확인용 (테스트/디버깅 목적)
  async fetch(request, env, ctx) {
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
  },
};
