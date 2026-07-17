# PCON and local-authority boundary shards

## Purpose

The boundary shard product replaces a runtime PostGIS dependency for station geography enrichment with compact R2 objects supporting:

- latitude/longitude to Westminster parliamentary constituency, PCON;
- latitude/longitude to local authority, LA.

The daily enrichment consumer is owned by the ingest repository. This product is not a public API.

## Source handling

The builder accepts local GeoJSON files directly and can optionally resolve configured source files from Dropbox.

Mixed source coordinate reference systems are supported. Current source data may include EPSG:4326 and EPSG:27700; output geometry and bounding boxes are normalised to EPSG:4326.

## Layout

The default prefix is `v1`:

```text
v1/
  manifest.json
  by_code/
    pcon/<version>/<code>.json
    la/<version>/<code>.json
  pcon/<detail>/grid_<size>/<tile>.json
  la/<detail>/grid_<size>/<tile>.json
  adjacency/pcon_<version>.json
  adjacency/la_<version>.json
```

A full feature geometry is stored once under `by_code/`. Tile shards contain only the feature code, name, bounding box and geometry reference.

## Tiling contract

- Canonical tile identity uses integer latitude and longitude indices, not serialised floating-point boundaries.
- A feature reference is included in every tile overlapped by its bounding box.
- MultiPolygon parts are tiled independently and de-duplicated by tile key.
- JSON objects are minified to reduce temporary disk and R2 storage use.
- Neighbouring-tile fallback may be required for points close to a tile or polygon boundary.

## Adjacency

The first implementation uses approximate bounding-box overlap adjacency. Consumers MUST NOT treat this as an exact topological neighbour contract.

## Object authority

`manifest.json` records the build configuration and source versions. Consumers must use a consistent prefix, grid size, boundary detail and source-version set.
