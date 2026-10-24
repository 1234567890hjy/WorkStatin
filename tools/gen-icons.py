#!/usr/bin/env python3
"""生成 PWA 所需的 PNG 图标。

为什么必须用 PNG：
Chrome Android 要求 PWA 必须有 192x192 和 512x512 的 PNG 图标才允许「安装」，
只有 SVG 图标时不会被当作可安装应用，也就**不会出现在系统分享面板里**。
这正是 share_target 失效的直接原因。
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OUT = Path(__file__).resolve().parents[1] / "apps" / "web" / "public"

BG = (15, 23, 42)       # #0f172a
CARD = (248, 250, 252)  # #f8fafc
BAR = (51, 65, 85)      # #334155
ACCENT = (34, 197, 94)  # 绿色对勾


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def render(size: int, maskable: bool) -> Image.Image:
    """画一个「卡片 + 对勾」的图标。

    maskable 版本四周留更多内边距（安全区 80%），
    否则 Android 自适应图标会把边缘裁掉。
    """
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)

    s = size
    pad = int(s * 0.22) if maskable else int(s * 0.14)
    inner = s - pad * 2

    # 卡片主体
    radius = int(inner * 0.18)
    rounded_rect(d, (pad, pad + int(inner * 0.08), pad + inner, pad + inner), radius, CARD)

    # 顶部色条
    bar_h = int(inner * 0.16)
    d.rounded_rectangle(
        (pad, pad + int(inner * 0.08), pad + inner, pad + int(inner * 0.08) + bar_h),
        radius=int(inner * 0.10),
        fill=BAR,
    )

    # 中间圆形
    cx = pad + inner // 2
    cy = pad + int(inner * 0.60)
    r = int(inner * 0.20)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BG)

    # 对勾
    w = max(2, int(inner * 0.055))
    d.line(
        [
            (cx - int(r * 0.45), cy),
            (cx - int(r * 0.05), cy + int(r * 0.40)),
            (cx + int(r * 0.50), cy - int(r * 0.38)),
        ],
        fill=ACCENT,
        width=w,
        joint="curve",
    )

    return img


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-512-maskable.png", 512, True),
        ("apple-touch-icon.png", 180, False),
    ]

    for name, size, maskable in targets:
        img = render(size, maskable)
        path = OUT / name
        img.save(path, "PNG", optimize=True)
        print(f"✅ {name}  {size}x{size}  {path.stat().st_size} bytes")

    # favicon
    render(64, False).save(OUT / "favicon.png", "PNG", optimize=True)
    print("✅ favicon.png  64x64")

    return 0


if __name__ == "__main__":
    sys.exit(main())
