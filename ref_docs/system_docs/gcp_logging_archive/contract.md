# GCP Cloud Logging analysis archive contract

## Status

**Active TEST current-runtime contract and future shared TEST/LIVE implementation contract.** The existing TEST collector is deployed and operating. These rules also constrain the environment-agnostic refactor and later LIVE activation. LIVE collection is not current runtime until its environment-specific configuration and operational acceptance are complete.

## Scope

The collector runs on the always-on MacBook Pro. One environment-agnostic implementation MUST support TEST and LIVE while keeping their configuration, credentials, state, evidence and archives isolated.

The runner MUST obtain `UK_AQ_ENV_NAME` from the corresponding local ingest repository `.env`. The only valid values are exactly `TEST` and `LIVE`. A missing, ambiguous or different value MUST fail closed before selecting credentials, creating the Cloud Logging client, retrieving entries or mutating archive/state. Environment identity MUST NOT be inferred from the ops repository path, Google project, archive path or another default.

Each environment's source scope is its configured Cloud Run services needed for cost/performance and operational analysis, including Latest Snapshot, selected ingestion services, their structured application logs and Cloud Run request logs. Project IDs and exact log filters are environment-specific configuration and MUST NOT be copied or inferred from the other environment.

The collector MUST NOT alter Cloud Run, schedulers, ingestion, Latest Snapshot cadence, application logging verbosity or another UK AQ cloud workload.

## Environment-isolated local runtime

All GCP logging archive operational runtime material MUST live below:

```text
/Users/mikehinford/uk-aq-gcp-logging-archive/<ENV>/
```

where `<ENV>` is the validated `UK_AQ_ENV_NAME`. The environment tree owns its configuration, checkpoints/state, run evidence, launchd/operator logs and Google credential material. A conventional layout is:

```text
<ENV>/
  config.json
  state/
  runs/
  logs/
  credentials/
```

Equivalent filenames inside those owned directories are implementation detail, but TEST and LIVE MUST NOT share mutable state, run evidence, logs or credentials.

After migration, this subsystem MUST NOT write new configuration, checkpoints, run evidence or operational logs beneath `~/Library/Logs/UK-AQ`, `~/Library/Logs/UK AQ`, `~/.config/uk-aq/gcp-logging-archive-*.json` or `~/.local/state/uk-aq/gcp-logging-archive`. Existing TEST evidence in superseded locations MAY be retained temporarily as rollback/history evidence until the migrated TEST runtime is accepted.

Implementation code remains in the ops repository and is not part of the runtime-state tree. The corresponding ingest repository `.env` remains the authority only for `UK_AQ_ENV_NAME`; secrets and full process environments MUST NOT be copied into run evidence.

## Archive layout and identities

The effective Dropbox-retained archive destinations are:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/GCP Logs/
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/LIVE/GCP Logs/
```

Each environment has the same logical archive layout:

```text
GCP Logs/
  archive-identity.json
  raw/
    YYYY/
      MM/
        YYYY-MM-DD.jsonl.gz
```

The environment directory is deliberately above `GCP Logs`. TEST and LIVE archive generations MUST NOT be nested under one shared `GCP Logs` directory and MUST NOT share archive identity.

Checkpoint state and operator run evidence MUST remain outside Dropbox under the environment-isolated runtime root defined above.

Each archive generation MUST have a stable `archive_id`.

The archive identity manifest MUST bind, at minimum:

- manifest schema version;
- validated environment (`TEST` or `LIVE`);
- selected environment project ID and exact log-filter identity;
- stable `archive_id`;
- resolved raw archive destination;
- exact redaction-policy identity.

All three collector modes, incremental, backfill and bounded range, MUST validate the archive manifest before creating the Cloud Logging client, retrieving entries or modifying daily archive files.

A manifest MAY be initialised automatically only for a genuinely empty archive destination. A non-empty archive without a valid matching manifest MUST fail closed rather than being adopted implicitly.

Changing the source scope, archive generation/destination or redaction policy MUST NOT be accepted merely by deleting or editing identity evidence.

## Raw entry format and redaction

Raw retained days use deterministic gzip-compressed JSON Lines. Each line is one sanitised Cloud Logging entry in stable JSON serialisation.

The collector SHOULD retain the returned structured entry as completely as practical, including timestamps, `insertId`, log name, severity, monitored-resource information, labels, trace/span fields, HTTP request metadata and structured/text payloads.

Known unsafe fields MUST be removed before archival. Redaction paths are exact configuration and are part of archive identity.

A redaction-policy change is incompatible with an existing archive generation. It MUST require a clean rebuild under a new archive identity/destination/state, or separately reviewed offline re-sanitisation for history that no longer exists in Cloud Logging. New differently redacted entries MUST NOT simply be merged into old daily files.

## Deduplication identity

Overlapping reads and safe reruns are expected.

When `insertId` is present, identity MUST be deterministic within the configured environment source and include the log identity; the implementation MAY additionally include monitored-resource identity to prevent collisions between copied or reused IDs.

When `insertId` is absent, the fallback MUST be a deterministic content identity derived from stable sanitised source fields and MUST exclude `receiveTimestamp` so redelivery does not create a new identity.

Timestamp alone MUST NOT be used as record identity.

## Incremental collection

Normal scheduled collection uses `receiveTimestamp` source windows.

The next successful interval begins from the previous successful receive-time watermark minus a configured overlap. The fixed run end is the current UTC time minus a settling delay.

The overlap protects against delayed delivery. Entries are still partitioned into the archive by their original event `timestamp`, falling back to `receiveTimestamp` only when the event timestamp is absent.

The initial incremental run MAY use a configured bounded lookback when no incremental checkpoint exists.

The normal schedule is daily via separate environment launchd jobs using `StartInterval=86400`:

```text
uk.co.ukaq.gcp-logging-archive.test
uk.co.ukaq.gcp-logging-archive.live
```

Both jobs MUST use the same generic runner semantics and environment contract. Each job resolves the corresponding ingest `.env`, validates `UK_AQ_ENV_NAME`, and then selects only that environment's runtime/configuration and credentials. The jobs MUST NOT share checkpoints or a mutable global authentication selection.

Cloud Logging remains the recent troubleshooting source; the Dropbox archive is primarily retained for historical service-usage, cost and configuration analysis. An operator MAY trigger the relevant launchd job or run incremental collection manually when a more current archive copy is wanted. This contract does not authorise changing other UK AQ schedules.

## Backfill and bounded range

Historical backfill and manual bounded-range operation use half-open event-time windows based on Cloud Logging `timestamp`.

Backfill MUST process bounded windows, use the same archive format and deduplication rules as incremental collection, and be resumable.

When no explicit historical start is supplied, backfill MUST discover the earliest retained matching source entry actually available. It MUST NOT claim to recover history that has expired from Cloud Logging.

Bounded range MUST use the same archive-manifest and redaction protections as incremental and backfill. It MUST NOT be an identity-bypass path.

## Pagination and source reads

The collector MUST consume all API pages for the selected bounded query.

Cloud Logging `entries.list` reads MUST be explicitly paced below the project-wide API quota rather than allowing sparse backfill windows to issue requests as fast as the client can return them. The implementation uses a 1.5-second minimum interval between page requests by default for each environment.

Quota exhaustion responses, including HTTP 429 / `ResourceExhausted`, MUST use bounded exponential retry/backoff. Retried reads MUST remain read-only and page-stable: an unsuccessful page request MUST NOT publish entries or advance a checkpoint. If the bounded retry period is exhausted, the run MUST fail while retaining the last successfully published checkpoint so the same operation can resume safely.

Read pacing and retry controls are operational configuration. Changing them does not by itself change source, archive or redaction identity.

The selected environment, configured project and exact filter form the source identity used by the archive manifest, checkpoints and run evidence. A changed environment/project/filter MUST fail against old identity evidence until the operator deliberately starts or rebuilds from an appropriate safe boundary.

## Daily publication

Incoming entries are grouped by UTC event date and merged with the corresponding existing daily archive.

For each affected day the collector MUST:

1. read the existing daily file, if present;
2. deduplicate existing plus incoming entries by deterministic identity;
3. write the complete replacement to a temporary file on the same local filesystem;
4. complete gzip finalisation and file sync;
5. atomically replace the destination;
6. sync the containing directory where supported.

A failed write MUST NOT replace the existing good daily file with a partial file.

If some daily files have already been replaced and a later day fails, the source checkpoint MUST remain unadvanced. Repeating the source window MUST safely merge/deduplicate the already replaced days again.

## Checkpoints

Incremental and backfill use separate local checkpoint files.

Each checkpoint MUST bind to:

- the configured source identity;
- archive ID and resolved archive destination;
- redaction-policy identity;
- the applicable successful source watermark.

Checkpoint identity MUST be validated before creating the Cloud Logging client or retrieving entries.

The incremental checkpoint advances only after every affected daily file for the source window has been published successfully.

The backfill checkpoint advances only after the current bounded event-time window has been published successfully.

A checkpoint records source progress only. It is not proof that every retained archive file is independently valid.

Range mode does not require a progress checkpoint but remains protected by the archive manifest.

## Locking

Each environment collector invocation MUST use an exclusive local invocation lock within that environment's runtime state before source retrieval or archive mutation.

If another invocation already holds the lock, the new invocation MUST not wait and MUST not retrieve or mutate archive data. It SHOULD leave bounded run evidence explaining the lock contention.

The lock protects incremental, backfill and range operations from concurrent writes to the same environment archive/checkpoints. TEST and LIVE MUST use distinct locks so one environment does not block the other. The operating-system lock, not the continued existence of the lock file, determines ownership.

## Run evidence and operator progress

Qualifying invocations follow the operator-execution contract.

Each invocation MUST have a distinct timestamped run directory, persistent human-readable log and bounded structured run report. Long phases MUST provide approximately 15-second elapsed-time heartbeats.

Run evidence SHOULD include source/window identity, overlap where applicable, entry/duplicate/new counts, affected dates/files, bytes written, resulting watermark, status, exit code and bounded error detail.

Run logs and reports are diagnostic evidence. They MUST NOT become archive, checkpoint or migration authority.

## Interruption and failure

A Cloud Logging read failure MUST NOT advance a checkpoint.

An archive publication failure MUST NOT advance the relevant checkpoint.

SIGTERM or operator interruption MUST leave accurate final run status when normal finalisation can execute, without advancing a checkpoint for an unpublished window.

A collector failure MUST remain isolated from all running UK AQ cloud workloads.

## Archive relocation

A path-only move is compatible only when the complete archive generation is moved intact with unchanged source scope, `archive_id` and redaction policy.

Before changing the effective archive path, the operator MUST stop scheduled
collection, complete and verify the archive move, preserve
identity/checkpoint evidence, then update the manifest and checkpoints to the
verified resolved destination. Existing progress MUST NOT be pointed at an
empty or partial destination.

For the September 2026 TEST layout correction from
`<archive_root>/GCP Logs/TEST` to `<archive_root>/TEST/GCP Logs`, the
configured `archive_root` remains unchanged. The complete archive directory
MUST be moved intact and verified first. Only the resolved
`archive.archive_path` in the manifest, backfill checkpoint and incremental
checkpoint may then change from the old `GCP Logs/TEST/raw` path to the new
`TEST/GCP Logs/raw` path. Source identity, `archive_id`, redaction identity
and both watermarks MUST remain unchanged.

## Local runtime migration

The deployed TEST archive generation MUST be migrated, not recreated. Moving TEST configuration, checkpoints/state, run evidence and operational logs into `/Users/mikehinford/uk-aq-gcp-logging-archive/TEST/` MUST preserve the existing TEST source identity, stable `archive_id`, redaction identity and incremental/backfill watermarks. The Dropbox archive remains at `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/TEST/GCP Logs/`.

The old TEST launchd job MUST be stopped while mutable state/configuration is moved. The new generic TEST runner MUST be structurally validated before deployment and then accepted through a real TEST incremental operation. Superseded runtime files MUST NOT be treated as active authority after acceptance.

## Credentials and security

TEST and LIVE MUST use separate environment-specific read-only Google authentication. Scheduled jobs MUST NOT depend on one mutable global Application Default Credentials selection that is switched between accounts.

Environment-specific credential material MUST be stored outside Git and Dropbox beneath the corresponding `/Users/mikehinford/uk-aq-gcp-logging-archive/<ENV>/credentials/` tree with restrictive local permissions. The generic runner MUST select only the credential material belonging to the validated environment.

Credentials, access tokens, private keys and full process environments MUST NOT be written into Git, the raw archive or run evidence.

The collector MUST NOT require a Cloud Logging sink, BigQuery retention sink, Cloud Storage retention sink or additional cloud compute merely to export the logs.

## Functional acceptance

Before deployment, validation is limited to structural viability and narrowly justified deterministic safety checks.

The environment-agnostic refactor is accepted through real TEST operation after installation. Acceptance includes confirming:

- `UK_AQ_ENV_NAME=TEST` resolves the TEST runtime/configuration and no LIVE material;
- expected structured and request logs are archived;
- pagination and overlapping reads do not leave gaps or amplify duplicates;
- late-arriving entries are merged into their event-date files;
- checkpoints advance only after successful publication;
- range replay is idempotent at the retained-identity level;
- manifest mismatches fail before source retrieval/archive mutation;
- Dropbox receives the raw files through normal filesystem synchronisation;
- known sensitive fields are absent;
- collector failures do not affect UK AQ cloud workloads.

LIVE activation is permitted only after the shared implementation has been accepted on TEST and the LIVE runtime has its own project/filter, archive identity, credentials and empty/new state as appropriate. Before enabling the unattended LIVE daily job, perform one deliberately bounded LIVE read/collection to verify the separate LIVE Google identity and source selection, then complete the required LIVE backfill/incremental operational acceptance. This targeted check exists to prevent a TEST/LIVE account or project mix-up; it is not a speculative pre-implementation test suite.
