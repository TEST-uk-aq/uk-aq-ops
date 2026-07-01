const HOUR_MS = 60 * 60 * 1000;
const DEEP_HOURLY_UPSERT_MAX_BATCH_SIZE = 50;
const DEEP_ROLLING_HOURLY_UPSERT_MAX_BATCH_SIZE = 100;

export type RefreshWindow = {
  hourEndStartExclusive: Date;
  hourEndEndInclusive: Date;
};

export type RefreshMetrics = {
  source_rows: number;
  rows_upserted: number;
  timeseries_hours_changed: number;
  max_changed_lag_hours: number | null;
};

export class DeepRefreshChunkError extends Error {
  chunkIndex: number;
  chunkCount: number;
  chunkStartUtc: string;
  chunkEndUtc: string;

  constructor(
    fullWindow: RefreshWindow,
    chunk: RefreshWindow,
    chunkIndex: number,
    chunkCount: number,
    rpcError: string,
    runMode = "reconcile_deep",
  ) {
    const fullStart = fullWindow.hourEndStartExclusive.toISOString();
    const fullEnd = fullWindow.hourEndEndInclusive.toISOString();
    const chunkStart = chunk.hourEndStartExclusive.toISOString();
    const chunkEnd = chunk.hourEndEndInclusive.toISOString();
    super(
      `helper upsert RPC failed for ${runMode} chunk ${chunkIndex}/${chunkCount}: ` +
        `full_window=(${fullStart}, ${fullEnd}] failed_chunk=(${chunkStart}, ${chunkEnd}] ` +
        `error=${rpcError}`,
    );
    this.name = "DeepRefreshChunkError";
    this.chunkIndex = chunkIndex;
    this.chunkCount = chunkCount;
    this.chunkStartUtc = chunkStart;
    this.chunkEndUtc = chunkEnd;
  }
}

export class DeepHourlyUpsertChunkError extends Error {
  chunkIndex: number;
  chunkCount: number;
  chunkStartUtc: string;
  chunkEndUtc: string;

  constructor(
    fullWindow: RefreshWindow,
    chunk: RefreshWindow,
    chunkIndex: number,
    chunkCount: number,
    rpcError: string,
    runMode = "reconcile_deep",
  ) {
    const fullStart = fullWindow.hourEndStartExclusive.toISOString();
    const fullEnd = fullWindow.hourEndEndInclusive.toISOString();
    const chunkStart = chunk.hourEndStartExclusive.toISOString();
    const chunkEnd = chunk.hourEndEndInclusive.toISOString();
    super(
      `hourly upsert RPC failed for ${runMode} chunk ${chunkIndex}/${chunkCount}: ` +
        `full_window=(${fullStart}, ${fullEnd}] failed_chunk=(${chunkStart}, ${chunkEnd}] ` +
        `error=${rpcError}`,
    );
    this.name = "DeepHourlyUpsertChunkError";
    this.chunkIndex = chunkIndex;
    this.chunkCount = chunkCount;
    this.chunkStartUtc = chunkStart;
    this.chunkEndUtc = chunkEnd;
  }
}

export function buildDeepRefreshChunks(
  window: RefreshWindow,
  chunkHours: number,
): RefreshWindow[] {
  if (!Number.isInteger(chunkHours) || chunkHours <= 0) {
    throw new Error("chunkHours must be a positive integer");
  }
  const startMs = window.hourEndStartExclusive.getTime();
  const endMs = window.hourEndEndInclusive.getTime();
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) || endMs <= startMs
  ) {
    throw new Error("deep refresh window must have end after start");
  }

  const chunks: RefreshWindow[] = [];
  let chunkStartMs = startMs;
  while (chunkStartMs < endMs) {
    const chunkEndMs = Math.min(endMs, chunkStartMs + chunkHours * HOUR_MS);
    chunks.push({
      hourEndStartExclusive: new Date(chunkStartMs),
      hourEndEndInclusive: new Date(chunkEndMs),
    });
    chunkStartMs = chunkEndMs;
  }
  return chunks;
}

export function aggregateRefreshMetrics(
  metrics: RefreshMetrics[],
): RefreshMetrics {
  return metrics.reduce<RefreshMetrics>(
    (total, item) => ({
      source_rows: total.source_rows + item.source_rows,
      rows_upserted: total.rows_upserted + item.rows_upserted,
      timeseries_hours_changed: total.timeseries_hours_changed +
        item.timeseries_hours_changed,
      max_changed_lag_hours: item.max_changed_lag_hours === null
        ? total.max_changed_lag_hours
        : total.max_changed_lag_hours === null
        ? item.max_changed_lag_hours
        : Math.max(total.max_changed_lag_hours, item.max_changed_lag_hours),
    }),
    {
      source_rows: 0,
      rows_upserted: 0,
      timeseries_hours_changed: 0,
      max_changed_lag_hours: null,
    },
  );
}

export function deepHourlyUpsertBatchSize(configuredBatchSize: number): number {
  return Math.min(
    Math.max(1, Math.trunc(configuredBatchSize)),
    DEEP_HOURLY_UPSERT_MAX_BATCH_SIZE,
  );
}

export function deepRollingHourlyUpsertBatchSize(
  configuredBatchSize: number,
): number {
  return Math.min(
    Math.max(1, Math.trunc(configuredBatchSize)),
    DEEP_ROLLING_HOURLY_UPSERT_MAX_BATCH_SIZE,
  );
}

export function buildDeepRollingWindow(
  referenceHourEnd: Date,
  lagHours: number,
  windowHours: number,
): RefreshWindow {
  if (!Number.isInteger(lagHours) || lagHours <= 0) {
    throw new Error("lagHours must be a positive integer");
  }
  if (
    !Number.isInteger(windowHours) ||
    windowHours <= 0 ||
    windowHours > lagHours
  ) {
    throw new Error(
      "windowHours must be a positive integer no greater than lagHours",
    );
  }
  const referenceMs = referenceHourEnd.getTime();
  if (!Number.isFinite(referenceMs)) {
    throw new Error("referenceHourEnd must be a valid date");
  }
  const startMs = referenceMs - lagHours * HOUR_MS;
  return {
    hourEndStartExclusive: new Date(startMs),
    hourEndEndInclusive: new Date(startMs + windowHours * HOUR_MS),
  };
}

export function buildRecentWindow(
  referenceHourEnd: Date,
  windowHours: number,
): RefreshWindow {
  if (!Number.isInteger(windowHours) || windowHours <= 0) {
    throw new Error("windowHours must be a positive integer");
  }
  const referenceMs = referenceHourEnd.getTime();
  if (!Number.isFinite(referenceMs)) {
    throw new Error("referenceHourEnd must be a valid date");
  }
  return {
    hourEndStartExclusive: new Date(referenceMs - windowHours * HOUR_MS),
    hourEndEndInclusive: new Date(referenceMs),
  };
}
