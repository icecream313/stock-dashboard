#!/usr/bin/env python3
"""
stock_alert.py — 관심종목 매수신호 감지 → 텔레그램 전송
GitHub Actions에서 5분마다 실행됩니다.

신호 감지 로직과 임계값은 signals_lib + state/thresholds.json 을 공유한다.
→ 주 1회 reflect.py(자가개선)가 보정한 임계값을 라이브 알림이 그대로 사용한다.

환경변수:
  TELEGRAM_TOKEN : Bot Token
  CHAT_ID        : 수신 Chat ID
"""

import os
import json
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

import signals_lib as S

# ── 설정 ──────────────────────────────────────────────────────
TOKEN   = os.environ["TELEGRAM_TOKEN"]
CHAT_ID = os.environ["CHAT_ID"]
ROOT           = Path(__file__).parent.parent
STATE_FILE     = ROOT / "state" / "signals.json"
WATCHLIST_FILE = ROOT / "watchlist.json"
COOLDOWN_HOURS = 4   # 동일 신호 재전송 최소 간격
KST = timezone(timedelta(hours=9))

# ── 장 시간 체크 ───────────────────────────────────────────────
def is_market_open(symbol: str) -> bool:
    now = datetime.now(KST)
    h, m = now.hour, now.minute
    if now.weekday() >= 5:                       # 주말 스킵
        return False
    if symbol.endswith((".KS", ".KQ")):          # 한국 09:00–15:30 KST
        return (h == 9) or (10 <= h <= 14) or (h == 15 and m <= 30)
    if symbol.endswith("-USD"):                   # 코인 24시간
        return True
    return h >= 22 or (h < 5) or (h == 5 and m == 0)   # 미국 22:30–05:00 KST

# ── 시세 + 신호 ───────────────────────────────────────────────
def scan_symbol(symbol: str, thr: dict) -> dict:
    bars, meta = S.fetch_bars(symbol, "1y")
    if len(bars) < 30:
        raise RuntimeError(f"bars={len(bars)}")
    closes = [b["close"] for b in bars]
    price = meta.get("regularMarketPrice") or closes[-1]
    # 일간 등락은 '전일 종가'(closes[-2]) 기준 — meta.chartPreviousClose는 범위 시작 전 종가라 부적합
    prev  = closes[-2] if len(closes) >= 2 else price
    chg_pct = (price - prev) / prev * 100 if price and prev else 0.0
    signals = S.detect_signals(bars, thr)        # state/thresholds.json 기준
    return {"symbol": symbol, "price": price, "chg_pct": chg_pct, "signals": signals}

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
    last = state.get(f"{symbol}:{sig_type}")
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
    req  = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

# ── 메인 ──────────────────────────────────────────────────────
def main():
    watchlist = json.loads(WATCHLIST_FILE.read_text(encoding="utf-8"))
    thr = S.load_thresholds()
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
            q = scan_symbol(symbol, thr)
            q["name"] = name
            new_signals = [s for s in q["signals"] if should_send(state, symbol, s["type"])]
            if new_signals:
                alerts.append({"q": q, "signals": new_signals})
                for s in new_signals:
                    mark_sent(state, symbol, s["type"])
                    print(f"[alert] {name}({symbol}) — {s['name']}")
            else:
                print(f"[ok]   {name}({symbol}) chg={q['chg_pct']:.2f}%")
        except Exception as e:
            print(f"[err]  {symbol}: {e}")

    if not alerts:
        print("신호 없음")
        save_state(state)
        return

    parts = []
    for a in alerts:
        q = a["q"]
        arrow = "▲" if q["chg_pct"] >= 0 else "▼"
        header = (f"📌 <b>{q['name']}</b> <code>{q['symbol']}</code>\n"
                  f"현재가 {fmt(q['price'], q['symbol'])}  {arrow} {abs(q['chg_pct']):.2f}%")
        sigs = "\n".join(f"  {s['emoji']} <b>{s['name']}</b>\n  {s['detail']}"
                         for s in a["signals"])
        parts.append(f"{header}\n\n{sigs}")

    ts  = now_kst.strftime("%m/%d %H:%M")
    msg = (f"🚨 <b>매수신호 감지</b> · {ts} KST\n{'─'*20}\n\n"
           + f"\n\n{'─'*20}\n\n".join(parts)
           + f"\n\n<i>기준: 자가개선 보정값(thresholds.json)</i>")

    send_telegram(msg)
    print(f"전송 완료: {len(alerts)}건")
    save_state(state)

if __name__ == "__main__":
    main()
