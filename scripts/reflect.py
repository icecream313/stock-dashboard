#!/usr/bin/env python3
"""
reflect.py — 자가개선 엔진 (주 1회 실행 권장)

하는 일:
  1) 관심종목 과거 2년 일봉을 받아 각 신호를 "그날까지의 데이터만으로" 재현(백테스트)
  2) 신호 발동 후 5·10·20일 실제 수익률을 채점 → 신호유형별 적중률·평균수익 집계
  3) 무작위(기준선) 수익률과 비교한 '엣지(edge)'를 계산 → 신호가 진짜 가치 있나 검증
  4) 임계값 후보를 스윕해 가장 성과 좋은 값으로 state/thresholds.json 자동 보정
  5) state/backtest_report.json 저장 + (텔레그램 환경변수 있으면) 요약 전송

look-ahead 차단: 신호 발동 판정은 과거 데이터만, 미래 데이터는 '채점'에만 사용.
"""

import os
import sys
import json
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

import signals_lib as S

# Windows 콘솔(cp949)에서도 이모지/한글 깨지지 않도록 (GitHub Actions 리눅스는 기본 UTF-8)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT           = Path(__file__).parent.parent
WATCHLIST_FILE = ROOT / "watchlist.json"
REPORT_FILE    = ROOT / "state" / "backtest_report.json"
THRESHOLDS_FILE= ROOT / "state" / "thresholds.json"
KST = timezone(timedelta(hours=9))

HORIZONS    = [5, 10, 20]   # 영업일
MIN_SAMPLES = 8             # 보정에 필요한 최소 표본
MIN_GAP     = 5             # 같은 신호 연속발동 중복 제거(영업일)
CALIB_HORIZON = 10          # 임계값 보정 기준 기간

# 임계값 후보 그리드
GRID = {
    "plunge":  [-3.0, -4.0, -5.0, -6.0, -7.0, -8.0],
    "rsi_os":  [25.0, 30.0, 35.0, 40.0],
    "w52_low": [1.02, 1.05, 1.08, 1.12],
    # bb_lower 는 불리언이라 스윕 없음 (성과만 측정)
}

# ── 단일 신호 발동 인덱스 추출 (특정 임계값으로) ──────────────────
def fire_indices(bars, sig_type, cutoff):
    """sig_type 신호가 cutoff 기준으로 발동한 인덱스들 (MIN_GAP 중복제거)"""
    n = len(bars)
    closes = [b["close"] for b in bars]
    lows   = [b["low"]   for b in bars]
    fired = []
    last = -999
    for i in range(21, n):
        ok = False
        if sig_type == "plunge":
            prev = closes[i - 1]
            if prev:
                chg = (closes[i] - prev) / prev * 100
                ok = chg <= cutoff
        elif sig_type == "rsi_os":
            rsi = S.calc_rsi(closes[:i + 1], 14)
            ok = rsi is not None and rsi <= cutoff
        elif sig_type == "bb_lower":
            bb = S.calc_bollinger(closes[:i + 1], 20)
            ok = bool(bb) and closes[i] < bb["lower"]
        elif sig_type == "w52_low":
            win = lows[max(0, i - 251):i + 1]
            w = min(win) if win else None
            ok = bool(w) and closes[i] <= w * cutoff
        if ok and (i - last) >= MIN_GAP:
            fired.append(i)
            last = i
    return fired

# ── 발동 인덱스들의 전방 수익률 채점 ─────────────────────────────
def score(bars, fired):
    closes = [b["close"] for b in bars]
    n = len(bars)
    out = {h: {"rets": []} for h in HORIZONS}
    for i in fired:
        for h in HORIZONS:
            j = i + h
            if j < n and closes[i]:
                out[h]["rets"].append((closes[j] - closes[i]) / closes[i] * 100)
    res = {}
    for h in HORIZONS:
        rets = out[h]["rets"]
        if rets:
            wins = sum(1 for r in rets if r > 0)
            res[h] = {"n": len(rets),
                      "hit": round(wins / len(rets) * 100, 1),
                      "avg": round(sum(rets) / len(rets), 2)}
        else:
            res[h] = {"n": 0, "hit": None, "avg": None}
    return res

# ── 기준선(무작위 진입) 전방 수익률 ──────────────────────────────
def baseline(bars):
    closes = [b["close"] for b in bars]
    n = len(bars)
    res = {}
    for h in HORIZONS:
        rets = [(closes[i + h] - closes[i]) / closes[i] * 100
                for i in range(21, n - h) if closes[i]]
        if rets:
            wins = sum(1 for r in rets if r > 0)
            res[h] = {"hit": round(wins / len(rets) * 100, 1),
                      "avg": round(sum(rets) / len(rets), 2)}
        else:
            res[h] = {"hit": None, "avg": None}
    return res

def telegram(text):
    tok, chat = os.environ.get("TELEGRAM_TOKEN"), os.environ.get("CHAT_ID")
    if not tok or not chat:
        return
    body = json.dumps({"chat_id": chat, "text": text, "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage",
                                 data=body, headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print("[telegram]", e)

def main():
    watchlist = json.loads(WATCHLIST_FILE.read_text(encoding="utf-8"))
    SIGS = ["plunge", "rsi_os", "bb_lower", "w52_low"]

    # 종목별 bars 수집 (한 번만)
    allbars = {}
    base_acc = {h: {"avg": [], "hit": []} for h in HORIZONS}
    for item in watchlist:
        sym = item["symbol"]
        try:
            bars, _ = S.fetch_bars(sym, "2y")
            if len(bars) < 80:
                print(f"[skip] {sym} bars={len(bars)}"); continue
            allbars[sym] = bars
            b = baseline(bars)
            for h in HORIZONS:
                if b[h]["avg"] is not None:
                    base_acc[h]["avg"].append(b[h]["avg"])
                    base_acc[h]["hit"].append(b[h]["hit"])
            print(f"[ok]  {sym} bars={len(bars)}")
        except Exception as e:
            print(f"[err] {sym}: {e}")

    base = {h: {"avg": round(sum(base_acc[h]["avg"]) / len(base_acc[h]["avg"]), 2) if base_acc[h]["avg"] else None,
                "hit": round(sum(base_acc[h]["hit"]) / len(base_acc[h]["hit"]), 1) if base_acc[h]["hit"] else None}
            for h in HORIZONS}

    cur_thr = S.load_thresholds()
    report = {"signals": {}, "baseline": base, "horizons": HORIZONS}
    # 엣지 검증을 통과한 신호만 보정값으로 덮어쓰고, 나머지는 안전한 기본값으로 복귀
    new_values = dict(S.DEFAULT_THRESHOLDS)

    for sig in SIGS:
        # 현재 임계값으로 풀(전 종목) 성과
        cur_cut = cur_thr.get(sig)
        pool_fired_cur = []
        for sym, bars in allbars.items():
            pool_fired_cur.append((bars, fire_indices(bars, sig, cur_cut)))
        # 풀 채점 (현재값)
        cur_res = aggregate(pool_fired_cur)

        entry = {"current": cur_cut, "current_perf": cur_res, "chosen": cur_cut,
                 "chosen_perf": cur_res, "calibrated": False, "verdict": "insufficient",
                 "candidates": []}

        base_avg = base.get(CALIB_HORIZON, {}).get("avg")

        # 보정 가능한 신호: 그리드 스윕 → '엣지(평균-기준선)' 최대값 선택
        if sig in GRID:
            best = None  # (key, cut, res, ch)
            for cut in GRID[sig]:
                pool = [(bars, fire_indices(bars, sig, cut)) for sym, bars in allbars.items()]
                res = aggregate(pool)
                ch = res.get(CALIB_HORIZON, {})
                entry["candidates"].append({"cut": cut, "n": ch.get("n", 0),
                                            "hit": ch.get("hit"), "avg": ch.get("avg")})
                # 평균수익 우선 → 적중률 → 표본수 (적중률만 보면 무작위 이하 설정을 고를 수 있어 평균수익 우선)
                if ch.get("n", 0) >= MIN_SAMPLES and ch.get("avg") is not None:
                    key = (ch["avg"], ch["hit"], ch["n"])
                    if best is None or key > best[0]:
                        best = (key, cut, res, ch)
            if best:
                best_ch = best[3]
                has_edge = (base_avg is None) or (best_ch["avg"] > base_avg)
                if has_edge:
                    # 무작위보다 우월할 때만 채택
                    entry["chosen"] = best[1]
                    entry["chosen_perf"] = best[2]
                    entry["calibrated"] = (best[1] != cur_cut)
                    new_values[sig] = best[1]
                    entry["verdict"] = "strong" if (base_avg is not None and best_ch["avg"] >= base_avg * 1.3) else "ok"
                else:
                    # 최선의 후보조차 무작위 이하 → 기본값 유지, 약신호로 표시
                    entry["verdict"] = "negative_edge"
            else:
                entry["verdict"] = "insufficient"
        else:
            # bb_lower 등 불리언 신호: 성과만 측정해 판정
            ch = cur_res.get(CALIB_HORIZON, {})
            if ch.get("avg") is not None and ch.get("n", 0) >= MIN_SAMPLES and base_avg is not None:
                if ch["avg"] >= base_avg * 1.3:   entry["verdict"] = "strong"
                elif ch["avg"] > base_avg:        entry["verdict"] = "ok"
                else:                             entry["verdict"] = "negative_edge"
            else:
                entry["verdict"] = "insufficient"

        report["signals"][sig] = entry

    # thresholds.json 갱신
    evidence = {s: report["signals"][s]["chosen_perf"].get(CALIB_HORIZON, {})
                for s in SIGS}
    THRESHOLDS_FILE.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).isoformat(),
        "method": "backtest_calibration",
        "calib_horizon": CALIB_HORIZON,
        "values": new_values,
        "evidence": evidence
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    report["updated"] = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    report["watchlist"] = [w["symbol"] for w in watchlist]
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print_summary(report, new_values, cur_thr)
    telegram(build_telegram(report, new_values, cur_thr))

# ── 풀(여러 종목) 채점 합산 ──────────────────────────────────────
def aggregate(pool):
    acc = {h: [] for h in HORIZONS}
    for bars, fired in pool:
        sc = score(bars, fired)
        closes = [b["close"] for b in bars]
        n = len(bars)
        for i in fired:
            for h in HORIZONS:
                j = i + h
                if j < n and closes[i]:
                    acc[h].append((closes[j] - closes[i]) / closes[i] * 100)
    res = {}
    for h in HORIZONS:
        rets = acc[h]
        if rets:
            wins = sum(1 for r in rets if r > 0)
            res[h] = {"n": len(rets), "hit": round(wins / len(rets) * 100, 1),
                      "avg": round(sum(rets) / len(rets), 2)}
        else:
            res[h] = {"n": 0, "hit": None, "avg": None}
    return res

NAMES = {"plunge": "급락", "rsi_os": "RSI과매도", "bb_lower": "볼린저하단", "w52_low": "52주저점"}
VERDICT = {"strong": "💪 우수", "ok": "✓ 유효", "negative_edge": "⚠️ 무작위이하", "insufficient": "❓ 표본부족"}
VERDICT_TXT = {"strong": "[우수]", "ok": "[유효]", "negative_edge": "[무작위이하-주의]", "insufficient": "[표본부족]"}

def _edge(ch, b):
    if ch.get("avg") is not None and b.get("avg") is not None:
        return ch["avg"] - b["avg"]
    return None

def print_summary(report, new_thr, cur_thr):
    print("\n" + "=" * 60)
    print("  자가개선 백테스트 리포트 ·", report["updated"])
    print("  대상:", ", ".join(report["watchlist"]))
    print("=" * 60)
    b = report["baseline"].get(CALIB_HORIZON, {})
    print(f"\n[기준선] 무작위 {CALIB_HORIZON}일 보유 → 승률 {b.get('hit')}% · 평균 {b.get('avg')}%\n")
    for sig, e in report["signals"].items():
        ch = e["chosen_perf"].get(CALIB_HORIZON, {})
        edge = _edge(ch, b)
        flag = "보정됨" if e["calibrated"] else "유지"
        vt = VERDICT_TXT.get(e["verdict"], "")
        if edge is not None:
            print(f"● {NAMES[sig]:9s} {vt:16s} 기준 {e['current']}→{e['chosen']} ({flag}) "
                  f"| n={ch.get('n')} 승률 {ch.get('hit')}% 평균 {ch.get('avg')}% | 엣지 {edge:+.2f}%p")
        else:
            print(f"● {NAMES[sig]:9s} {vt:16s} 기준 {e['current']}→{e['chosen']} ({flag}) | 표본부족")
    print("\n→ thresholds.json 갱신됨 (엣지 양(+)인 신호만 채택)\n")

def build_telegram(report, new_thr, cur_thr):
    b = report["baseline"].get(CALIB_HORIZON, {})
    lines = [f"🔄 <b>자가개선 백테스트</b> · {report['updated']}",
             f"기준선({CALIB_HORIZON}일 무작위): 승률 {b.get('hit')}% / 평균 {b.get('avg')}%",
             "─" * 18]
    for sig, e in report["signals"].items():
        ch = e["chosen_perf"].get(CALIB_HORIZON, {})
        v = VERDICT.get(e["verdict"], "")
        if ch.get("avg") is None:
            lines.append(f"{v} <b>{NAMES[sig]}</b> · 표본부족(n={ch.get('n',0)})")
            continue
        edge = _edge(ch, b) or 0
        cal = " 🔧보정" if e["calibrated"] else ""
        lines.append(f"{v} <b>{NAMES[sig]}</b> 기준{e['chosen']}{cal} · "
                     f"승률 {ch['hit']}% 평균 {ch['avg']}% (엣지 {edge:+.2f}%p, n={ch['n']})")
    lines.append("─" * 18)
    lines.append("엣지(+)=무작위보다 우월 · ⚠️신호는 참고만, 자동 채택 안 함")
    return "\n".join(lines)

if __name__ == "__main__":
    main()
