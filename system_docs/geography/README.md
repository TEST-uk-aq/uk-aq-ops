# Geography and postcode products

## Purpose

This area is the authoritative system documentation for the R2-backed UK postcode and administrative-boundary lookup products owned by `uk-aq-ops`.

The products are:

- exact postcode lookup and postcode suggestions built from ONSPD;
- PCON and local-authority boundary shards used for coordinate enrichment.

## Reading order

1. [`postcode_lookup.md`](postcode_lookup.md)
2. [`boundary_shards.md`](boundary_shards.md)
3. [`source_versions.md`](source_versions.md)
4. [`operations.md`](operations.md)
5. [`validation.md`](validation.md)

## Implementation ownership

- `scripts/postcodes/`
- `scripts/geography/`
- `workers/shared/postcode_lookup.mjs`
- `workers/uk_aq_postcode_lookup_r2_api_worker/`
- postcode routes in the cache proxy
- geography consumers in the ingest repository

## Authority boundaries

The postcode Worker is a trusted upstream service, not a direct public browser API. Website clients should use the cache-proxy route.

Boundary shards are an internal lookup product. They are not a public boundary API.
