# PurpleAirFriend ingest draft plan

Status: Draft
Project: UK AQ
Network name: PurpleAirFriend
Short code: PAF
Date: 2026-06-03

## 1. Purpose

PurpleAirFriend is a proposed small private/friend network for bringing selected PurpleAir sensors into the UK AQ app without relying on the PurpleAir cloud API.

The first use case is a friend-owned PurpleAir monitor. A small Raspberry Pi device on the friend’s local network will poll the PurpleAir local JSON endpoint and push readings to a UK AQ ingest endpoint.

The design goal is:

- avoid PurpleAir cloud API points
- avoid opening inbound ports on a friend’s router
- avoid putting Supabase service keys, Dropbox credentials or other high-risk credentials on the Raspberry Pi
- keep the new path off GCP where practical
- support near-realtime raw payload archiving
- integrate normalised observations into the existing UK AQ station, timeseries and observations model
- keep a migration path toward moving the existing GCP Pub/Sub/latest-snapshot builder to Cloudflare

## 2. Current decisions

### 2.1 Hardware direction

For the first prototype, use a cheap Raspberry Pi Zero W or equivalent small always-on device.

Planned device characteristics:

- Raspberry Pi Zero W if available
- Raspberry Pi OS Lite
- Wi-Fi configured before posting to the friend
- Tailscale for primary remote admin access
- Raspberry Pi Connect as optional backup remote shell
- systemd service for the forwarder script
- per-device serial such as `PAF-0001`
- simple case, likely a Flirc Raspberry Pi Zero case, with a UK-AQ sticker

A display is not required for v1.

### 2.2 Device identity

Use a serial/device ID format:

```text
PAF-0001
PAF-0002
PAF-0003
```

The sticker should identify the Pi forwarder device, not necessarily the PurpleAir sensor itself. The database should separately track the PurpleAir sensor ID or local sensor metadata.

Suggested sticker content:

```text
UKAQ.co.uk
PurpleAirFriend
PAF-0001
```

### 2.3 Ingest endpoint

Use Cloudflare Worker as the public ingest endpoint.

Planned endpoint shape:

```text
POST https://ingest.ukaq.co.uk/purpleairfriend/v1/observations
```

Request authentication:

```text
x-device-id: PAF-0001
x-device-token: per-device shared secret
```

Rationale:

- keeps the public internet-facing endpoint at Cloudflare
- avoids Supabase Edge Functions as the public ingest surface
- avoids GCP for the PAF ingest path
- allows per-device rate limits, validation and simple rejection before Supabase is touched
- can write raw payloads immediately to R2
- can enqueue latest snapshot update work in Cloudflare Queues

### 2.4 Direct write vs staging table

Use a hybrid direct-write design for v1.

The Cloudflare Worker should validate the device and payload, then call a Supabase RPC. The RPC should:

- insert a raw payload/audit row
- upsert or resolve the PurpleAirFriend connector
- upsert or resolve the station
- upsert or resolve required timeseries
- insert or upsert observations
- update latest-value fields needed by current UK AQ views
- return a small summary such as inserted/skipped/warnings

A separate staging-table-and-normaliser pipeline will not be built for v1.

Rationale:

- similar to the current GCP ingest pattern, where connector ingests write directly to core tables
- less operational complexity
- faster visibility in UK AQ
- raw payloads remain available for debugging/replay

### 2.5 Raw payload archive

Do not put Dropbox credentials on the Pi.

Do not use GCP for PAF raw payload archiving.

For v1, use R2 as the near-realtime raw payload archive. Every accepted PAF payload should be written to R2 immediately by the Cloudflare Worker, after device authentication and basic payload validation.

Suggested R2 raw payload key format:

```text
paf/raw_data/v1/device_id=PAF-0001/day_utc=2026-06-03/20260603T121500Z_<request_id>.json
```

Also store a raw payload row in Supabase via the RPC, including the R2 object key.

Dropbox export remains optional and secondary. It can be added later as a periodic export from R2 or Supabase, but it is not required for v1.

### 2.6 Latest snapshots

Do not have PAF write directly into the existing GCP-owned `latest_snapshots/v1/...` objects.

The current latest snapshot pipeline is owned by the GCP Cloud Run builder and Pub/Sub flow. If the PAF Worker writes to the same objects, the GCP builder may overwrite them on the next run.

For v1, PAF should write PAF-only latest snapshot overlay objects in R2, for example:

```text
latest_snapshots_paf/v1/network_group=purpleairfriend/pollutant=pm25/window=3h.json
latest_snapshots_paf/v1/network_group=purpleairfriend/pollutant=pm10/window=3h.json
latest_snapshots_paf/v1/manifest.json
latest_snapshots_paf_state/v1/latest_state.json
```

The website/cache proxy can later fetch the existing all-network latest snapshot plus the PAF overlay and merge them, or PAF can remain a separate network group until the global latest-snapshot builder is migrated off GCP.

### 2.7 Mentioned future migration

The PAF plan should explicitly mention the likely future project:

```text
Move the existing GCP Pub/Sub/latest-snapshot builder to Cloudflare Queues, Workers and R2.
```

This should become a separate plan MD file after the PAF ingest draft is reviewed.

## 3. Proposed v1 architecture

```text
PurpleAir sensor on friend LAN
  -> Pi Zero W forwarder
      -> Cloudflare PAF ingest Worker
          -> R2 raw payload object
          -> Supabase RPC direct write
          -> Cloudflare Queue message
              -> PAF latest snapshot queue consumer
                  -> R2 PAF latest state
                  -> R2 PAF latest snapshot overlay objects
                  -> R2 PAF manifest
          -> optional status response to Pi
```

## 4. Components

### 4.1 Raspberry Pi forwarder

Responsibilities:

- poll the PurpleAir local endpoint, usually `http://<sensor-ip>/json`
- collect timestamp, local sensor metadata and raw JSON
- POST to Cloudflare endpoint every 120 seconds by default
- include `x-device-id` and `x-device-token`
- spool locally when the endpoint is unavailable
- retry later without data loss within a sensible limit
- expose useful logs via `journalctl`
- run as a systemd service

It should not:

- expose inbound ports
- require friend router changes
- contain Supabase service keys
- contain Dropbox credentials
- contain Cloudflare API tokens

### 4.2 Cloudflare PAF ingest Worker

Responsibilities:

- accept only HTTPS POST requests
- validate method, body size and content type
- validate `x-device-id` and `x-device-token`
- reject unknown or disabled devices
- apply per-device rate limiting or minimum cadence if needed
- validate basic payload shape
- write accepted raw payload to R2
- call Supabase RPC to write raw audit row and normalised observations
- enqueue a small latest-snapshot message
- return a compact response to the Pi

Suggested response shape:

```json
{
  "ok": true,
  "device_id": "PAF-0001",
  "received_at": "2026-06-03T12:15:00Z",
  "raw_r2_key": "paf/raw_data/v1/device_id=PAF-0001/day_utc=2026-06-03/20260603T121500Z_abc123.json",
  "inserted_observations": 4,
  "warnings": []
}
```

### 4.3 Supabase RPC

Proposed RPC name:

```text
uk_aq_public.uk_aq_rpc_purpleairfriend_ingest
```

Input should be JSONB and include:

- device ID
- PurpleAir sensor URL or sensor ID if known
- collected timestamp
- worker received timestamp
- R2 raw payload key
- raw payload JSON
- forwarder version
- optional Pi diagnostics

Responsibilities:

- verify the device exists and is active, or rely on Worker validation and re-check minimally
- insert raw payload audit row
- upsert connector `purpleairfriend`
- upsert station row
- upsert phenomena/timeseries rows for mapped fields
- upsert observation rows
- update latest-value fields on timeseries
- return inserted/skipped counts and warnings

### 4.4 Cloudflare Queue

The ingest Worker should enqueue one message per accepted reading.

Suggested message:

```json
{
  "event_type": "purpleairfriend_observation_ingested",
  "device_id": "PAF-0001",
  "station_ref": "PAF-0001",
  "observed_at": "2026-06-03T12:14:00Z",
  "pollutants": ["pm25", "pm10"],
  "timeseries_ids": [1234, 1235],
  "raw_r2_key": "..."
}
```

The message should be small, under 64 KB.

Queue use is attractive because Cloudflare Queues bill by operations, messages under 64 KB are counted as one operation per write/read/delete step, and there is no Queues egress/throughput charge. The free plan includes 10,000 operations/day, while Workers Paid includes 1 million operations/month before $0.40 per million operations. Current Cloudflare docs say most deliveries take 3 operations: one write, one read and one delete.

### 4.5 PAF latest snapshot queue consumer

Responsibilities:

- consume PAF queue messages in small batches
- update PAF latest state in R2
- rebuild or patch PAF-only latest snapshot overlay objects
- update PAF manifest
- handle retries and idempotency

Suggested R2 keys:

```text
latest_snapshots_paf_state/v1/latest_state.json
latest_snapshots_paf/v1/network_group=purpleairfriend/pollutant=pm25/window=3h.json
latest_snapshots_paf/v1/network_group=purpleairfriend/pollutant=pm25/window=6h.json
latest_snapshots_paf/v1/network_group=purpleairfriend/pollutant=pm25/window=1d.json
latest_snapshots_paf/v1/network_group=purpleairfriend/pollutant=pm25/window=7d.json
latest_snapshots_paf/v1/network_group=purpleairfriend/pollutant=pm25/window=all.json
latest_snapshots_paf/v1/manifest.json
```

### 4.6 PAF scheduled cleanup Worker

A Cloudflare scheduled handler should run every few minutes to refresh/prune stale PAF snapshots.

Responsibilities:

- ensure stale sensors drop out of 3h/6h/1d/7d views when no new reading arrives
- rebuild PAF overlay objects from latest state if needed
- emit health diagnostics

Cloudflare Workers Free currently allows 5 Cron Triggers per account, and Workers Free allows 100,000 requests/day. The PAF ingest path should be comfortably below those limits for a small friend network.

## 5. PurpleAir field mapping

The exact local JSON shape should be confirmed against a live sensor or captured sample.

Initial likely fields to map:

- PM2.5 ATM channel A
- PM2.5 ATM channel B
- PM2.5 CF1 channel A
- PM2.5 CF1 channel B
- PM10 if present
- PM1 if present
- particle count fields such as PM0.3/count bins if present
- temperature, humidity and pressure if present
- RSSI/uptime as diagnostics, not public pollutants

Open decision:

- decide whether to store A/B channels separately, average them, or store both raw and a derived value
- decide how to label particle count fields, especially PM0.3/count bins
- decide which fields appear publicly on UK AQ in v1

## 6. Raw archive and storage strategy

### 6.1 R2 raw archive

R2 raw archive is near realtime and primary for PAF.

For one device posting every 120 seconds:

```text
30 posts/hour
720 posts/day
about 21,600 posts/month
```

If each raw JSON object is roughly 5 KB, this is roughly 108 MB/month per device before overhead. This is small compared with R2’s current free tier of 10 GB-month storage, 1 million Class A operations/month and 10 million Class B operations/month. R2 egress to the internet is free on Standard storage.

### 6.2 Dropbox

Dropbox is optional for PAF v1.

Decision:

- no Dropbox credentials on the Pi
- no GCP job required for PAF Dropbox export
- R2 is the near-realtime raw archive
- later, add a non-GCP export path from R2/Supabase to Dropbox if still wanted

Possible later Dropbox export options:

- manual local ops script
- Cloudflare Worker batch export if small enough
- Cloudflare Workflows/Queues if adopted later
- GitHub Actions only as manual fallback, not scheduled near-realtime

## 7. Cloudflare and Supabase cost notes

### 7.1 Cloudflare Workers

Cloudflare Workers Free currently lists 100,000 requests/day, 10 ms CPU time, 128 MB memory, 50 subrequests per request and 5 Cron Triggers per account. This is enough for a small PAF network if each device posts every two minutes.

The Worker request budget at 720 requests/day per device is approximately:

```text
100,000 / 720 = about 138 devices
```

This is only a rough request-count estimate and does not include other Workers on the same account.

### 7.2 Cloudflare R2

Current R2 Standard pricing/free tier:

- storage: $0.015 per GB-month
- Class A operations: $4.50 per million requests
- Class B operations: $0.36 per million requests
- egress to internet: free
- free tier: 10 GB-month storage/month, 1 million Class A operations/month, 10 million Class B operations/month

PAF raw writes should remain well below the free tier for early prototypes.

### 7.3 Cloudflare Queues

Cloudflare Queues operations are counted per 64 KB written/read/deleted. Most successful deliveries take 3 operations per message: write, read and delete.

For one device at 720 messages/day:

```text
720 messages/day * 3 = 2,160 queue operations/day
```

This is below the current Workers Free Queues allowance of 10,000 operations/day for a single device. Multiple devices may require care, or Workers Paid.

### 7.4 Supabase

Supabase receives one RPC/database write per accepted reading.

Supabase egress impact should be low because the readings are inbound to Supabase and the response payload is tiny. The main Supabase bandwidth/egress issue remains website/API users reading observations back out, not the PAF ingest path.

## 8. Why not use GCP for PAF v1

Avoiding GCP for PAF is preferred because:

- the project is already trying to reduce GCP cost
- PAF is a new small network that fits Cloudflare Workers/R2/Queues well
- raw payload archive can be near realtime in R2
- the current GCP latest snapshot path is already a candidate for migration

## 9. Relationship to existing latest snapshot pipeline

The current UK AQ latest snapshot pipeline publishes deterministic latest-value snapshot JSON files to R2 and serves them through the cache proxy. It is built by a Cloud Run service triggered every minute, pulling Pub/Sub observation messages, maintaining latest-per-timeseries state in R2 and writing snapshot objects/manifest to R2.

PAF v1 should not edit those existing GCP-owned snapshot objects.

Instead:

- PAF writes a separate overlay snapshot prefix
- the website/cache proxy can optionally merge PAF overlay data later
- a separate plan should be created to migrate the GCP Pub/Sub/latest-snapshot builder to Cloudflare Queues/Workers/R2

## 10. Future plan: migrate GCP Pub/Sub/latest-snapshot builder to Cloudflare

This should be a separate plan MD file.

The target architecture to explore:

```text
All ingests
  -> Supabase observations
  -> Cloudflare Queue messages
      -> latest snapshot queue consumer
          -> R2 latest_state
          -> R2 latest_snapshots/v1 objects
          -> manifest

Scheduled Cloudflare Worker
  -> prune/rebuild stale windows
  -> periodic health/check reports
```

The migration plan should compare current GCP components with Cloudflare replacements:

| Current | Candidate Cloudflare replacement |
|---|---|
| GCP Pub/Sub observation messages | Cloudflare Queues |
| Cloud Run latest snapshot builder | Cloudflare Queue consumer Worker |
| Cloud Scheduler every-minute trigger | Cloudflare Cron Trigger |
| R2 latest state and snapshot objects | Keep R2 |
| Latest snapshot R2 API Worker | Keep or simplify |
| Cache proxy latest snapshot route | Keep |

Important migration questions:

- can all current ingest paths emit Cloudflare Queue messages?
- do we still need the GCP Pub/Sub writer?
- can the Cloudflare consumer safely update the full snapshot matrix within Worker CPU/subrequest limits?
- do we need Durable Objects for locking/serialising latest-state writes?
- what is the rollback plan if Cloudflare latest snapshots fail?
- should PAF overlay be used as the prototype for the Cloudflare latest-snapshot replacement?

## 11. Open questions

1. Exact PurpleAir local JSON fields to map.
2. A/B channel policy: separate, averaged, or both.
3. Whether PAF PM0.3/particle-count fields appear publicly in v1.
4. Whether to use one R2 object per raw reading or hourly JSONL batches.
5. Whether latest snapshot overlay is merged in cache proxy or website.
6. Whether PAF should appear as a separate network group first.
7. How to handle Pi local spool limits and replay after outages.
8. Whether per-device tokens live only in Worker env vars, KV, D1 or Supabase device table.
9. Whether device config can be remotely updated via Tailscale/Git pull only, or needs central config pulled by the Pi.
10. Whether the follow-up GCP latest snapshot migration should replace the existing pipeline fully or run in parallel first.

## 12. Draft implementation phases

### Phase 0: confirm sample data

- get a real PurpleAir local `/json` sample
- define v1 field mapping
- decide public fields
- decide station/timeseries labels

### Phase 1: local forwarder proof

- build fake PurpleAir local JSON server
- build Python forwarder
- test POST to local mock endpoint
- add local spool/retry
- create systemd unit template

### Phase 2: Cloudflare ingest Worker

- create PAF ingest Worker in `uk-aq-ops`
- implement device auth
- implement R2 raw write
- implement Supabase RPC call
- implement queue send
- add basic health endpoint

### Phase 3: Supabase schema/RPC

- add PAF device registry table or connector-specific config table
- add raw payload audit table if not using an existing raw schema table
- add ingest RPC
- add tests using captured sample payloads

### Phase 4: PAF latest overlay

- create Cloudflare Queue
- create queue consumer Worker
- create PAF latest-state and overlay snapshot keys in R2
- add scheduled stale-window cleanup
- add manifest

### Phase 5: website integration

- display PAF as a network or network group
- decide whether to merge overlay into current latest snapshot path
- ensure chart mode can load PAF timeseries from normal observations

### Phase 6: hardware deployment

- prepare Raspberry Pi OS Lite image
- install Tailscale and optionally Raspberry Pi Connect
- install forwarder repo and systemd service
- configure device ID/token
- test with fake sensor and real PurpleAir local endpoint
- post to friend

### Phase 7: follow-up migration plan

- create separate MD plan for moving GCP Pub/Sub/latest-snapshot builder to Cloudflare
- use PAF overlay as a small proof of the Cloudflare latest-snapshot approach

