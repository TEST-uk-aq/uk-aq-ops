# TEST observation-history aligned-v2 candidate

## Calibration conclusion

This directory owns the isolated, non-authoritative TEST calibration path for
`timeseries-aligned-v2`. The physical-layout calibration completed on
2026-09-01.

The selected design is:

- partition remains UTC day / connector / pollutant;
- rows are ordered by timeseries, then observation time;
- one timeseries per independently decodable row group;
- dense timeseries are split into chronological segments;
- maximum segment / row-group size is **1,024 rows**;
- multiple row groups are packed into each Parquet file;
- each segment is indexed by its time bounds and physical coordinates;
- the serving index additionally owns the exact physical byte ranges required
  for `observed_at_utc` and `value`;
- the Worker does not need to fetch/parse the Parquet footer or decode
  `timeseries_id` for the selected hot path.

The selected physical-index implementation and CPU evidence are documented in:

```text
scripts/index_v3_physical_candidate_1024/README.md
```

The 2,048 physical-index candidate remains only as a calibration baseline.
Do not reopen row-cap calibration without new evidence that the selected
1,024-row contract is itself the bottleneck.

This prototype path never writes canonical history or index keys.

The selected design is now implemented by the shared production write path in
`workers/shared/uk_aq_observation_history_target_writer.mjs` and
`workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs`. This
candidate directory remains calibration evidence only; migration and
steady-state publication must not import or execute it.

## Why aligned-v2 exists

The earlier `timeseries-bounded-v1` layout allowed multiple timeseries to share
one independently decoded Parquet row group. The logical v3 index could identify
the requested rows, but the reader still had to decompress/decode unrelated
rows in the containing row group.

Representative old-layout amplification included:

- normal Sensor.Community TS7421: 288 wanted rows versus 8,103 physical rows;
- AURN: roughly 24 wanted rows versus roughly 3,400 physical rows;
- dense Sensor.Community TS7421 one-hour request: 527 wanted rows within a
  12,505-row timeseries row group.

`timeseries-aligned-v2` removes that cross-timeseries amplification. A normal
288-row timeseries/day becomes one independently decodable 288-row row group.
AURN timeseries similarly decode only their own rows. Dense timeseries are
chronologically split so a short request selects only the segment(s) whose time
bounds intersect the request.

The later physical-index experiment showed that logical segment coordinates are
not enough for a low-CPU Worker. The offline index must also carry the physical
column-byte information needed for direct decode. That is now considered part
of the intended v3 serving design rather than a separate optional optimisation.

## Cap decision

The original candidate generated 1,024, 2,048 and 4,096 row caps. The physical
index made 1,024 versus 2,048 directly comparable without footer/planning noise.

For dense TS7421 1h:

| Cap | Returned | Physical rows decoded | R2 bytes |
| --- | ---: | ---: | ---: |
| 1,024 | 527 | 1,024 | 4,840 |
| 2,048 | 527 | 2,048 | 9,263 |

Two repeated deployed TEST batches gave 20 CPU observations per workload and
cap:

| Workload | Cap | Mean CPU | Median CPU | P90 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| normal TS7421 24h | 1,024 | 7.3 ms | 6.5 ms | 9 ms | 15 ms |
| normal TS7421 24h | 2,048 | 7.9 ms | 7 ms | 9 ms | 19 ms |
| dense TS7421 1h | 1,024 | 7.65 ms | 7 ms | 11 ms | 16 ms |
| dense TS7421 1h | 2,048 | 10.2 ms | 9 ms | 16 ms | 16 ms |

The normal workload is effectively unchanged, while 1,024 materially reduces
the dense short-read amplification and CPU distribution. Therefore **1,024 is
the selected maximum segment size**.

A dense full-day request still returns 12,505 observations and remains costly
regardless of the cap. That is a separate request-size/CPU problem and is not a
reason to increase the selected segment size.

## Stage and generate locally

The tools require R2 credentials to already be exported as configuration data:
`CFLARE_R2_ENDPOINT`, `CFLARE_R2_BUCKET`, `CFLARE_R2_ACCESS_KEY_ID`, and
`CFLARE_R2_SECRET_ACCESS_KEY`. They also require `UKAQ_ENV_NAME=TEST`.

```bash
export UKAQ_ENV_NAME=TEST
node scripts/index_v3_aligned_candidate/stage_source.mjs \
  --output-root tmp/index_v3_aligned_candidate_source \
  --replace

python3 -m venv /tmp/uk_aq_aligned_v2_env
/tmp/uk_aq_aligned_v2_env/bin/pip install \
  -r scripts/index_v3_aligned_candidate/requirements.txt
/tmp/uk_aq_aligned_v2_env/bin/python \
  scripts/index_v3_aligned_candidate/generate.py \
  --environment TEST \
  --source-root tmp/index_v3_aligned_candidate_source \
  --output-root tmp/index_v3_aligned_candidate \
  --replace

node scripts/index_v3_aligned_candidate/validate_local.mjs \
  --output-root tmp/index_v3_aligned_candidate
```

`stage_source.mjs` performs GET requests only. Generation and validation are
local. The calibration object root is:

```text
history/_prototype/observation-history/timeseries-aligned-v2/cap_rows=<cap>/
```

Historical prototype caps remain useful for reproducing calibration evidence,
but 1,024 is the selected design for subsequent implementation work.

The default staging profile and generator inputs above remain the original
calibration fixture. The reviewed consecutive TS7421 extension uses
`--profile sensorcommunity-normal-multiday-extension` to stage only
2026-08-21 through 2026-08-26. The generator's repeatable
`--partition ROLE=DIRECTORY` option selects only those staged directories and
`--caps 1024` prevents regeneration of rejected calibration caps. Exact
commands and overlay validation are in
`scripts/index_v3_physical_leaf_candidate/README.md`.

## Publish after review

The first command is idempotent and skips objects whose stored SHA-256 is
already identical. It stops on a differing object. Add `--replace-existing`
only after reviewing the exact same cap/partition namespace.

```bash
export UKAQ_ENV_NAME=TEST
node scripts/index_v3_aligned_candidate/publish.mjs \
  --plan tmp/index_v3_aligned_candidate/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2
```

## Further CPU optimisation

Do not use further row-cap experiments as the default next step. The remaining
hot-path investigation should focus on fixed per-request work such as index
JSON parsing/validation, child-index SHA verification, per-file identity HEADs,
and response construction/JSON serialisation while preserving the current
fail-closed integrity guarantees.
