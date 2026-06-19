// 구형 모바일 브라우저 호환 (iOS 15·구형 안드로이드는 AbortSignal.timeout 미지원)
if (!AbortSignal.timeout) {
  AbortSignal.timeout = ms => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return c.signal;
  };
}
// HTML 이스케이프 (종목명 등 외부 데이터 표시용)
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 만료된 시세/재무 캐시 정리 (localStorage 무한 증식 방지)
(() => {
  const now = Date.now(), DAY = 24 * 60 * 60 * 1000;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!/^(yf:|yfs:|nv:)/.test(k)) continue;
    try {
      const c = JSON.parse(localStorage.getItem(k));
      if (!c || !c.t || now - c.t > DAY) localStorage.removeItem(k);
    } catch (e) { localStorage.removeItem(k); }
  }
})();

// ───────────────────────── 설정 ─────────────────────────
const STORAGE_KEY = 'my-watchlist-v2';
const DEFAULT_LIST = [
  { symbol: '005930.KS', name: '삼성전자' },
  { symbol: '000660.KS', name: 'SK하이닉스' },
  { symbol: 'NVDA',      name: '엔비디아', reuters: 'NVDA.O' }
];
const MACRO = [
  { symbol: '^KS11',     label: '코스피',       fmt: 'num', naver: 'KOSPI',  group: 'kr' },
  { symbol: '^KQ11',     label: '코스닥',       fmt: 'num', naver: 'KOSDAQ', group: 'kr' },
  { symbol: '^GSPC',     label: 'S&P 500',      fmt: 'num', group: 'us' },
  { symbol: '^IXIC',     label: '나스닥',       fmt: 'num', group: 'us' },
  { symbol: '^DJI',      label: '다우존스',     fmt: 'num', group: 'us' },
  { symbol: '^N225',     label: '닛케이 225',   fmt: 'num', group: 'global' },
  { symbol: '000001.SS', label: '상해종합',     fmt: 'num', group: 'global' },
  { symbol: '^SOX',      label: 'SOX 반도체',   fmt: 'num', group: 'global' },
  { symbol: 'KRW=X',     label: '원/달러',      fmt: 'krw', group: 'fx' },
  { symbol: 'DX-Y.NYB',  label: '달러인덱스',   fmt: 'num', group: 'fx' },
  { symbol: '^TNX',      label: '미국채 10년',  fmt: 'pct', group: 'fx' },
  { symbol: '^IRX',      label: '미국채 3M',    fmt: 'pct', group: 'fx' },
  { symbol: 'CL=F',      label: 'WTI 유가',     fmt: 'usd', group: 'comm' },
  { symbol: 'GC=F',      label: '금',           fmt: 'usd', group: 'comm' },
  { symbol: 'HG=F',      label: '구리',         fmt: 'usd', group: 'comm' },
  { symbol: 'BTC-USD',   label: '비트코인',     fmt: 'usd', group: 'comm' },
  { symbol: '^VIX',      label: 'VIX',          fmt: 'num', group: 'comm' }
];
const MACRO_GROUPS = [
  { key: 'kr',     label: '🇰🇷 국내' },
  { key: 'us',     label: '🇺🇸 미국' },
  { key: 'global', label: '🌏 글로벌' },
  { key: 'fx',     label: '💱 환율·금리' },
  { key: 'comm',   label: '🛢️ 원자재·기타' }
];
// 거시 칩 클릭 시 상세 모달에 넘길 item (지수/지표 공용)
function macroItem(m) { return { symbol: m.symbol, name: m.label, isIndex: true, naver: m.naver, fmt: m.fmt }; }
let usdkrw = null; // 원/달러 환율 — 미국 보유종목 원화 환산용
let macroData = {}; // 거시 점수용 — renderMacro에서 심볼별 {price, prev} 저장
// CORS 프록시 폴백 체인 (정적 페이지에서 외부 API 호출용)
// corsproxy: 빠르지만 네이버 차단 / allorigins: 전체 지원, 가끔 과부하
// corsfix·jina: 네이버 포함 전체 지원 / codetabs: 최후 보루
const PROXY_DEFS = [
  { wrap: u => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
  { wrap: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { wrap: u => 'https://proxy.corsfix.com/?' + u },
  { wrap: u => 'https://r.jina.ai/' + u, headers: { 'X-Return-Format': 'text' } },
  { wrap: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) }
];
// 호스트별 마지막 성공 프록시 기억 (네이버는 corsproxy가 차단하므로 corsfix(2)부터 시작)
const proxyAffinity = { 'm.stock.naver.com': 2, 'api.stock.naver.com': 2, 'ac.stock.naver.com': 2 };
const CACHE_TTL = 3 * 60 * 1000; // 시세 캐시 3분
// 데이터 로드 실패 시 마지막 캐시를 표시하고 상태 배너로 알림 (stale-while-error)
function noteStale(ts) {
  if (typeof setDataStatus === 'function')
    setDataStatus('일부 데이터가 지연되어 마지막 저장본을 표시 중입니다 ('
      + new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 기준)');
}

// ── Claude AI 연동 (하이브리드: 키 입력 시에만 실제 LLM 호출) ──
const CLAUDE_MODELS = {
  'claude-opus-4-8': 'Opus 4.8 — 최고 품질',
  'claude-sonnet-4-6': 'Sonnet 4.6 — 균형 (권장)',
  'claude-haiku-4-5-20251001': 'Haiku 4.5 — 빠름·저렴'
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';
function getClaudeKey() { return localStorage.getItem('anthropicKey') || ''; }
function getClaudeModel() { return localStorage.getItem('anthropicModel') || DEFAULT_MODEL; }
function hasClaudeKey() { return !!getClaudeKey(); }
async function callClaude(system, user, maxTokens = 1500) {
  const key = getClaudeKey();
  if (!key) throw new Error('NO_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: getClaudeModel(), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch (x) {}
    throw new Error(msg);
  }
  const j = await res.json();
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
// 멀티턴 대화용 — messages 배열을 그대로 전달 (대화형 질의 기능)
async function claudeChat(system, messages, maxTokens = 800) {
  const key = getClaudeKey();
  if (!key) throw new Error('NO_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: getClaudeModel(), max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch (x) {}
    throw new Error(msg);
  }
  const j = await res.json();
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

let watchlist = loadList();
let selected = watchlist[0] || DEFAULT_LIST[0];
const quoteCache = {}; // 카드 시세 저장 → 상세 모달 헤더에서 재사용

// ───────────────────────── 유틸 ─────────────────────────
function loadList() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved) && saved.length && saved[0].symbol) return saved;
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_LIST));
}
function saveList() { localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist)); }

async function fetchViaProxy(url, asText, validate) {
  const host = new URL(url).host;
  const fav = proxyAffinity[host];
  const order = [...PROXY_DEFS.keys()];
  if (fav != null) order.splice(0, 0, ...order.splice(order.indexOf(fav), 1)); // 성공했던 프록시 우선
  let lastErr;
  for (const idx of order) {
    const p = PROXY_DEFS[idx];
    try {
      const res = await fetch(p.wrap(url), { headers: p.headers || {}, signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      const out = asText ? text : JSON.parse(text); // 프록시가 에러 페이지를 200으로 줘도 JSON 검증에서 걸러짐
      // 200이지만 내용이 깨진 응답(프록시 차단/캡차 페이지 등)이면 다음 프록시로 — 잘못된 프록시가 affinity에 고정되는 것 방지
      if (validate && !validate(out)) throw new Error('invalid content');
      proxyAffinity[host] = idx;
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
// RSS/XML 응답 검증 — item이나 entry가 있어야 정상 피드
function isValidRss(t) { return typeof t === 'string' && /<item[\s>]|<entry[\s>]/i.test(t); }

// Yahoo Finance 차트 API (시세 + 시계열, 인증 불필요)
async function fetchChart(symbol, range, interval, noCache) {
  const cacheKey = `yf:${symbol}:${range}:${interval}`;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(cacheKey)); } catch (e) {}
  if (!noCache && cached && cached.d && Date.now() - cached.t < CACHE_TTL) return cached.d;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    const json = await fetchViaProxy(url, false);
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('no data: ' + symbol);
    try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), d: result })); } catch (e) {}
    return result;
  } catch (e) {
    if (cached && cached.d) { noteStale(cached.t); return cached.d; } // 실패 시 마지막 캐시라도 표시
    throw e;
  }
}

// Yahoo spark API — 여러 종목 시세를 한 번에 (프록시 요청 폭주 방지)
// 응답: { "심볼": { timestamp[], close[], previousClose, ... }, ... }
async function fetchSpark(symbols, range, interval, noCache) {
  const cacheKey = `yfs:${symbols.join('|')}:${range}`;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(cacheKey)); } catch (e) {}
  if (!noCache && cached && cached.d && Date.now() - cached.t < CACHE_TTL) return cached.d;
  try {
    // 심볼의 ^, = 등은 인코딩하되 구분자 콤마는 그대로 둬야 한다
    const symParam = symbols.map(encodeURIComponent).join(',');
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symParam}&range=${range}&interval=${interval}`;
    const json = await fetchViaProxy(url, false);
    if (!json || typeof json !== 'object') throw new Error('spark: no data');
    try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), d: json })); } catch (e) {}
    return json;
  } catch (e) {
    if (cached && cached.d) { noteStale(cached.t); return cached.d; } // 실패 시 마지막 캐시라도 표시
    throw e;
  }
}

function isKorean(symbol) { return /\.(KS|KQ)$/.test(symbol); }

function lastValid(arr) {
  for (let i = (arr || []).length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function fmtPrice(v, symbol, fmt) {
  if (v == null) return '—';
  if (fmt === 'pct') return v.toFixed(2) + '%';
  if (fmt === 'krw' || isKorean(symbol)) return '₩' + Math.round(v).toLocaleString('ko-KR');
  if (fmt === 'usd' || (!fmt && !isKorean(symbol))) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

function chgInfo(price, prevClose) {
  if (price == null || !prevClose) return { cls: 'flat', text: '—' };
  const diff = price - prevClose;
  const pct = (diff / prevClose) * 100;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const sign = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
  return { cls, text: `${sign} ${Math.abs(diff).toLocaleString('en-US', { maximumFractionDigits: 2 })} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)` };
}

function relTime(d) {
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 전';
  return Math.floor(h / 24) + '일 전';
}

