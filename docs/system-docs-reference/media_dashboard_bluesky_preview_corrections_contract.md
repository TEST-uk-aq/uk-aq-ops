# UK AQ Media dashboard Bluesky and preview corrections contract

**Status:** Current narrow correction authority agreed 17 September 2026 for Media dashboard manual-approval Bluesky controls, source-specific presentation-image fallbacks and dashboard article-card date formatting. This contract refines `media_dashboard_contract.md`, `media_dashboard_article_preview_contract.md`, `../media/media_bluesky_contract.md`, `../media/media-preview-contract.md` and active source-specific preview contracts only where the rules below are more specific.

## 1. Scope

This contract corrects four deployed TEST behaviours without redesigning Media:

1. every operator-driven transition whose destination is Approved must expose the existing explicit Bluesky opt-in, including Pending -> Approved;
2. bulk Approved selection must support every selected article whose current state has a valid individual transition to Approved, including Pending, Rejected and Hidden;
3. the authenticated dev dashboard should display an authorised source-specific UK AQ placeholder when an article has no genuine publisher image, with CAWS as the only currently authorised source;
4. article-card/thumbnail previews in the Media dashboard must show publication dates as `DD/MM/YYYY`, matching the current homepage Media presentation.

The contract also closes the backend idempotency race identified in the newly deployed bounded bulk approval endpoint.

This is not authority to change discovery, source trust, publication policy, public article ordering, Bluesky post composition, cooldown, publisher image acquisition, article identity or editorial provenance.

## 2. Manual approval and Bluesky opt-in

Manual editorial approval and Bluesky publication remain separate decisions.

Whenever an operator selects **Approved** as the destination status, the individual article editor MUST expose the existing:

```text
Post to Bluesky @ukaq.co.uk
```

control when Bluesky publication is eligible.

This applies to:

- Pending -> Approved;
- Rejected -> Approved;
- Hidden -> Approved.

The checkbox MUST default to unchecked. Changing the selected destination away from Approved MUST hide the control and clear any checked state. Returning to Approved MUST show it unchecked again.

The Media admin article-detail response MUST therefore represent Pending as a valid manual Bluesky publication origin, using the existing durable reason:

```text
pending_approved
```

in the same way that Rejected and Hidden already expose their manual publication reasons.

A human-facing dashboard label SHOULD render:

```text
pending_approved -> Approved from Pending
```

The raw database/API reason remains unchanged. The label describes why a publication request exists; it MUST NOT be presented as a publication status or as another approval step.

The existing thumbnail rule remains unchanged. If the article has no eligible real publisher thumbnail, ordinary editorial approval MUST still be available, but the Bluesky opt-in MUST be unavailable or fail clearly if selected. A source-specific UK AQ placeholder defined in section 5 does not by itself make an article Bluesky-thumbnail eligible.

## 3. Bulk Approved behaviour

The bulk status control MUST treat Approved consistently with the individual transition table.

A selected article is eligible for the bulk Approved destination when its current state is one of:

```text
Pending
Rejected
Hidden
```

provided that the corresponding normal individual transition to Approved is valid.

The dashboard MUST NOT artificially exclude Rejected or Hidden rows merely because they are part of a bulk selection.

When **Approved** is the chosen bulk destination, show the same unchecked:

```text
Post to Bluesky @ukaq.co.uk
```

control.

With the checkbox unchecked, the normal editorial transitions may proceed without Bluesky publication and without requiring Bluesky-thumbnail eligibility.

With the checkbox checked, the existing bounded Media bulk approval endpoint owns all-or-nothing social eligibility. The dashboard MUST NOT fan out best-effort social publication requests or silently publish only a subset.

## 4. Bulk idempotency race correction

The bounded Media bulk approval endpoint uses `Idempotency-Key` as the durable logical request identity.

The complete identity includes at least:

- the canonical ordered article-ID set;
- the requested `post_to_bluesky` boolean.

The backend MUST enforce that identity both before and after its transactional/batched mutation boundary.

If two concurrent requests reuse the same `Idempotency-Key` with different article IDs or different Bluesky intent, only the winning identity may be treated as the replayable request. The losing request MUST return the existing bounded idempotency conflict response rather than returning or adopting the winner's receipt.

A post-batch re-read MUST therefore verify that the stored durable request identity exactly matches the caller's canonical article IDs and `post_to_bluesky` value before returning a replay/success response.

This correction MUST NOT create duplicate approval events, duplicate Bluesky publication rows or article-level uniqueness that would prevent later deliberate reposts under a different valid request identity.

## 5. Source-specific default image in the dev dashboard

The Media preview contracts already permit a narrower source contract to authorise a UK AQ-owned source placeholder when no permitted publisher image exists.

The authenticated Media dashboard SHOULD show that authorised presentation fallback as well as public Media surfaces.

For an article whose source-specific contract authorises a static placeholder, the dashboard image-selection order is:

```text
genuine permitted publisher image
    -> authorised UK AQ source placeholder
    -> deliberate no-image fallback
```

The current source authorised for this behaviour is:

```text
source_key: communities-against-woodsmoke
asset: /source-images/communities-against-woodsmoke-default.png
```

The existing CAWS source contract remains the authority for that asset and for the rule that a genuine publisher image always wins.

### 5.1 Ownership and API boundary

Source-placeholder selection belongs in Media, not in Ops presentation code.

The dashboard SHOULD continue to request the normal authenticated Media article-preview/image path. Media may make that presentation route return the authorised source placeholder when no genuine publisher image exists and the source/article image policy permits presentation.

Ops MUST NOT need a hard-coded CAWS source-key -> asset-path branch merely to show the fallback. Future source placeholders should be addable through Media/source-specific policy without rewriting generic dashboard image-selection logic.

The implementation MAY reuse the repository-owned static asset through a shared Media helper and the simplest structurally valid Worker/static-asset mechanism. It MUST NOT create R2/KV storage or copy publisher bytes into durable storage merely for this dashboard fallback.

### 5.2 Metadata and policy separation

Showing a UK AQ placeholder in the dashboard MUST NOT:

- populate or overwrite `media_articles.og_image_url`;
- represent the placeholder as publisher metadata or discovery provenance;
- alter `preview_metadata_checked_at` merely because the placeholder is displayed;
- alter article status, approval method or canonical identity;
- make a blocked source/article image policy display an image;
- make the placeholder count as a genuine publisher thumbnail for Bluesky eligibility.

The dashboard's **Has image** filter and any metadata diagnostic that explicitly means "publisher image stored" MAY continue to reflect actual stored publisher-image state rather than presentation fallback state. The UI should not silently redefine `og_image_url != null` as "any presentation image exists".

## 6. Dashboard article-card date format

The current homepage Media contract uses the compact publication-date presentation:

```text
DD/MM/YYYY
```

The Media dashboard's article-card/thumbnail previews MUST mirror that format.

For example:

```text
18/08/2026
```

must be shown rather than:

```text
18 August 2026
```

This applies to the publication date displayed inside the dashboard's image-card preview and its homepage-mobile 360px preview.

The visible date is the publication calendar date supplied by Media metadata. It MUST NOT shift to a different calendar day because of browser timezone conversion.

This correction does **not** change detailed dashboard timestamps used for operational/editorial information. Full date/time fields such as Published, Discovered, Approved, Updated, run times and audit times may retain their existing `DD/MM/YYYY HH:MM` / UTC-labelled presentation where currently contracted.

This section supersedes the older sentence in `media_dashboard_article_preview_contract.md` requiring the dashboard preview to mirror the homepage's former full-date presentation. The current homepage authority is `../website_ui/homepage-media-carousel-contract.md`, which specifies `DD/MM/YYYY`.

## 7. Structural validation boundary

Before implementation, validate only structural viability of the existing paths:

- Media article-detail manual Bluesky availability can include Pending without schema change;
- the existing bulk endpoint can re-check durable request identity after its batch without changing the public contract;
- the dashboard bulk target calculation can use the existing individual Approved transition table for Pending, Rejected and Hidden;
- the authenticated Media image presentation route can select the already-authorised CAWS placeholder through a Media-owned helper/static-asset path without writing placeholder metadata into D1;
- the dashboard's two article-card preview date helpers can render the existing publication date as `DD/MM/YYYY` without changing stored timestamps.

Do not create a speculative pre-implementation functional test suite.

## 8. Post-deployment TEST acceptance

After deployment, confirm through real TEST operation:

- Pending -> Approved in the individual pop-up shows an unchecked Bluesky checkbox when a real eligible thumbnail exists;
- Rejected -> Approved and Hidden -> Approved retain the same behaviour;
- changing away from Approved clears the checked state;
- manual approval with the checkbox unchecked creates no Bluesky publication request;
- manual approval with the checkbox checked creates the expected bounded publication request;
- an image-less article may still be approved while Bluesky remains unavailable;
- bulk Approved is offered for valid Pending, Rejected and Hidden selections rather than excluding Rejected/Hidden solely because of their state;
- checked bulk Bluesky remains all-or-nothing;
- conflicting concurrent reuse of one bulk idempotency key cannot return the wrong request's receipt;
- an image-less CAWS article shows the CAWS default image in table/detail/expanded dashboard presentation where that normal Media image path is used;
- a CAWS article with a real publisher image shows the real image instead;
- the CAWS placeholder does not populate `og_image_url` and does not make Bluesky posting eligible;
- non-CAWS articles without an authorised source placeholder retain the deliberate no-image treatment;
- article-card and homepage-mobile dashboard previews show dates such as `18/08/2026` rather than `18 August 2026`;
- detailed operational timestamps remain unchanged.
