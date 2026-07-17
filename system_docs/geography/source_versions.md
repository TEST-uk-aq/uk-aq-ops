# Geography source versions

## Purpose

This file records the source-version contract for postcode and boundary products. A source update is an explicit data migration and must not occur accidentally during an unrelated code change.

## Current documented versions

| Product | Source | Version |
|---|---|---|
| Postcode exact and suggestions | ONS Postcode Directory | `ONSPD_MAY_2025` |
| Westminster parliamentary constituencies | ONS boundary GeoJSON | July 2024 / version `2024` |
| Local authorities | ONS boundary GeoJSON | May 2025 / version `2025` |

The build manifest is the authoritative record for a particular generated artefact. This document records the expected repository-wide selection.

## Compatibility rules

- Postcode and boundary products may use different publication dates.
- A code mismatch during validation may represent a genuine boundary change rather than a broken lookup.
- Name differences are secondary diagnostics because naming styles and vintages may differ.
- A source-version update must regenerate the complete affected prefix and its manifest.
- Consumers must not mix shards from two source versions under one manifest.

## Source paths

Local source paths are operator configuration and are not a portable system contract. Documentation examples should use placeholders or environment variables rather than a personal absolute path.

Optional Dropbox resolution uses the configured Dropbox base and path variables. Dropbox is a source transport, not the authority for the resulting R2 object contract.
