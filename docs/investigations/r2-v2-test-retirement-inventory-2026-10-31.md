# TEST R2 observation-history v2 retirement inventory — 31 October 2026

## Executive recommendation

**Do not authorise deletion.** The proposed immutable deletion manifest is empty: **0 objects, 0 bytes (0 MiB, 0 GiB), SHA-256: not applicable**. This is a TEST-only, read-only repository investigation; it did not perform an R2 LIST, HEAD or GET, Dropbox read, operational workflow, dry run, or any mutation. The previously reported approximately 245.141 MiB under `history/v2/` plus 19.869 MiB under `history/_index_v2/` is therefore an unverified historical observation, not an inventory or approval boundary.

The shortest route to a decision is one authenticated, paginated TEST-only LIST capture for the two candidate prefixes, followed by a read-only Dropbox checkpoint/content reconciliation and confirmation of the deployed legacy AQI history Worker configuration. Until then every candidate object is **C — further evidence required**, except objects shown by that capture to be used by the deployed legacy AQI Worker, which are **B — retain**. No broad-prefix or substring deletion is appropriate.

The prior LIVE assessment is useful methodology only. Its LIVE bucket, backup state, runs, approvals and conclusions are not evidence for TEST. The staging assessment's implementation conclusion *has* been checked against current TEST source: the Prune staging configuration and cleanup references are absent. That removes one former reason to retain staging, but does not prove that any historical staging object is unowned, backed up or deletable.

## Scope, authority and environment identity

The required sibling `TEST-uk-aq/uk-aq-system-docs` checkout is not available in this workspace (no `SYSTEM_OVERVIEW.md` was found). Per repository policy, this report does not substitute copied/legacy contracts for that missing authority. A reviewer must route the final decision through the then-current system-docs overview, `r2_history/README.md`, and `backup_and_recovery/README.md` before approval.

Repository evidence identifies the intended TEST bucket as `uk-aq-history-cic-test`: the tracked TEST variable export records it with the TEST Cloudflare endpoint, and the protected reconciliation workflow rejects a different bucket. This is configuration/operational evidence, **not** proof that this Cloud environment could authenticate to it today. No LIVE endpoint or bucket was used or considered as a fallback.

| Boundary | Result |
|---|---|
| Candidate bucket | `uk-aq-history-cic-test` (verified from tracked TEST evidence) |
| Candidate namespaces | `history/v2/`, `history/_index_v2/` |
| Direct R2 inspection | **Not available in this Codex Cloud session; 0 prefixes listed** |
| Direct Dropbox inspection | **Not available; 0 paths/checkpoints listed** |
| Candidate object count/bytes/identities | **Unknown, not zero** |
| A / eligible now | **0 / 0 bytes** |
| B / retain now | No per-object inventory; potential deployed legacy-AQI subset cannot be enumerated |
| C / further evidence | All unenumerated candidate objects |
| v3 / shared namespaces | Dependency-only review; explicitly outside deletion scope |

## Current source and dependency findings

### Generation-aware history operation

The shared generation resolver defines complete v2 and v3 physical domains: observations, run manifests, indexes, compact latest summary, individual bindings, Core, inventory roots, checkpoint roots and binding packs. A normal selected-v3 consumer consequently resolves only `history/v3/` and `history/_index_v3/`; it does not fall back to v2. Current v3 backup likewise validates all selected-generation prefixes and state before syncing.

That is strong evidence that selected-v3 observation readers, v3 publication and finalisation, Core generation, selected index construction/repair, Integrity/SOS-light generation paths and normal v3 Dropbox backup do not need old canonical v2 objects. It is **not** proof that the old objects have a complete historical recovery copy or that an installed/manual v2 tool is gone. The backup workflow still exposes an explicit non-default `v2` generation option; it must not be run as evidence gathering because it would write inventory/checkpoint/Dropbox state.

### Legacy and JSONgen boundaries

The active AQI-history Worker deployment workflow remains explicitly v1/v2 only and injects v2 AQI, v2 binding and `_index_v2` prefixes. Its actual deployed version/configuration was not available here. Therefore an inventory match beneath `history/v2/aqilevels/`, `history/_index_v2/aqilevels_hourly_data_timeseries/`, or `history/_index_v2/timeseries_binding/` must be retained until the operator proves the deployed Worker no longer reads it or supplies a separately accepted migration/retirement disposition.

JSONgen's checked source is explicit canonical **v3** and requires a separate canonical bucket. The ordinary Prune workflow includes a JSONgen handover only when enabled, while the scheduler has Prune Daily disabled. No Prune, JSONgen, migration, restore, Integrity, backup or dry-run job was run. Thus the accumulated IngestDB observations and current v3 canonical observations remain undisturbed. This source tracing does not establish a future JSONgen contract for v2 recovery: retain any object whose proposed retirement has not been reconciled with the planned test's canonical-v3 source/coverage evidence.

### Related namespaces inspected as dependencies, not candidates

* `history/v3/` and `history/_index_v3/` are the selected v3 canonical/index domains and are excluded from the proposal.
* `history/_backup_packs_v1/` is a shared pack domain, with v3 packs isolated below `timeseries_binding/generation=v3`; it is excluded.
* `_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v2/` and `...=v3/` are shared operational recovery evidence, not objects under either proposed candidate prefix. Their existence/currentness is unknown.
* `history/v1/`, `history/_index/`, and prototype material were not inventoried and are outside this v2 retirement decision.

## Candidate classification and accounting

No remote listing means a per-object table, sizes, LastModified timestamps, ETags and reconciled totals cannot honestly be supplied. The following classification is deliberately by *prospective functional domain*; the operator capture below must turn it into exact per-key rows and must classify unexpected keys as C rather than silently absorbing them.

| Candidate domain (within the two prefixes) | Producer / consumer finding | Class now | Required evidence before A |
|---|---|---|---|
| `history/v2/observations/`, manifests and `_manifests/` | Former canonical source; selected v3 has no fallback | C | Complete list; retained v2 recovery copy and explicit v2 rollback/recovery disposition |
| `history/v2/_ops/observations/runs/` and other operational records | Former run evidence; backup coverage cannot be inferred from canonical coverage | C | Key-level retention/contract and Dropbox reconciliation |
| `history/v2/_ops/observations/staging/` | Current TEST Prune source no longer has staging cleanup/producer | C | Complete list; installed/manual writer and recovery/hold disposition |
| `history/v2/core/` | Selected v3 Core is separate; old Core may be historical evidence | C | Current retained-copy and old-generation recovery decision |
| `history/v2/aqilevels/`, debug and other v2 keys | Legacy AQI deployment can be configured to v2 | C (B if deployed reader confirmed) | Deployed Worker/configuration and owner disposition |
| `history/_index_v2/observations_timeseries/` | Derived v2 index; selected v3 does not fall back | C | Rebuild proof plus legacy/manual-reader closure |
| Exact `history/_index_v2/observations_timeseries_latest.json` | Compact v2 latest summary; distinct backup/recovery payload | C | Current Dropbox object/checkpoint identity |
| `history/_index_v2/timeseries_binding/` and manifests/source state | Legacy AQI workflow injects this prefix; v3 has separate bindings | C (B if deployed reader confirmed) | Deployed-reader closure and historical recovery proof |
| `history/_index_v2/backup_inventory_v2/` and flat inventory if present | Historical inventory/reconciliation evidence | C | Preserve/export immutable evidence and reconcile referenced shards |
| AQI indexes and unexpected `_index_v2/` keys | Ownership unknown | C | Per-key functional owner, producer/consumer, recovery disposition |

**Reconciliation rule after capture:** `candidate_total = A + B + C` must use disjoint per-key rows, exact integer bytes, then report `MiB = bytes / 2^20` and `GiB = bytes / 2^30`. An absent prefix is a successful complete listing with zero rows; an access/listing/page/parse failure is an incomplete inventory and all totals remain unknown.

## Dropbox coverage and recovery assessment

The backup workflow derives its destination from the private TEST variables `UK_AQ_DROPBOX_ROOT` and `UK_AQ_R2_HISTORY_DROPBOX_DIR`, then passes the resulting path to `uk_aq_dropbox`. Those values are intentionally not present in tracked source, so this report does not guess a Dropbox path or reuse LIVE paths. The workflow's normal selected-generation backup includes canonical observations and manifests, run manifests, Core, bindings/pack authority and the compact latest summary; bulk derived observation-timeseries indexes are not thereby established as retained bytes and may be reconstructable.

No authenticated Dropbox list/read or checkpoint-root GET occurred. Historical successful reports, if later located, demonstrate a past process result, not that bytes, referenced shards and checkpoint roots still exist today. Before an A decision, obtain a private capture showing: the v2 checkpoint root and all referenced shards; matching source/processed roots; canonical units, runs, Core, compact latest and the applicable binding representation; and the current retention/cleanup policy proving that the required historical set will not be removed. Reconstructible derived indexes still require an accepted rebuild path; that is not a complete rollback.

After retirement, current v3 operation should continue from v3 canonical, v3 indexes/Core/bindings and their selected-generation backup. Historical v2 observations could be recovered only to the extent of verified retained v2 backup/checkpoints; derived indexes may be rebuilt only with accepted inputs; historical Core/bindings require their own verified payloads. An older v2 runtime and a complete lossless rollback to v2 are **not** established by this report. Resolve any TEST v2 rollback closure/retention record before deletion; do not create or backdate one.

## Read-only evidence collection (private operator evidence)

Run these only in an authorised TEST operator environment with existing read-only credentials. Do not put credentials, endpoint secrets or the full listing in GitHub. Store raw JSON and the rendered candidate manifest in a private evidence location with restricted access.

1. Confirm `CFLARE_R2_BUCKET=uk-aq-history-cic-test` exactly; stop on any other or blank value. With the existing R2 credentials, run this complete, paginated LIST-only capture (it makes no HEAD, GET, PUT, COPY or DELETE):

```bash
umask 077
test "${CFLARE_R2_BUCKET:?}" = "uk-aq-history-cic-test"
node --input-type=module <<'NODE' > private-test-v2-r2-listing.json
import { r2ListObjectsV2 } from './workers/shared/r2_sigv4.mjs';
const r2 = { endpoint: process.env.CFLARE_R2_ENDPOINT, region: process.env.CFLARE_R2_REGION || 'auto',
  bucket: process.env.CFLARE_R2_BUCKET, access_key_id: process.env.CFLARE_R2_ACCESS_KEY_ID,
  secret_access_key: process.env.CFLARE_R2_SECRET_ACCESS_KEY };
if (!r2.endpoint || !r2.access_key_id || !r2.secret_access_key) throw new Error('missing authorised TEST R2 read credentials');
const prefixes = ['history/v2/', 'history/_index_v2/']; const captures = [];
for (const prefix of prefixes) { let token = null, pages = [], entries = [];
  do { const page = await r2ListObjectsV2({ r2, prefix, continuation_token: token, max_keys: 1000, require_valid_listing: true });
    pages.push({ entry_count: page.entries.length, is_truncated: page.is_truncated }); entries.push(...page.entries); token = page.next_token;
  } while (token); captures.push({ prefix, complete: true, pages, entries }); }
const all = captures.flatMap(x => x.entries); const bytes = all.reduce((n, x) => n + x.size, 0);
console.log(JSON.stringify({ captured_at_utc: new Date().toISOString(), bucket: r2.bucket, list_only: true,
  captures, totals: { object_count: all.length, bytes, mib: bytes / 2 ** 20, gib: bytes / 2 ** 30 } }, null, 2));
NODE
sha256sum private-test-v2-r2-listing.json
```

2. Review the JSON for two `complete:true` captures, page continuity and only keys beginning with their requested prefix. ListObjectsV2 supplies size, LastModified and ETag, so the private JSON is the required per-object source. Render a sorted per-key candidate table only after functional classification; calculate its SHA-256. A manifest must include bucket, capture hash/time, key, bytes, LastModified, ETag/available identity, category, reason and backup or reconstruction reference. Do **not** make an executable deletion list.

3. Using the authorised existing Dropbox configuration from the backup workflow (not a committed token), perform read-only `rclone lsf --recursive --format 'psti' "uk_aq_dropbox:${PRIVATE_TEST_BACKUP_ROOT}"` and read the v2 checkpoint root plus every referenced shard. Record the resolved private root from `UK_AQ_DROPBOX_ROOT` + `UK_AQ_R2_HISTORY_DROPBOX_DIR`, root/shard hashes, and each required unit identity. If the root or a referenced shard is absent, coverage is failed—not inferred from an old report.

4. Capture the deployed legacy AQI Worker's TEST configuration/version and installed/manual v2 utilities without invoking them. Establish exact readers of v2 AQI, binding and index keys, then reconcile those keys against the R2 capture. Also obtain the current TEST rollback/retention closure record and the planned JSONgen source/coverage evidence. Keep all unresolved keys C.

## Later separately authorised retirement sequence

1. Complete and privately retain the four evidence sets above.
2. Have the owner approve an immutable, per-object A manifest and its SHA-256; no prefix rule may stand in for that approval.
3. Reconfirm backup/checkpoint/shard availability and the precise recovery claim, including rebuild-only versus lossless recovery.
4. Reconfirm no writer, reader, manual tool, deployed Worker, JSONgen path or recovery job requires each proposed A key.
5. Immediately before a separately authorised deletion, repeat TEST identity and LIST/identity capture; stop if it differs from the approved manifest.
6. Perform only the approved bounded operation, retain a durable audit record of requested keys and responses, and do not expand scope on errors.
7. Verify remaining R2 contents with a fresh read-only listing and preserve the before/after manifests.
8. Resume normal TEST acceptance only under its own authorisation. Do not enable/run Prune or consume accumulated JSONgen test observations merely to validate retirement.

## Investigation boundaries

Only this report was added. No application code, operational configuration, authoritative system documentation, remote storage, Dropbox, database, schedule or deployment changed. No deletion tooling or executable deletion workflow is supplied.
