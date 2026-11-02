# Manual historical JSON chart admission and TEST operation

Local implementation, 2 November 2026. **Not deployed or functionally accepted.**
No source data was regenerated, publication prepared, R2 upload performed, selector activated,
SQL executed or configuration changed remotely during implementation. Prune remains paused.

## Ownership and data path

Source ownership was established from the local TEST repositories and Git remotes:

- `TEST-uk-aq/uk-aq-ops`: normal station-history Worker (`workers/uk_aq_station_history`),
  authenticated proxy (`workers/uk_aq_cache_proxy`) and private Sleepercar Worker
  (`workers/uk_aq_compressed_chart_history`). The existing private deployment file identifies
  its account, Access hostname and `UK_AQ_COMPRESSED_CHART_BUCKET` binding.
- `TEST-uk-aq/TEST-uk-aq.github.io`: website, shared chart and new `/historical-json-chart-test/` page.
- `TEST-uk-aq/uk-aq-system-docs`: read-only authoritative contracts; no edits.

Browser -> existing session-authenticated proxy `/api/aq/history-json/{manifest,observations,aqi}`
-> existing protected Sleepercar HTTPS/Service Auth -> private Worker
`/v2/history-json/{manifest,observations,aqi}` -> existing private derived R2 binding.
The normal station-history Worker and older fixed September PM2.5 pilot remain independent.

## Compatibility and trust decisions

- No new environment names, credentials, database objects, deployments or workflow changes.
  Existing `UK_AQ_COMPRESSED_CHART_ENABLED`, upstream URL, Access client ID/secret and edge
  upstream secret are reused. Default deployments still leave the compressed route disabled.
- The separate small monthly selection lives under `manual/chart-history/v1/selections/`;
  immutable paired objects live under `manual/chart-history/v1/publications/`.
  No writes go to `managed/jsongen/v1`, canonical history, indexes or retained v2 evidence.
- Bootstrap schema 1 is consumed as Bootstrap schema 1, never as the old pilot schema.
  The original two gzip byte streams and UUID pubID are retained. Each selection pins both
  compressed/uncompressed SHA-256 and lengths, physical identity/month, algorithm and source ID.
  Source ID includes evidence, checkpoint, binding, verification, represented terminal and
  adjacent day proofs. Adjacent pairs must agree on terminal/first-day and PM last/context-day proof.
- The initial operator policy admits only August 2026 connector 1 / PM10 timeseries 43 /
  station 1581 / `aqilevels_hourly_v3`. Reader identity/range code itself is generic.
- Admission requires COMPLETE/report/manifest/descriptor/product hashes and all retained source
  metadata. It reuses Bootstrap's actual checkpoint/aggregate/packed-binding/verification validators
  with a network-free reader; validates daily source accounting, preceding context, authenticated
  next-day terminal authority, exact AQI endpoint grid and independent index status counts.
  It does not independently recalculate AQI or fetch original Parquet again.
- The candidate's five unresolved **managed** authority limitations are retained explicitly.
  Authenticated backup physical binding/pre-overlay mode is permitted by the isolated manual
  policy only; no current Core/all-writer verification or managed eligibility is claimed.
  Other verification/continuity policies fail closed in this initial manual admission tool.
- Raw month membership remains `[S,E)`. AQI is `S<n<=E`. The adapter can display authenticated
  exact-E concentration inputs from the AQI dependency section; they never enter the preceding
  raw-month object. Multi-month boundary inputs must agree with next month's original rows.
  Original multiplicity is preserved using optional shared-cache row IDs; no averaging/deduplication.
- Shared calculated normalization and controller settlement remain authoritative. Failed AQI
  transport/shape remains retryable and local to AQI; natural blank statuses are settled.
  Missing months remain incomplete/unavailable; there is no R2/ingest/v2 fallback.
- Optional `dataClient`/`prepareLoad` context preserves generation and cancellation ownership.
  Newest-month loading delegates older chunks to the existing planner. Selection snapshots and cache namespaces include station/connector/timeseries/pollutant,
  month, source, pubID, algorithm and object hashes. Calculated/compatibility defaults are unchanged.
- The shared cache owns bounded immutable parsed objects (64 MiB / 48 entries). Selectors have
  at most 300 seconds from the start of origin validation; selector HTTP responses are no-store
  at browser/proxy/CDN. The controller rechecks visible charts at expiry and on visibility return.
  Refresh forces origin checks. No stacking of proxy/CDN TTLs. Immutable bodies use private browser
  caching; failures cannot silently change source. Recheck failures produce unavailable diagnostics
  and bounded retry, not a renewed fresh selection.
- Serving reads only a <=16 KiB selection and the chosen R2 body. The latter's size and SHA metadata
  must match the admitted descriptor; the Worker streams gzip with `encodeBody: manual`.
  Monthly decompression, hashing, AQI calculation and large JSON transformation are absent from
  the new serving handler. Browser verifies decoded digest/length once before caching.
  Custom SHA metadata is a publisher-installed trust assertion, not a per-request body checksum.

## Manual preparation (not executed)

After separate operator authorisation, from the TEST Ops root, with Node 22+ dependencies installed:

```sh
UKAQ_CANDIDATE="$HOME/UKAQ-bootstrap-evidence/bootstrap-pm10-ts43-precision-v3-20261102T152304Z"
UKAQ_PREPARED="$HOME/UKAQ-bootstrap-evidence/history-reader-admission-20261102"
node scripts/historical_chart_json/admit.mjs prepare \
  --candidate-dir "$UKAQ_CANDIDATE" \
  --policy scripts/historical_chart_json/initial-test-policy.json \
  --output-dir "$UKAQ_PREPARED"
```

Expected: `prepared_not_selected`, two uploads, original pubID
`e4f51e3d-e0a9-4223-bcf1-1f574d76a0cf`. Directory must be new, private and outside the workspace.
It contains exact observation/AQI gzip copies and `prepared.json`. **Never upload `prepared.json`
as a selection.** Any failure leaves no selectable data. Do not edit or regenerate the candidate.

## Independently read back immutable uploads, then select last (not executed)

Use the existing dedicated `.env.compressed-chart-test` credentials in an operator shell.
Do not print them or use canonical R2 credentials. Confirm `UK_AQ_ENV_NAME=TEST`, existing Sleepercar
account/Access configuration and bucket-scoped write permission before continuing. AWS CLI v2 must
support conditional `put-object --if-none-match` and `--if-match`.

```sh
set -euo pipefail
: "${UK_AQ_COMPRESSED_CHART_R2_ENDPOINT:?Load existing dedicated TEST endpoint}"
: "${UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID:?Load existing dedicated TEST access key}"
: "${UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY:?Load existing dedicated TEST secret}"
test "${UK_AQ_ENV_NAME:?}" = TEST
export AWS_ACCESS_KEY_ID="$UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
UKAQ_BUCKET="$(python3 -c 'import tomllib; c=tomllib.load(open("workers/uk_aq_compressed_chart_history/wrangler.deploy.toml","rb")); print(next(b["bucket_name"] for b in c["r2_buckets"] if b["binding"]=="UK_AQ_COMPRESSED_CHART_BUCKET"))')"
UKAQ_ACCOUNT="$(python3 -c 'import tomllib; print(tomllib.load(open("workers/uk_aq_compressed_chart_history/wrangler.deploy.toml","rb"))["account_id"])')"
test "${UK_AQ_COMPRESSED_CHART_R2_ENDPOINT%/}" = "https://${UKAQ_ACCOUNT}.r2.cloudflarestorage.com"
test "$UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID" != "${CFLARE_R2_ACCESS_KEY_ID:-}"
UKAQ_READBACK="${UKAQ_PREPARED}-readback"
mkdir -m 700 "$UKAQ_READBACK"
for kind in observations aqi; do
  UKAQ_KEY="$(jq -r --arg k "$kind" '.uploads[] | select(.kind==$k) | .key' "$UKAQ_PREPARED/prepared.json")"
  UKAQ_SHA="$(jq -r --arg k "$kind" '.selection.objects[$k].sha256' "$UKAQ_PREPARED/prepared.json")"
  aws --endpoint-url "$UK_AQ_COMPRESSED_CHART_R2_ENDPOINT" s3api put-object \
    --bucket "$UKAQ_BUCKET" --key "$UKAQ_KEY" --body "$UKAQ_PREPARED/$kind.json.gz" \
    --content-type application/json --content-encoding gzip --metadata "sha256=$UKAQ_SHA" \
    --if-none-match '*' > "$UKAQ_READBACK/$kind.put.json"
  aws --endpoint-url "$UK_AQ_COMPRESSED_CHART_R2_ENDPOINT" s3api get-object \
    --bucket "$UKAQ_BUCKET" --key "$UKAQ_KEY" "$UKAQ_READBACK/$kind.json.gz" \
    > "$UKAQ_READBACK/$kind.head.json"
done
node scripts/historical_chart_json/admit.mjs verify-readback \
  --prepared-dir "$UKAQ_PREPARED" --readback-dir "$UKAQ_READBACK" \
  --selection-output "$UKAQ_READBACK/selection.json"
```

Expected: `readback_verified_selection_file_only`. Both independent S3 GETs must match original
compressed and decoded digests, lengths, physical/pubID/source identity and metadata. Do not fake
readback by copying local files. A 412 on immutable PUT means stop and inspect/read back the existing
object; do not overwrite/delete it or suppress other upload errors. Previously selected data remains
unchanged throughout these steps.

Before selection, obtain `.selection_key` from `prepared.json`. Save the existing selection bytes
and GET metadata privately if it exists. Treat only an explicit `NoSuchKey`/404 as absent; an auth or
transport failure is not absence. For the initial absent selection:

```sh
UKAQ_SELECTION_KEY="$(jq -r '.selection_key' "$UKAQ_PREPARED/prepared.json")"
aws --endpoint-url "$UK_AQ_COMPRESSED_CHART_R2_ENDPOINT" s3api put-object \
  --bucket "$UKAQ_BUCKET" --key "$UKAQ_SELECTION_KEY" --body "$UKAQ_READBACK/selection.json" \
  --content-type application/json --cache-control no-store --if-none-match '*' \
  > "$UKAQ_READBACK/selection.put.json"
aws --endpoint-url "$UK_AQ_COMPRESSED_CHART_R2_ENDPOINT" s3api get-object \
  --bucket "$UKAQ_BUCKET" --key "$UKAQ_SELECTION_KEY" "$UKAQ_READBACK/selected.json" \
  > "$UKAQ_READBACK/selected.head.json"
cmp "$UKAQ_READBACK/selection.json" "$UKAQ_READBACK/selected.json"
```

For an authorised replacement, use `--if-match "$(jq -r '.ETag' PREVIOUS.head.json)"` instead of
`--if-none-match '*'`, retaining `PREVIOUS.json` and its metadata. A 412 retains the other selection;
stop and review. A post-PUT readback failure requires inspecting the selected object before retrying.
No managed JSONgen writer/control/notification is involved. Conditional single-object selection is
atomic; [R2 conditional PUT semantics](https://developers.cloudflare.com/r2/api/s3/api/) support this
publish-last operation. No automatic uploader or scheduler was added.

## Manual TEST deployment (not executed)

1. Review local changes and separately arrange their publication to the TEST repositories.
   These instructions grant no Git write or deployment authority during the coding task.
2. Private Worker: use the existing dedicated TEST account credentials and deployment config.
   For route-attributed CPU evidence, enable invocation telemetry in a **private generated** config,
   without adding environment identities to a shared template. For example:

```sh
python3 - "$UKAQ_READBACK/worker.deploy.toml" <<'PY'
from pathlib import Path
import sys
source=Path('workers/uk_aq_compressed_chart_history/wrangler.deploy.toml').resolve()
text=source.read_text().replace('main = "worker.mjs"', 'main = "'+str(source.parent/'worker.mjs')+'"')
assert '[observability' not in text
text+='\n[observability]\nenabled = true\nhead_sampling_rate = 1\n[observability.logs]\nenabled = true\ninvocation_logs = true\n'
with open(sys.argv[1], 'x') as f: f.write(text)
Path(sys.argv[1]).chmod(0o600)
PY
npx wrangler deploy --config "$UKAQ_READBACK/worker.deploy.toml"
```

   Expected: existing private Worker updated, same Access hostname/R2 binding, no workers.dev or
   preview URL. Its upstream secret and Access Service Auth policy remain required.
3. Authenticated proxy: after TEST main contains reviewed code, use its existing opt-in workflow:

```sh
gh workflow run uk_aq_cache_proxy_deploy.yml -R TEST-uk-aq/uk-aq-ops \
  -f activate_compressed_chart_history=true
```

   It still probes the old September pilot before enabling the shared upstream; that pilot must
   remain available. Normal push deployments disable this opt-in flag. Do not weaken its probe.
4. **Hosting prerequisite:** operator must confirm existing Access protection covers the new TEST
   page/path and that no alternative public hostname exposes it. Browser session/Turnstile is reused
   but is not a substitute for page Access protection. This was not inspected or changed remotely.
   If coverage is absent, obtain separate configuration authorisation before publishing the page.
5. Website: after reviewed source is available and Access coverage confirmed:

```sh
gh workflow run pages.yml -R TEST-uk-aq/TEST-uk-aq.github.io -f refresh_blog_feed=false
```

   Existing injection and content-hash build handles the new page/module dependencies. Shared auth
   supplies public API configuration, including the existing `cache_base` override where required.
   No chart source switch or new public configuration is injected into Hex Map/Sensors.

## Focused real TEST validation after authorised deployment/publication

- Open `/historical-json-chart-test/` through the protected TEST website. Without the real session,
  disallowed Origin or Access/upstream credentials, requests must fail. Never expose tokens in
  diagnostics or browser source. New manifest must be the expected physical August/v3 pair.
- Compare both sources for **12 August 00:00–13 August 00:00 UTC**. Inspect 14:00 DAQI input 16,
  level 1, source count 24, status `ok`. If normal source pins differ from the selected Bootstrap
  snapshot, record the difference; do not declare same-snapshot parity from visual similarity.
- Compare both sources for **1 August 00:00–1 September 00:00 UTC**. JSON raw month has 585 rows;
  AQI has 744 endpoints, 01:00 August 1 through midnight September 1. One authenticated terminal
  input can display separately from the raw month. DAQI has 588 valid/156 blank endpoints and
  EAQI 584 valid/160 blank endpoints. Blank statuses are expected, independent and settled.
- Repeat each load warm. Exercise Refresh (origin manifest, same immutable pair reuse), leave the
  visible page open through a five-minute recheck, hide/show it after expiry, and rapidly change
  source/range while loading. Obsolete results must not commit. Resize should change geometry only.
- Absent selection/object/version mismatch should remain unavailable/inconsistent, with successful
  observation/AQI parts retained where safe. Test missing additional months only with separately
  authorised read requests; one admitted August is never advertised as 90 days.
- Recheck normal Hex Map/Sensors and retained old prototype. No defaults/normal Worker logic changed.

Collect separately for cold/warm 24-hour and full-August loads: first visible line, full observation
and AQI settlement, response headers/body/parse/normalization/merge/render elapsed times, compressed
transfer and decoded sizes, requests, source/month/pubID/algorithm, browser application/HTTP cache,
Refresh and manifest age. Resource Timing may show cached transfers or unavailable network phases;
reported object size is not necessarily actual network transfer bytes.

Collect Cloudflare **per-Worker and per-route** invocation CPU p50/p95/p99/max, percentage >=10 ms,
`exceededCpu`, errors, R2 GET counts and bytes for manifest/observation/AQI. Request URL identifies
route in invocation telemetry. Do not use `Server-Timing` or browser wall time as Worker CPU.
Expected origin read plan: manifest 1 R2 GET; each uncached object 2 GETs (selection+object), or 5
for one uncached full pair; application-cache object hits need no request, Refresh unchanged needs
one manifest GET. Auth and old normal-route reads are separate. Acceptance requires reliable CPU
headroom below 10 ms; no actual CPU/latency/hosting acceptance is claimed by local checks.

## Rollback and documentation handover

- Remove/withdraw this page or opt out of the new provider; normal charts need no source rollback.
  Restore reviewed previous active source and redeploy normally, retaining old pilot. Archives are
  byte snapshots for restoration only; never serve/import them as fallback code.
- If replacing an existing selection, restore saved `PREVIOUS.json` with a conditional PUT against
  the current selected ETag. Initial admission with no previous selection can be withdrawn by
  disabling the new route/page; retain private objects/evidence, do not delete canonical/managed data.
- Restore prior Worker version if necessary; deployment rollback does not require changing R2,
  database retention, Prune, managed JSONgen or default chart flags.
- ChatGPT should update only the relevant authoritative station-chart reader/precomputed contract
  implementation/status sections: routes/schema/isolated namespace, optional provider snapshot and
  shared cache row-ID semantics, 300-second discovery/Refresh, terminal and adjacency proof gates,
  explicit manual-only authority, deployment prerequisites and structural evidence. Keep current
  normal station-history and old prototype status separate. Record real TEST measurements only
  after the operator supplies them. No authoritative system_docs were modified here.
