# Station-chart pollutant-switch contract

## Authority

This is the authoritative narrower contract for changing pollutant while a UK AQ station chart is already open.

It supplements [`contract.md`](contract.md). The broad shared station-chart contract remains authoritative for module boundaries, cache ownership, AQI-source switching, data clients, rendering and page adapters.

This contract deliberately distinguishes:

- changing the chart pollutant;
- changing selected sensors within the same pollutant;
- changing only the AQI source within the same pollutant;
- opening a chart for the first time.

## Required user-visible behaviour

When the user changes pollutant while a chart is open, the chart MUST change to the newly selected pollutant without requiring the user to:

- leave chart mode;
- reload the page;
- reselect the area;
- reopen the chart;
- reselect the chart range.

A pollutant change MUST replace all pollutant-dependent visible state, including:

- observation lines;
- chart-frame pollutant identity;
- y-axis label and units;
- tooltip values and units;
- guideline state;
- DAQI and European AQI state;
- loading, unavailable and empty messages;
- sensor-entry metadata and timeseries identity.

Old-pollutant lines, labels, units, guideline or AQI bands MUST NOT remain visible as though they belong to the newly selected pollutant.

## Pollutant changes are full context replacements

A pollutant change MUST NOT use the targeted same-pollutant sensor-change path.

The targeted incremental path remains appropriate when sensors are added or removed while the pollutant is unchanged. It MUST NOT be used to retain a station line merely because the same station identifier exists for both the old and new pollutants.

Changing pollutant is a chart-context replacement. It MUST:

1. establish the target canonical pollutant;
2. wait until the target pollutant's page or map entries are available, or are confirmed successfully empty;
3. invalidate obsolete chart work;
4. rebuild the selected entries for the target pollutant;
5. replace the old pollutant frame and series;
6. commit the new pollutant only when the corresponding visible result is current.

## Shared module ownership

Pollutant switching MUST be implemented through the shared station-chart subsystem under `/station_chart/`.

The final implementation MUST NOT add another pollutant-transition state machine to `hex_map/index.html`.

The shared controller MUST own:

- target pollutant;
- rendered pollutant;
- load generation;
- active request cancellation;
- obsolete-result rejection;
- selected-entry replacement;
- chart-frame replacement;
- interaction with the shared renderer.

The controller interface MUST provide one operation equivalent to:

```text
setPollutantContext({
  pollutant,
  entries,
  dataReady,
  preserveRange,
  preserveSelection
})
```

The exact name and argument shape MAY differ, but there MUST be one explicit controller operation for replacing pollutant context. A page adapter MUST NOT reproduce the controller's loading, cancellation, cache or rendering decisions.

The Hex Map adapter owns only:

- reading the pollutant selected by the page;
- obtaining the target pollutant's area entries from the map state;
- distinguishing data still loading from data successfully loaded with zero entries;
- calling the shared controller when the target context is authoritative;
- forwarding page controls and updating surrounding Hex Map state.

The same shared controller and renderer MUST be reusable by other pages.

## Data-readiness boundary

The selected UI pollutant is not proof that target-pollutant map data is ready.

The page adapter MUST distinguish:

1. target pollutant selected but data still loading;
2. target pollutant data successfully loaded with entries;
3. target pollutant data successfully loaded with zero entries;
4. target pollutant data load failed.

The controller MUST NOT start the final pollutant replacement using entries that still belong to the previous pollutant.

A successfully loaded empty result is authoritative. It MUST complete the transition with a correct empty or unavailable chart state rather than being treated as an unresolved stale selection.

A failed target-data load MUST NOT mark the target pollutant as rendered successfully.

## State and identity

The shared controller MUST keep these concepts distinct:

- target pollutant: the pollutant the user most recently requested;
- rendered pollutant: the pollutant represented by the visible chart;
- load pollutant: the immutable canonical pollutant captured for one chart load;
- load generation: the identity used to reject obsolete work.

Each pollutant-changing load MUST capture its canonical load pollutant when that load begins.

A load MAY commit visible output only when:

- its generation is still current;
- it has not been aborted;
- its captured load pollutant still equals the current target pollutant;
- the rendered frame or empty state belongs to that captured pollutant.

Completion code MUST commit the captured load pollutant. It MUST NOT read mutable target state as the identity of the work that just completed.

Rapid switching such as:

```text
PM2.5 -> PM10 -> NO2
```

MUST leave only NO2 as the final visible and rendered pollutant. Late PM10 map or chart results MUST NOT draw, relabel or replace the NO2 result.

## Request, cache and frame identity

All pollutant-dependent identities MUST include the canonical pollutant, including:

- observation request identity;
- station-history request identity;
- browser cache keys;
- retained selected-entry identity;
- chart-frame identity;
- rendered series ownership.

A chart frame MUST NOT be reused when its pollutant differs from the load pollutant, regardless of whether the immediate load reason is labelled sensor change, resize, refresh, range change or pollutant change.

Old-pollutant selected-entry objects and timeseries identifiers MUST NOT be fallback entries for the target pollutant.

## Selected sensors and range

A pollutant change MUST preserve the selected chart range.

Selected station identifiers SHOULD be preserved when the same stations have valid entries for the target pollutant.

After target data is authoritative:

- selected stations supported by the target pollutant MUST remain selected;
- unsupported selected stations MUST be removed from the active chart selection;
- retained entry metadata MUST be replaced by target-pollutant metadata;
- the primary and AQI-source station MUST be changed to a valid remaining selection when required;
- if no selected station remains valid, the chart MUST render the correct empty or unavailable state.

A confirmed empty target result MUST NOT display a stale-selection message instructing the user to refresh the sensor list.

## Animation contract

The existing initial chart-render animation MUST be preserved when the chart is opened for the first time.

Changing pollutant while the chart is already open MUST NOT replay the initial chart-render animation.

For a pollutant change:

- obsolete old-pollutant work MUST be cancelled or ignored;
- old-pollutant visible state MUST be cleared or replaced through the shared renderer;
- the target pollutant MUST be committed without the first-render line animation;
- a loading or confirmed-empty state MAY be shown while the target result is prepared;
- labels, axes, guideline and AQI state MUST change atomically with the target result where practical.

Same-pollutant sensor additions and removals MUST preserve the established incremental behaviour and MUST NOT unnecessarily clear or redraw retained lines.

This animation rule does not change the separate approximately 50 millisecond AQI-source-only transition defined by [`contract.md`](contract.md).

## Renderer contract

The shared renderer MUST support an explicit render mode equivalent to:

```text
initial
pollutant-replacement
incremental-selection
```

The exact API MAY differ, but the outcome MUST be unambiguous:

- `initial` preserves the current first-render animation;
- `pollutant-replacement` renders the new pollutant without replaying the first-render animation;
- `incremental-selection` preserves retained same-pollutant layers.

The renderer MUST NOT decide when map data is ready or which pollutant is current. Those decisions belong to the adapter and controller respectively.

## Error and empty-state behaviour

While the target pollutant is loading, the chart MUST NOT present old-pollutant lines under new-pollutant labels.

When target data is successfully empty or no selected station supports the target pollutant:

- old lines MUST be removed;
- target labels and units MUST be correct;
- the page MUST show a clear empty or unavailable message;
- the transition MUST settle without an automatic retry loop.

When target data loading fails:

- the target pollutant MUST remain uncommitted;
- obsolete results MUST remain unable to draw;
- the failure MUST use the existing chart or map error ownership rather than creating a second error system.

## Inline-page boundary

After this responsibility moves to shared modules, `hex_map/index.html` MAY contain only the small bootstrap and adapter wiring required by the broad station-chart contract.

It MUST NOT contain implementations of:

- pollutant-transition queuing;
- chart load generation;
- obsolete-result rejection;
- pollutant-specific chart-frame reuse;
- selected-entry pollutant reconciliation;
- pollutant replacement rendering.

## Preserved behaviour

The implementation MUST preserve:

- the initial chart-render animation;
- chart range across pollutant changes;
- valid selected sensors across pollutant changes;
- same-pollutant incremental sensor rendering;
- existing maximum sensor selection and symbol order;
- current observation and AQI data-source precedence;
- the separate AQI-source-switch contract;
- TEST-only scope until separately approved for LIVE.

## Explicit non-goals

This contract does not:

- redesign the chart appearance;
- change pollutant values, units or supported pollutant definitions;
- change Worker routes or response schemas;
- change AQI algorithms;
- introduce a frontend framework or build system;
- require a broad rewrite of unrelated Hex Map code;
- authorise changes to LIVE repositories.

## Structural validation

Before deployment, perform only the smallest checks needed to establish structural viability:

- syntax and import parsing for changed modules;
- confirmation that the Hex Map adapter resolves and calls the shared controller;
- confirmation that pollutant replacement and same-pollutant sensor change use distinct controller or renderer modes;
- `git diff --check`.

Do not create a speculative broad test suite.

Functional validation occurs after deployment through normal use of the TEST website.

## TEST operational acceptance

The pollutant-switch implementation is accepted when TEST operation confirms:

1. the chart's existing first-open animation still runs;
2. changing PM2.5 to PM10 replaces the visible chart with PM10;
3. pollutant replacement does not replay the first-open line animation;
4. title, units, tooltip, guideline and AQI state match the new pollutant;
5. the chart range remains selected;
6. valid selected stations remain selected;
7. unsupported selected stations are removed without old-pollutant fallback;
8. a confirmed empty target result shows a correct empty state;
9. PM2.5 -> PM10 -> NO2 rapid switching leaves NO2 visible;
10. late obsolete results do not draw or relabel the chart;
11. adding or removing sensors without changing pollutant keeps retained lines visible and avoids unnecessary redraw;
12. the Hex Map and any later page use the same shared pollutant-switch controller and renderer behaviour.

## Rollback

Rollback is code-based:

- revert the shared controller, renderer and adapter changes together;
- do not alter Worker, R2 or database state;
- do not use archived page code as an active runtime fallback.
