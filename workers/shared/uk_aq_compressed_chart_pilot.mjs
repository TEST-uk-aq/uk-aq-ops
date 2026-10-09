// Exact TEST pilot authority shared by the offline publisher and private reader.
export const COMPRESSED_CHART_ROOT = "experimental/compressed-chart-history/v1";
export const COMPRESSED_CHART_SELECTOR_KEY = `${COMPRESSED_CHART_ROOT}/latest.json`;
export const COMPRESSED_CHART_SAMPLES = Object.freeze({
  "v3-september-2026": Object.freeze({ generation: "v3", start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" }),
  "v3-2026-09-01": Object.freeze({ generation: "v3", start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" }),
  "v2-2026-09-01": Object.freeze({ generation: "v2", start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" }),
});
export const COMPRESSED_CHART_SHA256 = /^[0-9a-f]{64}$/;

export function validateCompressedChartSelector(selector) {
  if (selector?.schema_version !== 1 || selector?.kind !== "uk_aq_compressed_chart_selector"
    || selector?.publication_state !== "published_complete" || !selector.samples
    || typeof selector.samples !== "object" || Array.isArray(selector.samples)) return false;
  return Object.entries(selector.samples).every(([id, entry]) => {
    const sample = Object.hasOwn(COMPRESSED_CHART_SAMPLES, id) ? COMPRESSED_CHART_SAMPLES[id] : null;
    return sample && COMPRESSED_CHART_SHA256.test(entry?.manifest_sha256 || "")
      && entry?.manifest_key === `${COMPRESSED_CHART_ROOT}/manifests/${entry.manifest_sha256}.json`
      && entry.source_generation === sample.generation
      && entry.start_utc === sample.start && entry.end_exclusive_utc === sample.end
      && entry.connector_id === 1 && entry.timeseries_id === 212
      && entry.station_id === 248 && entry.pollutant_code === "pm25";
  });
}

export function validateCompressedChartPublication(publication, sampleId) {
  const sample = Object.hasOwn(COMPRESSED_CHART_SAMPLES, sampleId) ? COMPRESSED_CHART_SAMPLES[sampleId] : null;
  if (!sample || publication?.schema_version !== 1
    || publication?.kind !== "uk_aq_compressed_chart_publication"
    || publication?.publication_state !== "published_complete"
    || publication?.sample_id !== sampleId
    || publication?.source_generation !== sample.generation
    || publication?.identity?.connector_id !== 1
    || publication?.identity?.timeseries_id !== 212
    || publication?.identity?.station_id !== 248
    || publication?.identity?.pollutant_code !== "pm25"
    || publication?.requested_interval?.start_utc !== sample.start
    || publication?.requested_interval?.end_exclusive_utc !== sample.end
    || !Array.isArray(publication.objects) || publication.objects.length !== 1) return false;
  const object = publication.objects[0];
  return object.key === `${COMPRESSED_CHART_ROOT}/objects/connector_id=1/timeseries_id=212/generation=${sample.generation}/month_utc=2026-09/${object.sha256}.json.gz`
    && COMPRESSED_CHART_SHA256.test(object.sha256 || "")
    && COMPRESSED_CHART_SHA256.test(object.json_sha256 || "")
    && Number.isSafeInteger(object.byte_size) && object.byte_size > 0 && object.byte_size <= 2 * 1024 * 1024
    && Number.isSafeInteger(object.row_count) && object.row_count > 0
    && object.month_utc === "2026-09"
    && object.requested_start_utc === sample.start
    && object.requested_end_exclusive_utc === sample.end
    && Array.isArray(object.coverage_days)
    && object.coverage_days.length === (Date.parse(sample.end) - Date.parse(sample.start)) / 86_400_000
    && object.coverage_days.reduce((sum, day, index) => {
      const expected = new Date(Date.parse(sample.start) + index * 86_400_000).toISOString().slice(0, 10);
      return day?.day_utc === expected && ["exported", "authoritative_absence"].includes(day.state)
        && Number.isSafeInteger(day.row_count) && day.row_count >= 0 ? sum + day.row_count : NaN;
    }, 0) === object.row_count;
}
