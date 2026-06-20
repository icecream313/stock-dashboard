// ───────────────────────── ① 거시 지표 ─────────────────────────
async function renderMacro(noCache) {
  const strip = document.getElementById('macro-strip');
  if (!strip.children.length) {
    MACRO_GROUPS.forEach(g => {
      const row = document.createElement('div');
      row.className = 'macro-group-row';
      row.dataset.group = g.key;
      const lbl = document.createElement('div');
      lbl.className = 'macro-group-label';
      lbl.textContent = g.label;
      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'macro-group-chips';
      MACRO.filter(m => m.group === g.key).forEach(m => {
        const chip = document.createElement('div');
        chip.className = 'macro-chip clickable';
        chip.id = 'macro-' + m.symbol.replace(/[^A-Za-z0-9]/g, '');
        chip.innerHTML = `<div class="label">${m.label}</div><div class="price">…</div><div class="chg flat">—</div>`;
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('aria-label', m.label + ' 상세');
        chip.onclick = () => openDetail(macroItem(m));
        chip.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(macroItem(m)); } };
        chipsWrap.appendChild(chip);
      });
      row.appendChild(lbl);
      row.appendChild(chipsWrap);
      strip.appendChild(row);
    });
  }
  try {
    const sparkSyms = MACRO.filter(m => !m.chartOnly).map(m => m.symbol);
    const chartMacros = MACRO.filter(m => m.chartOnly);
    // 스파크 API와 차트 API 결과를 완전히 분리된 객체에 저장 (old 캐시 오염 방지)
    const [sparkData, chartData] = await Promise.all([
      fetchSpark(sparkSyms, '1d', '15m', noCache),
      Promise.all(chartMacros.map(async m => {
        try {
          const r = await fetchChart(m.symbol, '5d', '1d', noCache);
          const price = r.meta?.regularMarketPrice ?? lastValid(r.indicators?.quote?.[0]?.close);
          const prev = r.meta?.chartPreviousClose ?? r.meta?.previousClose;
          return [m.symbol, { close: [price], previousClose: prev }];
        } catch (e) { return [m.symbol, null]; }
      })).then(entries => Object.fromEntries(entries))
    ]);
    MACRO.forEach(m => {
      const chip = document.getElementById('macro-' + m.symbol.replace(/[^A-Za-z0-9]/g, ''));
      if (!chip) return;
      const d = m.chartOnly ? chartData[m.symbol] : sparkData[m.symbol];
      if (!d) { chip.querySelector('.price').textContent = '—'; return; }
      const price = m.chartOnly ? (d.close[0] ?? null) : lastValid(d.close);
      if (m.symbol === 'KRW=X' && price) { usdkrw = price; updatePortfolio(); }
      macroData[m.symbol] = { price, prev: d.previousClose };
      const c = chgInfo(price, d.previousClose);
      chip.querySelector('.price').textContent = m.fmt === 'pct' ? price != null ? price.toFixed(2) + '%' : '—' : fmtPrice(price, m.symbol, m.fmt);
      const chg = chip.querySelector('.chg');
      chg.className = 'chg ' + c.cls;
      chg.textContent = c.text;
      // 급등/급락 하이라이트 (±3% 이상)
      const pct = (price != null && d.previousClose) ? (price - d.previousClose) / d.previousClose * 100 : 0;
      chip.classList.remove('chip-surge', 'chip-plunge');
      if (pct >= 3) chip.classList.add('chip-surge');
      else if (pct <= -3) chip.classList.add('chip-plunge');
    });
    const sub = document.getElementById('macro-pb-sub');
    if (sub) sub.innerHTML = '지수·환율·금리·원자재 · 칩을 누르면 차트와 과열 분석이 열립니다 · <span style="color:var(--accent)">🕒 기준 ' + fmtClock(Date.now()) + '</span>';
    updateYieldSpread();
    if (typeof renderMainInfographic === 'function') renderMainInfographic();
    if (typeof renderTopInsights === 'function') renderTopInsights();
  } catch (e) {
    document.querySelectorAll('.macro-chip .price').forEach(p => { if (p.textContent === '…') p.textContent = '오류'; });
  }
}

function updateYieldSpread() {
  const t10 = macroData['^TNX'], t3m = macroData['^IRX'];
  const banner = document.getElementById('yield-spread-banner');
  if (!banner) return;
  if (!t10 || t10.price == null || !t3m || t3m.price == null) { banner.hidden = true; return; }
  const spread = t10.price - t3m.price;
  const inverted = spread < 0;
  banner.hidden = false;
  banner.className = 'yield-spread-banner' + (inverted ? ' inverted' : ' normal');
  banner.innerHTML = inverted
    ? `⚠️ <b>장단기 금리 역전</b> — 미국채 10년(${t10.price.toFixed(2)}%) vs 3개월(${t3m.price.toFixed(2)}%), 스프레드 <b>${spread.toFixed(2)}%p</b>. 역전은 과거 경기침체 선행지표로 알려져 있습니다.`
    : `미국채 금리 스프레드 (10Y − 3M): <b class="good">+${spread.toFixed(2)}%p</b> — 정상 상태`;
}

// ───────────────────────── ② 관심종목 카드 ─────────────────────────
// 종목 카테고리 분류 (그룹 헤더용)
const WL_GROUPS = [
  { cat: 'kr',  label: '🇰🇷 한국주식' },
  { cat: 'us',  label: '🇺🇸 미국주식' },
  { cat: 'etc', label: '🌏 기타' }
];
function categoryOf(symbol) {
  if (isKorean(symbol)) return 'kr';
  if (/^[A-Za-z][A-Za-z.\-]*$/.test(symbol)) return 'us'; // 순수 영문 티커 = 미국
  return 'etc';
}

function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card' + (item.symbol === selected.symbol ? ' selected' : '');
  // role=button은 내부에 삭제/목표가 버튼·입력이 중첩되어 ARIA 위반 → 부여하지 않고
  // tabindex+keydown으로 키보드 열기만 지원 (포커스 링은 [tabindex]:focus-visible로 처리)
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', (item.name || item.symbol) + ' — Enter로 상세 열기');
  const tp = getWatchlistAlerts()[item.symbol] || '';
  card.innerHTML = `
    <button class="del" title="삭제" aria-label="${esc(item.name || item.symbol)} 삭제">✕</button>
    <div class="name">${esc(item.name || item.symbol)}</div>
    <div class="sym">${esc(item.symbol)}</div>
    <div class="price">…</div>
    <div class="chg flat">—</div>
    <div class="rets"></div>
    <div class="holding-line" hidden></div>
    <canvas></canvas>
    <div class="tp-row">
      <span class="tp-label">🔔 목표가</span>
      <input class="tp-input" type="number" min="0" step="any" placeholder="알림 받을 가격" value="${tp}" aria-label="${esc(item.name || item.symbol)} 목표가" title="현재가가 목표가에 도달하면 브라우저 알림">
      ${tp ? '<button class="tp-clear" title="목표가 삭제" aria-label="목표가 삭제">✕</button>' : ''}
    </div>`;
  card.querySelector('.del').onclick = e => {
    e.stopPropagation();
    if (!confirm(`'${item.name || item.symbol}' 종목을 삭제할까요?`)) return;
    watchlist = watchlist.filter(w => w.symbol !== item.symbol);
    saveList();
    if (selected.symbol === item.symbol && watchlist.length) selectStock(watchlist[0]);
    renderWatchlist();
  };
  // 목표가 입력 (카드 클릭/키보드와 충돌 방지)
  const tpInput = card.querySelector('.tp-input');
  tpInput.onclick = e => e.stopPropagation();
  tpInput.onkeydown = e => e.stopPropagation();
  tpInput.onchange = () => {
    const v = parseFloat(tpInput.value);
    const a = getWatchlistAlerts();
    if (!v || v <= 0) delete a[item.symbol]; else a[item.symbol] = v;
    try { localStorage.setItem('watchlist-alerts', JSON.stringify(a)); } catch (e) {}
    renderWatchlist();
  };
  const tpClear = card.querySelector('.tp-clear');
  if (tpClear) tpClear.onclick = e => {
    e.stopPropagation();
    const a = getWatchlistAlerts(); delete a[item.symbol];
    try { localStorage.setItem('watchlist-alerts', JSON.stringify(a)); } catch (x) {}
    renderWatchlist();
  };
  const open = () => { selectStock(item); openDetail(item); };
  card.onclick = open;
  card.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); open(); }
  });
  card.dataset.symbol = item.symbol;
  return card;
}

function renderWatchlist(noCache) {
  const root = document.getElementById('watchlist');
  root.innerHTML = '';
  if (!watchlist.length) {
    root.innerHTML = '<div class="hint" style="padding:18px 4px">관심종목이 없습니다. 위 검색창에서 종목 이름을 검색해 추가해 보세요.</div>';
    renderWatchlistStrip();
    updatePortfolio();
    return;
  }
  // 카테고리 그룹별 섹션 렌더 (빈 그룹은 숨김)
  WL_GROUPS.forEach(g => {
    const items = watchlist.filter(it => categoryOf(it.symbol) === g.cat);
    if (!items.length) return;
    const group = document.createElement('div');
    group.className = 'wl-group';
    group.dataset.cat = g.cat;
    group.innerHTML = `<h3 class="wl-group-title">${g.label} <span class="wl-group-count">${items.length}</span></h3><div class="cards"></div>`;
    const box = group.querySelector('.cards');
    items.forEach(item => box.appendChild(buildCard(item)));
    root.appendChild(group);
  });
  renderWatchlistStrip();
  fillCards(noCache);
}

// 관심종목 지수형 칩 스트립 (거시 지수 칩과 동일한 시각 언어, 미시 섹션)
function renderWatchlistStrip() {
  const strip = document.getElementById('wl-strip');
  if (!strip) return;
  if (!watchlist.length) {
    strip.innerHTML = '<div class="wl-strip-empty">관심종목을 추가하면 여기에 한눈에 보기로 표시됩니다.</div>';
    return;
  }
  strip.innerHTML = '';
  watchlist.forEach(item => {
    const q = quoteCache[item.symbol];
    const chip = document.createElement('div');
    chip.className = 'wl-chip';
    let priceTxt = '…', chgHtml = '<div class="wc-chg flat">—</div>';
    if (q && q.price != null) {
      priceTxt = fmtPrice(q.price, item.symbol);
      const c = chgInfo(q.price, q.prev);
      chgHtml = `<div class="wc-chg ${c.cls}">${c.text}</div>`;
    }
    chip.innerHTML = `<div class="wc-name">${esc(item.name || item.symbol)}</div><div class="wc-price">${priceTxt}</div>${chgHtml}`;
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-label', (item.name || item.symbol) + ' 상세 보기');
    const open = () => { selectStock(item); openDetail(item); };
    chip.onclick = open;
    chip.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    strip.appendChild(chip);
  });
}

// 모든 카드를 spark 호출로 채운다
// ① 3mo/1d — 스파크라인·기간별 수익률용 (일봉)
// ② 1d/15m — 장중 실시간 시세 + 전일 종가 대비 등락용 (매크로 칩과 동일 방식)
async function fillCards(noCache) {
  if (!watchlist.length) return;
  const syms = watchlist.map(w => w.symbol);
  let data = null, intraday = null;
  try { data = await fetchSpark(syms, '3mo', '1d', noCache); } catch (e) {}
  try { intraday = await fetchSpark(syms, '1d', '15m', noCache); } catch (e) {}
  watchlist.forEach(item => {
    const card = document.querySelector(`.card[data-symbol="${CSS.escape(item.symbol)}"]`);
    if (!card) return;
    const d = data && data[item.symbol];
    const closes = d ? (d.close || []).filter(v => v != null) : [];
    if (!closes.length) {
      card.querySelector('.price').textContent = '—';
      const chg = card.querySelector('.chg');
      chg.className = 'err';
      chg.innerHTML = '데이터 미로드 <button class="retry-inline" aria-label="시세 다시 불러오기">다시 시도</button>';
      const rb = chg.querySelector('.retry-inline');
      if (rb) rb.onclick = e => { e.stopPropagation(); fillCards(true); };
      return;
    }
    // 장중 데이터가 있으면 인트라데이 시세 + previousClose로 당일 등락 계산
    const id = intraday && intraday[item.symbol];
    const idPrice = id ? lastValid(id.close) : null;
    const price = idPrice != null ? idPrice : closes[closes.length - 1];
    const prev = id && id.previousClose ? id.previousClose
      : (closes.length > 1 ? closes[closes.length - 2] : null);
    // 기간별 수익률: 1주(5거래일) · 1개월(21거래일) · 3개월(전체) — 일봉 기준
    const retOf = n => {
      const base = closes[closes.length - 1 - n];
      return base ? (closes[closes.length - 1] - base) / base * 100 : null;
    };
    const ret1m = retOf(21);
    quoteCache[item.symbol] = { price, prev, ret1m };
    const c = chgInfo(price, prev);
    card.querySelector('.price').textContent = fmtPrice(price, item.symbol);
    const chg = card.querySelector('.chg');
    chg.className = 'chg ' + c.cls;
    chg.textContent = '전일 대비 ' + c.text;
    const periods = [['1주', retOf(5)], ['1개월', ret1m], ['3개월', closes.length > 1 ? (closes[closes.length - 1] - closes[0]) / closes[0] * 100 : null]];
    card.querySelector('.rets').innerHTML = periods
      .filter(p => p[1] != null)
      .map(p => {
        const cls = p[1] > 0 ? 'up' : p[1] < 0 ? 'down' : 'flat';
        return `<span class="ret-chip">${p[0]} <b class="${cls}">${p[1] >= 0 ? '+' : ''}${p[1].toFixed(1)}%</b></span>`;
      }).join('');
    fillHoldingLine(card, item);
    if (!item.name) fillName(item, card); // 이름이 없으면 비동기로 종목명 조회
    // 스파크라인 색은 3개월 추세 기준
    const trend = closes[closes.length - 1] > closes[0] ? 'up'
      : closes[closes.length - 1] < closes[0] ? 'down' : 'flat';
    drawSparkline(card.querySelector('canvas'), closes, trend);
  });
  sortCards();
  updatePortfolio();
  renderWatchlistStrip(); // 시세 채워진 뒤 칩 스트립 갱신
  checkPriceAlerts();      // 목표가 도달 알림 체크
  if (typeof renderMainInfographic === 'function') renderMainInfographic();
}

// ── 보유 손익 (수량·평단가는 상세 화면 개요 탭에서 입력) ──
function holdingPL(item) {
  const q = quoteCache[item.symbol];
  if (!item.qty || !item.avg || !q || !q.price) return null;
  const cost = item.qty * item.avg;
  const value = item.qty * q.price;
  return { cost, value, diff: value - cost, pct: (value - cost) / cost * 100 };
}

function fillHoldingLine(card, item) {
  const line = card.querySelector('.holding-line');
  const pl = holdingPL(item);
  if (!pl) { line.hidden = true; return; }
  const cls = pl.diff > 0 ? 'up' : pl.diff < 0 ? 'down' : 'flat';
  line.hidden = false;
  line.innerHTML = `💼 ${item.qty.toLocaleString()}주 보유 · 손익 <b class="${cls}">${pl.diff >= 0 ? '+' : ''}${fmtPrice(Math.abs(pl.diff), item.symbol).replace(/^([₩$])/, pl.diff < 0 ? '-$1' : '$1')} (${pl.pct >= 0 ? '+' : ''}${pl.pct.toFixed(1)}%)</b>`;
}

// ── 핵심 숫자 히어로 (항상 표시: 보유 있으면 평가금액·손익, 없으면 관심종목 당일 요약) ──
function updateHero() {
  const card = document.getElementById('hero-card');
  if (!card) return;
  const won = v => '₩' + Math.round(Math.abs(v)).toLocaleString('ko-KR');
  const holdings = watchlist.filter(w => w.qty && w.avg && quoteCache[w.symbol] && quoteCache[w.symbol].price);
  const needFx = holdings.some(w => !isKorean(w.symbol));
  if (holdings.length && (!needFx || usdkrw)) {
    let cost = 0, value = 0, daily = 0;
    holdings.forEach(w => {
      const pl = holdingPL(w), q = quoteCache[w.symbol], fx = isKorean(w.symbol) ? 1 : usdkrw;
      cost += pl.cost * fx; value += pl.value * fx;
      if (q.prev != null) daily += (q.price - q.prev) * w.qty * fx;
    });
    const diff = value - cost, pct = cost ? diff / cost * 100 : 0;
    const dcls = daily > 0 ? 'up' : daily < 0 ? 'down' : 'flat';
    const tcls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    card.innerHTML =
      `<div class="hero-block main"><span class="h-label">💼 보유 평가금액</span><span class="h-value">${won(value)}</span></div>
       <div class="hero-sep"></div>
       <div class="hero-block"><span class="h-label">당일 손익</span><span class="h-value ${dcls}">${daily >= 0 ? '+' : '-'}${won(daily)}</span></div>
       <div class="hero-block"><span class="h-label">누적 손익</span><span class="h-value ${tcls}">${diff >= 0 ? '+' : '-'}${won(diff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span></div>`;
    return;
  }
  // 관심종목 모드 — 당일 등락 요약
  const qs = watchlist.map(w => quoteCache[w.symbol]).filter(q => q && q.price != null && q.prev != null);
  if (!qs.length) {
    card.innerHTML = `<div class="hero-block main"><span class="h-label">⭐ 관심종목</span><span class="h-value flat" style="font-size:22px">시세 불러오는 중…</span></div>`;
    return;
  }
  let up = 0, down = 0, flat = 0, sum = 0;
  qs.forEach(q => { const c = (q.price - q.prev) / q.prev * 100; sum += c; if (c > 0) up++; else if (c < 0) down++; else flat++; });
  const avg = sum / qs.length, acls = avg > 0 ? 'up' : avg < 0 ? 'down' : 'flat';
  card.innerHTML =
    `<div class="hero-block main"><span class="h-label">⭐ 관심종목 ${qs.length}개 · 당일 평균</span><span class="h-value ${acls}">${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%</span></div>
     <div class="hero-sep"></div>
     <div class="hero-block"><span class="h-label">상승</span><span class="h-value up">${up}</span></div>
     <div class="hero-block"><span class="h-label">하락</span><span class="h-value down">${down}</span></div>
     <div class="hero-block"><span class="h-label">보합</span><span class="h-value flat">${flat}</span></div>`;
}

// ── 가격 알림 (목표가 도달 시 브라우저 알림) ──
function getWatchlistAlerts() {
  try { return JSON.parse(localStorage.getItem('watchlist-alerts') || '{}'); } catch (e) { return {}; }
}
function checkPriceAlerts() {
  const alerts = getWatchlistAlerts();
  let alerted = {};
  try { alerted = JSON.parse(localStorage.getItem('watchlist-alerted') || '{}'); } catch (e) {}
  watchlist.forEach(item => {
    const target = alerts[item.symbol];
    const q = quoteCache[item.symbol];
    if (!target || !q || q.price == null) return;
    const reached = q.price >= target;
    if (reached && !alerted[item.symbol]) {
      notifyPriceTarget(item, q.price, target);
      alerted[item.symbol] = true;
    } else if (!reached && alerted[item.symbol]) {
      delete alerted[item.symbol]; // 이탈하면 다음 도달 때 다시 알림
    }
  });
  try { localStorage.setItem('watchlist-alerted', JSON.stringify(alerted)); } catch (e) {}
}
function notifyPriceTarget(item, current, target) {
  const title = `🔔 ${item.name || item.symbol} 목표가 도달`;
  const body = `현재가 ${fmtPrice(current, item.symbol)} · 목표가 ${fmtPrice(target, item.symbol)}`;
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'price-' + item.symbol }); } catch (e) {}
  }
  if (typeof setDataStatus === 'function') setDataStatus(title + ' — ' + body);
}

// ── 발견 섹션에서 클릭 시 빠른 추가 (검색 없이 직접 추가) ──
function quickAddStock(symbol, name) {
  const existing = watchlist.find(w => w.symbol === symbol);
  if (existing) { selectStock(existing); openDetail(existing); return; }
  const item = { symbol, name };
  watchlist.push(item);
  saveList();
  renderWatchlist();
  selectStock(item);
  openDetail(item);
}

// ── 포트폴리오 집중도·분산 분석 (2종목 이상 보유 시) ──
function renderPortfolioAnalysis() {
  const sec = document.getElementById('portfolio-analysis');
  if (!sec) return;
  const holds = watchlist.filter(w => w.qty && w.avg && quoteCache[w.symbol] && quoteCache[w.symbol].price);
  const needFx = holds.some(w => !isKorean(w.symbol));
  if (holds.length < 2 || (needFx && !usdkrw)) { sec.hidden = true; return; }
  const valOf = w => { const q = quoteCache[w.symbol], fx = isKorean(w.symbol) ? 1 : usdkrw; return w.qty * q.price * fx; };
  const total = holds.reduce((a, w) => a + valOf(w), 0);
  if (!total) { sec.hidden = true; return; }
  const rows = holds.map(w => ({ name: w.name || w.symbol, w: valOf(w) / total * 100 })).sort((a, b) => b.w - a.w);
  const top1 = rows[0].w, top3 = rows.slice(0, 3).reduce((a, r) => a + r.w, 0);
  const krW = holds.filter(w => isKorean(w.symbol)).reduce((a, w) => a + valOf(w), 0) / total * 100;
  const concCls = top1 >= 50 ? 'bad' : top1 >= 30 ? 'mid' : 'good';
  let h = `<div class="wl-head"><h2>🧩 포트폴리오 분석 <span style="font-size:0.74rem;color:var(--muted);font-weight:400">— 집중도·분산</span></h2></div>`;
  h += `<div class="pf-bar" style="margin-bottom:12px">
    <div class="pf-item"><div class="k">보유 종목</div><div class="v">${holds.length}개</div></div>
    <div class="pf-item"><div class="k">최대 단일 비중</div><div class="v ${concCls}">${top1.toFixed(1)}%</div></div>
    <div class="pf-item"><div class="k">상위 3종목</div><div class="v ${top3 >= 70 ? 'bad' : top3 >= 50 ? 'mid' : 'good'}">${top3.toFixed(1)}%</div></div>
    <div class="pf-item"><div class="k">국가 배분</div><div class="v" style="font-size:0.9rem">🇰🇷 ${krW.toFixed(0)}% · 🇺🇸 ${(100 - krW).toFixed(0)}%</div></div></div>`;
  h += `<div style="display:flex;flex-direction:column;gap:7px">`;
  rows.forEach(r => {
    h += `<div style="display:flex;align-items:center;gap:10px">
      <div style="width:120px;font-size:0.8rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0">${esc(r.name)}</div>
      <div style="flex:1;height:14px;background:var(--bg-soft);border-radius:7px;overflow:hidden"><div style="width:${r.w.toFixed(1)}%;height:100%;background:var(--accent);border-radius:7px"></div></div>
      <div style="width:46px;text-align:right;font-size:0.82rem;font-weight:700;flex-shrink:0">${r.w.toFixed(1)}%</div></div>`;
  });
  h += `</div><div class="hint" style="margin-top:10px">💡 한 종목 비중이 클수록 그 종목 급락에 포트폴리오 전체가 흔들립니다. 최대 단일 비중 <b>50% 이상이면 과집중</b> 경고. (단일 5%·섹터 25% 상한은 대형 포트 기준의 분산 가이드로 참고용)</div>`;
  sec.hidden = false;
  sec.innerHTML = h;
}

// ── 포트폴리오 총 요약 (미국 종목은 원/달러 환율로 환산) ──
function updatePortfolio() {
  updateHero(); // 히어로는 항상 갱신 (보유/관심 모드 자동 판단)
  renderPortfolioAnalysis(); // 집중도·분산 분석
  const section = document.getElementById('portfolio-section');
  const bar = document.getElementById('portfolio-bar');
  const holdings = watchlist.filter(w => w.qty && w.avg && quoteCache[w.symbol] && quoteCache[w.symbol].price);
  if (!holdings.length) { section.hidden = true; return; }
  const needFx = holdings.some(w => !isKorean(w.symbol));
  if (needFx && !usdkrw) { section.hidden = true; return; } // 환율 로드 후 다시 호출됨
  let cost = 0, value = 0;
  holdings.forEach(w => {
    const pl = holdingPL(w);
    const fx = isKorean(w.symbol) ? 1 : usdkrw;
    cost += pl.cost * fx;
    value += pl.value * fx;
  });
  const diff = value - cost, pct = cost ? diff / cost * 100 : 0;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const won = v => '₩' + Math.round(Math.abs(v)).toLocaleString('ko-KR');
  section.hidden = false;
  bar.innerHTML = `
    <div class="pf-item"><div class="k">💼 보유 평가금액</div><div class="v">${won(value)}</div></div>
    <div class="pf-item"><div class="k">매입금액</div><div class="v">${won(cost)}</div></div>
    <div class="pf-item"><div class="k">평가손익</div><div class="v ${cls}">${diff >= 0 ? '+' : '-'}${won(diff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</div></div>
    <div class="pf-item"><div class="k">환율 적용</div><div class="v" style="font-size:0.85rem;color:var(--muted)">${needFx && usdkrw ? '$1 = ₩' + Math.round(usdkrw).toLocaleString() : '원화 종목만'}</div></div>`;
}

// ── 카드 정렬 ──
const sortSel = document.getElementById('wl-sort');
sortSel.value = localStorage.getItem('wl-sort') || 'added';
sortSel.onchange = () => { localStorage.setItem('wl-sort', sortSel.value); sortCards(); };

function sortCards() {
  const mode = sortSel.value;
  const keyOf = sym => {
    const item = watchlist.find(w => w.symbol === sym);
    const q = quoteCache[sym] || {};
    if (mode === 'chg') return q.price && q.prev ? (q.price - q.prev) / q.prev : -Infinity;
    if (mode === 'ret1m') return q.ret1m != null ? q.ret1m : -Infinity;
    if (mode === 'pl') { const pl = item && holdingPL(item); return pl ? pl.pct : -Infinity; }
    return 0;
  };
  // 각 카테고리 그룹 내부에서 정렬 (그룹 간 순서는 고정)
  document.querySelectorAll('#watchlist .wl-group .cards').forEach(grid => {
    const cards = [...grid.querySelectorAll('.card')];
    cards.sort((a, b) => {
      if (mode === 'added') // 저장된(watchlist) 순서
        return watchlist.findIndex(w => w.symbol === a.dataset.symbol) - watchlist.findIndex(w => w.symbol === b.dataset.symbol);
      if (mode === 'name') {
        const an = (watchlist.find(w => w.symbol === a.dataset.symbol) || {}).name || a.dataset.symbol;
        const bn = (watchlist.find(w => w.symbol === b.dataset.symbol) || {}).name || b.dataset.symbol;
        return an.localeCompare(bn, 'ko');
      }
      return keyOf(b.dataset.symbol) - keyOf(a.dataset.symbol); // 내림차순
    });
    cards.forEach(c => grid.appendChild(c));
  });
}

// ── 관심종목 공유 링크 (기기 간 이동: localStorage가 브라우저별이라 링크로 전달) ──
document.getElementById('share-btn').onclick = async () => {
  const payload = watchlist.map(w => ({ symbol: w.symbol, name: w.name, reuters: w.reuters }));
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const url = location.origin + location.pathname + '#wl=' + b64;
  try {
    await navigator.clipboard.writeText(url);
    alert('관심종목 목록 링크가 복사되었습니다.\n폰 등 다른 기기의 브라우저에 붙여넣어 열면 목록을 그대로 가져옵니다.');
  } catch (e) {
    prompt('아래 링크를 복사해 다른 기기에서 여세요:', url);
  }
};

// 공유 링크로 접속한 경우 목록 가져오기
(() => {
  const m = location.hash.match(/^#wl=(.+)$/);
  if (!m) return;
  try {
    const imported = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
    if (Array.isArray(imported) && imported.length && imported[0].symbol) {
      if (confirm(`공유받은 관심종목 ${imported.length}개를 가져올까요?\n(현재 목록은 대체되며, 보유 정보는 유지되지 않습니다)`)) {
        watchlist = imported;
        saveList();
        selected = watchlist[0];
      }
    }
  } catch (e) {}
  history.replaceState(null, '', location.pathname + location.search);
})();

async function fillName(item, card) {
  try {
    const r = await fetchChart(item.symbol, '1d', '15m');
    item.name = r.meta.shortName || r.meta.longName || item.symbol;
    card.querySelector('.name').textContent = item.name;
    saveList();
    if (selected.symbol === item.symbol) renderSymbolNews();
  } catch (e) {}
}

function drawSparkline(canvas, data, cls) {
  if (!data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const color = cls === 'up' ? '#f04452' : cls === 'down' ? '#3182f6' : '#8a90a3';
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 4 - ((v - min) / span) * (h - 8);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + '33');
  grad.addColorStop(1, color + '00');
  ctx.fillStyle = grad;
  ctx.fill();
}

// ───────────────────────── ③ 뉴스 (구글뉴스 RSS) ─────────────────────────
// 신뢰 소스 화이트리스트 — 부분일치(매체명이 source나 제목에 포함되면 통과)
const TRUSTED_SOURCES = [
  // 국내 경제·종합지
  '연합뉴스', '연합인포맥스', '한국경제', '한경', '매일경제', '매경', '머니투데이',
  '서울경제', '이데일리', '파이낸셜뉴스', '조선비즈', '비즈워치', '인포스탁',
  '헤럴드경제', '아시아경제', '뉴스핌', '뉴시스', '데일리안', 'KBS', 'MBC', 'SBS',
  'YTN', '한겨레', '조선일보', '중앙일보', '동아일보', '매일경제TV', '한국경제TV',
  '더벨', '딜사이트', 'EBN', '디지털타임스', '전자신문', 'ZDNet', '블로터',
  // 해외 신뢰 매체
  'Reuters', 'Bloomberg', 'Wall Street Journal', 'WSJ', 'CNBC', 'Financial Times',
  'MarketWatch', "Barron's", 'Barron', 'Yahoo Finance', 'The Motley Fool',
  'Investing.com', 'Seeking Alpha', 'Forbes', 'Business Insider', 'Associated Press',
  'Nikkei', 'Financial Post', 'TheStreet', "Investor's Business Daily"
];
let newsTrustedOnly = localStorage.getItem('newsTrustedOnly') !== '0'; // 기본: 신뢰소스만
function isTrustedSource(source, title) {
  const hay = ((source || '') + ' ' + (title || '')).toLowerCase();
  return TRUSTED_SOURCES.some(s => hay.includes(s.toLowerCase()));
}

// 뉴스 제목 키워드 기반 투자점수 (가중치 2 = 강한 신호, 1 = 일반 신호)
const NEWS_POS = [['급등', 2], ['신고가', 2], ['상한가', 2], ['어닝서프라이즈', 2], ['흑자전환', 2], ['흑자 전환', 2],
  ['목표가 상향', 2], ['목표주가 상향', 2], ['사상 최대', 2], ['최대 실적', 2], ['호실적', 2], ['깜짝 실적', 2],
  ['수주', 1], ['상승', 1], ['강세', 1], ['반등', 1], ['호재', 1], ['개선', 1], ['성장', 1], ['확대', 1],
  ['돌파', 1], ['상향', 1], ['최고치', 1], ['랠리', 1], ['자사주 매입', 2], ['배당 확대', 2], ['주주환원', 1],
  ['인수', 1], ['협력', 1], ['공급 계약', 1], ['공급계약', 1], ['승인', 1], ['출시', 1], ['신기록', 1], ['질주', 1], ['순매수', 1]];
const NEWS_NEG = [['급락', 2], ['신저가', 2], ['하한가', 2], ['어닝쇼크', 2], ['어닝 쇼크', 2], ['적자전환', 2], ['적자 전환', 2],
  ['목표가 하향', 2], ['목표주가 하향', 2], ['상장폐지', 2], ['압수수색', 2], ['횡령', 2], ['배임', 2], ['파산', 2], ['리콜', 2],
  ['하락', 1], ['약세', 1], ['악재', 1], ['부진', 1], ['감소', 1], ['축소', 1], ['우려', 1], ['리스크', 1],
  ['소송', 1], ['규제', 1], ['벌금', 1], ['제재', 1], ['철수', 1], ['적자', 1], ['쇼크', 1], ['급감', 1],
  ['경고', 1], ['최저치', 1], ['불확실', 1], ['둔화', 1], ['하향', 1], ['폭락', 2], ['순매도', 1]];

function scoreNews(title) {
  let s = 0;
  NEWS_POS.forEach(([w, p]) => { if (title.includes(w)) s += p; });
  NEWS_NEG.forEach(([w, p]) => { if (title.includes(w)) s -= p; });
  return s;
}
function newsBadge(s) {
  if (s >= 2) return ['buy', '호재 +' + s];
  if (s > 0) return ['buy', '호재 +' + s];
  if (s <= -2) return ['sell', '악재 ' + s];
  if (s < 0) return ['sell', '악재 ' + s];
  return ['neutral', '중립'];
}

// 뉴스 데이터원: 네이버 금융 뉴스 API (구글뉴스 RSS는 무료 프록시에 차단당해 폐기)
//  - 국내·시장: m.stock.naver.com/api/news/stock/{종목코드 또는 KOSPI}
//  - 미국:      api.stock.naver.com/news/stock/{로이터코드}
// 네이버 호스트는 corsfix 프록시로 안정적으로 열려 콘솔 에러 폭주·미로드 문제 해결
function naverDateToDate(s) {
  s = String(s || '');
  if (s.length < 8) return new Date();
  const dt = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +(s.slice(8, 10) || '0'), +(s.slice(10, 12) || '0'));
  return isNaN(dt) ? new Date() : dt;
}
function decodeEntities(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// 종목/지수 → 뉴스 조회 대상
function newsTargetFor(item) {
  if (!item) return { kind: 'market', code: 'KOSPI' };
  if (item.isIndex) return { kind: 'market', code: item.naver || 'KOSPI' }; // 미국 지수는 국내 시장 뉴스로 대체
  if (isKorean(item.symbol)) return { kind: 'stock', kr: true, code: item.symbol.split('.')[0] };
  return { kind: 'stock', kr: false, reuters: item.reuters, symbol: item.symbol };
}
// 네이버 뉴스 원본 → 정규화 [{title,link,source,pub,s}]
async function naverNewsRaw(target) {
  let url;
  if (target.kind === 'market') url = 'https://m.stock.naver.com/api/news/stock/' + (target.code || 'KOSPI');
  else if (target.kr) url = 'https://m.stock.naver.com/api/news/stock/' + target.code;
  else {
    let reuters = target.reuters;
    if (!reuters && target.symbol) { try { reuters = await resolveReuters(target.symbol); } catch (e) {} }
    if (!reuters) throw new Error('no reuters');
    url = 'https://api.stock.naver.com/news/stock/' + reuters;
  }
  const j = await fetchViaProxy(url, false, x => Array.isArray(x)); // 배열이 아니면(에러페이지 등) 다음 프록시
  const out = [], seen = new Set();
  (Array.isArray(j) ? j : []).forEach(g => (g.items || []).forEach(it => {
    const id = it.id || (it.officeId + '/' + it.articleId);
    if (seen.has(id)) return; seen.add(id);
    const title = decodeEntities(it.titleFull || it.title || '');
    if (!title) return;
    out.push({
      title,
      link: it.mobileNewsUrl || ('https://n.news.naver.com/mnews/article/' + it.officeId + '/' + it.articleId),
      source: it.officeName || '',
      pub: naverDateToDate(it.datetime),
      s: scoreNews(title)
    });
  }));
  out.sort((a, b) => b.pub - a.pub);
  return out.slice(0, 25);
}

async function loadNews(el, target, attempt) {
  el.innerHTML = '<div class="loading">불러오는 중…</div>';
  try {
    let scored = await naverNewsRaw(target);
    if (!scored.length) throw new Error('empty');
    el.innerHTML = '';
    // 신뢰 소스 필터 (토글 ON & 필터 후 1건 이상일 때만 적용)
    let filteredOut = 0;
    if (newsTrustedOnly) {
      const kept = scored.filter(x => isTrustedSource(x.source, x.title));
      if (kept.length) { filteredOut = scored.length - kept.length; scored = kept; }
    }
    const nPos = scored.filter(x => x.s > 0).length, nNeg = scored.filter(x => x.s < 0).length, nNeu = scored.length - nPos - nNeg;
    const net = scored.reduce((a, x) => a + x.s, 0);
    const netCls = net > 0 ? 'good' : net < 0 ? 'bad' : 'mid';
    const sum = document.createElement('div');
    sum.className = 'news-senti';
    sum.innerHTML = `🧮 투자 분위기: <b class="good">호재 ${nPos}</b> · <b style="color:var(--muted)">중립 ${nNeu}</b> · <b class="bad">악재 ${nNeg}</b>
      — 합산 점수 <b class="${netCls}">${net >= 0 ? '+' : ''}${net}</b>
      <span class="senti-note">제목 키워드 기반 자동 채점(참고용) · 네이버 금융 뉴스${newsTrustedOnly ? (filteredOut ? ` · 🛡️ 신뢰 소스만 (${filteredOut}건 숨김)` : ' · 🛡️ 신뢰 소스만') : ' · 전체 소스'}</span>`;
    el.appendChild(sum);
    scored.forEach(x => {
      const a = document.createElement('a');
      a.className = 'news-item';
      a.href = x.link; a.target = '_blank'; a.rel = 'noopener';
      const [bCls, bTxt] = newsBadge(x.s);
      a.innerHTML = `<div class="title"><span class="sig-badge ${bCls} news-score"></span><span class="tx"></span></div><div class="meta"></div>`;
      a.querySelector('.news-score').textContent = bTxt;
      a.querySelector('.tx').textContent = ' ' + x.title;
      a.querySelector('.meta').textContent = `${x.source} · ${relTime(x.pub)}`;
      el.appendChild(a);
    });
    if (el.id === 'market-news') {
      marketNewsNet = net; marketNewsItems = scored;
      stampAsof('market-news-asof');
      if (typeof renderMainInfographic === 'function') renderMainInfographic();
      if (typeof renderTopInsights === 'function') renderTopInsights();
    }
  } catch (e) {
    if (!attempt) {
      el.innerHTML = '<div class="loading">잠시 후 다시 시도합니다…</div>';
      setTimeout(() => loadNews(el, target, 1), 2500);
    } else {
      el.innerHTML = '<div class="loading">뉴스를 불러오지 못했습니다. <button class="retry-inline" aria-label="뉴스 다시 불러오기">다시 시도</button></div>';
      const rb = el.querySelector('.retry-inline');
      if (rb) rb.onclick = () => loadNews(el, target, 0);
    }
  }
}

// 뉴스 신뢰 소스 필터 토글
const newsFilterBtn = document.getElementById('news-filter-toggle');
function syncNewsFilterBtn() {
  newsFilterBtn.textContent = newsTrustedOnly ? '🛡️ 신뢰 소스만' : '🌐 전체 소스';
  newsFilterBtn.style.borderColor = newsTrustedOnly ? 'var(--accent)' : 'var(--border)';
  newsFilterBtn.style.color = newsTrustedOnly ? 'var(--accent)' : 'var(--muted)';
  newsFilterBtn.setAttribute('aria-pressed', newsTrustedOnly ? 'true' : 'false');
}
newsFilterBtn.onclick = () => {
  newsTrustedOnly = !newsTrustedOnly;
  localStorage.setItem('newsTrustedOnly', newsTrustedOnly ? '1' : '0');
  syncNewsFilterBtn();
  renderMarketNews();
  renderSymbolNews();
  if (detailItem) loadNews(document.getElementById('tab-news'), newsTargetFor(detailItem));
};
syncNewsFilterBtn();

function renderMarketNews() {
  loadNews(document.getElementById('market-news'), { kind: 'market', code: 'KOSPI' });
}

function renderSymbolNews() {
  document.getElementById('news-symbol-label').textContent = selected.name || selected.symbol;
  loadNews(document.getElementById('symbol-news'), newsTargetFor(selected));
}

// ───────────────────────── 종목 선택 ─────────────────────────
function selectStock(item) {
  selected = item;
  document.querySelectorAll('.card').forEach(c => {
    c.classList.toggle('selected', c.querySelector('.sym').textContent === item.symbol);
  });
  renderSymbolNews();
}

// ───────────────────────── 종목 추가 (네이버 자동완성 검색) ─────────────────────────
const acInput = document.getElementById('symbol-input');
const acBox = document.getElementById('ac-results');
let acTimer = null;
let acSeq = 0;

acInput.addEventListener('input', () => {
  clearTimeout(acTimer);
  const q = acInput.value.trim();
  if (!q) { acBox.hidden = true; return; }
  acTimer = setTimeout(() => searchStocks(q), 350);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.ac-wrap')) acBox.hidden = true;
});
acInput.addEventListener('focus', () => { if (acBox.children.length) acBox.hidden = false; });

async function searchStocks(q) {
  const seq = ++acSeq;
  acBox.hidden = false;
  acBox.innerHTML = '<div class="ac-empty">검색 중…</div>';
  try {
    const url = 'https://ac.stock.naver.com/ac?q=' + encodeURIComponent(q) + '&target=stock';
    const j = await fetchViaProxy(url, false);
    if (seq !== acSeq) return; // 더 최신 검색이 시작됐으면 무시
    const items = (j.items || []).filter(it => it.category === 'stock' && (it.nationCode === 'KOR' || it.nationCode === 'USA')).slice(0, 8);
    if (!items.length) {
      acBox.innerHTML = '<div class="ac-empty">검색 결과가 없습니다 (국내·미국 종목만 지원)</div>';
      return;
    }
    acBox.innerHTML = '';
    items.forEach(it => {
      const div = document.createElement('div');
      div.className = 'ac-item';
      div.setAttribute('role', 'option');
      div.setAttribute('tabindex', '0');
      div.innerHTML = `<div><div class="nm"></div><div class="cd"></div></div><span class="mk"></span>`;
      div.querySelector('.nm').textContent = it.name;
      div.querySelector('.cd').textContent = it.code;
      div.querySelector('.mk').textContent = it.typeName || it.typeCode;
      div.setAttribute('aria-label', it.name + ' ' + it.code + ' 추가');
      div.onclick = () => addFromSearch(it);
      div.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addFromSearch(it); } };
      acBox.appendChild(div);
    });
  } catch (e) {
    if (seq !== acSeq) return;
    acBox.innerHTML = '<div class="ac-empty">검색 실패 — 잠시 후 다시 입력해 보세요</div>';
  }
}

function addFromSearch(it) {
  let symbol, reuters;
  if (it.nationCode === 'KOR') {
    symbol = it.code + (it.typeCode === 'KOSDAQ' ? '.KQ' : '.KS');
    reuters = it.reutersCode || it.code;
  } else {
    symbol = it.code;            // 미국: 야후 = 티커 그대로
    reuters = it.reutersCode;    // 네이버용 (예: TSLA.O)
  }
  acBox.hidden = true;
  acInput.value = '';
  if (watchlist.some(w => w.symbol === symbol)) {
    alert('이미 등록된 종목입니다: ' + it.name);
    return;
  }
  watchlist.push({ symbol, name: it.name, reuters });
  saveList();
  renderWatchlist();
}

