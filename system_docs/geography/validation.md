# Geography validation

## Pre-upload structural checks

Run the existing structural checks for the changed scripts:

```bash
node --check scripts/postcodes/build_postcode_lookup_from_onspd.mjs
node --check scripts/postcodes/upload_postcode_lookup_to_r2.mjs
node --check scripts/geography/build_pcon_la_lookup_shards.mjs
node --check scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs
python3 -m py_compile scripts/geography/validate_r2_geo_lookup_against_stations.py
```

Before upload, confirm that the generated manifest names the intended source versions and that every referenced shard file exists.

## Postcode compatibility checks

Use the repository checks where relevant:

```bash
npm run postcode:check-geography -- \
  --postcode-dir "tmp/postcode_lookup_v1" \
  --pcon-geojson "/path/to/pcon.geojson" \
  --la-geojson "/path/to/la.geojson"

npm run validate:hexmap:2025
```

## Boundary TEST validation

After uploading to TEST, validate a bounded sample of stations that already have stored PCON and LA codes:

```bash
UK_AQ_GEO_VALIDATE_LIMIT=100 \
UK_AQ_GEO_VALIDATE_RANDOM_SEED=42 \
UK_AQ_GEO_VALIDATE_OUTPUT=logs/geo_validate/latest.json \
npm run geo:validate-stations
```

Interpret results as follows:

- code mismatches are the primary signal;
- name mismatches are secondary and may indicate source-version drift;
- a no-match requires checking tile coverage, geometry completeness and boundary-edge fallback;
- a neighbouring-tile match can be correct near a boundary;
- stored station values are not a perfect oracle when they were produced from a different boundary vintage.

## Postcode TEST validation

After upload and Worker deployment, verify through the trusted or cache-proxy route that:

1. a current postcode resolves to the expected coordinates and codes;
2. a terminated postcode is not returned as active;
3. one- and two-character suggestions return sampled real postcodes without a shard read;
4. a three-character query reads the expected area shard;
5. an unauthorised direct Worker request is rejected;
6. success responses are cacheable and errors are `no-store`;
7. a new upload either purges configured suggestion-cache prefixes or reports an explicit skip reason.
