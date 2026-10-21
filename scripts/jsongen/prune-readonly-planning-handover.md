# AURN complete original authentication: Stage 1

This implements the approved 21 October TEST Stage 1 contract at system-docs
commit `dc4e039a0132ddf6750cfbe2e03751e3285ed683`. The implementation starts from
Ops main `7a08b84e7d730208f9d8a1c44ab7dbe7684e8558` (merged PR #118).
Authoritative system documentation is unchanged.

## Behaviour and authority

Original AURN identity uses canonical pollutant syntax and physical/day validation
independently of the three-pollutant receipt identity. Syntax does not establish
authority: every original scope still needs the trusted original acceptance,
private PENDING bytes, original final manifest/exact-index closure, before-absence
and completed Core source/root/range/refresh/physical binding evidence. Schema-3
P/R/null and unavailable original-provider provenance retain their existing meanings.
Unsupported-scope contradictions invalidate the entire event.

The read-only consumer now stops before receipt construction. It returns
`authenticated_read_only` only after complete authentication and validated
in-memory original/selected/unsupported coverage. `receipt_eligible`,
`handover_complete` and `publication_eligible` stay false. Descriptor, bundle and
receipt retention and control registration stay `not_attempted`.

The fixed selection is `pm25`, `pm10`, `no2`. Every original scope is represented
once with source content/status and physical/binding authority. The selected and
unsupported sets partition the original set exactly. Versioned domain-separated
hashes cover original, selected, unsupported and selected partition-group evidence.
Original coverage excludes the policy-dependent disposition. Repeated authority
references use a deduplicated table. No observation values or metadata bodies are
included in the report. A zero-selected event returns `no_selected_scopes`, with
zero partitions and no synthetic empty receipt.

Selected partition preview uses the existing whole-scope encoding and protective
caps. Its gzip/JSON sizes are actual in-memory encodings, not measured network
traffic. Compression identities are deterministic for the installed runtime;
cross-runtime durable byte compatibility remains a Stage 2 decision. No selected
artifact is registered in the legacy receipt artifact capability map.

Legacy schema-2 construction still calls the complete-source eligibility guard
before any bundle/receipt retention. A complete unsupported source cannot be
registered as a selected subset. Receipt schemas 1/2, control schema 1,
currentness authority and the disabled publication selector are unchanged.

## Workflow and resources

The manual read-only workflow retains the ten-minute job guard and five-second
termination grace, and changes its external Node timeout from 90 to 150 seconds.
The internal handover budget stays 120 seconds / 192 MiB. Original 1,024 scopes,
100,000 rows and evidence-bundle bounds are unchanged; receipt previews keep
128 scopes, 32 references and existing record/gzip/JSON bounds.

The CLI and workflow validate the completed bounded read-only report. A nonempty
discovered page must have a successful result matching every discovered event.
Zero discovered events, incomplete processing, contradictory counts/digests,
resource exhaustion, unexpected errors and claimed writes remain non-success.
Discovery coverage remains incomplete/replay-required even when that page's
event authentication succeeds. Zero exit alone cannot satisfy workflow success.

Measurements report authentication/processing elapsed time, CPU user/system time,
sampled heap high-water and process-lifetime RSS high-water. Heap is sampled at
authority stages, budget checks and a 25 ms interval; it is a lower bound on true
peak heap, not an enforced heap cap. RSS includes earlier process allocations and
is not event-attributed. These measurements cover event reading/authentication
and planning; CLI report serialization is excluded. Actual private R2 response
body bytes and GET attempts/responses are distinct from charged byte counters;
failed/interrupted transport is explicitly incomplete, with protocol overhead
unmeasured. Coverage hashing charges its processed rows and descriptor preview
bytes to the same operation budget.

All original metadata is read from the retained bundle, not thousands of new
object GETs. Unsupported observations are neither copied into receipt bundles nor
retained as new derived objects. Frozen verified rows are shared inside one
invocation. No persistent verifier certificate/cache is introduced.

## Files and original archives

Active changes:

- `prune-original-identity.mjs`: original identity/key/digest boundary.
- `prune-original-authority.mjs`: complete original before/binding checks and
  direct validated physical-key lookup instead of repeated identity scans.
- `scope-authority.mjs`: shared physical digest projection; currentness validation
  and supported digest meaning stay unchanged.
- `prune-consumer-authentication.mjs`: complete original authentication and
  original evidence-bundle reference in the private proof token.
- `prune-pending-verification.mjs`: frozen verified-row iteration.
- `prune-consumer-partitions.mjs`: read-only selected plan and preserved legacy
  complete-event receipt boundary.
- `prune-coverage-plan.mjs`: in-memory evidence-bound coverage and validation.
- `prune-consumer-measurements.mjs`, `prune-consumer-outcome.mjs`: safe measurements
  and shared read-only outcome validation.
- `prune-consumer.mjs`, `inputs.mjs`: read-only orchestration and transfer counters.
- `.github/workflows/uk_aq_jsongen_prune_consumer_readonly.yml`: timeout and bounded
  outcome/success handling.
- Existing consumer fixture/check plus a focused read-only planning check.

New exact originals are under `archive/2026-10-21/`, preserving the relative
paths of `inputs.mjs`, `scope-authority.mjs`, `prune-original-authority.mjs`,
`prune-pending-verification.mjs`, `prune-consumer-partitions.mjs`, and the workflow.
Existing same-day archives for authentication and consumer are reused; their
immediate pre-change originals remain in the base commit above. New modules,
documentation and tests receive no code-style archive copies.

## Validation and remaining acceptance

Local Node v24.19.0 structural checks (workflow continues to use Node 20):

- Seven focused in-memory checks pass: 37 original pollutants with selected
  coverage/deterministic replay and no writes; unsupported binding corruption;
  no-selected scopes; legacy supported schema-2 group; 128-scope partitioning;
  result/page validation; and resource exhaustion/supported digest compatibility.
- Existing consumer file: 3 pass / 6 fail, identical failing cases before/after.
  Failures use stale fixture target or operation-specific credential configuration.
- Existing Stage 2 file: 27 pass / 12 fail on both base and implementation, with
  identical failing names. Failures involve fixture target/credential admission,
  environment configuration and invalid legacy references. No new failures.
- Active changed/new JavaScript syntax, embedded workflow JavaScript/shell, YAML
  parsing and `git diff --check` pass. No broad suite or private service was run.

These checks are synthetic structural evidence, not an authenticated replay of
the actual private event. The exact retained 15 October event is structurally
expected to authenticate, with all 37 pollutants / 940 scopes / 22,540 rows.
The reported 10,382 selected / 12,158 unsupported rows must be independently
confirmed. Selected scope counts, real runtime, heap behaviour and report size
remain unproven until separate operational acceptance. Scope usage is already
940/1,024; no capacity increase is included.

After separate merge/deployment and explicit operational authorization, use the
existing read-only workflow with `window_start_utc=2026-10-21T14:53:00.000Z`,
`window_end_utc=2026-10-21T14:55:00.000Z`, `discovery_mode=resweep`; its limit is one.
Inspect complete source/binding and selected/unsupported proofs, deterministic
digests, preview/partition sizes and measurements. There must be no writes.
Do not rerun Prune or recreate consumed original evidence.

Stage 2 remains unimplemented: no descriptor v1 persistence, receipt v3, control
v2, reconciliation v4, selected retention/CAS, publisher, dispatch or chart work.
Rollback is a code/workflow revert; retained originals remain unchanged. Older
code will reject the unsupported complete event again. No data rollback applies.

System-doc owner handover after review: record this as merged code only, retaining
the separate real read-only acceptance gate and all Stage 2/currentness/publication
blocks. No database migration, variable, credential, signer or writer change is
required. No deployment, workflow dispatch, scheduler change or LIVE action occurred.
