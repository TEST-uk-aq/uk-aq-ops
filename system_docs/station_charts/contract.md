# Shared station-chart frontend contract

## Authority

This is the authoritative frontend architecture and behaviour contract for UK AQ station charts.

It governs:

- shared station-chart modules;
- browser state ownership;
- observation and AQI loading orchestration;
- AQI-source switching;
- D3 rendering boundaries;
- cache and request-settlement behaviour in the browser;
- page-specific adapters;
- chart-local diagnostics and user-facing error behaviour.

It deliberately replaces the assumption that station-chart behaviour may be implemented directly inside one page's inline script.

The AQI and R2-history contracts remain authoritative for data meaning, source precedence, continuity, API fields, timestamps and AQI calculation rules.

## Problem being corrected

The current website implementation has accumulated too many responsibilities in `hex_map/index.html` and maintains overlapping calculated-history and compatibility chart paths.

That structure has produced:

- duplicated AQI request planning and cache interpretation;
- duplicated source-switch transitions;
- multiple owners for loading, cancellation and error messages;
- page resize and chart-load behaviour affecting AQI-source switching;
- browser allow-lists of Worker diagnostic strings controlling visible success or failure;
- repeated fixes in one path that do not reliably apply to the other;
- difficulty reusing the same chart on other pages.

The modularisation is an architectural correction, not a visual redesign or AQI algorithm change.

## Required outcome

The website must have one shared station-chart subsystem that can be configured by page adapters.

The subsystem must provide:

1. one chart controller;
2. one browser cache and request-settlement model;
3. one AQI-source controller;
4. one D3 renderer;
5. one calculated station-history data client;
6. one compatibility data client behind the same client interface;
7. one bounded diagnostics interface;
8. thin page adapters for page-specific controls and selection state.

The Hex Map and Sensors pages must not maintain independent copies of chart loading, caching, AQI interpretation or rendering logic.

## Target active structure

The final active website structure must be equivalent to:

```text
/station_chart/
  station-chart-domain.js
  station-chart-cache.js
  station-history-client.js
  station-history-compatibility-client.js
  aqi-source-controller.js
  station-chart-renderer.js
  station-chart-controller.js
  station-chart-diagnostics.js

/hex_map/
  hex-map-station-chart-adapter.js
  index.html

/sensors/
  sensor-station-chart-adapter.js
  index.html
```

Exact filenames may be adjusted during implementation when an existing shared filename is clearly better, but the responsibilities and dependency directions in this contract must remain explicit.

`station-history-loader.js` may temporarily remain as a compatibility facade during migration. It must not remain a second chart controller after cutover.

## Module format

Shared chart code must live in external JavaScript files.

The final implementation must:

- use explicit imports/exports or one narrow documented namespace facade;
- avoid arbitrary page globals;
- be loadable by both supported website pages;
- keep pure state and classification helpers importable by focused Node tests;
- avoid copying the same function body into page files;
- avoid inline page scripts containing chart-controller, cache, request or D3 implementation.

Page HTML may contain configuration and a small bootstrap only.

## Dependency direction

Dependencies must flow in one direction:

```text
page adapter
  -> station-chart controller
      -> AQI-source controller
      -> cache
      -> data client
      -> renderer
      -> diagnostics
```

The renderer must not call the data client.

The data client must not manipulate the DOM.

The cache must not call fetch or D3.

The AQI-source controller must not draw observation lines.

Page adapters must not interpret Worker completeness or AQI calculation statuses.

## Shared domain module

`station-chart-domain.js` owns pure values and normalisation used across modules, including:

- authoritative sensor identity;
- chart range snapshots;
- selected sensor ordering;
- AQI-source identity;
- request generation identity;
- chart load reasons;
- terminal request outcomes;
- cache keys;
- canonical hour endpoints.

It must contain no DOM, D3, fetch or page-specific state.

A chart range used for an AQI-source-only switch must be an immutable snapshot of the currently displayed x-domain.

## Shared cache module

`station-chart-cache.js` is the sole owner of browser observation and AQI cache semantics.

It must keep observation and AQI data separately by authoritative identity, connector, pollutant and range.

For AQI it must distinguish:

```text
available rows
request settlement
response diagnostics
freshness
```

It must not use the existence of blank AQI hours as proof that the request was not performed.

### Successful calculated response settlement

For browser source-switch planning, a calculated AQI response is terminal and settled for its requested range when all of the following are true:

- the HTTP request succeeded;
- the response is parseable;
- the authoritative request identity is valid;
- the AQI section has the expected structural shape;
- no replacement conflict makes the result unsafe to use.

This remains true when:

- `response_complete=false`;
- `has_gap=true`;
- some DAQI or European AQI values are null;
- observations are missing for some hours;
- rolling samples are insufficient;
- the Worker returns a recognised or previously unseen calculation status or missing-reason string;
- the response contains valid rows for only part of the requested range;
- the response contains no valid AQI row for a period that was nevertheless successfully evaluated.

The browser must retain the response diagnostics but must not maintain an exhaustive allow-list of Worker diagnostic strings as a condition of visible success.

Unknown calculation statuses, missing reasons or partial reasons must be recorded as bounded diagnostics. They must not by themselves turn an otherwise parseable successful AQI response into a user-facing failure.

The response must not be relabelled complete merely because it is settled for browser request planning.

### Retryable failure settlement

An AQI interval remains unsettled and retryable when the browser cannot safely use the response because of:

- network or HTTP failure;
- aborted or obsolete request before a usable terminal result;
- unparseable or structurally malformed response;
- invalid authoritative identity;
- unsafe conflicting replacement rows;
- another explicit contract failure that prevents accurate interpretation.

Manual Refresh, range change, cache expiry or a later normal chart load may retry such an interval.

Switching AQI source must not repeatedly request a successfully evaluated range merely because its AQI bands contain gaps.

## Data-client interface

All chart controllers must consume one common client interface equivalent to:

```text
loadCurrent(request, parts, signal)
loadOlder(request, parts, signal)
prefetchAqi(request, signal)
```

The request must include:

```text
connector_id
timeseries_id
pollutant
start_utc
end_utc
include_observations
include_aqi
```

The calculated station-history client is the default active client when the feature is enabled.

The compatibility client may read the retained stored-AQI path, but it must return the same browser-facing result shape and use the same controller, cache, source-switch and renderer modules.

There must not be a separate compatibility chart controller or a second AQI-source state machine.

The compatibility client is a data-source adapter, not an alternative frontend architecture.

## Station-chart controller ownership

`station-chart-controller.js` is the sole owner of one chart instance's orchestration.

It owns:

- current selected sensor list;
- selected AQI source;
- displayed range;
- load generation;
- active request cancellation;
- current data client;
- chart lifecycle;
- foreground request priority;
- background AQI prefetch scheduling;
- interaction with the renderer.

The controller must expose an interface equivalent to:

```text
setSelection(entries)
setAqiSource(stationId)
setRange(range)
refresh()
resize(dimensions)
destroy()
```

A page adapter must not call internal cache or renderer functions directly.

The controller must ensure that obsolete work cannot commit visible output.

## AQI-source controller ownership

`aqi-source-controller.js` is the sole owner of AQI-source-switch state.

It owns:

- source-switch generation or token;
- exact displayed-range snapshot;
- old-layer clearing;
- the approximately 50 millisecond transition;
- whether target AQI work is required;
- atomic staging and one visible commit;
- cancellation and obsolete-result rejection;
- AQI-local terminal diagnostics.

It must not own observation fetching, observation rendering, x-axis changes, y-axis changes or full-chart loading state.

### AQI-source switch sequence

For an already displayed chart:

1. snapshot the exact displayed x-domain;
2. invalidate any older source switch;
3. clear the old AQI layer immediately;
4. start the approximately 50 millisecond transition immediately;
5. inspect AQI settlement for the exact displayed range;
6. start no AQI request when the target range is settled;
7. start only required AQI requests when it is not settled;
8. never start an observation request solely because AQI source changed;
9. stage AQI results without visible per-chunk repaint;
10. wait only for the transition and required AQI work;
11. commit all available target-source AQI bands once;
12. leave hours without a valid AQI value blank;
13. return without repainting retained observation lines, symbols, axes or guideline layers.

A settled cached switch should normally finish in about 50 milliseconds plus one JavaScript and SVG update turn.

An uncached switch may take longer only while required AQI requests complete.

## Renderer ownership

`station-chart-renderer.js` is the sole owner of D3 and SVG chart drawing.

It owns:

- chart frame creation and destruction;
- x-axis and y-axis rendering;
- observation paths and symbols;
- AQI band layers;
- guideline and chart overlays;
- tooltip geometry;
- resize behaviour;
- incremental drawing methods.

It must expose narrow operations equivalent to:

```text
initialise(frame)
renderObservations(state)
renderAqi(state)
clearAqi()
renderAxes(state)
resize(dimensions)
destroy()
```

The renderer must not:

- fetch data;
- interpret API completeness;
- own request tokens;
- decide whether a range is settled;
- choose the AQI source;
- set page-wide status messages.

An AQI-only render must not rebuild observation paths or axes when the displayed range and y-domain are unchanged.

## Diagnostics ownership

`station-chart-diagnostics.js` owns bounded chart diagnostics.

It may record:

- request timing;
- cache hit or miss;
- selected source identity;
- request and transition generation;
- request outcome;
- response completeness and gap metadata;
- unknown diagnostic values;
- visible commit count;
- whether observation work was started or awaited.

It must not log full observation or AQI row arrays.

Diagnostics must not be awaited by the visible AQI switch.

## User-facing message contract

AQI-source switching must not use the chart-wide red error banner.

The following are never chart-wide user-facing errors:

- missing AQI hours;
- incomplete rolling context;
- partial AQI response;
- unknown calculation status;
- unknown missing reason;
- unknown partial reason;
- a successfully evaluated range with no valid AQI band;
- a retryable AQI-only request failure while the observation chart remains usable.

For any of those cases, valid AQI bands are shown and unavailable intervals remain blank.

A confirmed AQI-only transport, parsing or identity failure may be represented by an AQI-local unavailable state inside the AQI band area, but it must not replace, obscure or relabel the observation chart and must not leave a stale page-wide message.

The existing page-wide chart message area remains available for failures that prevent the observation chart or selected sensor data from loading accurately.

Resize must neither create nor clear AQI request ownership. A resize only updates geometry.

## Loading-state contract

A settled AQI-source switch must not activate full-chart loading state.

An uncached AQI-source switch may show only an AQI-local loading state while keeping observation lines and controls usable.

Initial chart load, range change, refresh and added-sensor observation loading may use the normal chart loading and progress behaviour.

Background AQI prefetch must never delay visible chart completion.

## Page-adapter contract

### Hex Map adapter

`hex-map-station-chart-adapter.js` owns only Hex Map integration, including:

- deriving the selected area and pollutant;
- providing ordered selected sensor entries;
- mapping Hex Map sensor symbols and chips;
- forwarding AQI-source selection;
- forwarding chart-range and Refresh controls;
- mounting and destroying the shared chart controller;
- updating Hex Map page URL and surrounding page state where required.

It must not contain cache, fetch, AQI classification or D3 path logic.

### Sensors adapter

`sensor-station-chart-adapter.js` owns only Sensors-page integration, including:

- constructing the single selected sensor entry;
- mounting the shared chart controller;
- forwarding range and Refresh controls;
- adapting page-specific labels and layout.

It uses the same controller, data client, cache and renderer.

The absence of a multi-sensor AQI-source selector is a page-adapter configuration, not a different chart implementation.

## Event-listener and lifecycle contract

Each mounted chart instance must have one controller and one set of page-adapter listeners.

The adapter must remove listeners and call `destroy()` when the chart is replaced or the page mode changes.

The modularisation must not create duplicate source-change, resize, Refresh or range-change handlers.

Window resize must call the controller's resize operation and must not reload chart data unless the displayed range or data request genuinely changes.

## Inline-page boundary

After final cutover, `hex_map/index.html` and `sensors/index.html` must contain only:

- markup;
- page-wide styles or linked stylesheets;
- page configuration;
- external script/module references;
- a small page bootstrap.

They must not contain implementations of:

- station-history fetch clients;
- chart caches;
- AQI settlement classification;
- AQI-source switching;
- D3 observation or AQI drawing;
- chart error ownership;
- station-chart request scheduling.

New station-chart behaviour must not be added to the inline monolith during migration unless it is the smallest wiring needed to transfer ownership to a shared module.

## Migration contract

Modularisation must be incremental and reversible through normal source control.

During migration:

1. extract pure modules before changing their behaviour;
2. retain narrow facades where existing page code still calls an old function;
3. move one responsibility at a time;
4. cut over one page adapter at a time;
5. do not maintain old and new active implementations after a responsibility has moved;
6. remove retired inline code as soon as its shared replacement is active;
7. keep the compatibility data source behind the shared client boundary;
8. do not add a new long-lived feature flag solely to preserve duplicate frontend implementations.

The current false AQI error and repeated-switch delay must be corrected through the shared AQI-source and cache ownership, not by another page-local conditional.

## Preserved behaviour

The refactor must preserve:

- maximum selected-sensor count and symbol ordering;
- chart-range controls;
- existing concentration-line values;
- exact hour-ending AQI band alignment;
- DAQI and European AQI labels and colours;
- blank intervals for missing AQI;
- observation and AQI source precedence;
- continuity-aware calculated AQI;
- no browser-side AQI calculation;
- bounded network concurrency;
- newest-first historical work planning;
- ordered settlement where required;
- background AQI prefetch;
- exact displayed-range reuse during AQI-source switching;
- 50 millisecond settled source-switch transition;
- no observation refetch or repaint for AQI-only source changes;
- feature-controlled compatibility data source;
- TEST-only scope until separately approved for LIVE.

## Explicit non-goals

This contract does not:

- change Worker routes or response calculation;
- change AQI breakpoints, averaging or supported pollutants;
- change R2 object layouts;
- change continuity families or physical identity;
- create AQI rows in Supabase;
- redesign the map or sensor-list product;
- add a frontend framework;
- require TypeScript or a build system;
- introduce browser-side AQI calculation;
- remove the compatibility data source before the existing feature rollback requirement is deliberately retired;
- modify LIVE repositories.

## Structural validation

Before deployment, use only the smallest checks needed to establish structural viability:

- syntax or module-import parsing for changed files;
- one directly relevant existing shared-loader or chart harness when affected;
- confirmation that page adapters resolve their imports;
- `git diff --check`.

Do not create a broad speculative test suite for the refactor.

Functional validation occurs after deployment through real TEST pages.

## TEST operational acceptance

The modular chart is accepted when normal TEST operation confirms:

1. the Hex Map chart loads multiple selected sensors;
2. the Sensors page loads the same shared chart for one sensor;
3. a settled AQI source switch clears old bands and commits new bands once in about 50 milliseconds;
4. AQI gaps remain blank without a chart-wide red error;
5. changing AQI source starts no observation request;
6. retained observation lines and axes do not repaint during an AQI-only switch;
7. a first uncached AQI source may wait for AQI data, then becomes a fast cache hit;
8. resize changes geometry only and does not clear or create AQI errors;
9. range change and Refresh still perform their intended data loads;
10. compatibility mode uses the same controller and renderer;
11. no duplicate event listeners or visible double commits occur;
12. bounded diagnostics show one controller generation and one AQI commit for each switch.

## Rollback

Rollback is code-based:

- revert the affected modularisation commit or restore the previous active page wiring;
- retain the existing calculated-history feature controls and compatibility data source;
- do not alter Worker, R2 or database state to roll back a frontend module extraction.

Archive copies must follow the website repository archive policy for active non-test code only. Documentation and tests must not be archived.