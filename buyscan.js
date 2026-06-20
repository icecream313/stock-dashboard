// ═════════════════════ 기술적매수 분석 엔진 (듀얼) ═════════════════════
// 두 매매기법을 분리 채점한다 (거래량·RSI 해석이 정반대이므로):
//   🛤️ 눌림목매수 — 상승추세 중 조정. 거래량 "수축" + RSI 40~50 반등 + 지지
//   🚀 돌파매수   — 저항/전고점 돌파. 거래량 "폭증" + RSI 55~75 모멘텀 + 신고가
// 시장 국면(상승장/하락장) 자동 판단 → 기준 동적 조정.

const buyScanCache = {}; // { [symbol]: { regime, pullback, breakout, best, ts } }

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

// ── 반전(지지) 캔들 패턴 감지 (강도 1~3) — 눌림목용 ──────────────
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

  if (!isUp(d2) && body(d2) > 0 && body(d1) < body(d2) * 0.4 &&
      isUp(d0) && body(d0) > body(d2) * 0.5 && d0.close > (d2.open + d2.close) / 2) {
    out.push({ name: '상승샛별형', strength: 3, emoji: '⭐',
      desc: '3봉 강한 하락→상승 반전. 거래량 수반 시 신뢰도 매우 높음.' });
  }
  if (!isUp(d1) && isUp(d0) && body(d0) >= body(d1) * 0.9 &&
      d0.open <= d1.close && d0.close >= d1.open) {
    out.push({ name: '상승장악형', strength: 2.5, emoji: '🟢',
      desc: '전일 음봉을 완전히 감싸는 양봉. 강한 매수세 진입.' });
  }
  if (body(d0) > 0 && dnSh(d0) >= body(d0) * 2 && upSh(d0) <= body(d0) * 0.5) {
    out.push({ name: '망치형', strength: 2, emoji: '🔨',
      desc: '긴 아래꼬리 + 작은 몸통. 저점 강한 매수세 유입.' });
  }
  if (!isUp(d1) && isUp(d0) && d0.open < d1.close &&
      d0.close > (d1.open + d1.close) / 2 && d0.close < d1.open) {
    out.push({ name: '관통형', strength: 2, emoji: '🗡️',
      desc: '전일 음봉 중간점 돌파. 매수세가 매도세를 이기기 시작.' });
  }
  if (body(d0) > 0 && upSh(d0) >= body(d0) * 2 && dnSh(d0) <= body(d0) * 0.5 && isUp(d0)) {
    out.push({ name: '역망치형', strength: 1.5, emoji: '🔁',
      desc: '긴 위꼬리 양봉. 매수 시도 신호. 익일 양봉 확인 권장.' });
  }
  if (!isUp(d1) && isUp(d0) && body(d0) < body(d1) * 0.5 &&
      d0.open > d1.close && d0.close < d1.open) {
    out.push({ name: '상승잉태형', strength: 1.5, emoji: '🫂',
      desc: '전일 음봉 안 작은 양봉. 하락 추세 약화 신호.' });
  }
  const range0 = d0.high - d0.low;
  if (range0 > 0 && body(d0) / range0 < 0.1) {
    out.push({ name: '도지', strength: 1, emoji: '➕',
      desc: '시가≒종가. 매수·매도 균형 상태. 다음날 방향 확인 필요.' });
  }
  return out;
}

// ── 스토캐스틱 슬로우 %K·%D (직전값 포함, 크로스 판정용) ──────────
function stochKD(bars, kPeriod = 14, kSmooth = 3, dPeriod = 3) {
  const n = bars.length;
  if (n < kPeriod + kSmooth + dPeriod) return null;
  const rawK = [];
  for (let i = kPeriod - 1; i < n; i++) {
    const sl = bars.slice(i - kPeriod + 1, i + 1);
    const hi = Math.max(...sl.map(b => b.high));
    const lo = Math.min(...sl.map(b => b.low));
    rawK.push(hi === lo ? 50 : (bars[i].close - lo) / (hi - lo) * 100);
  }
  const sma = (arr, p) => {
    const o = [];
    for (let i = p - 1; i < arr.length; i++)
      o.push(arr.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p);
    return o;
  };
  const slowK = sma(rawK, kSmooth);
  const dArr  = sma(slowK, dPeriod);
  if (slowK.length < 2 || dArr.length < 2) return null;
  return {
    kNow: slowK[slowK.length - 1], kPrev: slowK[slowK.length - 2],
    dNow: dArr[dArr.length - 1],   dPrev: dArr[dArr.length - 2]
  };
}

// ── 공통 통계 준비 ────────────────────────────────────────────
function prepStats(bars) {
  const closes = bars.map(b => b.close);
  const vols   = bars.map(b => b.volume || 0);
  const n = bars.length;
  const price = closes[n - 1];
  const smaOf = p => n >= p ? closes.slice(n - p).reduce((a, b) => a + b, 0) / p : null;

  const sma5  = smaOf(5),  sma20 = smaOf(20),
        sma60 = smaOf(60), sma120 = smaOf(120);

  // 거래량
  const avg20vol = n > 21 ? vols.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20 : 0;
  const volRatio = avg20vol > 0 ? vols[n - 1] / avg20vol : 1;             // 오늘 vs 20일평균
  const recent3vol = vols.slice(n - 3).reduce((a, b) => a + b, 0) / 3;
  const recentVolRatio = avg20vol > 0 ? recent3vol / avg20vol : 1;        // 최근 3일 vs 20일평균

  // 캔들 통계
  const avgBody = n > 20
    ? bars.slice(n - 20).reduce((a, b) => a + Math.abs(b.close - b.open), 0) / 20 : 0;
  const d0 = bars[n - 1];
  const range0 = d0.high - d0.low;
  const body0  = Math.abs(d0.close - d0.open);
  const isUp0  = d0.close >= d0.open;
  const closePos = range0 > 0 ? (d0.close - d0.low) / range0 : 0.5;       // 0=저가, 1=고가

  // 전고점 (오늘 제외 N일 고가)
  const highs = bars.map(b => b.high);
  const priorHigh20 = n > 21 ? Math.max(...highs.slice(n - 21, n - 1)) : null;
  const priorHigh60 = n > 61 ? Math.max(...highs.slice(n - 61, n - 1)) : null;
  const yearHigh    = Math.max(...highs);                                  // 데이터 범위 내 최고가
  // 최근 스윙 고점 (눌림 깊이 계산용, 오늘 포함 30일)
  const recentHigh30 = Math.max(...highs.slice(Math.max(0, n - 30)));

  // 지표
  const rsiVal = rsiWilder(closes, 14);
  const rsiArr = rsiSeries(closes, 14);
  const rsiPrev = rsiArr.filter(v => v != null).slice(-2)[0] ?? null;
  const { hist } = macdCalc(closes);
  const stoch = stochKD(bars);

  return {
    closes, vols, n, price, sma5, sma20, sma60, sma120,
    avg20vol, volRatio, recentVolRatio, avgBody, d0, range0, body0, isUp0, closePos,
    priorHigh20, priorHigh60, yearHigh, recentHigh30,
    rsiVal, rsiPrev, hist, stoch
  };
}

// ════════════════════ 눌림목매수 채점 ════════════════════════
// 상승추세 중 조정 후 재진입. 거래량 "수축" + RSI 되돌림 반등 + 지지.
function scorePullback(s, regime, item) {
  const { price, sma5, sma20, sma60, sma120, volRatio, recentVolRatio,
          rsiVal, rsiPrev, recentHigh30, stoch } = s;
  const comps = {};

  // ① 추세 정배열 [25%] — 눌림목의 대전제 ────────────────────
  let trend = 0; const tR = [];
  if (sma60 && price > sma60) { trend += 35; tR.push({ t: '주가 > 60일선 — 중장기 상승추세 유지', cls: 'good' }); }
  else if (sma60)            { tR.push({ t: '주가 < 60일선 — 추세 이탈, 눌림목 부적합', cls: 'bad' }); }
  if (sma20 && sma60 && sma20 > sma60) { trend += 25; tR.push({ t: '20일선 > 60일선 — 중기 정배열', cls: 'good' }); }
  if (sma5 && sma20 && sma60 && sma5 > sma20 && sma20 > sma60) {
    trend += 25; tR.push({ t: '5 > 20 > 60일선 — 완전 정배열', cls: 'good' });
  } else if (sma5 && sma20 && sma5 < sma20) {
    tR.push({ t: '5일선 < 20일선 — 단기 조정 진행 중 (눌림 형성)', cls: 'mid' });
  }
  if (sma120 && price > sma120) { trend += 15; tR.push({ t: '주가 > 120일선 — 장기 상승추세', cls: 'good' }); }
  trend = Math.min(100, trend);
  comps.trend = { score: Math.round(trend), weight: 25, reasons: tR };

  // ② 눌림 깊이 (20일선 이격도 + 스윙 되돌림) [20%] ──────────
  let depth = 40; const dR = [];
  if (sma20) {
    const dev20 = (price - sma20) / sma20 * 100;
    if (dev20 >= -2 && dev20 <= 3)       { depth = 92; dR.push({ t: `20일선 이격 ${dev20.toFixed(1)}% — 이상적 눌림 (지지선 안착)`, cls: 'good' }); }
    else if (dev20 >= -5 && dev20 < -2)  { depth = 78; dR.push({ t: `20일선 이격 ${dev20.toFixed(1)}% — 깊은 눌림 (지지 테스트)`, cls: 'good' }); }
    else if (dev20 > 3 && dev20 <= 7)    { depth = 55; dR.push({ t: `20일선 이격 +${dev20.toFixed(1)}% — 아직 덜 눌림`, cls: 'mid' }); }
    else if (dev20 < -8)                 { depth = 35; dR.push({ t: `20일선 이격 ${dev20.toFixed(1)}% — 과대 이탈, 추세 훼손 우려`, cls: 'bad' }); }
    else if (dev20 > 10)                 { depth = 18; dR.push({ t: `20일선 이격 +${dev20.toFixed(1)}% — 과이격, 눌림 아님`, cls: 'bad' }); }
    else                                 { depth = 50; dR.push({ t: `20일선 이격 ${dev20.toFixed(1)}%`, cls: 'mid' }); }
  }
  // 스윙 고점 대비 되돌림 깊이 (건강한 눌림 3~12%)
  if (recentHigh30 && price) {
    const pull = (recentHigh30 - price) / recentHigh30 * 100;
    if (pull >= 3 && pull <= 12) { depth = Math.min(100, depth + 8); dR.push({ t: `스윙고점 대비 -${pull.toFixed(1)}% 조정 — 정상 되돌림 구간`, cls: 'good' }); }
    else if (pull > 20)          { depth = Math.max(0, depth - 10); dR.push({ t: `스윙고점 대비 -${pull.toFixed(1)}% — 과도한 하락(추세 전환 경계)`, cls: 'bad' }); }
  }
  comps.depth = { score: Math.round(depth), weight: 20, reasons: dR };

  // ③ 거래량 수축 [15%] — 조정엔 거래량 감소가 건강 ──────────
  let volDry = 50; const vR = [];
  if (s.isUp0 && volRatio >= 1.3) {
    volDry = 90; vR.push({ t: `오늘 양봉 + 거래량 ${(volRatio*100).toFixed(0)}% — 눌림 후 반등 거래량 유입`, cls: 'good' });
  } else if (recentVolRatio < 0.8) {
    volDry = 85; vR.push({ t: `최근 3일 거래량 ${(recentVolRatio*100).toFixed(0)}% — 조정 중 거래량 수축(건강한 눌림)`, cls: 'good' });
  } else if (recentVolRatio <= 1.2) {
    volDry = 60; vR.push({ t: `최근 3일 거래량 ${(recentVolRatio*100).toFixed(0)}% — 보통 수준`, cls: 'mid' });
  } else {
    volDry = 32; vR.push({ t: `최근 3일 거래량 ${(recentVolRatio*100).toFixed(0)}% — 조정에 거래량 증가(매도세 유입 우려)`, cls: 'bad' });
  }
  comps.volDry = { score: Math.round(volDry), weight: 15, reasons: vR };

  // ④ RSI 되돌림 [15%] — 40~50 식은 뒤 반등 시작 ────────────
  let rsiSc = 50; const rR = [];
  if (rsiVal != null) {
    const turningUp = rsiPrev != null && rsiVal > rsiPrev;
    if (rsiVal >= 40 && rsiVal <= 52) {
      rsiSc = turningUp ? 88 : 78;
      rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 조정 후 매수 구간${turningUp ? ' + 반등 시작(상승 전환)' : ''}`, cls: 'good' });
    } else if (rsiVal >= 35 && rsiVal < 40) {
      rsiSc = 72; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 다소 깊은 조정 (저점 매수 관점)`, cls: 'good' });
    } else if (rsiVal > 52 && rsiVal <= 60) {
      rsiSc = 52; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 아직 충분히 식지 않음`, cls: 'mid' });
    } else if (rsiVal < 35) {
      rsiSc = 58; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 과매도, 추세 약화 가능성 점검 필요`, cls: 'mid' });
    } else {
      rsiSc = 30; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 과매수 방향, 눌림 진입 부적합`, cls: 'bad' });
    }
  }
  comps.rsiPull = { score: Math.round(rsiSc), weight: 15, reasons: rR };

  // ⑤ 스토캐스틱 과매도 골든크로스 [10%] ────────────────────
  let stSc = 50; const sR = [];
  if (stoch) {
    const { kNow, kPrev, dNow, dPrev } = stoch;
    const goldenCross = kPrev <= dPrev && kNow > dNow;
    if (kNow < 30 && goldenCross) { stSc = 92; sR.push({ t: `%K ${kNow.toFixed(0)} 과매도 + 골든크로스 — 강력 반등 신호`, cls: 'good' }); }
    else if (goldenCross && kNow < 50) { stSc = 76; sR.push({ t: `%K ${kNow.toFixed(0)} 골든크로스 — 단기 상승 전환`, cls: 'good' }); }
    else if (kNow < 20) { stSc = 70; sR.push({ t: `%K ${kNow.toFixed(0)} — 과매도, 반등 대기`, cls: 'good' }); }
    else if (kNow > 80) { stSc = 25; sR.push({ t: `%K ${kNow.toFixed(0)} — 과매수 구간`, cls: 'bad' }); }
    else { stSc = 50; sR.push({ t: `%K ${kNow.toFixed(0)} / %D ${dNow.toFixed(0)} — 중립`, cls: 'mid' }); }
  }
  comps.stoch = { score: Math.round(stSc), weight: 10, reasons: sR };

  // ⑥ 지지 캔들 패턴 [15%] ──────────────────────────────────
  let candle = 25; const cR = [];
  const pats = detectCandlePatterns(s_bars(s));
  if (pats.length) {
    const raw = pats.reduce((a, p) => a + p.strength, 0);
    candle = Math.min(100, 30 + raw / 3 * 70);
    pats.forEach(p => cR.push({ t: `${p.emoji} ${p.name} (강도 ${p.strength}) — ${p.desc}`, cls: p.strength >= 2 ? 'good' : 'mid' }));
  } else {
    cR.push({ t: '감지된 반전 캔들 패턴 없음 — 지지 확인 캔들 대기', cls: 'mid' });
  }
  comps.candle = { score: Math.round(candle), weight: 15, reasons: cR, patterns: pats };

  const raw = trend*0.25 + depth*0.20 + volDry*0.15 + rsiSc*0.15 + stSc*0.10 + candle*0.15;
  // 추세 이탈(하락장 + 60일선 하회) 시 감점 — 눌림목은 상승추세 전용
  let score = Math.round(raw);
  if (regime === 'bear' && sma60 && price < sma60) score = Math.round(score * 0.75);
  return { score: Math.min(100, score), components: comps };
}

// 패턴 함수가 bars를 필요로 해서 prepStats 결과에서 역참조 (간이)
function s_bars(s) { return s.__bars; }

// ════════════════════ 돌파매수 채점 ══════════════════════════
// 저항/전고점 돌파. 거래량 "폭증" + RSI 모멘텀 + 신고가 + 장대양봉.
function scoreBreakout(s, regime, item) {
  const { price, sma5, sma20, sma60, volRatio, rsiVal, hist,
          priorHigh20, priorHigh60, yearHigh, d0, closePos, body0, avgBody, isUp0 } = s;
  const comps = {};

  // ① 전고점·신고가 돌파 [25%] ──────────────────────────────
  let brk = 30; const bR = [];
  const close = price;
  if (priorHigh60 && close >= priorHigh60) { brk = 96; bR.push({ t: `60일 전고점(${fmtPrice(priorHigh60, item.symbol)}) 돌파 — 60일 신고가`, cls: 'good' }); }
  else if (priorHigh20 && close >= priorHigh20) { brk = 80; bR.push({ t: `20일 전고점(${fmtPrice(priorHigh20, item.symbol)}) 돌파 — 20일 신고가`, cls: 'good' }); }
  else if (priorHigh20) {
    const gap = (priorHigh20 - close) / priorHigh20 * 100;
    if (gap <= 2)      { brk = 58; bR.push({ t: `20일 전고점 -${gap.toFixed(1)}% 근접 — 돌파 임박`, cls: 'mid' }); }
    else if (gap <= 5) { brk = 42; bR.push({ t: `20일 전고점 -${gap.toFixed(1)}% 아래 — 돌파 대기`, cls: 'mid' }); }
    else               { brk = 25; bR.push({ t: `20일 전고점 -${gap.toFixed(1)}% 아래 — 박스권 내부`, cls: 'bad' }); }
  }
  if (yearHigh && close >= yearHigh * 0.995) { brk = Math.min(100, brk + 4); bR.push({ t: '기간 내 최고가 경신 — 매물대 부담 없음', cls: 'good' }); }
  comps.highBreak = { score: Math.round(brk), weight: 25, reasons: bR };

  // ② 거래량 폭증 [25%] — 돌파의 진위를 가르는 핵심 ──────────
  let vol = 20; const vR = [];
  const vp = (volRatio * 100).toFixed(0);
  if (volRatio >= 2.5)      { vol = 100; vR.push({ t: `거래량 ${vp}% (평균 2.5배↑) — 폭발적 매수 유입`, cls: 'good' }); }
  else if (volRatio >= 2.0) { vol = 90;  vR.push({ t: `거래량 ${vp}% (평균 2배↑) — 강력한 돌파 확인`, cls: 'good' }); }
  else if (volRatio >= 1.5) { vol = 75;  vR.push({ t: `거래량 ${vp}% — 돌파 신뢰 구간(150%↑)`, cls: 'good' }); }
  else if (volRatio >= 1.2) { vol = 55;  vR.push({ t: `거래량 ${vp}% — 다소 부족 (확인 필요)`, cls: 'mid' }); }
  else if (volRatio >= 1.0) { vol = 40;  vR.push({ t: `거래량 ${vp}% — 평균 수준 (돌파엔 미흡)`, cls: 'mid' }); }
  else                      { vol = 18;  vR.push({ t: `거래량 ${vp}% — 거래량 없는 돌파(가짜 돌파 의심)`, cls: 'bad' }); }
  comps.volSurge = { score: Math.round(vol), weight: 25, reasons: vR };

  // ③ 볼린저 스퀴즈→상단 돌파 [15%] ─────────────────────────
  let bb = 45; const bbR = [];
  const { closes, n } = s;
  if (sma20 && n >= 40) {
    const slice = closes.slice(n - 20);
    const sd = Math.sqrt(slice.reduce((a, v) => a + (v - sma20) ** 2, 0) / 20);
    const upper = sma20 + 2 * sd, lower = sma20 - 2 * sd;
    const bw = sma20 > 0 ? (upper - lower) / sma20 : 0;                 // 현재 밴드폭
    // 직전 20일 밴드폭 평균 (스퀴즈 판단)
    const bwHist = [];
    for (let i = n - 20; i < n; i++) {
      const sl = closes.slice(i - 19, i + 1);
      if (sl.length < 20) continue;
      const m = sl.reduce((a, b) => a + b, 0) / 20;
      const v = Math.sqrt(sl.reduce((a, x) => a + (x - m) ** 2, 0) / 20);
      bwHist.push(m > 0 ? (4 * v) / m : 0);
    }
    const bwAvg = bwHist.length ? bwHist.reduce((a, b) => a + b, 0) / bwHist.length : bw;
    const squeezed = bw < bwAvg * 0.9;
    const pctB = sd > 0 ? (price - lower) / (upper - lower) * 100 : 50;
    if (price > upper && squeezed)      { bb = 92; bbR.push({ t: `밴드 수축 후 상단(+2σ) 돌파 — 변동성 확장 시작`, cls: 'good' }); }
    else if (price > upper)             { bb = 76; bbR.push({ t: `볼린저 상단(+2σ) 돌파 — 강세 추세`, cls: 'good' }); }
    else if (pctB >= 80)               { bb = 64; bbR.push({ t: `%B ${pctB.toFixed(0)}% — 상단밴드 근접`, cls: 'mid' }); }
    else if (squeezed)                 { bb = 58; bbR.push({ t: `밴드폭 수축(변동성 저점) — 돌파 직전 에너지 응축`, cls: 'mid' }); }
    else                               { bb = 42; bbR.push({ t: `%B ${pctB.toFixed(0)}% — 밴드 중앙`, cls: 'mid' }); }
  }
  comps.squeeze = { score: Math.round(bb), weight: 15, reasons: bbR };

  // ④ 추세·MACD 모멘텀 [15%] ────────────────────────────────
  let mom = 0; const mR = [];
  if (sma5 && sma20 && sma60 && price > sma5 && sma5 > sma20 && sma20 > sma60) {
    mom += 45; mR.push({ t: '주가 > 5 > 20 > 60일선 — 완전 정배열', cls: 'good' });
  } else if (sma20 && sma60 && sma20 > sma60) {
    mom += 28; mR.push({ t: '20일선 > 60일선 — 중기 상승추세', cls: 'good' });
  } else {
    mR.push({ t: '정배열 미완성 — 추세 강도 약함', cls: 'mid' });
  }
  if (hist && hist.length > 3) {
    const h0 = hist[hist.length - 1], h1 = hist[hist.length - 2], h2 = hist[hist.length - 3];
    if (h0 > 0 && h0 > h1) { mom += 35; mR.push({ t: 'MACD 히스토그램 양수 + 확대 — 상승 모멘텀 가속', cls: 'good' }); }
    else if (h1 <= 0 && h0 > 0) { mom += 30; mR.push({ t: '🎯 MACD 골든크로스 — 모멘텀 전환', cls: 'good' }); }
    else if (h0 > 0) { mom += 22; mR.push({ t: 'MACD 히스토그램 양수 — 상승 우위', cls: 'good' }); }
    else { mom += 5; mR.push({ t: 'MACD 히스토그램 음수 — 모멘텀 부족', cls: 'bad' }); }
  }
  mom = Math.min(100, mom);
  comps.momentum = { score: Math.round(mom), weight: 15, reasons: mR };

  // ⑤ RSI 모멘텀 [10%] — 돌파엔 강한 RSI가 우호적 ──────────
  let rsiSc = 40; const rR = [];
  if (rsiVal != null) {
    if (rsiVal >= 55 && rsiVal <= 75)      { rsiSc = 88; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 강한 모멘텀(과열 전 이상 구간)`, cls: 'good' }); }
    else if (rsiVal > 50 && rsiVal < 55)   { rsiSc = 66; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 모멘텀 형성 중`, cls: 'mid' }); }
    else if (rsiVal > 75 && rsiVal <= 85)  { rsiSc = 58; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 강하나 과열 주의`, cls: 'mid' }); }
    else if (rsiVal > 85)                  { rsiSc = 32; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 과열, 단기 조정 위험`, cls: 'bad' }); }
    else                                   { rsiSc = 33; rR.push({ t: `RSI ${rsiVal.toFixed(1)} — 모멘텀 부족, 돌파 신뢰도 낮음`, cls: 'bad' }); }
  }
  comps.rsiMom = { score: Math.round(rsiSc), weight: 10, reasons: rR };

  // ⑥ 돌파 캔들 강도 [10%] — 장대양봉·종가 고가 마감 ────────
  let candle = 30; const cR = [];
  const bodyRatio = avgBody > 0 ? body0 / avgBody : 1;
  if (isUp0 && bodyRatio >= 1.5 && closePos >= 0.7) {
    candle = 92; cR.push({ t: `장대양봉(몸통 ${bodyRatio.toFixed(1)}배) + 고가권 마감 — 강한 돌파 캔들`, cls: 'good' });
  } else if (isUp0 && closePos >= 0.6) {
    candle = 66; cR.push({ t: `양봉 + 상단 마감(종가 위치 ${(closePos*100).toFixed(0)}%) — 매수 우위`, cls: 'mid' });
  } else if (isUp0) {
    candle = 48; cR.push({ t: `양봉이나 종가 위치 ${(closePos*100).toFixed(0)}% — 윗꼬리 부담`, cls: 'mid' });
  } else {
    candle = 28; cR.push({ t: '음봉 마감 — 돌파 강도 약함', cls: 'bad' });
  }
  comps.breakCandle = { score: Math.round(candle), weight: 10, reasons: cR };

  const raw = brk*0.25 + vol*0.25 + bb*0.15 + mom*0.15 + rsiSc*0.10 + candle*0.10;
  let score = Math.round(raw);
  // 거래량 폭증 없는 돌파는 가짜일 확률 高 → 캡
  if (brk >= 80 && volRatio < 1.2) { score = Math.min(score, 58); bR.push({ t: '⚠️ 돌파했으나 거래량 부족 — 가짜 돌파(속임수) 가능', cls: 'bad' }); }
  return { score: Math.min(100, score), components: comps };
}

// ── 핵심 듀얼 엔진 ────────────────────────────────────────────
function computeBuyScanScore(bars, item) {
  if (!bars || bars.length < 60) return null;
  const s = prepStats(bars);
  s.__bars = bars; // 캔들 패턴 함수용

  const regInfo = detectMarketRegime(bars);
  const regime  = regInfo.regime;
  const alertThreshold = getBuyScanThreshold(regime);

  const pb = scorePullback(s, regime, item);
  const bo = scoreBreakout(s, regime, item);

  const pullback = { ...pb, alertThreshold };
  const breakout = { ...bo, alertThreshold };

  const best = pullback.score >= breakout.score
    ? { type: 'pullback', score: pullback.score, label: '눌림목매수' }
    : { type: 'breakout', score: breakout.score, label: '돌파매수' };

  return {
    regime, regimeLabel: regime === 'bull' ? '상승장' : '하락장',
    regInfo, volRatio: s.volRatio, alertThreshold,
    pullback, breakout, best
  };
}

// ── 탭 점수 뱃지 ─────────────────────────────────────────────
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
  el.innerHTML = '<div class="d-loading">눌림목·돌파 동시 분석 중… (추세·거래량·RSI·스토캐스틱·볼린저)</div>';
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

// ── 등급 헬퍼 ────────────────────────────────────────────────
function bstGrade(score, type) {
  const kind = type === 'breakout' ? '돌파' : '눌림목';
  if (score >= 80) return { cls: 'good', color: '#2ecc71', label: `강한 ${kind} 신호` };
  if (score >= 70) return { cls: 'good', color: '#27ae60', label: `${kind} 검토 구간` };
  if (score >= 55) return { cls: 'mid',  color: '#f1c40f', label: '중립 — 관망' };
  return { cls: 'bad', color: '#e74c3c', label: '신호 미흡' };
}

function bstGaugeSVG(score, color, size = 96) {
  const r = size / 2 - 8, c = size / 2, CIRC = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#2a2e3a" stroke-width="8"/>
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="8"
      stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(2)}"
      stroke-dashoffset="${(CIRC * (1 - score / 100)).toFixed(2)}"
      transform="rotate(-90 ${c} ${c})"/>
  </svg>`;
}

// ── 컴포넌트 메타 (모드별) ───────────────────────────────────
const PULLBACK_COMPS = [
  { key: 'trend',  icon: '📐', label: '추세 정배열',          w: 25 },
  { key: 'depth',  icon: '📉', label: '눌림 깊이(이격도)',    w: 20 },
  { key: 'volDry', icon: '🔻', label: '거래량 수축',          w: 15 },
  { key: 'rsiPull',icon: '🌀', label: 'RSI 되돌림(40~50)',    w: 15 },
  { key: 'stoch',  icon: '⚡', label: '스토캐스틱 골든크로스', w: 10 },
  { key: 'candle', icon: '🕯️', label: '지지 캔들 패턴',        w: 15 }
];
const BREAKOUT_COMPS = [
  { key: 'highBreak',   icon: '🚩', label: '전고점·신고가 돌파', w: 25 },
  { key: 'volSurge',    icon: '🔥', label: '거래량 폭증',        w: 25 },
  { key: 'squeeze',     icon: '🎯', label: '볼린저 스퀴즈·돌파', w: 15 },
  { key: 'momentum',    icon: '📈', label: '추세·MACD 모멘텀',   w: 15 },
  { key: 'rsiMom',      icon: '🌀', label: 'RSI 모멘텀(55~75)',  w: 10 },
  { key: 'breakCandle', icon: '🕯️', label: '돌파 캔들 강도',      w: 10 }
];

function bstCompList(components, metaList) {
  let html = '<div class="bst-comps">';
  metaList.forEach(c => {
    const comp = components[c.key];
    if (!comp) return;
    const sc = comp.score;
    const scCls   = sc >= 70 ? 'good' : sc >= 45 ? 'mid' : 'bad';
    const scColor = sc >= 70 ? '#2ecc71' : sc >= 45 ? '#f1c40f' : '#e74c3c';
    let detailHtml = '';
    (comp.reasons || []).forEach(r => {
      detailHtml += `<div class="bst-metric"><span class="sm-dot ${r.cls || ''}"></span><div class="sm-body">
        <div class="sm-top"><span class="sm-label">${esc(r.t)}</span></div>
      </div></div>`;
    });
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
  html += '</div>';
  return html;
}

function paintBuyScanResult(el, result, item) {
  const { regimeLabel, regime, alertThreshold, volRatio, pullback, breakout, best } = result;
  const regimeCls = regime === 'bull' ? 'good' : 'mid';

  const pbG = bstGrade(pullback.score, 'pullback');
  const boG = bstGrade(breakout.score, 'breakout');
  const bestG = best.type === 'pullback' ? pbG : boG;

  const volPct = (volRatio * 100).toFixed(0);
  const volTag = volRatio >= 2.0 ? `<span class="bst-tag good">🔥 거래량 ${volPct}%</span>`
    : volRatio >= 1.5 ? `<span class="bst-tag mid">📊 거래량 ${volPct}%</span>`
    : `<span class="bst-tag">거래량 ${volPct}%</span>`;

  const alertTag = best.score >= alertThreshold
    ? `<div class="bst-alert-inline">🚨 ${best.label} 신호 기준(≥${alertThreshold}점) 충족!</div>` : '';

  const html = `
<div class="bst-dual">
  <button class="bst-card pullback ${best.type==='pullback'?'is-best':''}" data-mode="pullback">
    ${best.type==='pullback'?'<span class="bst-best-flag">BEST</span>':''}
    <div class="bst-card-gauge">${bstGaugeSVG(pullback.score, pbG.color)}
      <div class="bst-card-num ${pbG.cls}">${pullback.score}</div>
    </div>
    <div class="bst-card-title">🛤️ 눌림목매수</div>
    <div class="bst-card-verdict ${pbG.cls}">${pbG.label}</div>
  </button>
  <button class="bst-card breakout ${best.type==='breakout'?'is-best':''}" data-mode="breakout">
    ${best.type==='breakout'?'<span class="bst-best-flag">BEST</span>':''}
    <div class="bst-card-gauge">${bstGaugeSVG(breakout.score, boG.color)}
      <div class="bst-card-num ${boG.cls}">${breakout.score}</div>
    </div>
    <div class="bst-card-title">🚀 돌파매수</div>
    <div class="bst-card-verdict ${boG.cls}">${boG.label}</div>
  </button>
</div>
<div class="bst-summary">
  <div class="bst-tags">
    <span class="bst-tag ${regimeCls}">📊 ${regimeLabel} 모드</span>
    <span class="bst-tag">알람 기준 ≥${alertThreshold}점</span>
    ${volTag}
  </div>
  ${alertTag}
</div>
<div class="bst-mode-tabs">
  <button data-mt="pullback" class="${best.type==='pullback'?'active':''}">🛤️ 눌림목 근거</button>
  <button data-mt="breakout" class="${best.type==='breakout'?'active':''}">🚀 돌파 근거</button>
</div>
<div class="bst-mode-pane" data-pane="pullback" ${best.type==='pullback'?'':'hidden'}>
  <div class="bst-pane-head">🛤️ 눌림목매수 — 상승추세 중 조정 후 재진입. <b>거래량 수축</b> + RSI 40~50 반등 + 지지 확인이 핵심.</div>
  ${bstCompList(pullback.components, PULLBACK_COMPS)}
</div>
<div class="bst-mode-pane" data-pane="breakout" ${best.type==='breakout'?'':'hidden'}>
  <div class="bst-pane-head">🚀 돌파매수 — 저항·전고점 돌파. <b>거래량 폭증(150%↑)</b> + RSI 55~75 모멘텀 + 신고가가 핵심.</div>
  ${bstCompList(breakout.components, BREAKOUT_COMPS)}
</div>
<div class="disclaimer">⚠️ 기술적 분석은 과거 가격·거래량 패턴이며 미래 수익을 보장하지 않습니다. 눌림목·돌파 모두 시장 추세가 받쳐줄 때 신뢰도가 높습니다. 투자 판단과 책임은 본인에게 있습니다.</div>`;

  el.innerHTML = html;
  updateBuyScanTabBadge(best.score, bestG.cls);

  // 모드 탭 전환
  el.querySelectorAll('.bst-mode-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mt;
      el.querySelectorAll('.bst-mode-tabs button').forEach(b => b.classList.toggle('active', b === btn));
      el.querySelectorAll('.bst-mode-pane').forEach(p => { p.hidden = p.dataset.pane !== mode; });
    });
  });
  // 상단 카드 클릭 → 해당 모드 근거로 점프
  el.querySelectorAll('.bst-card').forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      const tabBtn = el.querySelector(`.bst-mode-tabs button[data-mt="${mode}"]`);
      if (tabBtn) tabBtn.click();
    });
  });
  // 근거 펼침 토글
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
      const r = await fetchChart(item.symbol, '1y', '1d', noCache);
      const q = r.indicators.quote[0];
      const bars = (r.timestamp || []).map((t, i) => ({
        time: t, open: q.open[i], high: q.high[i], low: q.low[i],
        close: q.close[i], volume: (q.volume && q.volume[i]) || 0
      })).filter(b => b.close != null && b.open != null && b.high != null && b.low != null);
      if (!bars || bars.length < 60) continue;
      const result = computeBuyScanScore(bars, item);
      if (!result) continue;
      buyScanCache[item.symbol] = { ...result, ts: Date.now() };
      if (result.best.score >= result.alertThreshold) alerts.push({ item, result });
    } catch (e) { /* 개별 종목 실패는 조용히 무시 */ }
    await new Promise(ok => setTimeout(ok, 400));
  }
  if (alerts.length) renderBuyScanAlertBanner(alerts);
}

function checkBuyScanAlerts() {
  const alerts = Object.keys(buyScanCache)
    .map(sym => {
      const c = buyScanCache[sym];
      const item = watchlist.find(w => w.symbol === sym);
      return (c && item && c.best && c.best.score >= c.alertThreshold) ? { item, result: c } : null;
    })
    .filter(Boolean);
  if (alerts.length) renderBuyScanAlertBanner(alerts);
}

function renderBuyScanAlertBanner(alerts) {
  const banner = document.getElementById('buyscan-alert-banner');
  if (!banner) return;
  const chips = alerts.map(a => {
    const best = a.result.best;
    const cls  = best.score >= 80 ? 'good' : 'mid';
    const name = esc(a.item.name || a.item.symbol);
    const sym  = esc(a.item.symbol);
    const icon = best.type === 'breakout' ? '🚀' : '🛤️';
    return `<button class="bsa-chip ${cls}" data-sym="${sym}" data-mode="${best.type}" title="${name} — ${best.label} ${best.score}점 (${a.result.regimeLabel})">
      ${icon} <b>${name}</b> ${best.score}점<span class="bsa-regime">${best.label}</span>
    </button>`;
  }).join('');
  banner.innerHTML = `<span class="bsa-label">📡 기술적 매수 신호</span>${chips}
    <button class="bsa-close" aria-label="닫기">✕</button>`;
  banner.hidden = false;

  banner.querySelectorAll('.bsa-chip').forEach(btn => {
    btn.onclick = () => {
      const sym  = btn.dataset.sym;
      const mode = btn.dataset.mode;
      const item = watchlist.find(w => w.symbol === sym);
      if (item) {
        openDetail(item);
        setTimeout(() => {
          switchTab('buyscan');
          setTimeout(() => {
            const tabBtn = document.querySelector(`#tab-buyscan .bst-mode-tabs button[data-mt="${mode}"]`);
            if (tabBtn) tabBtn.click();
          }, 250);
        }, 200);
      }
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

/* ── 듀얼 카드 (눌림목 / 돌파) ── */
.bst-dual {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
  padding: 14px 14px 6px;
}
.bst-card {
  position: relative; display: flex; flex-direction: column; align-items: center;
  gap: 4px; padding: 14px 10px 12px; border-radius: 14px;
  background: #ffffff06; border: 1.5px solid var(--border);
  cursor: pointer; transition: transform .12s, border-color .15s, background .15s;
}
.bst-card:hover { transform: translateY(-2px); background: #ffffff0c; }
.bst-card.is-best { border-color: #f39c12; background: #f39c1210; }
.bst-best-flag {
  position: absolute; top: -8px; left: 50%; transform: translateX(-50%);
  background: #f39c12; color: #1a1d27; font-size: 0.6rem; font-weight: 800;
  padding: 1px 8px; border-radius: 99px; letter-spacing: 0.05em;
}
.bst-card-gauge { position: relative; width: 96px; height: 96px; }
.bst-card-num {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 1.7rem; font-weight: 800; pointer-events: none;
}
.bst-card-num.good { color: #2ecc71; }
.bst-card-num.mid  { color: #f1c40f; }
.bst-card-num.bad  { color: #e74c3c; }
.bst-card-title { font-size: 0.9rem; font-weight: 700; margin-top: 2px; }
.bst-card-verdict { font-size: 0.74rem; }
.bst-card-verdict.good { color: #2ecc71; }
.bst-card-verdict.mid  { color: #f1c40f; }
.bst-card-verdict.bad  { color: #e74c3c; }

/* ── 요약 태그 ── */
.bst-summary { padding: 2px 14px 8px; }
.bst-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.bst-tag {
  font-size: 0.7rem; padding: 2px 8px; border-radius: 99px;
  background: #ffffff12; color: var(--muted);
}
.bst-tag.good { background: #2ecc7122; color: #2ecc71; }
.bst-tag.mid  { background: #f1c40f22; color: #f1c40f; }
.bst-alert-inline { font-size: 0.8rem; color: #f39c12; font-weight: 600; margin-top: 6px; }

/* ── 모드 탭 ── */
.bst-mode-tabs {
  display: flex; gap: 6px; padding: 6px 14px 0;
  border-top: 1px solid var(--border); margin-top: 4px;
}
.bst-mode-tabs button {
  flex: 1; padding: 9px 8px; font-size: 0.82rem; font-weight: 600;
  background: #ffffff08; border: 1px solid var(--border); border-radius: 9px;
  color: var(--muted); cursor: pointer; transition: all .12s;
}
.bst-mode-tabs button.active { background: var(--accent, #4f8cff); border-color: var(--accent, #4f8cff); color: #fff; }
.bst-pane-head {
  font-size: 0.74rem; color: var(--muted); line-height: 1.5;
  padding: 10px 14px 2px;
}
.bst-pane-head b { color: var(--fg, #e8e8e8); }

/* ── 컴포넌트 목록 ── */
.bst-comps { padding: 4px 0 8px; }
.bst-comp  { border-bottom: 1px solid var(--border); }
.bst-comp-head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; cursor: pointer; user-select: none; transition: background .12s;
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
.sm-top     { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.sm-label   { font-size: 0.8rem; line-height: 1.45; }

.disclaimer {
  font-size: 0.69rem; color: var(--muted); padding: 10px 14px;
  border-top: 1px solid var(--border); line-height: 1.5;
}
`;
  document.head.appendChild(s);
})();
