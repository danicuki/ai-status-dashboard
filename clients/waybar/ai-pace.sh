#!/usr/bin/env bash
# Waybar module (Hyprland / Sway / omarchy). Shows colored C▲ O● G▼; the tooltip has the details.
# Setup: see clients/waybar/README.md

AIPACE_URL="${AIPACE_URL:-http://localhost:8787}"
AIPACE_TOKEN="${AIPACE_TOKEN:-PASTE-YOUR-TOKEN-HERE}"

if ! curl -fsS --max-time 8 -H "Authorization: Bearer ${AIPACE_TOKEN}" "${AIPACE_URL%/}/api/v1/waybar" 2>/dev/null; then
  printf '{"text":"AI ⚠","tooltip":"AI Pace: no answer from %s","class":"error"}\n' "$AIPACE_URL"
fi
