# Postcode lookup

## Purpose

The postcode product resolves a current UK postcode to coordinates and administrative codes, and provides compact prefix suggestions without loading the full UK dataset into Worker memory.

## Source and filtering

- Source dataset: ONS Postcode Directory, ONSPD.
- Current documented source: `ONSPD_MAY_2025`.
- Coverage includes the full United Kingdom, including Northern Ireland.
- Rows with a populated `DOTERM` are terminated postcodes and MUST be excluded from the active build.

Source versions are recorded in [`source_versions.md`](source_versions.md).

## R2 layout

With prefix `v1`:

```text
v1/manifest.json
v1/area_town_index.json
v1/postcode_prefix_hints.json
v1/shards/<AREA>.json
v1/suggest/<AREA>.json
```

Exact and suggestion data are separate because their access patterns and payload needs differ.

## Compact formats

An exact shard maps a normalised postcode to:

```text
[lat, lon, pcon_code, la_code, area_town_id]
```

A suggestion row is:

```text
[postcode_normalised, postcode_display, area_town_id, pcon_code, la_code]
```

`area_town_index.json` maps `area_town_id` to `[area_name, post_town]`. Area and town strings MUST NOT be repeated in every postcode row.

## Area and town derivation

Area and post-town labels are derived from ONSPD fields rather than Royal Mail PAF post towns.

Current fallbacks are:

- England and Wales area: `BUASD24 -> BUA24 -> PARISH -> OSWARD -> OSLAUA`;
- Scotland area: `OSWARD -> OSLAUA`;
- Northern Ireland area: `OSWARD -> OSLAUA`;
- post town: `TTWA -> BUA24 -> OSLAUA -> OSCTY`.

Pseudo or missing codes are ignored.

## Worker routes

Exact lookup:

- `GET /v1/postcode_lookup`
- aliases documented in the Worker-local README

Suggestion:

- `GET /v1/postcode_suggest`
- aliases documented in the Worker-local README

The trusted upstream request header is:

```text
x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>
```

Browser clients should use the cache-proxy routes rather than call this Worker directly.

## Suggestion behaviour

- query length 0 returns an empty result;
- query length 1 or 2 uses sampled real postcodes from `postcode_prefix_hints.json` and does not read a suggestion shard;
- query length 3 or more reads one area suggestion shard and filters by prefix;
- the default limit is 6 and the maximum is 10;
- count-only hint rows are not returned as postcode results.

## Response and caching

Successful exact and suggestion responses include resolved area/town labels when available. Exact success also includes coordinates and administrative codes.

- successful responses: `Cache-Control: public, max-age=86400`;
- error responses: `Cache-Control: no-store`;
- exact shards, suggestion shards and shared index files use bounded in-memory caching.

Public field names and compact row order are compatibility contracts.
