# Hex Map frontend architecture contract

## Authority and scope

This contract governs the internal frontend architecture of the UK AQ Hex Map
under:

```text
/hex_map/
```

and its dependency boundaries with shared website modules.

It describes the accepted modular architecture after the Hex Map
modularisation project. It does not redefine product behaviour, scientific
meaning, API contracts or data-source precedence.

Narrower contracts remain authoritative for their own scope. In particular:

- `station_charts/contract.md` governs shared station-chart controller,
  clients, cache behaviour, AQI-source behaviour and rendering;
- `website_ui/contract.md` governs shared responsive behaviour and mobile
  boundaries;
- `website_ui/hex-map-summary-contract.md` governs summary-card presentation
  and coverage-bar behaviour;
- `website_ui/hex-map-url-state-contract.md` governs public query-string state,
  direct-link restoration, canonicalisation and browser-history semantics;
- `website_ui/hex-map-population-contract.md` governs the current TEST-only
  interim population source, mixed reference-year meaning and population tooltip
  presentation;
- `website_ui/beta-ui-isolation-contract.md` governs beta-only assets;
- data, observation, AQI, R2-history and source-precedence contracts govern
  scientific and data meaning.

The Hex Map consumes those contracts. It must not create competing
implementations of their responsibilities.

## Architectural outcome

The Hex Map is one responsive application composed from bounded modules.

`/hex_map/index.html` is primarily a document shell containing:

```text
page markup
stylesheet references
page/shared injected configuration
intentional classic shared dependencies
one native ES-module application entry point
```

Large application subsystems must not be reintroduced inline.

The application entry point is:

```text
/hex_map/hex-map-bootstrap.js
```

The current architecture uses native browser ES modules. It does not require a
bundler, frontend framework or TypeScript build step.

## Ownership rule

Each mutable responsibility has one authoritative owner.

A compatibility interface may expose an authoritative owner to a classic,
UMD/CommonJS or late-bound consumer, but it must not maintain a second copy of
application state or a second implementation.

The DOM is presentation. It must not silently become a second authoritative
store for state already owned by a module.

## Page-wide coordinator

`hex-map-coordinator.js` owns the page-wide map settings that are genuinely
shared between UK and Countries & Regions views.

Its authoritative state includes the accepted equivalents of:

```text
active map key
selected map pollutant
map metric
colour scale
map display window
```

The coordinator does not own:

```text
UK or C&R map data
map-specific caches
network selection
C&R operational region
station-chart selection
station-chart range
station-chart request state
```

UK and C&R controllers consume coordinator snapshots and actions rather than
maintaining competing page-wide truth.

## Network selection

`hex-map-network-controller.js` is the authoritative Hex Map network-selection
owner.

It owns:

```text
network catalogue loading and successful catalogue state
selected-network state
network-selection persistence
Select All
keep-one-selected behaviour
checkbox and accessibility presentation
active UK/C&R network-scope presentation
```

The current persistence key is:

```text
uk-aq-hex-map-network-selection-v1
```

The page has one shared network-catalogue request/in-flight owner. Failed loads
must not create a second catalogue owner.

Public network-catalogue eligibility does not automatically make every public
network eligible for the Hex Map product.

The canonical `black_carbon` network is explicitly excluded from Hex Map
network selection in the current Wood Burning / Black Carbon phase, even when
it is returned by the public network catalogue. The network controller MUST
exclude it before constructing the selectable/persisted Hex network set. Select
All MUST exclude it, and stale persisted selection MUST NOT reintroduce it.

This is a product-specific exclusion, not a change to
`public_display_enabled`. The narrower rationale and future-decision boundary
are defined by [wood-burning-page-contract.md](wood-burning-page-contract.md).

UK, C&R, toolbar and chart integration consume selected-network snapshots or
the network-controller interface. They must not reconstruct authoritative
network state from checkbox DOM.

## URL and browser history

`hex-map-url-state.js` remains the sole Hex Map browser-history owner.

The authoritative public URL-state contract is
[`hex-map-url-state-contract.md`](hex-map-url-state-contract.md). It now
requires the accepted equivalents of:

```text
map
pollutant
networks
window
metric
color_scale
area
mode
chart_range
```

to be shareable/bookmarkable subject to that contract's validity, dependency
and canonicalisation rules.

Individual selected chart stations, AQI-source station choice, search state,
zoom/pan state and other presentation/session state explicitly excluded by the
URL-state contract remain non-URL-backed.

Map controllers and controls MUST NOT independently call browser history APIs
for product navigation outside the URL-state owner. They expose/consume bounded
state-owner interfaces and let the URL-state owner coordinate query/history
representation.

Direct URLs MUST restore requested valid public state without first causing an
unrelated default-map or default-area request.

## Page mode

`hex-map-page-mode.js` owns whether the page is displaying the map or the
station-chart surface and which map context owns the active chart.

Its state is equivalent to:

```text
mode: "map" | "chart"
chartMapKey: "uk" | "cr" | null
```

The page-mode owner controls presentation transitions. Map controllers,
toolbar code and adapters must not infer authoritative page mode from incidental
DOM visibility.

Station-chart internal state remains owned by the shared station-chart
controller rather than the page-mode module.

## Toolbar and tab presentation

`hex-map-toolbar-controller.js` owns the shared visible toolbar presentation,
including the UK/C&R view controls and C&R region presentation.

It presents authoritative application state and invokes the relevant owners. It
must not become an alternative map-data, network-selection or URL-state owner.

Accessible attributes such as `aria-selected`, `aria-expanded` and button state
are rendered from authoritative state. They are not the source of that state.

## UK controller

`hex-map-uk-controller.js` is the bounded authoritative controller for the UK
constituency view.

It owns UK-specific responsibilities including:

```text
constituency geometry and identity
UK map data requests and stale-result protection
UK map rendering
UK selected constituency state
UK sensor-panel state and rendering
UK map polling/refresh lifecycle
UK summary calculation context
UK Search/map integration interfaces
UK station-chart launch/context integration
```

It consumes page-wide coordinator and network-controller state.

It must not own shared station-chart clients, cache, renderer, AQI calculation
or network-selection truth.

## Countries & Regions controller

`hex-map-cr-controller.js` is the bounded authoritative controller for the
Countries & Regions local-authority view.

It owns C&R-specific responsibilities including:

```text
active operational region
local-authority geometry and identity
region-specific geometry and aliases
C&R map data requests and stale-result protection
C&R map rendering
selected local-authority state
C&R sensor-panel state and rendering
C&R map polling/refresh lifecycle
C&R summary calculation context
cross-region Search support required by the C&R product
C&R station-chart launch/context integration
```

C&R is intentionally not collapsed into the UK controller.

UK and C&R have similar lower-level operations but materially different
geometry, area identity and operating semantics. Shared pure domain/data
definitions may be reused, but one parameterised universal map controller is
not the accepted architecture.

## Interim population data ownership

The current TEST-only interim population behaviour is defined by
[`hex-map-population-contract.md`](hex-map-population-contract.md).

Under that interim contract:

- the UK controller owns loading and lookup of the current 2024 Parliamentary
  Constituency population static asset;
- the C&R controller owns loading and lookup of the current 2025 Local
  Authority population static asset;
- population lookup is supplementary page data and does not become coordinator
  state, network state or station-chart state;
- population static data is not part of the air-quality Refresh/poll lifecycle;
- a population load failure must not change normal map, AQ, sensor or chart
  operation.

This ownership is deliberately narrow. It does not promote population data into
`/shared/data/` merely because both controllers display the same field, and it
does not activate the unfinished Supabase population endpoint.

## Search

`hex-map-search.js` owns Hex Map search interaction and result orchestration.

It may consume bounded map interfaces to:

```text
search current map data
preload/search the inactive map where current product behaviour requires it
switch map or C&R region for a selected result
select the destination area or sensor context
```

Search owns its own debounce, request-sequence and request-cancellation
protection.

It does not own URL history, network selection, map data caches or station
charts.

## Zoom and pan

`hex-map-zoom-pan.js` owns Hex-specific SVG zoom/pan interaction.

Zoom/pan state is page-local presentation state and is not URL-backed.

The module must not affect data selection, network state or map request
semantics.

## Scroll affordances

`hex-map-scroll-affordances.js` owns the current Hex-specific persistent
scrollbar/scroll-indicator behaviour used by the map sensor panels.

It remains Hex-owned unless another page deliberately adopts the same
behaviour and a separate shared-UI decision is made.

## Selected-area viewport framing

`hex-map-viewport-framing.js` owns selected-area document viewport framing for
both UK and C&R map mode across all viewport widths.

UK and C&R controllers retain authoritative area selection and sensor-panel
rendering. After a selected area has rendered its panel, they request framing
from this shared Hex-specific owner rather than implementing desktop/mobile or
UK/C&R-specific page-scroll logic.

Selected-area framing MUST:

```text
wait until the selected hex, sensor panel and first sensor row have stable measurable geometry
measure the current visual viewport, with a normal viewport fallback where required
make no document-scroll change when the first sensor row is already fully visible
otherwise scroll by only the minimum amount required to expose the first sensor row
keep the selected hex visible as well when both endpoints can fit in the viewport
prioritise exposing the first sensor row when the full selected-hex-to-first-sensor frame cannot fit
respect reduced-motion preference when choosing scroll behaviour
cancel or supersede stale pending framing work when selection/context changes
```

The decision MUST use actual rendered geometry. It MUST NOT use a fixed viewport
width, named region such as London, UK/C&R map type, device class or user-agent
heuristic as a substitute for visibility measurement.

This responsibility is cross-width presentation behaviour, not mobile layout
behaviour. `hex-map-mobile-map-layout.js` MUST NOT remain the owner of generic
selected-area framing. It may continue to own mobile-only layout/control
adaptation and mobile-only chart viewport framing while that chart behaviour
remains authorised only below `768px`.

The viewport-framing owner does not own selected-area state, sensor ordering,
sensor-panel rendering, map transforms, station-chart state, data requests or
browser-history state.

## Summary presentation

`hex-map-summary.js` is the bounded presenter for the UK and C&R top summary
cards.

UK and C&R controllers calculate the map-specific input context and pass it to
the presenter.

The summary presenter must not change:

```text
sensor eligibility
coverage calculations
network filtering
pollutant filtering
map request behaviour
```

The narrower Hex Map summary contract remains authoritative for card
presentation, coverage values and coverage-bar behaviour.

## Station-chart boundary

The Hex Map does not implement the station chart.

Its page adapter is:

```text
/hex_map/hex-map-station-chart-adapter.js
```

with the associated ES-module interface where required by the runtime graph.

The adapter may translate Hex-specific context into the shared station-chart
interface, including:

```text
ordered selected sensor entries
current map/area context
Hex page-mode entry and exit
Hex selection presentation synchronisation
pollutant-context handoff
```

It must not own:

```text
network catalogue or network selection
map navigation
station-history requests
chart cache
AQI calculations
D3 chart rendering
a second chart state machine
```

## Shared station-chart implementation

The sole active shared station-chart implementation is under:

```text
/shared/station-chart/
```

Both Hex Map and Sensors consume that implementation through page-specific
adapters.

The shared station-chart subsystem owns the authoritative:

```text
chart controller
chart selection and range
observation-history planning and loading
AQI-history/source handling
chart cache
pollutant target/rendered context
cancellation/generation protection
diagnostics
D3 renderer
chart-intrinsic CSS/presentation
```

There must not be an independent Sensors renderer/controller/cache or an
independent Hex renderer/controller/cache.

Compatibility clients or ESM interfaces must delegate to or export the same
canonical implementation. They are not a licence for a second chart.

## Sensors boundary

The existing Sensors page is an active station-chart consumer.

Its application entry point is:

```text
/sensors/sensors-bootstrap.js
```

Sensors owns page/list behaviour and its page-specific chart adapter. It uses
the same `/shared/station-chart/` implementation as Hex.

Sensors code must not depend on `/hex_map/` application modules.

## Shared domain and data

Genuinely cross-page domain definitions live under:

```text
/shared/domain/
```

This includes canonical shared definitions such as pollutants and networks.

Genuinely cross-page data/catalogue ownership lives under:

```text
/shared/data/
```

This includes the canonical shared network catalogue where currently consumed
across pages.

A helper must not be moved into `shared` merely because its name appears
generic. Shared ownership is semantic and must have a real cross-page/domain
reason.

Hex-only and Sensors-only presentation/application behaviour remains with the
owning page.

## Shared authentication

The sole shared protected-cache authentication implementation is:

```text
/shared/auth/uk-aq-cache-auth.js
```

It is shared by the relevant website pages, including the homepage, Hex,
Sensors and Sensor Map.

The shared auth owner controls Turnstile/session behaviour for protected
cache requests and the session-free classification of explicitly contracted
public display reads.

The current session-free browser-read routes are governed by
[`../cache_proxy/public-display-data-routes-contract.md`](../cache_proxy/public-display-data-routes-contract.md).
For the Hex Map, normal requests to `/api/aq/networks`,
`/api/aq/latest-snapshot`, `/api/aq/pcon-hex` and `/api/aq/la-hex` MUST
NOT initialise Turnstile/session merely to render the public map. If the page
later invokes a genuinely protected route, the same shared auth owner may
establish the protected session at that point.

Page code may provide page/deployment configuration and bounded request timing
or diagnostics, but it must not duplicate either protected auth/session logic
or the public-route classification.

Turnstile remains an active protected-route mechanism. Hex Map CSS MUST NOT
force `#uk-aq-turnstile-widget-shared` to remain hidden or non-interactive
with `!important` visibility/pointer rules that override the shared auth
owner's runtime show/hide state.

Moving auth into `/shared/auth/` does not authorise page-specific duplicate
authentication or public-route logic.

## Beta asset isolation

Beta assets contain beta behaviour only.

```text
beta-notice.js  -> beta notice behaviour only
beta-notice.css -> beta notice presentation only
```

Permanent homepage, footer, Hex network or table-layout behaviour must not be
placed in beta assets.

Removing the beta notice at public launch must not remove unrelated permanent
website behaviour.

## CSS ownership

Permanent Hex-specific presentation belongs primarily in:

```text
/hex_map/hex-map.css
```

Shared website presentation remains in the relevant shared/site stylesheets,
and responsive behaviour remains subject to the shared website UI contract.

Station-chart-intrinsic presentation belongs to the shared station-chart
subsystem.

Beta-specific presentation remains in `beta-notice.css`.

There must not be separate desktop and mobile business logic.

## Module format and compatibility boundaries

The accepted browser application architecture uses native ES modules.

No bundler, frontend framework or TypeScript build pipeline is required for the
Hex application.

Some established shared implementations continue to support classic or
UMD/CommonJS consumers. Narrow ESM interface modules may import those canonical
implementations and export the same singleton object.

Such interfaces are compatibility boundaries, not duplicate implementations.

D3 remains an intentional classic shared dependency.

`ChartCore` remains an intentional classic chart-rendering dependency where the
shared renderer requires it.

A bounded global may remain when it is required for:

```text
a classic/UMD consumer
a Node/CommonJS harness
late-bound runtime-instance access
breaking an otherwise harmful ESM import cycle
```

A retained global must delegate to one authoritative owner. It must not maintain
parallel mutable state.

The architecture does not require a global purge for its own sake.

## Static asset and ES-module hashing

GitHub Pages publication uses the existing static asset content-hash process.

The hash/staging process must understand the complete static ES-module
dependency graph. It must:

```text
resolve static local imports
reject missing or unsupported imports
reject module cycles according to the deployment contract
hash dependencies before importers
rewrite staged import references with dependency hashes
propagate deep dependency changes to the HTML entry asset
```

A new module must remain compatible with this fail-closed publication model.

This contract does not authorise introducing a bundler merely to manage module
hashes.

## Cross-module communication

Normal communication is through explicit module interfaces.

Custom browser events may be retained where they are the accepted boundary, but
the event must have one producer/owner for the state it represents.

Compatibility globals may expose authoritative modules where required by a
classic or late-bound consumer.

Modules must not primarily communicate by scraping unrelated DOM to reconstruct
hidden application state.

## Request and generation ownership

Each asynchronous subsystem owns its own stale-result/cancellation mechanism.

Examples include:

```text
UK map load generation
C&R map load generation
Search request sequence/abort
shared station-chart generation/abort/in-flight state
```

The coordinator does not centralise all request state.

An older asynchronous result must not overwrite newer authoritative user state.

The modularisation project preserved existing request semantics. Request-abort
optimisation for UK/C&R is a separate behavioural decision.

## Event-listener ownership

Each page interaction has one event-listener owner.

The architecture must not reintroduce duplicate handlers for:

```text
Refresh
network selection
pollutant selection
C&R region selection
toolbar/tab navigation
sensor selection
chart launch/back
page-mode changes
Search
zoom/pan
```

Modules that may be mounted or replaced must expose lifecycle cleanup where
needed. One-time page-lifetime modules may document page-lifetime ownership
instead of adding artificial lifecycle complexity.

## Data and scientific invariants

Frontend modularisation must not alter:

```text
observation values
observation timestamps
network identities
sensor/timeseries identities
pollutant mappings
area calculations
sensor eligibility
AQI calculations
WHO calculations
source precedence
history continuity
units
```

No scientific calculation may be moved into page-specific browser code as a
consequence of this architecture.

## Product invariants

Unless a narrower approved change says otherwise, the architecture preserves:

```text
network selection
pollutant selection
region/area selection
hex colouring
sensor listing and selection
maximum selected-sensor rules
chart symbol/order behaviour
map settings
summary information
chart launch and return
station-chart range and Refresh behaviour
URL behaviour
responsive behaviour
accessible control semantics
```

## No dual architecture

A migrated responsibility has one active implementation.

Do not reintroduce:

```text
an old inline implementation alongside a module
independent Hex and Sensors station charts
two selected-network owners
two URL/history writers
two page-mode owners
duplicate auth/session implementations
parallel desktop/mobile application logic
```

Compatibility interfaces must delegate to the authoritative implementation.

## Deferred work outside this contract

The completed modularisation does not include or require the following separate
product/optimisation work:

```text
Highest Areas five-row/table redesign
font-size fallback for long one-word area names
Updated -> Observed terminology reconciliation
UK/C&R request-abort optimisation
transient 502 handling redesign
preload-warning cleanup
mobile redesign
unrelated UI polish
```

Those items must not be treated as incomplete modularisation.

## TEST-first and LIVE boundary

The modularisation was implemented and accepted in TEST first.

This contract does not itself authorise a LIVE repository change.

Promotion to LIVE remains a separate deployment decision using the project's
normal TEST-to-LIVE process.

## Documentation ownership

This active architecture contract describes the realised steady state.

Migration history and phase-by-phase implementation details belong in the
completed implementation plan or an implementation record rather than in this
contract.

If future implementation changes one of these ownership boundaries, update the
authoritative documentation as part of that separately approved change.
