#!/bin/zsh
# Rendert icons/icon.svg mit Chrome headless und erzeugt alle PNG-Icongrößen.
set -e
ROOT="${0:A:h:h}"
TMP="$(mktemp -d)"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
printf '<html><body style="margin:0;background:#000"><img src="file://%s/icons/icon.svg" style="width:1024px;height:1024px;display:block"></body></html>' "$ROOT" > "$TMP/r.html"
"$CH" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --window-size=1024,1024 --screenshot="$TMP/icon-1024.png" "file://$TMP/r.html" >/dev/null 2>&1
python3 - "$TMP/icon-1024.png" "$ROOT/icons" <<'PY'
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
assert im.size == (1024, 1024), im.size
for s in [512, 384, 192, 180, 167, 152, 120, 96, 48, 32, 16]:
    im.resize((s, s), Image.LANCZOS).save(f"{out}/icon-{s}.png", optimize=True)
im.resize((180, 180), Image.LANCZOS).save(f"{out}/apple-touch-icon.png", optimize=True)
for s in [512, 192]:
    im.resize((s, s), Image.LANCZOS).save(f"{out}/icon-maskable-{s}.png", optimize=True)
im.resize((32, 32), Image.LANCZOS).save(f"{out}/favicon.ico", sizes=[(16,16),(32,32),(48,48)])
print("icons ok")
PY
rm -rf "$TMP"
