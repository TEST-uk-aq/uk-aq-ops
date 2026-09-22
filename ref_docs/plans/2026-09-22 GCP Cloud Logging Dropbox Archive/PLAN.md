# TEST GCP Cloud Logging to Dropbox Analysis Archive Plan

Date: 22 September 2026

Status: implementation plan aligned with the TEST implementation prepared in `TEST-uk-aq/uk-aq-ops` PR #75. It is not current runtime behaviour until the collector is installed and accepted on TEST. Authoritative future behaviour is defined by `system_docs/gcp_logging_archive/contract.md`.

## Objective

Create a low-cost, analysis-first archive of TEST Google Cloud logs for UK AQ by downloading existing Cloud Logging entries from the always-on MacBook Pro and storing compressed structured files in the locally synced Dropbox tree.

The immediate reason for doing this on TEST first is that TEST is currently producing billable GCP usage, while the aim is to understand where cost and runtime can be reduced without reducing UK AQ functionality or data freshness.

The archive is intended for retrospective analysis, not as a replacement for Cloud Logging during live troubleshooting.

## Core decisions

1. TEST is implemented first.
2. LIVE is out of scope until the TEST collector has operated successfully and the archive has proved useful.
3. Keep the normal Google Cloud Logging service for recent operational troubleshooting.
4. Do not introduce a Cloud Logging sink to BigQuery or Cloud Storage for this archive.
5. Download logs from the MacBook Pro using the Google Cloud Logging API or supported `gcloud logging read` interface.
6. Store the retained archive in the local Dropbox-synchronised filesystem.
7. Retain the original structured log payload as far as practical rather than reducing it to only selected metrics.
8. Prefer more complete historical evidence over increased application logging verbosity.
9. Do not change Latest Snapshot, OpenAQ, ingestion or scheduler cadence as part of this plan.
10. Do not add cloud compute merely to perform the export.
11. No new Dropbox API integration is required. The collector writes to the configured local Dropbox path and Dropbox performs normal filesystem synchronisation.
12. The archive must be incrementally resumable, deduplicated and safe to rerun.

## Architecture

```text
TEST Google Cloud Logging
        |
        | read-only incremental API queries
        v
Always-on MacBook Pro
  TEST log archive collector
        |
        +--> local state_dir
        |      incremental/backfill checkpoints + exclusive lock
        |
        +--> local run_evidence_root
        |      per-invocation log + bounded JSON report
        |
        +--> local Dropbox folder
                 GCP Logs/TEST/archive-identity.json
                 GCP Logs/TEST/raw/YYYY/MM/YYYY-MM-DD.jsonl.gz
                  |
                  v
             Dropbox cloud
```

Cloud Logging remains the recent operational source.

Dropbox becomes the retained analysis archive.

Neither Dropbox nor the local collector changes the behaviour of the running GCP services.

## Initial scope

The first implementation should collect the logs needed to analyse the GCP services currently relevant to TEST cost and execution behaviour.

Priority 1:

- Latest Snapshot Cloud Run service;
- TEST ingestion Cloud Run services;
- Cloud Run request logs associated with those services;
- structured application logs emitted by those services;
- warnings and errors for the same services.

Priority 2, after the collector is operating:

- other TEST Cloud Run services that materially contribute to GCP cost;
- relevant Cloud Scheduler execution evidence;
- relevant Cloud Tasks execution/scheduling evidence where needed for OpenAQ-style self-scheduling analysis;
- Pub/Sub-related logs where they materially explain Cloud Run workload or failures.

Do not collect unrelated Google project audit noise by default merely because it exists. The archive should be broad enough for cost/performance analysis, but still scoped to UK AQ operational services.

## Analysis requirements

The archive should preserve enough information to answer questions such as:

### Latest Snapshot

- how many invocations ran;
- invocation start/end times;
- execution duration;
- HTTP request duration/status where available;
- Pub/Sub messages pulled;
- state transitions applied;
- observations accepted/rejected/skipped where logged;
- number of snapshot objects changed;
- number of no-change runs;
- whether a run changed state but produced no physical snapshot change;
- warnings, retries and failures;
- correlations between workload and Cloud Run execution time;
- time-of-day and day-of-week patterns.

### Ingestion services

- which connector/service ran;
- whether the invocation did useful ingestion work;
- number of observations/stations/pages processed where available;
- skip/no-op reasons;
- upstream/API failures;
- rate-limit evidence where logged;
- retries;
- scheduling decisions where logged;
- execution duration;
- warning/error frequency;
- correlations between useful work and Cloud Run runtime.

### Cost analysis

The log archive should be usable alongside the separate GCP billing dataset/history so that analysis can compare:

- billable service/SKU cost by day;
- invocation counts;
- execution duration;
- useful-work versus no-op proportions;
- high-volume periods;
- unusually expensive periods;
- service configuration or scheduling changes over time.

The log collector itself does not calculate billing truth. Billing remains handled by the separate GCP billing pipeline/plan.

## Archive layout

Use a TEST-only Dropbox root for retained archive content:

```text
<archive_root>/
  GCP Logs/
    TEST/
      archive-identity.json
      raw/
        YYYY/
          MM/
            YYYY-MM-DD.jsonl.gz
```

Checkpoint/lock state and operator run evidence are intentionally outside the Dropbox raw archive and use explicit local `state_dir` and `run_evidence_root` configuration.

The manifest binds the archive generation to the TEST project/filter source identity, stable `archive_id`, resolved raw destination and exact redaction policy. Incremental, backfill and bounded-range modes all validate it before source retrieval or daily-file mutation. A non-empty manifestless archive is not adopted implicitly.

The LIVE equivalent must not be created or enabled by inference.

## Raw file format

Use compressed JSON Lines:

```text
YYYY-MM-DD.jsonl.gz
```

Each line represents one Cloud Logging entry in a stable serialised form.

JSONL is preferred because:

- Cloud Logging entries are naturally structured;
- entries are not all guaranteed to have exactly the same schema;
- individual records remain easy to stream and parse;
- gzip compression should substantially reduce repetitive JSON;
- the files can later be analysed with Python, DuckDB or other local tooling without introducing a database requirement.

Do not flatten the archive to CSV as the primary retained format.

## Fields to retain

Retain the complete returned log entry unless a field is explicitly excluded for security.

At minimum, preserve:

- log entry timestamp;
- receive timestamp where returned;
- `insertId`;
- log name;
- severity;
- resource type;
- resource labels;
- labels;
- trace/span identifiers where present;
- HTTP request metadata where present;
- structured `jsonPayload`;
- `textPayload` where present;
- operation/source location fields where present.

The collector may add a small archive envelope with fields such as:

- archive environment;
- collector retrieval time;
- source project ID;
- archive schema version.

Do not rewrite or reinterpret the original application payload during archival.

## Deduplication identity

The collector must tolerate overlapping source queries and safe reruns.

Preferred deduplication key:

```text
project_id + log_name + insertId
```

Where `insertId` is absent, use a deterministic fallback derived from stable source-entry fields, for example:

```text
timestamp + log_name + resource + payload hash
```

The fallback must be deterministic and documented.

Do not rely only on timestamps for identity.

## Incremental collection and overlap

The collector should run incrementally.

Each successful run reads from a bounded overlap before the last successful source watermark. This protects against late-arriving Cloud Logging entries and entries whose receive time is later than their event timestamp.

Conceptual flow:

```text
last successful watermark
        |
        +--> subtract overlap
        |
        v
read source window up to a fixed run-end boundary
        |
        v
deduplicate against entries already present for affected archive day(s)
        |
        v
atomically replace affected daily gzip file(s)
        |
        v
record run evidence
        |
        v
advance durable watermark
```

The exact overlap duration should be chosen from observed Cloud Logging behaviour during structural discovery. Start conservatively rather than risking gaps.

## Scheduling

Run the TEST collector on the MacBook Pro using launchd.

Recommended normal cadence:

```text
hourly
```

The logs are for analysis rather than real-time alerting, so minute-level export is unnecessary.

Hourly collection gives:

- reasonably fresh local evidence;
- many opportunities to recover automatically from a transient failure;
- small bounded queries;
- minimal pressure to run cloud-side export infrastructure.

A daily compaction/finalisation step is not required if the hourly collector safely replaces affected daily archives.

## Retention

The purpose of the Dropbox archive is long-term analysis, so do not automatically prune normal archived days during the initial implementation.

Retain:

- all successfully archived raw daily files;
- collector run evidence;
- source/checkpoint information required to prove continuity.

A future retention policy may be added only after real archive growth is measured.

## Credentials and permissions

Use a TEST-specific read-only Google Cloud identity.

Grant only the permissions required to read the relevant TEST Cloud Logging entries.

Requirements:

- no write permission to TEST GCP resources;
- no LIVE project access through the TEST collector unless separately authorised later;
- no service account key or token stored in Git;
- no credentials written into Dropbox archive files;
- local credential/config paths ignored by Git;
- collector logs must not print access tokens or private key material.

If Application Default Credentials or an existing safe local authentication mechanism can satisfy this without a new long-lived key, prefer that.

## Security and payload handling

Cloud logs can contain more than operational metrics.

Before broad retention, inspect representative TEST entries to identify whether payloads contain:

- secrets or authentication tokens;
- personally identifiable information;
- full request URLs containing sensitive query parameters;
- raw third-party API responses that should not be retained indefinitely.

If a known unsafe field exists, exclude or redact only that field at collection time and document the exclusion.

The exact redaction policy is part of archive identity. Changing it is incompatible with the existing archive generation: rebuild into a new archive identity/destination/state or use separately reviewed offline re-sanitisation for history no longer retained by Cloud Logging. Do not merge differently redacted representations into the same retained archive.

Do not broadly strip payloads merely to minimise file size because the goal is retrospective analysis.

## Collector state

Keep TEST collector state in the configured local `state_dir`, outside the Dropbox raw archive.

Incremental and backfill use separate checkpoint files, plus an exclusive invocation lock. Each checkpoint binds to the current source identity, archive ID/resolved destination, redaction-policy identity and applicable successful watermark.

Do not use a checkpoint as proof that archive files are valid. The checkpoint only records successfully published source progress.

Advance the incremental watermark only after every affected daily file for that receive-time window has been published successfully. Advance the backfill cursor only after the current bounded event-time window has been published successfully.

A manual bounded range has no progress checkpoint but is protected by the archive identity manifest.

## Collector run evidence

Store diagnostic run evidence in the configured local `run_evidence_root`, separate from the Dropbox raw archive and checkpoint state.

Each qualifying invocation has its own timestamped run directory containing a persistent human-readable `run.log` and bounded `run-report.json`, following the operator-execution contract.

The structured report should record source/window identity, overlap where applicable, entry/unique/new/duplicate counts, affected dates/files, bytes written, resulting watermark, final status/exit code and bounded error detail.

Do not duplicate complete raw source entries in run evidence. Run logs/reports are diagnostic evidence, not archive or checkpoint authority.

## Failure behaviour

The collector must fail safely.

If a Cloud Logging query fails:

- do not advance the source watermark;
- leave existing daily archive files unchanged;
- record the failure locally;
- allow the next scheduled run to retry.

If writing an affected daily file fails:

- do not replace the existing good file with a partial file;
- do not advance the source watermark;
- keep the temporary file only if useful for diagnosis, otherwise remove it.

Daily file replacement should use temporary-write then atomic rename semantics on the local filesystem.

A collector failure must never affect the running UK AQ cloud service.

## Initial historical backfill

After the TEST collector is deployed, backfill the Cloud Logging history still available from Google.

The backfill should:

1. discover the oldest source log boundary actually available;
2. process bounded time windows;
3. write into the same daily archive format as normal incremental operation;
4. use the same deduplication logic;
5. be safely resumable;
6. avoid assuming that logs exist before Google's current retained boundary.

Do not add a separate incompatible archive format just for the backfill.

Because the purpose is analysis, retain as much currently available TEST history as the source permits.

## Phase 0: targeted structural discovery

This is the genuinely necessary pre-implementation check.

Perform read-only discovery to establish:

- TEST GCP project ID(s) containing the relevant logs;
- exact resource/service names for Latest Snapshot and current ingestion services;
- log names and resource types actually emitted;
- representative structured application entries;
- representative Cloud Run request entries;
- whether Cloud Scheduler, Cloud Tasks and Pub/Sub entries are needed to explain current workloads;
- oldest Cloud Logging history currently available;
- timestamp/receiveTimestamp behaviour needed to choose a safe overlap;
- whether `insertId` is consistently present;
- approximate entries/day and compressed storage size;
- whether payloads contain fields that must be excluded for security;
- whether the current MacBook Pro Ops runtime should use the Logging API client or `gcloud logging read`;
- the appropriate existing UK AQ Dropbox parent path and launchd convention.

No synthetic traffic and no speculative pre-implementation functional test suite is required.

The output is a short structural inventory and final configuration decisions.

## Phase 1: implement the TEST collector

Implementation belongs in `TEST-uk-aq/uk-aq-ops`.

Add, following existing local-runtime conventions:

- collector source;
- configuration example;
- README/operator instructions;
- TEST launchd definition;
- local ignored state/credential path rules where needed.

The collector should support at least:

```text
incremental
backfill
single bounded range
```

The bounded-range mode is for operator analysis/recovery, not a separate code path with different archive semantics.

Before deployment, only validate structural viability:

- source query syntax/API shape;
- pagination;
- permissions;
- gzip/JSONL writing;
- atomic replacement;
- checkpoint persistence;
- launchd configuration;
- Dropbox target path.

Functional acceptance begins only after deployment against real TEST logs.

## Phase 2: deploy on TEST

Configure:

- TEST project identity;
- TEST read-only Google credentials/authentication;
- selected TEST log filters;
- local Dropbox archive root;
- overlap duration;
- launchd schedule.

Enable the collector on the always-on MacBook Pro.

Do not enable a LIVE collector.

## Phase 3: real TEST historical backfill

Run the real backfill against the available TEST Cloud Logging history.

Record:

- oldest source entry found;
- newest source boundary reached;
- number of daily files produced;
- total raw entries retained;
- compressed archive size;
- any security exclusions applied.

Allow Dropbox to complete normal filesystem synchronisation.

## Phase 4: TEST operational acceptance

Acceptance is through real operation.

Confirm from normal TEST runs that:

- new source logs appear in the correct daily archive;
- overlapping reads do not create duplicate retained entries;
- late-arriving entries within the overlap are added;
- checkpoint progress advances only after archive publication succeeds;
- rerunning a real bounded source range produces the same unique retained result;
- gzip files can be streamed and analysed successfully;
- warnings/errors and structured application payloads remain intact;
- collector failures do not affect UK AQ cloud workloads;
- Dropbox receives the files through normal local synchronisation;
- the archive size is acceptable in practice.

A targeted deterministic check is justified only if atomic replacement or checkpoint failure ordering cannot be established structurally and presents a concrete risk of silently losing log entries. Otherwise, do not create an artificial pre-deployment test suite.

## Phase 5: first cost/performance analysis

Once enough history exists, analyse at least:

- Latest Snapshot useful-work versus no-op runs;
- zero Pub/Sub-message runs;
- state-change but no physical-snapshot-change runs;
- snapshot-object change counts;
- execution-time distributions;
- heavy Pub/Sub backlog periods;
- ingestion invocation useful-work/no-op ratios;
- connector skip reasons;
- warning/error frequency;
- daily and hourly workload patterns.

Join these findings conceptually with the existing GCP billing facts by time/service to identify cost-saving candidates.

Any resulting optimisation is a separate plan/change. This archive plan must not itself alter production behaviour.

## Phase 6: extend coverage where useful

After the first analysis, add other TEST log filters only when they answer a concrete operational/cost question.

Examples:

- Cloud Tasks scheduling evidence for OpenAQ;
- scheduler trigger evidence;
- selected Pub/Sub operational evidence;
- another Cloud Run service contributing meaningful cost.

Prefer adding source coverage over increasing application verbosity unless an analysis question genuinely cannot be answered from existing logs.

## Phase 7: optional LIVE promotion

LIVE is a later, separate decision.

If TEST proves useful, create a structurally equivalent LIVE collector with:

- separate LIVE GCP authentication;
- explicit LIVE project/log filters;
- separate `GCP Logs/LIVE/` Dropbox root;
- separate checkpoint and run history;
- no inferred reuse of TEST paths or identities.

Do not merge TEST and LIVE source state.

## Out of scope

- changing the one-minute Latest Snapshot schedule;
- moving Latest Snapshot or ingestion services away from GCP;
- changing OpenAQ scheduling;
- increasing application log verbosity by default;
- sending logs to BigQuery merely for retention;
- sending logs to Cloud Storage merely for retention;
- making Dropbox a live alerting system;
- replacing recent Cloud Logging troubleshooting;
- automatic service shutdown based on cost;
- LIVE deployment during the TEST phase;
- storing credentials in Git or Dropbox.

## Success criteria

The plan is successful when TEST has a continuously growing, deduplicated, compressed structured log archive in Dropbox that:

- costs no new cloud compute/storage service by design;
- preserves enough detail for retrospective performance and cost analysis;
- survives collector interruptions without silent gaps or duplicate amplification;
- does not affect running UK AQ services;
- retains as much real TEST operational history as is practically available;
- provides evidence for later, separate cost-reduction decisions while preserving current functionality and freshness.
