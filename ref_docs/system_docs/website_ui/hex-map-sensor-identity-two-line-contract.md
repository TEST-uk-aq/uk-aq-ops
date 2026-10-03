# Hex Map sensor identity responsive line-mode contract

**Status: ACTIVE TEST IMPLEMENTATION CONTRACT - COMPACT/NARROW SENSOR IDENTITY**

## Authority and scope

This is the single narrow authority for combined Sensor / Network identity presentation in the Hex Map selected-area sensor list for:

```text
Narrow: viewport < 768 CSS px
Compact: viewport >= 768 CSS px AND sensor-table width < 860 CSS px
```

For Sensor / Network line mode, wrapping, truncation, separator behaviour and fit measurement, this contract supersedes any conflicting wording in:

- [`hex-map-compact-sensor-list-contract.md`](hex-map-compact-sensor-list-contract.md)
- [`hex-map-mobile-sensor-list-contract.md`](hex-map-mobile-sensor-list-contract.md)
- [`hex-map-sensor-list-presentation-contract.md`](hex-map-sensor-list-presentation-contract.md)

Those broader contracts may summarise this behaviour but MUST NOT redefine it.

Full presentation at sensor-table width `>=860px` is unchanged and continues to use separate Sensor and Network columns.

## Shared identity invariants

The rendered identity is formed from the existing authoritative row content:

```text
Sensor name
Network name
```

The canonical Sensor name MUST remain complete in Narrow and Compact identity presentation. Do not mutate, shorten or ellipsise Sensor names to make the layout fit.

The Network name remains secondary text and MUST remain atomic on one rendered line. For example, `Breathe London` MUST NOT split as:

```text
Breathe
London
```

The separator rule is based on the actual final rendered line relationship:

```text
Sensor and Network share the same rendered line -> show ·
Sensor and Network are on different rendered lines -> no dot
```

Where the separator is shown, its visual spacing is authoritative:

```text
Sensor name · Network name
```

There MUST be a small deliberate and visually balanced gap on BOTH sides of the centred dot. The dot MUST NOT touch the Sensor name, and the Network name MUST NOT touch the dot. The implementation SHOULD create that spacing with explicit CSS geometry, such as equal inline margins around a dot-only pseudo-element, rather than embedding literal whitespace in the generated content. This makes the visual spacing deterministic and ensures fit measurement uses the same final geometry.

The dot MUST never be stranded at the end of one line or by itself at the start of another.

All fit decisions involving a same-line Sensor / Network presentation MUST measure the exact final separator geometry, including the dot and both authorised side gaps. The implementation MUST NOT measure one geometry and then render a narrower geometry which can pull Network back onto the Sensor line without the dot.

For a candidate complete one-line identity, the implementation MUST first test the final form with the dot and both separator gaps present:

```text
Sensor name · Network name
```

If that exact candidate does not fit on one line, it does not qualify as a one-line identity and the applicable two-line geometry MUST be used.

For a two-line Sensor name where Network might share the Sensor's final line, the same rule applies. Measure the final shared-line candidate with the dot and both gaps present. If `Sensor continuation · Network name` fits, keep it on that line and render the dot. If it does not fit with the complete separator geometry, Network MUST be forced onto its own line and the dot MUST be absent. The final CSS layout MUST preserve that measured decision rather than allowing Network to reflow back onto the Sensor line after the separator is removed.

Fit decisions MUST use actual rendered geometry. Character counts, station-name length guesses and arbitrary extra viewport breakpoints are not authorised.

UK constituencies and Countries & Regions MUST use the same shared presentation logic.

## Narrow regime: list-wide line mode

For `viewport <768px`, the decision remains **list-wide**, not row-by-row.

### Narrow one-line list mode

Use one-line mode only when every real row in the rendered list can show the complete final identity, including the final dot and both separator gaps, on one line:

```text
Sensor name · Network name
```

If all rows fit, every row stays on one line and every row shows the centred dot.

Example:

```text
Bazely St · Breathe London
Woolmore St · Breathe London
Branch Road · Breathe London
```

### Narrow two-line list mode

If even one real row needs a second identity line, the **whole Narrow list** switches to two-line geometry.

A short Sensor name then uses:

```text
Bazely St
Breathe London
```

There is no dot because Sensor and Network are on different rendered lines.

A Sensor name that itself reaches line two MUST keep its full name. Where the complete `Sensor continuation · Network` candidate fits after the Sensor continuation on that same second line, it follows with the centred dot and the same balanced spacing:

```text
R-Urban Poplar & Leaders in
Community · Breathe London
```

If that exact candidate does not fit with the complete separator geometry included, Network MUST start its own line with no dot. It MUST NOT be allowed to fall back onto the Sensor continuation line merely because the dot and its spacing were then removed.

This behaviour remains required on Narrow screens.

The following is not acceptable:

```text
R-Urban Poplar & Leaders in
Community
```

The Network MUST NOT disappear when the Sensor name uses line two.

The following is also not acceptable:

```text
R-Urban Poplar & Leaders in Commu…
Breathe London
```

The Sensor name MUST NOT be truncated to make room for the Network.

The Narrow list has one identity mode at a time:

```text
all rows fit complete Sensor · Network on one line
  -> all rows use one-line mode

one or more rows need a second line
  -> all rows use two-line geometry
```

In Narrow two-line mode, a small row-level measurement MAY distinguish whether the Sensor itself reaches line two, solely so the Network can either start its own second line or follow the Sensor continuation on the second line. Any shared-final-line decision MUST be measured with the final dot and both separator gaps present.

The list-wide Narrow mode MUST be re-evaluated when relevant geometry changes, including sensor rows changing, available identity width changing, map/chart-selection mode changing the identity width, or crossing the `768px` boundary.

## Compact regime: per-row rendered fit

For `viewport >=768px` while the sensor-table available inline width is `<860px`, the identity decision is **per row**.

One Compact row MUST NOT be forced into two-line identity geometry merely because a different row in the same list needs wrapping.

For each real row independently:

```text
complete Sensor · Network, including the final dot and both separator gaps, fits on one rendered line
  -> keep that row on one line and show ·

complete identity with the complete separator geometry does not fit on one rendered line
  -> allow that row to use two-line identity geometry
```

Therefore a Compact list MAY legitimately contain both:

```text
Bazely St · Breathe London
```

and a longer two-line identity such as:

```text
R-Urban Poplar & Leaders in
Community · Breathe London
```

at the same time.

For a Compact row using two lines:

- preserve the complete Sensor name;
- keep the Network name atomic on one rendered line;
- if the Network shares the final rendered Sensor line, show the centred dot with the same small balanced gap on both sides;
- decide that shared-line state using the final rendered dot geometry, including both side gaps;
- if the complete `Sensor continuation · Network` candidate does not fit, force Network onto a separate rendered line and show no dot;
- do not allow Network to reflow back onto the Sensor line after the no-dot state is applied;
- do not force unrelated short rows into a second line;
- do not truncate the Sensor merely to preserve uniform row heights.

Compact row height MAY therefore vary according to the actual rendered identity. Existing bounded list scrolling continues to follow real rendered row height.

The Compact per-row decision MUST be re-evaluated when relevant geometry changes, including sensor rows changing, sensor-table width changing, map/chart-selection mode changing the identity width, or crossing either responsive regime boundary.

## Exceptional fit

The expected real TEST cases should fit within the authorised one/two-line presentation.

If an exceptional complete Sensor + atomic Network combination genuinely cannot fit within the available two-line identity geometry, preserve the complete Sensor identity and treat it as a TEST layout exception. Do not silently truncate the Sensor, hide the Network or create a third behavioural regime.

The existing generic `[data-hex-truncation]` tooltip system remains separate and continues to serve unrelated clipped fields and Full-mode behaviour. It MUST NOT become a substitute for preserving canonical Sensor identity.

## Implementation direction

Reuse the existing authoritative row markup:

```text
.sensor-identity-cell
  .sensor-name-button
  .sensor-network-text--compact
```

Keep one shared responsive identity helper for UK and C&R.

The implementation MAY use:

- list-level state for the Narrow list-wide mode;
- row-level state for Compact per-row line mode and for the small Narrow `Sensor reaches line two` distinction;
- explicit row state which forces Network onto its own line after a shared-final-line candidate fails with the complete separator geometry included.

The final dot SHOULD be produced from one consistent CSS presentation rule. Prefer a dot-only generated character plus equal explicit inline spacing on both sides instead of multiple separator strings containing literal spaces. Its spacing treatment MUST be the same in Narrow and Compact and SHOULD also be reused by other same-line Sensor / Network identity surfaces where practical.

The implementation MUST NOT create separate UK and C&R measurement paths, duplicate sensor renderers, mutate Sensor text or create new sensor-list state unrelated to presentation.

When moving between Narrow and Compact, stale list-level or row-level measurement attributes MUST be cleared so one regime cannot leak its presentation state into another.

## Row geometry

Narrow one-line mode uses one-line identity geometry for every real row.

Narrow two-line mode uses the same two-line identity geometry for every real row, including short Sensor names.

Compact uses row-local geometry: rows that fit remain one-line identities and only rows that need wrapping use two-line identity geometry.

The bounded sensor-list viewport and existing scrolling ownership remain unchanged.

## Full-mode isolation

At sensor-table width `>=860px`, preserve the existing Full table with separate Sensor and Network columns.

No Narrow or Compact identity measurement state may alter Full-mode presentation.

Full mode has no combined Sensor / Network dot separator because Sensor and Network occupy separate columns.

## Invariants

This contract MUST NOT alter:

```text
canonical Sensor names
canonical Network names
sensor eligibility or count
sensor ordering
Sort semantics
pollutant/window meaning
readings
Observed timestamps
chart-selection semantics
station-chart behaviour
API requests
URL/history semantics
Full-mode separate Sensor/Network columns
```

## Validation rule

Before implementation, perform only the structural checks needed to confirm the existing shared identity markup and refresh hooks can support exact separator-aware rendered-fit measurement, Narrow list-level state and Compact row-level state without duplicating UK/C&R behaviour.

Do not create a speculative pre-deployment functional or screenshot test suite.

Functional and visual acceptance occurs through real TEST operation after deployment. Representative acceptance should confirm:

```text
Narrow:
  one-line qualification includes the actual dot and both side gaps
  one long identity makes all rows use the authorised two-line list geometry
  a Network sharing the Sensor continuation line always has the dot with balanced spacing
  a Network that cannot fit there with the complete separator is forced onto its own line

Compact:
  short rows stay Sensor · Network on one line while only genuinely long rows wrap
  one-line qualification includes the actual dot and both side gaps
  no same-line Sensor / Network pair is rendered without the dot
  a failed shared-final-line candidate remains on separate lines after measurement

Full:
  separate Sensor and Network columns remain unchanged
```
