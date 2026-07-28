# Homepage latest-readings consumer contract

## Authority

This file is the authoritative narrow contract for the public homepage consumer of the UK AQ latest-snapshot API.

It supplements [`contract.md`](contract.md). The broad latest-snapshot data, API, filtering, cache identity and failure contracts remain unchanged.

## Scope

This contract governs the `Highest sensor readings` dashboard on the TEST website homepage, currently implemented by:

- `TEST-uk-aq/TEST-uk-aq.github.io/index.html`;
- `TEST-uk-aq/TEST-uk-aq.github.io/dashboard.js`.

It does not govern the WHO summary card or the hex map refresh lifecycle.

## Data behaviour

The homepage dashboard MUST continue to:

- request `pm25`, `pm10` and `no2` from the public latest-snapshot API;
- use the existing six-hour active window for the visible highest-reading, area and active-sensor summaries;
- use the existing `window=all` requests only for capability and availability decisions;
- preserve the existing network catalogue and public network-visibility rules;
- preserve the existing connector refresh-metadata display semantics;
- preserve the user's selected networks across data refreshes;
- keep the most recently rendered usable data visible while a refresh is in progress or when a later refresh fails.

No backend route, request parameter, response field or cache-proxy behaviour is changed by this contract.

## Initial load

The dashboard MUST perform its normal data load when the homepage is initialised.

The initial load establishes the latest completed dashboard request-cycle time used by the browser-focus freshness rule.

## Visible-page automatic refresh cadence

While the document is visible, the dashboard MUST automatically start a refresh on wall-clock five-minute boundaries, equivalent to cron `*/5 * * * *`.

Examples include `10:00`, `10:05`, `10:10` and `10:15`.

The scheduler MUST:

- calculate the next five-minute boundary from the current clock;
- use a recalculated one-shot schedule rather than relying on a drifting five-minute interval;
- avoid starting an automatic refresh while `document.hidden` is true;
- continue to target the next wall-clock boundary after every scheduled, manual or focus-triggered refresh;
- prevent overlapping request cycles.

A manual or focus-triggered refresh at an off-boundary time MUST NOT move or suppress the next normal five-minute boundary refresh.

## Hidden-page and browser-focus behaviour

The homepage MUST NOT perform periodic dashboard refresh requests while the document is hidden.

When the document becomes visible again:

- if more than five minutes have elapsed since the most recent completed dashboard request cycle, refresh immediately;
- otherwise, do not refresh immediately;
- in both cases, schedule the next normal wall-clock five-minute boundary.

A boundary missed while the page was hidden does not require a separate catch-up queue. The visibility rule provides the single immediate catch-up when the data cycle is older than five minutes.

## Manual refresh control

The `Highest sensor readings` card MUST provide a visible `Refresh` button in its top-right header area.

The button MUST reuse the established hex map refresh control's visual treatment and accessible button behaviour rather than introducing an unrelated control style.

Activating the button MUST:

- start a refresh immediately, regardless of the wall-clock minute;
- retain the current network selection;
- retain currently rendered usable data until replacement data is ready;
- expose an in-progress state and prevent duplicate overlapping activation;
- leave the normal five-minute boundary schedule unchanged.

The displayed update time and the fetched data time may therefore be off the five-minute boundary after manual and browser-focus refreshes.

## Header layout

The refresh button MUST occupy the top-right action position of the `Highest sensor readings` card.

The network selector MUST move below the main title row into a secondary controls row. The existing `Updated` display may remain associated with that lower controls area.

The layout MUST remain usable at the existing responsive breakpoints, including narrow mobile widths, without obscuring the heading, refresh button, update display or network selector.

## Concurrency and failure handling

All initial, scheduled, focus-triggered and manual refreshes MUST use one shared request-cycle function and one shared in-flight guard.

If a trigger occurs while a request cycle is already running, the implementation MUST NOT start a duplicate concurrent cycle.

A failed refresh MUST:

- preserve the last usable rendered data;
- expose the existing dashboard error or partial-availability status;
- release the in-flight state so a later boundary, focus event or manual action can retry.

## Explicit non-goals

This change MUST NOT:

- change latest-snapshot builder or Worker scheduling;
- change the six-hour homepage active window;
- change highest-reading, area-summary or active-sensor calculations;
- change network selection semantics;
- change connector refresh-metadata meaning;
- add background fetching while the page is hidden;
- add a service worker, WebSocket, polling Worker or new backend endpoint;
- change WHO summary refresh behaviour;
- change the hex map implementation.

## Validation

Before deployment, only the smallest structural checks are required, including JavaScript syntax validation and confirmation that the homepage references the intended controls.

Functional acceptance MUST happen through normal TEST website operation:

1. initial homepage load succeeds;
2. a visible page refreshes at the next minute ending in `0` or `5`;
3. a hidden page does not make periodic dashboard requests;
4. returning after more than five minutes triggers one immediate refresh;
5. returning within five minutes does not trigger an unnecessary immediate refresh;
6. manual refresh works at an arbitrary minute without shifting the next boundary refresh;
7. network selection remains unchanged through every refresh path;
8. a refresh failure leaves the previous usable readings visible and permits a later retry.

## Implementation status

This contract records the approved behaviour requested on 28 July 2026. Implementation in the TEST website repository is pending.