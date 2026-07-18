# 2026-07-18 SOS upstream failure handling

## Status

Implementation plan for the UK AQ TEST system.

- Plan repository: `TEST-uk-aq/uk-aq-ops`
- Implementation repository: `TEST-uk-aq/uk-aq-ingest`
- Scope: TEST only
- Plan date: 18 July 2026
- Recommended Codex configuration: Codex with High reasoning
- Default permission level: Level 1 code changes, followed by operator-run TEST deployment and validation

## Objective

Make two focused reliability and observability improvements to the UK-AIR SOS connector:

1. When the initial UK-AIR SOS upstream probe receives no HTTP response because it times out or is aborted by the connector runtime deadline, return HTTP `503 Service Unavailable` from the connector instead of the current generic HTTP `500`.
2. When the connector reaches its overall runtime deadline while several timeseries requests are still in flight, record one consolidated run-level runtime-budget error instead of creating a separate `error_logs` row and Dropbox error JSON file for every affected timeseries.

The work must preserve normal SOS polling, retries, partial-run handling, observation writes, connector run tracking, Dropbox connector logs, raw-response capture and all genuine per-timeseries error reporting.

## Background and current behaviour

The active SOS edge function currently:

- uses a total runtime budget, normally 120 seconds;
- applies a per-request timeout of up to 30 seconds;
- probes the UK-AIR SOS `/services` endpoint before polling timeseries;
- returns the actual upstream HTTP status when one is available;
- has no structured distinction between an HTTP failure, a request timeout, an abort caused by the overall runtime deadline and an unexpected local error;
- therefore treats an aborted probe with no HTTP status as HTTP `500`;
- catches every timeseries failure individually and writes an `error_logs` row, plus a mirrored Dropbox error JSON file where configured;
- marks the final response as partial with `stopped_reason: runtime_budget_exceeded` when the pool reports that the runtime budget was reached.

During the 18 July 2026 UK-AIR slowdown, multiple concurrent timeseries requests reached the same overall runtime deadline. The connector correctly stopped the run, but produced repeated timeseries-level error records for one run-level condition.

## Authoritative reading and operating constraints

Before changing code, Codex must read, in this order:

1. `TEST-uk-aq/uk-aq-ops/AGENTS.md`
2. `TEST-uk-aq/uk-aq-ops/AGENTS_BASE.md`, if referenced by `AGENTS.md`
3. `TEST-uk-aq/uk-aq-ingest/AGENTS.md`
4. `TEST-uk-aq/uk-aq-ingest/AGENTS_BASE.md`
5. the current `system_docs/README.md` and documentation contract in both repositories where present
6. the current system-document ownership entry for the SOS connector
7. the current SOS connector overview and ingest-flow documents
8. the current edge-function, Cloud Run, connector-run and error-logging documents relevant to SOS
9. the active SOS edge function and its deployment and wrapper path
10. directly relevant existing tests or helper checks only

Use `grep`, not `rg`, for repository discovery as required by the repository instructions.

Codex must treat every `system_docs/` directory as read-only. It must not create, edit, move, rename or delete files under `system_docs/`. After implementation and real TEST validation, Codex must provide a documentation handover for ChatGPT in Chat mode.

Follow the TEST System Validation Policy:

- perform only the smallest structural checks before deployment;
- do not create or run a broad test suite;
- do not call the real UK-AIR service merely to exercise artificial failure cases before deployment;
- perform normal functional validation after deployment through real TEST operation;
- do not touch LIVE repositories, services, databases, schedules or secrets.

If current code or an authoritative system document conflicts with this plan, stop and report the conflict rather than silently changing established behaviour.

## Existing behaviour that must not change

This is an error-classification and error-consolidation change only. Preserve the following:

- The connector remains named `SOS`, and the upstream service remains `UK-AIR SOS`.
- The active upstream base URL and `/services` probe remain unchanged.
- The initial probe continues to prevent a full timeseries fan-out when UK-AIR is unavailable.
- Existing retryable HTTP statuses and retry/backoff behaviour remain unchanged unless a directly related defect is found and reported.
- A real upstream HTTP response continues to be represented truthfully by its actual status.
- `upstream_status` must remain `null` when UK-AIR did not return an HTTP response. Do not claim that UK-AIR itself returned 503.
- The connector response may use a synthetic HTTP 503 to communicate that the dependency was unavailable.
- Unknown local errors, invalid configuration and programming errors must continue to return HTTP 500 rather than being reclassified as upstream unavailability.
- Genuine per-timeseries HTTP, parsing, transformation, observation-write, last-value, checkpoint and database failures remain individually logged.
- A normal per-request timeout that occurs while substantial overall runtime remains must not be hidden as a run-level runtime-budget stop.
- Observation upserts completed before the deadline remain committed and reported.
- The existing partial response and `stopped_reason: runtime_budget_exceeded` contract remains available to the Cloud Run wrapper and connector-run tracking.
- The connector's normal Dropbox log and raw-response archive behaviour remain unchanged.
- Error records already stored in Supabase or Dropbox are not deleted or rewritten.
- No schema migration and no new environment variable are expected.
- No polling cadence, concurrency, request timeout, total runtime budget or batch-size change is part of this plan.

## Design options

### Option A: match current error messages

Detect strings such as `The signal has been aborted` and `Runtime budget exhausted before UK-AIR SOS fetch completed`, then map or suppress them at their catch sites.

Pros:

- smallest initial code diff;
- no new error class or structured metadata;
- no database or configuration change;
- no change to upstream request count;
- reduced `error_logs` and Dropbox error-file growth during deadline fan-out.

Cons:

- brittle dependency on exact runtime and message wording;
- risks conflating a per-request timeout with the overall run deadline;
- difficult to extend safely when Deno or fetch error wording changes;
- makes it easier for unknown errors to be misclassified as 503;
- provides weak structured evidence in connector-run summaries.

Egress impact:

- upstream request behaviour is unchanged;
- Supabase billable endpoint egress change is negligible;
- fewer error-log insert and patch responses may reduce a very small amount of API traffic;
- fewer Dropbox error-file uploads reduce Dropbox API traffic.

Database-size impact:

- reduces duplicate `error_logs` rows during a runtime-deadline event;
- no schema change;
- no effect during healthy operation.

### Option B: add structured SOS fetch-failure classification

Introduce a small typed or structured failure representation at the SOS fetch boundary, then use it consistently in the probe and timeseries pool.

Suggested failure kinds are:

- `http`
- `request_timeout`
- `runtime_deadline`
- `network`
- `unknown`

The exact names may follow existing repository conventions, but the implementation must distinguish at least:

1. an actual upstream HTTP response;
2. an ordinary request timeout;
3. an abort or refusal to start because the overall connector deadline is exhausted;
4. an unexpected local error.

Pros:

- makes the 503 decision explicit and stable;
- keeps `upstream_status` truthful while allowing a synthetic connector HTTP status;
- reliably consolidates only overall-deadline failures;
- preserves individual reporting for ordinary request timeouts and all other timeseries errors;
- improves response payloads, logs and future incident diagnosis;
- does not require a schema, environment or scheduling change;
- no additional upstream requests;
- substantially reduces duplicate error rows and Dropbox error files during a deadline fan-out.

Cons:

- slightly larger focused code change;
- requires careful integration with retry classification and existing HTTP-status extraction;
- needs one narrowly targeted deterministic helper check because a real upstream timeout cannot be reliably reproduced on demand.

Egress impact:

- no increase in UK-AIR request count, polling cadence or response size during healthy runs;
- no material change to Supabase billable endpoint egress;
- fewer error-log writes and Dropbox error uploads during runtime-deadline events;
- any added response fields are tiny and occur only in connector run responses and logs.

Database-size impact:

- one run-level `error_logs` row replaces many deadline-derived timeseries rows;
- no schema change and no data migration;
- genuine per-timeseries errors continue to consume the same storage as before;
- historical duplicate rows remain untouched.

### Option C: add a persistent circuit breaker

Persist upstream health state and suppress later scheduled runs for a period after repeated probe failures.

Pros:

- could reduce requests during a prolonged upstream outage;
- could further reduce repeated run-level errors.

Cons:

- changes scheduling and recovery semantics well beyond the two requested improvements;
- risks delaying recovery when UK-AIR becomes available again;
- requires new state, configuration and operational documentation;
- introduces more database growth and more complex rollback;
- not justified by the incident because the existing probe already prevents timeseries fan-out.

Egress impact:

- may reduce upstream requests during long outages;
- adds state reads and writes;
- could delay collection and later require recovery traffic.

Database-size impact:

- requires persistent health or circuit state;
- increases complexity and storage for little benefit in this scope.

## Recommendation

Implement Option B.

Structured classification is the smallest safe design that can meet both objectives without hiding real timeseries faults. It has no meaningful healthy-run egress cost, reduces error-log and Dropbox growth during outages, requires no schema change and avoids the fragility of matching error-message strings.

Do not implement a circuit breaker in this work.

## Target behaviour

### 1. Upstream probe timeout response

When the `/services` probe fails:

- If UK-AIR returned an HTTP status, retain that status and existing handling.
- If the fetch failed because its request timeout elapsed, classify it as `request_timeout` and return connector HTTP 503.
- If it failed because the overall runtime deadline was exhausted, classify it as `runtime_deadline` and return connector HTTP 503.
- If it failed with another recognised network-unavailable condition, Codex must report whether it is safe to include it in the 503 classification. Do not silently broaden the scope.
- If it is an unknown local error, return HTTP 500.

The response and error context should distinguish:

- `upstream_status`: actual upstream HTTP status or `null`;
- `upstream_failure_kind`: structured classification;
- `connector_http_status`: the HTTP status returned by the connector, where useful;
- `upstream_error`: bounded diagnostic message.

The existing `status: upstream_unavailable`, `series_polled: 0` and `observations_upserted: 0` behaviour remains.

### 2. Runtime-deadline consolidation

When timeseries workers fail because the shared connector runtime deadline has been reached:

- stop scheduling new work through the existing pool stop mechanism;
- allow already completed observation work to remain reported normally;
- increment a run-local `runtime_deadline_failure_count` or equivalent;
- retain a bounded sample of affected timeseries IDs or refs, for example no more than 10;
- do not append one generic `upsert_failed` entry to the response for each deadline-derived failure;
- do not call the individual `errorLogger.logError` path for each deadline-derived failure;
- do not create one Dropbox error JSON file per affected timeseries;
- after the pool settles, write one run-level error record containing the count, sample, configured runtime, series completed and relevant run context;
- include one compact runtime-budget error token or object in the response summary;
- ensure `partial` is true and `stopped_reason` remains `runtime_budget_exceeded` whenever any overall-deadline failure was observed, even if the pool's existing Boolean does not capture every in-flight abort;
- keep the connector response status compatible with the current partial-run contract, normally HTTP 207 unless an existing harder failure takes precedence.

The consolidated error record must not set a `timeseries_id`, because it describes the whole connector run. Sample IDs belong in bounded context only.

### 3. Errors that remain individual

Continue the current individual error path for:

- an HTTP failure for one timeseries;
- a per-request timeout reached while the overall runtime deadline still has sufficient time remaining;
- invalid or unparseable SOS payloads;
- observations or last-value write failures;
- checkpoint and connector metadata update failures;
- unexpected code errors associated with one timeseries.

Do not use one failure to suppress unrelated genuine errors from the same run.

### 4. Logging and response payload

Keep existing fields for compatibility, and add only compact fields needed to explain the classification and consolidation. Candidate fields include:

- `upstream_failure_kind`
- `runtime_deadline_failure_count`
- `runtime_deadline_timeseries_sample`
- `individual_error_count`

Codex must inspect the Cloud Run wrapper and connector-run summary parser before finalising names. If the wrapper compacts or whitelists payload fields, update its allowed fields only where necessary so the new evidence is not silently discarded.

Avoid unbounded arrays, repeated stack traces or full URLs in response payloads and error context.

## Phased implementation

### Phase 0: repository and contract discovery

1. Start from the complete `TEST-uk-aq-ops` checkout as the cross-repository entry point.
2. Read the authoritative documents listed above.
3. Use `grep` to locate:
   - the active `ingest_sos` edge function;
   - `fetchJson`, retry classification and HTTP-status extraction;
   - the `/services` probe;
   - every SOS `errorLogger.logError` call;
   - the timeseries pool and runtime-stop logic;
   - response payload construction;
   - the Cloud Run wrapper's summary, partial and failure derivation;
   - connector-run persistence;
   - Dropbox error mirroring;
   - directly relevant existing tests or helper checks;
   - the authoritative SOS system-document ownership list.
4. Confirm the active deployment path and that no archive file is used at runtime.
5. Confirm the current HTTP and connector-run outcome for:
   - a probe HTTP 502;
   - a probe abort with no HTTP status;
   - a partial runtime-budget stop;
   - a genuine timeseries error.
6. Record the ownership map and preserved behaviours before editing.

Deliverable: concise implementation map, current contracts and exact files to change.

### Phase 1: define the structured failure boundary

1. Add the smallest local type, class or discriminated structure needed to carry:
   - failure kind;
   - actual HTTP status, when present;
   - retryability;
   - bounded message;
   - whether the timeout came from the request limit or the overall runtime deadline.
2. Keep the structure local to the SOS implementation unless an existing shared fetch-error type is already authoritative and suitable.
3. Preserve the existing retryable HTTP set.
4. Ensure retry logic can still identify aborts and retryable statuses without parsing display text.
5. Ensure a runtime-deadline failure does not start another retry when insufficient budget remains.
6. Ensure unknown exceptions remain unknown and fail as HTTP 500 at the appropriate boundary.

Deliverable: structurally viable classification design with no external calls.

### Phase 2: implement probe 503 classification

1. Update the fetch path so request timeout and runtime-deadline aborts carry structured classification.
2. Extend the probe result to return the failure kind separately from actual upstream status.
3. Derive the connector HTTP status as follows:
   - actual upstream HTTP status when present, preserving current behaviour;
   - 503 for `request_timeout` and `runtime_deadline` with no upstream response;
   - 500 for unknown local errors.
4. Retain `upstream_status: null` when no HTTP response exists.
5. Add the failure kind to the normal log, error record and response payload.
6. Preserve the current single probe-failure error record and skip-poll behaviour.

Deliverable: timed-out or deadline-aborted probes are accurately reported as dependency unavailability without pretending UK-AIR returned 503.

### Phase 3: consolidate overall runtime-deadline timeseries failures

1. Add run-local counters for deadline-derived timeseries failures.
2. Add a small bounded sample of affected timeseries IDs or refs.
3. In the timeseries catch path, branch on structured failure kind:
   - aggregate `runtime_deadline` failures;
   - keep all other failures on the current individual path.
4. Ensure the shared stop condition prevents new work once the deadline is reached.
5. After the pool settles, calculate one authoritative `runtimeBudgetExceeded` result from:
   - the existing pool result;
   - the deadline-failure count;
   - the existing deadline check, if needed.
6. Emit one run-level warning and one `error_logs` record for the runtime-budget event.
7. Include count and bounded sample in the consolidated context.
8. Keep response `partial` and `stopped_reason` compatible with current Cloud Run summary handling.
9. Do not discard individual errors that occurred earlier in the same run.
10. Ensure response status precedence remains correct for a hard gateway failure, a partial run and an unexpected internal failure.

Deliverable: one runtime-budget event per connector run instead of one event per outstanding timeseries.

### Phase 4: wrapper and connector-run compatibility

1. Inspect the active Cloud Run wrapper and any payload compaction or whitelist logic.
2. Confirm that HTTP 503 from a timed-out probe is recorded as upstream unavailability rather than an internal connector defect.
3. Preserve existing connector-run status semantics unless current documentation clearly requires a more accurate status mapping.
4. Ensure the wrapper retains the compact new fields needed for incident diagnosis.
5. Confirm that a partial runtime-budget response remains partial and does not become a total failure solely because it contains one consolidated error.
6. Do not change scheduler retries, service timeouts or deployment resources in this phase.

Deliverable: edge function and wrapper agree on the new classification without changing polling operations.

### Phase 5: minimal pre-deployment validation

Follow the TEST policy. Do not run broad suites or make live external calls.

Run only:

1. formatting or parser checks for each changed TypeScript or configuration file;
2. `deno check` or the repository's equivalent smallest type check for the active changed entry point;
3. one narrowly targeted deterministic classification and aggregation check, using existing test infrastructure where possible.

The targeted check is genuinely justified because a UK-AIR timeout or exact overall-deadline fan-out cannot be reliably reproduced during a normal operator-run validation. It must remain small and cover only:

- probe `request_timeout` with no upstream status maps to connector HTTP 503;
- probe `runtime_deadline` with no upstream status maps to connector HTTP 503;
- unknown local failure maps to HTTP 500;
- actual upstream HTTP status remains truthful;
- multiple `runtime_deadline` timeseries failures produce one consolidated event and count;
- an ordinary timeseries request timeout or HTTP failure remains individual.

Do not add fixtures for SOS payload parsing, observations or unrelated connectors. Do not run the full repository suite.

Deliverable: structural viability and the narrow error-routing boundary are confirmed.

### Phase 6: operator deployment to TEST

Codex must stop before external operations and provide exact operator commands for:

1. reviewing the changed files;
2. deploying only the affected TEST SOS edge function and any affected TEST Cloud Run wrapper through the existing authoritative workflow;
3. confirming the deployed revision and function version;
4. invoking one normal TEST SOS run through the existing scheduler or dispatch path;
5. locating the connector run, edge log, Cloud Run log, Supabase `error_logs` evidence and Dropbox connector log;
6. rolling back to the previous TEST revision.

Do not deploy, change secrets or run cloud commands without explicit Level 4 permission.

Deliverable: exact manual TEST deployment and rollback instructions, not executed by Codex.

### Phase 7: real TEST operational validation

After deployment, use real TEST operation rather than a broad simulated test programme.

For one normal healthy SOS run, confirm:

1. the upstream probe succeeds;
2. timeseries polling and observation writes remain normal;
3. connector-run status and counts remain compatible;
4. no new deadline error is emitted on a healthy run;
5. normal Dropbox log and raw capture remain available;
6. no unexpected change appears in Supabase endpoint egress or write volume.

For the next genuine upstream timeout or runtime-budget event, confirm from actual evidence:

1. a timed-out or deadline-aborted probe returns connector HTTP 503;
2. `upstream_status` remains null where UK-AIR returned no HTTP response;
3. `upstream_failure_kind` identifies the timeout class;
4. no timeseries fan-out occurs after a failed probe;
5. an overall runtime-budget fan-out creates one run-level error row and at most one mirrored Dropbox error JSON file;
6. the consolidated count matches the number of deadline-derived timeseries failures;
7. genuine non-deadline timeseries failures remain separate;
8. the connector run remains partial with `stopped_reason: runtime_budget_exceeded` where appropriate;
9. observations completed before the deadline remain written and counted.

Do not force a production-like outage by changing the persistent SOS base URL. If immediate failure-path proof is operationally required, present a separate, reversible TEST-only one-off invocation option for the operator and do not change scheduled configuration.

Deliverable: healthy-run evidence immediately, plus real incident evidence when the relevant condition naturally occurs or through an explicitly authorised one-off TEST invocation.

### Phase 8: ChatGPT system-document update

After implementation and real TEST validation, Codex must provide a concise handover containing:

- authoritative documents reviewed;
- exact files changed;
- structured failure kinds implemented;
- probe HTTP-status mapping;
- runtime-deadline aggregation behaviour;
- response and log fields added or changed;
- wrapper and connector-run compatibility findings;
- structural checks run;
- deployment commands used by the operator;
- actual TEST results;
- egress and database-size observations;
- rollback information;
- any unresolved limitation or follow-on work.

ChatGPT in Chat mode will then inspect the implemented code and TEST evidence and update the current authoritative documents identified by the `system_docs` ownership index. At minimum, assess the current successors of:

- the SOS connector overview;
- the SOS ingest flow;
- edge-function behaviour;
- Cloud Run dispatch and connector-run status handling;
- error logging and Dropbox mirroring, where the consolidation changes documented behaviour.

Codex must not edit these system documents itself.

Deliverable: authoritative system documentation matches the implemented and validated TEST behaviour.

## Expected implementation areas

Codex must confirm exact ownership before editing. Likely areas include:

- `TEST-uk-aq/uk-aq-ingest/supabase/functions/ingest_sos/index.ts`
- the active TEST UK-AIR SOS Cloud Run wrapper, only if payload handling or status interpretation needs adjustment
- the active deployment workflow, only if an implementation-path change makes it necessary
- one directly relevant existing SOS test or a new minimal helper check only where justified above

Do not modify:

- unrelated connectors;
- pollutant mappings;
- station or timeseries discovery;
- SOS historical archive ingestion;
- observation schemas;
- polling schedules;
- runtime limits or concurrency;
- LIVE code or configuration;
- `system_docs/` through Codex.

## Configuration, schema and data impact

Expected configuration impact:

- no new environment variables;
- no changes to `env-vars-master.csv`;
- no changes to GitHub environment target maps;
- no secret changes;
- no scheduler changes.

Expected schema impact:

- no migration;
- no table or RPC change;
- no schema-repository edit.

Expected data impact:

- no observation data is rewritten or deleted;
- existing error rows remain unchanged;
- future overall-runtime-deadline incidents create fewer `error_logs` rows and fewer Dropbox error files;
- genuine timeseries errors remain fully represented.

## Egress and cost assessment

Healthy operation:

- UK-AIR request count: unchanged;
- Supabase endpoint response egress: effectively unchanged;
- Supabase observation upload volume: unchanged;
- Cloud Run invocation count and runtime: unchanged;
- Dropbox uploads: unchanged unless an error occurs.

Runtime-deadline incident:

- UK-AIR request count: unchanged by this plan;
- Supabase billable endpoint egress: only a negligible reduction from fewer minimal error-log responses;
- Supabase upload/write traffic: reduced because many error inserts and Dropbox-path patches become one;
- Dropbox API calls and stored JSON error files: reduced from one per affected timeseries to one per run-level deadline event;
- database growth: reduced in proportion to the number of suppressed duplicate deadline rows.

Do not describe the reduced error-write payload as a major Supabase egress saving. Its main benefits are cleaner incident evidence, fewer writes and slower error-log growth.

## Rollback

Rollback must remain simple:

1. redeploy the previous TEST SOS edge-function revision and previous wrapper revision if it changed;
2. revert the focused implementation commit if required;
3. do not delete connector runs, error logs, Dropbox logs or observations created while the change was active;
4. no schema or environment rollback should be necessary;
5. confirm one normal SOS run after rollback.

If the implementation adds a local helper type or module, ensure reverting the consumer and helper occurs together.

## Acceptance criteria

The work is complete when all of the following are true:

- A probe timeout with no upstream HTTP response causes the connector to return HTTP 503.
- An overall-runtime-deadline probe abort with no upstream HTTP response causes the connector to return HTTP 503.
- `upstream_status` remains null when UK-AIR did not return a response.
- Unknown local failures continue to return HTTP 500.
- Actual upstream HTTP statuses continue to be reported truthfully.
- The failed probe still prevents timeseries polling.
- Multiple timeseries failures caused by one overall runtime deadline produce one consolidated run-level error record.
- The consolidated record contains a count and a bounded sample rather than unbounded per-timeseries detail.
- Deadline-derived failures do not each create a Dropbox error JSON file.
- Ordinary per-request timeouts and all genuine timeseries failures remain individually logged.
- Partial-run and `stopped_reason: runtime_budget_exceeded` behaviour remains compatible with the Cloud Run wrapper and connector-run records.
- Observations completed before the deadline remain committed and counted.
- Healthy SOS polling behaviour, retries, concurrency, runtime budget and cadence are unchanged.
- No schema, environment or scheduler change was introduced.
- Only minimal structural validation occurred before deployment.
- Real functional validation occurred on the TEST system.
- Codex supplied a complete ChatGPT documentation handover.
- Authoritative system documentation was updated by ChatGPT after implementation and validation.
