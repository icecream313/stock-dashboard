// ═════════════════════ 종목 상세 모달 ═════════════════════
// 데이터: 네이버 증권 비공개 API (국내 m.stock.naver.com, 해외 api.stock.naver.com)
const NV_TTL = 6 * 60 * 60 * 1000; // 재무 데이터 캐시 6시간 (프록시 부하 최소화)

async function fetchNaver(url) {
  const key = 'nv:' + url;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch (e) {}
  if (cached && cached.d && Date.now() - cached.t < NV_TTL) return cached.d;
  try {
    const j = await fetchViaProxy(url, false);
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: j })); } catch (e) {}
    return j;
  } catch (e) {
    if (cached && cached.d) { noteStale(cached.t); return cached.d; } // 실패 시 마지막 캐시
    throw e;
  }
}

// 미국 티커 → 네이버 로이터 코드 (.O 나스닥 / .N NYSE / .A AMEX)
async function resolveReuters(ticker) {
  const map = JSON.parse(localStorage.getItem('reutersMap') || '{}');
  if (map[ticker]) return map[ticker];
  for (const suf of ['.O', '.N', '.A']) {
    try {
      const b = await fetchNaver('https://api.stock.naver.com/stock/' + ticker + suf + '/basic');
      if (b && b.reutersCode) {
        map[ticker] = b.reutersCode;
        localStorage.setItem('reutersMap', JSON.stringify(map));
        return b.reutersCode;
      }
    } catch (e) {}
  }
  throw new Error('종목 코드를 찾을 수 없습니다: ' + ticker);
}

async function loadDetailData(item) {
  if (isKorean(item.symbol)) {
    const code = item.symbol.split('.')[0];
    const base = 'https://m.stock.naver.com/api/stock/' + code;
    const [basic, integ, annual] = await Promise.all([
      fetchNaver(base + '/basic'),
      fetchNaver(base + '/integration'),
      fetchNaver(base + '/finance/annual')
    ]);
    let quarter = null;
    try { quarter = (await fetchNaver(base + '/finance/quarter')).financeInfo; } catch (e) {}
    const cs = annual.corporationSummary;
    return {
      kr: true, basic,
      infos: integ.totalInfos || [],
      consensus: integ.consensusInfo,
      annual: annual.financeInfo, quarter,
      cashflow: null, // 네이버 API 현금흐름 미지원 (HTTP 400) — buildCashflowHTML은 null 시 생략
      researches: integ.researches || [],
      profile: cs ? [cs.comment1, cs.comment2, cs.comment3].filter(Boolean).join(' ') : null,
      unit: '억원 · %, 배 생략',
      dealTrend: integ.dealTrendInfos || [],
      industryCompare: integ.industryCompareInfo || []
    };
  } else {
    const reuters = item.reuters || await resolveReuters(item.symbol);
    const base = 'https://api.stock.naver.com/stock/' + reuters;
    const [basic, integ, annual] = await Promise.all([
      fetchNaver(base + '/basic'),
      fetchNaver(base + '/integration'),
      fetchNaver(base + '/finance/annual')
    ]);
    let quarter = null;
    try { quarter = await fetchNaver(base + '/finance/quarter'); } catch (e) {}
    return {
      kr: false, basic,
      infos: basic.stockItemTotalInfos || [],
      consensus: integ.consensusInfo,
      annual, quarter,
      researches: [],
      profile: (integ.summaries && integ.summaries.summary) || null,
      unit: annual.unit || 'USD(백만) · %, 배 생략',
      dealTrend: [],                                   // 미국은 외인·기관 수급 미제공
      industryCompare: integ.industryCompareInfo || [] // 동종 업종 비교
    };
  }
}

// ── 파싱 헬퍼 ──
function infoVal(infos, key) {
  if (!Array.isArray(infos)) return null;
  const f = infos.find(x => x.key === key);
  return f ? f.value : null;
}
function numOf(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function finSeries(fin, title) {
  if (!fin || !fin.rowList) return [];
  const row = fin.rowList.find(r => r.title === title);
  if (!row) return [];
  return (fin.trTitleList || []).map(t => {
    const col = row.columns[t.key];
    return { label: t.title, est: t.isConsensus === 'Y', value: numOf(col && col.value) };
  });
}
// 컨센서스(추정치) 제외 마지막 실적값과 그 직전값
function lastActual(series) {
  const act = series.filter(s => !s.est && s.value != null);
  return { cur: act.length ? act[act.length - 1].value : null, prev: act.length > 1 ? act[act.length - 2].value : null };
}

// ── 모달 열기/닫기 ──
let detailItem = null;
let detailData = null;
const overlay = document.getElementById('detail-overlay');

// 상세 모달 탭 표시/숨김 (종목 vs 지수)
function setTabsVisible(keys) {
  document.querySelectorAll('#detail-tabs button').forEach(b =>
    b.style.display = keys.includes(b.dataset.tab) ? '' : 'none');
}

let lastFocusEl = null; // 모달 닫을 때 포커스 복원용
function focusModalSheet() {
  lastFocusEl = document.activeElement;
  const sheet = overlay.querySelector('.detail-sheet');
  setTimeout(() => { try { sheet.focus(); } catch (e) {} }, 50);
}

function openDetail(item) {
  if (item.isIndex) return openIndexDetail(item);
  detailItem = item;
  setTabsVisible(['summary', 'overview', 'fund', 'tech', 'future', 'news', 'buyscan']); // 종목: 전체 탭
  overlay.classList.add('open');
  focusModalSheet();
  document.body.style.overflow = 'hidden';
  // 헤더
  document.getElementById('d-name').textContent = item.name || item.symbol;
  document.getElementById('d-sub').textContent = item.symbol;
  const logo = document.getElementById('d-logo');
  logo.classList.add('hidden');
  const q = quoteCache[item.symbol];
  document.getElementById('d-price').textContent = q ? fmtPrice(q.price, item.symbol) : '';
  const dchg = document.getElementById('d-chg');
  if (q) {
    const c = chgInfo(q.price, q.prev);
    dchg.className = 'd-chg ' + c.cls;
    dchg.textContent = c.text;
  } else dchg.textContent = '';
  // 탭 초기화
  switchTab('summary');
  document.getElementById('tab-summary').innerHTML = '<div class="d-loading">6개 항목을 종합 분석하는 중…</div>';
  document.getElementById('tab-overview').innerHTML = '<div class="d-loading">기업 정보를 불러오는 중…</div>';
  document.getElementById('tab-fund').innerHTML = '<div class="d-loading">불러오는 중…</div>';
  document.getElementById('tab-future').innerHTML = '<div class="d-loading">불러오는 중…</div>';
  loadNews(document.getElementById('tab-news'), newsTargetFor(item));
  renderTechTab(item); // 기술 분석은 야후 데이터만 쓰므로 독립적으로 로드
  if (typeof clearBuyScanTabBadge === 'function') clearBuyScanTabBadge();
  renderBuyScanTab(item); // 기술적매수 탭 (캐시 있으면 즉시, 없으면 백그라운드 fetch)
  // 재무 데이터 로드 (네이버)
  detailData = null;
  loadDetailData(item).then(d => {
    if (detailItem !== item) return; // 그 사이 다른 종목을 열었으면 무시
    detailData = d;
    // 헤더 퀵뷰: 시총·PER·목표가 업사이드
    try {
      const mktCap = infoVal(d.infos, '시총');
      const per = infoVal(d.infos, 'PER');
      const tgt = d.consensus && numOf(d.consensus.priceTargetMean);
      const cur = quoteCache[item.symbol] && quoteCache[item.symbol].price;
      const qvParts = [item.symbol];
      if (mktCap && mktCap !== 'N/A') qvParts.push('시총 ' + mktCap);
      if (per && per !== 'N/A') qvParts.push('PER ' + per);
      if (tgt && cur) { const up = (tgt - cur) / cur * 100; qvParts.push('목표 ' + fmtPrice(tgt, item.symbol) + ' (' + (up >= 0 ? '+' : '') + up.toFixed(1) + '%)'); }
      document.getElementById('d-sub').textContent = qvParts.join(' · ');
    } catch (_) {}
    if (d.basic && d.basic.itemLogoPngUrl) {
      logo.src = d.basic.itemLogoPngUrl;
      logo.classList.remove('hidden');
      logo.onerror = () => logo.classList.add('hidden');
    }
    renderOverviewTab(d, item);
    renderFundTab(d, item);
    renderFutureTab(d, item);
    renderSummaryTab(d, item); // 종합 평가 (재무·기술·뉴스·거시·미시·업종)
  }).catch(e => {
    if (detailItem !== item) return;
    ['tab-summary', 'tab-overview', 'tab-fund', 'tab-future'].forEach(id => {
      const el = document.getElementById(id);
      el.innerHTML = '<div class="d-loading">기업 정보를 불러오지 못했습니다.<br>무료 데이터 경유 서버가 일시적으로 느릴 수 있습니다.<br><br><button class="retry-btn">다시 시도</button></div>';
      el.querySelector('.retry-btn').onclick = () => openDetail(item);
    });
  });
}

function closeDetail() {
  detailItem = null;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  ['summary', 'fund', 'tech', 'news'].forEach(tab => {
    const el = document.getElementById('tbadge-' + tab);
    if (el) { el.textContent = ''; el.className = 'tab-score-badge'; }
  });
  if (lastFocusEl && lastFocusEl.offsetParent !== null) { try { lastFocusEl.focus(); } catch (e) {} }
}

// ── 지수/거시지표 상세 (종목 모달 재사용, 탭 = 개요·기술·뉴스) ──
function openIndexDetail(item) {
  detailItem = item;
  detailData = null;
  setTabsVisible(['overview', 'tech', 'news']);
  overlay.classList.add('open');
  focusModalSheet();
  document.body.style.overflow = 'hidden';
  document.getElementById('d-logo').classList.add('hidden');
  document.getElementById('d-name').textContent = item.name;
  document.getElementById('d-sub').textContent = item.naver ? '주가지수' : '시장지표';
  const md = macroData[item.symbol];
  const priceEl = document.getElementById('d-price'), dchg = document.getElementById('d-chg');
  if (md && md.price != null) {
    priceEl.textContent = item.fmt === 'pct' ? md.price.toFixed(2) + '%' : fmtPrice(md.price, item.symbol, item.fmt);
    const c = chgInfo(md.price, md.prev);
    dchg.className = 'd-chg ' + c.cls; dchg.textContent = c.text;
  } else { priceEl.textContent = ''; dchg.textContent = ''; }
  switchTab('overview');
  document.getElementById('tab-overview').innerHTML = '<div class="d-loading">지수 정보를 불러오는 중…</div>';
  loadNews(document.getElementById('tab-news'), newsTargetFor(item));
  renderTechTab(item);          // 차트 + 과열 분석 (야후 데이터)
  renderIndexOverview(item);    // 지표 + 시장폭 + 수급
}

async function renderIndexOverview(item) {
  const el = document.getElementById('tab-overview');
  let html = '';
  // ① 과열도 헤드라인 (야후 5년 일봉)
  try {
    const r = await fetchChart(item.symbol, '5y', '1d');
    if (detailItem !== item) return;
    const closes = (r.indicators.quote[0].close || []).filter(v => v != null);
    const sc = overheatScore(overheatSnapshot(closes));
    if (sc) {
      const cls = sc.level === 'hot' ? 'bad' : sc.level === 'warm' ? 'mid' : sc.level === 'cool' ? 'down' : 'mid';
      const lvl = sc.level === 'hot' ? '과열권' : sc.level === 'warm' ? '다소 과열' : sc.level === 'cool' ? '침체권' : '중립';
      html += `<div class="overheat-card"><div class="overheat-head"><span class="overheat-verdict ${cls}">🌡️ 시장 과열도 ${sc.score}점 / 100 · ${lvl}</span><span class="overheat-sub">RSI·이격도·52주위치·변동성을 과거 분포와 비교 · 자세히는 '기술' 탭</span></div></div>`;
    }
  } catch (e) {}
  // ② 네이버 지수 상세 (코스피·코스닥 전용 — 시장폭·수급·52주)
  if (item.naver) {
    try {
      const j = await fetchNaver('https://m.stock.naver.com/api/index/' + item.naver + '/integration');
      if (detailItem !== item) return;
      const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; };
      // 시장 폭
      const ud = j.upDownStockInfo;
      if (ud) {
        const rise = num(ud.riseCount), fall = num(ud.fallCount), flat = num(ud.steadyCount);
        const upper = num(ud.upperCount), lower = num(ud.lowerCount);
        const tot = rise + fall || 1, riseP = rise / tot * 100;
        const cls = riseP >= 70 ? 'good' : riseP <= 30 ? 'bad' : 'mid';
        const psy = Math.round(riseP); // 단순 당일 상승비율 (투자심리선은 시계열 필요 → 당일치만)
        html += `<div class="hf-title" style="font-size:0.92rem">📊 시장 폭 — 오른 종목 vs 내린 종목</div>
          <div class="breadth-bar"><div class="breadth-up" style="width:${riseP.toFixed(0)}%">▲ ${rise.toLocaleString()}</div><div class="breadth-down" style="width:${(100 - riseP).toFixed(0)}%">${fall.toLocaleString()} ▼</div></div>
          <div class="oh-metric-note">상승 ${rise.toLocaleString()} · 하락 ${fall.toLocaleString()} · 보합 ${flat.toLocaleString()}${upper ? ` · 상한가 ${upper}` : ''}${lower ? ` · 하한가 ${lower}` : ''} — 상승 비율 <b class="${cls}">${riseP.toFixed(0)}%</b>. 지수는 올랐는데 오른 종목이 더 적다면, 소수 대형주만 끌어올린 양극화일 수 있어 시장이 취약해진 신호입니다.</div>`;
      }
      // 투자자별 수급 (지수 integration의 dealTrendInfo는 배열이 아닌 단일 객체)
      const dt = Array.isArray(j.dealTrendInfo) ? j.dealTrendInfo[0] : j.dealTrendInfo;
      if (dt) {
        const flow = v => { const n = numOf(v); if (n == null) return '<span class="flat">—</span>'; const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat'; return `<span class="${cls}">${n >= 0 ? '순매수 +' : '순매도 '}${n.toLocaleString('ko-KR')}</span>`; };
        html += `<div class="hf-title" style="font-size:0.92rem;margin-top:16px">💧 투자자별 매매 동향 (당일${dt.bizdate ? ' ' + dt.bizdate.slice(4, 6) + '/' + dt.bizdate.slice(6, 8) : ''})</div><div class="metric-grid">
          <div class="metric"><div class="k">개인</div><div class="v" style="font-size:0.9rem">${flow(dt.personalValue)}</div></div>
          <div class="metric"><div class="k">외국인</div><div class="v" style="font-size:0.9rem">${flow(dt.foreignValue)}</div></div>
          <div class="metric"><div class="k">기관</div><div class="v" style="font-size:0.9rem">${flow(dt.institutionalValue)}</div></div></div>
          <div class="oh-metric-note">외국인·기관이 함께 순매수면 수급이 우호적, 함께 순매도면 부담입니다. (단위는 네이버 원자료 기준)</div>`;
      }
      // 52주 범위
      const hi = numOf(infoVal(j.totalInfos, '52주 최고')), lo = numOf(infoVal(j.totalInfos, '52주 최저'));
      const cur = macroData[item.symbol] && macroData[item.symbol].price;
      if (hi && lo && cur && hi > lo) {
        const pos = Math.min(100, Math.max(0, (cur - lo) / (hi - lo) * 100));
        html += `<div class="band-wrap" style="margin-top:16px"><div class="band-title">52주 범위 내 현재 위치 — <b>${pos.toFixed(0)}%</b></div>
          <div class="band-bar"><div class="band-cursor" style="left:${pos}%"></div></div>
          <div class="band-labels"><span>최저 ${lo.toLocaleString('ko-KR')}</span><span>최고 ${hi.toLocaleString('ko-KR')}</span></div></div>`;
      }
    } catch (e) {}
  } else {
    html += `<div class="oh-metric-note" style="margin-top:6px">ℹ️ 시장 폭·수급 데이터는 코스피·코스닥에서만 제공됩니다. 이 지표는 '기술' 탭의 차트와 과열 분석을 참고하세요.</div>`;
  }
  if (detailItem !== item) return;
  el.innerHTML = html || '<div class="d-loading">추가 정보가 없습니다. \'기술\' 탭의 차트·과열 분석을 참고하세요.</div>';
}
document.getElementById('d-close').onclick = closeDetail;
overlay.addEventListener('click', e => { if (e.target === overlay) closeDetail(); });
document.addEventListener('keydown', e => {
  if (!overlay.classList.contains('open')) return;
  if (e.key === 'Escape') { closeDetail(); return; }
  if (e.key === 'Tab') { // 포커스 트랩 — 모달 밖으로 못 나가게
    const list = [...overlay.querySelectorAll('button, [tabindex="0"], input, select, textarea, a[href]')].filter(el => el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function switchTab(name) {
  document.querySelectorAll('#detail-tabs button').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.d-tab').forEach(t =>
    t.hidden = (t.id !== 'tab-' + name));
  // 숨겨진 상태에선 캔버스 크기가 0이라, 해당 탭이 보일 때 차트를 다시 그린다
  if (name === 'fund' && detailData && document.getElementById('fin-chart')) drawFinance(detailData);
  if (name === 'tech') drawTechChart();
  if (name === 'buyscan' && detailItem) renderBuyScanTab(detailItem);
}
document.getElementById('detail-tabs').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) switchTab(b.dataset.tab);
});

// ── ① 개요 탭 ──
function renderOverviewTab(d, item) {
  const el = document.getElementById('tab-overview');
  const keys = d.kr
    ? ['시총', 'PER', '추정PER', 'PBR', 'EPS', 'BPS', '배당수익률', '주당배당금', '외인소진율', '거래량']
    : ['시총', '업종', 'PER', 'PBR', 'EPS', 'BPS', '배당수익률', '주당배당금', '배당일', '거래량'];
  let html = '<div class="metric-grid">';
  keys.forEach(k => {
    const v = infoVal(d.infos, k);
    if (v && v !== 'N/A') html += `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  });
  html += '</div>';
  // 52주 밴드
  const high = numOf(infoVal(d.infos, '52주 최고'));
  const low = numOf(infoVal(d.infos, '52주 최저'));
  const cur = quoteCache[item.symbol] ? quoteCache[item.symbol].price : numOf(infoVal(d.infos, '전일'));
  if (high && low && cur && high > low) {
    const pos = Math.min(100, Math.max(0, (cur - low) / (high - low) * 100));
    const toHigh = (high - cur) / cur * 100, fromLow = (cur - low) / low * 100;
    html += `<div class="band-wrap">
      <div class="band-title">52주 가격 범위 내 현재 위치 — <b>${pos.toFixed(0)}%</b> 지점</div>
      <div class="band-bar"><div class="band-cursor" style="left:${pos}%"></div></div>
      <div class="band-labels"><span>최저 ${fmtPrice(low, item.symbol)}</span><span>최고 ${fmtPrice(high, item.symbol)}</span></div>
      <div class="oh-metric-note" style="margin-top:8px">고가까지 <b class="up">+${toHigh.toFixed(1)}%</b> 여력 · 저가 대비 <b class="down">+${fromLow.toFixed(1)}%</b> 상승. ${pos >= 90 ? '신고가 부근 — 단기 과열 가능성을 함께 보세요.' : pos <= 15 ? '신저가 부근 — 반등·추가하락 여부를 함께 보세요.' : '범위 중간대입니다.'}</div>
    </div>`;
  }
  // 투자자별 수급 추세 (국내 — 최근 5거래일 외국인·기관·개인)
  html += supplyTrendHTML(d);
  // 배당 이력 (야후 비동기 — 자리만)
  html += `<div id="ov-dividends"></div>`;
  // 내 보유 정보 입력 (수량·평단가 → 카드와 상단 요약에 손익 표시)
  const unit = isKorean(item.symbol) ? '원' : '$';
  html += `<div class="holding-form" style="margin-top:14px">
    <div class="hf-title">💼 내 보유 정보 <span style="color:var(--muted);font-weight:400">— 입력하면 카드와 대시보드 상단에 평가손익이 표시됩니다 (이 기기에만 저장)</span></div>
    <div class="hf-row">
      <input id="hf-qty" type="number" min="0" step="any" placeholder="보유 수량 (주)" value="${item.qty || ''}">
      <input id="hf-avg" type="number" min="0" step="any" placeholder="평균단가 (${unit})" value="${item.avg || ''}">
      <button id="hf-save">저장</button>
      ${item.qty ? '<button class="hf-del" id="hf-del">보유 삭제</button>' : ''}
    </div>
    <div class="hf-result" id="hf-result"></div>
    <div id="hf-sim"></div>
  </div>`;
  el.innerHTML = html;
  fillDividends(item);       // 배당 이력 (야후 비동기)
  renderSimulator(el, item); // 손절·익절 시뮬레이터 (보유 시)
  // 보유 폼 이벤트
  const showPL = () => {
    const pl = holdingPL(item);
    const box = el.querySelector('#hf-result');
    if (!pl) { box.textContent = ''; return; }
    const cls = pl.diff > 0 ? 'up' : pl.diff < 0 ? 'down' : 'flat';
    box.innerHTML = `평가금액 <b>${fmtPrice(pl.value, item.symbol)}</b> · 손익 <b class="${cls}">${pl.diff >= 0 ? '+' : ''}${fmtPrice(pl.diff, item.symbol)} (${pl.pct >= 0 ? '+' : ''}${pl.pct.toFixed(2)}%)</b>`;
  };
  showPL();
  el.querySelector('#hf-save').onclick = () => {
    const qty = parseFloat(el.querySelector('#hf-qty').value);
    const avg = parseFloat(el.querySelector('#hf-avg').value);
    if (!qty || !avg || qty <= 0 || avg <= 0) { alert('수량과 평균단가를 올바르게 입력해 주세요.'); return; }
    item.qty = qty;
    item.avg = avg;
    saveList();
    showPL();
    const card = document.querySelector(`.card[data-symbol="${CSS.escape(item.symbol)}"]`);
    if (card) fillHoldingLine(card, item);
    updatePortfolio();
    renderOverviewTab(d, item); // 삭제 버튼 갱신
  };
  const delBtn = el.querySelector('#hf-del');
  if (delBtn) delBtn.onclick = () => {
    delete item.qty;
    delete item.avg;
    saveList();
    const card = document.querySelector(`.card[data-symbol="${CSS.escape(item.symbol)}"]`);
    if (card) fillHoldingLine(card, item);
    updatePortfolio();
    renderOverviewTab(d, item);
  };
}

// ── 투자자별 수급 추세 (국내 — 최근 5거래일) ──
function supplyTrendHTML(d) {
  const dt = (d.dealTrend || []).slice(0, 5);
  if (!dt.length) return '';
  const num = s => { const n = parseFloat(String(s || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
  const days = [...dt].reverse(); // 과거 → 최신
  const rows = [['외국인', 'foreignerPureBuyQuant'], ['기관', 'organPureBuyQuant'], ['개인', 'individualPureBuyQuant']];
  let h = `<div class="hf-title" style="font-size:0.92rem;margin-top:16px">💧 투자자별 수급 추세 <span style="color:var(--muted);font-weight:400">— 최근 ${dt.length}거래일 순매수(주)</span></div>`;
  h += `<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>투자자</th>`;
  days.forEach(x => { const b = x.bizdate || ''; h += `<th>${b.slice(4, 6)}/${b.slice(6, 8)}</th>`; });
  h += `<th>5일 합</th></tr></thead><tbody>`;
  rows.forEach(([label, key]) => {
    let sum = 0;
    h += `<tr><td>${label}</td>`;
    days.forEach(x => { const v = num(x[key]); sum += v; const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; h += `<td class="${cls}">${v >= 0 ? '+' : ''}${fmtNum(v)}</td>`; });
    const scls = sum > 0 ? 'up' : sum < 0 ? 'down' : 'flat';
    h += `<td class="${scls}"><b>${sum >= 0 ? '+' : ''}${fmtNum(sum)}</b></td></tr>`;
  });
  h += `</tbody></table></div><div class="unit-note">외국인·기관이 함께 순매수(빨강)면 수급 우호, 함께 순매도(파랑)면 부담. 개인은 보통 반대 방향입니다.</div>`;
  return h;
}

// ── 배당 이력 (야후 chart events=div, 비동기) ──
async function fillDividends(item) {
  const zone = document.getElementById('ov-dividends');
  if (!zone || item.isIndex) return;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=5y&interval=1d&events=div`;
    const json = await fetchViaProxy(url, false);
    if (detailItem !== item) return;
    const ev = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].events && json.chart.result[0].events.dividends;
    if (!ev) return;
    const divs = Object.values(ev).map(x => ({ amount: x.amount, date: new Date(x.date * 1000) })).sort((a, b) => b.date - a.date);
    if (!divs.length) return;
    const ttm = divs.filter(x => x.date.getTime() >= Date.now() - 365 * 864e5).reduce((a, x) => a + x.amount, 0);
    const cur = quoteCache[item.symbol] && quoteCache[item.symbol].price;
    const yld = (ttm && cur) ? ttm / cur * 100 : null;
    let h = `<div class="hf-title" style="font-size:0.92rem;margin-top:16px">💰 배당 이력 <span style="color:var(--muted);font-weight:400">— 최근 지급 내역${yld ? ` · 최근 1년 합산 수익률 약 ${yld.toFixed(2)}%` : ''}</span></div><div class="metric-grid">`;
    divs.slice(0, 6).forEach(x => { h += `<div class="metric"><div class="k">${x.date.getFullYear()}.${String(x.date.getMonth() + 1).padStart(2, '0')}</div><div class="v">${fmtPrice(x.amount, item.symbol)}</div></div>`; });
    h += `</div><div class="unit-note">배당락일 기준 과거 지급액입니다. 미래 배당은 보장되지 않습니다.</div>`;
    zone.innerHTML = h;
  } catch (e) {}
}

// ── 손절·익절 시뮬레이터 (보유 시) ──
function renderSimulator(el, item) {
  const zone = el.querySelector('#hf-sim');
  if (!zone) return;
  if (!item.qty || !item.avg) { zone.innerHTML = ''; return; }
  const tp = getWatchlistAlerts()[item.symbol] || '';
  zone.innerHTML = `<div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border)">
    <div class="hf-title" style="font-size:0.85rem">🎯 손절·익절 시뮬레이터 <span style="color:var(--muted);font-weight:400">— ${item.qty.toLocaleString()}주 · 평단 ${fmtPrice(item.avg, item.symbol)}</span></div>
    <div class="hf-row">
      <input id="sim-tp" type="number" min="0" step="any" placeholder="익절 목표가" value="${tp}" aria-label="익절 목표가">
      <input id="sim-sl" type="number" min="0" step="any" placeholder="손절가" aria-label="손절가">
    </div>
    <div id="sim-out" class="hf-result"></div></div>`;
  const tpI = zone.querySelector('#sim-tp'), slI = zone.querySelector('#sim-sl'), out = zone.querySelector('#sim-out');
  const calc = () => {
    const lines = [], tpv = parseFloat(tpI.value), slv = parseFloat(slI.value);
    if (tpv > 0) { const g = (tpv - item.avg) * item.qty, p = (tpv - item.avg) / item.avg * 100; lines.push(`익절 시 <b class="up">${g >= 0 ? '+' : ''}${fmtPrice(g, item.symbol)} (${p >= 0 ? '+' : ''}${p.toFixed(1)}%)</b>`); }
    if (slv > 0) { const g = (slv - item.avg) * item.qty, p = (slv - item.avg) / item.avg * 100; lines.push(`손절 시 <b class="down">${fmtPrice(g, item.symbol)} (${p.toFixed(1)}%)</b>`); }
    if (tpv > 0 && slv > 0 && item.avg > slv) { const rr = (tpv - item.avg) / (item.avg - slv); lines.push(`손익비 <b>${rr.toFixed(2)} : 1</b> ${rr >= 2 ? '(양호)' : rr >= 1 ? '(보통)' : '(불리 — 손실폭이 더 큼)'}`); }
    out.innerHTML = lines.join(' · ') || '<span style="color:var(--muted)">익절·손절가를 입력하면 예상 손익이 계산됩니다.</span>';
  };
  tpI.oninput = calc; slI.oninput = calc; calc();
}

// ── 리스크 지표 (베타·연변동성·최대낙폭 MDD) ──
function riskFromBars(bars) {
  const closes = bars.map(b => b.close).filter(v => v != null);
  if (closes.length < 30) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  const volAnnual = Math.sqrt(variance) * Math.sqrt(252) * 100;
  // 최대낙폭(MDD)
  let peak = closes[0], mdd = 0;
  closes.forEach(c => { if (c > peak) peak = c; const dd = (c - peak) / peak; if (dd < mdd) mdd = dd; });
  return { volAnnual, mdd: mdd * 100, rets };
}
async function fillRiskMetrics(item) {
  const zone = document.getElementById('tech-risk');
  if (!zone || !techState || techState.item !== item) return;
  const r = riskFromBars(techState.bars.slice(-252)); // 최근 1년
  if (!r) return;
  // 베타: 지수 수익률과 공분산 (KR=코스피, 그 외=S&P500)
  let beta = null;
  try {
    const idxSym = isKorean(item.symbol) ? '^KS11' : '^GSPC';
    const ir = await fetchChart(idxSym, '1y', '1d');
    const ic = (ir.indicators.quote[0].close || []).filter(v => v != null);
    const iret = []; for (let i = 1; i < ic.length; i++) iret.push(ic[i] / ic[i - 1] - 1);
    const n = Math.min(r.rets.length, iret.length);
    const sR = r.rets.slice(-n), iR = iret.slice(-n);
    const sM = sR.reduce((a, b) => a + b, 0) / n, iM = iR.reduce((a, b) => a + b, 0) / n;
    let cov = 0, ivar = 0;
    for (let i = 0; i < n; i++) { cov += (sR[i] - sM) * (iR[i] - iM); ivar += (iR[i] - iM) ** 2; }
    if (ivar > 0) beta = cov / ivar;
  } catch (e) {}
  if (detailItem !== item) return;
  const volCls = r.volAnnual > 45 ? 'bad' : r.volAnnual > 25 ? 'mid' : 'good';
  const mddCls = r.mdd < -40 ? 'bad' : r.mdd < -25 ? 'mid' : 'good';
  const betaCls = beta == null ? '' : beta > 1.3 ? 'bad' : beta > 0.8 ? 'mid' : 'good';
  zone.innerHTML = `<div class="hf-title" style="font-size:0.92rem;margin-top:18px">⚖️ 리스크 지표 <span style="color:var(--muted);font-weight:400">— 최근 1년 일봉 기준</span></div>
    <div class="metric-grid">
      <div class="metric"><div class="k">연 변동성</div><div class="v ${volCls}">${r.volAnnual.toFixed(1)}%</div></div>
      <div class="metric"><div class="k">최대낙폭 (MDD)</div><div class="v ${mddCls}">${r.mdd.toFixed(1)}%</div></div>
      <div class="metric"><div class="k">베타 (vs ${isKorean(item.symbol) ? '코스피' : 'S&P500'})</div><div class="v ${betaCls}">${beta == null ? '—' : beta.toFixed(2)}</div></div>
    </div>
    <div class="unit-note">변동성↑·MDD가 클수록 가격 출렁임이 큽니다. 베타 1 초과면 지수보다 더 민감하게 움직입니다. <b>최대낙폭은 1년 내 고점에서 최대 ${Math.abs(r.mdd).toFixed(0)}% 하락한 적이 있다는 뜻</b>으로, 하락장 감내 수준을 가늠하는 지표입니다.</div>`;
}

// ── 동종업계 비교 표 (industryCompareInfo) ──
function peerCompareHTML(d, item) {
  const peers = (d.industryCompare || []).slice(0, 8);
  if (!peers.length) return '';
  const num = s => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  let h = `<div class="fund-divider">🏭 동종업계 비교 <span style="font-weight:400;font-size:0.76rem;color:var(--muted)">— 같은 업종 주요 종목의 당일 등락</span></div>`;
  h += `<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>종목</th><th>현재가</th><th>등락률</th></tr></thead><tbody>`;
  peers.forEach(p => {
    const chg = num(p.fluctuationsRatio);
    const cls = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
    h += `<tr><td>${esc(p.stockName || '')}</td><td>${esc(p.closePrice || '—')}</td><td class="${cls}">${chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '—'}</td></tr>`;
  });
  h += `</tbody></table></div><div class="unit-note">같은 업종 내 상대 비교입니다. 내 종목이 동종 대비 부진한지/우위인지 가늠하는 데 참고하세요.</div>`;
  return h;
}

// ── ② 재무 분석 탭 (가이던스 + 투자적합도 + 실적·재무제표 통합) ──
// 컨센서스 추정치 sanity 가드 — 네이버 원본에 간혹 비현실적인 (E)값이 섞임
// (예: 삼성전자 2026E 영업이익률 51%처럼 직전 대비 비정상 급등). 종합점수에서도 재사용.
function estimateAnomaly(d) {
  const opTitle = d.kr ? '영업이익' : '영업이익';
  const revS = finSeries(d.annual, '매출액');
  const opS = finSeries(d.annual, opTitle);
  const estRev = revS.find(x => x.est && x.value != null);
  const estOp = opS.find(x => x.est && x.value != null);
  const actRev = [...revS].reverse().find(x => !x.est && x.value != null);
  const actOp = [...opS].reverse().find(x => !x.est && x.value != null);
  if (!estRev || !estOp || !actRev || !actOp || !estRev.value || !actRev.value) return false;
  const estMargin = estOp.value / estRev.value * 100;
  const actMargin = actOp.value / actRev.value * 100;
  // 추정 영업이익률이 직전 대비 +20%p 초과 급등 또는 절대 45% 초과면 데이터 이상치로 간주
  return (estMargin - actMargin > 20) || estMargin > 45;
}

// 다음 가이던스: 증권사 컨센서스 추정 실적·EPS·목표주가·투자의견 요약 카드
function buildGuidanceHTML(d, item) {
  const cur = quoteCache[item.symbol] && quoteCache[item.symbol].price;
  const fmtG = v => v == null ? '—' : v.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  const fwdTitles = d.kr ? ['매출액', '영업이익', '당기순이익'] : ['매출액', '당기순이익'];
  const rows = [];
  let estLabel = '';
  fwdTitles.forEach(title => {
    const s = finSeries(d.annual, title);
    const est = s.filter(x => x.est && x.value != null);
    const act = s.filter(x => !x.est && x.value != null);
    if (est.length && act.length && act[act.length - 1].value !== 0) {
      estLabel = est[0].label;
      const base = act[act.length - 1].value;
      rows.push({ title, est: est[0].value, g: (est[0].value - base) / Math.abs(base) * 100 });
    }
  });
  const fper = infoVal(d.infos, '추정PER'), feps = infoVal(d.infos, '추정EPS');
  const target = d.consensus && numOf(d.consensus.priceTargetMean);
  const rec = d.consensus && numOf(d.consensus.recommMean);
  if (!rows.length && !fper && !target && !rec) return ''; // 가이던스 데이터 없으면 섹션 숨김
  const anomaly = rows.length && estimateAnomaly(d);
  let h = `<div class="fund-divider" style="border-top:none;padding-top:0;margin-top:0">🔮 다음 가이던스 <span style="font-weight:400;font-size:0.76rem;color:var(--muted)">— 증권사 컨센서스 추정${estLabel ? ' (' + esc(estLabel) + ')' : ''}</span></div>`;
  if (anomaly) h += `<div class="disclaimer" style="margin-top:0;margin-bottom:12px;background:rgba(231,76,60,0.08);border-color:rgba(231,76,60,0.3)">⚠️ 이 종목은 네이버 컨센서스 <b>원본 추정값에 이상치(비현실적 이익률 등)가 포함</b>되어 있습니다. 아래 추정 실적은 신뢰도가 낮으니 목표주가·투자의견 위주로 참고하세요.</div>`;
  h += '<div class="metric-grid">';
  rows.forEach(r => {
    const cls = anomaly ? 'flat' : r.g > 0 ? 'up' : r.g < 0 ? 'down' : 'flat';
    h += `<div class="metric"><div class="k">${r.title} 추정${anomaly ? ' ⚠️' : ''}</div><div class="v">${fmtG(r.est)} <span style="font-size:0.76rem" class="${cls}">${r.g >= 0 ? '+' : ''}${r.g.toFixed(1)}%</span></div></div>`;
  });
  if (fper) h += `<div class="metric"><div class="k">추정 PER (선행)</div><div class="v">${esc(fper)}</div></div>`;
  if (feps) h += `<div class="metric"><div class="k">추정 EPS</div><div class="v">${esc(feps)}</div></div>`;
  if (target) {
    const up = cur ? (target - cur) / cur * 100 : null;
    h += `<div class="metric"><div class="k">목표주가 평균</div><div class="v">${fmtPrice(target, item.symbol)}${up != null ? ` <span style="font-size:0.76rem" class="${up >= 0 ? 'up' : 'down'}">${up >= 0 ? '+' : ''}${up.toFixed(1)}%</span>` : ''}</div></div>`;
  }
  if (rec) {
    const txt = rec >= 4.5 ? '적극매수' : rec >= 3.5 ? '매수' : rec >= 2.5 ? '중립' : rec >= 1.5 ? '매도' : '적극매도';
    h += `<div class="metric"><div class="k">투자의견</div><div class="v">${txt} <span style="font-size:0.76rem;color:var(--muted)">${rec.toFixed(2)}/5</span></div></div>`;
  }
  h += '</div>';
  if (rows.length) h += `<div class="unit-note">추정 실적 단위: ${d.unit} · 컨센서스는 증권사 추정 평균으로 수시 변경됩니다.</div>`;
  return h;
}

function buildCashflowHTML(d) {
  if (!d.cashflow) return '';
  const CF_MAIN = ['영업활동현금흐름', '투자활동현금흐름', '재무활동현금흐름'];
  const CAPEX_KEY = '설비투자';
  const rows = CF_MAIN.map(t => ({ title: t, data: finSeries(d.cashflow, t) })).filter(r => r.data.some(x => x.value != null));
  if (!rows.length) return '';
  const cols = (d.cashflow.trTitleList || []).filter(c => c.isConsensus !== 'Y');
  if (!cols.length) return '';
  const opCF = finSeries(d.cashflow, '영업활동현금흐름');
  const capexSeries = finSeries(d.cashflow, CAPEX_KEY);
  const hasFCF = opCF.some(x => x.value != null) && capexSeries.some(x => x.value != null);
  let h = `<div class="fund-divider">💵 현금흐름표 <span style="font-weight:400;font-size:0.76rem;color:var(--muted)">— 영업·투자·재무CF · 단위: 억원</span></div>`;
  h += `<div class="fin-table-wrap"><table class="fin-table"><thead><tr><th>항목</th>`;
  cols.forEach(c => { h += `<th>${c.title}</th>`; });
  h += `</tr></thead><tbody>`;
  rows.forEach(r => {
    h += `<tr><td>${r.title}</td>`;
    cols.forEach(c => {
      const it = r.data.find(x => x.label === c.title);
      const v = it ? it.value : null;
      if (v == null) { h += `<td>—</td>`; return; }
      const cls = v > 0 ? 'up' : v < 0 ? 'down' : '';
      h += `<td class="${cls}">${fmtNum(v)}</td>`;
    });
    h += `</tr>`;
  });
  if (hasFCF) {
    h += `<tr><td><b>잉여현금흐름 (FCF)</b></td>`;
    cols.forEach(c => {
      const op = opCF.find(x => x.label === c.title);
      const cx = capexSeries.find(x => x.label === c.title);
      if (!op || op.value == null) { h += `<td>—</td>`; return; }
      const fcf = op.value - (cx && cx.value != null ? Math.abs(cx.value) : 0);
      const cls = fcf > 0 ? 'good' : fcf < 0 ? 'bad' : '';
      h += `<td class="${cls}"><b>${fmtNum(fcf)}</b></td>`;
    });
    h += `</tr>`;
  }
  h += `</tbody></table></div>`;
  h += `<div class="unit-note">영업CF &gt; 0 지속 + FCF &gt; 0 = 실질 현금 창출. 투자CF 음수는 설비투자 활발한 것으로 성장주에선 정상입니다.</div>`;
  return h;
}

let finPeriod = 'annual';
function renderFundTab(d, item) {
  const el = document.getElementById('tab-fund');
  finPeriod = 'annual';
  let html = buildGuidanceHTML(d, item) + buildFitHTML(d, item);
  html += '<div class="fund-divider">📊 실적·재무제표</div>';
  html += '<div class="fin-toggle"><button data-p="annual" class="active">연간</button>';
  if (d.quarter) html += '<button data-p="quarter">분기</button>';
  html += '</div><canvas class="fin-chart" id="fin-chart"></canvas><div class="fin-legend" id="fin-legend"></div>';
  html += '<div class="fin-table-wrap" id="fin-table-wrap"></div><div class="unit-note">단위: ' + d.unit + ' · (E)는 컨센서스 추정치</div>';
  html += peerCompareHTML(d, item);
  html += buildCashflowHTML(d);
  el.innerHTML = html;
  el.querySelector('.fin-toggle').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    finPeriod = b.dataset.p;
    el.querySelectorAll('.fin-toggle button').forEach(x => x.classList.toggle('active', x === b));
    drawFinance(d);
  });
  drawFinance(d);
}

function drawFinance(d) {
  const fin = finPeriod === 'quarter' && d.quarter ? d.quarter : d.annual;
  // 막대 차트: 매출액 + 이익 2종
  const serieDefs = d.kr
    ? [{ t: '매출액', c: '#4f8cff' }, { t: '영업이익', c: '#38c79a' }, { t: '당기순이익', c: '#b08cff' }]
    : [{ t: '매출액', c: '#4f8cff' }, { t: 'EBIT', c: '#38c79a' }, { t: '당기순이익', c: '#b08cff' }];
  const series = serieDefs.map(s => ({ ...s, data: finSeries(fin, s.t) })).filter(s => s.data.some(x => x.value != null));
  drawFinChart(document.getElementById('fin-chart'), series);
  document.getElementById('fin-legend').innerHTML = series.map(s =>
    `<span><span class="dot" style="background:${s.c}"></span>${s.t}</span>`).join('');
  // 전체 표
  let t = '<table class="fin-table"><thead><tr><th>항목</th>';
  (fin.trTitleList || []).forEach(c => { t += `<th>${c.title}${c.isConsensus === 'Y' ? ' (E)' : ''}</th>`; });
  t += '</tr></thead><tbody>';
  (fin.rowList || []).forEach(r => {
    t += `<tr><td>${r.title}</td>`;
    (fin.trTitleList || []).forEach(c => {
      const col = r.columns[c.key];
      t += `<td>${col && col.value != null ? col.value : '-'}</td>`;
    });
    t += '</tr>';
  });
  t += '</tbody></table>';
  document.getElementById('fin-table-wrap').innerHTML = t;
}

function drawFinChart(canvas, series) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!series.length) return;
  const labels = series[0].data.map(x => x.label);
  const all = series.flatMap(s => s.data.map(x => x.value)).filter(v => v != null);
  if (!all.length) return;
  const maxV = Math.max(...all, 0), minV = Math.min(...all, 0);
  const span = (maxV - minV) || 1;
  const padT = 16, padB = 34, plotH = h - padT - padB;
  const y = v => padT + (maxV - v) / span * plotH;
  const groupW = w / labels.length;
  const barW = Math.min(22, (groupW - 24) / series.length);
  // 0 기준선
  ctx.strokeStyle = '#2a2e3a';
  ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(w, y(0)); ctx.stroke();
  labels.forEach((lab, i) => {
    const cx = groupW * i + groupW / 2;
    series.forEach((s, si) => {
      const v = s.data[i] ? s.data[i].value : null;
      if (v == null) return;
      const x = cx - (series.length * barW) / 2 + si * barW;
      ctx.fillStyle = s.c + (s.data[i].est ? '77' : '');
      const y0 = y(0), y1 = y(v);
      ctx.fillRect(x, Math.min(y0, y1), barW - 3, Math.max(2, Math.abs(y0 - y1)));
    });
    ctx.fillStyle = '#8a90a3';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const est = series[0].data[i] && series[0].data[i].est;
    ctx.fillText(lab + (est ? '(E)' : ''), cx, h - 14);
  });
}

// ── ③ 투자적합도 탭 ──
function makeCheck(grade, title, desc) { return { grade, title, desc }; }
function band(v, goodCond, midCond) { return goodCond ? 'good' : midCond ? 'mid' : 'bad'; }

function buildChecks(d, item) {
  const checks = [];
  const cur = quoteCache[item.symbol] ? quoteCache[item.symbol].price : numOf(infoVal(d.infos, '전일'));
  // 1. 애널리스트 투자의견 (1~5, 높을수록 매수)
  const rec = d.consensus && numOf(d.consensus.recommMean);
  if (rec) {
    const txt = rec >= 4.5 ? '적극 매수' : rec >= 3.5 ? '매수' : rec >= 2.5 ? '중립' : rec >= 1.5 ? '매도' : '적극 매도';
    checks.push(makeCheck(band(rec, rec >= 3.5, rec >= 2.5), '애널리스트 투자의견: ' + txt,
      `증권사 컨센서스 평균 ${rec.toFixed(2)}점 / 5점 (3.5 이상이면 매수 우세)`));
  }
  // 2. 목표주가 대비 상승여력
  const target = d.consensus && numOf(d.consensus.priceTargetMean);
  if (target && cur) {
    const up = (target - cur) / cur * 100;
    checks.push(makeCheck(band(up, up >= 15, up >= 0),
      `목표주가 대비 ${up >= 0 ? '상승여력' : '하락위험'} ${Math.abs(up).toFixed(1)}%`,
      `애널리스트 평균 목표주가 ${fmtPrice(target, item.symbol)} vs 현재가 ${fmtPrice(cur, item.symbol)}. 현재가가 목표주가를 넘었다면 과열 신호일 수 있습니다.`));
  }
  // 3. PER
  const per = numOf(infoVal(d.infos, 'PER'));
  if (per) {
    checks.push(makeCheck(band(per, per > 0 && per < 15, per > 0 && per < 30), `PER ${per.toFixed(1)}배`,
      'PER(주가수익비율)이 낮을수록 이익 대비 주가가 저렴. 통상 15배 미만 저평가권, 30배 초과는 고평가권으로 봅니다 (업종별 차이 큼).'));
  }
  // 4. 추정PER 개선 (국내만 제공)
  const fper = numOf(infoVal(d.infos, '추정PER'));
  if (per && fper) {
    checks.push(makeCheck(band(fper, fper < per * 0.8, fper <= per), `추정 PER ${fper.toFixed(1)}배 (현재 ${per.toFixed(1)}배)`,
      '추정PER이 현재PER보다 낮으면 앞으로 이익이 늘어난다는 증권가 전망을 뜻합니다.'));
  }
  // 5. PBR
  const pbr = numOf(infoVal(d.infos, 'PBR'));
  if (pbr) {
    checks.push(makeCheck(band(pbr, pbr < 1.2, pbr < 3), `PBR ${pbr.toFixed(2)}배`,
      'PBR(주가순자산비율) 1배 미만이면 장부상 자산가치보다 싸게 거래된다는 의미입니다.'));
  }
  // 6. 수익성 (KR: ROE / US: ROA)
  const profKey = d.kr ? 'ROE' : 'ROA';
  const prof = lastActual(finSeries(d.annual, profKey)).cur;
  if (prof != null) {
    const th = d.kr ? [10, 5] : [7, 3];
    checks.push(makeCheck(band(prof, prof >= th[0], prof >= th[1]), `${profKey} ${prof.toFixed(1)}%`,
      d.kr ? 'ROE(자기자본이익률) 10% 이상이면 자본을 효율적으로 굴리는 기업으로 평가합니다.'
           : 'ROA(총자산이익률) 7% 이상이면 자산 효율이 높은 기업으로 평가합니다.'));
  }
  // 7. 매출 성장
  const rev = lastActual(finSeries(d.annual, '매출액'));
  if (rev.cur != null && rev.prev) {
    const g = (rev.cur - rev.prev) / Math.abs(rev.prev) * 100;
    checks.push(makeCheck(band(g, g >= 10, g >= 0), `매출 성장률 ${g >= 0 ? '+' : ''}${g.toFixed(1)}% (최근 결산 연도)`,
      '직전 연도 대비 매출 증가율. 10% 이상이면 뚜렷한 성장세입니다.'));
  }
  // 8. 이익 성장
  const profitTitle = d.kr ? '영업이익' : '당기순이익';
  const pr = lastActual(finSeries(d.annual, profitTitle));
  if (pr.cur != null && pr.prev) {
    const g = (pr.cur - pr.prev) / Math.abs(pr.prev) * 100;
    checks.push(makeCheck(band(g, g >= 10, g >= 0), `${profitTitle} 성장률 ${g >= 0 ? '+' : ''}${g.toFixed(1)}%`,
      '이익이 매출보다 빠르게 늘면 수익성이 개선되고 있다는 신호입니다.'));
  }
  // 9. 재무 안정성 (국내만 제공)
  const debt = lastActual(finSeries(d.annual, '부채비율')).cur;
  if (debt != null) {
    checks.push(makeCheck(band(debt, debt < 100, debt < 200), `부채비율 ${debt.toFixed(0)}%`,
      '부채비율 100% 미만이면 안정적, 200%를 넘으면 재무 부담이 큰 편입니다.'));
  }
  // 10. 52주 가격 위치
  const high = numOf(infoVal(d.infos, '52주 최고'));
  const low = numOf(infoVal(d.infos, '52주 최저'));
  if (high && low && cur && high > low) {
    const pos = (cur - low) / (high - low) * 100;
    checks.push(makeCheck(band(pos, pos < 40, pos < 80), `52주 범위의 ${pos.toFixed(0)}% 지점`,
      '1년 가격 범위에서 현재가의 위치. 고점 부근(80% 이상)이면 단기 과열 가능성을 함께 살펴보세요.'));
  }
  return checks;
}

function buildFitHTML(d, item) {
  const checks = buildChecks(d, item);
  if (!checks.length) return '<div class="d-loading">적합도를 계산할 데이터가 부족합니다.</div>';
  const ptsGot = checks.reduce((a, c) => a + (c.grade === 'good' ? 2 : c.grade === 'mid' ? 1 : 0), 0);
  const ptsMax = checks.length * 2;
  const score = Math.round(ptsGot / ptsMax * 100);
  const gradeTxt = score >= 65 ? ['저평가·매력 신호 우세', 'good'] : score >= 45 ? ['중립 — 신호 혼재', 'mid'] : ['고평가·주의 신호 우세', 'bad'];
  const gcolor = { good: '#2ecc71', mid: '#f1c40f', bad: '#e74c3c' }[gradeTxt[1]];
  const R = 56, CIRC = 2 * Math.PI * R;
  const nGood = checks.filter(c => c.grade === 'good').length;
  const nMid = checks.filter(c => c.grade === 'mid').length;
  const nBad = checks.length - nGood - nMid;
  let html = `<div class="fit-top">
    <div class="gauge">
      <svg width="130" height="130" viewBox="0 0 130 130">
        <circle cx="65" cy="65" r="${R}" fill="none" stroke="#2a2e3a" stroke-width="11"/>
        <circle cx="65" cy="65" r="${R}" fill="none" stroke="${gcolor}" stroke-width="11" stroke-linecap="round"
          stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - score / 100)}"/>
      </svg>
      <div class="score"><b>${score}</b><span>/ 100점</span></div>
    </div>
    <div class="fit-summary">
      <div class="fit-grade ${gradeTxt[1]}">${gradeTxt[0]}</div>
      <div class="fit-desc">
        <b>점수 산출 방법(공개):</b> 아래 ${checks.length}개 항목을 각각 ✓ 긍정 <b>2점</b> · △ 중립 <b>1점</b> · ✗ 주의 <b>0점</b>으로 채점합니다.<br>
        이 종목: ✓ ${nGood}개 + △ ${nMid}개 + ✗ ${nBad}개 = <b>${ptsGot}점 / 만점 ${ptsMax}점 → 100점 환산 ${score}점</b><br>
        판정 기준: 65점 이상 '매력 우세' · 45~64점 '중립' · 45점 미만 '주의'. 모든 항목은 동일 가중치이며, 각 항목의 판단 기준은 아래에 명시되어 있습니다.
      </div>
    </div>
  </div>`;
  // 목표주가 박스
  const target = d.consensus && numOf(d.consensus.priceTargetMean);
  const cur = quoteCache[item.symbol] ? quoteCache[item.symbol].price : null;
  if (target && cur) {
    const up = (target - cur) / cur * 100;
    html += `<div class="target-box">🎯 애널리스트 평균 목표주가 <b>${fmtPrice(target, item.symbol)}</b>
      — 현재가 대비 <b class="${up >= 0 ? 'good' : 'bad'}">${up >= 0 ? '+' : ''}${up.toFixed(1)}%</b>`;
    if (d.consensus.priceTargetHigh) html += ` <span style="color:var(--muted)">(최고 ${fmtPrice(numOf(d.consensus.priceTargetHigh), item.symbol)} / 최저 ${fmtPrice(numOf(d.consensus.priceTargetLow), item.symbol)})</span>`;
    html += `</div>`;
  }
  const icon = { good: '✓', mid: '△', bad: '✗' };
  const ptBadge = { good: ['buy', '2/2점'], mid: ['neutral', '1/2점'], bad: ['sell', '0/2점'] };
  html += '<div class="check-list">' + checks.map(c =>
    `<div class="check-item"><span class="check-icon ${c.grade}">${icon[c.grade]}</span>
     <div style="flex:1"><div class="head-row"><span class="t">${c.title}</span><span class="sig-badge ${ptBadge[c.grade][0]}">${ptBadge[c.grade][1]}</span></div><div class="d">${c.desc}</div></div></div>`).join('') + '</div>';
  html += `<div class="disclaimer">⚠️ 본 적합도 점수는 네이버 증권 공개 데이터를 단순 규칙으로 평가한 <b>참고용 지표</b>이며 투자 권유가 아닙니다.
    PER·PBR 적정 수준은 업종마다 크게 다르고, 컨센서스는 변경될 수 있습니다. 투자 판단과 책임은 본인에게 있습니다.</div>`;
  return html;
}

// ── ③ 기술 분석 탭 ──
// 표준 기준: RSI(14) 30/70, MACD(12,26,9) 시그널 교차, 이동평균 5/20/60 크로스,
// 볼린저밴드(20,±2σ), Envelope(20일선 ±6%), 스토캐스틱(14,3) 20/80, 거래량 20일 평균 대비
let techState = null;

async function renderTechTab(item) {
  const el = document.getElementById('tab-tech');
  techState = null;
  el.innerHTML = '<div class="d-loading">차트와 기술 지표를 계산하는 중…</div>';
  try {
    const r = await fetchChart(item.symbol, '5y', '1d'); // 과거 과열 분석(1/3/5년 백분위)용 장기 데이터
    if (detailItem !== item) return;
    const q = r.indicators.quote[0];
    const bars = (r.timestamp || []).map((t, i) => ({
      time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: (q.volume && q.volume[i]) || 0
    })).filter(b => b.close != null && b.open != null && b.high != null && b.low != null);
    if (bars.length < 30) throw new Error('데이터 부족');
    techState = { item, bars, range: '6mo' };
    buildTechUI(el);
  } catch (e) {
    if (detailItem !== item) return;
    el.innerHTML = '<div class="d-loading">차트 데이터를 불러오지 못했습니다.<br><br><button class="retry-btn">다시 시도</button></div>';
    el.querySelector('.retry-btn').onclick = () => renderTechTab(item);
  }
}

function buildTechUI(el) {
  const sigs = computeSignals(techState.bars);
  const buy = sigs.filter(s => s.grade === 'buy').length;
  const sell = sigs.filter(s => s.grade === 'sell').length;
  const neutral = sigs.length - buy - sell;
  const verdict = buy >= sell + 2 ? ['📈 매수 우세', 'good'] : sell >= buy + 2 ? ['📉 매도 우세', 'bad'] : ['⚖️ 중립 — 신호 혼재', 'mid'];
  const icon = { buy: '▲', neutral: '─', sell: '▼' };
  const iconCls = { buy: 'good', neutral: 'mid', sell: 'bad' };
  const badge = { buy: '매수 신호', neutral: '중립', sell: '매도 신호' };
  if (!techState.interval) techState.interval = '1d';
  let html = renderOverheatBlock(techState.bars, techState.item) + `
    <div class="tech-interval" id="tech-interval">
      <button data-iv="1d"${techState.interval === '1d' ? ' class="active"' : ''}>일봉</button>
      <button data-iv="1wk"${techState.interval === '1wk' ? ' class="active"' : ''}>주봉</button>
    </div>
    <div class="tech-range" id="tech-range">
      <button data-r="3mo">3개월</button>
      <button data-r="6mo" class="active">6개월</button>
      <button data-r="1y">1년</button>
      <button data-r="3y">3년</button>
    </div>
    <div class="tech-chart-box" id="tech-chart"></div>
    <div class="ma-legend" id="ma-legend">
      <span style="color:#f1c40f">━ 5일선</span>
      <span style="color:#4f8cff">━ 20일선</span>
      <span style="color:#b08cff">━ 60일선</span>
      <span>하단 막대: 거래량</span>
    </div>
    <div class="signal-summary">
      <div class="signal-verdict ${verdict[1]}">기술적 종합: ${verdict[0]}</div>
      <div class="signal-counts">
        <span class="good">매수 <b>${buy}</b></span>
        <span class="mid">중립 <b>${neutral}</b></span>
        <span class="bad">매도 <b>${sell}</b></span>
      </div>
      <div style="flex-basis:100%;font-size:0.72rem;color:var(--muted)">
        판정 규칙(공개): ${sigs.length}개 지표 중 매수 신호가 매도보다 2개 이상 많으면 '매수 우세',
        매도가 2개 이상 많으면 '매도 우세', 그 외 '중립'. 이 종목: 매수 ${buy} − 매도 ${sell} = ${buy - sell}.
      </div>
    </div>
    <div class="check-list">` + sigs.map(s => `
      <div class="check-item">
        <span class="check-icon ${iconCls[s.grade]}">${icon[s.grade]}</span>
        <div style="flex:1">
          <div class="head-row"><span class="t">${s.title}</span><span class="sig-badge ${s.grade}">${badge[s.grade]}</span></div>
          <div class="d">${s.desc}</div>
        </div>
      </div>`).join('') + `</div>
    <div class="disclaimer">⚠️ 기술적 지표는 과거 가격·거래량의 통계일 뿐 미래 수익을 보장하지 않습니다.
      RSI 30/70, MACD 시그널 교차, 골든크로스, 볼린저밴드 ±2σ 등 일반적으로 통용되는 표준 기준을 적용했습니다.
      단일 신호보다 여러 신호의 방향과 재무 분석을 함께 보세요. 투자 판단과 책임은 본인에게 있습니다.</div>
    <div id="tech-risk"></div>`;
  el.innerHTML = html;
  fillRiskMetrics(techState.item); // 리스크 지표 (베타·변동성·MDD, 지수 비동기)
  el.querySelector('#tech-range').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    techState.range = b.dataset.r;
    el.querySelectorAll('#tech-range button').forEach(x => x.classList.toggle('active', x === b));
    drawTechChart();
  });
  el.querySelector('#tech-interval').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    techState.interval = b.dataset.iv;
    el.querySelectorAll('#tech-interval button').forEach(x => x.classList.toggle('active', x === b));
    drawTechChart();
  });
  drawTechChart();
}

// 일봉 bars → 주봉 집계 (월~일을 한 주로 묶음. open=첫날, high/low=주중 극값, close=마지막날, volume=합)
function toWeekly(bars) {
  const map = new Map();
  bars.forEach(b => {
    const wk = Math.floor((Math.floor(b.time / 86400) + 3) / 7); // 1970-01-01=목요일 → 월요일 시작 주
    let w = map.get(wk);
    if (!w) { w = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }; map.set(wk, w); }
    else { w.high = Math.max(w.high, b.high); w.low = Math.min(w.low, b.low); w.close = b.close; w.volume += b.volume || 0; }
  });
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function drawTechChart() {
  if (!techState) return;
  const box = document.getElementById('tech-chart');
  if (!box || !box.offsetParent) return; // 탭이 숨겨진 상태면 보일 때 다시 그림
  box.innerHTML = '';
  const { item, range } = techState;
  const weekly = techState.interval === '1wk';
  const bars = weekly ? toWeekly(techState.bars) : techState.bars;
  const nDaily = range === '3mo' ? 63 : range === '6mo' ? 126 : range === '1y' ? 252 : range === '3y' ? 756 : techState.bars.length;
  const n = weekly ? Math.ceil(nDaily / 5) : nDaily;
  const start = Math.max(0, bars.length - n);
  const closes = bars.map(b => b.close);
  const maArr = p => closes.map((_, i) => i + 1 >= p ? closes.slice(i + 1 - p, i + 1).reduce((a, b) => a + b, 0) / p : null);
  const maSet = weekly
    ? [[13, '#f1c40f', '13주'], [26, '#4f8cff', '26주'], [52, '#b08cff', '52주']]
    : [[5, '#f1c40f', '5일'], [20, '#4f8cff', '20일'], [60, '#b08cff', '60일']];
  const leg = document.getElementById('ma-legend');
  if (leg) leg.innerHTML = maSet.map(([, color, lbl]) => `<span style="color:${color}">━ ${lbl}선</span>`).join('') + '<span>하단 막대: 거래량</span>';
  const chart = LightweightCharts.createChart(box, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: '#8a90a3' },
    grid: { vertLines: { color: '#1f2330' }, horzLines: { color: '#1f2330' } },
    timeScale: { borderColor: '#2a2e3a' },
    rightPriceScale: { borderColor: '#2a2e3a' },
    localization: {
      // 종목(fmt 없음)·지수/지표(fmt 보유) 모두 올바른 단위로 — 지수=숫자, 환율=₩, 금리=%
      priceFormatter: v => fmtPrice(v, item.symbol, item.fmt)
    }
  });
  const candle = chart.addCandlestickSeries({
    upColor: '#f04452', downColor: '#3182f6',
    wickUpColor: '#f04452', wickDownColor: '#3182f6',
    borderVisible: false
  });
  candle.setData(bars.slice(start).map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  // 거래량 급증일(직전 20봉 평균의 150%↑) 진하게 강조 — 추세 신뢰도 시각화
  const volAvgAt = i => { const s = Math.max(0, i - 19); const sl = bars.slice(s, i + 1).map(b => b.volume || 0); return sl.reduce((a, b) => a + b, 0) / (sl.length || 1); };
  vol.setData(bars.slice(start).map((b, idx) => {
    const i = start + idx;
    const spike = (b.volume || 0) >= volAvgAt(i) * 1.5;
    const base = b.close >= b.open ? '240,68,82' : '49,130,246';
    return { time: b.time, value: b.volume, color: `rgba(${base},${spike ? 0.85 : 0.4})` };
  }));
  maSet.forEach(([p, color]) => {
    const data = maArr(p);
    const s = chart.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.setData(bars.map((b, i) => ({ time: b.time, value: data[i] })).slice(start).filter(pt => pt.value != null));
  });
  // 골든/데드크로스 마커 (단기선 vs 중기선 교차)
  const p1 = maArr(maSet[0][0]), p2 = maArr(maSet[1][0]);
  const markers = [];
  for (let i = Math.max(start, 1); i < bars.length; i++) {
    if (p1[i] == null || p2[i] == null || p1[i - 1] == null || p2[i - 1] == null) continue;
    if (p1[i - 1] <= p2[i - 1] && p1[i] > p2[i]) markers.push({ time: bars[i].time, position: 'belowBar', color: '#2ecc71', shape: 'arrowUp', text: 'G' });
    else if (p1[i - 1] >= p2[i - 1] && p1[i] < p2[i]) markers.push({ time: bars[i].time, position: 'aboveBar', color: '#e74c3c', shape: 'arrowDown', text: 'D' });
  }
  if (markers.length) candle.setMarkers(markers);
  // 52주 신고가/신저가 가격선 (일봉 기준 최근 252봉)
  const win52 = techState.bars.slice(-252);
  if (win52.length > 20) {
    const full = techState.bars.length >= 252; // 1년치 데이터 있으면 '52주', 아니면 '기간'(상장 직후 등)
    const hi52 = Math.max(...win52.map(b => b.high)), lo52 = Math.min(...win52.map(b => b.low));
    candle.createPriceLine({ price: hi52, color: 'rgba(240,68,82,0.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: full ? '52주 고' : '기간 고' });
    candle.createPriceLine({ price: lo52, color: 'rgba(58,134,255,0.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: full ? '52주 저' : '기간 저' });
  }
  // 차트 우상단 배지: 거래량 배수 · 신호 종합
  try {
    const sigs = computeSignals(techState.bars);
    const buy = sigs.filter(s => s.grade === 'buy').length, sell = sigs.filter(s => s.grade === 'sell').length;
    const verdict = buy >= sell + 2 ? 'buy' : sell >= buy + 2 ? 'sell' : 'neutral';
    const dv = techState.bars.map(b => b.volume || 0), last20 = dv.slice(-20);
    const vAvg = last20.reduce((a, b) => a + b, 0) / (last20.length || 1);
    const vRatio = vAvg ? dv[dv.length - 1] / vAvg : 1;
    const bd = document.createElement('div');
    bd.className = 'chart-badges';
    bd.innerHTML = `<div class="chart-badge volume">📊 거래량 ${Math.round(vRatio * 100)}%</div><div class="chart-badge signal-${verdict}">신호 ${verdict === 'buy' ? '매수' : verdict === 'sell' ? '매도' : '중립'}</div>`;
    box.appendChild(bd);
  } catch (e) {}
  chart.timeScale().fitContent();
}

// ── 기술 지표 계산 ──
function rsiWilder(closes, period) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function emaArr(arr, p) {
  const k = 2 / (p + 1);
  let e = arr[0];
  const out = [e];
  for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function macdCalc(closes) {
  const e12 = emaArr(closes, 12), e26 = emaArr(closes, 26);
  const macd = closes.map((_, i) => e12[i] - e26[i]);
  const sig = emaArr(macd, 9);
  return { hist: macd.map((v, i) => v - sig[i]) };
}
function stochasticK(bars, period, smooth) {
  const last = bars.length - 1;
  if (bars.length < period + smooth) return null;
  const kVals = [];
  for (let j = last - smooth + 1; j <= last; j++) {
    const sl = bars.slice(j - period + 1, j + 1);
    const hi = Math.max(...sl.map(b => b.high)), lo = Math.min(...sl.map(b => b.low));
    kVals.push(hi === lo ? 50 : (bars[j].close - lo) / (hi - lo) * 100);
  }
  return kVals.reduce((a, b) => a + b, 0) / kVals.length; // 슬로우 %K (3일 평활)
}

function computeSignals(bars, sym) {
  // 가격 표시용 심볼: 인자 우선, 없으면 techState(기술탭) 폴백 — 종합탭 폴백 경로에서 techState=null이어도 안전
  const symbol = sym || (techState && techState.item && techState.item.symbol) || '';
  const closes = bars.map(b => b.close);
  const vols = bars.map(b => b.volume);
  const last = closes.length - 1;
  const price = closes[last];
  const sma = (p, idx = last) => idx + 1 >= p ? closes.slice(idx + 1 - p, idx + 1).reduce((a, b) => a + b, 0) / p : null;
  const sigs = [];

  // 1. RSI(14)
  const rsi = rsiWilder(closes, 14);
  if (rsi != null) sigs.push({
    grade: rsi < 30 ? 'buy' : rsi > 70 ? 'sell' : 'neutral',
    title: `RSI(14) = ${rsi.toFixed(1)}`,
    desc: rsi < 30 ? '30 미만 과매도 구간 — 단기 반등을 노리는 매수 관점 신호입니다.'
      : rsi > 70 ? '70 초과 과매수 구간 — 단기 조정 가능성이 있는 매도 관점 신호입니다.'
      : '중립 구간입니다 (30 미만이면 과매도→매수, 70 초과면 과매수→매도 관점).'
  });

  // 2. MACD(12,26,9)
  const { hist } = macdCalc(closes);
  if (hist.length > 6) {
    const h = hist[last];
    let cross = '';
    for (let i = last - 4; i <= last; i++) {
      if (i > 0 && hist[i - 1] <= 0 && hist[i] > 0) cross = ' 최근 5일 내 골든크로스(시그널선 상향돌파)가 발생했습니다!';
      if (i > 0 && hist[i - 1] >= 0 && hist[i] < 0) cross = ' 최근 5일 내 데드크로스(시그널선 하향돌파)가 발생했습니다.';
    }
    sigs.push({
      grade: h > 0 ? 'buy' : 'sell',
      title: `MACD(12,26,9) ${h > 0 ? '시그널선 위 — 상승 모멘텀' : '시그널선 아래 — 하락 모멘텀'}`,
      desc: `히스토그램(diff) ${h >= 0 ? '+' : ''}${h.toFixed(2)}.${cross} MACD선이 시그널선을 상향 돌파하면 매수, 하향 돌파하면 매도 신호로 봅니다.`
    });
  }

  // 3. 단기 이동평균 (5/20 크로스)
  const m5 = sma(5), m20 = sma(20), m60 = sma(60);
  if (m5 && m20) {
    const m5p = sma(5, last - 1), m20p = sma(20, last - 1);
    const cross = (m5p <= m20p && m5 > m20) ? ' 골든크로스가 막 발생했습니다!'
      : (m5p >= m20p && m5 < m20) ? ' 데드크로스가 막 발생했습니다.' : '';
    sigs.push({
      grade: m5 > m20 ? 'buy' : 'sell',
      title: `단기 추세: 5일선이 20일선 ${m5 > m20 ? '위' : '아래'}`,
      desc: `5일 이동평균 ${fmtPrice(m5, symbol)} vs 20일선 ${fmtPrice(m20, symbol)}.${cross} 단기선이 위면 상승 추세 지속으로 봅니다.`
    });
  }

  // 4. 중기 추세 (20/60 배열)
  if (m20 && m60) {
    const aligned = price > m20 && m20 > m60;
    const reversed = price < m20 && m20 < m60;
    sigs.push({
      grade: aligned ? 'buy' : reversed ? 'sell' : 'neutral',
      title: aligned ? '중기 정배열 (주가 > 20일선 > 60일선)' : reversed ? '중기 역배열 (주가 < 20일선 < 60일선)' : '중기 추세 전환 구간',
      desc: '정배열은 중기 상승 추세의 교과서적 형태, 역배열은 하락 추세입니다. 섞여 있으면 추세 전환 중일 수 있습니다.'
    });
  }

  // 5. 볼린저밴드(20, ±2σ)
  if (m20 && last >= 19) {
    const sl = closes.slice(last - 19, last + 1);
    const sd = Math.sqrt(sl.reduce((a, v) => a + (v - m20) ** 2, 0) / 20);
    const up = m20 + 2 * sd, lo = m20 - 2 * sd;
    const pctB = (price - lo) / ((up - lo) || 1) * 100;
    sigs.push({
      grade: price < lo ? 'buy' : price > up ? 'sell' : 'neutral',
      title: `볼린저밴드 %B = ${pctB.toFixed(0)}%`,
      desc: price < lo ? '하단 밴드(-2σ) 아래로 이탈 — 통계적 과매도, 반등 관점 매수 신호입니다.'
        : price > up ? '상단 밴드(+2σ) 위로 돌파 — 통계적 과열 구간입니다.'
        : `밴드 내부 ${pctB.toFixed(0)}% 위치 (0% 부근 과매도, 100% 부근 과매수).`
    });
  }

  // 6. Envelope (20일선 ±6%)
  if (m20) {
    const dev = (price / m20 - 1) * 100;
    sigs.push({
      grade: dev < -6 ? 'buy' : dev > 6 ? 'sell' : 'neutral',
      title: `Envelope(20일, ±6%) 이격도 ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}%`,
      desc: dev < -6 ? '20일선 대비 6% 이상 하락 이탈 — 과매도 반등 관점 매수 신호입니다.'
        : dev > 6 ? '20일선 대비 6% 이상 상승 이탈 — 과열에 따른 조정 관점 매도 신호입니다.'
        : '20일선 ±6% 밴드 안의 정상 범위입니다. 밴드 이탈 시 평균 회귀를 노립니다.'
    });
  }

  // 7. 스토캐스틱 (14,3)
  const sto = stochasticK(bars, 14, 3);
  if (sto != null) sigs.push({
    grade: sto < 20 ? 'buy' : sto > 80 ? 'sell' : 'neutral',
    title: `스토캐스틱 %K(14,3) = ${sto.toFixed(1)}`,
    desc: sto < 20 ? '20 미만 과매도 구간 — 매수 관점 신호입니다.'
      : sto > 80 ? '80 초과 과매수 구간 — 매도 관점 신호입니다.'
      : '중립 구간입니다 (20 미만 과매도, 80 초과 과매수).'
  });

  // 8. 거래량 (20일 평균 대비)
  if (vols[last] > 0 && last >= 21) {
    const avg20 = vols.slice(last - 20, last).reduce((a, b) => a + b, 0) / 20;
    const ratio = avg20 ? vols[last] / avg20 : 1;
    const upDay = price >= closes[last - 1];
    sigs.push({
      grade: ratio >= 1.5 ? (upDay ? 'buy' : 'sell') : 'neutral',
      title: `거래량: 20일 평균의 ${(ratio * 100).toFixed(0)}%`,
      desc: ratio >= 1.5
        ? (upDay ? '상승하며 거래량 급증(150%↑) — 매수세 유입으로 추세 신뢰도가 높아집니다.'
                 : '하락하며 거래량 급증(150%↑) — 매도 압력이 강하다는 신호입니다.')
        : '평균 수준의 거래량입니다. 거래량이 평균의 150% 이상으로 늘 때 추세 신호의 신뢰도가 올라갑니다.'
    });
  }
  return sigs;
}

// ═════════════════════ 과거 대비 과열도 분석 엔진 ═════════════════════
// 핵심 원칙(리서치 검증): 절대 임계값(RSI 70 등)이 아니라 "현재값이 과거 분포의 몇 백분위인가"로 판단.
// 모든 계산은 t 시점까지의 데이터만 사용 → 룩어헤드(미래정보 누출) 코드 레벨 차단.
function percentileRank(window, current) {
  const vs = window.filter(v => v != null);
  if (!vs.length || current == null) return null;
  return vs.filter(v => v < current).length / vs.length * 100;
}
function rollingZ(window, current) {
  const vs = window.filter(v => v != null);
  if (vs.length < 2 || current == null) return null;
  const mu = vs.reduce((a, b) => a + b, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mu) ** 2, 0) / vs.length);
  return sd === 0 ? 0 : (current - mu) / sd;
}
function smaSeries(closes, p) {
  return closes.map((_, i) => i + 1 >= p ? closes.slice(i + 1 - p, i + 1).reduce((a, b) => a + b, 0) / p : null);
}
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
const OH_LOOKBACKS = { '1년': 252, '3년': 756, '5년': 1260 };

function overheatSnapshot(closes) {
  const n = closes.length, t = n - 1;
  if (n < 60) return null;
  const rsi = rsiSeries(closes, 14);
  const sma200 = smaSeries(closes, 200);
  const disp = closes.map((c, i) => sma200[i] == null ? null : (c - sma200[i]) / sma200[i] * 100);
  const metrics = {};
  for (const [tag, W] of Object.entries(OH_LOOKBACKS)) {
    const from = Math.max(0, t - W + 1);
    const rsiWin = rsi.slice(from, t + 1);
    const dispWin = disp.slice(from, t + 1);
    const pWin = closes.slice(from, t + 1);
    const lo = Math.min(...pWin), hi = Math.max(...pWin);
    metrics[tag] = {
      W,
      sampleN: pWin.length,
      rsiRaw: rsi[t],
      rsiPct: percentileRank(rsiWin, rsi[t]),
      dispRaw: disp[t],
      // 200일선 워밍업(앞 199봉 null) 탓에 유효 표본이 30 미만이면 이격도 백분위는 보류
      dispPct: dispWin.filter(v => v != null).length >= 30 ? percentileRank(dispWin, disp[t]) : null,
      pos52w: hi === lo ? 50 : (closes[t] - lo) / (hi - lo) * 100,
      z: rollingZ(closes.slice(from, t + 1), closes[t]) // RSI 백분위와 동일 룩백 윈도우 사용
    };
  }
  return { metrics, rsiRaw: rsi[t], dispRaw: disp[t] };
}

// 골든/데드크로스 + 추세 레짐 (과열이 아닌 방향 필터)
function crossState(closes) {
  const s50 = smaSeries(closes, 50), s200 = smaSeries(closes, 200);
  const t = closes.length - 1;
  if (s50[t] == null || s200[t] == null || s50[t - 1] == null || s200[t - 1] == null) return null;
  return {
    golden: s50[t - 1] <= s200[t - 1] && s50[t] > s200[t],
    dead: s50[t - 1] >= s200[t - 1] && s50[t] < s200[t],
    regime: s50[t] > s200[t] ? 'bull' : 'bear'
  };
}

// forward-return conditioning: 과거에 '지금처럼 과열(RSI 1년 백분위≥90)'이었을 때 이후 수익 통계
function forwardReturnStats(closes) {
  const W = 252, H1 = 21, H3 = 63;
  if (closes.length < W + H1 + 5) return null;
  const rsi = rsiSeries(closes, 14);
  const hot = [], normal = [];
  for (let t = W; t <= closes.length - 1 - H1; t++) {
    if (rsi[t] == null) continue;
    const pct = percentileRank(rsi.slice(t - W + 1, t + 1), rsi[t]);
    if (pct == null) continue;
    const rec = { f1: closes[t + H1] / closes[t] - 1, f3: (t + H3 <= closes.length - 1) ? closes[t + H3] / closes[t] - 1 : null };
    (pct >= 90 ? hot : normal).push(rec);
  }
  const agg = arr => {
    if (!arr.length) return null;
    const f1 = arr.map(x => x.f1), f3 = arr.map(x => x.f3).filter(v => v != null);
    const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const win = a => a.length ? a.filter(v => v > 0).length / a.length * 100 : null;
    // n=1개월 표본, n3=3개월 표본(끝쪽 시점은 t+63 미확보로 적음 → 별도 집계해 정직하게 표기)
    return { n: f1.length, n3: f3.length, mean1: mean(f1), med1: med(f1), win1: win(f1), mean3: mean(f3), med3: med(f3), win3: win(f3) };
  };
  return { hot: agg(hot), normal: agg(normal) };
}

// 종합 과열도 0~100 (1년 기준 백분위 4종 평균)
function overheatScore(snap) {
  const m = snap && snap.metrics['1년'];
  if (!m) return null;
  const parts = [m.rsiPct, m.dispPct, m.pos52w, m.z == null ? null : Math.min(100, Math.abs(m.z) / 3 * 100)].filter(v => v != null);
  if (!parts.length) return null;
  const score = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  const structural = ['1년', '3년', '5년'].every(k => snap.metrics[k] && snap.metrics[k].rsiPct != null && snap.metrics[k].rsiPct >= 90);
  return { score, level: score >= 90 ? 'hot' : score >= 80 ? 'warm' : score <= 20 ? 'cool' : 'normal', structural };
}

// 과열 분석 블록 HTML (종목·지수 공용). bars = [{close,...}], item = {symbol,name}
function renderOverheatBlock(bars, item) {
  const closes = bars.map(b => b.close).filter(v => v != null);
  const snap = overheatSnapshot(closes);
  if (!snap) return '<div class="oh-metric-note" style="padding:10px 0">과열 분석에 필요한 과거 데이터가 부족합니다.</div>';
  const sc = overheatScore(snap);
  const m = snap.metrics['1년'];
  const idx = isIndexSym(item.symbol);
  const lvlTxt = { hot: '과열권 — 평소보다 크게 달아오른 상태', warm: '다소 과열 — 평소보다 높은 편', cool: '침체권 — 평소보다 눌린 상태', normal: '중립 — 평소 범위' };
  const lvlCls = { hot: 'bad', warm: 'mid', cool: 'down', normal: 'mid' };
  let html = `<div class="overheat-card">
    <div class="overheat-head">
      <span class="overheat-verdict ${sc ? lvlCls[sc.level] : 'mid'}">🌡️ 과열도 ${sc ? sc.score : '—'}점 / 100</span>
      <span class="overheat-sub">${sc ? lvlTxt[sc.level] : ''} · 과거 1년 분포 대비 현재 위치</span>
    </div>`;
  if (sc && sc.structural) html += `<div class="disclaimer" style="margin:0 0 12px;background:rgba(231,76,60,0.1);border-color:rgba(231,76,60,0.35)">🚨 <b>구조적 과열</b> — 1년·3년·5년 어느 기준으로 봐도 과열권입니다. 일시적 과열보다 신뢰도가 높지만, 시장 환경이 바뀌면 과거 분포가 달라질 수 있습니다.</div>`;

  const metricRow = (k, v, pct, note, pctTagThresholds) => {
    if (pct == null) return '';
    const tag = pct >= 90 ? ['ov-hot', '과열'] : pct >= 80 ? ['ov-warm', '주의'] : pct <= 10 ? ['ov-cool', '과매도'] : ['', '중립'];
    return `<div class="oh-metric">
      <div class="oh-metric-top"><span class="oh-k">${k}</span><span class="oh-v">${v} · 과거 상위 ${(100 - pct).toFixed(0)}%${tag[0] ? ` <span class="ov-tag ${tag[0]}">${tag[1]}</span>` : ''}</span></div>
      <div class="oh-pct-track"><div class="oh-pct-cursor" style="left:${pct.toFixed(0)}%"></div></div>
      <div class="oh-metric-note">${note}</div>
    </div>`;
  };
  // 3년/5년 백분위 참고 문구
  const multi = key => ['3년', '5년'].map(k => snap.metrics[k] && snap.metrics[k][key] != null ? `${k} ${(100 - snap.metrics[k][key]).toFixed(0)}%` : null).filter(Boolean).join(' · ');

  html += metricRow('RSI(14) 과열도', m.rsiRaw != null ? m.rsiRaw.toFixed(0) : '—', m.rsiPct,
    `RSI가 지난 1년 중 상위 ${m.rsiPct != null ? (100 - m.rsiPct).toFixed(0) : '—'}%. ${idx ? '지수는 강한 추세장에서 오래 높게 머물 수 있어' : ''} 백분위 90 이상일 때만 과열로 봅니다.${multi('rsiPct') ? ' (' + multi('rsiPct') + ')' : ''}`);
  html += metricRow('200일선과의 거리(이격도)', m.dispRaw != null ? (m.dispRaw >= 0 ? '+' : '') + m.dispRaw.toFixed(1) + '%' : '—', m.dispPct,
    `200일 평균선보다 ${m.dispRaw != null ? Math.abs(m.dispRaw).toFixed(1) + '% ' + (m.dispRaw >= 0 ? '위' : '아래') : '—'}. 평소보다 과하게 벌어지면 되돌림 위험을 함께 보세요.`);
  html += metricRow('52주 가격 범위 내 위치', m.pos52w != null ? m.pos52w.toFixed(0) + '%' : '—', m.pos52w,
    `최근 1년 최저~최고 사이 위치입니다. 90% 이상이면 고점 부근입니다.`);
  if (m.z != null) {
    const zpct = Math.min(100, Math.abs(m.z) / 3 * 100);
    html += `<div class="oh-metric">
      <div class="oh-metric-top"><span class="oh-k">변동성 기준 과열도 (z-score)</span><span class="oh-v">${m.z >= 0 ? '+' : ''}${m.z.toFixed(2)}σ${Math.abs(m.z) >= 2 ? ` <span class="ov-tag ${m.z > 0 ? 'ov-hot' : 'ov-cool'}">${Math.abs(m.z) >= 3 ? '극단' : '경계'}</span>` : ''}</span></div>
      <div class="oh-pct-track"><div class="oh-pct-cursor" style="left:${(m.z > 0 ? 50 + zpct / 2 : 50 - zpct / 2).toFixed(0)}%"></div></div>
      <div class="oh-metric-note">평균에서 표준편차 ${Math.abs(m.z).toFixed(2)}배 ${m.z >= 0 ? '위' : '아래'}. ±2σ는 통계적으로 드문 구간(약 상·하위 2.5%)입니다.</div>
    </div>`;
  }

  // 추세 레짐
  const cross = crossState(closes);
  if (cross) {
    html += `<div class="oh-metric-note" style="margin:8px 0 4px">📐 추세: <b class="${cross.regime === 'bull' ? 'good' : 'bad'}">${cross.regime === 'bull' ? '50일선 > 200일선 (상승 추세)' : '50일선 < 200일선 (하락 추세)'}</b>${cross.golden ? ' · 최근 골든크로스 발생' : cross.dead ? ' · 최근 데드크로스 발생' : ''}</div>`;
  }

  // forward-return conditioning
  const fr = forwardReturnStats(closes);
  if (fr && fr.hot) {
    const h = fr.hot;
    const warn = h.n < 30 ? ' <span class="bad">(표본 30건 미만 — 참고하지 마세요)</span>' : h.n < 100 ? ' <span class="mid">(표본 적음, 주의)</span>' : '';
    const pc = v => v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
    const cls = v => v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    html += `<div class="oh-fwd">
      <b>📅 과거에 지금처럼 과열이었을 때, 이후 수익은?</b><br>
      RSI가 1년 백분위 90 이상이던 과거 <b>${h.n}건</b>${warn} 이후 →
      <b>1개월</b> 평균 <b class="${cls(h.mean1)}">${pc(h.mean1)}</b> (중앙값 ${pc(h.med1)}, 상승확률 ${h.win1 != null ? h.win1.toFixed(0) + '%' : '—'})${(h.n3 >= 30 && h.mean3 != null) ? `, <b>3개월</b> 평균 <b class="${cls(h.mean3)}">${pc(h.mean3)}</b> (상승확률 ${h.win3 != null ? h.win3.toFixed(0) + '%' : '—'}, ${h.n3}건)` : ''}.
      ${fr.normal ? `<span style="color:var(--muted)">— 평상시 1개월 평균은 ${pc(fr.normal.mean1)}입니다.</span>` : ''}
      <div class="oh-metric-note" style="margin-top:6px">⚠️ 과열은 '되돌림 확률이 통계적으로 높아진 상태'일 뿐 즉시 하락 신호가 아닙니다. 과거 통계가 미래를 보장하지 않습니다.</div>
    </div>`;
  } else {
    html += `<div class="oh-metric-note" style="margin-top:8px">📅 과거 비교에 필요한 데이터(약 1년 이상)가 부족해 forward-return 통계는 생략합니다.</div>`;
  }
  html += '</div>';
  return html;
}

// 지수 심볼 판별 (야후 지수는 ^로 시작)
function isIndexSym(symbol) { return /^\^/.test(symbol); }

// ── ④ 전망 탭 (미래지향 데이터: 컨센서스 전망·목표주가·투자의견·증권사 리포트·기업 개요) ──
function renderFutureTab(d, item) {
  const el = document.getElementById('tab-future');
  const cur = quoteCache[item.symbol] && quoteCache[item.symbol].price;
  let html = '';

  // 1) 컨센서스 실적 전망 — 재무제표의 (E) 추정 연도 vs 최근 확정 실적
  const fwdTitles = d.kr ? ['매출액', '영업이익', '당기순이익'] : ['매출액', '당기순이익'];
  const fwd = [];
  fwdTitles.forEach(title => {
    const s = finSeries(d.annual, title);
    const est = s.filter(x => x.est && x.value != null);
    const act = s.filter(x => !x.est && x.value != null);
    if (est.length && act.length && act[act.length - 1].value !== 0) {
      fwd.push({ title, label: est[0].label, g: (est[0].value - act[act.length - 1].value) / Math.abs(act[act.length - 1].value) * 100 });
    }
  });
  const fper = infoVal(d.infos, '추정PER'), feps = infoVal(d.infos, '추정EPS');
  if (fwd.length || fper) {
    html += '<div class="hf-title" style="font-size:0.92rem">🔮 컨센서스 실적 전망 <span style="color:var(--muted);font-weight:400">— 증권사 추정 평균과 최근 확정 실적의 비교</span></div><div class="metric-grid">';
    fwd.forEach(f => {
      const cls = f.g > 0 ? 'up' : f.g < 0 ? 'down' : 'flat';
      html += `<div class="metric"><div class="k">${f.title} 성장 전망 (${esc(f.label)} 추정)</div><div class="v ${cls}">${f.g >= 0 ? '+' : ''}${f.g.toFixed(1)}%</div></div>`;
    });
    if (fper) html += `<div class="metric"><div class="k">추정 PER (12개월 선행)</div><div class="v">${esc(fper)}</div></div>`;
    if (feps) html += `<div class="metric"><div class="k">추정 EPS</div><div class="v">${esc(feps)}</div></div>`;
    html += '</div>';
  }

  // 2) 목표주가 밴드
  const c = d.consensus || {};
  const mean = numOf(c.priceTargetMean), high = numOf(c.priceTargetHigh), low = numOf(c.priceTargetLow);
  if (mean && cur) {
    const lo = Math.min(low || mean, cur) * 0.97, hi = Math.max(high || mean, cur) * 1.03;
    const pos = v => Math.min(100, Math.max(0, (v - lo) / (hi - lo) * 100));
    const up = (mean - cur) / cur * 100;
    html += `<div class="band-wrap" style="margin-bottom:14px">
      <div class="band-title">🎯 애널리스트 목표주가 — 평균 <b>${fmtPrice(mean, item.symbol)}</b>, 현재가 대비 <b class="${up >= 0 ? 'good' : 'bad'}">${up >= 0 ? '+' : ''}${up.toFixed(1)}%</b>${c.createDate ? ' (' + esc(c.createDate) + ' 기준)' : ''}</div>
      <div class="band-bar">
        ${low ? `<div class="band-cursor" style="left:${pos(low)}%;background:#3182f6" title="최저 목표가 ${fmtPrice(low, item.symbol)}"></div>` : ''}
        <div class="band-cursor" style="left:${pos(mean)}%;background:#f1c40f" title="평균 목표가"></div>
        ${high ? `<div class="band-cursor" style="left:${pos(high)}%;background:#f04452" title="최고 목표가 ${fmtPrice(high, item.symbol)}"></div>` : ''}
        <div class="band-cursor" style="left:${pos(cur)}%" title="현재가"></div>
      </div>
      <div class="band-labels">
        <span>${low ? '🔵 최저 ' + fmtPrice(low, item.symbol) : ''}</span>
        <span>⚪ 현재 ${fmtPrice(cur, item.symbol)} · 🟡 평균</span>
        <span>${high ? '🔴 최고 ' + fmtPrice(high, item.symbol) : ''}</span>
      </div>
    </div>`;
  }

  // 3) 투자의견 스케일
  const rec = numOf(c.recommMean);
  if (rec) {
    const pct = Math.min(100, Math.max(0, (rec - 1) / 4 * 100));
    html += `<div class="band-wrap" style="margin-bottom:14px">
      <div class="band-title">🗳️ 애널리스트 투자의견 평균 — <b>${rec.toFixed(2)} / 5.0</b></div>
      <div class="band-bar"><div class="band-cursor" style="left:${pct}%"></div></div>
      <div class="band-labels"><span>1 적극매도</span><span>3 중립</span><span>5 적극매수</span></div>
    </div>`;
  }

  // 4) 증권사 리포트 (국내 전용 — 네이버 리서치)
  if (d.researches && d.researches.length) {
    html += '<div class="hf-title" style="font-size:0.92rem;margin-top:4px">📑 최신 증권사 리포트</div><div class="panel" style="margin-bottom:14px">';
    d.researches.slice(0, 8).forEach(r => {
      const dt = r.wdt && r.wdt.length === 8 ? `${r.wdt.slice(0, 4)}.${r.wdt.slice(4, 6)}.${r.wdt.slice(6, 8)}` : '';
      html += `<a class="news-item" target="_blank" rel="noopener" href="https://finance.naver.com/research/company_read.naver?nid=${encodeURIComponent(r.id)}">
        <div class="title">${esc(r.tit)}</div><div class="meta">${esc(r.bnm)} · ${dt}</div></a>`;
    });
    html += '</div>';
  }

  // 5) 기업 개요
  if (d.profile) {
    html += `<div class="hf-title" style="font-size:0.92rem">🏢 기업 개요</div>
      <div class="target-box" style="line-height:1.75;font-size:0.82rem;color:var(--text)">${esc(d.profile)}</div>`;
  }

  if (!html) html = '<div class="d-loading">이 종목의 전망 데이터가 제공되지 않습니다.</div>';
  else html += `<div class="disclaimer">⚠️ 목표주가·컨센서스·리포트는 증권사 추정과 의견으로 수시로 변경되며 실제와 다를 수 있습니다. 미래 전망 데이터는 보장이 아닌 참고 자료입니다.</div>`;
  el.innerHTML = html;
}

// ── ⓪ 종합 평가 탭 (재무·기술·미시·뉴스·업종·거시 6항목 + Claude 종합 의견) ──
async function fetchNewsScored(item) {
  let scored = await naverNewsRaw(newsTargetFor(item)); // [{title,source,s,...}]
  if (!scored.length) return null;
  if (newsTrustedOnly) { const k = scored.filter(x => isTrustedSource(x.source, x.title)); if (k.length) scored = k; }
  return scored;
}

function ruleOpinion(parts, comp, item) {
  const g = scoreGrade(comp.score);
  const strong = SCORE_DIMS.filter(dm => parts[dm.key] && parts[dm.key].score >= 65).map(dm => dm.label);
  const weak = SCORE_DIMS.filter(dm => parts[dm.key] && parts[dm.key].score < 45).map(dm => dm.label);
  let t = `${esc(item.name || item.symbol)}의 종합 점수는 <b>${comp.score}점 (${g.txt})</b>입니다. `;
  if (strong.length) t += `상대적 강점은 <b>${strong.join('·')}</b> 항목이고, `;
  if (weak.length) t += `주의가 필요한 항목은 <b>${weak.join('·')}</b>입니다. `;
  else if (strong.length) t += `뚜렷한 약점 항목은 없습니다. `;
  if (!strong.length && !weak.length) t += `대부분 항목이 중립 구간에 있어 방향성이 뚜렷하지 않습니다. `;
  return t;
}

async function claudeStockOpinion(item, d, parts, comp) {
  const lines = SCORE_DIMS.map(dm => {
    const p = parts[dm.key];
    return `- ${dm.label}(가중 ${Math.round(dm.weight * 100)}%): ` +
      (p ? `${p.score}점 — ${p.summary}${p.reasons && p.reasons.length ? ' [' + p.reasons.join(', ') + ']' : ''}` : '데이터 없음');
  }).join('\n');
  const cur = quoteCache[item.symbol] && fmtPrice(quoteCache[item.symbol].price, item.symbol);
  const target = d.consensus && numOf(d.consensus.priceTargetMean);
  const sys = '당신은 한국어로 답하는 신중한 주식 애널리스트입니다. 제공된 정량 지표만 근거로 평가하며, 단정적인 매수/매도 단언은 피하고 균형 잡힌 시각을 유지합니다. 모든 답변은 투자 권유가 아닌 참고 의견임을 전제로 합니다.';
  const user = `다음은 '${item.name || item.symbol}'(${item.symbol})의 규칙 기반 항목별 투자 점수입니다 (각 0~100, 높을수록 우호적).\n\n종합점수: ${comp.score}/100\n${lines}` +
    `${cur ? '\n\n현재가: ' + cur : ''}${target ? '\n애널리스트 평균 목표주가: ' + fmtPrice(target, item.symbol) : ''}` +
    `\n\n위 지표를 바탕으로 6~8문장으로 종합 평가를 작성하세요. 포함할 내용: (1) 전반적 투자 매력도 한 줄 요약, (2) 가장 두드러진 강점 1~2가지와 그 의미, (3) 가장 유의할 리스크 1~2가지, (4) 어떤 투자 성향·관점에 적합한지. 핵심 단어는 **굵게** 표시하세요.`;
  return await callClaude(sys, user, 1024);
}

function renderAiZone(item, d, parts, comp) {
  const zone = document.getElementById('sum-ai-zone');
  if (!zone) return;
  zone.innerHTML = `<button class="ai-btn" id="sum-ai-btn">${hasClaudeKey() ? '🤖 Claude 심층 의견 받기' : '🤖 Claude 의견 (AI 설정 필요)'}</button>`;
  document.getElementById('sum-ai-btn').onclick = async () => {
    if (!hasClaudeKey()) { document.getElementById('settings-btn').click(); return; }
    const btn = document.getElementById('sum-ai-btn');
    btn.disabled = true; btn.textContent = '🤖 Claude가 분석 중…';
    if (!document.getElementById('sum-ai-box'))
      zone.insertAdjacentHTML('beforeend', '<div class="ai-box" id="sum-ai-box"><div class="ai-head">🤖 Claude 심층 의견</div><div class="ai-body" id="sum-ai-body">생성 중…</div></div>');
    try {
      const txt = await claudeStockOpinion(item, d, parts, comp);
      if (detailItem !== item) return;
      document.getElementById('sum-ai-body').innerHTML = esc(txt).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      btn.style.display = 'none';
    } catch (e) {
      const body = document.getElementById('sum-ai-body');
      if (body) body.innerHTML = '<span class="bad">생성 실패: ' + esc(e.message) + '</span>';
      btn.disabled = false; btn.textContent = '🤖 다시 시도';
    }
  };
}

function paintSummary(el, d, item, parts, flags) {
  flags = flags || {};
  const comp = compositeScore(parts);
  let html = '';
  if (comp) {
    const g = scoreGrade(comp.score);
    const R = 56, CIRC = 2 * Math.PI * R;
    html += `<div class="fit-top">
      <div class="gauge">
        <svg width="130" height="130" viewBox="0 0 130 130">
          <circle cx="65" cy="65" r="${R}" fill="none" stroke="#2a2e3a" stroke-width="11"/>
          <circle cx="65" cy="65" r="${R}" fill="none" stroke="${g.color}" stroke-width="11" stroke-linecap="round"
            stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - comp.score / 100)}"/>
        </svg>
        <div class="score"><b>${comp.score}</b><span>/ 100점</span></div>
      </div>
      <div class="fit-summary">
        <div class="fit-grade ${g.cls}">종합 ${g.txt}</div>
        <div class="fit-desc">재무·기술·미시·뉴스·업종·거시 <b>${comp.used.length}개 항목</b>을 가중 평균한 규칙 기반 종합 점수입니다. 가중치·근거는 아래에 공개됩니다.${flags.techPending || flags.newsPending ? '<br><span style="color:var(--accent)">⏳ 기술·뉴스 항목 분석 중 — 잠시 후 자동 반영됩니다.</span>' : ''}</div>
      </div>
    </div>`;
    html += `<div class="sum-opinion">🧭 <b>요약 의견:</b> ${ruleOpinion(parts, comp, item)}</div>`;
  } else {
    html += '<div class="d-loading">종합 점수를 계산할 데이터가 부족합니다.</div>';
  }
  SCORE_DIMS.forEach(dim => {
    const p = parts[dim.key];
    const pending = (dim.key === 'technical' && flags.techPending) || (dim.key === 'news' && flags.newsPending);
    const hasDetail = p && p.detail;
    const scopeTag = hasDetail ? `<span class="sd-scope ${p.detail.scope === '거시' ? 'macro' : 'micro'}">${esc(p.detail.scope)}</span>` : '';
    html += `<div class="sum-dim${hasDetail ? ' expandable' : ''}"><div class="sum-dim-head"><span>${dim.icon}</span><span class="sum-dim-name">${dim.label}</span>${scopeTag}<span class="sum-dim-wt">가중 ${Math.round(dim.weight * 100)}%</span>`;
    if (p) {
      const g = scoreGrade(p.score);
      html += `<span class="sum-dim-score ${g.cls}">${p.score}${hasDetail ? '<span class="sd-caret">▶</span>' : ''}</span></div>
        <div class="sum-track"><div class="sum-fill" style="width:${p.score}%;background:${g.color}"></div></div>
        <div class="sum-reasons">${esc(p.summary)}${p.reasons && p.reasons.length ? '<br>' + p.reasons.map(r => `<span>${esc(r)}</span>`).join('') : ''}${hasDetail ? '<br><span style="color:var(--accent)">▸ 어떤 데이터·지표로 평가했는지 보기</span>' : ''}</div>`;
      if (hasDetail) html += `<div class="sd-wrap" hidden>${renderScoreDetail(p.detail)}</div>`;
    } else {
      html += `<span class="sum-dim-na">${pending ? '분석 중…' : '데이터 없음'}</span></div>`;
    }
    html += `</div>`;
  });
  html += `<div id="sum-ai-zone" style="margin-top:8px"></div>`;
  html += `<div id="sum-chat-zone" style="margin-top:14px"></div>`;
  html += `<div class="disclaimer">⚠️ 종합·항목별 점수는 공개 데이터를 규칙으로 계산한 <b>참고용 지표</b>이며 투자 권유가 아닙니다. 업종·거시 항목은 당일·단기 데이터 비중이 커 변동이 큽니다. 투자 판단과 책임은 본인에게 있습니다.</div>`;
  el.innerHTML = html;
  el.querySelectorAll('.sum-dim.expandable').forEach(dimEl => {
    dimEl.addEventListener('click', () => {
      const w = dimEl.querySelector('.sd-wrap');
      const open = dimEl.classList.toggle('expanded');
      if (w) w.hidden = !open;
    });
  });
  if (comp) renderAiZone(item, d, parts, comp);
  // 대화형 질문은 최종 렌더 시에만 (진행 중 입력이 초기화되지 않게)
  if (comp && !flags.techPending && !flags.newsPending) renderStockChat(item, d, parts, comp);
  updateTabBadges(parts, comp);
}

function updateTabBadges(parts, comp) {
  const map = {
    'summary':  comp ? comp.score : null,
    'fund':     parts.finance   ? parts.finance.score   : null,
    'tech':     parts.technical ? parts.technical.score : null,
    'news':     parts.news      ? parts.news.score      : null,
  };
  for (const [tab, score] of Object.entries(map)) {
    const el = document.getElementById('tbadge-' + tab);
    if (!el) continue;
    if (score != null) {
      const g = scoreGrade(score);
      el.textContent = score;
      el.className = 'tab-score-badge ' + g.cls;
    } else {
      el.textContent = '';
      el.className = 'tab-score-badge';
    }
  }
}

// ── 종목 상세 대화형 AI 질의 ──
let stockChat = null; // { symbol, history:[{role,content}] }
function buildStockChatContext(item, d, parts, comp) {
  const lines = SCORE_DIMS.map(dm => {
    const p = parts[dm.key];
    return `- ${dm.label}: ${p ? p.score + '점 — ' + p.summary : '데이터 없음'}`;
  }).join('\n');
  const cur = quoteCache[item.symbol] && quoteCache[item.symbol].price;
  const target = d && d.consensus && numOf(d.consensus.priceTargetMean);
  const news = (typeof marketNewsItems !== 'undefined' && marketNewsItems ? marketNewsItems : []).slice(0, 3).map(n => n.title).join(' | ');
  return `[${item.name || item.symbol} (${item.symbol}) 데이터]\n종합점수: ${comp ? comp.score + '/100' : '계산중'}\n${lines}` +
    `${cur ? '\n현재가: ' + fmtPrice(cur, item.symbol) : ''}${target ? '\n애널리스트 평균 목표주가: ' + fmtPrice(target, item.symbol) : ''}` +
    `${news ? '\n최근 시장 뉴스: ' + news : ''}`;
}
function renderStockChat(item, d, parts, comp) {
  const zone = document.getElementById('sum-chat-zone');
  if (!zone) return;
  const hasKey = hasClaudeKey();
  zone.innerHTML = `<div style="font-size:0.86rem;font-weight:700;margin-bottom:8px">💬 이 종목에 대해 자유롭게 질문하세요</div>
    <div class="chat-box">
      <div class="chat-messages" id="sum-chat-msgs"></div>
      <div class="chat-input-row">
        <textarea id="sum-chat-input" placeholder="${hasKey ? "예: 최근 오른 이유는? · 가장 큰 리스크는? · 목표주가까지 여력은?" : 'AI 설정에서 Claude API 키를 입력하면 질문할 수 있습니다'}" ${hasKey ? '' : 'disabled'} aria-label="종목 질문 입력"></textarea>
        <button class="chat-send-btn" id="sum-chat-send" ${hasKey ? '' : 'disabled'}>✉️ 질문</button>
      </div>
      ${hasKey ? '' : '<div class="hint" style="margin-top:8px;font-size:0.74rem">🔑 우측 상단 ⚙️ AI 설정에서 키를 넣으면 활성화됩니다.</div>'}
    </div>`;
  // 세션 이어그리기 (같은 종목이면 기존 대화 복원)
  if (!stockChat || stockChat.symbol !== item.symbol) stockChat = { symbol: item.symbol, history: [] };
  const msgs = zone.querySelector('#sum-chat-msgs');
  stockChat.history.forEach(m => { const dv = document.createElement('div'); dv.className = 'chat-msg ' + m.role; dv.textContent = m.content; msgs.appendChild(dv); });
  if (!hasKey) return;
  const input = zone.querySelector('#sum-chat-input'), btn = zone.querySelector('#sum-chat-send');
  const send = () => handleStockChat(item, d, parts, comp, input, btn, msgs);
  btn.onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !btn.disabled) { e.preventDefault(); send(); } });
}
async function handleStockChat(item, d, parts, comp, input, btn, msgs) {
  const q = input.value.trim();
  if (!q) return;
  const u = document.createElement('div'); u.className = 'chat-msg user'; u.textContent = q; msgs.appendChild(u);
  input.value = ''; msgs.scrollTop = msgs.scrollHeight;
  stockChat.history.push({ role: 'user', content: q });
  if (stockChat.history.length > 8) stockChat.history = stockChat.history.slice(-8);
  btn.disabled = true; btn.textContent = '🤖 …';
  const a = document.createElement('div'); a.className = 'chat-msg assistant typing'; msgs.appendChild(a); msgs.scrollTop = msgs.scrollHeight;
  const sys = '당신은 한국어로 답하는 신중한 주식 애널리스트입니다. 제공된 정량 데이터만 근거로 답하고, 단정적 매매 단언은 피하며 리스크와 불확실성을 함께 짚습니다. 투자 권유가 아닌 참고 의견입니다. 3~5문장 이내로 답하세요.';
  const ctx = buildStockChatContext(item, d, parts, comp);
  // 멀티턴: 직전 대화 + 마지막 질문에 컨텍스트 부착
  const msgsApi = stockChat.history.map((m, i) =>
    i === stockChat.history.length - 1 ? { role: 'user', content: ctx + '\n\n질문: ' + m.content } : m);
  try {
    const reply = await claudeChat(sys, msgsApi);
    if (detailItem !== item) return;
    a.classList.remove('typing');
    a.innerHTML = esc(reply).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    stockChat.history.push({ role: 'assistant', content: reply });
  } catch (e) {
    a.classList.remove('typing');
    a.innerHTML = '<span class="bad">❌ ' + esc(e.message === 'NO_KEY' ? 'AI 설정에서 키를 입력하세요' : e.message) + '</span>';
  } finally {
    btn.disabled = false; btn.textContent = '✉️ 질문'; msgs.scrollTop = msgs.scrollHeight;
  }
}

async function renderSummaryTab(d, item) {
  const el = document.getElementById('tab-summary');
  const compute = (bars, newsScored) => ({
    finance: scoreFinanceVal(d, item),
    technical: bars ? scoreTechnicalVal(bars, item) : null,
    micro: scoreMicroVal(d),
    news: newsScored ? scoreNewsVal(newsScored) : null,
    industry: scoreIndustryVal(d, item),
    macro: scoreMacroVal()
  });
  // 1차 렌더: 기술·뉴스 보류 상태
  paintSummary(el, d, item, compute(null, null), { techPending: true, newsPending: true });
  // 기술 bars 확보 (renderTechTab이 채우는 techState 우선, 최대 ~12초 폴링)
  let bars = null;
  for (let i = 0; i < 30; i++) {
    if (detailItem !== item) return;
    if (techState && techState.item === item && techState.bars && techState.bars.length >= 30) { bars = techState.bars; break; }
    await new Promise(r => setTimeout(r, 400));
  }
  if (!bars) { // 폴링 실패 시 직접 로드 (캐시 활용 · 기술탭과 동일하게 5년)
    try {
      const r = await fetchChart(item.symbol, '5y', '1d');
      const q = r.indicators.quote[0];
      bars = (r.timestamp || []).map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: (q.volume && q.volume[i]) || 0 })).filter(b => b.close != null && b.open != null && b.high != null && b.low != null);
      if (bars.length < 30) bars = null;
    } catch (e) {}
  }
  // 뉴스 점수
  let newsScored = null;
  try { newsScored = await fetchNewsScored(item); } catch (e) {}
  if (detailItem !== item) return;
  // 2차 렌더: 전체 반영
  paintSummary(el, d, item, compute(bars, newsScored), {});
}

