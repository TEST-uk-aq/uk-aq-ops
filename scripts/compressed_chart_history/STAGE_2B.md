# Separately authorised P2 TEST operation

These instructions are prepared, **not executed**. Review both implementation PRs first. Deployment, data reads/generation, private R2 publication and workflow dispatch require the subsequent explicit TEST operation authorisation. Never point these steps at LIVE. The prior September pilot commands are superseded by the finite configuration protocol in README.md; prior objects and accepted originals are not migrated or rewritten.

## Before execution

Supply real metadata for the finite AURN sample and context as described in README.md. Establish accepted verification interpretation from genuine evidence. Confirm selected canonical generation v3, source/binding availability through the terminal endpoint, dedicated derived IAM permissions, existing secrets, private bucket and Access Service Auth policy, allowed website origin, Free plan and route-attributed CPU telemetry. Preserve current private Worker/proxy deployment configuration and any experimental selector bytes for rollback. Keep original JSONgen control/registrations, Prune/Integrity and schedulers untouched.

Use Node 22+ and installed Ops dependencies (`npm ci` in the real selected checkout). Required private paths/values below are operator-supplied; no example data IDs or cloud resources are implied. POC_ENV_FILE contains existing source/derived settings and UK_AQ_ENV_NAME; never print its secrets. The separate config JSON is reviewed, enabled and fully populated. Use a new experiment prefix/ID for new configuration.

### Manual export and paired publication

Only after source-read/generation authorisation, for each genuine selected sample:

```sh
: "${POC_ENV_FILE:?private existing environment file}"
: "${POC_CONFIG:?private reviewed experiment JSON}"
: "${POC_SAMPLE_ID:?configured finite sample ID}"
: "${POC_OUTPUT_DIR:?new absolute private directory with an existing parent outside the repository workspace}"
node --env-file="$POC_ENV_FILE" scripts/compressed_chart_history/export.mjs \
  --config "$POC_CONFIG" --sample-id "$POC_SAMPLE_ID" --output-dir "$POC_OUTPUT_DIR"
```

Exit 0 plus complete candidate/report means a local exploratory export, not source freshness or production acceptance. Exit 2/incomplete report or missing candidate after any failure means do not publish. The report pins runtime, source GET/decode/prepare wall/process CPU, AQI wall time, peak process RSS, bytes/counts, source schema/status/context and exact candidate identity. Node CPU/RSS are not Worker metrics. Inspect raw row fidelity and shared AQI results before selecting output. A seven-day source interval may be the first bounded configuration; the full comparison needs the primary month/90-day extent and genuine context, not merely 15/17 October events.

Take POC_CANDIDATE from the report's exact candidate path/digest, not an arbitrary glob. Local preflight makes zero remote calls. Only the second command writes the authorised private derived namespace:

```sh
: "${POC_CANDIDATE:?exact private candidate-manifest SHA path}"
node --env-file="$POC_ENV_FILE" scripts/compressed_chart_history/publish.mjs \
  --config "$POC_CONFIG" --sample-id "$POC_SAMPLE_ID" --candidate "$POC_CANDIDATE"
node --env-file="$POC_ENV_FILE" scripts/compressed_chart_history/publish.mjs \
  --config "$POC_CONFIG" --sample-id "$POC_SAMPLE_ID" --candidate "$POC_CANDIDATE" --publish
```

Retain each candidate/report and publication outcome/operation counts privately. Verify selected manifest pins and readback. A failed/conflicting conditional write requires current authoritative selector inspection before retry; never overwrite a failed precondition unconditionally. Do not register these candidates in managed VERIFIED control, reconstruct the 16 October original or dispatch a repair/reconciler.

### Protected Worker, proxy and website

Provisioning/account/access changes are separate operator actions within the later approved scope. Confirm an existing Access Service Auth policy on the exact private upstream hostname before deploying its route. Its owner must separately verify that the dedicated service token is permitted only by the intended application policy, with no broader token reuse or bypass. This policy scope remains uninspected here; do not expose token values. Browser code receives neither Access tokens nor storage credentials.

Render local configuration **disabled** first; this helper itself has no network or data operation:

```sh
: "${POC_WORKER_NAME:?approved private Worker name}"
: "${POC_UPSTREAM_HOSTNAME:?approved Access-protected bare hostname}"
: "${POC_DISABLED_CONFIG:?new private absolute TOML path}"
node --env-file="$POC_ENV_FILE" scripts/compressed_chart_history/render-config.mjs \
  --config "$POC_CONFIG" --worker-name "$POC_WORKER_NAME" \
  --hostname "$POC_UPSTREAM_HOSTNAME" --output "$POC_DISABLED_CONFIG"
npx wrangler deploy --config "$POC_DISABLED_CONFIG"
```

The account/bucket come from the reviewed derived endpoint/config, not application literals. Configure the existing UK_AQ_EDGE_UPSTREAM_SECRET through the approved secret mechanism (Wrangler interactive secret put is available); do not put it into JSON/TOML/source or terminal logs. Keep workers.dev and preview URLs disabled.

After private deployment/authentication and immutable publication readiness, render a fresh explicitly enabled config and deploy only when authorised:

```sh
: "${POC_ENABLED_CONFIG:?new private absolute TOML path}"
node --env-file="$POC_ENV_FILE" scripts/compressed_chart_history/render-config.mjs \
  --config "$POC_CONFIG" --worker-name "$POC_WORKER_NAME" \
  --hostname "$POC_UPSTREAM_HOSTNAME" --output "$POC_ENABLED_CONFIG" --enable
npx wrangler deploy --config "$POC_ENABLED_CONFIG"
gh workflow run uk_aq_cache_proxy_deploy.yml --repo TEST-uk-aq/uk-aq-ops \
  --ref main -f activate_compressed_chart_history=true
```

The existing proxy workflow's explicit preflight now checks the protected catalog/environment and at least one selected publication, rather than a fixed September station. Its ordinary deployment still disables the prototype. Before this dispatch, the security/configuration owner must set the independent GitHub secret UK_AQ_COMPRESSED_CHART_APPROVED_ORIGIN from the reviewed Access application's exact canonical HTTPS origin, and restrict secret-write ownership separately from the operational URL variable. Do not infer this approval or populate it automatically from UK_AQ_COMPRESSED_CHART_UPSTREAM_URL. Configure that existing operational URL variable, Access ID/secret, upstream secret and browser allowed origins as before. Activation requires both origins to pass the identical runtime/preflight validator; it probes the approved destination and installs the approval as a proxy Worker secret. Missing, mismatched or malformed approval refuses activation before credential transmission. Both values may include one root slash; explicit ports (even :443), credentials, paths, queries and fragments are rejected. No concrete hostname is supplied by this implementation. Confirm all samples needed for a particular comparison are actually published; catalog admission alone is not data acceptance.

Deploy the companion TEST website through its existing Pages workflow only after separate authorisation. Its existing workflow remains unchanged. Open the existing isolated /compressed-chart-history-test/ path with browser-safe environment=APPROVED_ENVIRONMENT and, where needed, cache_base=APPROVED_TEST_CACHE_ORIGIN/api/aq query parameters. Values must match the authorised TEST deployment; no implicit cross-environment fallback exists. The page remains noindex and unlinked from normal navigation. No default chart source changes.

## Real evaluation and expected evidence

Alternate normal canonical-v3 and JSON modes under comparable device/network/cache conditions. Record deployed Ops/website SHAs, configuration SHA, exact source/algorithm/publication pins and UTC ranges. Confirm the normal route actually uses v3 and equivalent source observations/context. If canonical revisions changed, classify the comparison non-equivalent and choose/re-export a stable qualified interval before drawing latency conclusions.

Retain actual authenticated normal response bodies (or a private browser network capture) and the corresponding JSON payloads for identical ranges/context. Compare raw observation multisets and per-hour AQI values/statuses against those real responses/shared calculations; timing metadata alone is not parity evidence.

Use primary 24h, seven-day, full-month and 90-day views; switch pollutants/stations while mounted, change ranges quickly, repeat and Refresh. Confirm genuine gaps, zero/negative values, raw multiplicity/status provenance and nullable physical identity remain traceable to source; shared display filtering/merging stays the same as normal charts. Check exact hour-ending endpoint sets, daily/monthly joins and context, independent DAQI/EAQI results/status/missing reasons and latest-source-observation band cap. Include a genuine continuity transition only when admitted real data exists; otherwise record that case untested.

Download viewer diagnostics. They include bounded raw request records, request IDs, public pins, first useful line, shared-controller observation completion, separate normalised part coverage/cache commit hooks, parse/hash/normalise/merge/render timings, object reuse and observed bytes. Source completeness, natural blank hours, browser settlement and correctness are distinct. Cache-based repeats may settle without new full-range response records. Current JSON head is at most 24h; the shared controller requests older chunks, which reuse decoded month objects. A 24h view fetches only intersecting objects; an exact month boundary can genuinely require the terminal fragment. The transport cache is bounded, cancellation is consumer-aware and Refresh discards it after requesting an origin-authoritative catalog. Timing/diagnostic overhead and cross-origin Resource Timing restrictions must be included in interpretation.

Correlate IDs with actual Cloudflare per-Worker/per-route telemetry: manifest/catalog, observation, AQI, proxy/auth and normal control. Collect p50/p95/p99 only with adequate sample counts, maximum, over-10-ms share, exceededCpu and errors. Require reliable uncached headroom below 10 ms on every HTTP Worker. Browser elapsed time, request count headers and offline process CPU do not establish Worker CPU. Record observable memory and otherwise mark it unknown.

Measure compressed observation + AQI + discovery bytes, actual R2 GET/HEAD/PUT counts/storage, generation/read amplification/revision churn and manual publication-to-Refresh delay. Inspect fail-closed local refusal using a genuinely incomplete candidate if available, then a separately authorised genuine revision and Refresh; unchanged genuine bytes with a new identity demonstrate discovery only, not repair propagation. Never mutate canonical source for a benchmark. No automation/freshness SLA is established by manual success.

Before measuring, agree acceptable latency/resource/maintenance envelopes. GO requires same-source observation/AQI correctness, inspectable real charts, Free headroom, repeatable material benefit and a credible common-interface route to every applicable network. Missing evidence is not GO. NO-GO retains current charts and recommends authorised experimental retirement. The decision and any future rollout/cut-over remain separate operator actions; pollutant coverage is a separate policy from network coverage. Sensor.Community remains excluded and its conditional future hourly aggregation is not implemented here.

## Rollback and Chat-mode handover

Stop invoking the exporter/publisher. Disable the prototype flag/config through a separately authorised deployment; an ordinary proxy workflow deployment omitting activation restores its disabled route. Normal charts/canonical history require no rollback because they are unchanged. Preserve the last complete selectors/objects and original evidence; do not delete anything automatically. New-namespace partial uploads are unselected. Restoring a previous experimental selection/code requires explicit operational action and known bytes, not an unconditional blind overwrite. Exact prior code/workflow is archived in each implementation repository; configuration rollback sources remain in Git history.

For ChatGPT Chat mode, update only the routed prototype/precomputed chart contracts after separately requested documentation maintenance. Distinguish prepared code from deployed acceptance; record protocol versions, finite generic configuration, explicit source-as-read authority, status/physical identity preservation, inclusive terminal endpoint/context, paired CAS/readback, authenticated cross-account route, browser cache/cancellation and unchanged normal charts/managed selector. Maintain the existing local descriptor catalogue row and add the separately owned approved-origin secret row from README.md to the external env-vars-master.csv. Document the pre-request exact-origin gate, unchanged redirect/session/Access protections and outstanding token-policy verification without publishing approved values or credentials. Link both implementation PRs and their structural checks. After P2, add only actual deployments, source pins, correctness/CPU/timing/cost evidence and unresolved limitations. Do not imply all-writer authority, full monthly VERIFIED baseline, Sensor.Community activation, a GO decision or LIVE adoption from this implementation.
