#!/usr/bin/env python3
from pathlib import Path
import re


def replace_between(text: str, start_pattern: str, end_pattern: str, replacement: str, label: str) -> str:
    pattern = re.compile(start_pattern + r".*?(?=" + end_pattern + r")", re.MULTILINE | re.DOTALL)
    updated, count = pattern.subn(replacement.rstrip() + "\n\n", text, count=1)
    if count != 1:
        raise SystemExit(f"Expected exactly one replacement for {label}, got {count}")
    return updated


py_path = Path("local/dashboard/server/uk_aq_dashboard_api.py")
py = py_path.read_text(encoding="utf-8")

py_resolver = r'''def _resolve_dropbox_state_path_info() -> Dict[str, Any]:
    read_version_info = _resolve_r2_history_read_version()
    if not read_version_info.get("valid"):
        warning = str(
            read_version_info.get("warning")
            or "Invalid R2 history read version; hierarchical Dropbox state disabled."
        )
        return {
            "path": None,
            "source": "disabled_invalid_read_version",
            "cache_key": f"invalid:{read_version_info.get('raw') or ''}:dropbox_hierarchical_disabled",
            "warning": warning,
            "error": warning,
            "fallback_attempted": False,
            "read_version": read_version_info,
            "attempted_paths": [],
            "state_file_override": None,
            "ignored_state_file_override": None,
        }

    version = str(read_version_info.get("version") or "")
    if version != "v2":
        warning = (
            "Dropbox storage coverage is sourced only from the hierarchical v2 backup state; "
            f"active R2 history version is {version or 'unknown'}."
        )
        return {
            "path": None,
            "source": "disabled_non_v2",
            "cache_key": f"{version or 'unknown'}:dropbox_hierarchical_disabled",
            "warning": warning,
            "error": warning,
            "fallback_attempted": False,
            "read_version": read_version_info,
            "attempted_paths": [],
            "state_file_override": None,
            "ignored_state_file_override": None,
        }

    state_prefix = str(
        os.getenv("UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX")
        or "_ops/checkpoints/r2_history_backup_state_v2"
    ).strip().strip("/")
    if not state_prefix:
        warning = "UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX resolved to an empty path."
        return {
            "path": None,
            "source": "hierarchical_v2",
            "cache_key": "v2:dropbox_hierarchical_empty_path",
            "warning": warning,
            "error": warning,
            "fallback_attempted": False,
            "read_version": read_version_info,
            "attempted_paths": [],
            "state_file_override": None,
            "ignored_state_file_override": None,
        }

    root_path = f"{state_prefix}/root.json"
    return {
        "path": root_path,
        "source": "hierarchical_v2",
        "cache_key": f"v2:hierarchical:{root_path}",
        "warning": None,
        "error": None,
        "fallback_attempted": False,
        "read_version": read_version_info,
        "attempted_paths": [root_path],
        "state_file_override": None,
        "ignored_state_file_override": None,
    }'''

py = replace_between(
    py,
    r"^def _resolve_dropbox_state_path_info\(\) -> Dict\[str, Any\]:\n",
    r"^def _append_r2_history_read_version\(",
    py_resolver,
    "Python Dropbox state resolver",
)

py_loader = r'''def _hierarchical_dropbox_state_month_refs(
    raw_root: Any,
) -> Tuple[List[Tuple[str, str, str]], Optional[str]]:
    if not isinstance(raw_root, dict):
        return [], "Hierarchical Dropbox state root is not a JSON object"
    if (
        raw_root.get("kind") != "uk_aq_r2_history_backup_state_v2_root"
        or raw_root.get("backup_version") != "v2"
    ):
        return [], "Hierarchical Dropbox state root identity mismatch"

    observations = raw_root.get("observations")
    if not isinstance(observations, dict):
        return [], "Hierarchical Dropbox state root has no observations object"
    years = observations.get("years")
    if not isinstance(years, list):
        return [], "Hierarchical Dropbox state root observations.years is not an array"

    refs: List[Tuple[str, str, str]] = []
    for year_entry in years:
        if not isinstance(year_entry, dict):
            continue
        year = str(year_entry.get("year") or "").strip()
        if not re.fullmatch(r"\d{4}", year):
            return [], f"Invalid hierarchical Dropbox state year: {year!r}"
        months = year_entry.get("months")
        if not isinstance(months, list):
            continue
        for month_entry in months:
            if not isinstance(month_entry, dict):
                continue
            month = str(month_entry.get("month") or "").strip().zfill(2)
            if not re.fullmatch(r"0[1-9]|1[0-2]", month):
                return [], f"Invalid hierarchical Dropbox state month: {month!r}"
            state_key = str(month_entry.get("state_shard_key") or "").strip().strip("/")
            if (
                not state_key
                or state_key in {".", ".."}
                or state_key.startswith("../")
                or "/../" in state_key
                or "\\" in state_key
            ):
                return [], f"Invalid hierarchical Dropbox state shard key: {state_key!r}"
            refs.append((year, month, state_key))

    refs.sort(key=lambda item: (item[0], item[1], item[2]))
    return refs, None


def _hierarchical_dropbox_month_days(
    raw_month: Any,
    expected_year: str,
    expected_month: str,
) -> Tuple[Set[date], Optional[str]]:
    if not isinstance(raw_month, dict):
        return set(), "Hierarchical Dropbox month state is not a JSON object"
    if (
        raw_month.get("kind") != "uk_aq_r2_history_backup_state_observations_month"
        or raw_month.get("backup_version") != "v2"
        or raw_month.get("domain") != "observations"
    ):
        return set(), "Hierarchical Dropbox month state identity mismatch"
    if str(raw_month.get("year") or "").strip() != expected_year:
        return set(), "Hierarchical Dropbox month state year mismatch"
    if str(raw_month.get("month") or "").strip().zfill(2) != expected_month:
        return set(), "Hierarchical Dropbox month state month mismatch"

    raw_days = raw_month.get("days")
    if not isinstance(raw_days, list):
        return set(), "Hierarchical Dropbox month state days is not an array"

    days: Set[date] = set()
    for entry in raw_days:
        if not isinstance(entry, dict):
            return set(), "Hierarchical Dropbox month state contains an invalid day entry"
        parsed_day = _parse_iso_day(entry.get("day_utc"))
        if parsed_day is None:
            return set(), "Hierarchical Dropbox month state contains an invalid day_utc"
        if not parsed_day.isoformat().startswith(f"{expected_year}-{expected_month}-"):
            return set(), "Hierarchical Dropbox month state contains a day outside its month"
        days.add(parsed_day)
    return days, None


def _hierarchical_dropbox_history_root_from_state_path(
    state_path: Path,
    state_rel_path: str,
) -> Path:
    history_root = state_path
    rel_parts = [
        part
        for part in str(state_rel_path or "").strip().strip("/").split("/")
        if part
    ]
    for _ in rel_parts:
        history_root = history_root.parent
    return history_root


def _load_hierarchical_dropbox_days_from_local(
    state_path: Path,
    state_rel_path: str,
) -> Tuple[Dict[str, Set[date]], Optional[str]]:
    domain_days = _empty_dropbox_backup_days()
    try:
        raw_root = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return domain_days, f"Hierarchical Dropbox state root parse failed ({exc.__class__.__name__})"

    refs, root_error = _hierarchical_dropbox_state_month_refs(raw_root)
    if root_error:
        return domain_days, root_error

    history_root = _hierarchical_dropbox_history_root_from_state_path(
        state_path,
        state_rel_path,
    )
    errors: List[str] = []
    for year, month, state_key in refs:
        shard_path = history_root.joinpath(*state_key.split("/"))
        if not shard_path.is_file():
            errors.append(f"Missing hierarchical Dropbox month state {state_key}")
            continue
        try:
            raw_month = json.loads(shard_path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            errors.append(
                f"Hierarchical Dropbox month state parse failed for {state_key} "
                f"({exc.__class__.__name__})"
            )
            continue
        month_days, month_error = _hierarchical_dropbox_month_days(
            raw_month,
            year,
            month,
        )
        if month_error:
            errors.append(f"{state_key}: {month_error}")
            continue
        domain_days["observations"].update(month_days)

    return domain_days, "; ".join(errors) if errors else None


def _download_hierarchical_dropbox_json(
    access_token: str,
    state_rel_path: str,
) -> Dict[str, Any]:
    remote_path = _resolve_dropbox_state_remote_path(state_rel_path)
    if not remote_path:
        raise RuntimeError("Unable to resolve hierarchical Dropbox state path")
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Dropbox-API-Arg": json.dumps({"path": remote_path}),
    }
    resp = requests.post(
        DROPBOX_CONTENT_API_DOWNLOAD_URL,
        headers=headers,
        timeout=DROPBOX_API_TIMEOUT_SECONDS,
    )
    if not resp.ok:
        detail = _safe_response_text(resp)
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(
            f"Hierarchical Dropbox state download failed ({resp.status_code}){suffix}"
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise RuntimeError("Hierarchical Dropbox state returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Hierarchical Dropbox state payload is not a JSON object")
    return payload


def _load_dropbox_backup_days() -> Tuple[Dict[str, Set[date]], Optional[str], Optional[str], Dict[str, Any]]:
    state_info = _resolve_dropbox_state_path_info()
    resolved_path = state_info.get("path")
    domain_days = _empty_dropbox_backup_days()
    if not resolved_path:
        return domain_days, None, state_info.get("error"), state_info

    for candidate in _candidate_dropbox_state_paths(resolved_path, state_info=state_info):
        if not candidate.is_file():
            continue
        parsed_days, parse_error = _load_hierarchical_dropbox_days_from_local(
            candidate,
            resolved_path,
        )
        return parsed_days, str(candidate), parse_error, state_info

    access_token, token_error = _fetch_dropbox_access_token()
    remote_root = _resolve_dropbox_state_remote_path(resolved_path)
    path_ref = f"dropbox:{remote_root}" if remote_root else None
    if token_error:
        return domain_days, path_ref, token_error, state_info
    if not access_token:
        return (
            domain_days,
            path_ref,
            "Hierarchical Dropbox state root not found locally and Dropbox credentials are unavailable",
            state_info,
        )

    try:
        raw_root = _download_hierarchical_dropbox_json(access_token, resolved_path)
    except Exception as exc:  # noqa: BLE001
        return domain_days, path_ref, str(exc), state_info

    refs, root_error = _hierarchical_dropbox_state_month_refs(raw_root)
    if root_error:
        return domain_days, path_ref, root_error, state_info

    errors: List[str] = []
    for year, month, state_key in refs:
        try:
            raw_month = _download_hierarchical_dropbox_json(
                access_token,
                state_key,
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{state_key}: {exc}")
            continue
        month_days, month_error = _hierarchical_dropbox_month_days(
            raw_month,
            year,
            month,
        )
        if month_error:
            errors.append(f"{state_key}: {month_error}")
            continue
        domain_days["observations"].update(month_days)

    return domain_days, path_ref, "; ".join(errors) if errors else None, state_info'''

py = replace_between(
    py,
    r"^def _load_dropbox_backup_days\(\) -> Tuple\[Dict\[str, Set\[date\]\], Optional\[str\], Optional\[str\], Dict\[str, Any\]\]:\n",
    r"^def _latest_oldest_day_by_label\(",
    py_loader,
    "Python hierarchical Dropbox loader",
)
py_path.write_text(py, encoding="utf-8")


ts_path = Path("workers/uk_aq_dashboard_online_api_worker/src/lib/storage_coverage_http_enrichment.ts")
ts = ts_path.read_text(encoding="utf-8")

constants_marker = 'const DAY_RE = /^\\d{4}-\\d{2}-\\d{2}$/;\n'
constants_insert = '''const DAY_RE = /^\\d{4}-\\d{2}-\\d{2}$/;\nconst DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";\nconst DROPBOX_DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";\nconst DEFAULT_HIERARCHICAL_STATE_PREFIX = "_ops/checkpoints/r2_history_backup_state_v2";\n'''
if constants_marker not in ts:
    raise SystemExit("TS DAY_RE marker not found")
ts = ts.replace(constants_marker, constants_insert, 1)

ts_loader = r'''type BackupMonthRef = {
  year: string;
  month: string;
  stateKey: string;
};

function normaliseRelativeKey(value: unknown): string {
  const key = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!key || key === "." || key === ".." || key.startsWith("../") || key.includes("/../")) {
    throw new Error(`Invalid hierarchical Dropbox state key: ${String(value || "")}`);
  }
  return key;
}

function hierarchicalStateRootRelativePath(env: WorkerEnv): string {
  const extendedEnv = env as WorkerEnv & { UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX?: string };
  const prefix = String(
    extendedEnv.UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX
      || DEFAULT_HIERARCHICAL_STATE_PREFIX,
  ).trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("Hierarchical Dropbox state prefix is empty");
  return `${prefix}/root.json`;
}

function joinDropboxPath(env: WorkerEnv, relativePath: string): string {
  const root = String(env.UK_AQ_DROPBOX_ROOT || "CIC-Test").trim().replace(/^\/+|\/+$/g, "");
  const historyDir = String(env.UK_AQ_R2_HISTORY_DROPBOX_DIR || "R2_history_backup").trim().replace(/^\/+|\/+$/g, "");
  const relative = normaliseRelativeKey(relativePath);
  const parts = [root, historyDir, relative].filter(Boolean);
  return `/${parts.join("/")}`;
}

async function fetchDropboxAccessToken(env: WorkerEnv): Promise<string> {
  const appKey = String(env.DROPBOX_APP_KEY || "").trim();
  const appSecret = String(env.DROPBOX_APP_SECRET || "").trim();
  const refreshToken = String(env.DROPBOX_REFRESH_TOKEN || "").trim();
  if (!appKey || !appSecret || !refreshToken) {
    throw new Error("Dropbox credentials are incomplete for hierarchical backup coverage");
  }
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set("client_id", appKey);
  form.set("client_secret", appSecret);
  const payload = await fetchJsonObject(
    DROPBOX_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    "Dropbox token request",
  );
  const token = String(payload.access_token || "").trim();
  if (!token) throw new Error("Dropbox token response missing access_token");
  return token;
}

async function fetchDropboxJson(token: string, remotePath: string): Promise<JsonObject> {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Dropbox-API-Arg", JSON.stringify({ path: remotePath }));
  const response = await fetch(DROPBOX_DOWNLOAD_URL, { method: "POST", headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Dropbox state download failed (${response.status}): ${text.slice(0, 500)}`);
  }
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Dropbox state response is not a JSON object");
  }
  return payload as JsonObject;
}

function parseHierarchicalStateRoot(payload: JsonObject): BackupMonthRef[] {
  if (
    payload.kind !== "uk_aq_r2_history_backup_state_v2_root"
    || payload.backup_version !== "v2"
  ) {
    throw new Error("Hierarchical Dropbox state root identity mismatch");
  }
  const observations = payload.observations;
  if (!observations || typeof observations !== "object" || Array.isArray(observations)) {
    throw new Error("Hierarchical Dropbox state root has no observations object");
  }
  const years = (observations as JsonObject).years;
  if (!Array.isArray(years)) {
    throw new Error("Hierarchical Dropbox state root observations.years is not an array");
  }

  const refs: BackupMonthRef[] = [];
  for (const rawYear of years) {
    if (!rawYear || typeof rawYear !== "object" || Array.isArray(rawYear)) continue;
    const year = String((rawYear as JsonObject).year || "").trim();
    if (!/^\d{4}$/.test(year)) throw new Error(`Invalid hierarchical Dropbox state year: ${year}`);
    const months = (rawYear as JsonObject).months;
    if (!Array.isArray(months)) continue;
    for (const rawMonth of months) {
      if (!rawMonth || typeof rawMonth !== "object" || Array.isArray(rawMonth)) continue;
      const month = String((rawMonth as JsonObject).month || "").trim().padStart(2, "0");
      if (!/^(0[1-9]|1[0-2])$/.test(month)) {
        throw new Error(`Invalid hierarchical Dropbox state month: ${month}`);
      }
      refs.push({
        year,
        month,
        stateKey: normaliseRelativeKey((rawMonth as JsonObject).state_shard_key),
      });
    }
  }
  refs.sort((a, b) => `${a.year}-${a.month}-${a.stateKey}`.localeCompare(`${b.year}-${b.month}-${b.stateKey}`));
  return refs;
}

function parseHierarchicalMonthDays(
  payload: JsonObject,
  expectedYear: string,
  expectedMonth: string,
): Set<string> {
  if (
    payload.kind !== "uk_aq_r2_history_backup_state_observations_month"
    || payload.backup_version !== "v2"
    || payload.domain !== "observations"
  ) {
    throw new Error("Hierarchical Dropbox month state identity mismatch");
  }
  if (String(payload.year || "").trim() !== expectedYear) {
    throw new Error("Hierarchical Dropbox month state year mismatch");
  }
  if (String(payload.month || "").trim().padStart(2, "0") !== expectedMonth) {
    throw new Error("Hierarchical Dropbox month state month mismatch");
  }
  if (!Array.isArray(payload.days)) {
    throw new Error("Hierarchical Dropbox month state days is not an array");
  }
  const days = new Set<string>();
  for (const rawDay of payload.days) {
    if (!rawDay || typeof rawDay !== "object" || Array.isArray(rawDay)) {
      throw new Error("Hierarchical Dropbox month state contains an invalid day entry");
    }
    const day = normaliseDay((rawDay as JsonObject).day_utc);
    if (!day || !day.startsWith(`${expectedYear}-${expectedMonth}-`)) {
      throw new Error("Hierarchical Dropbox month state contains an invalid day_utc");
    }
    days.add(day);
  }
  return days;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadHierarchicalBackupDays(env: WorkerEnv): Promise<{
  days: DaySets | null;
  key: string | null;
  error: string | null;
}> {
  const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  const rootRelativePath = hierarchicalStateRootRelativePath(env);
  const rootRemotePath = joinDropboxPath(env, rootRelativePath);
  if (version !== "v2") {
    return {
      days: null,
      key: rootRemotePath,
      error: `Hierarchical Dropbox backup coverage requires UK_AQ_R2_HISTORY_VERSION=v2; got ${version || "missing"}`,
    };
  }

  try {
    const token = await fetchDropboxAccessToken(env);
    const rootPayload = await fetchDropboxJson(token, rootRemotePath);
    const refs = parseHierarchicalStateRoot(rootPayload);
    const observations = new Set<string>();
    const errors: string[] = [];
    await mapWithConcurrency(refs, 6, async (ref) => {
      try {
        const monthPayload = await fetchDropboxJson(token, joinDropboxPath(env, ref.stateKey));
        const monthDays = parseHierarchicalMonthDays(monthPayload, ref.year, ref.month);
        for (const day of monthDays) observations.add(day);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${ref.stateKey}: ${message}`);
      }
      return null;
    });
    return {
      days: { observations, aqilevels: new Set<string>() },
      key: rootRemotePath,
      error: errors.length ? errors.join("; ") : null,
    };
  } catch (error) {
    return {
      days: null,
      key: rootRemotePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadSources(request: Request, env: WorkerEnv): Promise<SourceSnapshot> {
  const historyUrl = resolveHistoryDaysUrl(env);
  const dbSizeUrl = String(env.UK_AQ_DB_SIZE_API_URL || "").trim();
  const version = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  const rootPath = (() => {
    try { return joinDropboxPath(env, hierarchicalStateRootRelativePath(env)); } catch (_error) { return ""; }
  })();
  const cacheKey = `${historyUrl}|${dbSizeUrl}|${version}|${rootPath}`;
  const forceRefresh = shouldForceRefresh(request);

  if (!forceRefresh && sourceCache && sourceCache.key === cacheKey && Date.now() < sourceCache.expiresAt) {
    return sourceCache.value;
  }

  const generatedAt = new Date().toISOString();
  let r2Days: DaySets | null = null;
  let r2Bucket: string | null = null;
  let r2Error: string | null = null;
  let backupDays: DaySets | null = null;
  let backupKey: string | null = rootPath || null;
  let backupError: string | null = null;
  let ingestOldestDay: string | null = null;
  let ingestError: string | null = null;

  const historyPromise = (async () => {
    if (!historyUrl) throw new Error("R2 history-days API is not configured");
    if (version !== "v1" && version !== "v2") {
      throw new Error("UK_AQ_R2_HISTORY_VERSION must be v1 or v2");
    }
    const url = new URL(historyUrl);
    url.searchParams.set("read_version", version);
    url.searchParams.set("max_days", "3660");
    return fetchJsonObject(url.toString(), resolveHistoryToken(env));
  })();

  const dbPromise = (async () => {
    if (!dbSizeUrl) throw new Error("UK_AQ_DB_SIZE_API_URL is not configured");
    const url = new URL(dbSizeUrl);
    const lookback = Math.max(1, Math.trunc(Number(env.UK_AQ_DB_SIZE_LOOKBACK_DAYS || 28) || 28));
    url.searchParams.set("lookback_days", String(lookback));
    return fetchJsonObject(url.toString(), String(env.UK_AQ_DB_SIZE_API_TOKEN || "").trim());
  })();

  const [historyResult, dbResult, backupResult] = await Promise.allSettled([
    historyPromise,
    dbPromise,
    loadHierarchicalBackupDays(env),
  ]);

  if (historyResult.status === "fulfilled") {
    const payload = historyResult.value;
    r2Bucket = String(payload.bucket || "").trim() || null;
    r2Days = parseDomainDays(payload.domains);
  } else {
    r2Error = historyResult.reason instanceof Error
      ? historyResult.reason.message
      : String(historyResult.reason);
  }

  if (dbResult.status === "fulfilled") {
    const rows = Array.isArray(dbResult.value.db_size_metrics)
      ? dbResult.value.db_size_metrics
      : [];
    ingestOldestDay = latestIngestOldestDay(rows);
    if (!ingestOldestDay) ingestError = "DB size metrics contain no usable IngestDB retention boundary";
  } else {
    ingestError = dbResult.reason instanceof Error
      ? dbResult.reason.message
      : String(dbResult.reason);
  }

  if (backupResult.status === "fulfilled") {
    backupDays = backupResult.value.days;
    backupKey = backupResult.value.key;
    backupError = backupResult.value.error;
  } else {
    backupError = backupResult.reason instanceof Error
      ? backupResult.reason.message
      : String(backupResult.reason);
  }

  const value: SourceSnapshot = {
    generatedAt,
    r2Days,
    r2Bucket,
    r2Error,
    backupDays,
    backupKey,
    backupError,
    ingestOldestDay,
    ingestError,
  };
  sourceCache = {
    key: cacheKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  };
  return value;
}'''

ts = replace_between(
    ts,
    r"^async function loadSources\(request: Request, env: WorkerEnv\): Promise<SourceSnapshot> \{\n",
    r"^function dayBounds\(",
    ts_loader,
    "TS hierarchical Dropbox loader",
)

ts_enrich = r'''function enrichPayload(payload: JsonObject, sources: SourceSnapshot): JsonObject {
  const rawRows = Array.isArray(payload.storage_coverage_days)
    ? payload.storage_coverage_days
    : [];
  const rows = rawRows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const row = { ...(value as JsonObject) };
    const day = normaliseDay(row.date);
    if (!day) return row;

    if (sources.ingestOldestDay) {
      row.ingest = day >= sources.ingestOldestDay;
    }
    if (sources.r2Days) {
      const observationsPresent = sources.r2Days.observations.has(day);
      row.r2_observs = observationsPresent;
      row.r2 = observationsPresent;
      row.r2_aqilevels = sources.r2Days.aqilevels.has(day);
    }

    // Hierarchical v2 observation state is the only Dropbox coverage source.
    // AQI backup state is intentionally not carried forward.
    row.dropbox_observs = Boolean(sources.backupDays?.observations.has(day));
    row.dropbox_aqilevels = false;
    return row;
  });

  const backupObservations = dayBounds(sources.backupDays?.observations || null);

  return {
    ...payload,
    storage_coverage_days: rows,
    storage_coverage_source: `${String(payload.storage_coverage_source || "dashboard")}+independent_http_sources`,
    r2_history_days_bucket: sources.r2Bucket || payload.r2_history_days_bucket || null,
    r2_history_days_error: mergeMessages(payload.r2_history_days_error, sources.r2Error),
    dropbox_backup_state_path: sources.backupKey ? `dropbox:${sources.backupKey}` : null,
    dropbox_backup_state_source: "dropbox-hierarchical-v2",
    dropbox_backup_state_error: sources.backupError,
    dropbox_backup_observations_earliest_day: backupObservations.earliest,
    dropbox_backup_observations_latest_day: backupObservations.latest,
    dropbox_backup_aqilevels_earliest_day: null,
    dropbox_backup_aqilevels_latest_day: null,
    storage_coverage_independent_sources: {
      generated_at: sources.generatedAt,
      r2_bucket: sources.r2Bucket,
      r2_observations_day_count: sources.r2Days?.observations.size ?? null,
      r2_aqilevels_day_count: sources.r2Days?.aqilevels.size ?? null,
      backup_state_root_key: sources.backupKey,
      backup_observations_day_count: sources.backupDays?.observations.size ?? null,
      backup_aqilevels_day_count: 0,
      ingest_oldest_day: sources.ingestOldestDay,
      r2_error: sources.r2Error,
      backup_error: sources.backupError,
      ingest_error: sources.ingestError,
    },
  };
}'''

ts = replace_between(
    ts,
    r"^function enrichPayload\(payload: JsonObject, sources: SourceSnapshot\): JsonObject \{\n",
    r"^export async function enrichStorageCoverageResponse\(",
    ts_enrich,
    "TS storage coverage enrichment",
)
ts_path.write_text(ts, encoding="utf-8")
