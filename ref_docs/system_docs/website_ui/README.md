# Public website UI system area

## Purpose

This directory is the authoritative entry point for public UK AQ website presentation and interaction behaviour.

It owns shared responsive/page-shell rules and narrower presentation contracts for specific website components. It does not own API/data semantics, scientific calculations, station-chart internals or Pages artifact construction.

For the cross-system map, start with [`../SYSTEM_OVERVIEW.md`](../SYSTEM_OVERVIEW.md).

## Choose the smallest task route

### Shared responsive UI or page shell

Read [`contract.md`](contract.md).

Use it for the shared `<768px` responsive boundary, single-application rule, touch targets, shared navigation, accessibility, desktop isolation and responsive data/API invariants.

Add [`validation.md`](validation.md) only when planning or reviewing deployment acceptance for shared responsive behaviour.


### Shared sidebar navigation

Read:

1. [`contract.md`](contract.md)
2. [`sidebar-navigation-contract.md`](sidebar-navigation-contract.md)

Use the sidebar contract for shared `/sidebar.js` menu ordering, icon geometry, vertical item spacing, overflow/scroll behaviour, Resources/Contact placement and preservation of existing hover, pin, drawer and navigation-handoff behaviour.

The sidebar contract is the narrower authority for navigation presentation. The broad responsive contract remains authoritative for the shared mobile boundary and page-specific constrained-width sidebar occupancy rules.

### Shared line-chart presentation

Read [`shared-line-chart-presentation-contract.md`](shared-line-chart-presentation-contract.md).

Use it for cross-page line-chart visual conventions including subtle horizontal dotted/short-dash Y-grid lines, solid data-line priority, deterministic multi-series colour treatment and accessible interactive legend behaviour where a page provides a series legend.

For existing Hex Map/Sensors station-chart rendering, also read [`../station_charts/README.md`](../station_charts/README.md); the station-chart subsystem remains the sole renderer/controller owner. For Wood Burning monthly-profile specifics, also read [`wood-burning-page-contract.md`](wood-burning-page-contract.md).

### Shared site-footer attribution

Read [`site-footer-attribution-contract.md`](site-footer-attribution-contract.md).

Use it for shared data-source/licence attribution blocks, `network_code` mapping, public-network-driven footer visibility, catalogue reuse and fail-open attribution behaviour.

If the task changes `/api/aq/networks`, public-network eligibility, origin/session behaviour or network catalogue response semantics, also read [`../cache_proxy/public-network-catalog-contract.md`](../cache_proxy/public-network-catalog-contract.md). The cache-proxy contract owns those data/API rules; the footer contract owns presentation only.

### Wood Burning page

Read:

1. [`contract.md`](contract.md)
2. [`shared-line-chart-presentation-contract.md`](shared-line-chart-presentation-contract.md)
3. [`wood-burning-page-contract.md`](wood-burning-page-contract.md)

Use the Wood Burning page contract for the `/wood-burning/` presentation: the three summary cards, mobile summary relocation, simple geographical sensor map, paired Summer/Winter BC/UV charts and their monthly legend interaction, canonical `black_carbon` network identity and the current decision to keep Black Carbon out of the Hex Map.

If the task changes the shared Defra/UK-AIR footer presentation, also read [`site-footer-attribution-contract.md`](site-footer-attribution-contract.md).

The Wood Burning contract still leaves final editorial copy, the exact BC/UV/UVPM property-switching control, Clean Air Night-specific content, richer map popup behaviour and any future Hex Map Black Carbon mode for later explicit decisions.

### Hex Map live-network eligibility

Read [`hex-map-live-network-eligibility-contract.md`](hex-map-live-network-eligibility-contract.md).

Use it when changing which canonical networks are eligible for the live/latest Hex Map, the `networks.live_map_enabled` field, Hex network-catalogue filtering, persisted network selection reconciliation or the rule that non-live network rows must not participate when Hex Map selection is "all".

If the task changes the public `/api/aq/networks` shape, also read [`../cache_proxy/public-network-catalog-contract.md`](../cache_proxy/public-network-catalog-contract.md). If it changes the IngestDB-to-ObsAQIDB network row, also read [`../ingest/network_catalogue_mirror_contract.md`](../ingest/network_catalogue_mirror_contract.md).

The shared footer remains governed by [`site-footer-attribution-contract.md`](site-footer-attribution-contract.md) and deliberately does not use `live_map_enabled` for visibility.

### Future Hex Map canonical physical-site grouping

**Status: future implementation authority; TEST-first, not current runtime.**

Read:

1. [`hex-map-canonical-site-contract.md`](hex-map-canonical-site-contract.md)
2. [`../latest_snapshot/canonical-site-projection-contract.md`](../latest_snapshot/canonical-site-projection-contract.md)
3. [`../station_identity/README.md`](../station_identity/README.md)

Use this route for one Hex Map sensor row per canonical physical site, AURN plus devolved-network identity display, network filtering before physical-site grouping, physical sensor counts and non-double-weighted Hex aggregation.

Add [`hex-map-sensor-list-presentation-contract.md`](hex-map-sensor-list-presentation-contract.md) and [`hex-map-sensor-identity-two-line-contract.md`](hex-map-sensor-identity-two-line-contract.md) only when the implementation also changes responsive row geometry or wrapping. Add [`hex-map-live-network-eligibility-contract.md`](hex-map-live-network-eligibility-contract.md) when changing eligible network catalogue semantics rather than merely consuming the existing eligible set.

### Hex Map interim population display

Read:

1. [`hex-map-population-contract.md`](hex-map-population-contract.md)
2. [`hex-map-modularisation-contract.md`](hex-map-modularisation-contract.md) when changing controller/data-loading ownership

Use the population contract for the current TEST-only static population snapshot, current-boundary code matching, mixed per-area reference years, tooltip format `Population: 123,456 (2025)`, fail-open behaviour and the boundary with the unfinished population-ingest/API path.

The displayed year is the population estimate reference year, not the publication year. The current interim implementation must not require Supabase or an Edge Function at browser runtime.

### Hex Map public URL/shareable state

Read [`hex-map-url-state-contract.md`](hex-map-url-state-contract.md).

Use it for Hex Map query parameters, shareable/bookmarkable state, `network_code` URL selection, map display window, selected-area codes, chart mode/range deep-linking, canonicalisation and browser Back/Forward behaviour.

The public contract deliberately excludes station/timeseries identifiers, search text, zoom/pan and internal diagnostic/cache parameters. For implementation ownership, also read [`hex-map-modularisation-contract.md`](hex-map-modularisation-contract.md). For eligible Hex network semantics, also read [`hex-map-live-network-eligibility-contract.md`](hex-map-live-network-eligibility-contract.md).

### Hex Map internal frontend architecture

Read [`hex-map-modularisation-contract.md`](hex-map-modularisation-contract.md).

Use it for Hex module/state ownership, bootstrap, UK/C&R controllers, network state, URL/history, page mode, toolbar, Search, shared domain/data/auth boundaries and the Hex adapter boundary with the shared station chart.

Read [`hex-map-modularisation-validation.md`](hex-map-modularisation-validation.md) only when historical migration/reconciliation evidence or the accepted modularisation baseline is relevant.

Do not load the modularisation contract for an unrelated visual-only component change.

### Hex Map narrow-screen layout

Read:

1. [`contract.md`](contract.md)
2. [`hex-map-mobile-layout-contract.md`](hex-map-mobile-layout-contract.md)

Use the narrow contract for the authorised `<768px` Hex Map map-first Phase 1 hierarchy and the current narrow-screen chart-mode presentation, including search placement, summary removal above the map, provisional distributed map controls, chart-control relocation, mobile Networks presentation, chart-to-sensor-list flow, desktop isolation and mobile ownership boundaries.

If the task changes the Hex Map mobile title row, hamburger/page-title composition or top-right UK AQ logo, also read:

3. [`mobile-header-contract.md`](mobile-header-contract.md)
4. [`hex-map-mobile-header-contract.md`](hex-map-mobile-header-contract.md)

The Hex Map mobile-header contract is the narrower authority for the `/hex_map/` two-line mobile UK AQ logo and compact title-row composition.

The active layout contract currently promotes the Phase 1 map presentation plus the accepted narrow-screen chart presentation. Later search-overlay behaviour, sensor bottom sheet, final map-control design, compact summary, region labels, long press, draggable sheet mechanics and tablet-specific layout remain deferred until separately accepted.

The fuller design source and implementation plan are retained under `plans/drafts/website_ui/` as non-authoritative planning material.

### Hex Map compact sensor list

Read:

1. [`contract.md`](contract.md)
2. [`hex-map-compact-sensor-list-contract.md`](hex-map-compact-sensor-list-contract.md)
3. [`hex-map-sensor-identity-two-line-contract.md`](hex-map-sensor-identity-two-line-contract.md) when the task touches combined Sensor / Network fit, wrapping, line mode or separators

Use this route for the intermediate-width selected-area sensor list where the viewport is at least `768px` but the sensor-table's available inline width is below `860px`.

This compact contract owns the visible compact heading row, shared map/chart grid tracks, hidden dedicated Network column, per-sensor chart-launch lane, chart-selection lanes, row placement and compact scroll/fade geometry.

The dedicated identity contract is the single authority for combined Sensor / Network fit. In Compact it requires a per-row rendered-fit decision: short rows remain `Sensor · Network` on one line while only rows that genuinely need wrapping use two-line identity geometry. This differs deliberately from the list-wide Narrow rule below `768px`.

It is distinct from [`hex-map-mobile-sensor-list-contract.md`](hex-map-mobile-sensor-list-contract.md), which remains the authority below `768px`, and from the normal full desktop table at sensor-table widths of `860px` and above.

Add [`hex-map-modularisation-contract.md`](hex-map-modularisation-contract.md) only if the task crosses into Hex state/module ownership rather than remaining presentation-only. Add the station-chart contracts only if the task changes chart internals rather than the surrounding sensor-list presentation.

### Hex Map narrow/mobile sensor list

Read:

1. [`contract.md`](contract.md)
2. [`hex-map-mobile-sensor-list-contract.md`](hex-map-mobile-sensor-list-contract.md)
3. [`hex-map-sensor-identity-two-line-contract.md`](hex-map-sensor-identity-two-line-contract.md) when the task touches Sensor / Network fit, wrapping, line mode or separators

Below `768px`, the mobile sensor-list contract owns the touch-first stacked row, left chart/control lanes, reading/Observed placement, typography, bounded internal scrolling and native page hand-off. The dedicated identity contract keeps Narrow Sensor / Network line mode list-wide: one row needing a second line puts all Narrow identities into the authorised two-line geometry.

Do not infer that Narrow list-wide identity behaviour also applies to Compact/tablet rows.

### Hex Map legend presentation

Read [`hex-map-legend-contract.md`](hex-map-legend-contract.md).

Use it for Hex Map legend positioning, rounded-card treatment, wide one-row versus narrow two-row internal layout, title/scale centring and the component-width threshold based on rendered map-canvas width.

The legend contract is the narrower authority for the legend itself. It explicitly distinguishes the shared site mobile boundary (`viewport <768px`) from the legend's current component layout boundary (`map-canvas inline width <=660px`) and owns control-clearance positioning so the legend is centred within the usable map region rather than blindly across the whole map.

Add [`hex-map-mobile-layout-contract.md`](hex-map-mobile-layout-contract.md) only when the task also changes the surrounding `<768px` Hex Map hierarchy or distributed controls.

### Hex Map top summary presentation

Read [`hex-map-summary-contract.md`](hex-map-summary-contract.md).

Add [`hex-map-summary-validation.md`](hex-map-summary-validation.md) only for its implementation/acceptance path.

This contract owns summary-card presentation and coverage-bar behaviour, not map calculations or data semantics.

### Beta-only UI isolation

Read [`beta-ui-isolation-contract.md`](beta-ui-isolation-contract.md).

Use it when changing `/beta-notice.css`, `/beta-notice.js` or permanent UI currently loaded beside beta assets. Permanent behaviour must remain independent of removable beta-only assets.

### Shared mobile header and navigation chrome

Read:

1. [`contract.md`](contract.md)
2. [`mobile-header-contract.md`](mobile-header-contract.md)

For homepage-specific mobile logo sizing, subtitle visibility and section-shell presentation, also read [`homepage-mobile-contract.md`](homepage-mobile-contract.md), which explicitly overrides the homepage's default fixed-width one-line-logo and subtitle rules below `768px` while preserving shared `/sidebar.js` ownership.

For Hex Map-specific mobile header work, also read [`hex-map-mobile-header-contract.md`](hex-map-mobile-header-contract.md), which explicitly overrides the default one-line mobile-logo presentation for `/hex_map/` only.

Add [`mobile-header-validation.md`](mobile-header-validation.md) only when validating a corresponding implementation.

### Homepage mobile shell and controls

Read:

1. [`contract.md`](contract.md)
2. [`homepage-mobile-contract.md`](homepage-mobile-contract.md)

Add only the narrower homepage component contract actually being changed.

If the task touches the mobile **Latest News on Air Quality** teaser, also read [`homepage-media-carousel-contract.md`](homepage-media-carousel-contract.md). The homepage-mobile contract owns its placement relative to the Beta notice and first divider; the Media contract owns the teaser artwork, article pill, typography, link cue/icon and Media state behaviour.

Use [`homepage-mobile-validation.md`](homepage-mobile-validation.md) only for post-deployment acceptance of the mobile homepage shell/controls.

### Homepage network scope

Read [`homepage-network-scope-contract.md`](homepage-network-scope-contract.md).

Use it for homepage network inclusion, removal of the Networks picker, the fixed all-public-network dashboard scope, catalogue-failure behaviour and the boundary with Hex Map-only `live_map_enabled` filtering.

If the task changes `/api/aq/networks`, `public_display_enabled`, origin/session behaviour or catalogue response semantics, also read [`../cache_proxy/public-network-catalog-contract.md`](../cache_proxy/public-network-catalog-contract.md). The cache-proxy contract owns public eligibility and API behaviour; the homepage contract owns how the homepage consumes that catalogue.

Add [`homepage-mobile-contract.md`](homepage-mobile-contract.md) only when the same task also changes the wider below-`768px` homepage presentation.

### Homepage Highest area readings

Read [`homepage-area-readings-contract.md`](homepage-area-readings-contract.md).

Add `homepage-mobile-contract.md` only when the change also affects the wider homepage mobile interaction layer. The area-readings contract remains the narrower authority for that table's rendered-fit geometry and responsive presentation.

### Homepage WHO summary presentation

Read [`homepage-who-summary-contract.md`](homepage-who-summary-contract.md).

Add [`homepage-who-summary-validation.md`](homepage-who-summary-validation.md) only for implementation/acceptance work.

If the task changes WHO calculations, publication or source selection, route to [`../who_2021/README.md`](../who_2021/README.md).

If it changes `/api/aq/who-summary`, R2-reader freshness, cache behaviour or browser fallback/data precedence, route to [`../cache_proxy/who-summary-contract.md`](../cache_proxy/who-summary-contract.md).

Do not load those backend contracts for a presentation-only WHO card change.

### Standalone WHO guidelines page

Read [`who-guidelines-page-contract.md`](who-guidelines-page-contract.md).

This is an authoritative **future implementation contract** for `/who-guidelines/`. It owns the page title/navigation integration, one randomly selected GOV.UK AURN PM2.5 sensor, the shared 365-day presentation model and the four temporary comparison renderers: calendar months, one month per row, continuous weeks and quarter strips.

For the future browser data boundary, also read [`../cache_proxy/who-daily-series-contract.md`](../cache_proxy/who-daily-series-contract.md). The website MUST consume canonical WHO daily derived results and MUST NOT recalculate WHO classifications from raw observations.

If the task changes WHO science, daily completeness, rolling-year semantics or publication, route instead to [`../who_2021/README.md`](../who_2021/README.md).

The page and API remain future implementation until implemented and accepted on TEST.

### Homepage Latest News on Air Quality Media surface

Read [`homepage-media-carousel-contract.md`](homepage-media-carousel-contract.md).

Use it for homepage Media placement, heading artwork, desktop/dashboard-preview article-card parity, external-link cue/icon, arrows/dots, eight-second rotation, quiet failure behaviour and the responsive ranges:

- below `768px`: compact mobile teaser below the Beta notice, using the one-line title artwork and a dark-blue text article pill with a persistent external-link indicator;
- `768px` through `926px`: compact desktop/tablet Media pill;
- `927px` and above: normal full-size desktop Media pill.

For below-`768px` work, also read [`homepage-mobile-contract.md`](homepage-mobile-contract.md), which owns the surrounding mobile flow, outer-card flattening and the first divider position after the complete Media teaser.

For Media image acquisition, public-feed/editorial semantics and cached preview delivery, follow the Media contracts referenced by the Media contract. Website code must remain a presentation consumer and must not create its own publisher scraper or image cache.

The current homepage Media integration is TEST-only. It does not authorise LIVE Media cut-over or wiring the heading/controls to `/news/`.

For the agreed future generation-based homepage freshness behaviour, the same homepage contract contains an explicitly labelled future implementation section. It is not current runtime until implemented and accepted on TEST. Also read [`../media/media-homepage-latest-six-contract.md`](../media/media-homepage-latest-six-contract.md) for the future backend generation, D1 state, versioned endpoint and long-cache rules.

### AQ in the News page presentation

Read [`news-page-contract.md`](news-page-contract.md).

Use it for the standalone/test AQ in the News article-card grid, rounded `16 / 9` whole-image cards, publisher/date above the compact headline overlay, whole-card external linking, the missing-image fallback, subtle whole-card hover/focus treatment and responsive three/two/one-column behaviour. The current `16 / 9` whole-card authority supersedes the earlier approximately `19 / 6` media-area design and detached lower article-body presentation.

For Media image acquisition, cached remote preview delivery and compact-title data semantics, also read [`../media/media-preview-contract.md`](../media/media-preview-contract.md). Website code must not create its own publisher scraper or image cache.

The homepage **Latest News on Air Quality** Media surface is a separate active presentation surface owned by [`homepage-media-carousel-contract.md`](homepage-media-carousel-contract.md). The news-page contract does not control its carousel mechanics, mobile teaser or responsive sizing.

### Blog page

Read:

1. [`contract.md`](contract.md)
2. [`sidebar-navigation-contract.md`](sidebar-navigation-contract.md)
3. [`blog-page-contract.md`](blog-page-contract.md)
4. [`blog-rss-phase2-contract.md`](blog-rss-phase2-contract.md) for Phase 2 automation/share-route work

The Phase 1 Blog contract records the current manual official-Substack-embed presentation until the authorised Phase 2 cut-over.

The Phase 2 contract is the narrower authority for automatic discovery from the official `https://ukairquality.substack.com/feed` feed, the Cloudflare Browser Run acquisition boundary, bounded normalised feed state, build-generated UK AQ article cards, copied social images and stable `/blog/<slug>/` Open Graph/X share routes.

Substack remains the canonical full-article host in both phases. Phase 2 does not authorise copying complete RSS article bodies into UK AQ.

For Phase 2 changes to Pages staging/build order, also read [`../website_deployment/contract.md`](../website_deployment/contract.md).

### Station charts

If the change enters chart controller, browser cache, data clients, AQI-source behaviour or D3 rendering, leave this area and start with [`../station_charts/README.md`](../station_charts/README.md).

Website UI may own the surrounding page/container presentation and Hex adapter integration, but it must not create a second chart implementation.

### Website deployment and asset identity

For GitHub Pages artifact construction, static ES-module dependency hashing, content hashes or browser asset identity, use [`../website_deployment/README.md`](../website_deployment/README.md).

UI implementation must not introduce manually maintained `?v=` asset hashes or use `SITE_VERSION` as browser cache identity when the deployment contract owns content-derived hashing.

## Authority boundaries

This area owns:

- public website shell and responsive interaction rules;
- shared mobile header/navigation presentation;
- homepage-specific mobile presentation and homepage Media presentation under their narrow contracts;
- shared site-footer attribution presentation and fail-open filtering behaviour;
- page/component presentation covered by the narrow contracts above;
- realised Hex Map frontend module/state ownership;
- active authorised Hex Map narrow-screen and compact intermediate-width presentation behaviour;
- separation of temporary beta UI from permanent website behaviour.

It does not own:

- API/cache/database contracts, including public-network eligibility;
- observation, AQI or WHO calculations;
- R2 history/source precedence;
- Latest Snapshot data semantics;
- station-chart internal controller/cache/rendering behaviour;
- Pages artifact construction/content-hash publication.

Follow the owning area's contract whenever a UI task crosses one of those boundaries.

## Implementation ownership

The implementation is primarily in `TEST-uk-aq/TEST-uk-aq.github.io`.

Important current owners include:

```text
/sidebar.js                         shared navigation, mobile drawer and site footer
/site-footer.css                    shared site-footer presentation
/mobile.css                         shared narrow-screen presentation
/site-ui.css                        permanent shared UI presentation
/beta-notice.css                    beta-only presentation
/beta-notice.js                     beta-only behaviour
/index.html                         homepage markup, homepage Media presentation and WHO presentation
/homepage-media-carousel.js         homepage Media carousel/teaser behaviour
/dashboard.js                       homepage dashboard/all-public-network/Refresh behaviour
/hex_map/                           Hex application and Hex-specific presentation
/wood-burning/                       Wood Burning page shell and future contracted Black Carbon presentation
/shared/station-chart/              sole shared Hex/Sensors chart subsystem
/shared/domain/ and /shared/data/   genuine cross-page domain/data ownership
```

Exact Hex module ownership is defined in `hex-map-modularisation-contract.md`; do not duplicate that catalogue here.

Deployment/workflow implementation is owned by the website-deployment area rather than this UI area.

## Documentation and validation boundary

Coding agents treat `system_docs/` as read-only authority and report implementation differences for documentation review.

Before implementation/deployment, use only the structural checks needed to establish viability. Functional and visual acceptance occurs through real TEST operation after deployment; do not preload or invent a broad speculative test suite.
