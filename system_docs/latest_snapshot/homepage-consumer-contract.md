# Homepage latest-readings consumer contract

## Authority

This file is the authoritative narrow contract for the public homepage consumer of the UK AQ latest-snapshot API.

It supplements [`contract.md`](contract.md). The broad latest-snapshot data, API, filtering, cache identity and failure contracts remain unchanged.

## Scope

This contract governs the `Highest sensor readings` dashboard on the TEST website homepage, currently implemented by:

- `TEST-uk-aq/TEST-uk-aq.github.io/index.html`;
- `TEST-uk-aq/TEST-uk-aq.github.io/dashboard.js`.

It does not govern the WHO summary card or the hex map refresh lifecycle.

## Active-page definition

For this contract, the homepage is active only when:

- the document is visible, meaning `document.hidden` is false; and
- the browser window has focus, meaning `document.hasFocus()` is true.

A visible tab in an unfocused browser window is not active and MUST NOT perform the periodic dashboard refresh.

## Data behaviour

The homepage dashboard MUST continue to:

- request `pm25`, `pm10` and `no2` from the public latest-snapshot API;
- use the existing six-hour active window for the visible highest-reading, area and active-sensor summaries;
- use the existing `window=all` requests only for capability and availability decisions;
- preserve the existing network catalogue and public network-visibility rules;
- preserve the user's selected networks across data refreshes;
- keep the most recently rendered usable data visible while a refresh is in progress or when a later refresh fails.

No backend route, request parameter, response field or cache-proxy behaviour is changed by this contract.

## Initial load

The dashboard MUST perform its normal data load when the homepage is initialised.

The initial load establishes the latest completed successful dashboard request-cycle time used by both the visible `Updated` display and the browser-focus freshness rule.

## Active-page automatic refresh cadence

While the homepage is active, the dashboard MUST automatically start a refresh on wall-clock five-minute boundaries, equivalent to cron `*/5 * * * *`.

Examples include `10:00`, `10:05`, `10:10` and `10:15`.

The scheduler MUST:

- calculate the next five-minute boundary from the current clock;
- use a recalculated one-shot schedule rather than relying on a drifting five-minute interval;
- avoid starting an automatic refresh when the document is hidden or the browser window is not focused;
- continue to target the next wall-clock boundary after every scheduled, manual or focus-triggered refresh;
- prevent overlapping request cycles.

A manual or focus-triggered refresh at an off-boundary time MUST NOT move or suppress the next normal five-minute boundary refresh.

## Hidden-page and browser-focus behaviour

The homepage MUST NOT perform periodic dashboard refresh requests while the document is hidden or the browser window is not focused.

The implementation MUST respond to both document visibility changes and browser window focus events.

When the homepage becomes active again:

- if more than five minutes have elapsed since the most recent completed successful dashboard request cycle, refresh immediately;
- otherwise, do not refresh immediately;
- in both cases, schedule the next normal wall-clock five-minute boundary.

A boundary missed while the page was inactive does not require a separate catch-up queue. The active-page rule provides the single immediate catch-up when the last successful dashboard refresh is older than five minutes.

## Manual refresh control

The `Highest sensor readings` card MUST provide a visible `Refresh` button in its top-right header area.

The button MUST reuse the established hex map refresh control's visual treatment and accessible button behaviour rather than introducing an unrelated control style.

Activating the button MUST:

- start a refresh immediately, regardless of the wall-clock minute;
- retain the current network selection;
- retain currently rendered usable data until replacement data is ready;
- expose an in-progress state and prevent duplicate overlapping activation;
- leave the normal five-minute boundary schedule unchanged.

Manual and browser-focus refreshes may complete at any minute. The visible `Updated` time is therefore not required to align to a five-minute boundary.

## Updated display semantics

The homepage `Updated` display means the browser time at which the latest successful dashboard request cycle completed and its usable latest-reading result was rendered.

The display MUST:

- use the local browser completion time for the dashboard request cycle;
- update after a successful initial, scheduled, manual or focus-triggered refresh;
- update when at least one current six-hour pollutant request succeeds and the resulting dashboard state is rendered, including a partial-success cycle that exposes the existing partial-availability status;
- remain unchanged when all current six-hour pollutant requests fail;
- never use a sensor observation timestamp;
- no longer use connector polling or connector refresh metadata as its displayed meaning;
- use the existing UK date and 24-hour time formatting conventions.

The request-cycle completion time used by the focus freshness rule MUST be the same successful completion time represented by the visible `Updated` display.

## Header layout

The top-right header area of the `Highest sensor readings` card MUST contain one compact action group with:

- the `Updated` display; and
- the `Refresh` button immediately beside it with only the normal small control gap.

The refresh button remains the rightmost control.

The network selector MUST remain below the main title row in a secondary controls row and MUST NOT separate the `Updated` display from the refresh button.

The layout MUST remain usable at the existing responsive breakpoints, including narrow mobile widths, without obscuring the heading, refresh button, update display or network selector.

## Concurrency and failure handling

All initial, scheduled, focus-triggered and manual refreshes MUST use one shared request-cycle function and one shared in-flight guard.

If a trigger occurs while a request cycle is already running, the implementation MUST NOT start a duplicate concurrent cycle.

A failed refresh MUST:

- preserve the last usable rendered data;
- preserve the previous successful `Updated` time when all current six-hour pollutant requests fail;
- expose the existing dashboard error or partial-availability status;
- release the in-flight state so a later boundary, focus event or manual action can retry.

## Explicit non-goals

This change MUST NOT:

- change latest-snapshot builder or Worker scheduling;
- change the six-hour homepage active window;
- change highest-reading, area-summary or active-sensor calculations;
- change network selection semantics;
- change backend connector polling or connector refresh-metadata production;
- add background fetching while the page is hidden or the browser window is unfocused;
- add a service worker, WebSocket, polling Worker or new backend endpoint;
- change WHO summary refresh behaviour;
- change the hex map implementation.

## Validation

Before deployment, only the smallest structural checks are required, including JavaScript syntax validation and confirmation that the homepage references the intended controls.

Functional acceptance MUST happen through normal TEST website operation:

1. initial homepage load succeeds and `Updated` shows its successful completion time;
2. an active page refreshes at the next minute ending in `0` or `5`;
3. a hidden page does not make periodic dashboard requests;
4. a visible page in an unfocused browser window does not make periodic dashboard requests;
5. returning focus after more than five minutes triggers one immediate refresh;
6. returning focus within five minutes does not trigger an unnecessary immediate refresh;
7. manual refresh works at an arbitrary minute without shifting the next boundary refresh;
8. manual and focus-triggered refreshes update `Updated` to their actual successful completion time;
9. the `Updated` display sits immediately beside the refresh button and the network selector remains below;
10. network selection remains unchanged through every refresh path;
11. a total refresh failure leaves the previous usable readings and previous `Updated` time visible and permits a later retry.

## Implementation status

The five-minute refresh lifecycle was implemented in the TEST website repository on 28 July 2026. The revised `Updated` timestamp semantics and adjacent header layout recorded in this amendment are pending implementation and TEST validation.