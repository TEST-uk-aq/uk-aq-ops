#!/usr/bin/env bash
#!trigger
set -euo pipefail

readonly SUPABASE_SECRETS_ENV_KEY="SUPABASE_SECRETS_ENV"
readonly WORKFLOW_SECRET_PATTERN='secrets\.[A-Z0-9_]+'
readonly WORKFLOW_SECRET_SED='s/.*secrets\.([A-Z0-9_]+).*/\1/'

usage() {
  cat <<'EOF'
Sync GitHub Actions repo secrets from local env files.

Usage:
  scripts/uk_aq_sync_github_secrets.sh [options]

Options:
  --repo <owner/name>            GitHub repo (default: current gh repo)
  --env-file <path>              Env file for per-secret key/value sync (default: .env)
  --supabase-env-file <path>     Env file to upload as SUPABASE_SECRETS_ENV (default: .env.supabase)
  --targets-file <path>          CSV map of KEY -> target(secret|variable|both|local) (default: config/uk_aq_github_env_targets.csv)
  --dry-run                      Show what would be updated without changing secrets
  -h, --help                     Show help

Notes:
  - Routing is controlled by --targets-file. Unmapped keys default to local-only (not synced to GitHub).
  - SUPABASE_SECRETS_ENV is built from non-local keys in --supabase-env-file.
  - For GCP_SA_KEY, if VALUE is a path to a local file, the file contents are uploaded.
EOF
}

REPO=""
ENV_FILE=".env"
SUPABASE_ENV_FILE=".env.supabase"
TARGETS_FILE="config/uk_aq_github_env_targets.csv"
DRY_RUN=0
SEEN_FILE="$(mktemp)"
TARGETS_CACHE_FILE="$(mktemp)"
PROCESSED_KEYS_FILE="$(mktemp)"
REQUIRED_FILE=""

cleanup() {
  rm -f "${SEEN_FILE}"
  rm -f "${TARGETS_CACHE_FILE}"
  rm -f "${PROCESSED_KEYS_FILE}"
  if [[ -n "${REQUIRED_FILE}" ]]; then
    rm -f "${REQUIRED_FILE}"
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --supabase-env-file)
      SUPABASE_ENV_FILE="${2:-}"
      shift 2
      ;;
    --targets-file)
      TARGETS_FILE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

HAS_GH=1
GH_USE_LOGIN_AUTH=0
if ! command -v gh >/dev/null 2>&1; then
  HAS_GH=0
fi

if [[ "${HAS_GH}" -eq 1 ]]; then
  if env -u GH_TOKEN -u GITHUB_TOKEN gh auth status >/dev/null 2>&1; then
    GH_USE_LOGIN_AUTH=1
  fi
fi

gh_cmd() {
  if [[ "${GH_USE_LOGIN_AUTH}" -eq 1 ]]; then
    env -u GH_TOKEN -u GITHUB_TOKEN gh "$@"
  else
    gh "$@"
  fi
}

if [[ -z "${REPO}" && "${HAS_GH}" -eq 1 ]]; then
  REPO="$(gh_cmd repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
fi
if [[ -z "${REPO}" ]]; then
  echo "Could not determine GitHub repo. Pass --repo owner/name." >&2
  exit 1
fi

if [[ "${HAS_GH}" -eq 0 && "${DRY_RUN}" -eq 0 ]]; then
  echo "gh CLI is required for non-dry-run execution." >&2
  exit 1
fi

if [[ "${DRY_RUN}" -eq 0 ]]; then
  gh_cmd auth status >/dev/null
fi

load_targets_map() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    echo "Targets file not found: ${file}" >&2
    exit 1
  fi

  python3 - "${file}" "${TARGETS_CACHE_FILE}" <<'PY'
import csv
import re
import sys
from pathlib import Path

source = Path(sys.argv[1])
output = Path(sys.argv[2])

allowed_targets = {"secret", "variable", "both", "local"}
key_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
seen = {}

with source.open("r", encoding="utf-8", newline="") as handle:
    reader = csv.DictReader(handle)
    if not reader.fieldnames:
        raise SystemExit(f"Targets file is empty: {source}")
    normalized = {name.strip().lower(): name for name in reader.fieldnames}
    if "key" not in normalized or "target" not in normalized:
        raise SystemExit(
            f"Targets file must contain 'key' and 'target' columns: {source}"
        )
    key_col = normalized["key"]
    target_col = normalized["target"]

    for idx, row in enumerate(reader, start=2):
        raw_key = (row.get(key_col) or "").strip()
        raw_target = (row.get(target_col) or "").strip().lower()
        if not raw_key:
            continue
        if not key_re.match(raw_key):
            raise SystemExit(
                f"Invalid key '{raw_key}' at {source}:{idx}. "
                "Keys must match [A-Za-z_][A-Za-z0-9_]*."
            )
        if raw_target not in allowed_targets:
            raise SystemExit(
                f"Invalid target '{raw_target}' for key '{raw_key}' at {source}:{idx}. "
                "Allowed: secret, variable, both, local."
            )
        previous = seen.get(raw_key)
        if previous and previous != raw_target:
            raise SystemExit(
                f"Conflicting targets for key '{raw_key}': '{previous}' vs '{raw_target}'."
            )
        seen[raw_key] = raw_target

with output.open("w", encoding="utf-8") as handle:
    for key in sorted(seen):
        handle.write(f"{key}\t{seen[key]}\n")
PY
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

strip_inline_comment() {
  local input="$1"
  local output=""
  local i ch prev_char
  local in_single=0
  local in_double=0
  local escaped=0

  for ((i=0; i<${#input}; i++)); do
    ch="${input:i:1}"

    if (( in_single )); then
      [[ "${ch}" == "'" ]] && in_single=0
      output+="${ch}"
      continue
    fi

    if (( in_double )); then
      if (( escaped )); then
        escaped=0
      elif [[ "${ch}" == "\\" ]]; then
        escaped=1
      elif [[ "${ch}" == '"' ]]; then
        in_double=0
      fi
      output+="${ch}"
      continue
    fi

    if [[ "${ch}" == "'" ]]; then
      in_single=1
      output+="${ch}"
      continue
    fi

    if [[ "${ch}" == '"' ]]; then
      in_double=1
      output+="${ch}"
      continue
    fi

    if [[ "${ch}" == "#" ]]; then
      prev_char=""
      if (( i > 0 )); then
        prev_char="${input:i-1:1}"
      fi
      if [[ -z "${prev_char}" || "${prev_char}" =~ [[:space:]] ]]; then
        break
      fi
    fi

    output+="${ch}"
  done

  trim "${output}"
}

set_secret() {
  local name="$1"
  local value="$2"
  local tmp_secret_file=""
  local gh_status=0
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would set ${name} (len=${#value})"
  else
    tmp_secret_file="$(mktemp)"
    chmod 600 "${tmp_secret_file}" || true
    printf '%s' "${value}" > "${tmp_secret_file}"
    if gh_cmd secret set "${name}" --repo "${REPO}" < "${tmp_secret_file}"; then
      :
    else
      gh_status=$?
    fi
    rm -f "${tmp_secret_file}"
    if [[ "${gh_status}" -ne 0 ]]; then
      return "${gh_status}"
    fi
    echo "set ${name}"
  fi
  printf '%s\n' "${name}" >> "${SEEN_FILE}"
}

set_variable() {
  local name="$1"
  local value="$2"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would set variable ${name} (len=${#value})"
  else
    gh_cmd variable set "${name}" --repo "${REPO}" --body "${value}"
    echo "set variable ${name}"
  fi
}

target_for_key() {
  local key="$1"
  local target
  target="$(awk -F $'\t' -v key="${key}" '$1 == key { print $2; exit }' "${TARGETS_CACHE_FILE}")"
  if [[ -z "${target}" ]]; then
    echo "local"
    return 0
  fi
  echo "${target}"
}

key_already_processed() {
  local key="$1"
  grep -Fxq "${key}" "${PROCESSED_KEYS_FILE}"
}

mark_key_processed() {
  local key="$1"
  printf '%s\n' "${key}" >> "${PROCESSED_KEYS_FILE}"
}

resolve_secret_value() {
  local key="$1"
  local value="$2"

  if [[ "${key}" == "GCP_SA_KEY" && -f "${value}" ]]; then
    if [[ ! -r "${value}" ]]; then
      echo "Error: GCP_SA_KEY file is not readable: ${value}" >&2
      exit 1
    fi

    # Refuse obviously unsafe permissions when we can determine them.
    # GNU: stat -c %a, BSD/macOS: stat -f %Lp
    local perms=""
    if perms="$(stat -c %a -- "${value}" 2>/dev/null)"; then
      :
    elif perms="$(stat -f %Lp -- "${value}" 2>/dev/null)"; then
      :
    fi
    if [[ -n "${perms}" ]]; then
      local others_perm="${perms: -1}"
      if [[ "${others_perm}" != "0" ]]; then
        echo "Error: GCP_SA_KEY file must not be world-readable (${value}, mode ${perms})" >&2
        exit 1
      fi
    fi

    cat "${value}"
    return 0
  fi

  if [[ "${key}" == "SUPABASE_DB_URL" ]]; then
    python3 - "${value}" <<'PY'
import sys
from urllib.parse import quote, unquote, urlsplit, urlunsplit

raw = sys.argv[1]
try:
    parsed = urlsplit(raw)
except Exception:
    print(raw)
    raise SystemExit(0)

if not parsed.scheme or not parsed.netloc or parsed.password is None:
    print(raw)
    raise SystemExit(0)

username = parsed.username or ""
password = parsed.password or ""
hostname = parsed.hostname or ""
host = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
port = f":{parsed.port}" if parsed.port else ""

userinfo = username
if parsed.password is not None:
    # urlsplit keeps percent escapes in parsed.password.
    # Decode once to canonical text, then re-encode once to avoid accidental double-encoding.
    canonical_password = unquote(password)
    userinfo = f"{username}:{quote(canonical_password, safe='')}"

netloc = f"{userinfo}@{host}{port}"
encoded = urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))
print(encoded)
PY
    return 0
  fi

  printf '%s' "${value}"
}

sync_env_vars() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    echo "skip missing file: ${file}" >&2
    return 0
  fi

  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    local line key value first_char last_char target
    line="${raw_line%$'\r'}"
    line="$(trim "${line}")"
    [[ -z "${line}" ]] && continue
    [[ "${line}" == \#* ]] && continue
    [[ "${line}" == export\ * ]] && line="${line#export }"
    [[ "${line}" != *=* ]] && continue

    key="$(trim "${line%%=*}")"
    value="${line#*=}"
    value="$(strip_inline_comment "${value}")"

    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "skip invalid key in ${file}: ${key}" >&2
      continue
    fi
    if [[ "${key}" == "${SUPABASE_SECRETS_ENV_KEY}" ]]; then
      echo "skip reserved ${key} from ${file}; value is built from filtered ${SUPABASE_ENV_FILE}"
      continue
    fi
    if key_already_processed "${key}"; then
      echo "skip duplicate key ${key} from ${file} (already processed)"
      continue
    fi

    first_char="${value:0:1}"
    last_char="${value: -1}"
    if [[ "${#value}" -ge 2 && "${first_char}" == '"' && "${last_char}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${#value}" -ge 2 && "${first_char}" == "'" && "${last_char}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi

    value="$(resolve_secret_value "${key}" "${value}")"
    target="$(target_for_key "${key}")"
    case "${target}" in
      secret)
        set_secret "${key}" "${value}"
        ;;
      variable)
        set_variable "${key}" "${value}"
        ;;
      both)
        set_variable "${key}" "${value}"
        set_secret "${key}" "${value}"
        ;;
      local)
        echo "skip local-only ${key}"
        ;;
      *)
        echo "Invalid target '${target}' for key '${key}' from ${TARGETS_FILE}" >&2
        exit 1
        ;;
    esac
    mark_key_processed "${key}"
  done < "${file}"
}

build_filtered_supabase_env_payload() {
  local file="$1"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi

  local raw_line line key value target
  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    line="${raw_line%$'\r'}"
    line="$(trim "${line}")"
    [[ -z "${line}" ]] && continue
    [[ "${line}" == \#* ]] && continue
    [[ "${line}" == export\ * ]] && line="${line#export }"
    [[ "${line}" != *=* ]] && continue

    key="$(trim "${line%%=*}")"
    value="${line#*=}"
    value="$(strip_inline_comment "${value}")"

    if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      continue
    fi
    if [[ "${key}" == "${SUPABASE_SECRETS_ENV_KEY}" ]]; then
      continue
    fi

    target="$(target_for_key "${key}")"
    if [[ "${target}" == "local" ]]; then
      continue
    fi

    printf '%s=%s\n' "${key}" "${value}"
  done < "${file}"
}

load_targets_map "${TARGETS_FILE}"
sync_env_vars "${ENV_FILE}"
sync_env_vars "${SUPABASE_ENV_FILE}"

if [[ -f "${SUPABASE_ENV_FILE}" ]]; then
  SUPABASE_SECRETS_ENV_VALUE="$(build_filtered_supabase_env_payload "${SUPABASE_ENV_FILE}")"
  if [[ -n "${SUPABASE_SECRETS_ENV_VALUE}" ]]; then
    set_secret "${SUPABASE_SECRETS_ENV_KEY}" "${SUPABASE_SECRETS_ENV_VALUE}"
  else
    echo "skip ${SUPABASE_SECRETS_ENV_KEY} (no non-local keys found in ${SUPABASE_ENV_FILE})"
  fi
fi

WORKFLOW_DIR=".github/workflows"
if [[ -d "${WORKFLOW_DIR}" ]]; then
  REQUIRED_FILE="$(mktemp)"
  if command -v rg >/dev/null 2>&1; then
    rg -n "${WORKFLOW_SECRET_PATTERN}" "${WORKFLOW_DIR}"/*.yml \
      | sed -E "${WORKFLOW_SECRET_SED}" \
      | sort -u > "${REQUIRED_FILE}"
  else
    grep -RnoE "${WORKFLOW_SECRET_PATTERN}" "${WORKFLOW_DIR}" --include="*.yml" \
      | sed -E "${WORKFLOW_SECRET_SED}" \
      | sort -u > "${REQUIRED_FILE}"
  fi

  sort -u "${SEEN_FILE}" -o "${SEEN_FILE}"
  MISSING="$(comm -23 "${REQUIRED_FILE}" "${SEEN_FILE}" || true)"
  if [[ -n "${MISSING}" ]]; then
    echo
    echo "Secrets referenced by workflows but not set from env files:"
    echo "${MISSING}"
  fi
fi

echo
echo "Done for ${REPO}."
