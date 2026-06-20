#!/usr/bin/env python3
"""
stock_alert.py — 관심종목 매수신호 감지 → 텔레그램 전송
GitHub Actions에서 5분마다 실행됩니다.

환경변수:
  TELEGRAM_TOKEN  : Bot Token
  CHAT_ID         : 수신 Chat ID
"""

import os
import json
import math
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── 설정 ──────────────────────────────────────────────────────
TOKEN   = os.environ["TELEGRAM_TOKEN"]
CHAT_ID = os.environ["CHAT_ID"]
STATE_FILE = Path(__file__).parent.parent / "state" / "signals.json"
WATCHLIST_FILE = Path(__file__).parent.parent / "watchlist.json"
COOLDOWN_HOURS = 4   # 동일 신호 재전송 최소 간격
KST = timezone(timedelta(hours=9))

SIGNAL_THRESHOLDS = {
    "plunge":   -5.0,   # 전일 대비 하락 %
    "rsi_os":   30.0,   # RSI 과매도
    "bb_lower": True,   # 볼린저 하단 이탈
    "w52_low":  1.05,   # 52주 저점 × 1.05 이내
}

# ── 장 시간 체크 ───────────────────────────────────────────────
def is_market_open(symbol: str) -> bool:
    now = datetime.now(KST)
    h, m = now.hour, now.minute
    # 주말 스킵
    if now.weekday() >= 5:
        return False
    if symbol.endswith((".KS", ".KQ")):
        # 한국 09:00–15:30 KST
        return (h == 9 and m >= 0) or (10 <= h <= 14) or (h == 15 and m <= 30)
    else:
        # 미국 22:30–05:00 KST (전날 밤 ~ 새벽)
        return h >= 22 or (h < 5) or (h == 5 and m == 0)

# ── Yahoo Finance 시세 ────────────────────────────────────────
def fetch_quote(symbol: str) -> dict:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol)}?range=3mo&interval=1d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.load(r)

    result = data["chart"]["result"][0]
    meta   = result["meta"]
    closes = [v for v in (result.get("indicators", {})
                          .get("quote", [{}])[0]
                          .get("close", [])) if v is not None]

    price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
    prev  = meta.get("chartPreviousClose") or meta.get("previousClose")
    chg_pct = (price - prev) / prev * 100 if price and prev else 0.0

    return {
        "symbol":    symbol,
        "price":     price,
        "prev":      prev,
        "chg_pct":   chg_pct,
        "w52_low":   meta.get("fiftyTwoWeekLow"),
        "w52_high":  meta.get("fiftyTwoWeekHigh"),
        "rsi":       calc_rsi(closes),
        "bb":        calc_bollinger(closes),
        "closes":    closes,
    }

# ── 지표 계산 ──────────────────────────────────────────────────
def calc_rsi(closes: list, period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    gains = losses = 0.0
    for i in range(len(closes) - period, len(closes)):
        d = closes[i] - closes[i - 1]
        if d > 0:
            gains += d
        else:
            losses -= d
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1 + rs))

def calc_bollinger(closes: list, period: int = 20) -> dict | None:
    if len(closes) < period:
        return None
    sl = closes[-period:]
    mid = sum(sl) / period
    std = math.sqrt(sum((x - mid) ** 2 for x in sl) / period)
    return {"mid": mid, "upper": mid + 2 * std, "lower": mid - 2 * std}

# ── 신호 감지 ──────────────────────────────────────────────────
def detect_signals(q: dict) -> list[dict]:
    signals = []
    t = SIGNAL_THRESHOLDS

    if q["chg_pct"] <= t["plunge"]:
        signals.append({
            "type":   "plunge",
            "emoji":  "📉",
            "name":   f"급락 {q['chg_pct']:.2f}%",
            "detail": f"전일 대비 {q['chg_pct']:.2f}% 하락 → 단기 반등 타이밍",
        })

    if q["rsi"] is not None and q["rsi"] <= t["rsi_os"]:
        signals.append({
            "type":   "rsi_os",
            "emoji":  "📊",
            "name":   f"RSI 과매도 ({q['rsi']:.1f})",
            "detail": f"RSI {q['rsi']:.1f} — 기술적 반등 구간",
        })

    bb = q.get("bb")
    if bb and q["price"] is not None and q["price"] < bb["lower"]:
        signals.append({
            "type":   "bb_lower",
            "emoji":  "🎯",
            "name":   "볼린저 하단 이탈",
            "detail": f"현재가 {fmt(q['price'], q['symbol'])} < 하단 {fmt(bb['lower'], q['symbol'])}",
        })

    if q["w52_low"] and q["price"] and q["price"] <= q["w52_low"] * t["w52_low"]:
        dist = (q["price"] / q["w52_low"] - 1) * 100
        signals.append({
            "type":   "w52_low",
            "emoji":  "🔻",
            "name":   "52주 저점 근접",
            "detail": f"52주 저점 {fmt(q['w52_low'], q['symbol'])} 대비 +{dist:.1f}%",
        })

    return signals

# ── 중복 방지 상태 관리 ────────────────────────────────────────
def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

def save_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

def should_send(state: dict, symbol: str, sig_type: str) -> bool:
    key = f"{symbol}:{sig_type}"
    last = state.get(key)
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
        return (datetime.now(timezone.utc) - last_dt).total_seconds() > COOLDOWN_HOURS * 3600
    except Exception:
        return True

def mark_sent(state: dict, symbol: str, sig_type: str):
    state[f"{symbol}:{sig_type}"] = datetime.now(timezone.utc).isoformat()

# ── 가격 포맷 ──────────────────────────────────────────────────
def fmt(v, symbol="") -> str:
    if v is None:
        return "—"
    if symbol.endswith((".KS", ".KQ")):
        return f"₩{int(v):,}"
    return f"${v:,.2f}"

# ── 텔레그램 전송 ──────────────────────────────────────────────
def send_telegram(text: str):
    url  = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    body = json.dumps({"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML"}).encode()
    req  = urllib.request.Request(url, data=body,
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

# ── 메인 ──────────────────────────────────────────────────────
def main():
    watchlist = json.loads(WATCHLIST_FILE.read_text(encoding="utf-8"))
    state = load_state()
    now_kst = datetime.now(KST)
    alerts = []

    for item in watchlist:
        symbol = item["symbol"]
        name   = item.get("name", symbol)

        if not is_market_open(symbol):
            print(f"[skip] {symbol} — 장외 시간")
            continue

        try:
            q = fetch_quote(symbol)
            q["name"] = name
            signals = detect_signals(q)
            new_signals = [s for s in signals if should_send(state, symbol, s["type"])]
            if new_signals:
                alerts.append({"q": q, "signals": new_signals})
                for s in new_signals:
                    mark_sent(state, symbol, s["type"])
                    print(f"[alert] {name}({symbol}) — {s['name']}")
            else:
                print(f"[ok]   {name}({symbol}) chg={q['chg_pct']:.2f}% rsi={q['rsi']}")
        except Exception as e:
            print(f"[err]  {symbol}: {e}")

    if not alerts:
        print("신호 없음")
        save_state(state)
        return

    # 메시지 조합
    parts = []
    for a in alerts:
        q = a["q"]
        chg_arrow = "▲" if q["chg_pct"] >= 0 else "▼"
        header = (
            f"📌 <b>{q['name']}</b> <code>{q['symbol']}</code>\n"
            f"현재가 {fmt(q['price'], q['symbol'])}  "
            f"{chg_arrow} {abs(q['chg_pct']):.2f}%"
        )
        sigs = "\n".join(f"  {s['emoji']} <b>{s['name']}</b>\n  {s['detail']}"
                         for s in a["signals"])
        parts.append(f"{header}\n\n{sigs}")

    ts  = now_kst.strftime("%m/%d %H:%M")
    msg = (
        f"🚨 <b>매수신호 감지</b> · {ts} KST\n"
        f"{'─'*20}\n\n"
        + f"\n\n{'─'*20}\n\n".join(parts)
    )

    send_telegram(msg)
    print(f"전송 완료: {len(alerts)}건")
    save_state(state)

if __name__ == "__main__":
    main()
