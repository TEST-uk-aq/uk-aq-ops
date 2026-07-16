# Complete affected-area list

The phase plan will need to cover these areas:

1. **Shared pollutant validity definition**
2. **All connector observation write paths**
3. **All connector metadata/discovery paths**
4. **`timeseries.last_value` and `last_value_at` updates**
5. **Connector checkpoint schemas**
6. **Polling cursor and window logic**
7. **Connector run-level `last_observed_at`**
8. **Latest-snapshot state application**
9. **Latest-snapshot rebuilding and remediation**
10. **AQI and WHO derived calculations**
11. **Public chart/timeseries presentation**
12. **Freshness dashboards and integrity reporting**
13. **One-off repair of existing invalid current state**
14. **System documentation**

The raw observation, Pub/Sub history, R2 backup and pruning paths should generally retain invalid source values and therefore require confirmation rather than filtering changes.




Yes. The three areas you listed are the core of the fix, but the analysis shows several other places where the same distinction between **last received observation** and **last valid current value** matters.

I would divide the affected system into six definite areas, plus several places that need auditing but may not require changes.

# Definite additional areas

## 1. Connector metadata and discovery paths

This is separate from ordinary observation polling.

Some connectors populate `timeseries.last_value` and `last_value_at` from source-supplied timeseries metadata, such as an SOS `lastValue`, rather than deriving them only from newly inserted observations.

The UK-AIR SOS code has multiple routes that can populate these fields:

* timeseries discovery;
* recent refresh;
* historical backfill;
* normal polling.

The existing code specifically handles nested source shapes such as:

```text
lastValue: {
  timestamp,
  value
}
```

and writes them into `timeseries.last_value` and `last_value_at`.

Therefore, changing only the normal observation writer would leave another route through which `-99` could become the current value.

### Required outcome

Every path that writes `timeseries.last_value` must use the same validity policy, including:

* discovery metadata;
* recent polling;
* historical backfills;
* repair scripts;
* station or timeseries catalogue refreshes.

This applies across every connector, not just SOS.

---

## 2. Derived AQI and WHO products

Invalid pollutant values must be excluded before any calculation, not merely hidden from the latest snapshot.

This includes:

* hourly pollutant values;
* hourly AQI;
* rolling 24-hour pollutant means;
* DAQI;
* European AQI;
* WHO daily status;
* calendar-year summaries;
* rolling-year summaries;
* any cached or precomputed AQI datasets.

For pollutants, the base lower-bound rule should be:

```text
value >= 0
```

Zero is valid. Negative concentrations are not.

Upper limits can remain property-specific, such as the limits already applied by the latest-snapshot service.

### Why this is separate

A `-99` row can remain correctly stored in history but must not be included in an average. Otherwise, it could lower an hourly or daily mean even though it never appears on the map.

This is a definite change or confirmation point in `uk-aq-ops`.

---

## 3. Public chart and timeseries output

The history store should preserve the raw `-99`, but normal website chart APIs should not return it as a plotted concentration.

It should normally become:

```text
null
```

or be omitted from the display series so that the chart shows a gap.

Otherwise:

* the chart axis can extend below zero;
* hover text can show `-99 µg/m³`;
* averages calculated in the browser could be corrupted;
* the user may interpret it as a genuine measurement.

### Recommended separation

* Raw or diagnostic history endpoint: preserve `-99`.
* Normal public chart endpoint: convert invalid pollutant values to missing points.
* AQI endpoint: exclude invalid values entirely from calculations.

This may already be happening in some routes, but it needs auditing across the current R2-first chart path and any Supabase fallback path.

---

## 4. State rebuilding and recovery tools

Fixing future processing will not repair existing poisoned state.

The following can already contain an invalid latest value:

* `timeseries.last_value`;
* `timeseries.last_value_at`;
* R2 latest-snapshot state;
* generated latest snapshot files;
* browser or edge caches.

Any state-seeding or rebuild script also needs the corrected definition of “latest”:

```text
latest valid observation
```

not:

```text
latest observation, followed by filtering
```

A seed process based solely on the current `timeseries.last_value` will not be sufficient until those database fields have first been repaired.

### Required one-off recovery

For every pollutant timeseries:

1. Find the newest stored observation with a finite value `>= 0` and within any configured upper limit.
2. Update `timeseries.last_value` and `last_value_at`.
3. Rebuild latest-snapshot state from those valid values.
4. Regenerate the public snapshot files.
5. Clear or allow expiry of related caches.

This should be part of the eventual phase plan.

---

## 5. Freshness dashboards, integrity checks and operational reporting

Several reports currently use `timeseries.last_value_at` as a general freshness measure. For example, historical repository work added freshness reports comparing `timeseries.last_value_at` with the latest `observations.observed_at`.

After the change:

* `last_value_at` means latest **valid** observation;
* checkpoint `last_observed_at` means latest **received and stored** observation;
* `last_polled_at` means latest attempted poll.

Those are three different kinds of freshness.

### Operational implications

A sensor could show:

```text
last_polled_at    = 12:15
last_observed_at  = 12:00
last_value_at     = 08:00
```

That would mean:

* it was polled recently;
* it supplied a recent observation;
* its latest usable value is four hours old.

Existing dashboards and integrity checks may otherwise incorrectly classify that sensor as simply “stale” or “not responding”.

They should distinguish at least:

* polling stale;
* source data stale;
* valid data stale;
* receiving invalid values.

This does not require storing a validity status in the checkpoint. The difference between `last_observed_at` and `last_value_at` provides that information, and the raw row can be inspected when needed.

---

## 6. Connector run summaries

There is already a connector-run-level `last_observed_at` concept in parts of the ingest system. Previous work added it to ingest run summaries and sometimes derived it from `timeseries.last_value_at` as a fallback.

That fallback will become semantically wrong.

A run-level `last_observed_at` should mean:

```text
maximum observed_at successfully received and stored during the run
```

It should not be derived from `timeseries.last_value_at`, because the latter will deliberately ignore invalid observations.

This needs checking in:

* connector run-row insertion;
* run summaries;
* Cloud Run wrapper summaries;
* dashboard displays;
* fallback logic used when an ingest response omits `last_observed_at`.

# Checkpoint tables and polling logic

Your proposed checkpoint change is correct, but it should not necessarily be applied identically to every connector.

## UK-AIR SOS

This definitely needs:

```sql
last_observed_at timestamptz null
```

The checkpoint was created to rotate timeseries according to `last_polled_at`, including when a timeseries stopped sending data.

The resulting meanings should be:

| Field                         | Meaning                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `last_polled_at`              | Last poll attempt                                        |
| checkpoint `last_observed_at` | Newest observation received and stored, valid or invalid |
| `timeseries.last_value_at`    | Newest valid observation                                 |
| `timeseries.last_value`       | Newest valid value                                       |

Polling windows and source cursors should use checkpoint `last_observed_at` where the objective is to avoid repeatedly downloading already-received rows.

## Other connectors

Each connector needs an inventory of its existing cursor or checkpoint mechanism.

Possible patterns include:

* per-timeseries checkpoint;
* per-station checkpoint;
* source pagination cursor;
* source `datetimeFrom`;
* connector-level last-poll timestamp;
* `timeseries.last_value_at` being used as an implicit cursor.

The rule should be:

> Add `last_observed_at` only to the checkpoint level at which source progress is actually tracked.

For example, if a connector polls an entire station at once, a station checkpoint may be more appropriate than adding a row for every timeseries.

The important change is not “add the column to every table”. It is:

> Stop using `timeseries.last_value_at` as both the valid-value timestamp and the ingest cursor.

# Places that probably do not need behavioural changes

## Raw observation tables

These should continue to accept `-99`.

That includes:

* primary `observations`;
* `observs`;
* R2 observation history;
* Parquet history exports;
* observation indexes.

These represent what the source actually supplied.

No database constraint should require pollutant values to be non-negative at this storage level.

## Observs Pub/Sub publisher

The publisher should continue publishing `-99`, because the same stream is used to populate raw `observs` history as well as feed downstream consumers.

The latest-snapshot subscription should reject invalid values when applying rows to current state.

## History backup and pruning

Backup and prune operations should preserve `-99` like any other raw observation.

They may need no code change, but their integrity rules must not classify a preserved sentinel as a damaged backup merely because it is negative.

## Public latest views and RPCs

Existing public latest queries already defensively filter negative values in places. Repository history shows these were changed to require `last_value >= 0`.

Those filters can remain as defence in depth.

Once `timeseries.last_value` is guaranteed valid, they should no longer be the primary mechanism preventing bad values from reaching users.

# One unresolved design detail: upper limits

The lower-bound policy for pollutant concentrations is clear:

```text
finite value AND value >= 0
```

There is still a design decision over upper bounds.

The latest snapshot currently has pollutant-specific outlier limits. If those upper limits also determine whether `timeseries.last_value` is updated, then the system needs one authoritative definition shared by:

* ingest;
* snapshot state;
* AQI generation;
* public chart output;
* repair tooling.

Otherwise, a value might be:

* accepted into `timeseries.last_value`;
* rejected by latest snapshot;
* accepted or rejected differently by AQI.

The eventual plan should therefore include centralising pollutant current-value validity, rather than copying threshold values into multiple services.

