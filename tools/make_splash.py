#!/usr/bin/env python3
"""Erzeugt iOS-Startbildschirme (schwarz mit Logo) und gibt die <link>-Tags aus."""
import sys
from PIL import Image

DEVICES = [  # (CSS-Breite, CSS-Höhe, Pixelverhältnis)
    (440, 956, 3), (402, 874, 3), (430, 932, 3), (393, 852, 3), (420, 912, 3),
    (428, 926, 3), (390, 844, 3), (375, 812, 3), (414, 896, 3), (414, 896, 2),
    (375, 667, 2), (414, 736, 3),
]

logo_path, out_dir = sys.argv[1], sys.argv[2]
logo = Image.open(logo_path).convert("RGBA")
bbox = logo.getbbox()
logo = logo.crop(bbox)
tags = []
for w, h, r in DEVICES:
    W, H = w * r, h * r
    img = Image.new("RGB", (W, H), (0, 0, 0))
    lw = int(W * 0.26)
    lh = int(logo.height * lw / logo.width)
    l = logo.resize((lw, lh), Image.LANCZOS)
    img.paste(l, ((W - lw) // 2, int(H * 0.46 - lh / 2)), l)
    name = f"splash-{W}x{H}.png"
    img.save(f"{out_dir}/{name}", optimize=True)
    tags.append(f'<link rel="apple-touch-startup-image" href="icons/splash/{name}" '
                f'media="(device-width: {w}px) and (device-height: {h}px) and (-webkit-device-pixel-ratio: {r}) and (orientation: portrait)">')
print("\n".join(tags))
