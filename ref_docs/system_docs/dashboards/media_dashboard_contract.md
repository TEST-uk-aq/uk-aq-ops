# UK AQ Media dashboard contract

**Status:** Current authority for the Media editorial/admin page within the UK AQ dev dashboard.

This contract owns dashboard presentation and operator workflow for UK AQ Media. It supplements the broad Media contracts under `system_docs/media/`. Where this contract defines dashboard exposure of source or author rules more specifically than older dashboard-compatibility wording, this contract is the narrower authority.

## 1. Purpose and authority

The dev dashboard MUST provide one top-level **Media** page for normal editorial and operational administration of UK AQ Media.

The Media page MUST use authoritative Media D1 state through authenticated `media-admin` routes. The browser MUST NOT receive direct D1 credentials and MUST NOT write D1 directly.

The MacBook Pro/MySQL dashboard cache or any later Media mirror MAY support reporting/derived reads where useful, but it MUST NOT be required for normal Media editorial work and MUST NOT become authoritative for article state, source configuration, author rules, AI-title decisions or discovery-run state.

All state-changing actions MUST flow through `media-admin`. Dashboard code owns presentation/integration only.

The local and hosted dashboard implementations SHOULD preserve the existing shared dashboard architecture and `/api/*` compatibility approach where practical, while keeping Media D1 as the source of truth.

## 2. Media sub-navigation

The Media page MUST contain pill-style internal navigation, visually consistent with other dashboard mini-pages.

The first implemented sub-pages are, in this order:

```text
Articles | AI Titles | Runs | Sources
```

`Articles` is the default sub-page.

These are mini-pages within the main Media page, not separate top-level dashboard products.

Do not create separate Media pills for Add Article, AI Usage or Images. Those functions belong inside the four sub-pages above.

## 3. Articles mini-page

### 3.1 Search/Add area

The top of Articles MUST provide the contracted URL-led **Search / Add article** workflow.

The operator can paste an article URL. Media canonicalises the URL and searches authoritative D1 before offering any creation action.

If the canonical article already exists, show the existing article and its current editorial state/actions. Searching MUST NOT change its status.

If the canonical article is genuinely new, the backend may obtain only metadata allowed by the applicable source policy and offer the existing/manual-add editorial workflow. It MUST NOT create a duplicate canonical article.

A visible **Add Article** button SHOULD open/focus this Search/Add workflow rather than introduce a second independent article-creation path.

The article list SHOULD also have a separate simple text search for existing rows, covering at least title and canonical URL and MAY include author. Do not overload the URL Search/Add control with general table search behaviour.

### 3.2 Default article list

Under Search/Add, show the most recent **20** articles matching the current filters and sort.

Default state:

```text
Status filter: Approved
Sort: Published Date: Newest to Oldest
Page size: 20
```

The list MUST support bounded pagination or **Load more**. It MUST NOT silently make 20 articles the permanent maximum.

The backend MUST perform filtering, ordering and pagination against authoritative Media state. The browser MUST NOT fetch the entire article table and sort/filter it locally.

### 3.3 Table columns and thumbnail

The first table column MUST be a thumbnail preview image.

Recommended initial column order:

```text
Image | Title | Publication | Author | Published | Approved | Status
```

Additional compact operational fields MAY be added only where they materially improve editorial work; detailed technical/provenance fields belong in article detail rather than making the table excessively wide.

The thumbnail SHOULD be approximately **96 x 64 CSS pixels**, or a similarly compact 3:2-ish footprint, smaller than the public AQ in the News cards. It SHOULD use `object-fit: cover` or equivalent.

Where an article has an authorised preview image, the dashboard SHOULD use the existing Media image-delivery/proxy path rather than exposing a publisher image URL unnecessarily. Missing/blocked images MUST render a deliberate fallback/empty-image treatment rather than a broken image element.

### 3.4 Sort selector

A **Sort** label and dropdown MUST appear above the table on the right.

The dropdown MUST contain at least these options in this order:

1. `Published Date: Newest to Oldest` **(default)**
2. `Published Date: Oldest to Newest`
3. `Approved Date: Newest to Oldest`
4. `Approved Date: Oldest to Newest`
5. `Discovered Date: Newest to Oldest`
6. `Recently Updated`

`Recently Updated` means authoritative article `updated_at`, newest first.

Alphabetical Title/Author/Publication sorting is not required for the initial page because those dimensions are better served by search/filter controls. They MAY be added later from real editorial need.

Sorts MUST have a deterministic stable tie-break, normally article ID in the corresponding direction, so pagination cannot randomly duplicate/skip rows with equal timestamps.

### 3.5 Filters

The Articles page MUST provide a filter selector/panel with checkbox-style multi-select where multiple values make sense.

Initial filters:

- **Status:** Approved, Pending, Rejected, Hidden. Default selection is Approved.
- **Publication:** one or more human-readable publishers/sources.
- **Author:** one or more authors. The selector SHOULD become searchable when the author list is long.
- **Has image:** Yes / No.
- **Display title state:** Original only / Human title / AI-approved title / Pending AI suggestion.

Filters MAY be combined. The active filter state MUST be visible enough that an operator can understand why rows are absent.

Do not expose every internal policy/provenance field as a first-version filter. Review level, discovery route, image policy, approval method and similar diagnostics belong primarily in article detail unless real operation establishes a useful filtering need.

### 3.6 Inline Status control

The Status table cell MUST provide an inline dropdown for valid editorial transitions.

It MUST NOT directly mutate on selection. Selecting a different valid value creates an unsaved row state and shows a **red square floppy-disk Save button/icon** next to the dropdown. Clicking Save performs the authenticated Media mutation.

When the dropdown reflects the authoritative current value, the default/current indicator is a **green square floppy-disk icon**. After a successful save the control returns to this green/current state.

On mutation failure, the unsaved selection MUST remain visibly unsaved, the save control MUST remain actionable/red, and the dashboard MUST show the failure rather than pretending the save succeeded.

Colour MUST NOT be the only accessibility signal. The controls MUST also have suitable text/title/ARIA labelling such as `Saved/current` and `Save status change`.

Only valid transitions for the current state SHOULD be offered:

- Pending -> Approve or Reject;
- Approved -> Hide or Reject;
- Rejected -> Approve;
- Hidden -> Restore/Unhide to Approved.

The dashboard MUST use the existing authenticated Media status-transition API and preserve its idempotency/event/revision semantics. It MUST NOT implement direct status SQL.

### 3.7 Article detail/editor

Selecting a row SHOULD open an article detail/editor view or panel without requiring the table itself to contain every field.

The detail view SHOULD expose, where applicable:

- publisher/original title;
- current display title and its origin;
- pending/accepted/rejected AI-title evidence;
- canonical URL;
- publication, author and relevant timestamps;
- status and permitted transitions;
- current preview image and image-policy information;
- approval provenance, including trusted-source or trusted-author auto-approval where applicable;
- discovery provenance/evidence where useful;
- **Reload metadata** controls and preview/apply behaviour under the existing Media metadata/image contracts.

Reloading metadata MUST NOT silently replace a different non-null image or alter editorial status. Existing source-specific contracts continue to govern metadata/image permissions.

## 4. AI Titles mini-page

AI Titles combines editorial review of AI display-title suggestions with Media AI usage information.

### 4.1 Usage summary

The top of the page SHOULD show a compact current usage summary using authoritative admin telemetry, including where available:

- calculated neurons used today;
- configured Media daily neuron budget and remaining amount;
- configured/estimated Cloudflare account free-neuron allowance and remaining amount;
- request count;
- titles attempted/generated;
- input/output token counts;
- outstanding reservations or other ledger state needed to understand budget blocking.

The dashboard MUST label configured/local budget values separately from Cloudflare-provider allowance estimates. It MUST NOT imply the local ledger itself is Cloudflare billing authority.

### 4.2 AI-title review list

Pending AI title suggestions are the default review state.

Each review row/card SHOULD show at least:

- publisher/original title;
- AI suggested title;
- Publication;
- generated date/time;
- actions equivalent to **Approve title**, **Edit**, and **Use original / Reject**.

The page MUST allow switching/filtering between Pending, Accepted and Rejected AI-title suggestions.

Accepting a suggestion sets the display title through Media. Editing creates an explicit human display title/origin. Using original/rejecting the suggestion leaves the publisher title as the public fallback. Display-title decisions MUST remain independent of article publication status.

Human display titles MAY exceed the automatic AI-generation length threshold. The operator MUST also be able to clear a human/AI display title back to the publisher original through the contracted admin behaviour.

## 5. Runs mini-page

Runs is an operational discovery view, not a raw unbounded log viewer.

The default view SHOULD show recent discovery runs with at least:

- source/publication;
- route where applicable;
- start time;
- duration or finish time;
- status;
- items seen;
- inserted;
- updated;
- filtered;
- invalid;
- error code/count/details where recorded.

Other bounded run metrics such as duplicate/enrichment counts MAY be shown when present in the runtime schema.

Selecting a run MAY expand bounded diagnostic/error detail. The dashboard MUST NOT turn D1 into an unlimited log store.

Runs MUST be paginated/bounded and newest first by default.

## 6. Sources mini-page

Sources is the operator view for publisher/source configuration and explicit author rules.

### 6.1 Source list/detail

For each source, show at least:

- human-readable name/publication;
- canonical domain;
- enabled/disabled state;
- source type;
- discovery method/adapter;
- publication policy;
- review level;
- content-fetch policy;
- AI-content policy;
- image policy;
- current configured discovery route/feed information in a suitably bounded form;
- recent run/health information where convenient.

The UI SHOULD distinguish everyday editorial controls from more technical source-policy fields so accidental policy broadening is difficult.

### 6.2 Source-wide publication rule

The dashboard MUST support changing a source's publication policy between at least:

```text
manual
auto_approve
```

A source-wide change to `auto_approve` is a broad editorial decision and MUST carry an explicit warning/confirmation in the UI.

Rule changes affect **future discovery/publication decisions only**. They MUST NOT silently rewrite already-stored article statuses, bulk-approve Pending rows, or resurrect Rejected/Hidden rows.

Source-policy changes MUST be authenticated `media-admin` mutations against authoritative D1/configuration state and MUST retain enough audit/provenance information to understand the change.

### 6.3 Author rules

The Sources page MUST expose explicit author rules where supported by the source.

At minimum an author rule must be able to represent and edit the already-contracted dimensions:

```text
inclusion_policy:
  normal
  always_include

publication_policy:
  inherit_source
  pending
  auto_approve
```

The UI SHOULD show display name, source, enabled state and stable identity/profile/feed evidence needed by that adapter. It MAY expose narrowly configured byline aliases where required.

The dashboard MUST support **Add author rule** for a source whose adapter can safely use such rules.

Author-rule changes affect future discovery/publication behaviour only. They MUST NOT silently rewrite existing article status. Rejected/Hidden precedence remains unchanged.

Source-wide and author-specific auto-approval provenance MUST remain distinguishable. An author rule MUST NOT accidentally turn the whole source into an auto-approved source.

This section supersedes older wording in `system_docs/media/media-author-rules-contract.md` that treated dashboard author-rule editing as merely optional/not required for the first Guardian adapter. The underlying author identity, inclusion/publication semantics and provenance rules remain owned by that Media author-rules contract.

### 6.4 Add Source

The Sources page SHOULD provide **Add Source**.

Adding a source definition is distinct from making a new discovery adapter work.

The first dashboard implementation MAY create a new source as a **disabled definition** even when no discovery adapter currently supports it. Creating the row MUST NOT make the source trusted, scheduled or auto-approved.

Recommended conservative defaults for a newly created source are:

```text
Enabled:              No
Publication policy:   Manual
Review level:         Standard
Content fetch:        Discovery metadata only
AI content policy:    Disabled
Image policy:         Blocked
```

Required source-definition fields SHOULD include a stable source key, display name, canonical domain and source type. Adapter/discovery configuration may be supplied only where the selected adapter type supports it.

A new source MUST NOT be enabled for scheduled discovery unless its selected discovery adapter/method is actually implemented and the configuration passes the narrow structural validation required by that adapter.

The initial discovery implementation currently has publisher-specific support for AQN and Guardian. A future **Generic RSS** adapter is the preferred way to make straightforward RSS publishers addable/configurable from the dashboard without writing source-specific code each time. Until such an adapter exists, an arbitrary RSS URL MUST NOT be treated as automatically supported discovery merely because it can be stored in the source row.

Sources that require special sitemaps, overlapping feeds, author-profile routes or publisher-specific handling MAY continue to require a dedicated adapter.

### 6.5 Runtime source configuration authority

Once source/rule editing is exposed through the dashboard, authoritative runtime state is the corresponding Media D1/configuration state reached through `media-admin`.

Repository seed/configuration files are bootstrap/deployment defaults and implementation references. Normal deployment MUST NOT overwrite later operator-managed D1 source/rule choices merely because a seed file still contains an older default. A deliberate migration MAY change existing rows only through an explicit, narrowly guarded migration/operation that preserves operator choices unless the migration is intentionally authorised to replace them.

## 7. Performance/query contract

Normal Media dashboard pages MUST use bounded server-side queries. D1 is authoritative and is expected to serve the normal editorial working set directly through `media-admin`.

The Articles page MUST request only the rows needed for the current page/filter/sort. The admin API SHOULD expose cursor/bounded pagination and explicit supported sort/filter parameters rather than returning the whole table.

Queries SHOULD use indexes appropriate to the exposed dashboard operations. Existing public/source/updated indexes may be reused where they match. Before implementing additional sort/filter endpoints, structurally confirm/index the paths needed for at least:

- status + published/feed-sort time;
- approved date sorting;
- discovered date sorting;
- updated date sorting;
- source/publication filtering;
- author filtering where needed at useful scale.

Do not add speculative indexes for filters the dashboard does not expose.

Thumbnail bytes MUST continue to use the Media image proxy/cache path and SHOULD load independently/lazily so image transfer cannot block the article table data response.

The dashboard MAY cache small read-only selector metadata such as source and author option lists for a short period, but editorial mutations MUST refresh/invalidate affected UI state and D1 remains authoritative.

## 8. Security and mutation boundary

The Media admin credential MUST NOT be exposed as a browser-readable long-lived secret in a public dashboard bundle.

Hosted/local dashboard integration MUST preserve the existing protected dashboard/admin trust boundary and proxy authenticated Media admin requests server-side where necessary.

All mutation endpoints MUST validate permitted state/policy transitions in `media-admin`, not rely on the browser to enforce them.

No dashboard feature may become a generic server-side URL fetch proxy. URL metadata retrieval remains bounded by Media source/content policy and SSRF-safe backend validation.

## 9. Implementation sequencing

The dashboard may be implemented incrementally, but the intended navigation and authority boundaries above are fixed.

A sensible sequence is:

1. Media page shell and pill navigation;
2. Articles list with thumbnail, default Approved filter, sorts, filters and inline status save;
3. article detail plus existing title/metadata controls;
4. AI Titles review plus usage stats;
5. Runs;
6. Sources read/edit, author rules and Add Source;
7. later Generic RSS support if/when implemented in Media discovery.

The complete UI MUST NOT be blocked on Generic RSS. Add Source may initially create disabled/non-discoverable definitions under the rules above.

## 10. Validation boundary

Before implementation, perform only structural viability checks needed to establish:

- the dev dashboard can proxy/read authenticated `media-admin` without exposing the admin secret to the browser;
- required admin list/query endpoints can represent the contracted filters/sorts with bounded D1 queries;
- required D1 indexes/configuration/migrations are structurally viable;
- source and author rule changes can be represented without deployments overwriting operator-managed choices;
- Add Source cannot enable an unsupported adapter accidentally.

Do not build a speculative pre-implementation functional test suite.

After deployment, validate behaviour through real TEST operation, including real article list/filter/sort reads, status save success/failure, thumbnail rendering, AI-title decisions/usage display, run inspection, source/author rule changes and creation of a disabled source definition before any later public/LIVE adoption.
