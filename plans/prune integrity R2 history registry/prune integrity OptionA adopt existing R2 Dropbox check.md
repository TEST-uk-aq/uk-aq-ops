# prune integrity Option A adopt existing R2 + Dropbox prune check

Status: interim bridge design  
Scope: `CIC-test-uk-aq-ops` / `workers/uk_aq_prune_daily`  
Purpose: prevent committed R2 overwrite now, while creating prune-generated comparison files in Dropbox for manual DuckDB comparison.

---

## 1. Purpose

Option A is a short-term safety and learning phase before the full Option C `r2_history_object_registry` design.

The key idea:

> If committed R2 history already exists for a `(day_utc, connector_id)`, prune Phase B adopts that R2 manifest into history state and never overwrites committed R2. Prune can still generate its own Parquet output, but it uploads that comparison output directly to Dropbox, not R2.

This lets us compare:

- integrity/backfill-created committed R2 history; and
- prune-created Parquet for the same day/connector;

without increasing R2 write churn or risking committed history.

---

## 2. Current overwrite risk

Phase B observations export currently discovers candidates from ingest DB state via `uk_aq_ops.history_candidates`.

If integrity/backfill has already written a valid R2 connector/day, but `history_candidates` does not know about it, prune Phase B can later write to the same committed R2 keys:

```text
history/v1/observations/day_utc=<day>/connector_id=<connector>/part-00000.parquet
history/v1/observations/day_utc=<day>/connector_id=<connector>/manifest.json
```

Option A changes this behaviour for existing R2 manifests.

---

## 3. Option A rules

For each observations candidate `(day_utc, connector_id)`:

1. Build the committed R2 manifest key:

   ```text
   history/v1/observations/day_utc=<day>/connector_id=<connector>/manifest.json
   ```

2. `HEAD` that manifest key in R2.

3. If the R2 manifest exists:
   - treat R2 as source of truth;
   - do not write committed R2 Parquet;
   - do not write committed R2 manifest;
   - adopt the existing R2 manifest into `history_candidates`;
   - optionally create prune-generated comparison Parquet;
   - upload comparison output directly to Dropbox.

4. If the R2 manifest does not exist:
   - run normal Phase B committed R2 export for that connector/day.

5. If adoption succeeds but Dropbox comparison upload fails:
   - still treat R2 as source of truth;
   - keep the adoption;
   - log the Dropbox failure;
   - do not overwrite R2.

---

## 4. Dropbox output

Cloud Run uploads prune-created comparison files directly to Dropbox.

No comparison Parquet is written to R2.

### Dropbox path

The Dropbox root is already environment-specific, so do not include `env=<env>` in the comparison path.

Use:

```text
<UK_AQ_DROPBOX_ROOT>/prune_r2_check/run_id=<run_id>/observations/day_utc=<day>/connector_id=<id>/
```

Example:

```text
<UK_AQ_DROPBOX_ROOT>/prune_r2_check/run_id=abc123/observations/day_utc=2026-05-01/connector_id=4/
```

Recommended files:

```text
part-00000.parquet
part-00001.parquet
prune_manifest.json
adopted_r2_manifest.json
comparison_context.json
```

---

## 5. Dropbox upload behaviour

Recommended env/query controls:

```text
UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_ENABLED=true|false
UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_DIR=prune_r2_check
UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_REQUIRED=false
```

Recommended defaults:

- adoption guard: enabled;
- Dropbox comparison upload: manually enabled;
- Dropbox comparison upload failure: best effort;
- no retention policy;
- no R2 shadow writes.

`UK_AQ_R2_HISTORY_PRUNE_CHECK_DROPBOX_REQUIRED=true` can exist for testing, but should not be the normal setting.

---

## 6. Adoption checks

During this checking phase, validation should be minimal.

Required:

- committed R2 manifest exists for `(day_utc, connector_id)`.

Recommended minimal extra check if easy:

- JSON parse succeeds;
- manifest `day_utc` matches path day;
- manifest `connector_id` matches path connector.

Do not require during Option A:

- HEAD every referenced Parquet part;
- validate manifest hash;
- compare file bytes;
- compare row-level content;
- compare per-timeseries counts.

Rationale: this phase treats R2 as source of truth and exists to collect comparison evidence.

---

## 7. Candidate state after adoption

When existing R2 is adopted, update `history_candidates` as if the connector backup is complete, but point at the existing committed R2 manifest.

Set:

```text
status = 'complete'
manifest_key = <existing committed R2 manifest key>
history_row_count = <manifest.source_row_count if parsed/available>
history_file_count = <manifest.file_count if parsed/available>
history_total_bytes = <manifest.total_bytes if parsed/available>
history_completed_at = now()
last_error = null
resume_last_timeseries_id = null
resume_last_observed_at = null
resume_part_index = 0
resume_exported_row_count = 0
resume_parts_json = []
```

Optional helper columns:

```text
history_source_owner = 'adopted_r2'
history_write_mode = 'adopt_existing_r2_manifest_dropbox_prune_check'
history_manifest_hash = <manifest.manifest_hash if parsed/available>
```

---

## 8. Per-connector behaviour

Option A is per connector.

A day can have mixed connector states:

| Connector state | Behaviour |
|---|---|
| R2 committed manifest exists | Adopt R2 for that connector; optionally upload prune comparison to Dropbox. |
| R2 committed manifest missing | Normal Phase B writes committed R2 for that connector. |
| R2 committed manifest exists but minimal parse/check fails | Do not overwrite R2; mark connector failed/blocked. |

This is useful because some connectors may compare better than others.

---

## 9. Day gate behaviour

`prune_day_gates.history_done=true` can be set only when all expected connectors for the day are complete.

A connector can count as complete if:

- it was newly exported by normal Phase B; or
- it was adopted from existing R2.

If any connector fails adoption or export, the day remains blocked.

---

## 10. Comparison output contents

### `prune_manifest.json`

A manifest for the prune-created Dropbox comparison files.

Add fields making clear it is not canonical:

```json
{
  "comparison_only": true,
  "safe_to_promote": false,
  "source_owner": "phase_b_prune_check",
  "storage_target": "dropbox",
  "canonical_r2_manifest_key": "history/v1/observations/day_utc=YYYY-MM-DD/connector_id=N/manifest.json"
}
```

### `adopted_r2_manifest.json`

A copy of the committed R2 manifest body, saved next to the prune-created Dropbox output.

### `comparison_context.json`

Suggested fields:

```json
{
  "run_id": "...",
  "day_utc": "YYYY-MM-DD",
  "connector_id": 1,
  "adopted_r2_manifest_key": "...",
  "adopted_r2_manifest_hash": "...",
  "prune_manifest_hash": "...",
  "adopted_r2_source_row_count": 123,
  "prune_source_row_count": 123,
  "row_count_delta": 0,
  "adopted_r2_file_count": 1,
  "prune_file_count": 1,
  "adopted_r2_total_bytes": 12345,
  "prune_total_bytes": 12300,
  "comparison_output_root": "...",
  "notes": "comparison only; committed R2 was not overwritten"
}
```

---

## 11. Enablement decision

Recommended behaviour:

- adoption guard: always enabled once deployed;
- Dropbox comparison upload: opt-in with env/query flag.

Reason:

- the adoption guard is the safety fix;
- Dropbox output is diagnostic and may add runtime/Dropbox upload volume.

---

## 12. R2 impact

For adopted connectors:

- R2 `HEAD` manifest: yes.
- R2 `GET` manifest: yes, if copying manifest to Dropbox / reading counts.
- R2 Parquet reads: no.
- R2 writes: no.
- R2 comparison/shadow files: no.

---

## 13. Dropbox/storage impact

- Comparison Parquet is uploaded directly from Cloud Run to Dropbox.
- No retention policy.
- User manually manages `prune_r2_check`.
- Candidate limit can be absent or very high because this phase is manually controlled.

Optional high safety limit:

```text
UK_AQ_R2_HISTORY_PRUNE_CHECK_MAX_CANDIDATES_PER_RUN=100000
```

---

## 14. Logs

Recommended structured events:

```text
phase_b_history_existing_manifest_found
phase_b_history_existing_manifest_adopted
phase_b_history_existing_manifest_adoption_failed
phase_b_history_prune_check_dropbox_export_start
phase_b_history_prune_check_dropbox_export_complete
phase_b_history_prune_check_dropbox_export_failed
phase_b_history_prune_check_summary
```

---

## 15. Acceptance criteria

- Existing committed R2 connector manifest is never overwritten.
- Existing committed R2 connector manifest can be adopted into `history_candidates`.
- Adopted connector can contribute to day gate completion.
- Prune-created comparison Parquet is uploaded only to Dropbox.
- No comparison Parquet is written to R2.
- Dropbox comparison failure is best-effort by default.
- Day gate completes only when all expected connectors are complete/adopted.
- Per-connector mixed states work.
- Logs clearly show adopted, newly written, comparison uploaded, and comparison failed cases.

---

## 16. Test plan

### Unit tests

- Existing manifest detection.
- No committed R2 write when manifest exists.
- Candidate state after adoption.
- Dropbox path generation.
- Dropbox comparison manifest generation.
- Mixed connector states for one day.
- Day gate completion from adopted/new connector mix.
- Dropbox failure best-effort mode.

### Integration tests

Use fake R2 and fake Dropbox upload.

1. Seed committed R2 manifest.
2. Seed pending DB candidate.
3. Run Phase B.
4. Assert:
   - committed manifest not overwritten;
   - committed parts not overwritten;
   - candidate marked complete/adopted;
   - prune comparison Parquet uploaded to fake Dropbox;
   - day gate completes only when all connectors are complete/adopted.

Repeat with:

- committed R2 missing;
- manifest exists but parse fails;
- one connector adopted and one connector newly written;
- Dropbox comparison disabled;
- Dropbox upload failure.

---

## 17. Manual runbook

For a known integrity-loaded day/connector:

1. Record committed R2 manifest ETag/Last-Modified.
2. Run Phase B Option A with Dropbox comparison enabled.
3. Confirm committed R2 ETag/Last-Modified unchanged.
4. Confirm Dropbox contains:

   ```text
   <UK_AQ_DROPBOX_ROOT>/prune_r2_check/run_id=<run_id>/observations/day_utc=<day>/connector_id=<id>/
   ```

5. Confirm `history_candidates.manifest_key` points to committed R2.
6. Confirm day gate state is correct.
7. Compare committed/integrity and prune-created files using DuckDB.
