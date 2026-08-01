#!/usr/bin/env bash
#
# Copy one Cloudflare Cache Rule from an old zone/account to a new zone/account.
#
# Required environment variables:
#   CF_OLD_API_TOKEN       Token that can read Cache Rules for the old zone
#   CLOUDFLARE_API_TOKEN   Token that can edit Cache Rules for the new zone
#
# Optional overrides:
#   OLD_ZONE_NAME          default: chronicillnesschannel.co.uk
#   NEW_ZONE_NAME          default: ukaq.co.uk
#   OLD_ZONE_ID            skip old-zone lookup when supplied
#   NEW_ZONE_ID            skip new-zone lookup when supplied
#   OLD_HOST               default: uk-aq-beta.chronicillnesschannel.co.uk
#   NEW_HOST               default: beta.ukaq.co.uk
#
# Usage:
#   ./copy_cloudflare_cache_rule.sh --check
#   ./copy_cloudflare_cache_rule.sh --dry-run
#   ./copy_cloudflare_cache_rule.sh
#
set -euo pipefail

CF_API="https://api.cloudflare.com/client/v4"

OLD_ZONE_NAME="${OLD_ZONE_NAME:-chronicillnesschannel.co.uk}"
NEW_ZONE_NAME="${NEW_ZONE_NAME:-ukaq.co.uk}"
OLD_ZONE_ID="${OLD_ZONE_ID:-}"
NEW_ZONE_ID="${NEW_ZONE_ID:-}"
OLD_HOST="${OLD_HOST:-uk-aq-beta.chronicillnesschannel.co.uk}"
NEW_HOST="${NEW_HOST:-beta.ukaq.co.uk}"

MODE="apply"
case "${1:-}" in
  "")
    ;;
  --check)
    MODE="check"
    ;;
  --dry-run)
    MODE="dry-run"
    ;;
  -h|--help)
    sed -n '2,24p' "$0"
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: $0 [--check|--dry-run]" >&2
    exit 2
    ;;
esac

for command_name in curl jq mktemp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

: "${CF_OLD_API_TOKEN:?CF_OLD_API_TOKEN is not set in the current shell}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set in the current shell}"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ukaq-cache-rule.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

RESPONSE_FILE="${TMP_DIR}/response.json"
HTTP_STATUS=""

api_call() {
  token="$1"
  method="$2"
  url="$3"
  body="${4:-}"

  if [ -n "$body" ]; then
    if ! HTTP_STATUS="$(
      curl -sS \
        --output "$RESPONSE_FILE" \
        --write-out '%{http_code}' \
        --request "$method" \
        --header "Authorization: Bearer ${token}" \
        --header 'Content-Type: application/json' \
        --data "$body" \
        "$url"
    )"; then
      echo "curl failed while calling: $method $url" >&2
      exit 1
    fi
  else
    if ! HTTP_STATUS="$(
      curl -sS \
        --output "$RESPONSE_FILE" \
        --write-out '%{http_code}' \
        --request "$method" \
        --header "Authorization: Bearer ${token}" \
        "$url"
    )"; then
      echo "curl failed while calling: $method $url" >&2
      exit 1
    fi
  fi
}

print_api_error() {
  label="$1"
  echo "${label} failed with HTTP ${HTTP_STATUS}." >&2

  if jq -e . "$RESPONSE_FILE" >/dev/null 2>&1; then
    jq '{
      success,
      errors,
      messages
    }' "$RESPONSE_FILE" >&2
  else
    cat "$RESPONSE_FILE" >&2
  fi
}

require_success_200() {
  label="$1"
  if [ "$HTTP_STATUS" != "200" ] || ! jq -e '.success == true' "$RESPONSE_FILE" >/dev/null 2>&1; then
    print_api_error "$label"
    exit 1
  fi
}

verify_token() {
  token="$1"
  label="$2"

  api_call "$token" GET "${CF_API}/user/tokens/verify"
  require_success_200 "${label} token verification"

  status="$(jq -r '.result.status // empty' "$RESPONSE_FILE")"
  if [ "$status" != "active" ]; then
    echo "${label} token is not active. Status: ${status:-unknown}" >&2
    exit 1
  fi

  token_id="$(jq -r '.result.id // empty' "$RESPONSE_FILE")"
  echo "${label} token: active (${token_id:-ID unavailable})"
}

resolve_zone_id() {
  token="$1"
  zone_name="$2"
  label="$3"

  api_call "$token" GET \
    "${CF_API}/zones?name=${zone_name}&status=active&match=all&per_page=50"
  require_success_200 "${label} zone lookup"

  result_count="$(jq '.result | length' "$RESPONSE_FILE")"
  if [ "$result_count" -ne 1 ]; then
    echo "${label} token returned ${result_count} active zones named ${zone_name}; expected exactly one." >&2
    jq '{result: [.result[]? | {id, name, status, account: .account.name}]}' "$RESPONSE_FILE" >&2
    exit 1
  fi

  jq -r '.result[0].id' "$RESPONSE_FILE"
}

get_cache_rules_entrypoint() {
  token="$1"
  zone_id="$2"
  label="$3"
  allow_missing="$4"

  api_call "$token" GET \
    "${CF_API}/zones/${zone_id}/rulesets/phases/http_request_cache_settings/entrypoint"

  if [ "$HTTP_STATUS" = "404" ] && [ "$allow_missing" = "true" ]; then
    return 4
  fi

  if [ "$HTTP_STATUS" != "200" ] || ! jq -e '.success == true' "$RESPONSE_FILE" >/dev/null 2>&1; then
    print_api_error "${label} Cache Rules read"
    echo >&2
    echo "The token is valid for the zone but does not have enough Cache Rules/Rulesets permission." >&2
    return 1
  fi

  return 0
}

echo "Checking API tokens..."
verify_token "$CF_OLD_API_TOKEN" "Old-account"
verify_token "$CLOUDFLARE_API_TOKEN" "New-account"

echo
echo "Resolving zones..."
if [ -n "$OLD_ZONE_ID" ]; then
  echo "Using supplied old zone ID; Zone Read is not required for lookup."
else
  OLD_ZONE_ID="$(resolve_zone_id "$CF_OLD_API_TOKEN" "$OLD_ZONE_NAME" "Old-account")"
fi

if [ -n "$NEW_ZONE_ID" ]; then
  echo "Using supplied new zone ID; Zone Read is not required for lookup."
else
  NEW_ZONE_ID="$(resolve_zone_id "$CLOUDFLARE_API_TOKEN" "$NEW_ZONE_NAME" "New-account")"
fi

if ! [[ "$OLD_ZONE_ID" =~ ^[0-9a-fA-F]{32}$ ]]; then
  echo "Invalid OLD_ZONE_ID: ${OLD_ZONE_ID}" >&2
  exit 1
fi
if ! [[ "$NEW_ZONE_ID" =~ ^[0-9a-fA-F]{32}$ ]]; then
  echo "Invalid NEW_ZONE_ID: ${NEW_ZONE_ID}" >&2
  exit 1
fi

echo "Old zone: ${OLD_ZONE_NAME} (${OLD_ZONE_ID})"
echo "New zone: ${NEW_ZONE_NAME} (${NEW_ZONE_ID})"

echo
echo "Checking access to the old Cache Rules..."
get_cache_rules_entrypoint "$CF_OLD_API_TOKEN" "$OLD_ZONE_ID" "Old-account" "false"
cp "$RESPONSE_FILE" "${TMP_DIR}/old-ruleset.json"

SOURCE_MATCH_COUNT="$(
  jq \
    --arg old_host "$OLD_HOST" \
    '[.result.rules[]? | select((.expression // "") | contains($old_host))] | length' \
    "${TMP_DIR}/old-ruleset.json"
)"

if [ "$SOURCE_MATCH_COUNT" -eq 0 ]; then
  echo "No enabled or disabled Cache Rule contains the old host: ${OLD_HOST}" >&2
  echo "Available old-zone Cache Rules:" >&2
  jq -r '.result.rules[]? | "- " + (.description // "(no description)") + ": " + (.expression // "")' \
    "${TMP_DIR}/old-ruleset.json" >&2
  exit 1
fi

if [ "$SOURCE_MATCH_COUNT" -ne 1 ]; then
  echo "Found ${SOURCE_MATCH_COUNT} Cache Rules containing ${OLD_HOST}; expected exactly one." >&2
  jq \
    --arg old_host "$OLD_HOST" \
    '[.result.rules[]? | select((.expression // "") | contains($old_host))
      | {id, description, enabled, expression, action_parameters}]' \
    "${TMP_DIR}/old-ruleset.json" >&2
  exit 1
fi

SOURCE_RULE="$(
  jq -c \
    --arg old_host "$OLD_HOST" \
    --arg new_host "$NEW_HOST" '
      .result.rules[]
      | select((.expression // "") | contains($old_host))
      | {
          action,
          action_parameters,
          expression: ((.expression // "") | gsub($old_host; $new_host)),
          description: (
            if (.description // "") == ""
            then ("UK AQ cache rule for " + $new_host)
            else ((.description // "") | gsub($old_host; $new_host))
            end
          ),
          enabled: (.enabled // true)
        }
    ' "${TMP_DIR}/old-ruleset.json"
)"

echo
echo "Source rule transformed for the new hostname:"
printf '%s\n' "$SOURCE_RULE" | jq

echo
echo "Checking access to the new Cache Rules..."
set +e
get_cache_rules_entrypoint "$CLOUDFLARE_API_TOKEN" "$NEW_ZONE_ID" "New-account" "true"
TARGET_ENTRYPOINT_RESULT=$?
set -e

if [ "$TARGET_ENTRYPOINT_RESULT" -eq 1 ]; then
  exit 1
fi

if [ "$TARGET_ENTRYPOINT_RESULT" -eq 0 ]; then
  cp "$RESPONSE_FILE" "${TMP_DIR}/new-ruleset.json"

  TARGET_RULESET_ID="$(jq -r '.result.id' "${TMP_DIR}/new-ruleset.json")"
  EXISTING_MATCH_COUNT="$(
    jq \
      --arg new_host "$NEW_HOST" \
      '[.result.rules[]? | select((.expression // "") | contains($new_host))] | length' \
      "${TMP_DIR}/new-ruleset.json"
  )"

  if [ "$EXISTING_MATCH_COUNT" -gt 0 ]; then
    echo
    echo "A Cache Rule for ${NEW_HOST} already exists. Nothing changed."
    jq \
      --arg new_host "$NEW_HOST" \
      '[.result.rules[]? | select((.expression // "") | contains($new_host))
        | {id, description, enabled, expression, action_parameters}]' \
      "${TMP_DIR}/new-ruleset.json"
    exit 0
  fi

  if [ "$MODE" = "check" ]; then
    echo
    echo "Checks passed. The target ruleset exists and the rule is not present."
    exit 0
  fi

  if [ "$MODE" = "dry-run" ]; then
    echo
    echo "Dry run only. The following rule would be added to ruleset ${TARGET_RULESET_ID}:"
    printf '%s\n' "$SOURCE_RULE" | jq
    exit 0
  fi

  echo
  echo "Adding the rule to existing target ruleset ${TARGET_RULESET_ID}..."
  api_call "$CLOUDFLARE_API_TOKEN" POST \
    "${CF_API}/zones/${NEW_ZONE_ID}/rulesets/${TARGET_RULESET_ID}/rules" \
    "$SOURCE_RULE"

  if [ "$HTTP_STATUS" != "200" ] || ! jq -e '.success == true' "$RESPONSE_FILE" >/dev/null 2>&1; then
    print_api_error "Create target Cache Rule"
    exit 1
  fi

  echo "Cache Rule created successfully."
  jq \
    --arg new_host "$NEW_HOST" \
    '.result.rules
      | map(select((.expression // "") | contains($new_host)))
      | map({id, description, enabled, expression, action_parameters})' \
    "$RESPONSE_FILE"
  exit 0
fi

# A 404 means the target zone does not yet have a Cache Rules phase entrypoint.
if [ "$MODE" = "check" ]; then
  echo
  echo "Checks passed. The target zone has no Cache Rules ruleset yet."
  exit 0
fi

CREATE_RULESET_PAYLOAD="$(
  jq -cn \
    --arg zone_name "$NEW_ZONE_NAME" \
    --argjson rule "$SOURCE_RULE" '
      {
        name: "Cloudflare Cache Rules",
        description: ("Cache Rules for " + $zone_name),
        kind: "zone",
        phase: "http_request_cache_settings",
        rules: [$rule]
      }
    '
)"

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "Dry run only. A new Cache Rules ruleset would be created with:"
  printf '%s\n' "$CREATE_RULESET_PAYLOAD" | jq
  exit 0
fi

echo
echo "Creating the target Cache Rules ruleset and rule..."
api_call "$CLOUDFLARE_API_TOKEN" POST \
  "${CF_API}/zones/${NEW_ZONE_ID}/rulesets" \
  "$CREATE_RULESET_PAYLOAD"

if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "201" ]; then
  print_api_error "Create target Cache Rules ruleset"
  exit 1
fi
if ! jq -e '.success == true' "$RESPONSE_FILE" >/dev/null 2>&1; then
  print_api_error "Create target Cache Rules ruleset"
  exit 1
fi

echo "Cache Rules ruleset and rule created successfully."
jq '{
  ruleset_id: .result.id,
  name: .result.name,
  phase: .result.phase,
  rules: [
    .result.rules[]?
    | {id, description, enabled, expression, action_parameters}
  ]
}' "$RESPONSE_FILE"
