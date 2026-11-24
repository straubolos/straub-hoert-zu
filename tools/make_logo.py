#!/usr/bin/env python3
"""Erzeugt das Logo von "Straub hört zu" als SVG (S + Schallwellen)."""
import math, sys, os

def build(bg=True, size=512):
    cx, cy = 191.0, 256.0
    r, sw = 58.0, 40.0
    a0, a1 = -35.0, 145.0           # Endpunkte des S
    c1 = (cx, cy - r); c2 = (cx, cy + r)
    p0 = (c1[0] + r*math.cos(math.radians(a0)), c1[1] + r*math.sin(math.radians(a0)))
    p3 = (c2[0] + r*math.cos(math.radians(a1)), c2[1] + r*math.sin(math.radians(a1)))
    s_path = (f"M{p0[0]:.2f} {p0[1]:.2f} A{r:.0f} {r:.0f} 0 1 0 {cx:.2f} {cy:.2f} "
              f"A{r:.0f} {r:.0f} 0 1 1 {p3[0]:.2f} {p3[1]:.2f}")
    waves = []
    for R, w, col, span in [(140, 24, "#A1A1A6", 37), (190, 24, "#5A5A5E", 37)]:
        c, s = math.cos(math.radians(span)), math.sin(math.radians(span))
        x = cx + R*c
        waves.append(f'<path d="M{x:.2f} {cy - R*s:.2f} A{R} {R} 0 0 1 {x:.2f} {cy + R*s:.2f}" '
                     f'stroke="{col}" stroke-width="{w}"/>')
    bg_el = ('<defs><radialGradient id="g" cx="50%" cy="38%" r="75%">'
             '<stop offset="0" stop-color="#1C1C1E"/><stop offset="1" stop-color="#000"/>'
             '</radialGradient></defs><rect width="512" height="512" fill="url(#g)"/>') if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">'
            f'{bg_el}<g fill="none" stroke-linecap="round">'
            f'<path d="{s_path}" stroke="#F5F5F7" stroke-width="{sw:.0f}"/>{"".join(waves)}</g></svg>\n')

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "icons"
    open(os.path.join(out, "logo.svg"), "w").write(build(bg=False))
    open(os.path.join(out, "icon.svg"), "w").write(build(bg=True))
    print("ok")
