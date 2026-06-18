const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const TIMESERIES_V2_WINDOW_HOURS = Object.freeze({
  "12h": 12,
  "24h": 24,
  "7d": 24 * 7,
  "31d": 24 * 31,
  "90d": 24 * 90,
});

export function parseIsoMsOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveTimeseriesWindowBounds({
  nowMs,
  windowLabel,
  startUtc,
  endUtc,
  maxWindowDays,
}) {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const safeMaxWindowDays = Number.isFinite(maxWindowDays)
    ? Math.max(1, Math.floor(maxWindowDays))
    : 90;

  const explicitStartMs = parseIsoMsOrNull(startUtc);
  const explicitEndMs = parseIsoMsOrNull(endUtc);
  if (
    Number.isFinite(explicitStartMs) &&
    Number.isFinite(explicitEndMs) &&
    explicitEndMs > explicitStartMs
  ) {
    const maxSpanMs = safeMaxWindowDays * DAY_MS;
    const effectiveEndMs = Math.min(explicitEndMs, safeNowMs);
    const effectiveStartMs = Math.max(explicitStartMs, effectiveEndMs - maxSpanMs);
    return {
      startMs: effectiveStartMs,
      endMs: effectiveEndMs,
      mode: "explicit",
      normalizedWindowLabel: null,
    };
  }

  const normalizedWindow = TIMESERIES_V2_WINDOW_HOURS[windowLabel] ? windowLabel : "24h";
  const spanMs = Math.min(
    TIMESERIES_V2_WINDOW_HOURS[normalizedWindow] * HOUR_MS,
    safeMaxWindowDays * DAY_MS,
  );
  return {
    startMs: safeNowMs - spanMs,
    endMs: safeNowMs,
    mode: "window",
    normalizedWindowLabel: normalizedWindow,
  };
}

export function normalizeObservedRow(input, sourceLabel) {
  if (!input || typeof input !== "object") return null;
  const observedAt = String(input.observed_at ?? "").trim();
  const observedMs = parseIsoMsOrNull(observedAt);
  if (!Number.isFinite(observedMs)) return null;

  const valueNumber = Number(input.value);
  const value = Number.isFinite(valueNumber) ? valueNumber : null;
  const output = {
    observed_at: new Date(observedMs).toISOString(),
    value,
    source: sourceLabel,
  };
  if (input.unit !== undefined && input.unit !== null) {
    output.unit = input.unit;
  }
  return output;
}

export function mergeAndDedupeRows(r2Rows, ingestRows, allowIngestOverwrite) {
  const byObservedAt = new Map();
  let deduped = 0;

  for (const row of r2Rows) {
    if (!row?.observed_at) continue;
    byObservedAt.set(row.observed_at, row);
  }

  for (const row of ingestRows) {
    if (!row?.observed_at) continue;
    if (byObservedAt.has(row.observed_at)) {
      deduped += 1;
      if (allowIngestOverwrite) {
        byObservedAt.set(row.observed_at, row);
      }
      continue;
    }
    byObservedAt.set(row.observed_at, row);
  }

  const merged = Array.from(byObservedAt.values()).sort((left, right) => {
    const leftMs = Date.parse(left.observed_at) || 0;
    const rightMs = Date.parse(right.observed_at) || 0;
    return leftMs - rightMs;
  });

  return { merged, deduped };
}

export function parseDayUtcFromManifestKey(key) {
  const match = String(key ?? "").match(/day_utc=(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

export function buildMissingDaySlices(keys, requestStartMs, requestEndMs) {
  const byDay = new Set();
  for (const key of keys) {
    const day = parseDayUtcFromManifestKey(key);
    if (day) byDay.add(day);
  }

  const slices = [];
  for (const day of byDay) {
    const dayStartMs = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(dayStartMs)) continue;
    const dayEndMs = dayStartMs + DAY_MS;
    const startMs = Math.max(requestStartMs, dayStartMs);
    const endMs = Math.min(requestEndMs, dayEndMs);
    if (endMs > startMs) {
      slices.push({ startMs, endMs, reason: "missing_day_manifest" });
    }
  }

  slices.sort((a, b) => a.startMs - b.startMs);
  return slices;
}

export function mergeSlices(slices) {
  if (!Array.isArray(slices) || slices.length === 0) return [];
  const sorted = slices
    .filter((slice) => Number.isFinite(slice?.startMs) && Number.isFinite(slice?.endMs) && slice.endMs > slice.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (!sorted.length) return [];

  const merged = [sorted[0]];
  for (let idx = 1; idx < sorted.length; idx += 1) {
    const next = sorted[idx];
    const last = merged[merged.length - 1];
    if (next.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, next.endMs);
      last.reason = last.reason || next.reason;
      continue;
    }
    merged.push({ ...next });
  }
  return merged;
}

export function computeCoverageFromRows(rows) {
  if (!rows.length) {
    return { coverageStart: null, coverageEnd: null };
  }
  return {
    coverageStart: rows[0].observed_at,
    coverageEnd: rows[rows.length - 1].observed_at,
  };
}

export function detectGapRanges(rows, requestStartMs, requestEndMs, windowLabel) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return { hasGap: false, gapRanges: [] };
  }

  const diffs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prevMs = Date.parse(rows[i - 1].observed_at);
    const nextMs = Date.parse(rows[i].observed_at);
    if (Number.isFinite(prevMs) && Number.isFinite(nextMs) && nextMs > prevMs) {
      diffs.push(nextMs - prevMs);
    }
  }
  if (!diffs.length) {
    return { hasGap: false, gapRanges: [] };
  }

  const sorted = diffs.slice().sort((a, b) => a - b);
  const medianDiffMs = sorted[Math.floor(sorted.length / 2)] || HOUR_MS;
  const minimumExpectedMs = windowLabel === "12h" || windowLabel === "24h" ? 15 * 60 * 1000 : HOUR_MS;
  const expectedMs = Math.max(minimumExpectedMs, medianDiffMs);
  const gapThresholdMs = Math.max(expectedMs * 1.6, expectedMs + 20 * 60 * 1000);

  const gapRanges = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prevIso = rows[i - 1].observed_at;
    const nextIso = rows[i].observed_at;
    const prevMs = Date.parse(prevIso);
    const nextMs = Date.parse(nextIso);
    if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs) || nextMs <= prevMs) continue;
    if ((nextMs - prevMs) > gapThresholdMs) {
      gapRanges.push({ start_utc: prevIso, end_utc: nextIso });
    }
  }

  if (rows.length > 0) {
    const firstMs = Date.parse(rows[0].observed_at);
    if (Number.isFinite(firstMs) && (firstMs - requestStartMs) > gapThresholdMs) {
      gapRanges.unshift({
        start_utc: new Date(requestStartMs).toISOString(),
        end_utc: rows[0].observed_at,
      });
    }
    const lastMs = Date.parse(rows[rows.length - 1].observed_at);
    if (Number.isFinite(lastMs) && (requestEndMs - lastMs) > gapThresholdMs) {
      gapRanges.push({
        start_utc: rows[rows.length - 1].observed_at,
        end_utc: new Date(requestEndMs).toISOString(),
      });
    }
  }

  return { hasGap: gapRanges.length > 0, gapRanges };
}

export function computeNextSince(rows, requestedSinceIso) {
  const sinceMs = parseIsoMsOrNull(requestedSinceIso);
  let maxObservedMs = Number.isFinite(sinceMs) ? sinceMs : Number.NaN;

  for (const row of rows) {
    const observedMs = parseIsoMsOrNull(row?.observed_at);
    if (!Number.isFinite(observedMs)) continue;
    if (!Number.isFinite(maxObservedMs) || observedMs > maxObservedMs) {
      maxObservedMs = observedMs;
    }
  }

  if (!Number.isFinite(maxObservedMs)) return null;
  return new Date(maxObservedMs).toISOString();
}

export function subtractCoveredTailInterval(requestStartMs, requestEndMs, r2CoverageEndIso) {
  const coverageEndMs = parseIsoMsOrNull(r2CoverageEndIso);
  if (!Number.isFinite(coverageEndMs)) {
    return { tailStartMs: requestStartMs, tailEndMs: requestEndMs };
  }
  const tailStartMs = Math.max(requestStartMs, coverageEndMs + 1);
  return {
    tailStartMs,
    tailEndMs: requestEndMs,
  };
}
