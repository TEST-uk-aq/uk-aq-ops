# Geography operations

## Postcode build

From the repository root:

```bash
npm run postcode:build -- \
  --input "/path/to/ONSPD_MAY_2025_UK.csv" \
  --output "tmp/postcode_lookup_v1" \
  --prefix "v1"
```

The build clears its output directory before writing the new artefact.

## Postcode upload

```bash
npm run postcode:upload -- \
  --input-dir "tmp/postcode_lookup_v1"
```

The uploader clears existing objects under the target prefix unless `--skip-clear-prefix` is supplied.

Postcode suggestion cache purging is conditional and best effort:

- it is attempted unless `--skip-cache-purge` is supplied;
- purge hosts come from repeated `--cache-purge-origin` arguments or `UK_AQ_CACHE_ALLOWED_ORIGINS`;
- an API token must be available;
- the zone may be supplied or resolved from the configured hosts;
- when required inputs are absent, upload completes with an explicit purge-skip reason.

Do not state that cache purge is permanently disabled.

## Boundary build

```bash
npm run geo:build-shards -- \
  --pcon-geojson "/path/to/pcon.geojson" \
  --la-geojson "/path/to/la.geojson" \
  --output-dir "${UK_AQ_GEO_SHARD_OUTPUT_DIR:-$HOME/tmp/geo_lookup_v1}" \
  --prefix "${UK_AQ_GEO_R2_PREFIX:-v1}" \
  --grid-size "${UK_AQ_GEO_GRID_SIZE_DEGREES:-0.05}" \
  --boundary-detail "${UK_AQ_GEO_BOUNDARY_DETAIL:-detailed}" \
  --pcon-version "${UK_AQ_GEO_PCON_VERSION:-2024}" \
  --la-version "${UK_AQ_GEO_LA_VERSION:-2025}"
```

## Boundary upload

```bash
npm run geo:upload-shards -- \
  --input-dir "${UK_AQ_GEO_SHARD_OUTPUT_DIR:-$HOME/tmp/geo_lookup_v1}" \
  --prefix "${UK_AQ_GEO_R2_PREFIX:-v1}"
```

## Configuration boundaries

Build inputs, output directories, bucket, prefix, grid size and source versions must be explicit or resolve to documented defaults.

Credentials remain environment configuration. They must not be written into manifests or documentation examples.

## Rollback

Retain the previous complete prefix or a verified backup until the new product has passed TEST operational validation. Rollback restores a complete manifest and matching object set, not a mixture of individual shards from different builds.
