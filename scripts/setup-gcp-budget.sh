#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AI Pace — Google Cloud credits setup
#
# Run once on any machine where `gcloud` is logged in with an account that administers your
# billing account. Re-run it whenever you get a new credit: it updates the budgets in place.
#
# Why: Google Cloud has no public API for "how much have I spent" or "credits remaining". The only
# official, automatic signal is budget notifications, which Cloud Billing publishes to Pub/Sub
# several times a day. This script creates, in YOUR Google Cloud account:
#
#   On the billing account (covers ALL projects, no project filter):
#     • budget "AI Pace (gross)"  — total cost, credits not subtracted
#     • budget "AI Pace (net)"    — cost after promotional credits
#     AI Pace computes  credits consumed = gross − net  (exact even if some usage isn't covered).
#     Both are notification-only: no thresholds, no emails, no spending caps.
#
#   In a "host" project of your choice (only where these small resources live; it doesn't limit
#   what is counted):
#     • Pub/Sub topic + subscription "ai-pace-budget"
#     • service account "ai-pace-reader" that can ONLY read that subscription, and a JSON key for it
#
# It talks only to Google Cloud (via gcloud and https://billingbudgets.googleapis.com) and prints
# the lines to add to the AI Pace server's .env. Requirements: gcloud, curl. Works with macOS bash 3.2.
# Non-interactive use: set HOST_PROJECT, BILLING_ACCOUNT, CREDIT_START, CREDIT_END, CREDIT_TOTAL,
# CREDIT_REMAINING (and optionally KEY_FILE) in the environment, and YES=1 to skip the confirmation.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
umask 077

TOPIC="ai-pace-budget"
SUBSCRIPTION="ai-pace-budget"
SA_NAME="ai-pace-reader"
GROSS_NAME="AI Pace (gross)"
NET_NAME="AI Pace (net)"
API="https://billingbudgets.googleapis.com/v1"

say() { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "Question" [default]
  local var=$1 question=$2 default=${3:-} answer
  if [ -n "${!var:-}" ]; then return; fi
  answer=""
  # `|| true`: without a terminal (piped/non-interactive) read hits end-of-input; fall back to the default.
  if [ -n "$default" ]; then read -r -p "$question [$default]: " answer || true; else read -r -p "$question: " answer || true; fi
  printf -v "$var" '%s' "${answer:-$default}"
}
is_date() { [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; }
is_amount() { [[ "$1" =~ ^[0-9]+([.][0-9]{1,2})?$ ]]; }
date_json() { # 2026-11-09 → {"year":2026,"month":11,"day":9}
  local y m d
  IFS=- read -r y m d <<<"$1"
  printf '{"year":%d,"month":%d,"day":%d}' "$((10#$y))" "$((10#$m))" "$((10#$d))"
}

command -v gcloud >/dev/null || die "gcloud not found. Install the Google Cloud CLI first."
command -v curl >/dev/null || die "curl not found."
ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n1)
[ -n "$ACCOUNT" ] || die "gcloud is not logged in. Run: gcloud auth login"

say "AI Pace — Google Cloud credits setup (logged in as $ACCOUNT)"
say "Copy the active credit's values from console.cloud.google.com/billing → Credits."
say "Amounts: digits with a dot for decimals, no thousand separators (e.g. 1000.00)."
say ""

ask HOST_PROJECT "Host project for the Pub/Sub queue (any project you own)" "$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$HOST_PROJECT" ] || die "A host project is required."
if [ -z "${BILLING_ACCOUNT:-}" ]; then
  BILLING_ACCOUNT=$(gcloud billing projects describe "$HOST_PROJECT" --format='value(billingAccountName)' 2>/dev/null | sed 's#^billingAccounts/##' || true)
fi
ask BILLING_ACCOUNT "Billing account ID (XXXXXX-XXXXXX-XXXXXX)"
BILLING_ACCOUNT=${BILLING_ACCOUNT#billingAccounts/}
[[ "$BILLING_ACCOUNT" =~ ^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$ ]] || die "Invalid billing account ID: $BILLING_ACCOUNT"
ask CREDIT_START "Credit start date (YYYY-MM-DD)"
ask CREDIT_END "Credit end date (YYYY-MM-DD)"
ask CREDIT_TOTAL "Credit original value"
ask CREDIT_REMAINING "Credit remaining value right now"
ask KEY_FILE "Where to save the reader key" "./ai-pace-gcp-key.json"

is_date "$CREDIT_START" || die "Invalid start date: $CREDIT_START"
is_date "$CREDIT_END" || die "Invalid end date: $CREDIT_END"
is_amount "$CREDIT_TOTAL" || die "Invalid amount: $CREDIT_TOTAL"
is_amount "$CREDIT_REMAINING" || die "Invalid amount: $CREDIT_REMAINING"
TODAY=$(date +%Y-%m-%d)
[[ "$CREDIT_END" > "$TODAY" ]] || die "The credit end date ($CREDIT_END) must be after today ($TODAY)."
USED_BEFORE=$(awk -v t="$CREDIT_TOTAL" -v r="$CREDIT_REMAINING" 'BEGIN { u = t - r; if (u < 0) u = 0; printf "%.2f", u }')
CURRENCY=$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(currencyCode)' 2>/dev/null || true)
SA_EMAIL="$SA_NAME@$HOST_PROJECT.iam.gserviceaccount.com"
TOPIC_PATH="projects/$HOST_PROJECT/topics/$TOPIC"
SUB_PATH="projects/$HOST_PROJECT/subscriptions/$SUBSCRIPTION"

cat <<EOF

This will create or update, in your Google Cloud account:
  • billing account $BILLING_ACCOUNT (all projects):
      budgets "$GROSS_NAME" and "$NET_NAME", from $TODAY to $CREDIT_END,
      notification-only (no thresholds, no emails, no caps)
  • project $HOST_PROJECT:
      enable the Pub/Sub, Billing Budgets, Cloud Billing and IAM APIs
      Pub/Sub topic and subscription "$TOPIC"
      service account $SA_EMAIL, allowed only to read that subscription
      a JSON key for it at $KEY_FILE (only if that file doesn't exist yet)
Credit: ${CURRENCY:-?} $CREDIT_TOTAL from $CREDIT_START to $CREDIT_END, $USED_BEFORE already used.
EOF
if [ "${YES:-}" != 1 ]; then
  ok=""
  read -r -p "Proceed? [y/N] " ok || true
  case "$ok" in y | Y | yes | YES) ;; *) die "Nothing was changed." ;; esac
fi

step "Enabling APIs on $HOST_PROJECT"
gcloud services enable pubsub.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com iam.googleapis.com --project "$HOST_PROJECT"

step "Pub/Sub topic and subscription"
gcloud pubsub topics describe "$TOPIC" --project "$HOST_PROJECT" >/dev/null 2>&1 ||
  gcloud pubsub topics create "$TOPIC" --project "$HOST_PROJECT"
gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project "$HOST_PROJECT" >/dev/null 2>&1 ||
  gcloud pubsub subscriptions create "$SUBSCRIPTION" --topic "$TOPIC" --ack-deadline 60 \
    --message-retention-duration 7d --expiration-period never --project "$HOST_PROJECT"

step "Read-only service account"
gcloud iam service-accounts describe "$SA_EMAIL" --project "$HOST_PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "AI Pace (reads budget notifications)" --project "$HOST_PROJECT"
gcloud pubsub subscriptions add-iam-policy-binding "$SUBSCRIPTION" --project "$HOST_PROJECT" \
  --member "serviceAccount:$SA_EMAIL" --role roles/pubsub.subscriber >/dev/null
say "  $SA_EMAIL can only consume messages from $SUB_PATH"

step "Budgets on billing account $BILLING_ACCOUNT"
# The access token goes in a private temp file, not on the command line (where other local users could see it).
HEADERS=$(mktemp)
trap 'rm -f "$HEADERS"' EXIT
{
  printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token)"
  printf 'x-goog-user-project: %s\n' "$HOST_PROJECT"
  printf 'Content-Type: application/json\n'
} >"$HEADERS"

PERIOD=$(printf '"customPeriod":{"startDate":%s,"endDate":%s}' "$(date_json "$TODAY")" "$(date_json "$CREDIT_END")")
AMOUNT=$(printf '"amount":{"specifiedAmount":{"units":"%s"}}' "${CREDIT_TOTAL%.*}")
NOTIFY=$(printf '"notificationsRule":{"pubsubTopic":"%s","schemaVersion":"1.0","disableDefaultIamRecipients":true}' "$TOPIC_PATH")

upsert_budget() { # upsert_budget "Display name" '"creditTypesTreatment":...'
  local name=$1 credits=$2 listing existing body out code
  if ! listing=$(gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --format='value(name,displayName)'); then
    die "Could not list the budgets of $BILLING_ACCOUNT (see the error above). You need Billing Account Administrator or Costs Manager."
  fi
  existing=$(printf '%s\n' "$listing" | awk -F'\t' -v n="$name" '$2 == n { print $1; exit }')
  body=$(printf '{"displayName":"%s","budgetFilter":{%s,%s},%s,%s}' "$name" "$credits" "$PERIOD" "$AMOUNT" "$NOTIFY")
  out=$(mktemp)
  if [ -n "$existing" ]; then
    code=$(curl -sS -o "$out" -w '%{http_code}' -X PATCH -H @"$HEADERS" --data "$body" \
      "$API/$existing?updateMask=budgetFilter,amount,notificationsRule")
  else
    code=$(curl -sS -o "$out" -w '%{http_code}' -X POST -H @"$HEADERS" --data "$body" \
      "$API/billingAccounts/$BILLING_ACCOUNT/budgets")
  fi
  if [ "${code:0:1}" != 2 ]; then
    cat "$out" >&2
    rm -f "$out"
    die "Could not save budget \"$name\" (HTTP $code). You need Billing Account Administrator or Costs Manager on $BILLING_ACCOUNT."
  fi
  rm -f "$out"
  say "  ✓ $name (${existing:+updated}${existing:-created})"
}
upsert_budget "$GROSS_NAME" '"creditTypesTreatment":"EXCLUDE_ALL_CREDITS"'
upsert_budget "$NET_NAME" '"creditTypesTreatment":"INCLUDE_SPECIFIED_CREDITS","creditTypes":["PROMOTION"]'

step "Reader key"
if [ -e "$KEY_FILE" ]; then
  say "  $KEY_FILE already exists, keeping it."
else
  gcloud iam service-accounts keys create "$KEY_FILE" --iam-account "$SA_EMAIL" --project "$HOST_PROJECT" ||
    die "Key creation failed (an organization policy may forbid service account keys). Nothing else needs undoing."
  chmod 600 "$KEY_FILE"
fi

cat <<EOF

✓ Done. On the AI Pace server:

  1. Copy the key (it can only read the budget queue), e.g.:
       scp "$KEY_FILE" your-server:~/.config/ai-pace/gcp-sa.json
     then on the server: chmod 600 ~/.config/ai-pace/gcp-sa.json
     and delete the local copy.

  2. Set these in the server's .env:
       GEMINI_CREDIT_TOTAL=$CREDIT_TOTAL
       GEMINI_CREDIT_CURRENCY=${CURRENCY:-USD}
       GEMINI_CREDIT_START=$CREDIT_START
       GEMINI_CREDIT_END=$CREDIT_END
       GEMINI_CREDIT_USED_OFFSET=$USED_BEFORE
       GCP_PUBSUB_SUBSCRIPTION=$SUB_PATH
       GCP_BUDGET_SINCE=$TODAY
       GCP_SERVICE_ACCOUNT_FILE=~/.config/ai-pace/gcp-sa.json

  3. Restart the server. Google sends the first budget update within a few hours.

When your next credit arrives, run this script again with the new values.
EOF
