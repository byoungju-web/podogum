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
 *   OPENALEX_MAIL  (Plain,  권장)  wrangler.toml [vars] 에 넣으세요.
 *                  대시보드에 직접 넣으면 재배포 때마다 지워집니다.
 */

const ALLOWED_ORIGINS = [
  'https://podogum.kr',
  'https://www.podogum.kr',
  'https://podolang.kr',
  'https://www.podolang.kr',
  'https://byoungju-web.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

const CACHE_TTL = 1800;        // 30분
const SOURCE_TIMEOUT = 4500;   // 소스별 4.5초
const UA = 'podogum/2.0 (+https://podogum.kr)';
const RRF_K = 60;

const FREE_PER_DAY_DEFAULT   = 3;    // 방문자 1인당 하루 무료 Brave 검색
const GLOBAL_PER_DAY_DEFAULT = 300;  // 전체 하루 상한 (크레딧 보호용 안전판)              // 표준값

/* =======================================================
   공통
   ======================================================= */

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Brave-Key, X-Tavily-Key, X-Stackex-Key, X-Openalex-Mail, X-Searxng-Url, X-Notion-Token',
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

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function grab(url, options) {
  const opts = options || {};
  const tries = opts.retries === undefined ? 1 : opts.retries;
  let lastErr = null;

  for (let attempt = 0; attempt <= tries; attempt++) {
    let res;
    try {
      const init = {
        method: opts.method || 'GET',
        headers: Object.assign({ 'User-Agent': UA, 'Accept': 'application/json' }, opts.headers || {}),
        signal: AbortSignal.timeout(opts.timeout || SOURCE_TIMEOUT)
      };
      if (opts.body) {
        init.body = opts.body;
        if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
      }
      res = await fetch(url, init);
    } catch (e) {
      const timedOut = e.name === 'TimeoutError';
      lastErr = new Error(timedOut ? '시간 초과' : '연결 실패');
      // 제한시간을 넘긴 소스는 다시 물어봐도 똑같이 느립니다.
      // 재시도하면 4.5초짜리가 세 번 쌓여 전체가 15초가 됩니다. 바로 포기합니다.
      if (timedOut || attempt === tries) throw lastErr;
      await sleep(300);
      continue;
    }

    if (res.ok) return opts.text ? await res.text() : await res.json();

    // 서버가 알려준 이유를 그대로 담습니다 (추측 대신 진단)
    let why = '';
    try {
      const body = await res.text();
      const m = /"error_message"\s*:\s*"([^"]{0,120})"/.exec(body)
             || /"error"\s*:\s*"([^"]{0,120})"/.exec(body)
             || /"message"\s*:\s*"([^"]{0,120})"/.exec(body);
      why = m ? m[1] : body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      why = why.slice(0, 60);
    } catch (e) { why = ''; }

    lastErr = new Error('HTTP ' + res.status + (why ? ' · ' + why : ''));

    // 429는 재시도하지 않습니다. 할당량 창은 분·시간 단위라 기다려도 안 풀리고
    // 재시도가 응답만 느리게 만듭니다. 일시적 서버 오류만 다시 시도합니다.
    const retryable = res.status >= 500;
    if (!retryable || attempt === tries) throw lastErr;
    await sleep(600 * (attempt + 1));
  }
  throw lastErr;
}


/* =======================================================
   Brave 할당량

   Brave만 돈이 드는 소스입니다. 나머지 11개는 무료라 아무 제한이 없습니다.
   그래서 이 문을 통과하지 못하면 Brave 칸만 닫히고 검색은 계속됩니다.

   세 가지 통로가 있습니다.
     byok  자기 Brave 키를 넣은 사람      무제한, 사장님 비용 0
     pass  이용권 코드를 넣은 사람        남은 횟수만큼
     free  아무것도 안 넣은 사람          하루 몇 회

   KV(PODOGUM_KV)가 연결되어 있지 않으면 free와 pass는 열리지 않습니다.
   횟수를 셀 곳이 없는데 서버 키를 열어주면 크레딧이 그냥 새기 때문입니다.
   ======================================================= */

function today() {
  // 한국 시간 자정에 초기화되도록 9시간을 더해서 날짜를 셉니다.
  // UTC로 세면 한국에서는 아침 9시에 무료 횟수가 되살아납니다.
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function sha8(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).slice(0, 4)
    .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

async function bump(kv, key, ttl) {
  const cur = parseInt((await kv.get(key)) || '0', 10) || 0;
  await kv.put(key, String(cur + 1), { expirationTtl: ttl });
  return cur + 1;
}

async function checkQuota(env, request, opts, consume) {
  // 1. 자기 키를 가져온 사람은 셀 필요가 없습니다. 본인 계정에서 나갑니다.
  if (opts.braveKey) {
    return { ok: true, mode: 'byok', key: opts.braveKey, left: null, limit: null };
  }

  if (!env.BRAVE_API_KEY) {
    return { ok: false, mode: 'none', reason: '서버에 Brave 키가 없습니다', left: 0, limit: 0 };
  }

  const kv = env.PODOGUM_KV;
  if (!kv) {
    return { ok: false, mode: 'nokv', reason: 'Brave 키를 입력하면 검색됩니다', left: 0, limit: 0 };
  }

  const day = today();

  // 2. 전체 안전판. 이걸 넘으면 아무도 서버 키를 못 씁니다.
  const globalCap = parseInt(env.GLOBAL_PER_DAY || GLOBAL_PER_DAY_DEFAULT, 10);
  const globalUsed = parseInt((await kv.get('g:' + day)) || '0', 10) || 0;
  if (globalUsed >= globalCap) {
    return { ok: false, mode: 'globalfull', reason: '오늘 전체 무료분이 다 찼습니다', left: 0, limit: 0 };
  }

  // 3. 이용권 코드
  if (opts.passKey) {
    const raw = await kv.get('pass:' + opts.passKey);
    if (!raw) return { ok: false, mode: 'badpass', reason: '없는 이용권 코드입니다', left: 0, limit: 0 };
    let pass;
    try { pass = JSON.parse(raw); } catch (e) { pass = null; }
    if (!pass) return { ok: false, mode: 'badpass', reason: '이용권 정보가 깨졌습니다', left: 0, limit: 0 };
    if ((pass.left || 0) <= 0) {
      return { ok: false, mode: 'passempty', reason: '이용권을 다 쓰셨습니다', left: 0, limit: pass.total || 0 };
    }
    if (consume) {
      pass.left = pass.left - 1;
      pass.used_at = day;
      await kv.put('pass:' + opts.passKey, JSON.stringify(pass));
      await bump(kv, 'g:' + day, 172800);
    }
    return { ok: true, mode: 'pass', key: env.BRAVE_API_KEY,
             left: pass.left - (consume ? 0 : 1) + (consume ? 0 : 1), limit: pass.total || null };
  }

  // 4. 무료. 브라우저 ID와 IP를 각각 세고 많이 쓴 쪽을 기준으로 봅니다.
  //    ID는 지우면 초기화되고 IP는 여러 사람이 공유하니, 둘을 겹쳐서 새는 걸 줄입니다.
  const cap = parseInt(env.FREE_PER_DAY || FREE_PER_DAY_DEFAULT, 10);
  const vid = (opts.visitorId || '').slice(0, 40) || 'anon';
  const ipHash = await sha8((request.headers.get('CF-Connecting-IP') || '0') + '|' + day);

  const kId = 'f:' + day + ':v:' + vid;
  const kIp = 'f:' + day + ':i:' + ipHash;
  const usedId = parseInt((await kv.get(kId)) || '0', 10) || 0;
  const usedIp = parseInt((await kv.get(kIp)) || '0', 10) || 0;
  const used = Math.max(usedId, usedIp);

  if (used >= cap) {
    return { ok: false, mode: 'freefull', reason: '오늘 무료 ' + cap + '회를 다 쓰셨습니다', left: 0, limit: cap };
  }

  if (consume) {
    await bump(kv, kId, 172800);
    await bump(kv, kIp, 172800);
    await bump(kv, 'g:' + day, 172800);
  }

  return { ok: true, mode: 'free', key: env.BRAVE_API_KEY,
           left: cap - used - (consume ? 1 : 0), limit: cap };
}

/* 이용권 발급·조회. 사장님만 씁니다.
   폰 브라우저 주소창에 그대로 치면 됩니다.

     .../api/pass?admin=관리비밀번호&code=PODO-1234&add=1000&memo=홍길동
     .../api/pass?admin=관리비밀번호&code=PODO-1234                (잔액 확인)
*/
async function handlePass(request, env, origin) {
  const url = new URL(request.url);
  const admin = url.searchParams.get('admin') || '';
  if (!env.ADMIN_KEY || admin !== env.ADMIN_KEY) {
    return json({ error: '권한 없음' }, 403, origin);
  }
  const kv = env.PODOGUM_KV;
  if (!kv) return json({ error: 'KV가 연결되지 않았습니다' }, 500, origin);

  const code = (url.searchParams.get('code') || '').trim();
  if (!code) return json({ error: 'code 가 필요합니다' }, 400, origin);

  const add = parseInt(url.searchParams.get('add') || '0', 10) || 0;
  const raw = await kv.get('pass:' + code);
  let pass = null;
  try { pass = raw ? JSON.parse(raw) : null; } catch (e) { pass = null; }

  if (!add) {
    if (!pass) return json({ error: '없는 코드입니다', code: code }, 404, origin);
    return json({ code: code, left: pass.left, total: pass.total, memo: pass.memo || '' }, 200, origin);
  }

  if (!pass) pass = { left: 0, total: 0, memo: '', created: today() };
  pass.left  = (pass.left || 0) + add;
  pass.total = (pass.total || 0) + add;
  const memo = url.searchParams.get('memo');
  if (memo) pass.memo = memo.slice(0, 60);
  await kv.put('pass:' + code, JSON.stringify(pass));

  return json({ ok: true, code: code, added: add, left: pass.left, total: pass.total, memo: pass.memo }, 200, origin);
}

/* =======================================================
   소스별 어댑터
   각 어댑터는 [{title, url, snippet, extra}] 를 반환합니다
   ======================================================= */

async function fromBrave(q, env, opts) {
  // 할당량 문을 통과할 때 정해진 키만 씁니다 (checkQuota가 넣어줍니다)
  const key = opts && opts.allowedBraveKey;
  if (!key) throw new Error((opts && opts.braveReason) || 'Brave 키 없음');
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


/* -------- Tavily --------
   Brave와 같은 종합 웹 검색입니다. 둘 다 붙여두면 서로 겹치는 문서가 생기고,
   그래야 일반 질문에서도 RRF 융합이 실제로 작동합니다.
   지금까지 종합 웹 엔진이 Brave 하나뿐이라 비어 있던 자리입니다. */
async function fromTavily(q, env, opts) {
  const key = opts && opts.allowedTavilyKey;
  if (!key) throw new Error((opts && opts.tavilyReason) || 'Tavily 키 없음');
  const data = await grab('https://api.tavily.com/search', {
    method: 'POST',
    retries: 0,
    headers: { 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      query: q,
      max_results: 8,
      search_depth: 'basic',      // 1크레딧. advanced 는 2크레딧입니다.
      include_answer: false
    })
  });
  return (data.results || []).map(function (x) {
    return { title: strip(x.title, 130), url: x.url, snippet: strip(x.content, 200) };
  }).filter(function (x) { return x.title && x.url; });
}


/* -------- 내 노션 --------
   웹이 아니라 내 것을 뒤집니다. "이거 우리가 전에 검토했었나" 에는
   구글도 네이버도 답할 수 없고, 내 노션에만 답이 있습니다.

   토큰은 브라우저에만 저장되고 서버에 남기지 않습니다. 다만 노션 API는
   브라우저에서 직접 부를 수 없어서 요청이 이 Worker를 거쳐 갑니다.
   그래서 안내문에서 읽기 전용, 필요한 페이지만 연결하도록 권합니다. */

function notionTitle(item) {
  // 데이터베이스는 맨 위에 title 배열이 있습니다
  if (Array.isArray(item.title) && item.title.length) {
    return item.title.map(function (t) { return t.plain_text || ''; }).join('');
  }
  // 페이지는 속성 중 type 이 title 인 것을 찾아야 합니다
  const props = item.properties || {};
  for (const k in props) {
    const p = props[k];
    if (p && p.type === 'title' && Array.isArray(p.title) && p.title.length) {
      return p.title.map(function (t) { return t.plain_text || ''; }).join('');
    }
  }
  return '';
}

async function fromNotion(q, env, opts) {
  const token = opts && opts.notionToken;
  if (!token) throw new Error('노션 토큰 없음');

  const data = await grab('https://api.notion.com/v1/search', {
    method: 'POST',
    retries: 0,
    timeout: 4000,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({ query: q, page_size: 8 })
  });

  const out = (data.results || []).map(function (item) {
    const title = strip(notionTitle(item), 130);
    if (!title || !item.url) return null;
    const when = (item.last_edited_time || '').slice(0, 10);
    return {
      title: title,
      url: item.url,
      snippet: '',
      extra: (item.object === 'database' ? '노션 데이터베이스' : '노션 페이지')
             + (when ? ' · 수정 ' + when : '')
    };
  }).filter(Boolean);

  if (!out.length) throw new Error('결과 없음');
  return out;
}



async function fromSearxng(q, env, opts) {
  const raw = (opts && opts.searxngUrl) || env.SEARXNG_URL;
  if (!raw) throw new Error('인스턴스 주소 없음');
  const base = String(raw).replace(/\/+$/, '');
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
  u.searchParams.set('srlimit', '3');
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

/* 위키백과 검색은 질문에서 흔한 낱말 하나만 걸려도 문서를 돌려줍니다.
   "트럼프의 미래" 에 "문재인 정부" 가 나오는 식입니다.
   그래서 각 언어의 1순위는 그대로 두고, 2순위부터는
   제목과 검색어가 실제로 겹치는지 확인합니다. */
function shareWord(title, q) {
  const qs = q.toLowerCase();
  const ts = title.toLowerCase();
  if (qs.indexOf(ts) !== -1) return true;
  const words = ts.split(/[\s·,()\[\]:–—-]+/).filter(function (w) { return w.length >= 2; });
  for (let i = 0; i < words.length; i++) {
    if (qs.indexOf(words[i]) !== -1) return true;
  }
  return false;
}

async function fromWikipedia(q) {
  const both = await Promise.allSettled([wikiLang(q, 'ko'), wikiLang(q, 'en')]);
  let out = [];
  both.forEach(function (r) {
    if (r.status !== 'fulfilled') return;
    r.value.forEach(function (item, i) {
      if (i === 0 || shareWord(item.title, q)) out.push(item);
    });
  });
  if (!out.length) throw new Error('결과 없음');
  return out;
}

/* 개발·학술 소스는 영문 기술 용어를 다루는 색인입니다.
   "부산 가볼만한곳" 에 맞을 수 있는 문서가 애초에 없는데도 각각 1초씩 쓰고
   0건을 냅니다. 한글만으로 된 질문이면 아예 부르지 않습니다.
   영문이 섞여 있으면(예: "부산 airbnb") 그대로 켭니다. */
function looksTechnical(q) {
  const latin = (q.match(/[A-Za-z]/g) || []).length;
  if (latin >= 3) return true;                 // 영문 낱말이 있으면 통과
  return /[0-9]{2,}|[<>{}/\\#@$]|에러|오류|버그|코드|함수|라이브러리|프레임워크|알고리즘|논문|깃허브/.test(q);
}

async function fromHackerNews(q) {
  if (!looksTechnical(q)) throw new Error('개발 질문 아님');
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

function shapeSo(data) {
  return (data.items || []).map(function (x) {
    return {
      title: strip(x.title, 130),
      url: x.link,
      snippet: '',
      extra: '점수 ' + x.score + (x.is_answered ? ' · 해결됨' : '')
    };
  });
}

async function fromStackOverflow(q, env, opts) {
  if (!looksTechnical(q)) throw new Error('개발 질문 아님');
  const u = new URL('https://api.stackexchange.com/2.3/search/advanced');
  u.searchParams.set('q', q);
  u.searchParams.set('site', 'stackoverflow');
  u.searchParams.set('pagesize', '6');
  // 키가 없으면 Cloudflare 공용 IP의 하루 할당량을 남들과 나눠 쓰게 되어 거의 항상 막힙니다.
  // stackapps.com 에서 무료로 받은 키를 STACKEX_KEY에 넣으면 앱 기준으로 바뀝니다.
  const sk = (opts && opts.stackexKey) || (env && env.STACKEX_KEY);
  if (sk) u.searchParams.set('key', sk);
  return shapeSo(await grab(u.toString(), { retries: 0 }));
}

async function fromArxiv(q) {
  if (!looksTechnical(q)) throw new Error('논문 질문 아님');
  const u = new URL('https://export.arxiv.org/api/query');
  u.searchParams.set('search_query', 'all:' + q);
  u.searchParams.set('start', '0');
  u.searchParams.set('max_results', '6');
  // arXiv 서버는 자주 느립니다. 논문은 있으면 좋은 정도라
  // 2.5초 안에 안 오면 포기합니다. 이것 하나가 전체를 5초로 끌던 원인이었습니다.
  const xml = await grab(u.toString(), {
    text: true, retries: 0, timeout: 2500,
    headers: { 'Accept': 'application/atom+xml' }
  });

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

async function fromOpenAlex(q, env, opts) {
  if (!looksTechnical(q)) throw new Error('논문 질문 아님');
  const u = new URL('https://api.openalex.org/works');
  u.searchParams.set('search', q);
  u.searchParams.set('per-page', '6');
  // OpenAlex 는 연락처가 없는 요청을 공용 대역으로 묶습니다. Worker 는 세계 각지의
  // 공유 IP에서 나가기 때문에 그 대역이 남들 요청으로 이미 차 있고, 그래서 429 가
  // 났습니다. 메일을 넣으면 polite pool 로 옮겨져 사실상 막히지 않습니다.
  // 쿼리와 User-Agent 양쪽에 넣는 것이 OpenAlex 가 안내하는 방식입니다.
  const mail = (opts && opts.openalexMail) || (env && env.OPENALEX_MAIL);
  const headers = {};
  if (mail) {
    u.searchParams.set('mailto', mail);
    headers['User-Agent'] = 'podogum/2.0 (+https://podogum.kr; mailto:' + mail + ')';
  }
  const data = await grab(u.toString(), { retries: 0, headers: headers });
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
  if (!looksTechnical(q)) throw new Error('개발 질문 아님');
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

/* -------- 날씨 (Open-Meteo, 키 없음) --------
   검색어에 날씨 낱말과 지명이 같이 있을 때만 켜집니다.
   "부산에 비가 오냐" 같은 질문에 문서가 아니라 실제 예보로 답하기 위한 소스입니다. */

const WEATHER_HINT = /(날씨|기온|온도|비가|비 오|눈이|눈 오|우산|더운|더위|추운|추위|습도|바람|예보|weather|forecast|rain|snow|temperature)/i;
const JOSA = /(에서|으로|에게|이랑|하고|한테|까지|부터|에|은|는|이|가|을|를|의|로|도|만|과|와)$/;
const STOPWORD = /^(오늘|내일|모레|지금|현재|이번|주말|아침|저녁|밤|낮|날씨|기온|온도|우산|예보|어떻게|어때|어떄|알려줘|알려|아니면|안오냐|오냐|weather|today|tomorrow|now)$/i;

const WMO = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림',
  45: '안개', 48: '서리 안개',
  51: '약한 이슬비', 53: '이슬비', 55: '강한 이슬비',
  61: '약한 비', 63: '비', 65: '강한 비',
  66: '얼어붙는 비', 67: '강하게 얼어붙는 비',
  71: '약한 눈', 73: '눈', 75: '많은 눈', 77: '싸락눈',
  80: '소나기', 81: '강한 소나기', 82: '매우 강한 소나기',
  85: '눈 소나기', 86: '강한 눈 소나기',
  95: '뇌우', 96: '우박 동반 뇌우', 99: '강한 우박 뇌우'
};

function placeCandidates(q) {
  return q.split(/\s+/)
    .map(function (t) { return t.replace(/[?!.,~]/g, '').replace(JOSA, ''); })
    .filter(function (t) { return t.length >= 2 && !STOPWORD.test(t) && !/^\d+$/.test(t); })
    .slice(0, 4);
}

async function geocode(name) {
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.searchParams.set('name', name);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'ko');
  u.searchParams.set('format', 'json');
  const data = await grab(u.toString(), { retries: 0 });
  const hit = (data.results || [])[0];
  return hit ? { name: hit.name, lat: hit.latitude, lon: hit.longitude, country: hit.country || '' } : null;
}

async function fromWeather(q) {
  if (!WEATHER_HINT.test(q)) throw new Error('날씨 질문 아님');

  let place = null;
  const names = placeCandidates(q);
  for (let i = 0; i < names.length && !place; i++) {
    try { place = await geocode(names[i]); } catch (e) { /* 다음 후보 */ }
  }
  if (!place) throw new Error('지명을 못 찾음');

  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(place.lat));
  u.searchParams.set('longitude', String(place.lon));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,precipitation,weather_code');
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  u.searchParams.set('timezone', 'auto');
  u.searchParams.set('forecast_days', '3');
  const d = await grab(u.toString(), { retries: 0 });

  const cur = d.current || {};
  const day = d.daily || {};
  const sky = WMO[cur.weather_code] || '';
  const pop = (day.precipitation_probability_max || [])[0];
  const hi = (day.temperature_2m_max || [])[0];
  const lo = (day.temperature_2m_min || [])[0];

  const head = place.name + ' 지금 ' + Math.round(cur.temperature_2m) + '°C'
             + (sky ? ' · ' + sky : '')
             + (typeof pop === 'number' ? ' · 강수확률 ' + pop + '%' : '');

  const lines = [];
  if (typeof hi === 'number') lines.push('오늘 ' + Math.round(lo) + '~' + Math.round(hi) + '°C');
  if (typeof cur.precipitation === 'number' && cur.precipitation > 0) lines.push('현재 강수 ' + cur.precipitation + 'mm');
  if (typeof cur.relative_humidity_2m === 'number') lines.push('습도 ' + cur.relative_humidity_2m + '%');

  // 내일·모레 요약
  const codes = day.weather_code || [];
  const pops = day.precipitation_probability_max || [];
  const labels = ['오늘', '내일', '모레'];
  const ahead = [];
  for (let i = 1; i < Math.min(3, codes.length); i++) {
    ahead.push(labels[i] + ' ' + (WMO[codes[i]] || '') + (typeof pops[i] === 'number' ? ' ' + pops[i] + '%' : ''));
  }
  if (ahead.length) lines.push(ahead.join(' · '));

  return [{
    title: head,
    url: 'https://search.naver.com/search.naver?query=' + encodeURIComponent(place.name + ' 날씨'),
    snippet: lines.join(' · '),
    extra: '실시간 예보 · Open-Meteo'
  }];
}

/* github.com 주소를 하나의 표준형으로 맞춥니다.
   npm·PyPI 결과를 저장소 주소로 바꿔주면 GitHub 결과와 실제로 겹쳐서
   여러 소스가 같은 라이브러리를 가리킬 때 RRF가 비로소 작동합니다. */
function ghNorm(u) {
  if (!u) return '';
  const m = /github\.com[/:]([^/\s]+)\/([^/#?\s]+)/.exec(String(u));
  if (!m) return '';
  return 'https://github.com/' + m[1] + '/' + m[2].replace(/\.git$/, '');
}

function pickRepo(urls) {
  const keys = ['Source', 'Source Code', 'Repository', 'Code', 'GitHub', 'Homepage', 'homepage'];
  for (let i = 0; i < keys.length; i++) {
    const hit = ghNorm(urls[keys[i]]);
    if (hit) return hit;
  }
  for (const k in urls) {
    const hit = ghNorm(urls[k]);
    if (hit) return hit;
  }
  return '';
}


/* =======================================================
   패키지 저장소 묶음

   일곱 곳을 Worker 안에서 한꺼번에 부르고 결과를 하나로 합칩니다.
   화면에는 칸 하나로 보이지만 속은 일곱 갈래입니다.
   주소는 되도록 GitHub 저장소로 맞춰서 GitHub 검색 결과와 겹치게 합니다.
   ======================================================= */

async function npmSearch(q) {
  const u = new URL('https://registry.npmjs.org/-/v1/search');
  u.searchParams.set('text', q);
  u.searchParams.set('size', '4');
  const data = await grab(u.toString(), { retries: 0 });
  return (data.objects || []).map(function (o) {
    const p = o.package || {};
    const repo = ghNorm(p.links && p.links.repository);
    return {
      title: strip(p.name, 130),
      url: repo || ('https://www.npmjs.com/package/' + p.name),
      snippet: strip(p.description, 200),
      extra: 'npm v' + (p.version || '')
    };
  }).filter(function (x) { return x.title; });
}

async function pypiLookup(q) {
  const name = q.trim().toLowerCase().replace(/\s+/g, '-');
  if (!/^[a-z0-9._-]{2,60}$/.test(name)) return [];
  const data = await grab('https://pypi.org/pypi/' + encodeURIComponent(name) + '/json', { retries: 0 });
  const info = data.info || {};
  if (!info.name) return [];
  const repo = pickRepo(info.project_urls || {}) || ghNorm(info.home_page);
  return [{
    title: strip(info.name, 130),
    url: repo || ('https://pypi.org/project/' + info.name + '/'),
    snippet: strip(info.summary, 200),
    extra: 'PyPI v' + (info.version || '')
  }];
}

async function cratesSearch(q) {
  const u = new URL('https://crates.io/api/v1/crates');
  u.searchParams.set('q', q);
  u.searchParams.set('per_page', '4');
  const data = await grab(u.toString(), { retries: 0 });
  return (data.crates || []).map(function (c) {
    const repo = ghNorm(c.repository);
    return {
      title: strip(c.name, 130),
      url: repo || ('https://crates.io/crates/' + c.name),
      snippet: strip(c.description, 200),
      extra: 'crates.io v' + (c.newest_version || c.max_version || '')
    };
  }).filter(function (x) { return x.title; });
}

async function mavenSearch(q) {
  const u = new URL('https://search.maven.org/solrsearch/select');
  u.searchParams.set('q', q);
  u.searchParams.set('rows', '4');
  u.searchParams.set('wt', 'json');
  const data = await grab(u.toString(), { retries: 0 });
  const docs = ((data.response || {}).docs) || [];
  return docs.map(function (d) {
    if (!d.g || !d.a) return null;
    return {
      title: strip(d.a, 130),
      // Maven 검색 결과에는 저장소 주소가 없어서 GitHub과 겹치지 않습니다
      url: 'https://central.sonatype.com/artifact/' + d.g + '/' + d.a,
      snippet: strip(d.g, 200),
      extra: 'Maven v' + (d.latestVersion || d.v || '')
    };
  }).filter(Boolean);
}

async function nugetSearch(q) {
  const u = new URL('https://azuresearch-usnc.nuget.org/query');
  u.searchParams.set('q', q);
  u.searchParams.set('take', '4');
  const data = await grab(u.toString(), { retries: 0 });
  return (data.data || []).map(function (p) {
    if (!p.id) return null;
    const repo = ghNorm(p.projectUrl);
    return {
      title: strip(p.id, 130),
      url: repo || ('https://www.nuget.org/packages/' + p.id),
      snippet: strip(p.description, 200),
      extra: 'NuGet v' + (p.version || '')
    };
  }).filter(Boolean);
}

async function gemsSearch(q) {
  const u = new URL('https://rubygems.org/api/v1/search.json');
  u.searchParams.set('query', q);
  const list = await grab(u.toString(), { retries: 0 });
  return (Array.isArray(list) ? list : []).slice(0, 4).map(function (g) {
    if (!g.name) return null;
    const repo = ghNorm(g.source_code_uri) || ghNorm(g.homepage_uri);
    return {
      title: strip(g.name, 130),
      url: repo || ('https://rubygems.org/gems/' + g.name),
      snippet: strip(g.info, 200),
      extra: 'RubyGems v' + (g.version || '')
    };
  }).filter(Boolean);
}

async function packagistSearch(q) {
  const u = new URL('https://packagist.org/search.json');
  u.searchParams.set('q', q);
  u.searchParams.set('per_page', '4');
  const data = await grab(u.toString(), { retries: 0 });
  return (data.results || []).map(function (p) {
    if (!p.name) return null;
    const repo = ghNorm(p.repository) || ghNorm(p.url);
    return {
      title: strip(p.name, 130),
      url: repo || p.url || ('https://packagist.org/packages/' + p.name),
      snippet: strip(p.description, 200),
      extra: 'Packagist'
    };
  }).filter(Boolean);
}

async function fromPackages(q) {
  // 저장소들은 전부 영문 패키지 이름으로 되어 있습니다.
  // 한글로만 된 질문에는 맞을 수 있는 게 없습니다.
  if (!/[A-Za-z][A-Za-z0-9._-]/.test(q)) throw new Error('패키지 검색어 아님');

  const settled = await Promise.allSettled([
    npmSearch(q), pypiLookup(q), cratesSearch(q), mavenSearch(q),
    nugetSearch(q), gemsSearch(q), packagistSearch(q)
  ]);

  const lists = [];
  settled.forEach(function (r) {
    if (r.status === 'fulfilled' && r.value && r.value.length) lists.push(r.value);
  });
  if (!lists.length) throw new Error('결과 없음');

  // 이어붙이면 뒤쪽 저장소의 1등이 한참 아래 순위를 받습니다.
  // 각 저장소의 1등끼리, 2등끼리 번갈아 뽑아야 공평합니다.
  const out = [];
  let depth = 0;
  while (out.length < 14) {
    let added = false;
    for (let i = 0; i < lists.length; i++) {
      if (lists[i][depth]) { out.push(lists[i][depth]); added = true; }
    }
    if (!added) break;
    depth++;
  }
  return out;
}

/* =======================================================
   제품 (Open Food Facts)

   키가 없고 광고가 없는 공개 식품 데이터베이스입니다.
   성분표·첨가물·영양등급이 사람들 손으로 모여 있고, 돈으로 순위를 살 수 없습니다.

   두 가지 경우에만 켜집니다.
     1. 검색어가 바코드 숫자일 때  → 그 제품을 바로 조회
     2. 성분·첨가물 같은 낱말이 있을 때 → 제품명으로 검색
   그 외에는 조용히 꺼집니다. 아무 질문에나 켜지면 npm 때처럼 엉뚱한 결과만 늘어납니다.
   ======================================================= */

const PRODUCT_HINT = /(성분|첨가물|첨가제|리콜|무해|유해|안전한가|칼로리|영양|당류|나트륨|알레르기|들어있|들어가|함유)/;
const NUTRI = { a: '영양등급 A (가장 좋음)', b: '영양등급 B', c: '영양등급 C', d: '영양등급 D', e: '영양등급 E (가장 나쁨)' };
const NOVA = { 1: '자연식품', 2: '가공 재료', 3: '가공식품', 4: '초가공식품' };

function shapeProduct(p) {
  if (!p || !p.code) return null;
  const name = (p.product_name_ko || p.product_name || '').trim();
  if (!name) return null;

  const brand = (p.brands || '').split(',')[0].trim();
  const bits = [];

  if (p.nutriscore_grade && NUTRI[p.nutriscore_grade]) bits.push(NUTRI[p.nutriscore_grade]);
  if (p.nova_group && NOVA[p.nova_group]) bits.push(NOVA[p.nova_group]);

  const adds = (p.additives_tags || []).length;
  if (adds) bits.push('첨가물 ' + adds + '개');

  const alg = (p.allergens_tags || []).length;
  if (alg) bits.push('알레르기 표시 ' + alg + '개');

  const ing = strip(p.ingredients_text_ko || p.ingredients_text || '', 220);

  return {
    title: strip(name + (brand ? ' · ' + brand : ''), 130),
    url: 'https://world.openfoodfacts.org/product/' + p.code,
    snippet: ing || strip((p.categories || '').split(',').slice(0, 3).join(', '), 200),
    extra: bits.length ? bits.join(' · ') : ('바코드 ' + p.code)
  };
}

async function fromProduct(q) {
  const t = q.trim();

  // 1. 바코드
  if (/^\d{8,14}$/.test(t)) {
    const u = 'https://world.openfoodfacts.org/api/v2/product/' + t + '.json'
            + '?fields=code,product_name,product_name_ko,brands,nutriscore_grade,nova_group,'
            + 'additives_tags,allergens_tags,ingredients_text,ingredients_text_ko,categories';
    const data = await grab(u, { retries: 0, timeout: 3500 });
    const one = shapeProduct(data.product);
    if (!one) throw new Error('등록되지 않은 바코드');
    return [one];
  }

  // 2. 성분·안전 관련 낱말이 있을 때만 제품명으로 검색
  if (!PRODUCT_HINT.test(t)) throw new Error('제품 질문 아님');

  const u = new URL('https://kr.openfoodfacts.org/cgi/search.pl');
  u.searchParams.set('search_terms', t.replace(PRODUCT_HINT, '').trim() || t);
  u.searchParams.set('search_simple', '1');
  u.searchParams.set('action', 'process');
  u.searchParams.set('json', '1');
  u.searchParams.set('page_size', '5');
  const data = await grab(u.toString(), { retries: 0, timeout: 4000 });

  const out = (data.products || []).map(shapeProduct).filter(Boolean);
  if (!out.length) throw new Error('결과 없음');
  return out;
}

// id, 표시명, RRF 가중치, 어댑터
const SOURCES = [
  { id: 'weather',  label: '날씨',           weight: 2.0, fn: fromWeather },
  { id: 'brave',    label: 'Brave',          weight: 1.4, fn: fromBrave },
  { id: 'tavily',   label: 'Tavily',         weight: 1.4, fn: fromTavily },
  { id: 'searxng',  label: 'SearXNG',        weight: 1.4, fn: fromSearxng },
  { id: 'ddg',      label: 'DuckDuckGo',     weight: 0.9, fn: fromDuckDuckGo },
  { id: 'wiki',     label: 'Wikipedia',      weight: 1.1, fn: fromWikipedia },
  { id: 'hn',       label: 'Hacker News',    weight: 0.8, fn: fromHackerNews },
  { id: 'so',       label: 'Stack Overflow', weight: 0.8, fn: fromStackOverflow },
  { id: 'arxiv',    label: 'arXiv',          weight: 0.7, fn: fromArxiv },
  { id: 'openalex', label: 'OpenAlex',       weight: 0.7, fn: fromOpenAlex },
  { id: 'github',   label: 'GitHub',         weight: 0.8, fn: fromGithub },
  { id: 'notion',   label: '내 노션',        weight: 1.5, fn: fromNotion },
  { id: 'pkg',      label: '패키지',         weight: 0.8, fn: fromPackages },
  { id: 'product',  label: '제품',           weight: 1.8, fn: fromProduct }
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
      if (!item.title) return;
      const key = item.url ? normalizeUrl(item.url) : ('t:' + item.title);
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
  // 브라우저가 보낸 개인 키·설정 (저장하지 않고 이 요청에만 씁니다)
  const opts = {
    braveKey:     (request.headers.get('X-Brave-Key') || '').trim(),
    tavilyKey:    (request.headers.get('X-Tavily-Key') || '').trim(),
    notionToken:  (request.headers.get('X-Notion-Token') || '').trim(),
    stackexKey:   (request.headers.get('X-Stackex-Key') || '').trim(),
    openalexMail: (request.headers.get('X-Openalex-Mail') || '').trim(),
    searxngUrl:   (request.headers.get('X-Searxng-Url') || '').trim(),
    passKey:      (request.headers.get('X-Pass-Key') || '').trim(),
    visitorId:    (request.headers.get('X-Visitor-Id') || '').trim()
  };

  const only = (src.searchParams.get('only') || '').split(',').filter(Boolean);
  const active = only.length
    ? SOURCES.filter(function (s) { return only.indexOf(s.id) !== -1; })
    : SOURCES;
  if (!active.length) return json({ error: '고른 소스가 없습니다.' }, 400, origin);

  // Brave가 이번 요청에 실제로 포함될 때만 할당량을 봅니다.
  // 화면이 소스별로 따로 요청하기 때문에, 이 조건이 없으면
  // GitHub만 검색해도 Brave 횟수가 깎입니다.
  const wantsBrave = active.some(function (s) { return s.id === 'brave' || s.id === 'tavily'; });
  let gate = { ok: false, mode: 'skip', left: null, limit: null };
  if (wantsBrave) {
    // 아직 세지는 않습니다. 캐시에서 답이 나오면 깎지 않기 위해서입니다.
    gate = await checkQuota(env, request, opts, false);
    opts.allowedBraveKey = gate.ok ? gate.key : '';
    opts.braveReason = gate.ok ? '' : (gate.reason || '무료분을 다 쓰셨습니다');
    // Tavily 도 같은 무료 한도를 씁니다. 자기 키를 넣으면 제한이 없습니다.
    opts.allowedTavilyKey = opts.tavilyKey || (gate.ok ? (env.TAVILY_KEY || '') : '');
    opts.tavilyReason = opts.allowedTavilyKey ? '' : (gate.reason || 'Tavily 키를 입력하면 검색됩니다');
  }

  const cacheUrl = new URL(src.origin + '/cache/fusion');
  cacheUrl.searchParams.set('q', q);
  cacheUrl.searchParams.set('s', active.map(function (s) { return s.id; }).join(','));
  cacheUrl.searchParams.set('bk', opts.allowedBraveKey ? '1' : '0');
  // 노션 결과는 사람마다 다릅니다. 토큰이 있으면 캐시를 아예 쓰지 않습니다.
  if (opts.notionToken) cacheUrl.searchParams.set('nt', await sha8(opts.notionToken));
  cacheUrl.searchParams.set('sx', (opts.searxngUrl || env.SEARXNG_URL) ? '1' : '0');
  const cache = caches.default;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const body = await hit.json();
    body.cache = 'HIT';
    if (wantsBrave) body.quota = { mode: gate.mode, left: gate.left, limit: gate.limit };
    return json(body, 200, origin);
  }

  // 캐시에 없으니 실제로 Brave를 부릅니다. 이제 한 번 차감합니다.
  if (wantsBrave && gate.ok && gate.mode !== 'byok') {
    gate = await checkQuota(env, request, opts, true);
    opts.allowedBraveKey = gate.ok ? gate.key : '';
    opts.braveReason = gate.ok ? '' : (gate.reason || '무료분을 다 쓰셨습니다');
    opts.allowedTavilyKey = opts.tavilyKey || (gate.ok ? (env.TAVILY_KEY || '') : '');
    opts.tavilyReason = opts.allowedTavilyKey ? '' : (gate.reason || 'Tavily 키를 입력하면 검색됩니다');
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
    // 소스별 원본. 화면이 이걸로 칸을 채우고 자체 융합도 합니다.
    bysource: perSource.map(function (p) {
      return { id: p.id, items: p.items };
    }),
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

  // 사람마다 다른 값이라 캐시에는 넣지 않습니다
  if (wantsBrave) payload.quota = { mode: gate.mode, left: gate.left, limit: gate.limit };
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
      kv: Boolean(env.PODOGUM_KV),
      tavily_key_server: Boolean(env.TAVILY_KEY),
      free_per_day: parseInt(env.FREE_PER_DAY || FREE_PER_DAY_DEFAULT, 10),
        brave_key_header: 'X-Brave-Key (브라우저에서 보내면 그걸 우선 사용)',
        openalex_mail: Boolean(env.OPENALEX_MAIL),
        searxng: Boolean(env.SEARXNG_URL)
      }, 200, origin);
    }

    if (url.pathname === '/api/pass') {
      return handlePass(request, env, origin);
    }

    if (url.pathname === '/api/search') {
      if (request.method !== 'GET') return json({ error: 'GET만 지원합니다.' }, 405, origin);
      return handleSearch(request, env, ctx, origin);
    }

    return json({ error: '없는 경로입니다.' }, 404, origin);
  }
};
