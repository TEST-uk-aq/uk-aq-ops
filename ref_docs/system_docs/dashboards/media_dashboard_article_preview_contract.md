# UK AQ Media dashboard article preview contract

**Status:** Current narrow authority for article-preview presentation inside the UK AQ Media Articles dashboard. This contract refines `media_dashboard_contract.md` and, only where it names the dashboard preview as a presentation reference, `../website_ui/homepage-media-carousel-contract.md`.

## 1. Scope and ownership

This contract owns the operator-facing article previews used while reviewing and editing titles in the Media Articles mini-page.

It does not change Media discovery, article state, AI-title policy, image acquisition, public-feed semantics, homepage runtime behaviour or the standalone `/news/` page. Those remain owned by their existing contracts.

The previous dashboard-wide preview selector with separate `Desktop`, `Carousel` and `Mobile` modes is no longer authoritative and MUST be removed. Operators should not have to switch the whole article list between presentation modes merely to judge title fit.

## 2. Expanded article preview layout

The expanded title/editor area for an article MUST keep the existing image-based article preview and MUST add a compact homepage-mobile preview directly below that image preview.

The image preview remains the visual reference for the image-card presentation used by the relevant public Media surfaces. The wording in `../website_ui/homepage-media-carousel-contract.md` that names the dashboard `Carousel` mode as the desktop/tablet visual source of truth is refined accordingly: the authoritative dashboard reference is now the expanded article's image-card preview, not a global mode-labelled `Carousel` preview.

The dashboard MUST NOT require a separate `Desktop`, `Carousel` or `Mobile` mode switch to expose either preview.

## 3. Homepage mobile 360 px preview

The added non-image preview exists specifically to show how the homepage mobile Media card will render on a narrow phone.

It MUST emulate the real homepage at a **360 CSS-pixel viewport width**. `360px` refers to the simulated viewport, not to the dark-blue article card itself.

The preview MUST mirror the current homepage mobile rendering contract and implementation values that materially affect title fit, including:

- the homepage outer horizontal padding;
- the white Media-container inner horizontal padding;
- the dark-blue article-card padding;
- publisher/date row typography and spacing;
- headline font family, responsive font sizing, weight, line-height and letter spacing;
- the two-line headline height and `-webkit-line-clamp: 2` behaviour below the wider-mobile breakpoint;
- the persistent top-right external-link icon and the space it occupies;
- the same full-date presentation used by the homepage.

At the currently contracted homepage values, a 360px viewport produces a dark-blue article-card width smaller than 360px because the real homepage and Media container both consume horizontal padding. The dashboard MUST reproduce that nesting rather than simply setting the card itself to `width: 360px`.

Where website and dashboard code cannot literally share CSS, the dashboard MUST mirror the current homepage values exactly enough that title wrapping and truncation at 360px are representative. The mirrored admin CSS/DOM MUST be scoped to the preview and SHOULD contain a concise source comment naming the website files from which the rendering contract was copied, so later drift is easy to identify.

This preview is diagnostic/editorial UI only. It MUST NOT add a second public renderer, change public API data or create a new runtime dependency from Media Admin to the website repository.

## 4. Title shown in previews

By default, both expanded previews MUST render the currently effective public title:

```text
display_title ?? title
```

Pending AI suggestions MUST NOT silently replace that title merely because they exist.

While the operator edits the human-title field, the previews SHOULD update immediately to show the title that would be public if that editor state were saved. A non-empty proposed human title therefore previews that proposed value; clearing the human-title field previews the publisher original, consistent with clearing `display_title`.

Preview-only typing MUST NOT mutate D1, article status, AI suggestion state or the persisted display title. Persistence still occurs only through the existing authenticated save action.

## 5. Behaviour protected from change

This dashboard simplification MUST NOT change:

- the public homepage Media implementation or its `768px` responsive boundary;
- the standalone `/news/` image presentation;
- homepage latest-six selection, generation, rotation or freshness behaviour;
- article/publication status semantics;
- AI title eligibility, generation, acceptance or rejection semantics;
- metadata reload behaviour;
- image policy, image proxy/cache behaviour or publisher permissions;
- Media public/admin API schemas;
- D1 schema or migrations.

No website-repository change is required merely to add this dashboard preview because the dashboard is mirroring already-deployed website presentation for editorial inspection.

## 6. Structural and TEST validation boundary

Before implementation, perform only the structural checks needed to confirm that the existing expanded article renderer can host both previews and that the current website mobile DOM/CSS values can be mirrored without changing API/schema boundaries. Do not create a speculative pre-implementation functional or visual test suite.

After deployment to TEST, validate through real operation:

- the global `Desktop / Carousel / Mobile` preview selector is absent;
- expanding an article shows the existing image preview plus the homepage-mobile preview beneath it;
- the mobile preview represents a 360px viewport rather than a 360px card;
- publisher/date and the external-link icon match the real homepage mobile card;
- long titles wrap and truncate at the same point as the real TEST homepage at 360px for the same article/title;
- editing a proposed human title updates the preview without persisting until Save;
- saving or clearing a human title continues to use the existing authenticated title mutation and refreshes the authoritative state normally;
- no public website, feed, article status, AI or image-policy behaviour changes as a consequence of the dashboard-only change.
