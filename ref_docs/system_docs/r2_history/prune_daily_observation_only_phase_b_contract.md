# Prune Daily observation-only Phase B contract

## Authority and scope

This document defines the permanent supported Prune Daily Phase B R2 operating model.

It is an authoritative amendment to:

- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md).

The permanent retirement of calculated AQI / `aqilevels` as an R2 history product is defined by:

- [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md).

Complete connector-day pollutant child-set semantics are defined by:

- [`prune_daily_complete_snapshot_child_set_contract.md`](prune_daily_complete_snapshot_child_set_contract.md).

Where older wording describes observation-only Phase B as temporary, optional, disabled by a switch, or reversible by setting an AQI flag back to true, this document supersedes that wording.

TEST remains the implementation and operational proving ground before a separately authorised LIVE rollout.

## Permanent operating model

Prune Daily Phase B writes canonical observation history only.

Its supported permanent R2 operation is:

```text
eligible connector-day
    -> freeze exact IngestDB observation source
    -> canonicalise observations
    -> write and verify canonical observation Parquet
    -> write and verify pollutant / connector manifests
    -> publish required observation parent/index authority
    -> verify connector-day evidence
    -> complete Prune Daily connector-day deletion gate
    -> delete matching IngestDB observations only through that gate
```

Calculated AQI is not an R2 Phase B output.

The logical observation-history version remains:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

After the accepted observation-history index-v3 cut-over, the active observation index authority is:

```text
UK_AQ_R2_HISTORY_INDEX_VERSION=v3
```

The observation-timeseries physical/index runtime is v3-only after cut-over even though logical canonical observation paths remain under `history/v2/observations`.

## No AQI mode selector

There is no supported normal runtime mode that switches Phase B between observation-only and AQI-in-R2 behaviour.

A legacy internal property such as:

```javascript
phase_b_calculate_aqi_from_observations_enabled
```

MUST NOT be treated as a supported writer-generation or product-selection control.

If such a property remains temporarily while old AQI code is being removed, active production semantics remain observation-only and the retired AQI branch MUST NOT be reachable from the normal Phase B execution path.

No replacement AQI enable/disable secret, repository variable or environment variable is required.

## Required observation behaviour

For each eligible connector-day, Phase B must:

1. establish the exact current source identity required by the prune contracts;
2. freeze the canonical target-day source under the active observation-operation coordination boundary;
3. preserve canonical logical observation identity including `verification_status`;
4. group/write the complete required pollutant partitions through the shared canonical observation writer;
5. preserve the deterministic `observation_content_hash` contract;
6. write Parquet using the active accepted physical writer/layout contract;
7. verify exact durable Parquet identity before manifests/index authority may reference it;
8. build and verify the canonical pollutant and connector manifests;
9. treat the frozen Prune connector-day source as a complete snapshot: the final connector pollutant child set must equal the exact source-derived pollutant set, and a previously authoritative pollutant absent from that complete snapshot must not be preserved merely because old R2 objects still exist;
10. preserve unrelated valid connectors already present in the affected day while finalising the complete current day connector set;
11. finalise the canonical day and higher observation hierarchy without dropping unrelated connector/day state;
12. publish the authoritative observation-timeseries index generation according to the active index contract, removing obsolete authoritative v3 scopes when a pollutant disappears from the complete Prune snapshot;
13. return exact verified connector evidence to Prune Daily;
14. complete the connector-day prune gate only after the required observation evidence is valid;
15. permit IngestDB deletion only after the source identity is revalidated under the deletion transaction contract.

Normal Integrity selected-partition repair remains a partial-merge mode and may preserve unrelated valid pollutant children under its own contracts. That behaviour MUST NOT be inferred for a Prune complete connector-day snapshot.

The shared writer does not own the prune gate or IngestDB deletion.

## V3 post-cut-over writer requirements

After index-v3 cut-over, the active observation writer must require:

```text
UK_AQ_R2_HISTORY_INDEX_VERSION=v3
```

Missing, malformed or non-v3 authority fails closed for active steady-state observation writes.

The active writer must use the accepted bounded v3 target writer and accepted writer limits from the active observation-history index-v3 contract.

The active path MUST NOT:

- silently fall back to the old observation physical/index writer;
- update `_index_v2` observation-timeseries runtime state;
- maintain parallel v2 and v3 observation indexes for convenience;
- use the retired generic v2 observation index writer as a post-write verification side effect.

Formal rollback is operational and restores the previously sealed v2 runtime. It is not implemented as a hidden compatibility branch in the active v3 writer.

## Required AQI absence

Normal Phase B must not invoke or create calculated AQI R2 work.

It must not perform:

- observation-derived AQI R2 calculation stages;
- PM rolling-context RPC calls for an R2 AQI writer;
- AQI data or debug Parquet writes;
- AQI pollutant or connector manifests;
- AQI day/month/year/root finalisation;
- connector-targeted AQI indexes;
- AQI global/latest index updates;
- AQI-specific R2 completion state.

No new normal objects may be produced under legacy calculated-AQI paths such as:

```text
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
```

Existing historical AQI objects are legacy retained data and are outside normal Phase B mutation.

## Candidate and deletion-gate behaviour

The candidate result and run summary should report observation-history outcomes directly.

There is no requirement to synthesise an `aqilevels_disabled` success/skip result merely to preserve the shape of the retired AQI pipeline. Compatibility fields may remain temporarily in reports only when an external consumer still requires them, but they MUST NOT imply that AQI R2 execution remains a supported stage.

The connector-day gate is observation-only deletion authority.

It must depend on:

- exact canonical connector/day identity;
- valid source identity;
- canonical manifest identity;
- required row/file/byte evidence;
- physical Parquet identity;
- active observation-index evidence where required by the post-cut-over gate contract;
- mandatory comparison/safety checks.

AQI data, AQI index state or AQI completion is not part of gate authority.

## Day and aggregate finalisation

Phase B must finalise the affected observation hierarchy in the deterministic bottom-up order required by the active observation writer contracts.

If `uk_aq_ops.prune_day_gates` remains as aggregate whole-day metadata, its current supported meaning is observation-based completion only.

It MUST NOT require AQI data/debug outputs, AQI manifests or AQI indexes.

The aggregate day relation may be audited or removed separately if it has no remaining consumer. That decision does not change connector-day deletion safety.

## Locks and coordination

Prune Daily uses the canonical observation-operation coordination defined by the active observation exclusion/coordination contracts.

There is no active R2 AQI writer requiring a separate AQI publication lock.

A fine-grained lock that remains only because of the retired AQI R2 path is legacy implementation and should be removed when safe.

The v3 writer may retain transitional connector/day/global internal locks where the accepted observation-v3 implementation still requires them, provided they do not recreate a competing cross-run ownership model.

## Calculated AQI outside R2 history

This contract does not remove calculated AQI from the product.

Calculated station-chart AQI and website AQI are governed by the active contracts under:

```text
system_docs/aqi-levels/
```

They may use canonical observation history as their source. After index-v3 cut-over, exact/ranged observation reads are governed by [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md).

## Future verification-overlay writer amendment

The future [observation verification overlay contract](observation_verification_overlay_contract.md) changes only the verification-persistence part of canonical observation publication.

Current implementation may populate `verification_status` for connector `1` and null for other connectors, but the current shared writer still physically writes that column. After overlay cut-over, Prune Daily MUST instead:

- write the new six-column measurement-only physical schema with no verification-status column;
- use the measurement-only observation-content-hash contract;
- stop synthesising null status values for connectors with no verification authority;
- stop embedding SOS P/R into canonical Parquet;
- keep connector-day deletion authority based on the measurement-history evidence required by this contract;
- leave durable verification-overlay publication to the verification-refresh authority.

A later P/R-only source change MUST NOT cause Prune Daily to rewrite an otherwise unchanged connector-day Parquet partition.

Existing schema-version-3 Parquet containing embedded status remains readable legacy measurement history after overlay cut-over; Prune Daily is not required to rebuild the historical archive solely to remove that column.

## Structural validation requirement

Before deploying a changed Phase B observation writer, focused deterministic checks must prove at least:

- the active Phase B path reaches the accepted shared canonical observation writer;
- the active post-cut-over writer requires exact v3 observation index authority;
- canonical logical observation identity and content hashes remain stable;
- durable Parquet SHA/size evidence is established before authority publication;
- Prune complete-snapshot publication derives the final connector pollutant set exactly from the frozen source and removes a previously authoritative pollutant that is absent from the new source;
- corresponding obsolete v3 scope authority is removed without requiring immediate deletion of stale physical objects;
- unrelated valid connectors in the same day remain preserved;
- normal Integrity partial-merge semantics still preserve an unrelated valid pollutant child;
- the active Phase B call graph does not write `_index_v2` observation-timeseries state;
- the active Phase B call graph does not write `history/v2/aqilevels/...`;
- the active Phase B call graph does not call a legacy generic index writer for an `aqilevels` domain;
- connector-day gate completion remains observation-only and fail-closed;
- no AQI re-enable switch or hidden production fallback remains.

Use only the smallest local checks required by repository policy. Functional acceptance belongs in real TEST operation.

## TEST functional acceptance

After review, commit, push and deployment to TEST, perform one explicitly authorised controlled Prune operation while the broader migration safety state remains controlled.

Acceptance must confirm:

1. canonical observation Parquet and manifests are written and verified;
2. the final connector pollutant set equals the exact complete frozen source snapshot for the selected candidate;
3. the v3 observation scoped/index/latest authority is correct for that final child set and contains no obsolete authoritative scope;
4. exact physical R2 SHA/size evidence is valid;
5. the connector-day prune gate is based only on valid observation evidence for the final connector manifest;
6. required parent observation manifests preserve unrelated valid connectors already present in the day;
7. matching IngestDB deletion occurs only if separately authorised by the controlled procedure and gate contract;
8. no new AQI/`aqilevels` R2 Parquet, manifest or index object is created;
9. no legacy `_index_v2` observation-timeseries object is updated by the active v3 path;
10. no retired AQI R2 finaliser or index helper runs.

If the selected real candidate does not naturally contain a disappearing pollutant, deterministic TEST regression coverage of that edge case is sufficient; do not manufacture source mutation merely to force the condition.

## Rollback

Rollback of the observation index-v3 deployment uses the separately sealed operational rollback evidence and restores the recoverable v2 observation runtime/configuration.

Rollback MUST NOT be implemented by re-enabling calculated AQI in R2.

There is no supported AQI-in-R2 rollback target in normal Prune Daily operation.

Reintroducing AQI persistence in R2 requires a new explicit architecture decision and updated active system contracts.