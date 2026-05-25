# prune integrity Option C R2 history_object_registry

Status: final design plan  
Scope: `CIC-test-uk-aq-ops` / `CIC-test-uk-aq-schema`  
Primary worker: `workers/uk_aq_prune_daily`  
Design: Option C — DB-backed R2 history object ownership registry

---

## 1. Purpose

Option C is the long-term design for preventing prune Phase B from accidentally overwriting valid R2 history created by integrity/backfill, manual repair, or another trusted path.

Core rule:

> Committed R2 history object ownership must be explicit in DB, and Phase B must check that ownership state before writing to committed R2.

The registry records the current trusted object for each history domain, day, and connector.

---

## 2. Problem

Phase B observations backup currently discovers work from ingest DB state through `uk_aq_ops.history_candidates` (in ingestdb / main UK AQ DB).

That means valid R2 history can already exist for a `(day_utc, connector_id)`, but prune Phase B can later see the same day/connector as pending and write to the same committed R2 keys.

This can overwrite integrity-created history.

Option C fixes this by making R2 object state and ownership durable in DB.

---

## 3. Goals

- Prevent accidental overwrite of valid committed R2 history.
- Keep full backup integrity.
- Prefer deterministic/idempotent behaviour.
- Avoid unnecessary R2 writes.
- Support safe retries and partial resumes.
- Support explicit scoped repair/rebuild flows.
- Keep prune gate behaviour correct.
- Keep `observations` and `aqilevels` coherent where possible.
- Create an audit trail for which process owns each current history object.

---

## 4. Non-goals

- Do not require Parquet body reads during every routine prune run.
- Do not allow broad unscoped force rebuild from the daily scheduler.
- Do not treat `history_candidates.status='complete'` alone as proof of protected R2 ownership.
- Do not make diagnostic comparison output part of current history.

---

## 5. Registry table

### 5.1 Table name

```sql
uk_aq_ops.r2_history_object_registry
```

### 5.2 Proposed schema

```sql
create table if not exists uk_aq_ops.r2_history_object_registry (
  id bigserial primary key,

  domain text not null,
  object_level text not null,
  day_utc date not null,
  connector_id integer,

  manifest_key text not null,
  manifest_hash text,

  source_owner text not null,
  trust_status text not null default 'verified',
  object_status text not null default 'current',

  source_row_count bigint,
  file_count integer,
  total_bytes bigint,

  history_schema_name text,
  history_schema_version integer,
  writer_version text,
  writer_git_sha text,

  source_run_id text,
  protected boolean not null default true,

  first_seen_at timestamptz not null default now(),
  last_verified_at timestamptz,
  superseded_at timestamptz,
  superseded_by_run_id text,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (domain in ('observations', 'aqilevels')),
  check (object_level in ('connector', 'day')),
  check (trust_status in (
    'verified',
    'adopted_unverified',
    'conflict',
    'stale',
    'superseded'
  )),
  check (object_status in (
    'current',
    'superseded',
    'quarantined'
  )),
  check (
    (object_level = 'connector' and connector_id is not null)
    or
    (object_level = 'day' and connector_id is null)
  )
);
```

### 5.3 Indexes

```sql
create unique index if not exists r2_history_registry_current_connector_uq
on uk_aq_ops.r2_history_object_registry(domain, day_utc, connector_id)
where object_level = 'connector'
  and object_status = 'current';

create unique index if not exists r2_history_registry_current_day_uq
on uk_aq_ops.r2_history_object_registry(domain, day_utc)
where object_level = 'day'
  and connector_id is null
  and object_status = 'current';

create index if not exists r2_history_registry_trust_idx
on uk_aq_ops.r2_history_object_registry(domain, trust_status, day_utc);

create index if not exists r2_history_registry_owner_idx
on uk_aq_ops.r2_history_object_registry(source_owner, day_utc);

create index if not exists r2_history_registry_manifest_key_idx
on uk_aq_ops.r2_history_object_registry(manifest_key);
```

---

## 6. Optional helper columns

The registry is the source of truth, but helper columns on existing tables make debugging easier.

```sql
alter table uk_aq_ops.history_candidates
  add column if not exists history_source_owner text,
  add column if not exists history_manifest_hash text,
  add column if not exists history_write_mode text default 'create_if_absent',
  add column if not exists r2_registry_id bigint;

alter table uk_aq_ops.prune_day_gates
  add column if not exists history_source_owner text,
  add column if not exists history_manifest_hash text,
  add column if not exists history_trust_status text default 'verified';
```

---

## 7. Source owners

Recommended `source_owner` values:

| Value | Meaning |
|---|---|
| `phase_b_prune` | Object was created by normal prune Phase B. |
| `integrity_backfill` | Object was created by integrity/backfill. |
| `adopted_r2` | Object existed in R2 and was adopted into DB state. |
| `manual_repair` | Object was created by manual repair/rebuild. |
| `phase_b_prune_check` | Object was created only for diagnostic comparison, not current R2 history. |

---

## 8. Trust statuses

| Value | Meaning |
|---|---|
| `verified` | Manifest parsed, path matched, required fields valid, referenced objects exist. |
| `adopted_unverified` | Manifest exists and is adopted, but verification was partial. |
| `conflict` | Registry, R2, or DB candidate state disagree. Do not prune. |
| `stale` | Object was valid but is no longer believed current after source repair/rebuild. |
| `superseded` | Object was replaced by a newer current object through explicit rebuild. |

---

## 9. Object statuses

| Value | Meaning |
|---|---|
| `current` | This is the current trusted object for the domain/day/connector or day. |
| `superseded` | This was previously current and has been replaced. |
| `quarantined` | This object should not be trusted or used by gates/readers. |

---

## 10. Final write policy

Normal Phase B mode should be:

```text
create_if_absent
```

For observations `(day_utc, connector_id)`:

1. Check registry for current trusted connector row.
2. If current trusted registry row exists:
   - do not write committed R2;
   - use registry metadata;
   - mark candidate adopted/complete if needed.
3. If registry row is missing:
   - check committed R2 connector manifest.
4. If committed R2 manifest exists:
   - do not overwrite;
   - validate/adopt into registry;
   - complete candidate only if trust policy passes.
5. If committed R2 manifest is missing:
   - write new committed R2 history.
6. If registry and R2 disagree:
   - mark conflict;
   - keep prune gate blocked.

---

## 11. Day manifest policy

For a day-level observations manifest:

1. If current trusted day registry row exists:
   - do not overwrite day manifest.
2. If day manifest exists but registry is missing:
   - validate/adopt day manifest.
3. If day manifest is missing but all connector manifests are trusted:
   - create day manifest from trusted connector manifests.
4. If any connector is pending, failed, untrusted, missing, or conflict:
   - keep `prune_day_gates.history_done=false`.

---

## 12. Prune gate rule

`prune_day_gates.history_done=true` should mean:

> There is trusted current observations R2 history for the whole UTC day.

It should not mean merely:

> The current Phase B run wrote something.

A day can open the gate only when all expected connectors are trusted/current, whether those connector objects were:

- created by normal prune Phase B;
- created by integrity/backfill and adopted;
- created by manual repair and registered.

---

## 13. AQI levels policy

AQI should be brought under the same registry model.

Rules:

- existing AQI day manifest should be adopted/skipped, not overwritten;
- AQI day should be marked stale if source observations day is force-rebuilt;
- AQI force-rebuild should be explicit and scoped;
- AQI registry rows should use `domain='aqilevels'`.

---

## 14. Conflict handling

Examples of conflict:

- registry says current object exists, but R2 manifest is missing;
- R2 manifest exists, but registry has a different current manifest;
- manifest path and manifest body disagree;
- candidate source row count (from ingestdb) is incompatible with trusted R2 state;
- day manifest references connector manifests that are not current/trusted.

Conflict behaviour:

- do not overwrite committed R2;
- do not mark gate complete;
- record `trust_status='conflict'` where applicable;
- log structured error;
- require manual repair/adoption/rebuild.

### 14.1 Adopted parity delta guard (future)

In addition to ownership/manifest checks, add a lightweight row-count parity guard for adopted observations connector candidates.

Guard inputs for each `(day_utc, connector_id)` candidate:

- `prune_ingestdb_source_row_count` (rows selected from ingestdb source during Phase B export path);
- `r2_history_row_count` from adopted current R2 connector manifest/registry row.

Source-of-truth note for this guard:

- Primary parity source DB: ingestdb (main UK AQ DB; `uk_aq_core.observations` via Phase B source path).
- Not part of the parity guard calculation: obsaqidb (`uk_aq_observs.observations`).
- Optional diagnostics only: compare ingestdb vs obsaqidb counts/fingerprints when investigating conflicts.

Guard policy:

1. Compute:
   - `row_count_delta = prune_ingestdb_source_row_count - r2_history_row_count`
   - `abs_row_count_delta = abs(row_count_delta)`
   - `delta_ratio = abs_row_count_delta / greatest(prune_ingestdb_source_row_count, 1)`
2. If `abs_row_count_delta` or `delta_ratio` exceeds configured thresholds:
   - mark candidate and/or registry trust as `conflict`;
   - block prune delete for that day/connector;
   - emit structured conflict log with both counts and delta values.
3. If delta is within thresholds:
   - allow adopt/skip behaviour to continue.

Recommended initial thresholds (tune later):

- `abs_row_count_delta > 1000` OR
- `delta_ratio > 0.10` (10%)

This is intentionally a metadata-level safety check, not full row-by-row parity. It is intended to catch large drift cheaply, using ingestdb as the parity source for prune safety decisions.

Operational impact:

- Supabase egress impact: none (internal DB-to-worker queries only).
- DB size impact: minimal (small extra metrics fields in logs and optional registry notes).
- Runtime impact: low (simple integer math per adopted candidate).

---

## 15. Force rebuild policy

Force rebuild must be explicit and scoped.

Required controls:

```text
UK_AQ_R2_HISTORY_ALLOW_FORCE_REBUILD=true
historyForceRebuild=true
historyForceRebuildReason=<non-empty>
historyForceDays=<explicit days>
historyForceConnectorIds=<explicit connectors>
```

Normal scheduled prune should not be able to broad-force rebuild.

Recommended rebuild flow:

1. Read old registry/manifest state.
2. Preserve old current object until new output validates.
3. Write new output to a rebuild/versioned area.
4. Validate new manifest and parts.
5. Promote stable manifest last.
6. Mark old registry row `superseded`.
7. Insert new current registry row.
8. Mark derived AQI state stale if observations changed.

---

## 16. Migration plan

### Stage 1 — add registry schema

Add `uk_aq_ops.r2_history_object_registry` and indexes.

No worker behaviour change yet.

### Stage 2 — registry adoption script

Build script to scan/adopt existing R2 history:

- observations connector manifests;
- observations day manifests;
- AQI day manifests;
- AQI connector manifests if used.

The script should:

- parse manifests;
- validate enough to assign trust status;
- insert current registry rows;
- report conflicts.

### Stage 3 — dry-run registry enforcement

Deploy worker in registry-aware dry-run/report mode:

- show what would be skipped;
- show what would be adopted;
- show what would be blocked;
- no new overwrite behaviour.

### Stage 4 — enforce registry in Phase B

Worker decision order:

1. registry current/trusted row;
2. R2 manifest adoption fallback;
3. create if absent;
4. block on conflict;
5. force rebuild only with explicit scoped controls.

### Stage 5 — bring AQI under registry

Apply equivalent registry checks to AQI export.

### Stage 6 — safe force rebuild/versioned promotion

Add explicit repair/rebuild path with superseded registry records.

---

## 17. Backward compatibility

- Schema changes are additive.
- Existing `history_candidates` and `prune_day_gates` continue to exist.
- Registry becomes the stronger source of truth for R2 ownership.
- Old worker can run without using registry if rolled back, though Phase B should be disabled if overwrite risk is present.
- Existing adopt-if-R2-exists logic can remain as fallback even after registry exists.

---

## 18. Rollback plan

If registry enforcement causes unexpected blocking:

1. Roll back worker code.
2. Keep registry table and data.
3. Do not drop registry rows.
4. Disable Phase B if needed rather than allowing unsafe overwrite.
5. Investigate conflicts from registry/logs.

If a forced rebuild needs rollback:

1. Find superseded registry row.
2. Restore it as current if safe.
3. Repoint stable manifest if required.
4. Mark bad rebuild row quarantined/superseded.

---

## 19. Acceptance criteria

- Registry has one current connector row per `(domain, day_utc, connector_id)`.
- Registry has one current day row per `(domain, day_utc)`.
- Phase B checks registry/R2 before committed writes.
- Trusted current registry row causes skip/adopt, not overwrite.
- Missing registry but existing R2 manifest causes adopt-or-block, not overwrite.
- Registry/R2 mismatch blocks prune.
- Adopted parity delta guard blocks prune delete when row-count drift exceeds thresholds.
- `prune_day_gates.history_done=true` only when all observations connector objects for the day are trusted/current.
- Force rebuild requires explicit scoped controls.
- Forced rebuild preserves superseded registry records.
- AQI behaviour is coherent with observations.

---

## 20. Test plan

### Unit tests

- registry lookup current trusted row;
- registry missing + R2 manifest exists;
- registry/R2 conflict;
- adopted row-count delta within threshold (adopt allowed);
- adopted row-count delta above threshold (conflict + prune delete blocked);
- candidate complete from registry adoption;
- day gate complete from trusted connector registry rows;
- day gate blocked by one conflict;
- force rebuild guard parsing;
- superseded/current unique index assumptions.

### Integration tests

Use test DB and fake R2:

1. Seed registry current row + R2 manifest.
2. Seed pending candidate.
3. Run Phase B.
4. Assert no committed R2 write and candidate completes from registry.

Repeat with:

- registry missing but R2 manifest exists;
- registry says current but R2 missing;
- R2 manifest exists but body/path mismatch;
- mixed adopted/new connector day;
- adopted connector day with large `prune_ingestdb_source_row_count` vs `r2_history_row_count` drift;
- AQI day manifest exists;
- explicit force rebuild enabled/disabled.

### Manual checks

1. Pick known integrity-loaded day/connector.
2. Ensure registry row exists after adoption.
3. Run prune Phase B.
4. Confirm committed R2 ETag/Last-Modified unchanged.
5. Confirm candidate/gate state points to trusted object.
6. Confirm prune delete only proceeds for days with trusted current observations registry.
