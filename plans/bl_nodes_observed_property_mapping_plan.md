# UK AQ observed-property mapping plan

## Purpose

Fix the observed-property mapping gap that currently prevents Breathe London Nodes AQI rows from being produced, and prevent the same class of bug across all current and future ingests.

The preferred design is:

1. A central shared database RPC for creating/updating phenomena.
2. A connector-aware mapping table that defines how source pollutant/species labels map to canonical observed properties.
3. Explicit support for source-provided index/derived series, such as BL Nodes `PM25Index` and `NO2Index`, which must remain intentionally unmapped for raw AQI computation.
4. Migration/backfill for existing metadata.
5. Ingest changes so new metadata is always mapped correctly at creation time.

This plan is for implementation in the UK AQ schema and ingest repos. The system is not live, so the aim is a permanent design-level fix rather than a temporary SQL patch.

---

## Implementation status

Last updated: 2026-07-01.

| Phase | Status | Notes |
|---|---|---|
| Phase 0 — Audit and baseline | Complete | Read-only ingest DB audit and active-code audit completed on 2026-07-01. No SQL writes were run. |
| Phase 1 — Schema design | Complete | Canonical and v0.2.0 DDL, focused apply SQL, constraints, docs, tests, and four BL Nodes seed rows completed and applied to CIC-Test on 2026-07-01. |
| Phase 2 — Harden central phenomena RPC | Complete | Mapping-authoritative RPC, explicit administrative mapping mode, strict guards, diagnostics, docs, and transactional validation completed and applied to CIC-Test on 2026-07-01. |
| Phase 3 — Migrate BL Nodes ingest and reconcile metadata | Complete; deploy pending | Ingest migration, tests, documentation, central set-based reconciliation, and BL0052 CIC-Test validation completed on 2026-07-01. Cloud Run image deployment remains an operational step. |
| Phase 4 — Rebuild helper/AQI rows | Validation complete; deploy pending | Targeted helper rebuild, Cloud Run AQI backfill, ObsAQIDB/rollup checks, index exclusion, and local station snapshot v2 validation completed on 2026-07-01. Dashboard and BL Nodes ingest code deployments remain pending. |
| Phase 5 — Migrate other ingests | Complete; deploy pending | Communities, OpenAQ, Sensor.Community, ERG/LAQN, and both UK-AIR SOS writers migrated; 57 existing mappings seeded and populated CIC-Test connectors smoke-tested on 2026-07-01. Service deployments remain pending. |
| Phase 6 — Enforce and monitor | Not started | Renumbered from the former Phase 7. |

The former standalone Phase 4 metadata-backfill migration has been removed. A
separate migration is unnecessary if Phase 3 invokes the hardened, idempotent
central RPC for all four existing BL Nodes phenomena before observation
processing. That reconciliation must update the two raw phenomenon mappings
while preserving the two index phenomena as intentionally unmapped. This is
separate from the later BL Nodes observation-history backfill.

---

## Current problem

Breathe London Nodes is successfully ingesting observations, but the raw PM2.5 and NO2 timeseries are not being included in AQI helper output.

Example from BL0052, Byward Street / Great Tower Street:

| Timeseries ID | Ref | Meaning | Current mapping state |
|---:|---|---|---|
| `8317497` | `BL0052:PM25` | Raw PM2.5 concentration | `observed_property_id = null` |
| `8317498` | `BL0052:NO2` | Raw NO2 concentration | `observed_property_id = null` |
| `8317499` | `BL0052:PM25Index` | Source-provided PM2.5 DAQI index | `observed_property_id = null`, should remain excluded |
| `8317500` | `BL0052:NO2Index` | Source-provided NO2 DAQI index | `observed_property_id = null`, should remain excluded |

Observed data exists for raw timeseries such as `8317497`, but no rows exist in:

```sql
uk_aq_aqilevels.timeseries_aqi_hourly_helper
```

and therefore no downstream AQI rows can be copied into Obs AQI DB.

The confirmed connector-wide evidence for Breathe London Nodes is:

| Metric | Count |
|---|---:|
| Total BL Nodes timeseries | 576 |
| Timeseries with null observed-property mapping | 576 |
| Raw AQ pollutant timeseries unmapped | 288 |
| Source DAQI/index series, intentionally not raw pollutants | 288 |

---

## Root cause

The active AQI helper source SQL requires a canonical observed-property relationship.

Conceptually it does this:

```sql
join uk_aq_core.phenomena p
  on p.id = ts.phenomenon_id
join uk_aq_core.observed_properties op
  on op.id = p.observed_property_id
where op.code in ('pm25', 'pm10', 'no2')
```

This is deliberately strict. It does not fall back to `pollutant_label`, `notation`, `label`, or `timeseries_ref`.

BL Nodes creates connector-specific phenomena with fields such as:

```text
label = PM2.5
notation = PM2.5
pollutant_label = pm2.5
source_label = breathelondon_nodes:pm2.5
```

but does not write:

```text
phenomena.observed_property_id -> observed_properties.code = pm25
```

So the AQI helper cannot classify the raw PM2.5/NO2 series and excludes them before aggregation starts.

This is not an observation ingestion problem, an AQI Cloud Run worker problem, an Obs AQI DB export problem, or a website problem. It is a metadata mapping problem at the source/ingest/schema boundary.

---

## Current mapping model

The schema already has three important pieces.

### 1. Canonical observed-property table

```sql
uk_aq_core.observed_properties
```

This is the canonical destination table for properties such as:

```text
pm25
pm10
no2
o3
so2
co
temperature
humidity
pressure
```

### 2. Phenomena to observed-property link

```sql
uk_aq_core.phenomena.observed_property_id
```

This links a connector-specific phenomenon to a canonical observed property.

Example intended meaning:

```text
Breathe London Nodes source phenomenon: PM2.5
  -> observed_property_id
  -> canonical observed_properties.code = pm25
```

### 3. Canonicalisation function

```sql
uk_aq_core.uk_aq_observed_property_code(
  source_label text,
  notation text,
  pollutant_label text,
  label text
)
```

This can infer common canonical codes, for example:

```text
pm2.5 -> pm25
pm25 -> pm25
no2 -> no2
nitrogen dioxide -> no2
```

But it is only a function. It is not a trigger and direct table upserts do not call it automatically.

Existing rows may have been mapped by a previous schema/backfill, but new rows created by direct ingest upserts can remain unmapped.

---

## Why a mapping table is needed

A pure string-inference function is useful, but not enough.

Some source labels are raw pollutants:

```text
PM25
NO2
pm2.5
no2
```

Some source labels look pollution-related but are not raw concentration measurements:

```text
PM25Index
NO2Index
daqi_pm25
daqi_no2
```

Those source-provided DAQI/index values must not be mapped to canonical raw pollutants. They should remain explicitly classified as derived/index series.

A connector-aware mapping table lets the database record this distinction clearly and repeatably.

The table should be connector-aware because different data providers use different source names, units, index series, and conventions. For example:

| Connector | Source value | Intended classification |
|---|---|---|
| Breathe London Nodes | `PM25` | raw `pm25` |
| Breathe London Nodes | `PM25Index` | derived/index, no raw mapping |
| Breathe London Communities | `IPM25` | raw `pm25` |
| Sensor.Community | `P2` or similar | raw `pm25`, if that is the connector convention |
| OpenAQ | `pm25` | raw `pm25` |

Connector-specific rows also make audits easier. We can ask: “Which source labels for this connector are mapped, unmapped, or deliberately excluded?”

---

## Proposed data model

### New table: `uk_aq_core.observed_property_mappings`

Suggested columns:

```sql
create table if not exists uk_aq_core.observed_property_mappings (
  id bigint generated by default as identity primary key,

  connector_id integer references uk_aq_core.connectors(id) on delete cascade,

  source_label text not null,
  notation text,
  pollutant_label text,
  source_uom text,

  observed_property_id bigint references uk_aq_core.observed_properties(id),
  observed_property_code text,

  mapping_kind text not null check (
    mapping_kind in (
      'raw_observed_property',
      'derived_index',
      'derived_statistic',
      'meteorological',
      'unknown',
      'ignored'
    )
  ),

  is_aqi_eligible boolean not null default false,
  is_active boolean not null default true,

  confidence text not null default 'explicit' check (
    confidence in ('explicit', 'inferred', 'legacy_backfill')
  ),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint observed_property_mappings_connector_source_uidx
    unique (connector_id, source_label)
);
```

Recommended meaning:

| Column | Meaning |
|---|---|
| `connector_id` | Connector-specific mapping. `null` could optionally be reserved for global fallback mappings, but keep phase 1 connector-specific. |
| `source_label` | Stable provider/source label used by the ingest. |
| `notation` | Human/provider notation, useful for audit. |
| `pollutant_label` | Existing source pollutant label. |
| `source_uom` | Source unit, useful to avoid mapping index values as concentrations. |
| `observed_property_id` | Canonical property link for raw mapped values. |
| `observed_property_code` | Denormalised/code input for readability and migration convenience. |
| `mapping_kind` | Explicit classification. |
| `is_aqi_eligible` | True only for raw AQ pollutants intended for AQI helper use. |
| `confidence` | Whether mapping was explicit, inferred, or backfilled. |

For raw AQ measurements:

```text
mapping_kind = raw_observed_property
observed_property_code = pm25/no2/etc
observed_property_id = canonical ID
is_aqi_eligible = true for pm25, pm10, no2
```

For BL Nodes DAQI index series:

```text
mapping_kind = derived_index
observed_property_code = null
observed_property_id = null
is_aqi_eligible = false
```

### Optional global fallback table

If useful later, a second table could hold provider-independent aliases:

```sql
uk_aq_core.observed_property_aliases
```

Example:

```text
pm2.5 -> pm25
nitrogen dioxide -> no2
```

However, this is not required for the first fix because `uk_aq_observed_property_code()` already provides generic inference. The new mapping table should be the authoritative connector-specific layer.

---

## Proposed central RPC

### New or hardened RPC: `uk_aq_public.uk_aq_rpc_phenomena_upsert`

There is already a central phenomena upsert RPC in the schema. The plan is to make it the required path for ingests and harden the contract so it can safely handle raw and derived/index series.

The RPC should accept rows with fields like:

```json
{
  "connector_id": 2,
  "label": "PM2.5",
  "source_label": "breathelondon_nodes:pm2.5",
  "notation": "PM2.5",
  "pollutant_label": "pm2.5",
  "source_uom": "ug.m-3",
  "mapping_kind": "raw_observed_property",
  "observed_property_code": "pm25",
  "is_aqi_eligible": true
}
```

and for index series:

```json
{
  "connector_id": 2,
  "label": "PM2.5 DAQI",
  "source_label": "breathelondon_nodes:pm2.5:daqi",
  "notation": "PM2.5 DAQI",
  "pollutant_label": "daqi_pm25",
  "source_uom": "DAQI",
  "mapping_kind": "derived_index",
  "observed_property_code": null,
  "is_aqi_eligible": false
}
```

RPC responsibilities:

1. Upsert or look up canonical `observed_properties` for raw mapped rows.
2. Upsert the connector-specific mapping table row.
3. Upsert the `phenomena` row.
4. Set `phenomena.observed_property_id` only when `mapping_kind` is `raw_observed_property` or another explicitly mappable kind.
5. Leave `phenomena.observed_property_id` null when `mapping_kind` is `derived_index`, `ignored`, or `unknown`.
6. Return a mapping of `source_label -> phenomenon_id`, plus mapping status for diagnostics.
7. Be idempotent.
8. Never silently convert an index series into raw PM2.5/NO2.

### Suggested RPC safety rules

The RPC should reject inconsistent input, for example:

| Input | Behaviour |
|---|---|
| `mapping_kind = raw_observed_property`, no code, but inference gives `pm25` | Accept if inference mode is allowed, or require explicit code depending on chosen strictness. |
| `mapping_kind = raw_observed_property`, `source_uom = DAQI` | Reject. |
| `mapping_kind = derived_index`, `observed_property_code = pm25` | Reject unless an explicit override is introduced. |
| `is_aqi_eligible = true`, `observed_property_code not in ('pm25','pm10','no2')` | Reject or force false. |
| `pollutant_label like 'daqi_%'`, `mapping_kind = raw_observed_property` | Reject. |

Recommended strictness for phase 1:

- Require explicit `observed_property_code` for raw BL Nodes and other known AQ pollutants.
- Allow fallback inference only when `mapping_kind = raw_observed_property` and a feature flag/parameter says inference is allowed.
- Never infer for `derived_index` rows.

---

## Phased implementation plan

## Phase 0 — Audit and baseline

Goal: quantify the problem across all connectors before changing anything.

Status: **Complete (2026-07-01).**

### Tasks

1. Run read-only diagnostics on ingest DB:
   - raw AQ pollutant phenomena with null `observed_property_id`;
   - DAQI/index/pseudo-series;
   - connector/source-label grouping;
   - comparison between existing mapped and unmapped connectors.
2. Confirm which ingests directly upsert `uk_aq_core.phenomena`.
3. Confirm whether any existing ingest already uses `uk_aq_rpc_phenomena_upsert`.
4. Confirm AQI helper dependency on `phenomena.observed_property_id`.
5. Document current counts by connector.

### Acceptance criteria

- A connector-by-connector table of unmapped raw AQ series exists.
- BL Nodes count remains understood: 288 raw unmapped, 288 derived/index unmapped.
- No SQL writes have been run.

### Completed baseline

The diagnostics were executed against the CIC-Test ingest DB inside an explicit
read-only transaction with `default_transaction_read_only=on`. The transaction
was rolled back after the queries.

| Connector | Timeseries | Unmapped timeseries | Unmapped raw AQ timeseries |
|---|---:|---:|---:|
| `blondon_nodes` | 576 | 576 | 288 |
| `blondon_communities` | 408 | 0 | 0 |
| `openaq` | 2,833 | 0 | 0 |
| `sensorcommunity` | 1,119 | 0 | 0 |
| `sos` | 1,132 | 0 | 0 |

BL Nodes detail:

| Source label | Classification | Timeseries | Mapped canonical code |
|---|---|---:|---|
| `breathelondon_nodes:pm2.5` | Raw pollutant | 144 | Unmapped |
| `breathelondon_nodes:no2` | Raw pollutant | 144 | Unmapped |
| `breathelondon_nodes:pm2.5:daqi` | Derived/index | 144 | Intentionally unmapped |
| `breathelondon_nodes:no2:daqi` | Derived/index | 144 | Intentionally unmapped |

The currently mapped connectors demonstrate that earlier schema/backfill work
populated their metadata, but their active ingest implementations can still
create future unmapped phenomena:

| Active ingest | Current phenomena write path |
|---|---|
| Breathe London Nodes | Direct PostgREST upsert to `uk_aq_core.phenomena` |
| Breathe London Communities | Direct PostgREST upsert |
| OpenAQ | Direct SQL insert/upsert |
| Sensor.Community | Direct PostgREST upsert |
| ERG/LAQN | Direct PostgREST upsert |
| UK-AIR SOS, including AURN | Direct PostgREST upsert |

No active ingest call to `uk_aq_public.uk_aq_rpc_phenomena_upsert` was found.
The active AQI source RPC was also reconfirmed to require the inner join from
`timeseries.phenomenon_id` through `phenomena.observed_property_id`; it has no
label or `pollutant_label` fallback.

Phase 0 egress impact: the audit caused only bounded diagnostic response egress
from the ingest DB. It made no endpoint or steady-state egress change.

Phase 0 database-size impact: none. All database work was read-only.

### Suggested SQL

```sql
select
  c.connector_code,
  count(*) as timeseries_count,
  count(*) filter (where p.observed_property_id is null) as unmapped_timeseries,
  count(*) filter (
    where p.observed_property_id is null
      and lower(coalesce(t.uom, '')) <> 'daqi'
      and uk_aq_core.uk_aq_observed_property_code(
        p.source_label, p.notation, p.pollutant_label, p.label
      ) in ('pm25', 'pm10', 'no2', 'o3', 'so2', 'co')
  ) as unmapped_raw_aq_timeseries
from uk_aq_core.timeseries t
join uk_aq_core.connectors c on c.id = t.connector_id
left join uk_aq_core.phenomena p on p.id = t.phenomenon_id
group by c.connector_code
order by unmapped_raw_aq_timeseries desc, unmapped_timeseries desc, c.connector_code;
```

---

## Phase 1 — Schema design for connector-aware mapping

Goal: add durable mapping metadata without changing ingest behaviour yet.

Status: **Complete and applied to the CIC-Test ingest DB (2026-07-01).**

### Tasks

1. Add `uk_aq_core.observed_property_mappings` table.
2. Add indexes and uniqueness constraints.
3. Add comments explaining raw versus derived/index semantics.
4. Add validation checks for invalid combinations.
5. Seed explicit mapping rows for existing known connectors, starting with BL Nodes.
6. Add system documentation.

### Initial BL Nodes mapping rows

| Connector | Source label | Mapping kind | Canonical code | AQI eligible |
|---|---|---|---|---|
| `blondon_nodes` | `breathelondon_nodes:pm2.5` | `raw_observed_property` | `pm25` | true |
| `blondon_nodes` | `breathelondon_nodes:no2` | `raw_observed_property` | `no2` | true |
| `blondon_nodes` | `breathelondon_nodes:pm2.5:daqi` | `derived_index` | null | false |
| `blondon_nodes` | `breathelondon_nodes:no2:daqi` | `derived_index` | null | false |

### Acceptance criteria

- Mapping table exists.
- BL Nodes mapping rows are present.
- Derived/index rows are explicitly represented and not treated as raw AQ pollutants.
- No ingest code has changed yet.

### Completed implementation

- Added canonical DDL to
  `schemas/ingest_db/uk_aq_core_schema.sql`.
- Added focused, idempotent apply SQL at
  `schemas/ingest_db/uk_aq_observed_property_mappings.sql`.
- Kept the v0.2.0 target schema, seed, and security files aligned.
- Enforced canonical observed-property ID/code consistency with a composite
  foreign key.
- Added checks for mapping-kind/property presence, AQI eligibility, DAQI/index
  units, and `daqi_*` pollutant labels.
- Added RLS and service-role write policy.
- Seeded two raw and two intentionally unmapped derived/index BL Nodes rows.
- Added schema overview, table documentation, and static contract tests.
- Applied the focused SQL to the CIC-Test ingest DB and verified all four seed
  rows.
- Confirmed Phase 1 did not alter runtime phenomena: all 576 BL Nodes
  timeseries remain unmapped until the Phase 2/3 RPC path applies the policy.

Phase 1 egress impact: no steady-state endpoint response egress change. The
apply and validation produced only small administrative result sets.

Phase 1 database-size impact: negligible—one small mapping table, three
indexes, four seed rows, constraints, and table/column comments. No observation
or AQI fact rows were added.

---

## Phase 2 — Harden central phenomena RPC

Goal: make one safe shared RPC responsible for mapping and phenomena upsert.

Status: **Complete and applied to the CIC-Test ingest DB (2026-07-01).**

### Tasks

1. Update or replace `uk_aq_public.uk_aq_rpc_phenomena_upsert` to accept mapping metadata.
2. Make it consult `observed_property_mappings` by `(connector_id, source_label)`.
3. Allow explicit input to create/update mapping rows when authorised by migration/admin usage.
4. Set `phenomena.observed_property_id` based on the mapping table.
5. Return enough information for ingest scripts:
   - `source_label`;
   - `phenomenon_id`;
   - `observed_property_code`;
   - `mapping_kind`;
   - `is_aqi_eligible`;
   - any warning or inferred status.
6. Add strict rejection for dangerous mismatches.
7. Add SQL tests or validation SQL.

### Important design choice

There are two possible RPC modes.

#### Option 2A — Mapping table is authoritative

Ingests call the RPC with ordinary phenomenon fields. The RPC looks up `(connector_id, source_label)` in the mapping table and applies the mapping.

Pros:

- Central database controls mappings.
- Ingest code stays simpler.
- Changing a mapping does not require code deployment.

Cons:

- New source labels must be seeded before ingest, or they become `unknown`.
- Requires good diagnostics for unmapped rows.

#### Option 2B — Ingest provides explicit mapping metadata

Ingests call the RPC with `observed_property_code` and `mapping_kind`; the RPC validates and stores it.

Pros:

- Mapping lives close to connector code.
- New connector species can be introduced by code changes.

Cons:

- More chance of divergent mapping logic across ingests.
- Harder to audit all mappings centrally.

### Recommendation

Use a hybrid:

1. Mapping table is authoritative for known connector/source labels.
2. Ingest may provide explicit mapping metadata for first-time known connector labels.
3. RPC validates the ingest-provided mapping and upserts the mapping table.
4. Unknown labels are allowed only as `unknown`/unmapped unless explicitly classified.

### Acceptance criteria

- RPC maps BL Nodes PM25/NO2 correctly.
- RPC leaves BL Nodes PM25Index/NO2Index unmapped.
- RPC cannot accidentally map `DAQI` unit rows to raw `pm25`/`no2`.
- RPC is idempotent.

### Completed implementation

- Hardened `uk_aq_public.uk_aq_rpc_phenomena_upsert` with a default
  mapping-table-authoritative mode.
- Added explicit `p_allow_mapping_upsert=true` administrative mode for
  controlled mapping registration/change.
- Required existing canonical observed-property codes for raw and
  meteorological mappings; the RPC no longer creates arbitrary canonical codes
  from untrusted source labels.
- Added strict rejection for:
  - raw mappings without a canonical code;
  - derived/index mappings with a canonical code;
  - DAQI/index units classified as raw;
  - `daqi_*` pollutant labels classified as raw;
  - invalid AQI eligibility;
  - caller metadata that conflicts with authoritative policy;
  - duplicate connector/source keys in one request.
- Unknown labels are recorded as `unknown`, remain canonically unmapped, and
  return `mapping_warning = unknown_source_label`.
- The RPC now returns one diagnostic row per phenomenon: source identity,
  phenomenon ID, canonical code, mapping kind, AQI eligibility, status, and
  warning.
- Derived/inactive mappings explicitly clear `phenomena.observed_property_id`;
  the old null-preserving `coalesce` behaviour was removed.
- When transitional direct timeseries mapping columns are present, the RPC
  reconciles `timeseries.observed_property_id` with a set-based update that
  writes only differing rows and returns no timeseries metadata.
- Added static contract tests, transactional SQL validation, RPC documentation,
  and schema-overview documentation.
- Applied the new function and service-role grant to CIC-Test.
- Transactional validation passed for raw PM2.5, derived PM2.5 DAQI,
  dangerous-input rejection, policy-conflict rejection, and unknown-label
  diagnostics; validation changes were rolled back.

Phase 2 egress impact: no steady-state endpoint response change yet because no
active ingest calls the RPC. Future ingest metadata calls return small
diagnostic rows, which is negligible compared with observation traffic.

Phase 2 database-size impact: negligible. The function and documentation add no
fact rows. Transactional validation writes were rolled back.

---

## Phase 3 — Migrate BL Nodes ingest and reconcile existing metadata

Goal: fix the currently broken connector and idempotently reconcile its existing
phenomena without a separate one-off metadata-backfill migration.

Status: **Implementation and CIC-Test metadata reconciliation complete
(2026-07-01); Cloud Run deployment pending.**

### Tasks

1. Update `scripts/blondon_nodes/blondon_nodes_ingest.py`.
2. Extend `SPECIES_CONFIG` with explicit mapping metadata:

```python
"PM25": {
    "label": "PM2.5",
    "uom": "ug.m-3",
    "source_label": "breathelondon_nodes:pm2.5",
    "notation": "PM2.5",
    "pollutant_label": "pm2.5",
    "kind": "pollutant",
    "mapping_kind": "raw_observed_property",
    "observed_property_code": "pm25",
    "is_aqi_eligible": True,
}
```

```python
"NO2": {
    "label": "NO2",
    "uom": "ug.m-3",
    "source_label": "breathelondon_nodes:no2",
    "notation": "NO2",
    "pollutant_label": "no2",
    "kind": "pollutant",
    "mapping_kind": "raw_observed_property",
    "observed_property_code": "no2",
    "is_aqi_eligible": True,
}
```

```python
"PM25Index": {
    "label": "PM2.5 DAQI",
    "uom": "DAQI",
    "source_label": "breathelondon_nodes:pm2.5:daqi",
    "notation": "PM2.5 DAQI",
    "pollutant_label": "daqi_pm25",
    "kind": "daqi_index",
    "mapping_kind": "derived_index",
    "observed_property_code": None,
    "is_aqi_eligible": False,
}
```

```python
"NO2Index": {
    "label": "NO2 DAQI",
    "uom": "DAQI",
    "source_label": "breathelondon_nodes:no2:daqi",
    "notation": "NO2 DAQI",
    "pollutant_label": "daqi_no2",
    "kind": "daqi_index",
    "mapping_kind": "derived_index",
    "observed_property_code": None,
    "is_aqi_eligible": False,
}
```

3. Replace direct `self.core.table("phenomena").upsert(...)` with the central RPC.
4. Keep returned `source_label -> phenomenon_id` behaviour for timeseries creation.
5. Add tests for all four species.
6. Update BL Nodes docs.
7. On ingest startup, pass all four configured BL Nodes phenomena through the
   hardened central RPC, including phenomena that already exist.
8. Verify that this idempotent call:
   - maps existing raw `breathelondon_nodes:pm2.5` to `pm25`;
   - maps existing raw `breathelondon_nodes:no2` to `no2`;
   - leaves the two DAQI/index phenomena unmapped;
   - updates direct `timeseries.observed_property_id` too if the v0.2.0 direct
     relationship is active.

### Acceptance criteria

- New BL Nodes phenomena are created with canonical mappings for raw PM25/NO2.
- Index series remain intentionally unmapped.
- Running BL Nodes ingest for one station returns the same timeseries IDs or safely updates existing rows.
- No direct table upsert to `phenomena` remains in BL Nodes.
- Existing BL Nodes raw metadata is repaired by the normal idempotent RPC path;
  no separate manual metadata migration is required.
- This returns zero:

```sql
select count(*)
from uk_aq_core.timeseries t
join uk_aq_core.connectors c on c.id = t.connector_id
join uk_aq_core.phenomena p on p.id = t.phenomenon_id
where c.connector_code = 'blondon_nodes'
  and p.observed_property_id is null
  and t.timeseries_ref ~ ':(PM25|NO2)$';
```

- This returns 288, or the current expected count of index series:

```sql
select count(*)
from uk_aq_core.timeseries t
join uk_aq_core.connectors c on c.id = t.connector_id
join uk_aq_core.phenomena p on p.id = t.phenomenon_id
where c.connector_code = 'blondon_nodes'
  and p.observed_property_id is null
  and t.timeseries_ref ~ ':(PM25Index|NO2Index)$';
```

### Completed implementation

- Added explicit raw/index mapping metadata to all four BL Nodes
  `SPECIES_CONFIG` entries.
- Replaced the direct `uk_aq_core.phenomena` table upsert with
  `uk_aq_public.uk_aq_rpc_phenomena_upsert`.
- Kept the existing `source_label -> phenomenon_id` behaviour used by
  timeseries creation and added canonical observed-property IDs to timeseries
  upsert rows.
- Validated every RPC diagnostic against the connector configuration and fail
  closed on warnings or mapping mismatches.
- Moved transitional direct-timeseries reconciliation into the central RPC as
  a set-based update. This avoids downloading all 576 timeseries metadata rows
  on every ingest run.
- Added three BL Nodes mapping tests and updated connector documentation.
- Ran BL0052 metadata-only reconciliation with all four species and
  `--max-api-calls 0`; no source observation API calls or checkpoint updates
  occurred.
- Preserved timeseries IDs `8317497` through `8317500`.
- Reconciled all 288 raw BL Nodes timeseries at both the phenomenon and direct
  timeseries links.
- Confirmed all 288 index timeseries remain unmapped at both links.
- Confirmed the idempotent rerun required only the central RPC and normal
  BL0052 timeseries upsert; it did not download connector-wide timeseries
  metadata.

Phase 3 egress impact: the steady-state metadata path adds one small RPC
diagnostic response per ingest run. Connector-wide direct-link reconciliation
is executed inside Postgres and returns no timeseries rows, avoiding the
approximately 576-row metadata response that an application-side
reconciliation would require. Observation endpoint response egress is
unchanged.

Phase 3 database-size impact: negligible metadata updates only. No observation,
helper, or AQI fact rows were added. Existing raw timeseries rows received
canonical foreign-key values; index rows remain null.

Required deployment step: publish the changed ingest repository through
`.github/workflows/uk_aq_blondon_nodes_cloud_run_deploy.yml` before considering
the Cloud Run runtime migrated. Phase 4 validation should use the deployed
revision.

---

## Phase 4 — Rebuild helper/AQI rows for BL Nodes

Goal: prove the mapping fix restores AQI output.

Status: **Targeted CIC-Test validation complete (2026-07-01); changed
repository code deployments remain pending.**

### Tasks

1. Run targeted helper rebuild for BL0052 raw PM2.5, `timeseries_id = 8317497`.
2. Verify helper rows appear with `pollutant_code = 'pm25'`.
3. Run targeted AQI worker/reconcile for the same window.
4. Verify Obs AQI DB hourly rows exist.
5. Confirm station snapshot v2 uses raw PM2.5 timeseries and displays AQI data.
6. Confirm BL Nodes index series are not included in helper/AQI tables.

### Suggested SQL

```sql
select *
from uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_helper_window(
  p_hour_end_start_exclusive := timestamptz '2026-06-30 00:00:00+00',
  p_hour_end_end_inclusive   := timestamptz '2026-07-01 03:00:00+00',
  p_timeseries_ids           := array[8317497]::integer[]
)
order by timestamp_hour_utc desc;
```

Expected: rows appear for `8317497` after helper upsert/rebuild.

### Completed validation

- Selected the bounded mature window `(2026-06-30 00:00,
  2026-07-01 08:00]` UTC for raw BL0052 timeseries `8317497` and `8317498`.
- Ran the targeted ingest helper upsert:
  - 110 hourly source rows read;
  - 62 helper rows inserted/changed;
  - 64 helper rows present across the final window, 32 per raw timeseries.
- Verified helper pollutant codes:
  - `8317497` -> `pm25`;
  - `8317498` -> `no2`.
- Verified helper inputs and DAQI/EAQI levels have `calculation_status = ok`
  for mature rows.
- Confirmed zero helper rows for index timeseries `8317499` and `8317500`.
- Invoked the deployed AQI Cloud Run service in targeted `backfill` mode for
  only `8317497,8317498`; the service returned `ok=true`, `code=0`.
- Verified ObsAQIDB now contains:
  - 32 hourly AQI rows for raw PM2.5;
  - 32 hourly AQI rows for raw NO2;
  - non-null DAQI and EAQI levels on all 64 rows;
  - zero hourly AQI rows for both index timeseries.
- Verified daily and monthly rollup rows exist for both raw timeseries and none
  exist for the index timeseries.

### Station snapshot v2 blocker fixed

Phase 4 uncovered two pre-existing snapshot-handler defects:

1. The handler selected nonexistent `timeseries.phenomenon`, causing the
   request to fail before selecting a timeseries.
2. ObsAQIDB observations and AQI reads shared one `try` block, so the absent
   `uk_aq_public.observations` view suppressed otherwise valid AQI rows.

The handler now:

- selects `observed_property_id,observed_properties(code)`;
- matches the requested pollutant by canonical observed-property code;
- excludes the unmapped PM25Index/NO2Index series from raw selection;
- reads ObsAQIDB observations and AQI independently.

Local handler validation against CIC-Test selected only raw PM2.5 timeseries
`8317497` and returned:

- 22 snapshot rows;
- 20 rows with AQI data;
- latest AQI source `ObsAQIDB`;
- DAQI level 1 and EAQI level 1 for the latest row.

The deployed admin route is protected by Cloudflare Access and could not be
validated unauthenticated. The local handler test used the real CIC-Test
ingest/ObsAQIDB data. Unit tests and TypeScript checks passed.

Phase 4 egress impact: the targeted helper/window and worker run caused bounded
one-time Supabase response egress for 64 helper rows plus validation result
sets. No polling frequency changed. The snapshot fix avoids failed/repeated
requests but does not claim a measured steady-state egress reduction.

Phase 4 database-size impact: 62 additional ingest helper rows, 64 ObsAQIDB
hourly AQI rows, and the expected daily/monthly rollups for two raw timeseries.
No observation-history rows were added or downsampled, and no index-series AQI
rows were created.

Required deployment steps:

- deploy the Phase 3 BL Nodes ingest revision through
  `.github/workflows/uk_aq_blondon_nodes_cloud_run_deploy.yml`;
- deploy the station snapshot v2 fixes through
  `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`;
- repeat the authenticated deployed snapshot request after both deployments.

---

## Phase 5 — Migrate other ingests

Goal: remove the same structural weakness from the rest of the system.

Status: **Implementation and CIC-Test metadata reconciliation complete
(2026-07-01); connector service deployments pending.**

### Priority order

1. Breathe London Communities.
2. OpenAQ.
3. Sensor.Community.
4. ERG/LAQN.
5. GOV.UK/AURN / UK-AIR SOS.
6. Any remaining connector-specific ingest.

### Tasks per ingest

For each connector:

1. Identify all source phenomena/species/parameters.
2. Add or seed mapping-table rows.
3. Move phenomena creation to central RPC.
4. Remove direct `phenomena` table upserts.
5. Add tests.
6. Run connector-specific validation SQL.
7. Backfill existing phenomena if needed.

### Acceptance criteria

- No active ingest directly upserts `uk_aq_core.phenomena` without going through the central RPC or a clearly documented equivalent.
- All raw AQ pollutant series have canonical observed-property mapping.
- Derived/index/pseudo-series are explicitly classified and excluded.

### Completed implementation

- Added shared fail-closed client helper
  `scripts/uk_aq_phenomena_rpc.py`.
- Migrated these active writers away from direct phenomena writes:
  - Breathe London Communities shared station/ingest writer;
  - OpenAQ psycopg metadata writer;
  - Sensor.Community ingest writer;
  - ERG/LAQN ingest writer;
  - UK-AIR SOS observation/discovery writer;
  - UK-AIR SOS station-list discovery writer.
- Confirmed no active ingest contains a direct phenomena table upsert or direct
  `insert into uk_aq_core.phenomena`.
- Added a schema-repo Phase 5 policy seed that preserves verified current
  canonical mappings and excludes legacy null-source-label rows.
- Seeded 57 authoritative mappings:
  - Breathe London Communities: 2;
  - OpenAQ: 13;
  - Sensor.Community: 5;
  - UK-AIR SOS: 37.
- Preserved AQ/met domain classification and limited AQI eligibility to PM2.5,
  PM10, and NO2.
- Reapplying the seed produced `INSERT 0 0`.
- Ran the central RPC across all 57 stable source labels:
  - every row returned `mapping_status = existing`;
  - zero mapping warnings;
  - zero unmapped phenomena or timeseries for populated non-BL-Nodes
    connectors.
- Ran real writer-level CIC-Test smoke calls:
  - Communities: 2 mappings;
  - Sensor.Community: 5 mappings;
  - OpenAQ: 13 mappings;
  - UK-AIR SOS ingest writer: 37 mappings;
  - UK-AIR SOS station-list writer: 37 mappings.
- ERG/LAQN compilation and contract validation passed. It could not receive a
  database smoke call because no `erg_laqn` connector currently exists in
  CIC-Test; its fixed species path uses explicit administrative registration.
- Added shared-helper and unsafe-direct-write contract tests, connector
  documentation, mapping-table documentation, and the required script note.

Phase 5 egress impact: normal metadata runs replace separate phenomena writes
and follow-up ID reads with one small RPC diagnostic response where possible.
The one-time policy/reconciliation validation returned 57 rows. Observation
endpoint response egress and the fixed one-minute website polling requirement
are unchanged.

Phase 5 database-size impact: 57 small mapping-policy rows plus indexes already
created in Phase 1. Existing foreign-key values were reconciled in place; no
observation, helper, AQI, or history fact rows were added.

Required deployment steps after committing/pushing:

- `.github/workflows/uk_aq_blondon_communities_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_openaq_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_sos_cloud_run_deploy.yml`.

No dedicated Sensor.Community or ERG/LAQN deploy workflow currently exists in
the ingest repo, so their active deployment path must be identified before
those runtime migrations can be considered deployed.

---

## Phase 6 — Enforce and monitor

Goal: prevent regressions.

### Tasks

1. Add database validation checks for unmapped raw AQ series.
2. Add CI/contract tests to search ingest code for unsafe direct phenomena upserts.
3. Add a scheduled metadata health report.
4. Add Cloud Logging warnings when an ingest creates `unknown` or unmapped raw-looking phenomena.
5. Consider eventually enforcing not-null mapping for AQ-eligible raw timeseries.

### Suggested health query

```sql
select
  c.connector_code,
  count(*) as unmapped_raw_aq_timeseries
from uk_aq_core.timeseries t
join uk_aq_core.connectors c on c.id = t.connector_id
join uk_aq_core.phenomena p on p.id = t.phenomenon_id
where p.observed_property_id is null
  and lower(coalesce(t.uom, '')) not in ('daqi', 'index')
  and uk_aq_core.uk_aq_observed_property_code(
    p.source_label, p.notation, p.pollutant_label, p.label
  ) in ('pm25', 'pm10', 'no2', 'o3', 'so2', 'co')
group by c.connector_code
having count(*) > 0
order by unmapped_raw_aq_timeseries desc;
```

### Acceptance criteria

- Metadata health query returns zero for raw AQ pollutants.
- Any future unmapped raw-looking source labels are surfaced as a deployment/test failure or operational warning.

---

## Recommended implementation sequence

Because the system is not live, favour the permanent shared fix.

Recommended order:

1. Phase 0 audit.
2. Phase 1 mapping table.
3. Phase 2 hardened central RPC.
4. Phase 3 BL Nodes RPC migration and idempotent existing-metadata reconciliation.
5. Phase 4 targeted BL Nodes validation.
6. Phase 5 migrate other ingests.
7. Phase 6 enforcement.

Do not start by changing the AQI helper to infer from labels. The strict AQI helper is useful because it exposes bad metadata instead of silently guessing.

---

## Fix options considered

### Option A — Only fix BL Nodes in application code

Add `observed_property_code` to BL Nodes `SPECIES_CONFIG`, resolve IDs, and write `observed_property_id` directly.

Pros:

- Fastest.
- Low local risk.
- Fixes current visible BL Nodes AQI issue.

Cons:

- Does not fix other ingests.
- Repeats mapping logic in application code.
- Future connectors can recreate the same bug.
- No central audit trail of source mappings.

Recommendation: not enough as the final design.

### Option B — Central RPC only, no mapping table

Make all ingests call a shared RPC that uses `uk_aq_observed_property_code()`.

Pros:

- Simpler than adding a table.
- Removes direct table upserts.

Cons:

- Risky for index/pseudo-series.
- No connector-specific source mapping audit.
- Harder to explicitly say “this source label is intentionally unmapped”.

Recommendation: useful but incomplete.

### Option C — Mapping table plus central guarded RPC

Add connector-aware mapping table and make all ingests use a central RPC.

Pros:

- Best long-term design.
- Handles raw versus derived/index explicitly.
- Auditable by connector.
- Avoids repeated code-level mapping logic.
- Supports future connectors safely.

Cons:

- More implementation work.
- Requires careful migration and validation.

Recommendation: choose this.

### Option D — AQI helper fallback

Make AQI helper infer pollutants from `pollutant_label` or labels if `observed_property_id` is missing.

Pros:

- Can recover AQI rows quickly for unmapped legacy data.

Cons:

- Hides metadata defects.
- Risks accidentally including DAQI/index series.
- Adds downstream complexity.
- Conflicts with the v0.2.0 direction of stronger canonical metadata.

Recommendation: do not use as the main fix.

---

## Validation checklist

### Database metadata

- BL Nodes raw PM2.5 maps to `pm25`.
- BL Nodes raw NO2 maps to `no2`.
- BL Nodes `PM25Index` remains unmapped.
- BL Nodes `NO2Index` remains unmapped.
- Other connectors have no raw AQ pollutant series with null observed-property mapping.

### AQI helper

- `8317497` appears in helper output after rebuild.
- `8317498` appears in helper output after rebuild.
- `8317499` and `8317500` do not appear in helper output.

### Obs AQI DB

- Hourly AQI rows appear for BL Nodes raw PM2.5/NO2 after worker reconciliation.
- Rollups update normally.
- No FK errors are introduced.

### Website/snapshot

- Station snapshot v2 selects raw PM2.5/NO2 timeseries for readings.
- It does not choose `PM25Index`/`NO2Index` as raw pollutant timeseries.
- BL Nodes chart/AQI display uses computed AQI rows, not source-provided DAQI index rows.

---

## Non-goals

- Do not treat source-provided DAQI index values as raw pollution observations.
- Do not fix only in Obs AQI DB.
- Do not make the website infer AQI from BL Nodes `PM25Index`/`NO2Index`.
- Do not rely on a one-off manual SQL patch as the final solution.
- Do not weaken AQI helper strictness as the primary fix.
- Do not expose private/core schemas through public APIs to work around metadata issues.

---

## Summary recommendation

Use a connector-aware mapping table plus a hardened central phenomena upsert RPC.

Start with BL Nodes because it is currently broken and provides a clear test case:

```text
PM25       -> raw pm25, AQI eligible
NO2        -> raw no2, AQI eligible
PM25Index  -> derived index, not AQI eligible
NO2Index   -> derived index, not AQI eligible
```

Then migrate the other ingests away from direct `phenomena` table upserts. Once all ingests use the shared mapping path, add monitoring/validation so unmapped raw AQ pollutant series cannot silently break AQI again.
