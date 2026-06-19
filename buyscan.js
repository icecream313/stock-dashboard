// ═════════════════════ 기술적매수 분석 엔진 ═════════════════════
// Jay 트레이딩 스타일: 캔들 + 거래량 중심 (가중 40%)
// 시장 국면(상승장/하락장) 자동 판단 → RSI·알람 기준 동적 조정

const buyScanCache = {}; // { [symbol]: { score, regime, components, ts } }

// 설정 로드: bull=70, bear=80 기본
function getBuyScanThreshold(regime) {
  try {
    const s = JSON.parse(localStorage.getItem('buyscan-settings') || '{}');
    if (regime === 'bull') return s.thresholdBull != null ? s.thresholdBull : 70;
    return s.thresholdBear != null ? s.thresholdBear : 80;
  } catch (e) { return regime === 'bull' ? 70 : 80; }
}

// ── 시장 국면 (종목 자체 200·120일선) ──────────────────────────
function detectMarketRegime(bars) {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const price = closes[n - 1];
  const smaOf = p => n >= p ? closes.slice(n - p).reduce((a, b) => a + b, 0) / p : null;
  const s200 = smaOf(200);
  if (s200 != null) return { regime: price > s200 ? 'bull' : 'bear', smaUsed: 200, smaVal: s200 };
  const s120 = smaOf(120);
  if (s120 != null) return { regime: price > s120 ? 'bull' : 'bear', smaUsed: 120, smaVal: s120 };
  return { regime: 'bull', smaUsed: null, smaVal: null };
}

// ── 캔들 패턴 감지 (강도 1~3) ────────────────────────────────
function detectCandlePatterns(bars) {
  const n = bars.length;
  if (n < 3) return [];
  const g = i => bars[n - 1 - i]; // 0=오늘, 1=어제, 2=그저께
  const body   = b => Math.abs(b.close - b.open);
  const isUp   = b => b.close >= b.open;
  const topOf  = b => Math.max(b.open, b.close);
  const botOf  = b => Math.min(b.open, b.close);
  const upSh   = b => b.high - topOf(b);
  const dnSh   = b => botOf(b) - b.low;
  const d0 = g(0), d1 = g(1), d2 = g(2);
  const out = [];

  // ① 상승샛별형 (Morning Star) — 강도 3
  if (!isUp(d2) && body(d2) > 0 &&
      body(d1) < body(d2) * 0.4 &&
      isUp(d0) && body(d0) > body(d2) * 0.5 &&
      d0.close > (d2.open + d2.close) / 2) {
    out.push({ name: '상승샛별형', strength: 3, emoji: '⭐',
      desc: '3봉 강한 하락→상승 반전. 거래량 수반 시 신뢰도 매우 높음.' });
  }
  // ② 상승장악형 (Bullish Engulfing) — 강도 2.5
  if (!isUp(d1) && isUp(d0) && body(d0) >= body(d1) * 0.9 &&
      d0.open <= d1.close && d0.close >= d1.open) {
    out.push({ name: '상승장악형', strength: 2.5, emoji: '🟢',
      desc: '전일 음봉을 완전히 감싸는 양봉. 강한 매수세 진입.' });
  }
  // ③ 망치형 (Hammer) — 강도 2
  if (body(d0) > 0 && dnSh(d0) >= body(d0) * 2 && upSh(d0) <= body(d0) * 0.5) {
    out.push({ name: '망치형', strength: 2, emoji: '🔨',
      desc: '긴 아래꼬리 + 작은 몸통. 저점 강한 매수세 유입.' });
  }
  // ④ 관통형 (Piercing Line) — 강도 2
  if (!isUp(d1) && isUp(d0) && d0.open < d1.close &&
      d0.close > (d1.open + d1.close) / 2 && d0.close < d1.open) {
    out.push({ name: '관통형', strength: 2, emoji: '🗡️',
      desc: '전일 음봉 중간점 돌파. 매수세가 매도세를 이기기 시작.' });
  }
  // ⑤ 역망치형 (Inverted Hammer) — 강도 1.5
  if (body(d0) > 0 && upSh(d0) >= body(d0) * 2 && dnSh(d0) <= body(d0) * 0.5 && isUp(d0)) {
    out.push({ name: '역망치형', strength: 1.5, emoji: '🔁',
      desc: '긴 위꼬리 양봉. 매수 시도 신호. 익일 양봉 확인 권장.' });
  }
  // ⑥ 상승잉태형 (Bullish Harami) — 강도 1.5
  if (!isUp(d1) && isUp(d0) && body(d0) < body(d1) * 0.5 &&
      d0.open > d1.close && d0.close < d1.open) {
    out.push({ name: '상승잉태형', strength: 1.5, emoji: '🫂',
      desc: '전일 음봉 안 작은 양봉. 하락 추세 약화 신호.' });
  }
  // ⑦ 도지 (Doji) — 강도 1
  const range0 = d0.high - d0.low;
  if (range0 > 0 && body(d0) / range0 < 0.1) {
    out.push({ name: '도지', strength: 1, emoji: '➕',
      desc: '시가≒종가. 매수·매도 균형 상태. 다음날 방향 확인 필요.' });
  }
  return out;
}

// ── 일목균형표 ────────────────────────────────────────────────
function computeIchimoku(bars) {
  const n = bars.length;
  if (n < 78) return null;
  const mid = sl => sl && sl.length
    ? (Math.max(...sl.map(b => b.high)) + Math.min(...sl.map(b => b.low))) / 2
    : null;
  const tenkan = mid(bars.slice(n - 9));
  const kijun  = mid(bars.slice(n - 26));
  const i26 = n - 26;
  if (i26 < 52) return null;
  const t26 = mid(bars.slice(i26 - 9,  i26));
  const k26 = mid(bars.slice(i26 - 26, i26));
  const senkou_a = t26 != null && k26 != null ? (t26 + k26) / 2 : null;
  const senkou_b = mid(bars.slice(i26 - 52, i26));
  const price    = bars[n - 1].close;
  const cloudTop = senkou_a != null && senkou_b != null ? Math.max(senkou_a, senkou_b) : null;
  const cloudBot = senkou_a != null && senkou_b != null ? Math.min(senkou_a, senkou_b) : null;
  return { tenkan, kijun, senkou_a, senkou_b, cloudTop, cloudBot, price };
}

// ── 핵심 점수 엔진 ────────────────────────────────────────────
function computeBuyScanScore(bars, item) {
  if (!bars || bars.length < 60) return null;
  const closes = bars.map(b => b.close);
  const vols   = bars.map(b => b.volume || 0);
  const n = bars.length;
  const price = closes[n - 1];
  const smaOf = p => n >= p ? closes.slice(n - p).reduce((a, b) => a + b, 0) / p : null;
  const sma5  = smaOf(5);
  const sma20 = smaOf(20);
  const sma60 = smaOf(60);

  // 국면
  const regInfo = detectMarketRegime(bars);
  const regime  = regInfo.regime;
  const rsiThreshold = regime === 'bull' ? 45 : 30;
  const alertThreshold = getBuyScanThreshold(regime);

  // ① 캔들 패턴 + 거래량 [가중 40%] ─────────────────────────
  const patterns = detectCandlePatterns(bars);
  const avg20vol = n > 21
    ? vols.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20
    : 0;
  const volRatio = avg20vol > 0 ? vols[n - 1] / avg20vol : 1;

  const patternRaw = patterns.reduce((s, p) => s + p.strength, 0);
  const patternBase = Math.min(100, patternRaw / 3 * 100);
  const volMult = patternRaw > 0
    ? (volRatio >= 2.0 ? 1.5 : volRatio >= 1.5 ? 1.3 : volRatio >= 1.0 ? 1.0 : 0.7)
    : 1.0;
  const noPatternBase = volRatio >= 2.0 ? 40 : volRatio >= 1.5 ? 25 : 15;
  const candleVolScore = Math.min(100, patternRaw > 0 ? patternBase * volMult : noPatternBase);

  // ② 추세 · 눌림목 [가중 20%] ─────────────────────────────
  let trendScore = 45;
  const trendReasons = [];
  if (sma20 && sma60) {
    const dev20 = (price - sma20) / sma20 * 100;
    const dev60 = (price - sma60) / sma60 * 100;
    if (regime === 'bull') {
      if (price > sma60) { trendScore += 20; trendReasons.push('주가 60일선 위 — 상승 추세 유지'); }
      if (dev20 >= -4 && dev20 <= 6) { trendScore += 30; trendReasons.push(`20일선 눌림목 구간 (이격 ${dev20.toFixed(1)}%)`); }
      else if (dev20 < -8) { trendScore += 15; trendReasons.push(`20일선 과대 이탈 — 단기 과매도 (이격 ${dev20.toFixed(1)}%)`); }
      else if (dev20 > 10) { trendScore -= 10; trendReasons.push(`20일선 과이격 — 단기 과매수 (이격 ${dev20.toFixed(1)}%)`); }
    } else {
      if (Math.abs(dev60) < 5) { trendScore += 30; trendReasons.push(`60일선 지지 도달 (이격 ${dev60.toFixed(1)}%)`); }
      if (price < sma20 && price < sma60) { trendScore -= 15; trendReasons.push('역배열 — 추가 하락 경계'); }
    }
    if (sma5 && sma5 > sma20 && sma20 > sma60) {
      trendScore += 10; trendReasons.push('이동평균 정배열 (5일 > 20일 > 60일)');
    }
  }
  trendScore = Math.max(0, Math.min(100, trendScore));

  // ③ 일목균형표 [가중 15%] ────────────────────────────────
  let ichimokuScore = 50;
  const ichimokuReasons = [];
  const ich = computeIchimoku(bars);
  if (ich && ich.cloudTop != null) {
    ichimokuScore = 0;
    if (ich.price > ich.cloudTop) {
      ichimokuScore += 50; ichimokuReasons.push('구름대 위 거래 — 강세 구간');
    } else if (ich.price < ich.cloudBot) {
      ichimokuScore += 15; ichimokuReasons.push('구름대 하단 — 약세 구간');
    } else {
      ichimokuScore += 30; ichimokuReasons.push('구름대 내 — 방향 전환 구간');
    }
    if (ich.tenkan > ich.kijun) {
      ichimokuScore += 30; ichimokuReasons.push('전환선 > 기준선 — 단기 상승 신호');
    } else {
      ichimokuScore += 5; ichimokuReasons.push('전환선 < 기준선 — 단기 하락 압력');
    }
    if (ich.senkou_a != null && ich.senkou_b != null) {
      if (ich.senkou_a > ich.senkou_b) {
        ichimokuScore += 20; ichimokuReasons.push('양운 (선행스팬A > B) — 강세 구름');
      } else {
        ichimokuReasons.push('음운 (선행스팬A < B) — 약세 구름');
      }
    }
    ichimokuScore = Math.min(100, ichimokuScore);
  }

  // ④ RSI [가중 10%] ───────────────────────────────────────
  const rsiVal = rsiWilder(closes, 14);
  let rsiScore = 50;
  const rsiReasons = [];
  if (rsiVal != null) {
    if (rsiVal < rsiThreshold) {
      rsiScore = 85;
      rsiReasons.push(`RSI ${rsiVal.toFixed(1)} — ${regime === 'bull' ? '상승장' : '하락장'} 기준 ${rsiThreshold} 이하 → 매수 구간`);
    } else if (rsiVal > 70) {
      rsiScore = 20;
      rsiReasons.push(`RSI ${rsiVal.toFixed(1)} — 과매수(70↑) 경계`);
    } else if (rsiVal < 55) {
      rsiScore = 60;
      rsiReasons.push(`RSI ${rsiVal.toFixed(1)} — 중립 (매도 압력 없음)`);
    } else {
      rsiScore = 40;
      rsiReasons.push(`RSI ${rsiVal.toFixed(1)} — 다소 과매수 방향`);
    }
    // RSI 강세 다이버전스 탐지
    if (n >= 40) {
      const rsiArr = rsiSeries(closes, 14);
      const pLow1 = Math.min(...closes.slice(n - 20));
      const pLow2 = Math.min(...closes.slice(n - 40, n - 20));
      const r1 = rsiArr.slice(n - 20).filter(v => v != null);
      const r2 = rsiArr.slice(n - 40, n - 20).filter(v => v != null);
      if (pLow1 < pLow2 && r1.length && r2.length && Math.min(...r1) > Math.min(...r2)) {
        rsiScore = Math.min(100, rsiScore + 15);
        rsiReasons.push('🔀 RSI 강세 다이버전스 — 가격 신저가, RSI 저점 상승');
      }
    }
  }

  // ⑤ MACD [가중 10%] ─────────────────────────────────────
  const { hist } = macdCalc(closes);
  let macdScore = 50;
  const macdReasons = [];
  if (hist && hist.length > 6) {
    const h0 = hist[hist.length - 1];
    const h1 = hist[hist.length - 2];
    const h2 = hist[hist.length - 3];
    if (h0 > 0) {
      macdScore = 70; macdReasons.push('히스토그램 양수 — 상승 모멘텀');
    } else {
      macdScore = 30; macdReasons.push('히스토그램 음수 — 하락 모멘텀');
    }
    if (h0 < 0 && h0 > h1 && h1 > h2) {
      macdScore = Math.min(100, macdScore + 20);
      macdReasons.push('히스토그램 수렴 중 — 바닥 형성 가능');
    }
    if (h1 <= 0 && h0 > 0) {
      macdScore = Math.min(100, macdScore + 20);
      macdReasons.push('🎯 골든크로스 — 시그널선 상향 돌파');
    }
  }

  // ⑥ 볼린저밴드 [가중 5%] ────────────────────────────────
  let bbScore = 50;
  const bbReasons = [];
  if (sma20 && n >= 20) {
    const slice = closes.slice(n - 20);
    const sd = Math.sqrt(slice.reduce((a, v) => a + (v - sma20) ** 2, 0) / 20);
    const lower = sma20 - 2 * sd;
    const upper = sma20 + 2 * sd;
    const pctB  = sd > 0 ? (price - lower) / (upper - lower) * 100 : 50;
    if (price < lower) {
      bbScore = 90; bbReasons.push('하단(-2σ) 이탈 — 통계적 과매도');
    } else if (pctB < 20) {
      bbScore = 75; bbReasons.push(`%B ${pctB.toFixed(0)}% — 하단 밴드 근접`);
    } else if (price > upper) {
      bbScore = 15; bbReasons.push(`상단(+2σ) 초과 — 과매수`);
    } else {
      bbScore = 50; bbReasons.push(`%B ${pctB.toFixed(0)}% — 밴드 내 정상 범위`);
    }
  }

  // 패턴 + 거래량 동반 보너스
  const bonus = patterns.length > 0 && volRatio >= 1.5 ? 8 : 0;
  const raw   = candleVolScore * 0.40 + trendScore * 0.20 + ichimokuScore * 0.15
              + rsiScore * 0.10 + macdScore * 0.10 + bbScore * 0.05;
  const score = Math.min(100, Math.round(raw + bonus));

  return {
    score, regime, alertThreshold, volRatio, regInfo,
    regimeLabel: regime === 'bull' ? '상승장' : '하락장',
    rsiThreshold,
    components: {
      candleVol: { score: Math.round(candleVolScore), weight: 40, patterns, volRatio },
      trend:     { score: Math.round(trendScore),     weight: 20, reasons: trendReasons, sma5, sma20, sma60 },
      ichimoku:  { score: Math.round(ichimokuScore),  weight: 15, reasons: ichimokuReasons, data: ich },
      rsi:       { score: Math.round(rsiScore),       weight: 10, reasons: rsiReasons, value: rsiVal, threshold: rsiThreshold },
      macd:      { score: Math.round(macdScore),      weight: 10, reasons: macdReasons, histVal: hist && hist.length ? hist[hist.length - 1] : null },
      bb:        { score: Math.round(bbScore),        weight: 5,  reasons: bbReasons }
    }
  };
}

// ── 탭 UI 렌더링 ─────────────────────────────────────────────
function updateBuyScanTabBadge(score, cls) {
  const btn = document.querySelector('#detail-tabs [data-tab="buyscan"]');
  if (!btn) return;
  let badge = btn.querySelector('.bst-tab-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'bst-tab-badge';
    btn.appendChild(badge);
  }
  badge.textContent = score;
  badge.className = 'bst-tab-badge ' + (cls || '');
}

function clearBuyScanTabBadge() {
  const badge = document.querySelector('#detail-tabs [data-tab="buyscan"] .bst-tab-badge');
  if (badge) badge.remove();
}

async function renderBuyScanTab(item) {
  const el = document.getElementById('tab-buyscan');
  if (!el) return;
  const cached = buyScanCache[item.symbol];
  if (cached) { paintBuyScanResult(el, cached, item); return; }
  el.innerHTML = '<div class="d-loading">캔들·거래량·일목균형표·RSI·MACD 분석 중…</div>';
  try {
    const r = await fetchChart(item.symbol, '1y', '1d');
    if (detailItem !== item) return;
    const q = r.indicators.quote[0];
    const bars = (r.timestamp || []).map((t, i) => ({
      time: t, open: q.open[i], high: q.high[i], low: q.low[i],
      close: q.close[i], volume: (q.volume && q.volume[i]) || 0
    })).filter(b => b.close != null && b.open != null && b.high != null && b.low != null);
    if (bars.length < 60) throw new Error('데이터 부족');
    const result = computeBuyScanScore(bars, item);
    if (!result) throw new Error('점수 계산 실패');
    buyScanCache[item.symbol] = { ...result, ts: Date.now() };
    paintBuyScanResult(el, result, item);
  } catch (e) {
    if (detailItem !== item) return;
    el.innerHTML = `<div class="d-loading">분석 실패 — <button class="retry-btn" style="cursor:pointer;background:none;border:1px solid var(--muted);border-radius:4px;padding:2px 8px;color:var(--fg)">다시 시도</button></div>`;
    const rb = el.querySelector('.retry-btn');
    if (rb) rb.onclick = () => { buyScanCache[item.symbol] = null; renderBuyScanTab(item); };
  }
}

function paintBuyScanResult(el, result, item) {
  const { score, regime, regimeLabel, alertThreshold, components, volRatio, rsiThreshold } = result;

  const grd = score >= 80 ? { cls: 'good', color: '#2ecc71', label: '강한 매수 신호' }
    : score >= 70        ? { cls: 'good', color: '#27ae60', label: '매수 검토 구간' }
    : score >= 55        ? { cls: 'mid',  color: '#f1c40f', label: '중립 — 관망 구간' }
    :                      { cls: 'bad',  color: '#e74c3c', label: '아직 이른 구간' };

  const R    = 54;
  const CIRC = 2 * Math.PI * R;
  const regimeCls = regime === 'bull' ? 'good' : 'mid';

  const volPct = (volRatio * 100).toFixed(0);
  const volTag = volRatio >= 2.0
    ? `<span class="bst-tag good">🔥 거래량 ${volPct}%</span>`
    : volRatio >= 1.5
    ? `<span class="bst-tag mid">📊 거래량 ${volPct}%</span>`
    : `<span class="bst-tag">거래량 ${volPct}%</span>`;

  const alertTag = score >= alertThreshold
    ? `<div class="bst-alert-inline">🚨 매수 신호 기준(≥${alertThreshold}점) 충족!</div>`
    : '';

  const comps = [
    { key: 'candleVol', icon: '🕯️', label: '캔들 패턴 + 거래량', w: 40 },
    { key: 'trend',     icon: '📈', label: '추세 · 눌림목',       w: 20 },
    { key: 'ichimoku',  icon: '☁️', label: '일목균형표',           w: 15 },
    { key: 'rsi',       icon: '📉', label: 'RSI',                w: 10 },
    { key: 'macd',      icon: '🌊', label: 'MACD / DIFF',        w: 10 },
    { key: 'bb',        icon: '🎯', label: '볼린저밴드',           w: 5  }
  ];

  let html = `
<div class="bst-top">
  <div class="bst-gauge">
    <svg width="124" height="124" viewBox="0 0 124 124">
      <circle cx="62" cy="62" r="${R}" fill="none" stroke="#2a2e3a" stroke-width="10"/>
      <circle cx="62" cy="62" r="${R}" fill="none" stroke="${grd.color}" stroke-width="10"
        stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(2)}"
        stroke-dashoffset="${(CIRC * (1 - score / 100)).toFixed(2)}"
        transform="rotate(-90 62 62)"/>
    </svg>
    <div class="bst-gcenter"><b class="${grd.cls}">${score}</b><span>/ 100</span></div>
  </div>
  <div class="bst-headline">
    <div class="bst-verdict ${grd.cls}">${grd.label}</div>
    <div class="bst-tags">
      <span class="bst-tag ${regimeCls}">📊 ${regimeLabel} 모드</span>
      <span class="bst-tag">RSI 기준 &lt;${rsiThreshold}</span>
      <span class="bst-tag">알람 기준 ≥${alertThreshold}점</span>
      ${volTag}
    </div>
    ${alertTag}
    <div class="bst-basis">캔들+거래량(40%)·추세(20%)·일목균형표(15%)·RSI(10%)·MACD(10%)·볼린저밴드(5%) 가중 합산</div>
  </div>
</div>
<div class="bst-comps">`;

  comps.forEach(c => {
    const comp = components[c.key];
    const sc   = comp.score;
    const scCls   = sc >= 70 ? 'good' : sc >= 45 ? 'mid' : 'bad';
    const scColor = sc >= 70 ? '#2ecc71' : sc >= 45 ? '#f1c40f' : '#e74c3c';

    let detailHtml = '';

    if (c.key === 'candleVol') {
      const { patterns: pats, volRatio: vr } = comp;
      const vrCls = vr >= 2.0 ? 'good' : vr >= 1.5 ? 'mid' : '';
      detailHtml += `<div class="bst-metric"><span class="sm-dot ${vrCls}"></span><div class="sm-body">
        <div class="sm-top"><span class="sm-label">거래량 배수</span><span class="sm-value ${vrCls}">평균 대비 ${(vr * 100).toFixed(0)}%</span></div>
        <div class="sm-rule">150% 이상이면 패턴 신뢰도 강화 → 현재 ${vr >= 1.5 ? '✅ 충족' : '⚠️ 미달'}</div>
        <div class="sm-why">거래량 급증은 세력·기관 매수 진입 신호입니다. 캔들 패턴과 동반 시 신뢰도 대폭 상승.</div>
      </div></div>`;
      if (pats.length) {
        pats.forEach(p => {
          const strCls = p.strength >= 2.5 ? 'good' : p.strength >= 2 ? 'mid' : '';
          detailHtml += `<div class="bst-metric"><span class="sm-dot ${strCls}"></span><div class="sm-body">
            <div class="sm-top"><span class="sm-label">${p.emoji} ${esc(p.name)}</span><span class="sm-value ${strCls}">강도 ${p.strength}</span></div>
            <div class="sm-why">${esc(p.desc)}</div>
          </div></div>`;
        });
      } else {
        const noPatDot = vr >= 1.5 ? 'mid' : '';
        const noPatLabel = vr >= 1.5 ? '패턴 대기 구간' : '감지된 패턴 없음';
        const noPatWhy = vr >= 1.5
          ? '거래량 급증이 선행 중입니다. 반전 캔들 패턴이 출현하면 강한 진입 신호가 됩니다.'
          : '오늘 기준 주요 반전 캔들 패턴이 발견되지 않았습니다.';
        detailHtml += `<div class="bst-metric"><span class="sm-dot ${noPatDot}"></span><div class="sm-body">
          <div class="sm-top"><span class="sm-label">${noPatLabel}</span></div>
          <div class="sm-why">${noPatWhy}</div>
        </div></div>`;
      }
    } else {
      (comp.reasons || []).forEach(r => {
        const rCls = /골든|정배열|눌림목|구름대 위|상승 신호|매수 구간|수렴|다이버전스|지지/.test(r) ? 'good'
          : /역배열|하락|과매수|경계|약세|미달/.test(r) ? 'bad' : 'mid';
        detailHtml += `<div class="bst-metric"><span class="sm-dot ${rCls}"></span><div class="sm-body">
          <div class="sm-top"><span class="sm-label">${esc(r)}</span></div>
        </div></div>`;
      });

      if (c.key === 'rsi' && comp.value != null) {
        detailHtml += `<div class="bst-metric"><span class="sm-dot"></span><div class="sm-body">
          <div class="sm-rule">판정 기준: ${esc(regimeLabel)} → RSI &lt;${comp.threshold} 매수 / &gt;70 매도</div>
          <div class="sm-why">상승장에서는 RSI 45 이하도 매수 타이밍 — 하락장 기준(30)까지 기다리면 기회를 놓칩니다.</div>
        </div></div>`;
      }

      if (c.key === 'ichimoku' && comp.data) {
        const ich  = comp.data;
        const fp   = v => v != null ? fmtPrice(v, item.symbol) : '—';
        detailHtml += `<div class="bst-metric"><span class="sm-dot"></span><div class="sm-body">
          <div class="sm-rule">전환선 ${fp(ich.tenkan)} · 기준선 ${fp(ich.kijun)} · 구름 ${fp(ich.cloudBot)} ~ ${fp(ich.cloudTop)}</div>
        </div></div>`;
      }
    }

    html += `<div class="bst-comp" data-expanded="false">
      <div class="bst-comp-head">
        <span class="bst-comp-icon">${c.icon}</span>
        <span class="bst-comp-name">${c.label}</span>
        <span class="bst-comp-w">가중 ${c.w}%</span>
        <span class="bst-comp-score ${scCls}" style="background:${scColor}22">${sc}<small>점</small><span class="bst-caret">▶</span></span>
      </div>
      <div class="bst-bar-track"><div class="bst-bar-fill" style="width:${sc}%;background:${scColor}"></div></div>
      <div class="bst-detail" hidden>${detailHtml}</div>
    </div>`;
  });

  html += `</div>
<div class="disclaimer">⚠️ 기술적 분석은 과거 가격·거래량의 패턴이며 미래 수익을 보장하지 않습니다. 여러 신호가 같은 방향을 가리킬 때 신뢰도가 높습니다. 투자 판단과 책임은 본인에게 있습니다.</div>`;

  el.innerHTML = html;

  // 탭 버튼에 점수 뱃지 표시
  updateBuyScanTabBadge(score, grd.cls);

  // 근거 보기 토글
  el.querySelectorAll('.bst-comp').forEach(comp => {
    comp.querySelector('.bst-comp-head').addEventListener('click', () => {
      const open = comp.dataset.expanded !== 'true';
      comp.dataset.expanded = open ? 'true' : 'false';
      const det = comp.querySelector('.bst-detail');
      if (det) det.hidden = !open;
      const caret = comp.querySelector('.bst-caret');
      if (caret) caret.style.transform = open ? 'rotate(90deg)' : '';
    });
  });
}

// ── 백그라운드 자동 스캔 ─────────────────────────────────────
async function runBuyScanAll(noCache) {
  if (!watchlist || !watchlist.length) return;
  const alerts = [];
  for (const item of watchlist) {
    try {
      let bars = null;
      const r = await fetchChart(item.symbol, '1y', '1d', noCache);
      const q = r.indicators.quote[0];
      bars = (r.timestamp || []).map((t, i) => ({
        time: t, open: q.open[i], high: q.high[i], low: q.low[i],
        close: q.close[i], volume: (q.volume && q.volume[i]) || 0
      })).filter(b => b.close != null && b.open != null && b.high != null && b.low != null);
      if (!bars || bars.length < 60) continue;
      const result = computeBuyScanScore(bars, item);
      if (!result) continue;
      buyScanCache[item.symbol] = { ...result, ts: Date.now() };
      if (result.score >= result.alertThreshold) alerts.push({ item, result });
    } catch (e) { /* 개별 종목 실패는 조용히 무시 */ }
    await new Promise(ok => setTimeout(ok, 400)); // 프록시 과부하 방지
  }
  if (alerts.length) renderBuyScanAlertBanner(alerts);
}

function checkBuyScanAlerts() {
  const alerts = Object.keys(buyScanCache)
    .map(sym => {
      const c = buyScanCache[sym];
      const item = watchlist.find(w => w.symbol === sym);
      return (c && item && c.score >= c.alertThreshold) ? { item, result: c } : null;
    })
    .filter(Boolean);
  if (alerts.length) renderBuyScanAlertBanner(alerts);
}

function renderBuyScanAlertBanner(alerts) {
  const banner = document.getElementById('buyscan-alert-banner');
  if (!banner) return;
  const chips = alerts.map(a => {
    const cls  = a.result.score >= 80 ? 'good' : 'mid';
    const name = esc(a.item.name || a.item.symbol);
    const sym  = esc(a.item.symbol);
    return `<button class="bsa-chip ${cls}" data-sym="${sym}" title="${name} — ${a.result.score}점 (${a.result.regimeLabel})">
      🚨 <b>${name}</b> ${a.result.score}점<span class="bsa-regime">${a.result.regimeLabel}</span>
    </button>`;
  }).join('');
  banner.innerHTML = `<span class="bsa-label">📡 기술적 매수 신호</span>${chips}
    <button class="bsa-close" aria-label="닫기">✕</button>`;
  banner.hidden = false;

  banner.querySelectorAll('.bsa-chip').forEach(btn => {
    btn.onclick = () => {
      const sym  = btn.dataset.sym;
      const item = watchlist.find(w => w.symbol === sym);
      if (item) { openDetail(item); setTimeout(() => switchTab('buyscan'), 200); }
    };
  });
  banner.querySelector('.bsa-close').onclick = () => { banner.hidden = true; };
}

// ── CSS 주입 (별도 파일 없이 self-contained) ─────────────────
(function injectBuyScanCSS() {
  if (document.getElementById('buyscan-style')) return;
  const s = document.createElement('style');
  s.id = 'buyscan-style';
  s.textContent = `
/* ── 탭 점수 뱃지 ── */
.bst-tab-badge {
  display: inline-block; margin-left: 5px;
  font-size: 0.65rem; font-weight: 700;
  padding: 1px 6px; border-radius: 99px;
  background: #ffffff18; color: var(--muted);
  vertical-align: middle; line-height: 1.6;
}
.bst-tab-badge.good { background: #2ecc7130; color: #2ecc71; }
.bst-tab-badge.mid  { background: #f1c40f30; color: #f1c40f; }
.bst-tab-badge.bad  { background: #e74c3c30; color: #e74c3c; }

/* ── 알람 배너 ── */
#buyscan-alert-banner {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  padding: 8px 12px; background: #1a1d27; border-bottom: 2px solid #f39c12;
  position: sticky; top: 0; z-index: 900;
}
.bsa-label { font-size: 0.75rem; color: var(--muted); white-space: nowrap; }
.bsa-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 99px; font-size: 0.76rem;
  border: none; cursor: pointer; transition: opacity .15s;
}
.bsa-chip.good { background: #2ecc7133; color: #2ecc71; }
.bsa-chip.mid  { background: #f1c40f33; color: #f1c40f; }
.bsa-chip:hover { opacity: .8; }
.bsa-regime { font-size: 0.7rem; color: var(--muted); margin-left: 3px; }
.bsa-close  { margin-left: auto; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 1rem; padding: 0 4px; }

/* ── 게이지 + 헤더 ── */
.bst-top {
  display: flex; align-items: flex-start; gap: 16px;
  padding: 16px; border-bottom: 1px solid var(--border);
}
.bst-gauge { position: relative; flex-shrink: 0; width: 124px; height: 124px; }
.bst-gcenter {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; pointer-events: none;
}
.bst-gcenter b { font-size: 2rem; font-weight: 700; line-height: 1; }
.bst-gcenter b.good { color: #2ecc71; }
.bst-gcenter b.mid  { color: #f1c40f; }
.bst-gcenter b.bad  { color: #e74c3c; }
.bst-gcenter span   { font-size: 0.72rem; color: var(--muted); }

.bst-headline { flex: 1; min-width: 0; }
.bst-verdict  { font-size: 1.05rem; font-weight: 600; margin-bottom: 6px; }
.bst-verdict.good { color: #2ecc71; }
.bst-verdict.mid  { color: #f1c40f; }
.bst-verdict.bad  { color: #e74c3c; }

.bst-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.bst-tag  {
  font-size: 0.7rem; padding: 2px 8px; border-radius: 99px;
  background: #ffffff12; color: var(--muted);
}
.bst-tag.good { background: #2ecc7122; color: #2ecc71; }
.bst-tag.mid  { background: #f1c40f22; color: #f1c40f; }

.bst-alert-inline {
  font-size: 0.8rem; color: #f39c12; font-weight: 600; margin-bottom: 5px;
}
.bst-basis { font-size: 0.68rem; color: var(--muted); line-height: 1.4; }

/* ── 컴포넌트 목록 ── */
.bst-comps { padding: 8px 0; }
.bst-comp  { border-bottom: 1px solid var(--border); }
.bst-comp-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; cursor: pointer; user-select: none;
  transition: background .12s;
}
.bst-comp-head:hover { background: #ffffff08; }
.bst-comp-icon { font-size: 1rem; }
.bst-comp-name { flex: 1; font-size: 0.85rem; }
.bst-comp-w    { font-size: 0.7rem; color: var(--muted); }
.bst-comp-score {
  font-size: 0.82rem; font-weight: 600; padding: 2px 9px;
  border-radius: 99px; display: flex; align-items: center; gap: 4px;
}
.bst-comp-score.good { color: #2ecc71; }
.bst-comp-score.mid  { color: #f1c40f; }
.bst-comp-score.bad  { color: #e74c3c; }
.bst-comp-score small { font-size: 0.65rem; font-weight: 400; }
.bst-caret { font-size: 0.6rem; transition: transform .2s; }

.bst-bar-track { height: 3px; background: #ffffff10; }
.bst-bar-fill  { height: 100%; border-radius: 2px; transition: width .4s; }

.bst-detail { padding: 4px 14px 12px; }
.bst-metric {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 0; border-bottom: 1px solid #ffffff08;
}
.bst-metric:last-child { border-bottom: none; }
.sm-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  margin-top: 5px; background: var(--muted);
}
.sm-dot.good { background: #2ecc71; }
.sm-dot.mid  { background: #f1c40f; }
.sm-dot.bad  { background: #e74c3c; }
.sm-body    { flex: 1; min-width: 0; }
.sm-top     { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-bottom: 2px; }
.sm-label   { font-size: 0.8rem; }
.sm-value   { font-size: 0.78rem; font-weight: 600; margin-left: auto; }
.sm-value.good { color: #2ecc71; }
.sm-value.mid  { color: #f1c40f; }
.sm-value.bad  { color: #e74c3c; }
.sm-rule    { font-size: 0.72rem; color: var(--muted); margin-bottom: 2px; }
.sm-why     { font-size: 0.71rem; color: #aaa; line-height: 1.45; }

.disclaimer {
  font-size: 0.69rem; color: var(--muted); padding: 10px 14px;
  border-top: 1px solid var(--border); line-height: 1.5;
}
`;
  document.head.appendChild(s);
})();
