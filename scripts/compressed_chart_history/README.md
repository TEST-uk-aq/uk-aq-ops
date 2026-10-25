# Isolated compressed observation/AQI experiment

Code prepared for separately authorised TEST deployment and real evaluation. Nothing in this directory schedules generation, changes normal charts, registers original events or enables managed JSONgen. The existing pilot is extended in place; its fixed September/PM2.5 allowlist and old CLI are retired. Old published objects are neither read as a fallback nor modified. Use a new isolated experiment prefix/ID for this configuration and protocol.

## P0 findings

Confirmed at Ops main `0df7453c25889591633a1cdbe72647249aca6b9a`, website main `6fce23bfd8394d462c93b43b291ba1d219e31522`, read-only system-docs main `9e06f29d44901821936396ba70641438055381e3`:

- Existing v3 scoped exact-leaf/Parquet reader, effective verification resolver, physical binding/continuity validator, shared AQI library/orchestration, paired publisher/readback, private authenticated proxy and shared browser chart modules provide the necessary interfaces.
- The prepared paired export/streaming extension was code, not accepted precomputed deployment. No deployed state or CPU result was inferred here.
- No private source credentials are available in this environment. Exact primary/reference identities, historical coverage, accepted status transition, genuine context and Access/resource configuration are **unknown**, not absent. Station 248 is preferred only after its real three-pollutant bindings are supplied; no PM10/NO2 IDs were invented.
- The two accepted 15/17 October originals do not supply a continuous window, month, 90 days or PM context. Their registrations and missing 16 October handover are untouched. This source-as-read experiment does not depend on the future Integrity/writer-inventory work in #133/#134.
- The implementation admits a finite operator configuration and rejects missing/ambiguous binding, source, status, context, pair or request authority. No structural interface blocker remains for this bounded route. Source/access readiness and functional acceptance remain P2 prerequisites.

The design reference is [review #135](https://github.com/TEST-uk-aq/uk-aq-ops/pull/135); that review is unchanged. Authoritative constraints are routed through system_docs/station_charts/README.md, prototype/precomputed contracts, shared chart/pollutant-switch contracts, calculated station history, and canonical v3/schema/continuity/status contracts. No authoritative documents were copied or edited during implementation.

## Configuration: supply real metadata

Copy `experiment.example.json` outside the repositories. It is deliberately disabled and unpopulated; it cannot run. `experiment.schema.json` describes shape; the shared runtime validator additionally enforces environment/resource equality, explicit enablement, unique finite identities, hour-aligned contained views and bounds. Unknown fields fail admission.

Supply:

| Fields | Required meaning |
| --- | --- |
| experiment_id, enabled, environment | New bounded experiment ID, explicit true only for an authorised operation, exact existing UK_AQ_ENV_NAME. No environment default/fallback. |
| canonical_generation, network, source_mode | v3; operator-confirmed AURN network label/connector; exploratory_canonical_source_as_read. No VERIFIED authority. |
| source_endpoint, source_bucket | Exact canonical S3 HTTPS origin and bucket, matching existing CFLARE_R2_ENDPOINT/BUCKET. |
| derived_endpoint, derived_bucket, derived_prefix | Exact private derived S3 origin, separate bucket, and new experimental/ prefix. Never history/ or managed/. The renderer derives the deployment account from this endpoint. |
| verification_mode, legacy_status_mode, status_authority_reference | Explicit pre_overlay_accepted or overlay_accepted, sos_compatibility or persisted_verification_only, and reference to genuine accepted transition evidence at the source boundary. A missing overlay entry alone does not establish acceptance. This remains an operator-supplied historical assumption in exploratory evidence. |
| observation_units, algorithm_version | ug/m3 and aqilevels_hourly_v2. No unit conversion. Export additionally pins actual AQI/orchestration source SHA-256 and current 24-hour/18-valid-hour parameters. |
| samples | At most six explicit identities; one evaluation connector. Supply id, station_label, connector_id, station_id, timeseries_id, pollutant_code, permitted_timeseries_ids, start_utc, end_utc, views. |

This task permits only the genuine AURN connector (documented connector 1). The parser is generic; it does not authorise operations on another network.

For each sample, `permitted_timeseries_ids` contains its root and every genuine date-valid physical member needed for visible data and context, at most four. Canonical bindings, never browser/operator-invented dates, determine member selection; gaps, overlaps and contradictory member bindings fail. Root binding families above 32 members are outside this bounded implementation. Source physical schemas/timestamps must be supported and millisecond-precise; finer precision is refused rather than truncated.

Configure the primary AURN station's genuine PM2.5/PM10/NO2 series, ideally station 248 if corroborated, over a closed historical 90-day range. Supply 24h, 7d, full calendar-month and 90d views with explicit id/label/start_utc/end_utc. Use ids 24h, 7d, 31d and 90d for the shared controller's existing window chunk sizes. Configure the second AURN station's available matching pollutants over its approved switching range, at least 24h plus required context. Unavailable pollutants/views are absent, never fabricated. A first bounded seven-day source interval is also supported; extending its configuration requires a new experiment prefix/ID and new source pins, not a partial success declaration over an existing 90-day selection.

All times are canonical ISO UTC milliseconds and hour-aligned. A represented view S…E returns AQI endpoints S < n <= E, including E. The source export reads observations through E inclusive (its internal exclusive bound is E + 1 ms), retaining the actual reading at E when present. Thus an exact month-end view may legitimately need a one-endpoint fragment in the following calendar month's object. The reader authenticates that day's source metadata; an absent/unread source day cannot become a fabricated terminal value. PM context starts 24 hours before the first stored endpoint, covering the n−23…n hour-ending inputs and irregular readings; NO2 reads the preceding hour. Context is hidden from visible observation objects.

## Implemented flow and formats

`export.mjs --config FILE --sample-id ID --output-dir NEW-ABSOLUTE-DIRECTORY` performs bounded canonical GETs only. The real parent directory must already exist outside the multi-repository workspace. Each invocation selects one configured sample, at most 93 intersected visible UTC days, four selected physical members, 100,000 selected/context rows, 1,000,000 rows per source file, 2,048 GET attempts, 64 MiB Parquet / 16 MiB metadata per object, 128 MiB total source bodies, five monthly pairs and a five-minute processing deadline. No limits were enlarged to fit the demonstration. Metadata is re-read at the end, including missing references. This is detected-change protection, **not a coherent writer checkpoint**.

The source decoder preserves binary64 values (including negative zero in new canonical JSON), millisecond timestamps, multiplicity, nullable physical station, effective P/R/null, embedded status and genuine source status/provenance separately. Schema-3 embedded verification is not relabelled as original provider status. No averaging, rounding, deduplication, interpolation or hour filling is applied to exported observations. The shared AQI module's own hourly aggregation/exclusion and the shared renderer's existing display rules remain unchanged.

The existing `buildCalculatedHistory` orchestration resolves date-valid members before daily AQI calculation. A missing reading/negative excluded input may yield a correctly evaluated blank or insufficient_samples endpoint; these are not unresolved transport/context. No request-time AQI or browser AQI implementation exists in the new path.

Formats are versioned extensions of the existing pilot:

- Observation payload v2 keeps monthly coverage and source pins, with tuples `[observed_at_utc, value, station_id, source_status, verification_status, timeseries_id, embedded_verification_status, source_status_provenance]`.
- AQI payload v2 retains the shared calculated-history row/status shape, non-overlapping daily endpoint batches, explicit context/completeness and common publication/algorithm pins.
- Local candidate v3 and source evidence v2 distinguish exploratory provenance and always set managed_publication_eligible=false. One UUID identifies the local pair set; this is not a managed JSONgen registration/pubID.
- Publication v3 pins each month's observation/AQI compressed and raw digests/lengths/counts, the same source evidence, algorithm and publication identity. Selector v2 pins complete immutable publication manifests. A new configuration cannot adopt an old selector automatically.

gzip is level 9. Each payload is bounded at 2 MiB compressed / 16 MiB raw, evidence 16 MiB and total private output 192 MiB. Exact compressed readback, local raw/gzip equality and metadata/identity/context checks precede eligibility. Natural gaps are allowed; unresolved required source/context prevents selection. Complete authoritative empty data is distinct from unavailable generation.

`publish.mjs --config FILE --sample-id ID --candidate EXACT-CANDIDATE-PATH` is local preflight by default. Only explicit --publish uses existing private derived credentials. Immutable uploads use If-None-Match: *, exact bounded readback, then a strong-ETag conditional selector update. Concurrent conflict or ambiguous write stops without unconditional retry. Existing selector bytes are requested with identity encoding. Publication work is bounded at 128 operations, 64 MiB readback and five minutes; no scheduler, history lock, database or managed control is involved. Reruns inspect current state before retry; partial immutable uploads remain unselected.

The Worker validates small selection/manifest metadata and streams gzip. It checks the paired counterpart's size/existence with HEAD; payload requests currently cost selector GET + publication GET + payload GET + counterpart HEAD. Catalog costs one GET and sample manifest two. Nothing decompresses a month or calculates AQI in HTTP. Those code counts are not a CPU/cost benchmark.

The proxy preserves session-cookie/origin enforcement, opt-in enablement, Access Service Auth, upstream secret and redirect refusal. Before constructing credential headers, the proxy requires the upstream URL to match a separately approved exact HTTPS origin using the same validator as activation preflight. The request base comes from that approved value. A response environment mismatch remains a separate fail-closed defence after the request. Object/config/publication diagnostics headers are exposed through CORS. No private object keys, storage resources or credentials enter the public catalog.

## Environment catalogue

Reuse existing UK_AQ_ENV_NAME, CFLARE_R2_ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY, UK_AQ_COMPRESSED_CHART_R2_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY, UK_AQ_EDGE_UPSTREAM_SECRET, UK_AQ_COMPRESSED_CHART_ENABLED, UK_AQ_COMPRESSED_CHART_UPSTREAM_URL, Access credentials and UK_AQ_CACHE_ALLOWED_ORIGINS. Dedicated publication credentials must differ from canonical credentials and be limited to the separate derived bucket. Configuration pins both endpoints/buckets; no TEST/LIVE resource values appear in the changed application logic.

One narrowly new runtime setting, UK_AQ_COMPRESSED_CHART_CONFIG, carries the finite non-secret descriptor JSON to the private Worker. No existing setting expresses this scope. It is marked local in config/uk_aq_github_env_targets.csv: render it into a private per-deployment Wrangler file, not a GitHub repository variable. Committed base/deploy configs remain disabled with an empty descriptor. No secrets/variables/settings were applied remotely.

The security follow-up adds UK_AQ_COMPRESSED_CHART_APPROVED_ORIGIN, a private proxy trust setting targeted as a GitHub **secret**, distinct from the operational UK_AQ_COMPRESSED_CHART_UPSTREAM_URL variable. Existing UK_AQ_CACHE_ALLOWED_ORIGINS controls browser callers, and the private Worker descriptor controls data scope; neither supplies independently approved upstream authority. A security/configuration owner must maintain this approval from the reviewed Access application's exact HTTPS origin under separate secret-write control. Never derive, auto-populate or routinely copy it from the upstream URL variable. Changing only the operational URL cannot authorise a new credential destination.

Both runtime and the explicit activation preflight import workers/shared/uk_aq_compressed_chart_origin.mjs. They accept only matching canonical HTTPS origins (an optional single root slash is allowed), reject all explicit ports including :443, user information, non-root/normalised-away paths, query strings and fragments, and reject missing/contradictory values before constructing or sending credential-bearing requests. No hostname, suffix or cross-environment fallback is embedded in application code. The workflow probes the validated approved origin and installs both separately supplied settings only on explicit activation. Redirects are not followed; runtime rejects them, and preflight requires HTTP 200. Session/origin checks, Access Service Auth, upstream secret and response-environment validation remain intact.

Actual Cloudflare Access service-token scope was not inspected. Before P2, its owner must confirm a dedicated token is allowed by the intended private Worker's Access Service Auth policy and is not broadly reusable through other application policies or bypass rules. Host approval does not prove that policy scope. No secret values or hostname approvals were inspected, invented or applied here.

The externally maintained env-vars-master.csv is not present in this repository/workspace; no guessed mirror was created. Operator/Chat-mode catalogue handover: retain the existing local-only UK_AQ_COMPRESSED_CHART_CONFIG descriptor entry and add UK_AQ_COMPRESSED_CHART_APPROVED_ORIGIN as a proxy runtime secret / GitHub secret target, independently owned exact-origin approval, no default or cross-environment fallback. Its actual value and permission ownership remain operator prerequisites. Existing keys keep their meanings.

## Changed/reused components and acceptance

Changed active code: source_reader.mjs, extract.mjs, export.mjs, publish.mjs, shared compressed-chart validator, compressed-history Worker and its disabled Wrangler configs, prototype proxy/CORS branch and its explicit activation preflight. The active monthly observation JSON schema is aligned with payload v2. New local helpers: configuration.mjs and render-config.mjs, plus configuration schema/template. TEST website dependency: the existing compressed-chart-history-test client/viewer/index extension. Exact original active code/workflow snapshots are under archive/2026-10-25 (website uses Archive/2026-10-25); archive code is never executed.

Shared lib/aqi/aqi_levels.mjs, station-history calculation/continuity, chart controller/cache/normaliser/renderer and authentication library are reused **without changes**. No original-event or managed-JSONgen module, database/schema, scheduler, default chart or canonical writer is changed.

Structural checks passed: node --check for nine Ops modules (including TypeScript proxy) and two browser modules; inert linkage imports for the four offline/helper modules and Worker; matching runtime/config-schema required fields; parsed disabled Wrangler TOML; proxy workflow YAML plus nine embedded shell scripts; HTML IDs/references; all 11 archived code originals against pinned Git blob identities; and active-change EOF/whitespace checks. No operational exporter/publisher entry point or HTTP handler was invoked, no observations generated and no functional suite created. Functional/CPU acceptance remains unknown until real TEST P2.

See [STAGE_2B.md](STAGE_2B.md) for separately executable deployment, evaluation, rollback and Chat-mode handover. The Ops PR supplies the protocol; the website PR depends on it. Neither PR authorises its own deployment or a GO decision.
