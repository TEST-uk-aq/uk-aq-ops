// Local planning adapter. No repair, source acquisition or remote I/O.
// The existing hash CLI deliberately omits rows; this adapter retains the
// existing canonical normalization result for per-physical comparisons.
import fs from "node:fs";
import {
  resolveLegacyVerificationStatus,
  normalizeCanonicalObservationRow,
  computeObservationContentHash,
  computeEmptyObservationContentHash,
  computeObservationMeasurementContentHash,
  computeEmptyObservationMeasurementContentHash,
} from "../../../../workers/shared/uk_aq_observation_content_hash.mjs";

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!Array.isArray(input.rows) || input.rows.length > 500000) throw new Error("Invalid local partition bound");
  const rows = input.rows.map((source) => {
    const { status: _legacyStatus, ...row } = source;
    return normalizeCanonicalObservationRow({
      ...row,
      verification_status: resolveLegacyVerificationStatus(source, { isSos: input.is_sos === true }),
    });
  });
  if (![1, 2].includes(input.hash_contract_version)) throw new Error("Unsupported canonical content hash contract");
  const result = input.hash_contract_version === 2
    ? rows.length ? computeObservationMeasurementContentHash(rows) : computeEmptyObservationMeasurementContentHash()
    : rows.length ? computeObservationContentHash(rows) : computeEmptyObservationContentHash();
  process.stdout.write(JSON.stringify({ ...result, canonical_rows: rows }));
} catch (error) {
  process.stderr.write((error?.name || "Error") + ":canonical_partition_unavailable\n");
  process.exitCode = 1;
}
