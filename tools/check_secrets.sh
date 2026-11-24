#!/bin/sh
# Prüft alle Dateien, die ins Repo gehen, auf Geheimnisse (z. B. OpenAI-Schlüssel).
# Wird als git pre-commit- und pre-push-Hook genutzt. Exit-Code 1 = Fund.
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1
FILES=$(git ls-files --cached --others --exclude-standard 2>/dev/null || find . -type f -not -path './.git/*')
PATTERN='sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|["'\''=: ][0-9a-f]{40}["'\''[:space:]]'
FOUND=0
for f in $FILES; do
  [ -f "$f" ] || continue
  case "$f" in *.png|*.ico|*.jpg|*.jpeg|*.gif|*.webp) continue ;; esac
  if grep -EnI "$PATTERN" "$f" >/dev/null 2>&1; then
    echo "Möglicher geheimer Schlüssel in: $f"
    grep -EnI "$PATTERN" "$f" | sed -E 's/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/\1…(gekürzt)/g' | head -5
    FOUND=1
  fi
done
for f in $FILES; do
  case "$f" in .env|.env.*|*/.env|*/.env.*|*.pem|*.key|secrets*|*/secrets*) echo "Verdächtige Datei: $f"; FOUND=1 ;; esac
done
if [ "$FOUND" -ne 0 ]; then
  echo "Abgebrochen: Bitte Geheimnisse entfernen." >&2
  exit 1
fi
echo "Keine Geheimnisse gefunden."
