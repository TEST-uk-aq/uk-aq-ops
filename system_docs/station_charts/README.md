# Shared station-chart system area

## Purpose

This directory is the authoritative frontend architecture and behaviour contract for UK AQ station charts.

It governs the shared browser implementation used by:

- the Hex Map multi-sensor chart;
- the Sensors single-sensor chart;
- future website pages that render the same station observation and AQI history.

It exists because station-chart loading, caching, AQI-source switching, pollutant switching, D3 rendering and page-specific controls must no longer be implemented as one large inline script or duplicated between pages and data-source modes.

## Authoritative reading order

1. [`contract.md`](contract.md)
2. [`pollutant-switch-contract.md`](pollutant-switch-contract.md)
3. [`../aqi-levels/station-history-contract.md`](../aqi-levels/station-history-contract.md)
4. [`../aqi-levels/station-history-validation.md`](../aqi-levels/station-history-validation.md)
5. [`../r2_history/interfaces.md`](../r2_history/interfaces.md)
6. [`../r2_history/continuity.md`](../r2_history/continuity.md)
7. repository `AGENTS.md` and linked `AGENTS_BASE.md`

## Contract precedence

This area governs browser module boundaries, browser state ownership, chart-controller behaviour, page adapters, rendering ownership and AQI-source-switch user experience.

[`pollutant-switch-contract.md`](pollutant-switch-contract.md) is the narrower authority for replacing the chart when the selected pollutant changes. It distinguishes pollutant replacement from the initial chart render, same-pollutant sensor changes and AQI-source-only changes.

The AQI and R2-history areas remain authoritative for:

- observation and AQI source precedence;
- continuity and physical identity;
- API request and response semantics;
- AQI algorithms, timestamps, averaging and missing reasons;
- persisted R2 history and validation.

Where older station-history wording assumes that chart orchestration lives directly in `hex_map/index.html`, the contracts in this directory govern the modular frontend implementation.

## Implementation ownership

The implementation belongs in the TEST website repository:

```text
TEST-uk-aq/TEST-uk-aq.github.io
```

The final shared implementation is expected under:

```text
/station_chart/
```

with page-specific adapters under their page directories.

During migration, existing shared files such as `station-history-loader.js` may act as compatibility facades, but the final chart implementation must follow [`contract.md`](contract.md) and [`pollutant-switch-contract.md`](pollutant-switch-contract.md).

## Documentation boundary

This directory does not redefine Worker calculations, R2 layouts, continuity families or AQI breakpoints.

Codex and other coding agents must read these files but must not edit `system_docs/`. Implementation differences must be reported to ChatGPT in Chat mode for documentation review.