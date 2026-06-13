// ═════════════════════ 기준 시각 표시 ═════════════════════
function fmtClock(ts) { return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); }
function stampAsof(elId) {
  blockAsOf[elId] = Date.now();
  const el = document.getElementById(elId);
  if (el) el.textContent = '기준 ' + fmtClock(blockAsOf[elId]);
}

// ═════════════════════ 🔥 떠오르는 업종 ═════════════════════
// 미국 11개 SPDR 섹터 ETF + 대표 종목
const US_SECTORS = [
  { symbol: 'XLK',  name: '기술',        leaders: ['애플', '엔비디아', '마이크로소프트'] },
  { symbol: 'XLC',  name: '커뮤니케이션', leaders: ['메타', '알파벳', '넷플릭스'] },
  { symbol: 'XLY',  name: '임의소비재',  leaders: ['아마존', '테슬라', '홈디포'] },
  { symbol: 'XLF',  name: '금융',        leaders: ['JP모건', '뱅크오브아메리카', '비자'] },
  { symbol: 'XLV',  name: '헬스케어',    leaders: ['일라이릴리', '유나이티드헬스', 'J&J'] },
  { symbol: 'XLI',  name: '산업재',      leaders: ['GE에어로', '캐터필러', '보잉'] },
  { symbol: 'XLE',  name: '에너지',      leaders: ['엑슨모빌', '셰브론'] },
  { symbol: 'XLP',  name: '필수소비재',  leaders: ['코스트코', 'P&G', '월마트'] },
  { symbol: 'XLB',  name: '소재',        leaders: ['린데', '셔윈윌리엄스'] },
  { symbol: 'XLU',  name: '유틸리티',    leaders: ['넥스트에라', '서던컴퍼니'] },
  { symbol: 'XLRE', name: '부동산',      leaders: ['프로로지스', '아메리칸타워'] }
];
async function fetchNaverIndustries() {
  const url = 'https://m.stock.naver.com/api/stocks/industry?page=1&pageSize=45';
  const j = await fetchViaProxy(url, false, o => o && Array.isArray(o.groups));
  return (j.groups || []).map(g => ({
    no: g.no, name: g.name, changeRate: parseFloat(g.changeRate),
    riseCount: +g.riseCount || 0, fallCount: +g.fallCount || 0, totalCount: +g.totalCount || 0
  })).filter(g => !isNaN(g.changeRate));
}
async function fetchIndustryLeaders(no) {
  try {
    const url = `https://m.stock.naver.com/api/stocks/industry/${no}?page=1&pageSize=4`;
    const j = await fetchViaProxy(url, false, o => o && Array.isArray(o.stocks));
    return (j.stocks || []).map(s => ({ name: s.stockName, code: s.itemCode, ratio: parseFloat(s.fluctuationsRatio) })).filter(x => x.name).slice(0, 3);
  } catch (e) { return []; }
}
async function fetchUsSectors(noCache) {
  const data = await fetchSpark(US_SECTORS.map(s => s.symbol), '1d', '15m', noCache);
  return US_SECTORS.map(s => {
    const d = data[s.symbol];
    if (!d) return null;
    const price = lastValid(d.close), prev = d.previousClose;
    if (price == null || !prev) return null;
    return { name: s.name, leaders: s.leaders, changeRate: (price - prev) / prev * 100 };
  }).filter(Boolean);
}
// 업종이 떠오르는 이유 (규칙 기반)
function sectorWhy(s, mk) {
  const cr = s.changeRate, p = [];
  if (mk === 'kr') {
    const breadth = s.totalCount ? Math.round(s.riseCount / s.totalCount * 100) : null;
    if (cr >= 3) p.push(`업종 지수가 +${cr.toFixed(1)}%로 강하게 상승하며 오늘 시장 자금이 집중된 섹터`);
    else if (cr >= 0.5) p.push(`업종 지수가 +${cr.toFixed(1)}% 올라 상대적 강세`);
    else if (cr < 0) p.push(`업종 지수는 ${cr.toFixed(1)}%이나 순위권에 든 방어적 섹터`);
    else p.push(`업종 지수 +${cr.toFixed(1)}%`);
    if (breadth != null && breadth >= 75) p.push(`구성 종목의 ${breadth}%가 동반 상승해 일부 종목만이 아닌 업종 전반의 매수세`);
    else if (breadth != null && breadth >= 50) p.push(`구성 종목 ${breadth}%가 상승`);
    if (s.leaders && s.leaders.length && s.leaders[0].ratio >= 8) p.push(`${s.leaders[0].name}(+${s.leaders[0].ratio.toFixed(1)}%) 등 주도주 급등이 견인`);
  } else {
    if (cr >= 1.5) p.push(`섹터 ETF가 +${cr.toFixed(1)}%로 뚜렷한 강세를 보인 미국 섹터`);
    else if (cr >= 0.3) p.push(`섹터 ETF +${cr.toFixed(1)}% 상승`);
    else if (cr < 0) p.push(`섹터 ETF ${cr.toFixed(1)}%이나 상대적으로 선방`);
    else p.push(`섹터 ETF +${cr.toFixed(1)}%`);
    if (s.leaders && s.leaders.length) p.push(`${s.leaders.slice(0, 2).join('·')} 등 대형주가 속한 섹터`);
  }
  return p.join(', ') + '.';
}
async function renderTrendingSectors(noCache) {
  const wrap = document.getElementById('trending-sectors');
  if (!wrap) return;
  const mk = trendingMarket;
  wrap.innerHTML = '<div class="loading">업종별 자금 흐름을 분석하는 중…</div>';
  try {
    let sectors;
    if (mk === 'kr') {
      const inds = await fetchNaverIndustries();
      sectors = inds.sort((a, b) => b.changeRate - a.changeRate).slice(0, 6);
      await Promise.all(sectors.map(async t => { t.leaders = await fetchIndustryLeaders(t.no); }));
    } else {
      const us = await fetchUsSectors(noCache);
      sectors = us.sort((a, b) => b.changeRate - a.changeRate).slice(0, 6);
    }
    if (trendingMarket !== mk) return; // 사용자가 토글을 바꿈
    trendingCache[mk] = sectors;
    paintTrending(wrap, sectors, mk);
    stampAsof('ts-asof');
    if (typeof renderTopInsights === 'function') renderTopInsights();
  } catch (e) {
    if (trendingCache[mk] && trendingCache[mk].length) { // 실패 시 마지막 캐시라도 표시
      paintTrending(wrap, trendingCache[mk], mk);
      wrap.insertAdjacentHTML('beforeend', '<div class="oh-metric-note" style="margin-top:10px">⚠️ 데이터가 지연 중이라 직전 데이터를 표시 중입니다. <button class="retry-inline" onclick="renderTrendingSectors(true)">새로 고침</button></div>');
    } else {
      wrap.innerHTML = `<div class="loading">업종 데이터를 불러오지 못했습니다. <button class="retry-inline" onclick="renderTrendingSectors(true)" style="margin-left:8px">다시 시도</button></div>`;
    }
  }
}
function paintTrending(wrap, sectors, mk) {
  if (!sectors || !sectors.length) { wrap.innerHTML = '<div class="loading">표시할 업종이 없습니다.</div>'; return; }
  let html = '<div class="ts-grid">';
  sectors.forEach((s, i) => {
    const cls = s.changeRate >= 0 ? 'up' : 'down';
    const hot = i === 0 && s.changeRate > 0;
    const breadth = (mk === 'kr' && s.totalCount) ? Math.round(s.riseCount / s.totalCount * 100) : null;
    html += `<div class="ts-card${hot ? ' hot' : ''}">
      <div class="ts-card-head">
        <span class="ts-rank-badge">${i + 1}</span>
        <span class="ts-name">${esc(s.name)}</span>
        <span class="ts-chg ${cls}">${s.changeRate >= 0 ? '+' : ''}${s.changeRate.toFixed(2)}%</span>
      </div>`;
    if (breadth != null) {
      html += `<div class="ts-breadth">구성 ${s.totalCount}개 중 <b class="up">▲ ${s.riseCount}</b> · <b class="down">▼ ${s.fallCount}</b> (상승 ${breadth}%)
        <div class="ts-breadth-bar"><div class="ts-breadth-fill" style="width:${breadth}%"></div></div></div>`;
    }
    if (mk === 'kr' && s.leaders && s.leaders.length) {
      html += `<div class="ts-leaders">🚀 주도주 ` + s.leaders.map(l =>
        `<span class="ts-leader">${esc(l.name)} <span class="${l.ratio >= 0 ? 'up' : 'down'}">${isNaN(l.ratio) ? '' : (l.ratio >= 0 ? '+' : '') + l.ratio.toFixed(1) + '%'}</span></span>`).join('') + `</div>`;
    } else if (mk === 'us' && s.leaders && s.leaders.length) {
      html += `<div class="ts-leaders">🏢 대표 종목 ` + s.leaders.map(n => `<span class="ts-leader">${esc(n)}</span>`).join('') + `</div>`;
    }
    html += `<div class="ts-why">💡 ${esc(sectorWhy(s, mk))}</div></div>`;
  });
  wrap.innerHTML = html + '</div>';
}
// 토글 핸들러
(() => {
  const tog = document.getElementById('ts-toggle');
  if (!tog) return;
  tog.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    trendingMarket = b.dataset.mk;
    tog.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    if (trendingCache[trendingMarket]) { paintTrending(document.getElementById('trending-sectors'), trendingCache[trendingMarket], trendingMarket); stampAsof('ts-asof'); }
    else renderTrendingSectors();
  });
})();

// ═════════════════════ 🔝 오늘의 핵심 Top3 ═════════════════════
// 거시 지표별 정규화 계수(이 %만큼 움직이면 "유의미") + 방향별 영향 설명
const INSIGHT_MACRO = [
  { sym: '^KS11', name: '코스피', emoji: '📈', norm: 1.0, up: '국내 위험선호가 살아나 관심종목 전반에 우호적입니다.', dn: '국내 증시 전반의 투자심리가 위축되는 신호입니다.' },
  { sym: '^KQ11', name: '코스닥', emoji: '📈', norm: 1.2, up: '중소형·성장주로 매수세가 유입되는 신호입니다.', dn: '중소형·성장주의 투자심리가 약해지고 있습니다.' },
  { sym: '^IXIC', name: '나스닥', emoji: '🇺🇸', norm: 1.2, up: '미국 기술주 강세는 국내 반도체·AI주에 우호적으로 이어지기 쉽습니다.', dn: '미국 기술주 약세는 국내 성장주에 부담으로 전이될 수 있습니다.' },
  { sym: 'KRW=X', name: '원/달러 환율', emoji: '💱', norm: 0.5, up: '원화 약세(환율 상승)는 수출주에 유리하나 외국인 자금이탈 우려가 있습니다.', dn: '원화 강세(환율 하락)는 외국인 자금 유입에 우호적입니다.' },
  { sym: '^TNX', name: '미 국채 10년 금리', emoji: '🏦', norm: 2.0, up: '금리 상승은 성장주·기술주 밸류에이션에 부담을 줍니다.', dn: '금리 하락은 성장주·기술주에 우호적입니다.' },
  { sym: 'CL=F', name: 'WTI 유가', emoji: '🛢️', norm: 2.5, up: '유가 급등은 정유·조선에 수혜, 항공·운송·화학엔 비용 부담이며 인플레 압력입니다.', dn: '유가 하락은 운송·항공 비용을 낮추나 에너지주엔 부담입니다.' },
  { sym: '^VIX', name: 'VIX 공포지수', emoji: '⚠️', norm: 4.0, up: '변동성 급등은 시장 불안 확대 신호로, 위험회피 심리가 강해집니다.', dn: '변동성 진정은 위험자산 선호 회복 신호입니다.' },
  { sym: 'BTC-USD', name: '비트코인', emoji: '₿', norm: 4.0, up: '위험자산 선호의 바로미터로, 코인·핀테크 관련주와 동조하는 경향이 있습니다.', dn: '위험자산 회피 심리가 코인 시장에서 먼저 나타나는 신호일 수 있습니다.' }
];
function buildInsightCandidates() {
  const cands = [];
  INSIGHT_MACRO.forEach(def => {
    const d = macroData[def.sym];
    if (!d || d.price == null || !d.prev) return;
    const pct = (d.price - d.prev) / d.prev * 100;
    const impact = Math.abs(pct) / def.norm;
    if (impact < 0.55) return; // 평범한 변동은 후보 제외
    const up = pct >= 0;
    const valTxt = def.sym === '^TNX' ? d.price.toFixed(2) + '%' : (def.sym === 'KRW=X' ? fmtNum(d.price) + '원' : fmtNum(d.price));
    cands.push({
      cat: 'macro', emoji: def.emoji, impact,
      title: `${def.name} ${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%`,
      metric: `현재 ${valTxt} · 전일 대비 ${up ? '+' : ''}${pct.toFixed(2)}%`,
      why: up ? def.up : def.dn
    });
  });
  // 시장 뉴스 헤드라인 — 감성이 강한 톱 기사
  if (marketNewsItems && marketNewsItems.length) {
    const strong = [...marketNewsItems].filter(x => Math.abs(x.s) >= 2).sort((a, b) => Math.abs(b.s) - Math.abs(a.s))[0];
    if (strong) {
      const pos = strong.s > 0;
      cands.push({
        cat: 'news', emoji: pos ? '📰' : '🗞️', impact: 1.2 + Math.abs(strong.s) * 0.15,
        title: strong.title.length > 52 ? strong.title.slice(0, 52) + '…' : strong.title,
        metric: `${strong.source || '뉴스'} · 감성 점수 ${pos ? '호재 +' : '악재 '}${strong.s}`,
        why: pos ? '오늘 시장 분위기를 끌어올린 핵심 헤드라인입니다. 관련 섹터에 단기 모멘텀이 실릴 수 있습니다.' : '시장에 부담을 준 핵심 헤드라인입니다. 관련 섹터의 변동성 확대에 유의하세요.',
        link: strong.link
      });
    }
  }
  // 떠오르는 업종 1위 (한국)
  const kr = trendingCache.kr;
  if (kr && kr.length && kr[0].changeRate >= 2) {
    const top = kr[0];
    cands.push({
      cat: 'sector', emoji: '🔥', impact: 1.0 + top.changeRate / 4,
      title: `${top.name} 업종 ${top.changeRate >= 0 ? '+' : ''}${top.changeRate.toFixed(1)}% 급등`,
      metric: top.totalCount ? `구성 ${top.totalCount}개 중 ${top.riseCount}개 상승` : '오늘 등락률 1위 업종',
      why: '오늘 국내 시장에서 자금이 가장 몰린 업종입니다. ' + (top.leaders && top.leaders[0] ? `${top.leaders[0].name} 등이 주도하고 있습니다.` : '관련 테마의 흐름을 살펴볼 만합니다.')
    });
  }
  return cands.sort((a, b) => b.impact - a.impact);
}
function renderTopInsights() {
  const el = document.getElementById('top-insights');
  if (!el) return;
  const cands = buildInsightCandidates();
  if (!cands.length) {
    el.innerHTML = '<div class="loading">현재 지수·환율·뉴스에 두드러진 변동이 없어 평온한 장세입니다. 데이터가 모이면 핵심 이슈가 표시됩니다.</div>';
    return;
  }
  const top = cands.slice(0, 3);
  const catLabel = { macro: '거시 지표', news: '뉴스', sector: '업종' };
  let html = '<div class="ti-grid">';
  top.forEach((c, i) => {
    html += `<div class="ti-card${i === 0 ? ' rank1' : ''}">
      <div class="ti-card-top">
        <span class="ti-rank">${i === 0 ? '🥇 가장 주목' : i === 1 ? '🥈 2순위' : '🥉 3순위'}</span>
        <span class="ti-cat ${c.cat}" style="margin-left:auto">${catLabel[c.cat]}</span>
      </div>
      <div class="ti-card-title"><span class="ti-emoji">${c.emoji}</span><span>${esc(c.title)}</span></div>
      <div class="ti-metric">${esc(c.metric)}</div>
      <div class="ti-why">💬 ${esc(c.why)}</div>
    </div>`;
  });
  el.innerHTML = html + '</div>';
  stampAsof('ti-asof');
}

// ═════════════════════ 📊 오늘의 발견 (종목 랭킹·스크리너) ═════════════════════
// 네이버 금융 랭킹 API (검증됨): up=상승 / down=하락 / marketValue=시총. 코스피 기준.
const RANK_DEFS = {
  up:          { api: 'up',          reason: s => `오늘 +${s.chg.toFixed(1)}% 상승 상위 종목` },
  down:        { api: 'down',        reason: s => `오늘 ${s.chg.toFixed(1)}% 하락 상위 종목` },
  marketValue: { api: 'marketValue', reason: s => `시가총액 상위${s.mcap ? ' · ' + s.mcap : ''}` }
};
let discoveryCache = {};
let discoveryMode = 'up';
let screenerF = { minP: null, maxP: null, minC: null, maxC: null };
const numK = s => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };

async function fetchRanking(api, noCache) {
  if (!noCache && discoveryCache[api]) return discoveryCache[api];
  const url = 'https://m.stock.naver.com/api/stocks/' + api + '?page=1&pageSize=30';
  const j = await fetchViaProxy(url, false, o => o && Array.isArray(o.stocks));
  const out = (j.stocks || []).map(s => {
    const mkt = (s.stockExchangeType && s.stockExchangeType.code === 'KQ') ? 'KQ' : 'KS';
    return { code: s.itemCode, symbol: s.itemCode + '.' + mkt, name: s.stockName, price: numK(s.closePrice), chg: numK(s.fluctuationsRatio) || 0, mcap: s.marketValueHangeul || '' };
  }).filter(s => s.code && s.price != null);
  discoveryCache[api] = out;
  return out;
}

function diCard(s, reason) {
  const cls = s.chg > 0 ? 'up' : s.chg < 0 ? 'down' : 'flat';
  const added = watchlist.some(w => w.symbol === s.symbol);
  return `<div class="di-card" role="button" tabindex="0" data-sym="${esc(s.symbol)}" data-name="${esc(s.name)}" aria-label="${esc(s.name)} 관심종목에 추가">
    <div class="di-name">${esc(s.name)}${added ? ' <span class="di-added">✓ 추가됨</span>' : ''}</div>
    <div class="di-code">${esc(s.symbol)}</div>
    <div class="di-price">${fmtPrice(s.price, s.symbol)}</div>
    <div class="di-chg ${cls}">${s.chg >= 0 ? '▲ +' : '▼ '}${Math.abs(s.chg).toFixed(2)}%</div>
    <div class="di-reason">💡 ${esc(reason)}</div>
  </div>`;
}
function bindDiCards(root) {
  root.querySelectorAll('.di-card').forEach(c => {
    const add = () => quickAddStock(c.dataset.sym, c.dataset.name);
    c.onclick = add;
    c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } };
  });
}

async function renderDiscovery(mode, noCache) {
  if (mode) discoveryMode = mode;
  const el = document.getElementById('discovery-list');
  if (!el) return;
  document.querySelectorAll('#discovery-tabs button').forEach(b => {
    const on = b.dataset.rank === discoveryMode;
    b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (discoveryMode === 'screener') return renderScreener(noCache);
  el.innerHTML = '<div class="loading">종목 데이터를 분석하는 중…</div>';
  try {
    const def = RANK_DEFS[discoveryMode];
    const items = await fetchRanking(def.api, noCache);
    if (discoveryMode === 'screener') return; // 그 사이 탭 변경
    el.innerHTML = '<div class="discovery-grid">' + items.slice(0, 12).map(s => diCard(s, def.reason(s))).join('') + '</div>';
    bindDiCards(el);
    stampAsof('discovery-asof');
  } catch (e) {
    el.innerHTML = '<div class="loading">발견 데이터를 불러오지 못했습니다. <button class="retry-inline" onclick="renderDiscovery(null, true)">다시 시도</button></div>';
  }
}

function renderScreener(noCache) {
  const el = document.getElementById('discovery-list');
  if (!el) return;
  el.innerHTML = `<div class="screener-filter">
    <label>주가 ₩ <input type="number" id="scr-minp" placeholder="최소" value="${screenerF.minP == null ? '' : screenerF.minP}"> ~ <input type="number" id="scr-maxp" placeholder="최대" value="${screenerF.maxP == null ? '' : screenerF.maxP}"></label>
    <label>등락률 % <input type="number" id="scr-minc" placeholder="최소" value="${screenerF.minC == null ? '' : screenerF.minC}"> ~ <input type="number" id="scr-maxc" placeholder="최대" value="${screenerF.maxC == null ? '' : screenerF.maxC}"></label>
    <button class="screener-reset" id="scr-reset">초기화</button>
  </div><div id="scr-result"><div class="loading">시총 상위 종목을 불러오는 중…</div></div>`;
  ['scr-minp', 'scr-maxp', 'scr-minc', 'scr-maxc'].forEach(id => { const i = el.querySelector('#' + id); if (i) i.onchange = applyScreener; });
  el.querySelector('#scr-reset').onclick = () => { screenerF = { minP: null, maxP: null, minC: null, maxC: null }; renderScreener(); };
  fetchRanking('marketValue', noCache).then(applyScreener).catch(() => {
    const r = el.querySelector('#scr-result'); if (r) r.innerHTML = '<div class="loading">데이터 로드 실패 <button class="retry-inline" onclick="renderScreener(true)">다시 시도</button></div>';
  });
}
function applyScreener() {
  const el = document.getElementById('discovery-list'); if (!el) return;
  const g = id => { const i = el.querySelector('#' + id); const v = i ? parseFloat(i.value) : NaN; return isNaN(v) ? null : v; };
  screenerF = { minP: g('scr-minp'), maxP: g('scr-maxp'), minC: g('scr-minc'), maxC: g('scr-maxc') };
  const uni = discoveryCache['marketValue'] || [];
  const out = uni.filter(s =>
    (screenerF.minP == null || s.price >= screenerF.minP) &&
    (screenerF.maxP == null || s.price <= screenerF.maxP) &&
    (screenerF.minC == null || s.chg >= screenerF.minC) &&
    (screenerF.maxC == null || s.chg <= screenerF.maxC));
  const res = el.querySelector('#scr-result'); if (!res) return;
  res.innerHTML = out.length
    ? '<div class="discovery-grid">' + out.slice(0, 12).map(s => diCard(s, '시총상위 · 조건 충족')).join('') + '</div>'
    : '<div class="loading">조건에 맞는 종목이 없습니다. (유니버스: 코스피 시총 상위 30)</div>';
  bindDiCards(res);
  stampAsof('discovery-asof');
}

