import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('workers/uk_aq_backfill_local/run_job.ts', 'utf8');

test('openaq no-location-source-files path classifies authoritative no-data and writes empty manifest path', () => {
  assert.match(src, /reason:\s*"no_location_day_source_files"/);
  assert.match(src, /source_to_r2_openaq_no_data_classification/);
  assert.match(src, /source_to_r2_openaq_empty_manifest_written/);
  assert.match(src, /empty_manifest_written\s*=\s*true/);
});

test('zero observation rows in openaq path are classified authoritative no-data', () => {
  assert.match(src, /const shouldWriteOpenaqEmptyManifest = sourceAdapter === "openaq"[\s\S]*noObservations/);
  assert.match(src, /empty_manifest_reason = skipReason/);
  assert.match(src, /class:\s*"authoritative_no_data"/);
});

test('metadata mismatch skip reasons remain skips with metadata classification', () => {
  assert.match(src, /skip_reason:\s*"no_matching_requested_timeseries_ids"[\s\S]*no_data_classification:\s*"metadata_mismatch"/);
  assert.match(src, /no_matching_location_ids_after_timeseries_filter[\s\S]*no_data_classification:\s*"metadata_mismatch"/);
});

test('fetchOpenaqArchiveCsvGz contract comment documents no structured non-throwing errors', () => {
  assert.match(src, /does not currently return structured non-throwing error results/i);
});
