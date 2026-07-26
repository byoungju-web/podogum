/**
 * podogum Fusion Search Worker
 * © 2026 BJ LEE
 *
 * 10개 소스를 병렬로 호출하고 RRF(Reciprocal Rank Fusion)로 융합합니다.
 *
 * Cloudflare 환경변수
 *   BRAVE_API_KEY  (Secret, 선택)  없으면 Brave만 건너뜁니다
 *   SEARXNG_URL    (Plain,  선택)  예: https://searx.example.org
 *                  JSON 출력이 켜진 인스턴스여야 합니다
 */

const ALLOWED_ORIGINS = [
  'https://podolang.kr',
  'https://www.podolang.kr',
  'https://byoungju-web.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

const CACHE_TTL = 1800;        // 30분
const SOURCE_TIMEOUT = 6000;   // 소스별 6초
const UA = 'podogum/2.0 (+https://podolang.kr)';
const RRF_K = 60;              // 표준값

/* =======================================================
   공통
   ======================================================= */

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Brave-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status, origin) {
  const headers = corsHeaders(origin);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(data), { status: status, headers: headers });
}

function strip(text, limit) {
  if (!text) return '';
  let s = String(text).replace(/<[^>]*>/g, '');
  s = s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

async function grab(url, options) {
  const opts = options || {};
  const res = await fetch(url, {
    headers: Object.assign({ 'User-Agent': UA, 'Accept': 'application/json' }, opts.headers || {}),
    signal: AbortSignal.timeout(SOURCE_TIMEOUT)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return opts.text ? await res.text() : await res.json();
}

/* =======================================================
   소스별 어댑터
   각 어댑터는 [{title, url, snippet, extra}] 를 반환합니다
   ======================================================= */

async function fromBrave(q, env, opts) {
  // 우선순위: 브라우저에서 보낸 키 > Worker Secret
  const key = (opts && opts.braveKey) || env.BRAVE_API_KEY;
  if (!key) throw new Error('Brave 키 없음');
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', q);
  u.searchParams.set('count', '10');
  u.searchParams.set('country', 'KR');
  u.searchParams.set('search_lang', 'ko');
  u.searchParams.set('safesearch', 'moderate');
  const data = await grab(u.toString(), {
    headers: { 'X-Subscription-Token': key, 'Accept-Encoding': 'gzip' }
  });
  return ((data.web || {}).results || []).map(function (x) {
    return { title: strip(x.title, 130), url: x.url, snippet: strip(x.description, 200) };
  });
}

async function fromSearxng(q, env) {
  if (!env.SEARXNG_URL) throw new Error('인스턴스 주소 없음');
  const base = String(env.SEARXNG_URL).replace(/\/+$/, '');
  const u = new URL(base + '/search');
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'json');
  u.searchParams.set('language', 'ko');
  const data = await grab(u.toString());
  return (data.results || []).slice(0, 12).map(function (x) {
    return { title: strip(x.title, 130), url: x.url, snippet: strip(x.content, 200) };
  });
}

async function fromDuckDuckGo(q) {
  const u = new URL('https://api.duckduckgo.com/');
  u.searchParams.set('q', q);
  u.searchParams.set('format', 'json');
  u.searchParams.set('no_html', '1');
  u.searchParams.set('skip_disambig', '1');
  const data = await grab(u.toString());
  const out = [];
  if (data.AbstractURL) {
    out.push({
      title: strip(data.Heading || q, 130),
      url: data.AbstractURL,
      snippet: strip(data.AbstractText, 200)
    });
  }
  (data.RelatedTopics || []).forEach(function (t) {
    if (t.FirstURL && t.Text) {
      out.push({ title: strip(t.Text.split(' - ')[0], 130), url: t.FirstURL, snippet: strip(t.Text, 200) });
    } else if (t.Topics) {
      t.Topics.slice(0, 3).forEach(function (s) {
        if (s.FirstURL && s.Text) {
          out.push({ title: strip(s.Text.split(' - ')[0], 130), url: s.FirstURL, snippet: strip(s.Text, 200) });
        }
      });
    }
  });
  if (!out.length) throw new Error('즉답 없음');
  return out.slice(0, 8);
}

async function wikiLang(q, lang) {
  const u = new URL('https://' + lang + '.wikipedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('list', 'search');
  u.searchParams.set('srsearch', q);
  u.searchParams.set('srlimit', '5');
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');
  const data = await grab(u.toString());
  return (((data.query || {}).search) || []).map(function (x) {
    return {
      title: strip(x.title, 130),
      url: 'https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(x.title.replace(/ /g, '_')),
      snippet: strip(x.snippet, 200)
    };
  });
}

async function fromWikipedia(q) {
  const both = await Promise.allSettled([wikiLang(q, 'ko'), wikiLang(q, 'en')]);
  let out = [];
  both.forEach(function (r) { if (r.status === 'fulfilled') out = out.concat(r.value); });
  if (!out.length) throw new Error('결과 없음');
  return out;
}

async function fromHackerNews(q) {
  const u = new URL('https://hn.algolia.com/api/v1/search');
  u.searchParams.set('query', q);
  u.searchParams.set('hitsPerPage', '6');
  const data = await grab(u.toString());
  return (data.hits || []).map(function (x) {
    return {
      title: strip(x.title || x.story_title, 130),
      url: x.url || ('https://news.ycombinator.com/item?id=' + x.objectID),
      snippet: strip(x.story_text || x.comment_text || '', 200),
      extra: (x.points || 0) + 'pt · 댓글 ' + (x.num_comments || 0)
    };
  }).filter(function (x) { return x.title; });
}

async function fromStackOverflow(q) {
  const u = new URL('https://api.stackexchange.com/2.3/search/advanced');
  u.searchParams.set('q', q);
  u.searchParams.set('site', 'stackoverflow');
  u.searchParams.set('order', 'desc');
  u.searchParams.set('sort', 'relevance');
  u.searchParams.set('pagesize', '6');
  const data = await grab(u.toString());
  return (data.items || []).map(function (x) {
    return {
      title: strip(x.title, 130),
      url: x.link,
      snippet: '',
      extra: '점수 ' + x.score + (x.is_answered ? ' · 해결됨' : '')
    };
  });
}

async function fromArxiv(q) {
  const u = new URL('http://export.arxiv.org/api/query');
  u.searchParams.set('search_query', 'all:' + q);
  u.searchParams.set('start', '0');
  u.searchParams.set('max_results', '6');
  const xml = await grab(u.toString(), { text: true, headers: { 'Accept': 'application/atom+xml' } });

  const out = [];
  const entries = xml.split('<entry>').slice(1);
  entries.forEach(function (chunk) {
    const t = /<title>([\s\S]*?)<\/title>/.exec(chunk);
    const link = /<id>([\s\S]*?)<\/id>/.exec(chunk);
    const sum = /<summary>([\s\S]*?)<\/summary>/.exec(chunk);
    if (t && link) {
      out.push({
        title: strip(t[1], 130),
        url: link[1].trim(),
        snippet: strip(sum ? sum[1] : '', 200)
      });
    }
  });
  if (!out.length) throw new Error('결과 없음');
  return out;
}

async function fromOpenAlex(q) {
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', q);
  u.searchParams.set('per-page', '6');
  u.searchParams.set('mailto', 'podogum@podolang.kr'); // 폴라이트 풀
  const data = await grab(u.toString());
  return (data.results || []).map(function (x) {
    return {
      title: strip(x.display_name, 130),
      url: x.doi || x.id,
      snippet: '',
      extra: (x.publication_year || '') + ' · 인용 ' + (x.cited_by_count || 0)
    };
  }).filter(function (x) { return x.title && x.url; });
}

async function fromGithub(q) {
  const u = new URL('https://api.github.com/search/repositories');
  u.searchParams.set('q', q);
  u.searchParams.set('per_page', '6');
  const data = await grab(u.toString(), { headers: { 'Accept': 'application/vnd.github+json' } });
  return (data.items || []).map(function (x) {
    return {
      title: strip(x.full_name, 130),
      url: x.html_url,
      snippet: strip(x.description, 200),
      extra: '★' + x.stargazers_count + (x.language ? ' · ' + x.language : '')
    };
  });
}

async function fromNpm(q) {
  const u = new URL('https://registry.npmjs.org/-/v1/search');
  u.searchParams.set('text', q);
  u.searchParams.set('size', '5');
  const data = await grab(u.toString());
  return (data.objects || []).map(function (o) {
    const p = o.package || {};
    return {
      title: strip(p.name, 130),
      url: (p.links && p.links.npm) || ('https://www.npmjs.com/package/' + p.name),
      snippet: strip(p.description, 200),
      extra: 'v' + (p.version || '')
    };
  }).filter(function (x) { return x.title; });
}

// id, 표시명, RRF 가중치, 어댑터
const SOURCES = [
  { id: 'brave',    label: 'Brave',          weight: 1.4, fn: fromBrave },
  { id: 'searxng',  label: 'SearXNG',        weight: 1.4, fn: fromSearxng },
  { id: 'ddg',      label: 'DuckDuckGo',     weight: 0.9, fn: fromDuckDuckGo },
  { id: 'wiki',     label: 'Wikipedia',      weight: 1.1, fn: fromWikipedia },
  { id: 'hn',       label: 'Hacker News',    weight: 0.8, fn: fromHackerNews },
  { id: 'so',       label: 'Stack Overflow', weight: 0.8, fn: fromStackOverflow },
  { id: 'arxiv',    label: 'arXiv',          weight: 0.7, fn: fromArxiv },
  { id: 'openalex', label: 'OpenAlex',       weight: 0.7, fn: fromOpenAlex },
  { id: 'github',   label: 'GitHub',         weight: 0.8, fn: fromGithub },
  { id: 'npm',      label: 'npm',            weight: 0.6, fn: fromNpm }
];

/* =======================================================
   URL 정규화 + RRF 융합
   ======================================================= */

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const drop = [];
    u.searchParams.forEach(function (v, k) {
      if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(k)) drop.push(k);
    });
    drop.forEach(function (k) { u.searchParams.delete(k); });
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch (e) {
    return String(raw || '').trim();
  }
}

/**
 * RRF: score(doc) = Σ  weight_s / (K + rank_s)
 * 여러 소스가 같은 문서를 올릴수록 점수가 합산됩니다.
 */
function fuse(perSource) {
  const docs = new Map();

  perSource.forEach(function (entry) {
    entry.items.forEach(function (item, rank) {
      if (!item.url || !item.title) return;
      const key = normalizeUrl(item.url);
      const gain = entry.weight / (RRF_K + rank);

      let doc = docs.get(key);
      if (!doc) {
        doc = {
          url: item.url,
          title: item.title,
          snippet: item.snippet || '',
          extra: item.extra || '',
          sources: [],
          score: 0,
          bestRank: rank
        };
        docs.set(key, doc);
      }
      doc.score += gain;
      if (doc.sources.indexOf(entry.id) === -1) doc.sources.push(entry.id);
      if (rank < doc.bestRank) {
        doc.bestRank = rank;
        if (item.title) doc.title = item.title;
      }
      if (!doc.snippet && item.snippet) doc.snippet = item.snippet;
      if (!doc.extra && item.extra) doc.extra = item.extra;
    });
  });

  const list = Array.from(docs.values());
  list.forEach(function (d) {
    d.score = Math.round(d.score * 100000) / 100000;
    delete d.bestRank;
  });

  list.sort(function (a, b) {
    // 여러 소스가 동시에 올린 문서를 먼저 (RRF의 핵심)
    if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
    return b.score - a.score;
  });
  return list;
}

/* =======================================================
   핸들러
   ======================================================= */

async function handleSearch(request, env, ctx, origin) {
  const src = new URL(request.url);
  const q = (src.searchParams.get('q') || '').trim();
  if (!q) return json({ error: '검색어가 비어 있습니다.' }, 400, origin);
  if (q.length > 200) return json({ error: '검색어가 너무 깁니다.' }, 400, origin);

  // 브라우저가 보낸 개인 키 (저장하지 않고 이 요청에만 씁니다)
  const opts = { braveKey: (request.headers.get('X-Brave-Key') || '').trim() };

  const only = (src.searchParams.get('only') || '').split(',').filter(Boolean);
  const active = only.length
    ? SOURCES.filter(function (s) { return only.indexOf(s.id) !== -1; })
    : SOURCES;
  if (!active.length) return json({ error: '고른 소스가 없습니다.' }, 400, origin);

  const cacheUrl = new URL(src.origin + '/cache/fusion');
  cacheUrl.searchParams.set('q', q);
  cacheUrl.searchParams.set('s', active.map(function (s) { return s.id; }).join(','));
  cacheUrl.searchParams.set('bk', (opts.braveKey || env.BRAVE_API_KEY) ? '1' : '0');
  const cache = caches.default;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.json();
    body.cache = 'HIT';
    return json(body, 200, origin);
  }

  const started = Date.now();

  // ---------- 병렬 실행 ----------
  const settled = await Promise.allSettled(active.map(function (s) {
    const t0 = Date.now();
    return s.fn(q, env, opts).then(function (items) {
      return { id: s.id, weight: s.weight, items: items || [], ms: Date.now() - t0 };
    });
  }));

  const perSource = [];
  const stats = [];

  settled.forEach(function (r, i) {
    const s = active[i];
    if (r.status === 'fulfilled') {
      perSource.push(r.value);
      stats.push({ id: s.id, label: s.label, ok: true, count: r.value.items.length, ms: r.value.ms });
    } else {
      const msg = (r.reason && r.reason.message) || '실패';
      stats.push({ id: s.id, label: s.label, ok: false, count: 0, error: msg });
    }
  });

  // ---------- 융합 ----------
  const fused = fuse(perSource);
  const overlap = fused.filter(function (d) { return d.sources.length > 1; }).length;

  const payload = {
    query: q,
    total: fused.length,
    overlap: overlap,
    results: fused.slice(0, 40),
    stats: stats,
    fusion: 'RRF k=' + RRF_K,
    elapsed: Date.now() - started,
    cache: 'MISS'
  };

  const toCache = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=' + CACHE_TTL
    }
  });
  ctx.waitUntil(cache.put(cacheKey, toCache));

  return json(payload, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({
        service: 'podogum',
        version: '2.0-fusion',
        owner: 'BJ LEE',
        sources: SOURCES.map(function (s) { return { id: s.id, label: s.label, weight: s.weight }; }),
        brave_key_server: Boolean(env.BRAVE_API_KEY),
        brave_key_header: 'X-Brave-Key (브라우저에서 보내면 그걸 우선 사용)',
        searxng: Boolean(env.SEARXNG_URL)
      }, 200, origin);
    }

    if (url.pathname === '/api/search') {
      if (request.method !== 'GET') return json({ error: 'GET만 지원합니다.' }, 405, origin);
      return handleSearch(request, env, ctx, origin);
    }

    return json({ error: '없는 경로입니다.' }, 404, origin);
  }
};
