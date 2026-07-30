import fs from "node:fs";

import {
  computeObservationContentHash,
  normalizeCanonicalObservationRow,
  resolveLegacyVerificationStatus,
} from "../../../workers/shared/uk_aq_observation_content_hash.mjs";
import {
  compressors,
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
} from "./uk_aq_parquet_dependencies.mjs";

function parquetIso(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Observation Parquet timestamp is invalid");
  }
  return parsed.toISOString();
}

export async function inspectObservationParquetFile({ filePath, connectorId }) {
  const canonicalRows = [];
  const sosConnectorId = Number.parseInt(
    process.env.UK_AQ_BACKFILL_SOS_CONNECTOR_ID_FALLBACK || "1",
    10,
  );
  const body = fs.readFileSync(filePath);
  const file = new Uint8Array(body).slice().buffer;
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Number(metadata.num_rows || 0);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0) {
    throw new Error(`Observation Parquet must contain rows: ${filePath}`);
  }
  const physicalColumns = parquetSchema(metadata).children.map((column) =>
    String(column.element.name)
  );
  const schemaColumns = new Set(physicalColumns);
  const required = [
    "connector_id",
    "station_id",
    "timeseries_id",
    "pollutant_code",
    "observed_at_utc",
    "value",
  ];
  const missing = required.filter((column) => !schemaColumns.has(column));
  if (missing.length) {
    throw new Error(
      `Observation Parquet is missing canonical columns: ${missing.join(",")}`,
    );
  }
  const statusColumn = schemaColumns.has("verification_status")
    ? "verification_status"
    : schemaColumns.has("status")
    ? "status"
    : null;
  const columns = [...required, ...(statusColumn ? [statusColumn] : [])];
  let rows = [];
  await parquetRead({
    file,
    metadata,
    columns,
    rowStart: 0,
    rowEnd: rowCount,
    compressors,
    onComplete: (value) => {
      rows = Array.isArray(value) ? value : [];
    },
  });
  if (rows.length !== rowCount) {
    throw new Error(`Observation Parquet row count changed while reading: ${filePath}`);
  }
  for (const values of rows) {
    if (!Array.isArray(values)) {
      throw new Error(`Observation Parquet contains an invalid row: ${filePath}`);
    }
    const statusRow = statusColumn
      ? { [statusColumn]: values[required.length] ?? null }
      : {};
    canonicalRows.push(normalizeCanonicalObservationRow({
      connector_id: Number(values[0]),
      station_id: values[1] === null || values[1] === undefined
        ? null
        : Number(values[1]),
      timeseries_id: Number(values[2]),
      pollutant_code: values[3],
      observed_at_utc: parquetIso(values[4]),
      value: Number(values[5]),
      verification_status: resolveLegacyVerificationStatus(statusRow, {
        isSos: Number(connectorId) === sosConnectorId,
      }),
    }));
  }
  return { body, canonicalRows, physicalColumns, rowCount };
}

export async function observationContentHashFromLocalParquet({
  filePaths,
  connectorId,
}) {
  const canonicalRows = [];
  const paths = [...new Set(
    (filePaths || []).map((value) => String(value || "")).filter(Boolean),
  )].sort();
  if (!paths.length) {
    throw new Error("Observation content hash requires local Parquet files");
  }
  for (const filePath of paths) {
    const inspected = await inspectObservationParquetFile({ filePath, connectorId });
    canonicalRows.push(...inspected.canonicalRows);
  }
  const { canonical_rows: _canonicalRows, ...metadata } =
    computeObservationContentHash(canonicalRows);
  return metadata;
}
