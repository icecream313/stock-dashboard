# PWA 아이콘 생성 스크립트 (1회용)
from PIL import Image, ImageDraw

BG = (15, 17, 23)        # --bg
UP = (240, 68, 82)       # 상승 빨강
DOWN = (49, 130, 246)    # 하락 파랑
LINE = (232, 234, 240)   # 텍스트색


def make(size, path):
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    u = size / 100.0  # 비율 단위

    # 캔들 3개 (빨강-파랑-빨강)
    candles = [
        (22, 48, 78, UP),    # x중심%, 몸통위%, 몸통아래%
        (50, 38, 62, DOWN),
        (78, 22, 55, UP),
    ]
    bw = 14 * u  # 몸통 폭
    for cx, top, bot, color in candles:
        x = cx * u
        # 심지
        d.line([(x, (top - 10) * u), (x, (bot + 8) * u)], fill=color, width=max(1, int(2.5 * u)))
        # 몸통
        d.rounded_rectangle(
            [x - bw / 2, top * u, x + bw / 2, bot * u],
            radius=3 * u, fill=color,
        )

    # 우상향 추세선
    pts = [(10 * u, 80 * u), (38 * u, 60 * u), (60 * u, 68 * u), (90 * u, 30 * u)]
    d.line(pts, fill=LINE, width=max(1, int(3.5 * u)), joint="curve")

    img.save(path, "PNG")
    print(f"saved {path} ({size}x{size})")


make(192, "icon-192.png")
make(512, "icon-512.png")
make(180, "apple-touch-icon.png")
