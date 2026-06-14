// ═════════════════════ 종합 투자 점수 엔진 (규칙 기반) ═════════════════════
// 각 함수 → {score:0~100, summary, reasons[], detail?} 또는 데이터 없으면 null
// detail = { scope:'거시'|'미시', asOf, basis, metrics:[{label,value,verdict,rule,why}] }
function fmtNum(v) { return v == null ? '—' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 }); }
function verdictWord(v) { return v === 'good' ? '우호' : v === 'bad' ? '부담' : '중립'; }
// detail 객체 → 펼침 패널 HTML (info-bar·sum-dim 공용)
function renderScoreDetail(detail) {
  if (!detail) return '';
  const scopeCls = detail.scope === '거시' ? 'macro' : 'micro';
  let h = `<div class="score-detail">`;
  h += `<div class="sd-basis"><span class="sd-scope ${scopeCls}">${esc(detail.scope)} 관점</span>${esc(detail.basis)}</div>`;
  (detail.metrics || []).forEach(m => {
    h += `<div class="score-metric"><span class="sm-dot ${m.verdict}"></span><div class="sm-body">
        <div class="sm-top"><span class="sm-label">${esc(m.label)}</span><span class="sm-value ${m.verdict}">${esc(m.value)}</span></div>
        ${m.rule ? `<div class="sm-rule">판정 기준: ${esc(m.rule)} → <b class="${m.verdict}">${verdictWord(m.verdict)}</b></div>` : ''}
        ${m.why ? `<div class="sm-why">왜 중요한가: ${esc(m.why)}</div>` : ''}
      </div></div>`;
  });
  if (detail.asOf) h += `<div class="sd-asof">📌 데이터 기준: ${esc(detail.asOf)}</div>`;
  return h + `</div>`;
}
const SCORE_DIMS = [
  { key: 'finance',  label: '재무',      icon: '📊', weight: 0.28 },
  { key: 'technical',label: '기술',      icon: '📈', weight: 0.20 },
  { key: 'micro',    label: '미시(수급)',icon: '💧', weight: 0.14 },
  { key: 'news',     label: '뉴스',      icon: '📰', weight: 0.14 },
  { key: 'industry', label: '업종',      icon: '🏭', weight: 0.12 },
  { key: 'macro',    label: '거시',      icon: '🌐', weight: 0.12 }
];

function scoreFinanceVal(d, item) {
  const checks = buildChecks(d, item);
  if (!checks.length) return null;
  const got = checks.reduce((a, c) => a + (c.grade === 'good' ? 2 : c.grade === 'mid' ? 1 : 0), 0);
  const score = Math.round(got / (checks.length * 2) * 100);
  const good = checks.filter(c => c.grade === 'good');
  const bad = checks.filter(c => c.grade === 'bad');
  return {
    score,
    summary: `${checks.length}개 지표 중 긍정 ${good.length} · 주의 ${bad.length}`,
    reasons: [...good.slice(0, 2).map(c => '✓ ' + c.title), ...bad.slice(0, 2).map(c => '✗ ' + c.title)],
    detail: {
      scope: '미시', asOf: '최근 결산 재무제표 · 증권사 컨센서스',
      basis: '밸류에이션(PER·PBR)·수익성(ROE/ROA)·성장성·재무 안정성·애널리스트 의견을 종합한 기업 펀더멘털 평가입니다. 종목 고유의 미시 지표입니다.',
      metrics: checks.map(c => ({ label: c.title, value: verdictWord(c.grade), verdict: c.grade, why: c.desc }))
    }
  };
}

function scoreTechnicalVal(bars, item) {
  if (!bars || bars.length < 30) return null;
  let sigs;
  try { sigs = computeSignals(bars, item && item.symbol); } catch (e) { return null; } // 심볼 전달 → techState 미설정이어도 안전
  if (!sigs.length) return null;
  const buy = sigs.filter(s => s.grade === 'buy').length;
  const sell = sigs.filter(s => s.grade === 'sell').length;
  const score = Math.max(0, Math.min(100, Math.round(50 + (buy - sell) / sigs.length * 50)));
  const gmap = { buy: 'good', sell: 'bad', neutral: 'mid' };
  return {
    score,
    summary: `${sigs.length}개 지표 중 매수 ${buy} · 매도 ${sell}`,
    reasons: sigs.filter(s => s.grade !== 'neutral').slice(0, 3).map(s => (s.grade === 'buy' ? '▲ ' : '▼ ') + s.title),
    detail: {
      scope: '미시', asOf: '최근 일봉 종가 기준 (장중 지연 시세)',
      basis: 'RSI·MACD·이동평균(골든크로스)·볼린저밴드·스토캐스틱 등 표준 기술 지표의 매수/매도 신호 개수를 50점 기준으로 가감합니다. 가격·거래량 흐름의 미시 지표입니다.',
      metrics: sigs.map(s => ({ label: s.title, value: s.grade === 'buy' ? '매수' : s.grade === 'sell' ? '매도' : '중립', verdict: gmap[s.grade], why: s.desc }))
    }
  };
}

function scoreNewsVal(scored) {
  if (!scored || !scored.length) return null;
  const net = scored.reduce((a, x) => a + x.s, 0);
  const pos = scored.filter(x => x.s > 0).length, neg = scored.filter(x => x.s < 0).length;
  const score = Math.max(0, Math.min(100, Math.round(50 + net * 4))); // net ±12 부근에서 포화
  const top = [...scored].filter(x => x.s !== 0).sort((a, b) => Math.abs(b.s) - Math.abs(a.s)).slice(0, 6);
  return {
    score, summary: `호재 ${pos} · 악재 ${neg} · 합산 ${net >= 0 ? '+' : ''}${net}`, reasons: [],
    detail: {
      scope: '미시', asOf: '네이버 종목 뉴스 헤드라인 (실시간)',
      basis: '최근 종목 뉴스 제목을 호재/악재 키워드로 채점해 합산합니다(호재 +, 악재 −). 합산 점수에 비례해 50점 기준으로 가감합니다. 종목 고유의 미시 신호입니다.',
      metrics: top.length ? top.map(x => ({
        label: (x.title || '').slice(0, 48) + ((x.title || '').length > 48 ? '…' : ''),
        value: (x.s > 0 ? '호재 +' : '악재 ') + x.s, verdict: x.s > 0 ? 'good' : 'bad',
        why: esc(x.source || '') ? '출처: ' + x.source : '제목 키워드 기반 감성 점수'
      })) : [{ label: '뚜렷한 호재·악재 키워드 없음', value: '중립', verdict: 'mid', why: '최근 헤드라인에서 강한 방향성 신호가 감지되지 않았습니다.' }]
    }
  };
}

function scoreMacroVal() {
  const md = macroData;
  const metrics = [];
  const idxChk = (sym, label, why) => {
    const d = md[sym];
    if (!d || d.price == null || !d.prev) return;
    const up = d.price >= d.prev, pct = (d.price - d.prev) / d.prev * 100;
    metrics.push({
      label, value: `${fmtNum(d.price)} ${up ? '▲' : '▼'} ${up ? '+' : ''}${pct.toFixed(2)}%`,
      verdict: up ? 'good' : 'bad', rule: '전일 종가 대비 상승이면 우호, 하락이면 부담', why
    });
  };
  idxChk('^KS11', '코스피', '국내 증시 대표 지수. 상승은 국내 위험자산 선호 심리를 반영합니다.');
  idxChk('^IXIC', '나스닥', '미국 기술주 중심 지수. 글로벌 성장주·반도체 투자 심리의 선행 지표입니다.');
  idxChk('^GSPC', 'S&P 500', '미국 대형주 500개 지수. 글로벌 위험선호의 큰 방향을 보여줍니다.');
  const vix = md['^VIX'];
  if (vix && vix.price != null) {
    const calm = vix.price < 20;
    metrics.push({
      label: 'VIX (공포지수)', value: vix.price.toFixed(1) + (calm ? ' · 안정' : ' · 경계'),
      verdict: calm ? 'good' : 'bad', rule: '20 미만이면 안정(우호), 20 이상이면 변동성 경계(부담)',
      why: 'S&P500 옵션의 기대 변동성. 높을수록 시장이 불안·공포 상태임을 뜻합니다.'
    });
  }
  const tnx = md['^TNX'];
  if (tnx && tnx.price != null && tnx.prev) {
    const easing = tnx.price <= tnx.prev;
    metrics.push({
      label: '미 국채 10년 금리', value: tnx.price.toFixed(2) + '%' + (easing ? ' ▼' : ' ▲'),
      verdict: easing ? 'good' : 'bad', rule: '전일 대비 하락·보합이면 우호, 상승이면 부담',
      why: '글로벌 자금조달 비용의 기준. 금리 상승은 성장주·위험자산에 부담으로 작용합니다.'
    });
  }
  if (!metrics.length) return null;
  const pts = metrics.filter(m => m.verdict === 'good').length;
  return {
    score: Math.round(pts / metrics.length * 100),
    summary: `시장 ${metrics.length}개 지표 중 우호 ${pts}`,
    reasons: metrics.map(m => (m.verdict === 'good' ? '▲ ' : '▼ ') + m.label).slice(0, 4),
    detail: {
      scope: '거시', asOf: '실시간 시세 (약 15분 지연)',
      basis: '국내외 대표 지수·시장 변동성(VIX)·기준 금리가 위험자산에 우호적인지를 종합합니다. 모든 종목에 공통으로 적용되는 거시 환경 지표입니다.',
      metrics
    }
  };
}

function scoreMicroVal(d) {
  const dt = d.dealTrend || [];
  if (!dt.length) return null; // 미국 등 수급 미제공 → 차원 제외
  const sum = key => dt.slice(0, 5).reduce((a, x) => a + (numOf(x[key]) || 0), 0);
  const fNet = sum('foreignerPureBuyQuant'), oNet = sum('organPureBuyQuant');
  let pts = 0, max = 0; const reasons = []; const metrics = [];
  max += 2; if (fNet > 0) { pts += 2; reasons.push('✓ 외국인 5일 순매수'); } else reasons.push('✗ 외국인 5일 순매도');
  metrics.push({ label: '외국인 수급 (5일 누적)', value: (fNet > 0 ? '순매수 +' : '순매도 ') + fmtNum(fNet) + '주', verdict: fNet > 0 ? 'good' : 'bad',
    rule: '5거래일 순매수면 우호, 순매도면 부담 (가중 2배)', why: '외국인은 대형주 주가의 핵심 수급 주체로, 지속 매수는 강한 상승 동력입니다.' });
  max += 2; if (oNet > 0) { pts += 2; reasons.push('✓ 기관 5일 순매수'); } else reasons.push('✗ 기관 5일 순매도');
  metrics.push({ label: '기관 수급 (5일 누적)', value: (oNet > 0 ? '순매수 +' : '순매도 ') + fmtNum(oNet) + '주', verdict: oNet > 0 ? 'good' : 'bad',
    rule: '5거래일 순매수면 우호, 순매도면 부담 (가중 2배)', why: '연기금·자산운용사 등 기관의 매수는 중장기 신뢰를 반영하는 수급 신호입니다.' });
  if (dt.length >= 2) {
    const recent = numOf(dt[0].foreignerHoldRatio), old = numOf(dt[Math.min(4, dt.length - 1)].foreignerHoldRatio);
    if (recent != null && old != null) {
      const up = recent >= old; if (up) pts++; max++;
      reasons.push(up ? '✓ 외국인 보유비중 증가' : '✗ 외국인 보유비중 감소');
      metrics.push({ label: '외국인 보유비중 추이', value: old.toFixed(2) + '% → ' + recent.toFixed(2) + '%', verdict: up ? 'good' : 'bad',
        rule: '최근 5일간 보유비중이 늘면 우호, 줄면 부담', why: '외국인 지분율 상승은 장기 자금이 종목에 유입되고 있음을 뜻합니다.' });
    }
  }
  return {
    score: Math.round(pts / max * 100), summary: '외국인·기관 수급 종합 (최근 5거래일)', reasons,
    detail: { scope: '미시', asOf: '최근 5거래일 투자자별 매매동향 (국내 종목)',
      basis: '외국인·기관의 순매수/순매도와 외국인 보유비중 변화를 봅니다. 종목으로 실제 돈이 들어오는지 보여주는 미시 수급 지표입니다.', metrics }
  };
}

function scoreIndustryVal(d, item) {
  const peers = (d.industryCompare || []).map(p => numOf(p.fluctuationsRatio)).filter(v => v != null);
  if (!peers.length) return null;
  const peerAvg = peers.reduce((a, b) => a + b, 0) / peers.length;
  const q = quoteCache[item.symbol];
  const myChg = q && q.prev ? (q.price - q.prev) / q.prev * 100 : null;
  if (myChg == null) return null;
  const rel = myChg - peerAvg;
  const score = Math.max(0, Math.min(100, Math.round(50 + rel * 10)));
  return {
    score,
    summary: `동종 ${peers.length}개 평균 ${peerAvg >= 0 ? '+' : ''}${peerAvg.toFixed(1)}% 대비 ${rel >= 0 ? '우위 +' : '열위 '}${rel.toFixed(1)}%p (당일 기준)`,
    reasons: [rel >= 0 ? '✓ 업종 평균 대비 강세 (당일)' : '✗ 업종 평균 대비 약세 (당일)'],
    detail: {
      scope: '미시', asOf: '당일 동종업계 등락률 비교',
      basis: '같은 업종 동종 기업들의 평균 등락률과 이 종목의 등락률을 비교합니다. 업종 안에서 상대적으로 강한지(주도주인지)를 보는 미시 지표입니다.',
      metrics: [
        { label: '이 종목 당일 등락률', value: (myChg >= 0 ? '+' : '') + myChg.toFixed(2) + '%', verdict: rel >= 0 ? 'good' : 'bad',
          rule: '동종 평균보다 높으면 우호, 낮으면 부담', why: '같은 업황 속에서 시장이 이 종목을 상대적으로 더(덜) 선호하는지를 보여줍니다.' },
        { label: `동종 ${peers.length}개 평균 등락률`, value: (peerAvg >= 0 ? '+' : '') + peerAvg.toFixed(2) + '%', verdict: 'mid',
          rule: '비교 기준선', why: '같은 업종이 함께 움직이는 평균. 이 선보다 위면 업종 내 강세입니다.' },
        { label: '상대 강도 (종목 − 업종)', value: (rel >= 0 ? '+' : '') + rel.toFixed(2) + '%p', verdict: rel >= 0 ? 'good' : 'bad',
          rule: '+면 업종 내 우위, −면 열위', why: '업종 전체 흐름을 제거하고 이 종목만의 상대적 힘을 나타냅니다.' }
      ]
    }
  };
}

// 가용한 차원만 가중평균
function compositeScore(parts) {
  let wsum = 0, acc = 0; const used = [];
  SCORE_DIMS.forEach(dim => { const p = parts[dim.key]; if (p && p.score != null) { acc += p.score * dim.weight; wsum += dim.weight; used.push(dim.key); } });
  if (!wsum) return null;
  return { score: Math.round(acc / wsum), used };
}
function scoreGrade(s) {
  if (s >= 65) return { txt: '매력 우세', cls: 'good', color: '#2ecc71' };
  if (s >= 45) return { txt: '중립 — 혼재', cls: 'mid', color: '#f1c40f' };
  return { txt: '주의 우세', cls: 'bad', color: '#e74c3c' };
}

// ── 메인 종합 투자 환경 인포그래픽 (거시·모멘텀·시장뉴스) ──
let marketNewsNet = null; // 시장 헤드라인 감성 합산 (renderNews가 채움)
let marketNewsItems = null; // 시장 뉴스 헤드라인 목록 (Top3 핵심용)
let trendingMarket = 'kr'; // 떠오르는 업종 시장 (kr|us)
let trendingCache = { kr: null, us: null };
const blockAsOf = {}; // 블록별 데이터 기준 시각
const MAIN_DIMS = [
  { key: 'macro',    label: '거시 환경',       icon: '🌐', weight: 0.40 },
  { key: 'momentum', label: '관심종목 모멘텀', icon: '📈', weight: 0.35 },
  { key: 'news',     label: '시장 뉴스 분위기',icon: '📰', weight: 0.25 }
];
function scoreWatchlistMomentum() {
  const rows = watchlist.map(w => ({ w, q: quoteCache[w.symbol] })).filter(x => x.q && x.q.price && x.q.prev);
  if (!rows.length) return null;
  const qs = rows.map(x => x.q);
  const up = qs.filter(q => q.price > q.prev).length;
  const r1 = qs.filter(q => q.ret1m != null);
  const posM = r1.filter(q => q.ret1m > 0).length;
  const score = r1.length
    ? Math.round((up / qs.length * 0.65 + posM / r1.length * 0.35) * 100)
    : Math.round(up / qs.length * 100);
  const metrics = rows.map(({ w, q }) => {
    const pct = (q.price - q.prev) / q.prev * 100, isUp = q.price > q.prev;
    const r1txt = q.ret1m != null ? ` · 1개월 ${q.ret1m >= 0 ? '+' : ''}${q.ret1m.toFixed(1)}%` : '';
    return { label: w.name || w.symbol, value: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%${r1txt}`, verdict: isUp ? 'good' : 'bad',
      rule: '당일 상승이면 우호, 하락이면 부담', why: '내 관심종목이 오늘 오르고 한 달 추세가 플러스인지로 체감 분위기를 측정합니다.' };
  }).sort((a, b) => (b.verdict === 'good') - (a.verdict === 'good'));
  return {
    score, summary: `${qs.length}개 중 당일 ${up}개 상승${r1.length ? ` · 1개월 플러스 ${posM}개` : ''}`,
    detail: { scope: '미시', asOf: '실시간 관심종목 시세',
      basis: '관심종목들의 당일 상승 비율(65%)과 최근 한 달 플러스 비율(35%)을 가중 평균합니다. 시장 전체가 아니라 내 종목 기준의 체감 모멘텀입니다.', metrics }
  };
}
function scoreMarketNewsVal() {
  if (marketNewsNet == null) return null;
  const pos = marketNewsNet > 0;
  return {
    score: Math.max(0, Math.min(100, Math.round(50 + marketNewsNet * 4))),
    summary: `시장 헤드라인 감성 합산 ${marketNewsNet >= 0 ? '+' : ''}${marketNewsNet}`,
    detail: { scope: '거시', asOf: '시장 뉴스 헤드라인 (실시간)',
      basis: '주요 경제·증시 헤드라인 제목을 호재/악재 키워드로 채점해 합산합니다. 시장 전반의 뉴스 분위기를 나타내는 거시 신호입니다.',
      metrics: [{ label: '시장 뉴스 감성 합산', value: (marketNewsNet >= 0 ? '+' : '') + marketNewsNet, verdict: marketNewsNet === 0 ? 'mid' : pos ? 'good' : 'bad',
        rule: '합산이 +면 우호, −면 부담, 0이면 중립', why: '헤드라인 전반의 톤이 위험선호(호재)인지 위험회피(악재)인지를 보여줍니다. 상단 시장 뉴스 목록에서 개별 기사를 확인할 수 있습니다.' }] }
  };
}

// 거시/미시 탭 라벨 옆 점수 배지 + 종합 점수 갱신
function updateViewTabScores(parts, overall) {
  const setBadge = (id, sc) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (sc == null) { el.textContent = ''; el.className = 'vt-score'; return; }
    el.textContent = sc;
    el.className = 'vt-score ' + scoreGrade(sc).cls;
  };
  setBadge('vt-score-macro', parts.macro ? parts.macro.score : null);     // 거시 환경 점수
  setBadge('vt-score-micro', parts.momentum ? parts.momentum.score : null); // 내 종목 모멘텀 점수
  const ov = document.getElementById('vt-overall');
  if (ov) {
    if (overall == null) { ov.innerHTML = ''; }
    else {
      const label = overall >= 65 ? '우호' : overall >= 45 ? '중립' : '주의';
      ov.innerHTML = `오늘 평가 <b class="${scoreGrade(overall).cls}">${overall}</b> · ${label}`;
    }
  }
}

function renderMainInfographic() {
  const el = document.getElementById('main-infographic');
  if (!el) return;
  const parts = { macro: scoreMacroVal(), momentum: scoreWatchlistMomentum(), news: scoreMarketNewsVal() };
  let wsum = 0, acc = 0, used = 0;
  MAIN_DIMS.forEach(d => { const p = parts[d.key]; if (p) { acc += p.score * d.weight; wsum += d.weight; used++; } });
  const score = wsum ? Math.round(acc / wsum) : null;
  updateViewTabScores(parts, score); // 거시/미시 탭 배지 + 종합 점수 갱신
  if (!wsum) { el.innerHTML = '<div class="loading">종합 투자 환경을 분석하는 중…</div>'; return; }
  const g = scoreGrade(score);
  const verdict = score >= 65 ? '위험 선호 — 우호적 환경' : score >= 45 ? '중립 — 관망 구간' : '위험 회피 — 신중 필요';
  const R = 54, CIRC = 2 * Math.PI * R;
  let html = `<div class="info-card"><div class="info-top">
    <div class="info-gauge">
      <svg width="124" height="124" viewBox="0 0 124 124">
        <circle cx="62" cy="62" r="${R}" fill="none" stroke="#2a2e3a" stroke-width="10"/>
        <circle cx="62" cy="62" r="${R}" fill="none" stroke="${g.color}" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - score / 100)}"/>
      </svg>
      <div class="g-center"><b class="${g.cls}">${score}</b><span>종합 / 100</span></div>
    </div>
    <div class="info-headline">
      <div class="info-verdict ${g.cls}">🧭 ${verdict}</div>
      <div class="info-sub">거시 환경·관심종목 모멘텀·시장 뉴스 분위기 <b>${used}개 축</b>을 가중 평균한 <b>오늘의 종합 투자 환경 점수</b>입니다. 개별 종목 평가는 카드를 눌러 '종합' 탭에서 보세요.</div>
    </div>
  </div><div class="info-bars">`;
  MAIN_DIMS.forEach(d => {
    const p = parts[d.key];
    const hasDetail = p && p.detail;
    html += `<div class="info-bar${hasDetail ? ' expandable' : ''}"><div class="info-bar-head"><span>${d.icon}</span><span>${d.label}</span>`;
    if (p) {
      const gg = scoreGrade(p.score);
      html += `<span class="ib-score ${gg.cls}">${p.score}${hasDetail ? '<span class="sd-caret">▶</span>' : ''}</span></div><div class="info-bar-track"><div class="info-bar-fill" style="width:${p.score}%;background:${gg.color}"></div></div><div class="info-bar-note">${esc(p.summary)}${hasDetail ? ' · <span style="color:var(--accent)">근거 보기</span>' : ''}</div>`;
      if (hasDetail) html += `<div class="sd-wrap" hidden>${renderScoreDetail(p.detail)}</div>`;
    } else {
      html += `<span class="ib-na">집계 중…</span></div>`;
    }
    html += `</div>`;
  });
  html += `</div><div class="info-foot"><button class="ai-btn" id="main-ai-btn">${hasClaudeKey() ? '🤖 Claude 시황 코멘트' : '🤖 Claude 코멘트 (AI 설정 필요)'}</button><span class="info-disclaim">규칙 기반 참고 지표이며 투자 권유가 아닙니다. 시장 환경은 수시로 변합니다.</span></div><div id="main-ai-zone"></div><div id="main-chat-zone" style="margin-top:10px"></div></div>`;
  el.innerHTML = html;
  el.querySelectorAll('.info-bar.expandable').forEach(bar => {
    bar.addEventListener('click', () => {
      const w = bar.querySelector('.sd-wrap');
      const open = bar.classList.toggle('expanded');
      if (w) w.hidden = !open;
    });
  });
  document.getElementById('main-ai-btn').onclick = async () => {
    if (!hasClaudeKey()) { document.getElementById('settings-btn').click(); return; }
    const btn = document.getElementById('main-ai-btn');
    btn.disabled = true; btn.textContent = '🤖 분석 중…';
    const zone = document.getElementById('main-ai-zone');
    zone.innerHTML = '<div class="ai-box"><div class="ai-head">🤖 Claude 시황 코멘트</div><div class="ai-body" id="main-ai-body">생성 중…</div></div>';
    try {
      const txt = await claudeMarketComment(parts, score);
      document.getElementById('main-ai-body').innerHTML = esc(txt).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      btn.style.display = 'none';
    } catch (e) {
      const b = document.getElementById('main-ai-body');
      if (b) b.innerHTML = '<span class="bad">생성 실패: ' + esc(e.message) + '</span>';
      btn.disabled = false; btn.textContent = '🤖 다시 시도';
    }
  };
  renderMainChat(parts, score);
}

// ── 메인 시황 대화형 AI 질의 ──
let mainChat = null; // { history:[{role,content}] }
function buildMainChatContext(parts, score) {
  const lines = MAIN_DIMS.map(d => { const p = parts[d.key]; return `- ${d.label}: ${p ? p.score + '점 — ' + p.summary : '데이터 없음'}`; }).join('\n');
  const holds = watchlist.map(w => w.name || w.symbol).slice(0, 12).join(', ');
  const news = (typeof marketNewsItems !== 'undefined' && marketNewsItems ? marketNewsItems : []).slice(0, 3).map(n => n.title).join(' | ');
  return `[오늘의 종합 투자 환경]\n종합: ${score}/100\n${lines}\n관심종목: ${holds}${news ? '\n시장 뉴스: ' + news : ''}`;
}
function renderMainChat(parts, score) {
  const zone = document.getElementById('main-chat-zone');
  if (!zone) return;
  const hasKey = hasClaudeKey();
  zone.innerHTML = `<div class="ai-box" style="background:rgba(176,140,255,0.06)">
    <div style="font-size:0.86rem;font-weight:700;margin-bottom:8px">💬 오늘 시장에 대해 자유롭게 질문하세요</div>
    <div class="chat-box">
      <div class="chat-messages" id="main-chat-msgs"></div>
      <div class="chat-input-row">
        <textarea id="main-chat-input" placeholder="${hasKey ? '예: 오늘 시장 분위기는? · 어떤 업종이 강한가? · 무엇을 유의할까?' : 'AI 설정에서 Claude API 키를 입력하면 질문할 수 있습니다'}" ${hasKey ? '' : 'disabled'} aria-label="시황 질문 입력"></textarea>
        <button class="chat-send-btn" id="main-chat-send" ${hasKey ? '' : 'disabled'}>✉️ 질문</button>
      </div>
      ${hasKey ? '' : '<div class="hint" style="margin-top:8px;font-size:0.74rem">🔑 우측 상단 ⚙️ AI 설정에서 키를 넣으면 활성화됩니다.</div>'}
    </div></div>`;
  if (!mainChat) mainChat = { history: [] };
  const msgs = zone.querySelector('#main-chat-msgs');
  mainChat.history.forEach(m => { const dv = document.createElement('div'); dv.className = 'chat-msg ' + m.role; dv.textContent = m.content; msgs.appendChild(dv); });
  if (!hasKey) return;
  const input = zone.querySelector('#main-chat-input'), btn = zone.querySelector('#main-chat-send');
  const send = () => handleMainChat(parts, score, input, btn, msgs);
  btn.onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !btn.disabled) { e.preventDefault(); send(); } });
}
async function handleMainChat(parts, score, input, btn, msgs) {
  const q = input.value.trim();
  if (!q) return;
  const u = document.createElement('div'); u.className = 'chat-msg user'; u.textContent = q; msgs.appendChild(u);
  input.value = ''; msgs.scrollTop = msgs.scrollHeight;
  mainChat.history.push({ role: 'user', content: q });
  if (mainChat.history.length > 8) mainChat.history = mainChat.history.slice(-8);
  btn.disabled = true; btn.textContent = '🤖 …';
  const a = document.createElement('div'); a.className = 'chat-msg assistant typing'; msgs.appendChild(a); msgs.scrollTop = msgs.scrollHeight;
  const sys = '당신은 한국어로 답하는 신중한 시황 애널리스트입니다. 제공된 거시·모멘텀·뉴스 지표만 근거로 답하고, 단정적 예측은 피하며 불확실성을 함께 짚습니다. 투자 권유가 아닌 참고 의견입니다. 3~5문장 이내로 답하세요.';
  const ctx = buildMainChatContext(parts, score);
  const msgsApi = mainChat.history.map((m, i) => i === mainChat.history.length - 1 ? { role: 'user', content: ctx + '\n\n질문: ' + m.content } : m);
  try {
    const reply = await claudeChat(sys, msgsApi);
    a.classList.remove('typing');
    a.innerHTML = esc(reply).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    mainChat.history.push({ role: 'assistant', content: reply });
  } catch (e) {
    a.classList.remove('typing');
    a.innerHTML = '<span class="bad">❌ ' + esc(e.message === 'NO_KEY' ? 'AI 설정에서 키를 입력하세요' : e.message) + '</span>';
  } finally {
    btn.disabled = false; btn.textContent = '✉️ 질문'; msgs.scrollTop = msgs.scrollHeight;
  }
}
async function claudeMarketComment(parts, score) {
  const macroDetail = (scoreMacroVal() && scoreMacroVal().reasons || []).join(', ');
  const lines = MAIN_DIMS.map(d => { const p = parts[d.key]; return `- ${d.label}: ${p ? p.score + '점 — ' + p.summary : '데이터 없음'}`; }).join('\n');
  const holds = watchlist.map(w => w.name || w.symbol).slice(0, 12).join(', ');
  const sys = '당신은 한국어로 답하는 신중한 시황 애널리스트입니다. 제공된 지표만 근거로 간결하게 시장 분위기를 설명하며 단정적 예측은 피합니다. 투자 권유가 아닌 참고용입니다.';
  const user = `오늘의 종합 투자 환경 지표입니다 (각 0~100, 높을수록 우호적).\n\n종합: ${score}/100\n${lines}\n거시 세부: ${macroDetail}\n\n사용자 관심종목: ${holds}\n\n위를 바탕으로 4~6문장으로 오늘 시장 환경을 요약하세요: (1) 전반적 분위기 한 줄, (2) 우호/부담 요인, (3) 관심종목 보유자가 유의할 점. 핵심 단어는 **굵게** 표시하세요.`;
  return await callClaude(sys, user, 700);
}

