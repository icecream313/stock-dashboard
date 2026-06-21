#!/usr/bin/env python3
"""
signals_lib.py — 신호 감지 단일 소스 (라이브 알림 + 백테스트 공용)

핵심 원칙:
  · detect_signals(bars, thr, at=i) 는 인덱스 i "까지의" 데이터만 사용한다.
    → 백테스트에서 미래 데이터를 절대 보지 않는다(look-ahead bias 차단).
  · 임계값은 state/thresholds.json 에서 읽는다(자가개선 엔진이 갱신).
"""

import json
import math
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).parent.parent
THRESHOLDS_FILE = ROOT / "state" / "thresholds.json"

# ── 기본 임계값 (thresholds.json 없을 때 폴백) ────────────────────
DEFAULT_THRESHOLDS = {
    "plunge":   -5.0,   # 전일 대비 하락 % (이하이면 발동)
    "rsi_os":   30.0,   # RSI 과매도 (이하이면 발동)
    "bb_lower": True,   # 볼린저 하단(-2σ) 이탈
    "w52_low":  1.05,   # 52주 저점 × 배수 이내
}

def load_thresholds() -> dict:
    thr = dict(DEFAULT_THRESHOLDS)
    try:
        saved = json.loads(THRESHOLDS_FILE.read_text(encoding="utf-8"))
        for k, v in (saved.get("values") or {}).items():
            if k in thr:
                thr[k] = v
    except Exception:
        pass
    return thr

# ── 시세 조회 (Yahoo Finance chart API) ───────────────────────────
def fetch_bars(symbol: str, rng: str = "2y") -> list:
    """일봉 리스트 반환: [{t, open, high, low, close, volume}, ...] (과거→현재)"""
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol)}?range={rng}&interval=1d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.load(r)
    result = data["chart"]["result"][0]
    ts = result.get("timestamp", []) or []
    q  = result["indicators"]["quote"][0]
    o, h, l, c, v = q.get("open", []), q.get("high", []), q.get("low", []), q.get("close", []), q.get("volume", [])
    bars = []
    for i in range(len(ts)):
        if i >= len(c) or c[i] is None or o[i] is None or h[i] is None or l[i] is None:
            continue
        bars.append({
            "t": ts[i], "open": o[i], "high": h[i], "low": l[i],
            "close": c[i], "volume": (v[i] if i < len(v) and v[i] is not None else 0)
        })
    meta = result.get("meta", {})
    return bars, meta

# ── 지표 계산 ─────────────────────────────────────────────────────
def calc_rsi(closes: list, period: int = 14):
    if len(closes) < period + 1:
        return None
    gains = losses = 0.0
    # 초기 평균
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        if d >= 0: gains += d
        else:      losses -= d
    avg_gain, avg_loss = gains / period, losses / period
    # Wilder 평활
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(d, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-d, 0)) / period
    if avg_loss == 0:
        return 100.0
    return 100.0 - (100.0 / (1 + avg_gain / avg_loss))

def calc_bollinger(closes: list, period: int = 20):
    if len(closes) < period:
        return None
    sl = closes[-period:]
    mid = sum(sl) / period
    std = math.sqrt(sum((x - mid) ** 2 for x in sl) / period)
    return {"mid": mid, "upper": mid + 2 * std, "lower": mid - 2 * std}

# ── 신호 감지 (인덱스 at "까지의" 데이터만 사용) ───────────────────
def detect_signals(bars: list, thr: dict, at: int = None) -> list:
    """at 시점에서 발동하는 매수 신호 리스트. at 미래는 절대 참조하지 않음."""
    n = len(bars)
    if at is None:
        at = n - 1
    if at < 21:                      # 지표 산출 최소 구간
        return []
    closes = [b["close"] for b in bars[:at + 1]]
    lows   = [b["low"]   for b in bars[:at + 1]]
    price  = closes[-1]
    prev   = closes[-2]
    signals = []

    # ① 급락
    chg_pct = (price - prev) / prev * 100 if prev else 0.0
    if chg_pct <= thr["plunge"]:
        signals.append({"type": "plunge", "emoji": "📉",
                        "name": f"급락 {chg_pct:.2f}%",
                        "detail": f"전일 대비 {chg_pct:.2f}% 하락 → 단기 반등 타이밍",
                        "value": round(chg_pct, 2)})

    # ② RSI 과매도
    rsi = calc_rsi(closes, 14)
    if rsi is not None and rsi <= thr["rsi_os"]:
        signals.append({"type": "rsi_os", "emoji": "📊",
                        "name": f"RSI 과매도 ({rsi:.1f})",
                        "detail": f"RSI {rsi:.1f} — 기술적 반등 구간",
                        "value": round(rsi, 1)})

    # ③ 볼린저 하단 이탈
    if thr.get("bb_lower"):
        bb = calc_bollinger(closes, 20)
        if bb and price < bb["lower"]:
            signals.append({"type": "bb_lower", "emoji": "🎯",
                            "name": "볼린저 하단 이탈",
                            "detail": f"현재가 < 하단밴드(-2σ) {bb['lower']:.2f}",
                            "value": round((price / bb["lower"] - 1) * 100, 2)})

    # ④ 52주 저점 근접
    win = lows[-252:] if len(lows) >= 252 else lows
    w52_low = min(win) if win else None
    if w52_low and price <= w52_low * thr["w52_low"]:
        dist = (price / w52_low - 1) * 100
        signals.append({"type": "w52_low", "emoji": "🔻",
                        "name": "52주 저점 근접",
                        "detail": f"52주 저점 대비 +{dist:.1f}%",
                        "value": round(dist, 1)})

    return signals
