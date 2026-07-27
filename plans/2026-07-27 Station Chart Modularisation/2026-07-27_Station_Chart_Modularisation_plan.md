# 2026-07-27 Station Chart Modularisation Plan

## Status

Proposed TEST implementation plan.

This plan implements the authoritative frontend contract in:

```text
system_docs/station_charts/contract.md
```

It is a website refactor. It does not change Worker calculations, R2, Supabase, schemas, Cloudflare configuration or LIVE repositories.

## Recommended coding model

Use **GPT-5.6 Codex with High reasoning** for every implementation phase.

## Why this work starts now

`hex_map/index.html` has accumulated station-history loading, duplicate AQI data paths, cache interpretation, D3 rendering, source-switch state, message ownership, page state and unrelated map functionality in one large file.

The current AQI-source regression has continued through several narrow fixes because:

- calculated and compatibility paths duplicate controller behaviour;
- multiple functions own cache, loading, transition and error state;
- page resize and chart load state can interact with source switching;
- browser diagnostic allow-lists affect visible success or failure;
- focused fixes in one path do not reliably simplify the other path.

Further page-local AQI conditionals are not the intended solution.

## Locked architecture decisions

1. Shared chart implementation lives under `station_chart/` in the TEST website repository.
2. Hex Map and Sensors use the same chart controller, cache, data-client interface and renderer.
3. The calculated station-history source is the normal data client.
4. The retained stored-AQI compatibility source is a data-client adapter behind the same controller.
5. There is one AQI-source controller and one visible source-switch state machine.
6. A successful, parseable and identity-valid calculated AQI response settles for browser source switching even when it contains gaps or unfamiliar diagnostic strings.
7. Missing AQI remains blank.
8. AQI-source switching never uses the page-wide red chart error banner.
9. Settled AQI-source switching uses the exact displayed range, starts no observation request and normally commits once after approximately 50 milliseconds.
10. The renderer owns D3 and SVG only. It does not fetch or interpret API completeness.
11. Page adapters own page controls only. They do not contain chart cache, request or rendering logic.
12. No new frontend framework, build system or browser-side AQI calculation is introduced.
13. No long-lived feature flag is added solely to preserve two frontend controller implementations.

## Repositories

Authoritative documentation and plan:

```text
TEST-uk-aq/uk-aq-ops
```

Implementation:

```text
TEST-uk-aq/TEST-uk-aq.github.io
```

Do not inspect or modify LIVE repositories.

## Required reading for every phase

Before implementation, read:

```text
TEST-uk-aq/uk-aq-ops/AGENTS.md
TEST-uk-aq/uk-aq-ops/system_docs/README.md
TEST-uk-aq/uk-aq-ops/system_docs/station_charts/README.md
TEST-uk-aq/uk-aq-ops/system_docs/station_charts/contract.md
TEST-uk-aq/uk-aq-ops/system_docs/aqi-levels/station-history-contract.md
TEST-uk-aq/uk-aq-ops/system_docs/aqi-levels/station-history-validation.md
TEST-uk-aq/uk-aq-ops/system_docs/r2_history/interfaces.md
TEST-uk-aq/TEST-uk-aq.github.io/AGENTS.md
TEST-uk-aq/TEST-uk-aq.github.io/AGENTS_BASE.md
```

`system_docs/` is read-only to Codex.

## Validation policy

This is the TEST system.

Before deployment, use only the smallest structural checks needed for changed files:

```text
node --check <changed JavaScript file>
existing directly relevant station-history/chart harness where affected
inline script syntax parsing only while inline chart code remains
git diff --check
```

Do not create a broad speculative test suite.

Do not use browser automation.

Functional validation happens after deployment through the real TEST Hex Map and Sensors pages.

A targeted helper check is genuinely required when moving ownership of:

- AQI-source transition generation;
- cache settlement;
- renderer incremental methods;
- event-listener lifecycle.

Those are high-risk boundaries that are difficult to validate from syntax alone. Keep each check narrow and use the real extracted helper rather than source-text matching where practical.

## Archive policy

Before each substantial phase, archive every active non-test implementation file that phase will change under:

```text
Archive/2026-07-27/<original-relative-path>
```

Do not archive:

- tests;
- documentation;
- fixtures;
- generated outputs;
- assets.

A file needs only one archive copy for 2026-07-27.

Do not reference archive files from active code.

---

# Phase 0: Structural ownership inventory

## Objective

Map the active station-chart implementation before extraction and confirm that the proposed module boundaries are structurally viable.

This is not a functional test phase.

## Required inspection

Identify all active functions and state for:

- chart instance creation and destruction;
- observation cache and coverage;
- AQI cache and settlement;
- calculated station-history client;
- compatibility AQI client;
- AQI-source switching;
- loading and abort ownership;
- message ownership;
- D3 axes, paths, symbols, AQI bands, guideline and tooltips;
- Hex Map page controls;
- Sensors page controls;
- resize, Refresh, range change and selected-sensor event listeners;
- browser diagnostics;
- `station-history-loader.js` consumers.

Produce an ownership table mapping each current function to its target module.

Confirm that no other active page relies directly on an inline Hex Map chart function.

## Decision gate

Stop before implementation only when one of these is found:

- another active page calls private Hex Map chart functions directly;
- the compatibility path cannot be represented behind the same client interface;
- the current renderer cannot be extracted without changing the API or AQI calculation contract;
- an essential page lifecycle is not identifiable.

Do not stop for ordinary naming or file-placement choices already resolved by the system contract.

## Output

A concise ownership map and exact file list for Phase 1.

No code change is required in this phase.

---

# Phase 1: Create shared domain, cache and diagnostics modules

## Objective

Move pure station-chart state and cache behaviour out of page code without changing visible behaviour.

## Target files

Create equivalents of:

```text
station_chart/station-chart-domain.js
station_chart/station-chart-cache.js
station_chart/station-chart-diagnostics.js
```

`station-history-loader.js` may temporarily re-export or delegate to these modules so existing consumers keep working during migration.

## Required ownership

### Domain

Extract pure handling for:

- sensor identity;
- chart-range snapshots;
- cache keys;
- load reasons;
- source-switch generations;
- terminal request outcomes;
- canonical AQI hour endpoints.

### Cache

Extract one browser cache model for:

- observation rows and coverage;
- AQI rows and request settlement;
- response diagnostics;
- freshness and invalidation;
- exact range subtraction;
- settled successful calculated partials;
- retryable transport, parsing, identity and conflict failures.

The cache must not maintain an exhaustive Worker reason allow-list as a visible-success gate.

### Diagnostics

Extract bounded event and timing shaping only.

It must not upload or log row arrays and must not be awaited by visible rendering.

## Behaviour requirement

No visible chart behaviour should intentionally change in Phase 1.

Do not create a second cache alongside the existing one. Existing page code must delegate to the shared cache module as functions are extracted.

## Minimal checks

Run syntax checks for the new modules, the directly relevant existing loader test and `git diff --check`.

## Handover

Report:

- functions moved;
- remaining facade functions;
- cache contract version change, if any;
- current page globals still required;
- next extraction boundary.

---

# Phase 2: Extract and cut over the shared AQI-source controller

## Objective

Fix the current false AQI error and slow repeated switching by giving one module sole ownership of the AQI-source transition.

This is the first visible-behaviour milestone.

## Target file

Create:

```text
station_chart/aqi-source-controller.js
```

## Required behaviour

The controller must:

1. snapshot the exact displayed range;
2. invalidate an older switch;
3. clear the old AQI layer immediately through a renderer callback;
4. start the 50 millisecond transition immediately;
5. query the shared cache for settlement;
6. request AQI only when the exact range is unsettled;
7. never request observations;
8. never wait for observation work, resize work, background prefetch or diagnostics;
9. stage required AQI results invisibly;
10. commit the available AQI layer once;
11. leave missing hours blank;
12. keep unknown Worker diagnostics bounded and non-user-facing;
13. avoid the page-wide red chart error banner for every AQI-only outcome;
14. return a terminal result to the chart controller.

For a confirmed hard AQI-only failure, leave the AQI layer blank or expose a chart-local unavailable state through the renderer callback. Do not set the page-wide chart message.

## Current code removal

Remove AQI-source transition and message ownership from `hex_map/index.html` as soon as the new controller is active.

Do not leave old and new source-switch controllers active together.

The compatibility data source must call the same AQI-source controller even before the remaining client extraction is complete.

## Minimal targeted checks

One focused behavioural helper check is required to prove:

- settled source switch starts no fetch;
- transition commits once;
- unresolved observation promise does not delay it;
- missing/unknown AQI diagnostics do not create the page-wide error;
- obsolete switch cannot commit;
- 50 millisecond timer remains.

Run only that focused check, syntax checks and `git diff --check`.

## TEST deployment milestone A

After Phase 2 is deployed normally, validate on the real TEST Hex Map:

```text
London -> Richmond upon Thames -> PM2.5 -> Last 31 days
```

Use selected sensors including:

```text
Twickenham - Palmerston Road
London Teddington Bushy Park
East Sheen Primary School
```

Confirm:

- no red AQI-source error appears;
- valid bands render once;
- gaps remain blank;
- repeated switching is approximately 50 milliseconds after cache settlement;
- no observation request starts;
- resize does not alter AQI error state;
- chart loading state does not remain stuck.

If this milestone fails, fix the shared controller before continuing. Do not patch the page-local implementation.

---

# Phase 3: Unify calculated and compatibility data clients

## Objective

Move station-history and compatibility fetching behind one browser-facing data-client interface.

## Target files

Create equivalents of:

```text
station_chart/station-history-client.js
station_chart/station-history-compatibility-client.js
```

## Required interface

Both clients must expose equivalent operations:

```text
loadCurrent(request, parts, signal)
loadOlder(request, parts, signal)
prefetchAqi(request, signal)
```

They must return the same normalized browser-facing result shape.

## Calculated client

Preserve:

- explicit `include_observations` and `include_aqi`;
- current combined response;
- exact displayed range;
- continuity-unaware browser identity;
- bounded concurrency;
- newest-first planning and ordered settlement;
- no browser AQI calculation.

## Compatibility client

The retained stored-AQI path becomes only a data-source adapter.

It must not own:

- a separate cache;
- a separate source-switch state machine;
- a separate renderer;
- a separate message controller;
- a separate chart load lifecycle.

## Current code removal

Remove duplicated request parsing and cache-state decisions from `hex_map/index.html` after the clients own them.

## Minimal checks

Run syntax checks and one focused client-normalisation check using existing representative response fixtures or minimal inline objects.

Do not call cloud services.

---

# Phase 4: Extract the shared D3 renderer

## Objective

Move chart drawing and geometry out of page code without changing data loading.

## Target file

Create:

```text
station_chart/station-chart-renderer.js
```

## Required renderer methods

Provide narrow operations equivalent to:

```text
initialise(frame)
renderObservations(state)
renderAqi(state)
clearAqi()
renderAxes(state)
resize(dimensions)
destroy()
```

## Move into renderer

Move ownership of:

- D3 scales and axes;
- observation path and symbol groups;
- AQI DAQI and European AQI layers;
- guideline overlays;
- chart tooltips;
- frame dimensions and resize geometry;
- incremental line updates;
- AQI-only early return.

## Preserve

- hour-ending AQI alignment;
- final band endpoint;
- blank missing intervals;
- symbol ordering;
- existing chart colours and labels;
- line segmentation;
- current tooltip content;
- no observation repaint during AQI-only render.

## Boundary

The renderer receives already-normalized view state. It must not fetch, inspect API metadata or choose cache coverage.

## Minimal targeted check

A narrow renderer helper check is genuinely required for:

- AQI interval clipping;
- AQI-only render not invoking observation drawing;
- resize preserving data state.

Do not add screenshot or browser automation tests.

---

# Phase 5: Extract the shared station-chart controller and cut over Hex Map

## Objective

Create one controller that coordinates domain state, cache, clients, AQI-source controller and renderer.

## Target files

Create:

```text
station_chart/station-chart-controller.js
hex_map/hex-map-station-chart-adapter.js
```

## Controller interface

Expose equivalent operations:

```text
setSelection(entries)
setAqiSource(stationId)
setRange(range)
refresh()
resize(dimensions)
destroy()
```

## Controller ownership

The controller becomes the sole owner of:

- selected sensors;
- selected AQI source;
- displayed range;
- load generation;
- active abort controller;
- foreground request priority;
- background AQI prefetch;
- data-client selection;
- renderer calls;
- chart lifecycle.

## Hex Map adapter ownership

The adapter owns only:

- deriving selected entries from Hex Map state;
- selected-sensor ordering and symbol mapping;
- forwarding source, range and Refresh controls;
- mounting and destroying the controller;
- page-specific labels and URL state.

It must not interpret Worker responses or draw the chart.

## Inline removal

Remove the active chart-controller implementation from `hex_map/index.html` during this phase.

Keep only page configuration, external script references and bootstrap wiring for the chart.

Do not defer removal and leave two active controllers.

## Minimal checks

Run module syntax/import checks, the directly relevant existing chart harness and `git diff --check`.

## TEST deployment milestone B

After normal TEST deployment, validate:

1. multi-sensor selection up to the current maximum;
2. add and remove one sensor without repainting retained lines;
3. change AQI source repeatedly;
4. change chart range;
5. Refresh;
6. resize;
7. compatibility mode through the existing flag;
8. one current-data failure and recovery through Refresh.

Use real TEST operation. Do not create a broad pre-deployment test programme.

---

# Phase 6: Cut over the Sensors page to the shared controller

## Objective

Make `sensors/index.html` use the same shared chart implementation.

## Target file

Create:

```text
sensors/sensor-station-chart-adapter.js
```

## Adapter behaviour

The Sensors adapter must:

- provide one selected sensor;
- configure no multi-sensor AQI-source selector;
- forward range and Refresh controls;
- mount the same controller and renderer;
- use the same calculated and compatibility clients;
- preserve Sensors-page labels and surrounding layout.

## Removal

Remove any duplicated Sensors-page station-history load, cache or render implementation once the adapter is active.

## Minimal checks

Run syntax/import checks and the existing directly relevant Sensors-page parser or station-history harness.

## TEST deployment milestone C

After normal TEST deployment, validate one representative PM2.5 sensor on the Sensors page:

- initial load;
- range change;
- Refresh;
- resize;
- blank AQI gaps;
- calculated mode;
- compatibility mode.

Confirm the loaded shared module files are the same as the Hex Map chart uses.

---

# Phase 7: Remove retired inline and duplicate chart code

## Objective

Finish the migration and prevent the monolith from regrowing.

## Required removal

Remove retired implementations of:

- duplicate caches;
- duplicate AQI settlement classifiers;
- duplicate data-client parsing;
- page-level AQI-source controller;
- page-level chart renderer;
- duplicate message ownership;
- duplicate event listeners;
- obsolete `station-history-loader.js` facade functions no longer required.

Keep `station-history-loader.js` only when it remains the narrow active public facade required by both pages. Otherwise replace its references and remove it in the same phase.

## HTML boundary

Confirm that `hex_map/index.html` and `sensors/index.html` contain only chart markup, configuration, external module references and small bootstrap code for the station chart.

Do not set an arbitrary line-count target. The acceptance condition is responsibility removal, not file size alone.

## Compatibility boundary

The compatibility data client remains available under the existing calculated-history feature rollback.

It must not retain a separate chart controller or renderer.

## Minimal checks

Run syntax/import checks, directly relevant existing harnesses and `git diff --check`.

Do not run broad repository suites.

---

# Phase 8: Final TEST operational validation

## Objective

Validate the completed modular architecture through normal TEST operation.

## Hex Map cases

Validate:

- a GOV.UK AURN sensor;
- a Breathe London sensor;
- a Sensor.Community sensor;
- two to four selected sensors;
- Last 31 days;
- Last 90 days;
- AQI source switches between networks;
- source with genuine AQI gaps;
- repeated cached switch;
- rapid second switch;
- resize;
- range change;
- Refresh;
- added and removed sensor;
- compatibility mode.

## Sensors case

Validate one supported sensor through:

- initial load;
- range change;
- Refresh;
- resize;
- calculated and compatibility clients.

## Required observations

Confirm:

- one shared controller instance per chart;
- one set of page-adapter listeners;
- one AQI visible commit per source switch;
- no chart-wide red message for AQI-only outcomes;
- no observation request on AQI-only switches;
- no observation repaint on settled AQI-only switches;
- no duplicate network requests caused by overlapping old/new controllers;
- no stale source band after rapid switching;
- no full-chart loading state for settled AQI switch;
- expected bounded diagnostics;
- no browser-side AQI calculation.

One successful representative operation for each page and one representative AQI-source switch failure or blank case are sufficient unless a real TEST problem appears.

---

# Phase 9: ChatGPT system-document review

## Objective

After implementation and TEST validation, ChatGPT in Chat mode reviews the coding-agent handover and updates active `system_docs/` only where the implemented final filenames or interfaces differ from the contract without changing its intent.

Codex must not edit `system_docs/`.

## Required handover

Codex reports:

- final module tree;
- module responsibilities;
- public controller and adapter interfaces;
- files removed from inline HTML;
- compatibility-client implementation;
- cache contract version;
- AQI-source terminal outcomes;
- page-wide versus AQI-local error behaviour;
- event-listener ownership;
- deployment steps;
- real TEST validation results;
- unresolved differences from the authoritative contract.

---

# Rollback

Frontend rollback uses normal source control and existing feature controls.

For a failed extraction milestone:

1. revert the affected website implementation change;
2. restore the previously active page wiring;
3. retain the calculated-history and continuity feature settings unless the failure is in those paths;
4. use the existing compatibility data-source control when calculated-history rollback is required;
5. do not change Worker, R2, Supabase or schema state for a frontend-only rollback.

# Definition of complete

This plan is complete when:

- the shared module structure is active;
- Hex Map and Sensors use the same chart controller, cache, clients and renderer;
- the compatibility source is only a data-client adapter;
- AQI-source switching has one owner;
- settled switching normally completes in approximately 50 milliseconds;
- AQI gaps remain blank without a chart-wide red message;
- page resize changes geometry only;
- `hex_map/index.html` no longer contains station-chart implementation;
- retired duplicate code and listeners are removed;
- real TEST validation succeeds;
- ChatGPT reviews the final system-document accuracy.