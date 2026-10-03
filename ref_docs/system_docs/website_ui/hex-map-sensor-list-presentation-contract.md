# Hex Map sensor-list presentation contract

**Status: ACTIVE TEST IMPLEMENTATION CONTRACT - SENSOR LIST + CHART SELECT MODE**

## Authority and scope

This is the presentation authority for the Hex Map inline sensor list and its chart-selection additions.

It supersedes conflicting sensor-list presentation wording in [`hex-map-mobile-controls-contract.md`](hex-map-mobile-controls-contract.md) and [`hex-map-mobile-layout-contract.md`](hex-map-mobile-layout-contract.md).

For combined Sensor / Network identity line mode, wrapping, truncation, rendered-fit measurement and separator behaviour in Narrow and Compact regimes, the narrower authority is [`hex-map-sensor-identity-two-line-contract.md`](hex-map-sensor-identity-two-line-contract.md). This broad contract MUST NOT redefine those rules.

It does not redefine sensor eligibility, ordering, sort state, selected-sensor state, AQI-source semantics, chart data, API requests or persistence. Those remain owned by the existing Hex controllers/modules and station-chart contracts.

The implementation MUST continue to use the same authoritative sensor list, row renderer, sort state, scroll owner and chart-selection state across map and chart modes. A second sensor-list renderer or duplicate state model is not authorised.

## Design baseline

The current LIVE wide Hex Map sensor table is the visual baseline for the Full presentation.

In Full map mode, TEST MUST preserve the material appearance and spacing of the current LIVE sensor list rather than invent a new wide-table geometry. In particular, Full map mode SHOULD preserve the complete LIVE rendered geometry, including:

```text
leading gutter / control region before Sensor
Sensor
Network
active pollutant value
Observed
```

The leading LIVE region is part of the accepted visual/table geometry. It MUST NOT be discarded merely because map mode does not currently need chart-selection controls in that space.

The implementation MUST inspect LIVE to determine what actually creates that leading region, such as an existing structural column, colgroup, cell width, padding or equivalent. Do not infer that the space should disappear simply because Select and Series symbol are hidden.

The leading LIVE region MUST NOT be reinterpreted as a visible chart-series symbol or row-level chart-launch control in map mode. It is a presentation/gutter requirement unless the LIVE implementation shows otherwise.

The three-regime work is intended to simplify responsive behaviour around that stable wide presentation. It is NOT intended to redesign the successful LIVE full-width table.

Where the current TEST implementation conflicts with this baseline, prefer the current LIVE wide-table presentation for Full map mode, then add chart-selection controls additively for Full chart mode.

## Responsive model: exactly three presentation regimes

The sensor list has exactly three structural presentation regimes:

```text
Narrow:
  viewport < 768 CSS px

Compact:
  viewport >= 768 CSS px
  AND sensor-table component width < 860 CSS px

Full:
  viewport >= 768 CSS px
  AND sensor-table component width >= 860 CSS px
```

`768px` remains the shared narrow/normal viewport boundary used by the existing mobile shell and controllers.

The Compact -> Full decision MUST be based on the actual named sensor-table/component width, not on a guessed browser viewport width. The accepted TEST boundary is `860px` of sensor-table component width (`<=859px` Compact, `>=860px` Full).

No additional structural sensor-list regime is authorised at `520px`, `600px`, `699px`, `899px`, `1000px`, `1042px` or similar. Such widths MAY affect small spacing details but MUST NOT switch the list to another row/table model.

## Common invariants

Map mode and chart mode MUST use the same authoritative rows and the same underlying identity/value/time information.

Chart mode is additive. It MAY add:

```text
selection-circle control
chart-series symbol
chart-selection actions
```

but MUST NOT replace the list with a separate chart-specific row model.

The chart-series symbol has one meaning only: the selected chart series marker in chart-selection mode. It MUST NOT be reused as the map-mode chart-entry control.

The map-mode chart-entry control remains the existing area/panel chart control used by the accepted LIVE presentation. It MUST NOT migrate into the chart-series symbol column or appear as a misplaced floating row control merely because responsive layout changes.

Any row-end chevron/details action is also distinct from both the area chart-entry control and the chart-series symbol.

Header/body geometry MUST come from one authoritative column template per regime. Do not align headers and values through independent manual x offsets, negative margins, transforms or per-column nudges.

Every outside-window divider row MUST span the complete usable sensor-table width for the active regime, including any leading Full-mode gutter/control region. It MUST NOT stop after the Sensor column or occupy only part of the table.

## Narrow regime: viewport below 768px

Below `768px`, there is one stacked narrow-screen sensor-row presentation at all widths.

There MUST NOT be a special `600px` or other wider-mobile transition back into a horizontal six-column table.

### Narrow map mode

The conceptual information layout is:

```text
sensor/network identity                  reading
observed date/time                       optional row-end details action
```

Sensor and Network form one identity presentation. The Narrow list-wide line-mode rule, complete-name preservation and separator behaviour are defined only by [`hex-map-sensor-identity-two-line-contract.md`](hex-map-sensor-identity-two-line-contract.md).

The area/panel chart-entry control remains in its established panel-header position and MUST NOT be inserted into the row's chart-series symbol position.

### Narrow chart mode

The same identity/value/time presentation is retained, with selection additions at the left:

```text
select   series-symbol   sensor/network identity
                         observed date/time        reading
```

The horizontal order is authoritative:

```text
Select -> Series symbol -> Sensor identity
```

The visible series symbol MUST be visually centred between the visible selection circle and the start of the sensor identity through layout geometry rather than per-symbol transforms.

The Narrow Sensor / Network identity continues to follow the dedicated list-wide identity authority in chart-selection mode.

### Narrow headings

The table column-heading row (`Sensor`, `Network`, pollutant heading, `Observed`) MUST NOT be shown at any width below `768px`.

### Narrow sorting

The authoritative native Sort selector is the visible sorting UI in BOTH map mode and chart mode below `768px`.

Its presentation MUST follow the accepted pre-three-regime compact/narrow control style: a labelled, bounded control aligned within the sensor-list toolbar. It MUST NOT stretch across nearly the complete sensor-panel width merely because space is available.

The control SHOULD remain comfortably readable and MAY grow/shrink with available space, but it MUST retain a deliberate maximum/comfortable width rather than `width: 100%` presentation.

In chart mode the fixed toolbar contains:

```text
left:  select/fill circle / keep-top circle-with-1
right: Sort [current sort]
```

The fixed chart-selection toolbar remains outside the vertical sensor-row scroll owner and MUST NOT scroll with the rows.

## Compact regime: >=768px viewport and sensor-table width below 860px

Compact is the single intermediate presentation and applies equally to map mode and chart mode.

Sensor and Network are combined into one identity field. Its line mode is row-local under [`hex-map-sensor-identity-two-line-contract.md`](hex-map-sensor-identity-two-line-contract.md): each Compact row stays `Sensor · Network` on one line when that row fits, and only individual rows that genuinely need wrapping use two-line geometry. One long Compact row MUST NOT force unrelated short rows onto two lines.

There is no separate Network column in Compact mode.

The semantic Compact information columns are:

```text
map mode:
  Sensor/Network identity | pollutant value | Observed

chart mode:
  Select | Series symbol | Sensor/Network identity | pollutant value | Observed
```

The area/panel chart-entry control stays in its established panel-header position in map mode. Compact MUST NOT create a row-level chart-series-symbol track in map mode.

Map and chart modes MUST otherwise use the same Compact identity/value/time geometry.

The Sensor/Network identity column receives the flexible surplus width. Pollutant value and Observed size primarily to their actual content.

### Compact headings and sorting

Compact MAY show simple static aligned headings for the information columns, for example:

```text
SENSOR                  PM2.5                  OBSERVED
```

There MUST NOT be a separate `NETWORK` heading because Network is part of the Sensor identity column.

Compact uses the authoritative native Sort selector rather than sortable heading pills/buttons.

The Sort control MUST use the accepted pre-three-regime visual treatment: a compact labelled control aligned to the right/control area, not a full-width select spanning almost the entire panel.

Chart mode adds the selection actions alongside it. Map mode shows Sort without chart-selection actions.

Blue sortable pollutant/Observed heading pills are reserved for Full mode and MUST NOT appear as a competing sorting UI in Compact.

## Full regime: >=768px viewport and sensor-table width >=860px

Full is the conventional wide sensor table and MUST be based on the current LIVE wide-table presentation.

### Full map mode

Full map mode uses the complete established LIVE geometry, conceptually:

```text
LIVE leading gutter/control region | Sensor | Network | pollutant value | Observed
```

The leading region is part of the accepted wide-table layout even when no row-level control is visibly rendered there. It provides the same material table start position and column balance seen in LIVE.

Do NOT collapse Sensor leftwards simply because chart-selection controls are absent.

Do NOT apply the LIVE `Sensor / Network / value / Observed` width proportions directly to a different four-column table that has discarded the LIVE leading region. Doing so changes every visible column start position and does not satisfy this contract.

The established area/panel chart-entry control remains where LIVE places it. The leading region MUST NOT acquire a visible chart-series symbol or new row-level chart-launch control merely to occupy the space.

The Full map table SHOULD materially match LIVE for:

```text
leading gutter/control width and resulting Sensor start position
Sensor start position and allocation
Network start position and allocation
pollutant-value start/alignment
Observed start/alignment
heading positions
row density
padding
usable whitespace
outside-window divider span
```

The implementation SHOULD reuse the actual LIVE structural mechanism where practical, or reproduce its rendered geometry directly where current TEST markup differs. The target is the LIVE rendered result, not a newly interpreted proportional grid.

### Full chart mode

Full chart mode is the Full/LIVE data geometry plus chart-selection affordances.

The visible structure is:

```text
Select | Series symbol | Sensor | Network | pollutant value | Observed
```

The authoritative order is:

```text
Select -> Series symbol -> Sensor -> Network -> pollutant -> Observed
```

The Select + Series-symbol region replaces/uses the Full leading control/gutter space as far as practical before consuming additional width from the normal data columns. Chart mode MAY reduce the Sensor/Network allocation enough to accommodate the two visible chart-selection controls, but SHOULD preserve the LIVE Sensor/Network/value/Observed relationships as closely as practical.

The Full chart implementation MUST NOT place the Series symbol to the right of Sensor, in the pollutant area or in the map chart-entry position.

### Full headings and sorting

Full uses the normal aligned table heading row with separate headings:

```text
SENSOR | NETWORK | active pollutant | OBSERVED
```

The heading row MUST begin on the same data-column tracks as the body, after the Full leading control/gutter region.

Full MAY use the existing sortable heading controls/pills. These are the visible sorting UI for Full mode.

Header and body MUST inherit the same Full column template so heading positions, sort pills and body values share identical x tracks.

Do not position the pollutant or Observed blue sort controls independently from their value columns.

The outside-window divider MUST span the entire Full row across the leading region and every data column.

## Map/chart continuity

Switching map -> chart -> map MUST preserve the same authoritative area/list, row ordering, sort state, sensor identity, reading/time content and scroll owner.

Chart mode adds selection affordances. It does not choose an unrelated table layout.

When the same area and materially the same rows remain active, sensor-list scroll position SHOULD be preserved across mode transitions. If geometry changes require clamping, use the nearest valid scroll position rather than unconditionally resetting to the top.

## Three-visible-row sizing and scrolling

Where the selected-area sensor panel is constrained, approximately three complete real sensor rows SHOULD remain visible while every remaining rendered sensor stays reachable through the same internal vertical scroll owner.

The three-row limit applies only to viewport height. It MUST NOT limit row rendering.

Only the sensor-row region is vertically scrollable. Fixed controls/toolbars and the panel header remain outside that scroll owner.

The actual `.sensor-table-wrap` (or its authoritative existing equivalent) MUST be the constrained vertical scroll viewport. The implementation MUST NOT allow a full-content-height table to expand behind an ancestor with `overflow: hidden`, because that makes extra rows visually clipped but unreachable.

Overflow detection SHOULD use both rendered geometry and authoritative row count where appropriate. For example, when a deliberate three-real-row viewport is active, `sensorCount > 3` is sufficient to know that row scrolling is required even before final layout settles.

Existing custom scrollbar/indicator behaviour, outside-window divider rows and authoritative sensor ordering remain unchanged unless separately approved.

## Summary relationship below 768px

The authoritative mobile summary follows the sensor panel/list in both map mode and chart mode as defined by [`hex-map-summary-contract.md`](hex-map-summary-contract.md).

The stable lower-page order is:

```text
map mode:
  map
  sensor panel/list when selected
  summary
  footer

chart mode:
  station chart
  sensor panel/list
  summary
  footer
```

Summary presence MUST NOT change sensor-list scroll ownership or reduce the sensor-row viewport.

## Sort-state ownership

All visible sorting presentations MUST continue to update the same authoritative:

```text
sortKey
sortDir
```

state.

The responsive presentation changes only which sorting UI is visible:

```text
Narrow:  native compact Sort selector
Compact: native compact Sort selector
Full:    sortable table headings
```

Do not create separate narrow/compact/full sort state.

Pollutant changes MUST continue to update pollutant-specific sort labels while preserving the authoritative key/direction semantics.

## State and behaviour invariants

This presentation contract MUST NOT deliberately change:

```text
sensor eligibility
in-window / outside-window precedence
sensor ordering and tie-breaks
sortKey / sortDir semantics
maximum selected chart sensors
selected-sensor ordering
AQI-source selection semantics
pollutant switching semantics
station/network/readings/observed values
API requests
chart history loading
network-selection state
```

UK constituencies and Countries & Regions MUST use the same responsive sensor-list presentation rules.

## Implementation simplification rule

The implementation SHOULD remove obsolete conflicting layout rules rather than layering new overrides on top of them.

The final CSS SHOULD contain one understandable Narrow structure, one Compact component template and one Full/LIVE-compatible component template.

Obsolete structural rules for former 520/600/699/899px sensor-list variants, full-width stretched Sort presentation, duplicate narrow Network sort pills, conflicting chart-only Compact grids and manual header offsets SHOULD be removed when no longer required.

Shared Sensor / Network fit logic SHOULD remain one presentation helper with regime-specific state, not separate UK/C&R implementations.

## Validation rule

Before implementation, perform only structural checks needed to confirm current DOM ownership, Sort/control relocation, scroll ownership, reusable row/header geometry, the shared identity measurement hooks and the complete LIVE wide-table reference implementation, including its leading gutter/control region.

Do not create a speculative pre-deployment functional test suite.

Functional and visual acceptance occurs through real operation on TEST after deployment, including representative Narrow, Compact and Full widths and map -> chart -> map transitions.
