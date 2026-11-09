#!/usr/bin/env bash
# <xbar.title>AI Pace</xbar.title>
# <xbar.version>v0.1.0</xbar.version>
# <xbar.desc>Are you using Claude, OpenAI and Gemini faster than your plan allows?</xbar.desc>
# <xbar.dependencies>curl</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
#
# SwiftBar (https://swiftbar.app) or xbar plugin. The file name sets the interval
# (".5m." = every 5 minutes; the server caches the data, so this is cheap).
# Menu bar: C▲ O● G▼  →  ▲ above pace · ● on pace · ▼ below pace · ■ limit reached · ⚠ action needed.
#
# Configure below (or export AIPACE_URL / AIPACE_TOKEN):

AIPACE_URL="${AIPACE_URL:-https://your-server}"
AIPACE_TOKEN="${AIPACE_TOKEN:-PASTE-YOUR-TOKEN-HERE}"

if ! out=$(curl -fsS --max-time 10 --proto '=https,http' -H "Authorization: Bearer ${AIPACE_TOKEN}" "${AIPACE_URL%/}/api/v1/swiftbar" 2>&1); then
  echo "AI ⚠ | color=#898781"
  echo "---"
  echo "No answer from ${AIPACE_URL} | size=12"
  echo "${out//|//} | size=11 color=#898781"
  echo "Try again | refresh=true"
  exit 0
fi
printf '%s\n' "$out"
