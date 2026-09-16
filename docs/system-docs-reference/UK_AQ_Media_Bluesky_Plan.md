REFERENCE SNAPSHOT FOR IMPLEMENTATION

Copied from TEST-uk-aq/uk-aq-system-docs on 15/09/2026.

The authoritative version remains in uk-aq-system-docs.
Do not maintain or independently revise this copy.
If implementation work reveals a required contract change, update
uk-aq-system-docs separately rather than editing product decisions here.

# UK AQ Media Bluesky publishing implementation plan

**Original plan date:** 11 September 2026  
**Revised:** 15 September 2026  
**Status:** Agreed implementation plan, not yet implemented  
**Implementation repository:** private `TEST-uk-aq/uk-aq-media`  
**Runtime:** dedicated Cloudflare account `UK AQ Media`  
**Publishing account:** `@ukaq.co.uk`  
**Authority:** [`../../system_docs/media/media_bluesky_contract.md`](../../system_docs/media/media_bluesky_contract.md)

## 1. Purpose and supersession

This revision replaces the earlier V1 design in this file.

The earlier plan assumed source-specific social policy, allowed thumbnail-less cards, preferred a separate social Worker and treated `(article_id, platform)` as globally unique. Those points are superseded.

The agreed V1 is now:

```text
auto-approved + thumbnail
    -> automatically queue Bluesky

Pending -> Approved + thumbnail
    -> automatically queue Bluesky

Rejected -> Approved
    -> optional Post to Bluesky checkbox

Hidden -> Approved
    -> optional Post to Bluesky checkbox

all posts
    -> display_title, otherwise original title, first
    -> one blank line
    -> global editable default message
    -> proper external card with thumbnail
    -> durable D1 publication row
    -> dedicated Bluesky Queue
    -> oldest D1 job first
    -> configurable default 10-minute cooldown
    -> @ukaq.co.uk
```

The Articles page also gains a global **Bluesky** button. It opens a generic settings modal, not an article-specific modal, containing the publishing switch, editable default message, live grapheme counters, generic example preview and cooldown setting.

The authoritative behaviour is the dedicated Bluesky contract. This plan gives Codex Cloud an implementation sequence and identifies the few structural checks that genuinely must be resolved before code choices are finalised.

The separate `Phase_2_Social_Dashboard_and_Dynamic_Profile.md` remains future work for profile/banner management. Where its older article-posting notes conflict with the new Bluesky contract, the contract and this revised parent plan win.

## 2. Current repo facts to preserve

Before changing code, inspect current `main` and confirm these facts have not changed.

At the time of this revision:

- `apps/media-public` is the public read-only Worker;
- `apps/media-admin` owns authenticated article transitions and the editorial dashboard;
- `apps/media-discovery` owns scheduled discovery and the existing discovery Queue consumer;
- D1 database `uk-aq-media` is shared authoritative state;
- Queue `uk-aq-media-discovery` is discovery-specific;
- the active Media discovery cadence is two-hour central-scheduler dispatch, `0 */2 * * *`;
- native Media Cron is not active;
- article status events are append-only D1 rows;
- `media_article_events` contains `event_type`, `from_status`, `to_status`, `event_key`, `article_id`, revision and timestamps;
- newly inserted approved articles create `auto_approved` events;
- Pending -> Approved and Rejected -> Approved both create `approved` events, distinguished by `from_status`;
- Hidden -> Approved creates `unhidden`;
- admin status transitions already require a replay-safe `Idempotency-Key`;
- `media-admin` currently has D1/AI but no Queue producer binding;
- `media-discovery` already has Queue bindings and is the natural place to hold outbound Bluesky credentials.

Do not change public Media behaviour merely to implement social publishing.

## 3. Codex Cloud working boundary

Codex Cloud is for development only. The deployed runtime remains Cloudflare Workers, D1 and Queues.

Codex should:

- work in `TEST-uk-aq/uk-aq-media`;
- read the Bluesky contract before editing;
- inspect current migrations/configuration before selecting migration numbers or exact file locations;
- make source, migration and configuration changes only;
- leave changes uncommitted in the working tree for review;
- not create a branch or pull request unless explicitly requested separately;
- not deploy Workers;
- not create Cloudflare resources;
- not create or set a Bluesky app password;
- not perform a real public Bluesky post during development.

Existing repository structural checks such as type generation, type checking, deterministic repo checks and Wrangler dry-run bundling may be used after changes. Do not add a speculative broad pre-deployment functional test suite.

## 4. Phase 0: targeted structural viability checks

These checks are genuinely required before implementation because their result affects the design. They are not a functional test suite.

### 4.1 Bluesky API/client and deterministic remote identity

Using current official Bluesky/AT Protocol documentation and the current package ecosystem, establish:

1. the smallest supported TypeScript API/client path that works in the current Cloudflare Worker compatibility mode;
2. how to authenticate `@ukaq.co.uk` with an app password without exposing it;
3. how to upload the external-card thumbnail blob;
4. how to create `app.bsky.embed.external` explicitly;
5. how to supply a valid deterministic record key for `app.bsky.feed.post`, if supported by the chosen API/client;
6. current post text, grapheme, byte, image/blob and external-thumbnail constraints.

At the time of planning, the current `app.bsky.feed.post` lexicon defines `maxGraphemes: 300` and `maxLength: 3000` for post text. Re-check the current lexicon during implementation rather than assuming those provider limits can never change.

If deterministic record-key creation is supported, use it for remote retry idempotency. If the chosen current client cannot safely provide it, stop and document the alternative reconciliation design before writing the publishing path.

Relevant official/current references:

- <https://docs.bsky.app/docs/tutorials/creating-a-post>
- <https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json>
- <https://atproto.com/specs/record-key>

### 4.2 Multiple Queue consumers on the existing discovery Worker

Confirm current Wrangler/Workers support for binding `media-discovery` as consumer of both:

```text
uk-aq-media-discovery
uk-aq-media-bluesky
```

and dispatching by the Queue batch's queue name.

Current Cloudflare documentation supports this shape, so a fourth Worker is not expected. If current repo tooling or generated bindings expose a real incompatibility, use a small dedicated Bluesky consumer Worker rather than weakening the discovery Queue schema.

### 4.3 D1 event-trigger/outbox shape

Confirm the current migration state still allows a forward-only trigger on newly inserted `media_article_events` to create Bluesky outbox rows for only:

```text
event_type = 'auto_approved'
OR
(event_type = 'approved' AND from_status = 'pending')
```

Confirm that a trigger caused by the existing article insert/status transition can safely cause the outbox insert in D1/SQLite without changing existing append-only event semantics.

Do not rewrite migration `0001` or any applied migration.

### 4.4 Manual transition plus optional repost atomicity

Inspect the current `mutate()` implementation and D1 API usage. Choose a structurally safe way for Rejected -> Approved and Hidden -> Approved to make the status transition and, when requested, create exactly one manual Bluesky publication row tied to the existing admin idempotency key.

Prefer one atomic D1 unit where the current D1 API supports it cleanly. Preserve the existing status-transition event and replay contract.

### 4.5 Thumbnail conversion boundary

Confirm what the existing Media remote-preview/image path can provide to the Bluesky publisher without broadening image permissions.

The V1 must be able to:

```text
permitted article thumbnail
    -> bounded bytes
    -> current Bluesky-compatible image
    -> uploadBlob
```

If the existing Worker can upload the permitted image directly within current provider limits, do so. If normalisation/resizing is required, use only an existing safe Worker capability or a narrowly justified bounded implementation. Do not introduce an unrelated paid image service merely to satisfy this feature without explicit approval.

If a thumbnail cannot be made valid, the article does not post to Bluesky and receives a bounded failure/blocked reason.

## 5. Phase 1: D1 schema and activation safety

Create the next forward-only migration after re-checking current `main`. At the time this plan was written the Media repo had migrations through the current `0020` range, so `0021_bluesky_publication.sql` is likely but MUST NOT be assumed if the repo has advanced.

### 5.1 Bluesky settings

Add a singleton settings/state table, or an equivalent bounded schema, with at least:

```text
media_bluesky_settings

id                         # singleton
publishing_enabled         # 0/1
default_message_template   # global editable template
cooldown_seconds           # default 600
activation_event_id        # null until first deliberate activation
last_successful_post_at
updated_at
```

Seed the initial `default_message_template` as:

```text
From {publisher} {publisher_mention}

Live and historical UK air quality data:
https://ukaq.co.uk/
```

Recommended semantics:

- migration seeds `publishing_enabled = 0`;
- migration seeds the agreed default message;
- migration seeds `cooldown_seconds = 600`;
- `activation_event_id` starts null;
- first deliberate activation sets `activation_event_id` to the current maximum `media_article_events.id` and enables publishing;
- automatic event capture applies only to events after that activation watermark;
- later temporary disable/re-enable MUST NOT move the activation watermark.

The settings API must reject unknown template placeholders and enforce the product limit of **120 graphemes of literal/non-variable default-message text**. Recognised placeholder tokens themselves are excluded from that 120 count. Use Unicode grapheme semantics, not UTF-16 code units or bytes.

This prevents deploying the migration from creating a flood of historical approvals and also prevents approval activity between migration and deliberate first activation from unexpectedly becoming public posts.

After initial activation, disabling publication is a kill switch. New eligible jobs may continue to accumulate durably while disabled so they can resume later.

### 5.2 Publication table

Add durable publication/outbox state. Suggested logical schema:

```text
media_bluesky_publications

id INTEGER PRIMARY KEY AUTOINCREMENT
article_id INTEGER NOT NULL
approval_event_id INTEGER NULL
publication_key TEXT NOT NULL UNIQUE
publication_reason TEXT NOT NULL
status TEXT NOT NULL
attempt_count INTEGER NOT NULL DEFAULT 0
record_key TEXT NULL
post_uri TEXT NULL
post_cid TEXT NULL
last_error_code TEXT NULL
created_at TEXT NOT NULL
last_attempted_at TEXT NULL
posted_at TEXT NULL
updated_at TEXT NOT NULL
```

Suggested `publication_reason` values:

```text
auto_approved
pending_approved
rejected_repost
unhidden_repost
```

Use constraints/indexes so:

- `approval_event_id` is unique when present;
- automatic publication cannot duplicate the same approval event;
- manual reposts are not unique by article id;
- `publication_key` is the durable request identity for all paths;
- oldest queued lookup is indexed;
- article publication history is indexed.

Add bounded status values suitable for the final consumer design, for example `queued`, `posting`, `posted`, `failed` and/or `blocked`. Avoid a state machine that can strand rows permanently after a Worker crash. If a `posting` claim is used, provide a bounded stale-claim recovery rule.

### 5.3 Optional publisher social identity

Preserve the earlier agreed ability to mention a publisher only when its Bluesky identity is explicitly configured.

A small source-social table remains suitable, for example:

```text
media_source_social_accounts

source_key
platform                   # bluesky
handle
account_did
mention_enabled
created_at
updated_at
```

Do not guess handles. This table is independent from whether UK AQ automatically publishes the article.

## 6. Phase 2: automatic outbox creation

Add a new trigger on future `media_article_events` inserts after the activation watermark is set.

It must create one automatic publication row only when all of these are true:

```text
Bluesky activation_event_id is set
NEW.id > activation_event_id
article has a currently eligible thumbnail
AND
(
  NEW.event_type = 'auto_approved'
  OR
  (NEW.event_type = 'approved' AND NEW.from_status = 'pending')
)
```

It must not automatically create a row for:

```text
NEW.event_type = 'approved' AND NEW.from_status = 'rejected'
NEW.event_type = 'unhidden' AND NEW.from_status = 'hidden'
```

Those are operator-controlled repost paths.

Use deterministic automatic publication keys derived from the approval event identity, for example a namespaced `approval-event:<id>` equivalent that meets the chosen schema constraints.

Do not add any trigger that scans or backfills existing historical event rows.

## 7. Phase 3: manual Rejected/Hidden repost request

Extend the authenticated status-transition request shape narrowly.

For the transitions that originate from `rejected` or `hidden`, accept an optional bounded boolean equivalent to:

```json
{
  "post_to_bluesky": true
}
```

Required behaviour:

- checkbox omitted/false: perform only the existing approval/restore transition;
- checkbox true: require an eligible thumbnail and create one manual publication row;
- derive the publication identity from the existing admin `Idempotency-Key` so replaying the same request cannot create another job;
- do not check whether the article was posted in an older, different request;
- a later deliberate request with a new idempotency key may create another post for the same article;
- preserve the current status event type, revision and approval provenance semantics.

The backend must derive the article's current status itself. Do not rely on the browser to decide whether the transition is Pending, Rejected or Hidden.

For Pending -> Approved, automatic outbox creation remains event-driven. A `post_to_bluesky` flag is unnecessary and should not change the automatic rule.

If an explicit manual social request cannot be honoured because the thumbnail requirement is not met, fail that combined request clearly rather than silently approving while discarding the checked social instruction.

## 8. Phase 4: dedicated Bluesky Queue bindings

Create the Cloudflare Queue manually during deployment/rollout:

```text
uk-aq-media-bluesky
```

Add producer binding:

```text
MEDIA_BLUESKY_QUEUE
```

to both:

```text
apps/media-admin/wrangler.jsonc
apps/media-discovery/wrangler.jsonc
```

Add `uk-aq-media-bluesky` as a second consumer queue for `media-discovery` with:

```text
max_batch_size: 1
max_concurrency: 1
```

Do not alter the existing discovery queue schema or put social messages into `MEDIA_DISCOVERY_QUEUE`.

Regenerate Worker binding types using the repository's normal type-generation command.

The Bluesky Queue body should be deliberately small. It may carry a schema/version and publication or generic wake-up identity, but MUST NOT contain:

- image bytes;
- credentials;
- arbitrary remote URLs selected by a caller;
- article body text.

D1 remains the actual backlog.

## 9. Phase 5: wake-up producers and reconciliation

Add a shared bounded helper to wake the Bluesky Queue when D1 contains eligible queued work.

### 9.1 Admin path

After an eligible admin approval/repost transaction is durably complete, request a Bluesky wake-up.

If the Queue send fails after D1 commit:

- do not roll back or report the article approval as failed solely because Bluesky wake-up failed;
- log a bounded social wake-up error;
- leave the durable Bluesky row queued for reconciliation.

### 9.2 Discovery path

After discovery work creates one or more automatic publication rows, request a Bluesky wake-up without making Bluesky success part of the discovery result.

Avoid one large queue payload per article. A generic wake-up is sufficient because the consumer selects work from D1.

### 9.3 Two-hour reconciliation safety net

Extend the existing authenticated Media scheduler path so each normal two-hour scheduler invocation can issue one generic Bluesky wake-up when queued work exists.

This is recovery only. Normal posts should be queued immediately after approval and must not wait for the two-hour cadence.

## 10. Phase 6: Bluesky consumer

Extend `apps/media-discovery/src/index.ts`, or a narrowly separated module used by it, so `queue()` dispatches by `batch.queue`.

Keep current discovery handling unchanged for `uk-aq-media-discovery`.

For `uk-aq-media-bluesky`:

1. validate the bounded message shape;
2. read the authoritative settings row, including the current default-message template;
3. if first activation has not happened, do not call Bluesky;
4. if publishing is disabled, do not call Bluesky;
5. select the oldest queued D1 publication deterministically;
6. apply any safe claim/stale-claim mechanism chosen in Phase 1;
7. calculate whether the current cooldown has elapsed;
8. if not, leave the job queued and schedule/retry a wake-up using the remaining delay;
9. load the article and current permitted thumbnail identity;
10. fetch the permitted image through the existing bounded Media image boundary;
11. validate/normalise it to current Bluesky requirements;
12. authenticate as `@ukaq.co.uk`;
13. upload the thumbnail blob;
14. expand the stored default-message template with the real publisher values, then construct the title-first post text/facets and explicit external card;
15. validate the complete expanded post against current Bluesky grapheme/byte limits and deterministically shorten only the rendered title when necessary;
16. create the post using the publication's stable remote record identity where supported;
17. store returned URI/CID, `posted_at`, final status and `last_successful_post_at`;
18. if more queued work exists, arrange the next wake-up subject to the current cooldown;
19. acknowledge/retry the Queue wake-up consistently with the final D1 result.

The consumer must not assume Queue delivery order. Every invocation asks D1 which publication is oldest.

## 11. Phase 7: post/card builder

Implement a shared deterministic builder with inputs from existing Media state and the global Bluesky settings only.

Required source values:

```text
article id
publishable display_title or original title
publisher
canonical_url
source key
optional configured publisher Bluesky identity
default_message_template
```

The card must be:

```text
$type: app.bsky.embed.external
external.uri: canonical article URL
external.title: Media display title or original title
external.description: deterministic bounded publisher/Media metadata only
external.thumb: uploaded Bluesky blob reference
```

The post text must always be built as:

```text
{display title, otherwise original title}

{expanded default message}
```

Initial default message:

```text
From {publisher} {publisher_mention}

Live and historical UK air quality data:
https://ukaq.co.uk/
```

V1 recognised placeholders:

```text
{publisher}
{publisher_mention}
```

Do not allow the editable template to contain or control the title position. The title is a separate mandatory first block.

When `{publisher_mention}` has no configured value, expand it to empty and normalise the neighbouring whitespace so the output remains clean.

The canonical article URL remains the external-card destination whether or not it appears in the editable message text. Do not depend on text URLs to select the card.

Use the same grapheme-counting helper for:

- the 120-grapheme literal/default-message product limit;
- the dashboard counters;
- final full-post validation and deterministic title shortening.

Recognised placeholder tokens are excluded from the 120-grapheme literal count. Placeholder expansions count normally towards the final full-post limit.

At publication time, expand the actual article values first. Reserve the fixed blank-line separator and expanded message, then give the remaining provider grapheme budget to the rendered title. If needed, deterministically truncate only the rendered title with a fixed ellipsis marker. Never mutate Media's stored title/display title and never silently truncate the operator's configured default message.

If the expanded message itself leaves no room for a valid title under current provider limits, fail the publication with a bounded text-length error.

Use the current official Bluesky rich-text/facet tooling, or an equivalent correctly byte-indexed implementation, for real publisher mentions and any links present in the message.

## 12. Phase 8: thumbnail acquisition

Do not create a new arbitrary image fetch path.

Refactor/reuse the existing Media image-validation/fetch behaviour so the Bluesky publisher can obtain only an image already permitted for that article.

Requirements:

- article must have a stored eligible preview image;
- source/article image policy must permit its current remote-preview use;
- redirects, content type, HTTPS/domain rules, response size and timeout remain bounded;
- thumbnail bytes are never persisted in D1 or Queue messages;
- image metadata should be stripped/normalised where the chosen image path supports it and current Bluesky guidance requires it;
- upload occurs only immediately before the associated Bluesky post;
- if the image cannot become a valid current Bluesky external-card thumbnail, mark the publication with a bounded error/blocked reason and do not create a thumbnail-less post.

## 13. Phase 9: credentials and deployment configuration

Add only the minimum secret to the Bluesky-consuming Worker, expected to be logically equivalent to:

```text
BLUESKY_APP_PASSWORD
```

The identifier `ukaq.co.uk` may be a non-secret bounded config value.

Do not give the app password to `media-public` or browser code. `media-admin` does not need the Bluesky credential if it only creates D1 work and produces Queue wake-ups.

Update the existing deployment workflow only through its established secret-management pattern. Do not print or persist the secret.

Resource creation and secret installation are operator deployment steps, not Codex Cloud development steps.

## 14. Phase 10: global Articles-page Bluesky settings modal

Add a **Bluesky** button to the existing authenticated Articles page. This button is global. It is not part of any individual article row/card/pop-up.

Opening the button shows a generic Bluesky settings modal with at least:

```text
Bluesky
Account: @ukaq.co.uk
Publishing: Enabled / Disabled

Default message
[editable multiline template]
<literal graphemes> / 120

Available placeholders:
{publisher}
{publisher_mention}

Example preview
[fixed dummy/example post]
<expanded example graphemes> / <current Bluesky limit>

Post cooldown
[ 10 ] minutes

[Cancel] [Save]
```

The example preview MUST be generic. Do not pick a random article, the newest article, the selected article or any other real Media article merely to populate the settings preview.

Use fixed sample values such as:

```text
Example display title for an air-quality article
Example Publisher
@example.bsky.social
```

so it is obvious that the preview demonstrates the template rather than a real pending/queued publication.

The preview must preserve the mandatory post order:

```text
Example display title for an air-quality article

From Example Publisher @example.bsky.social

Live and historical UK air quality data:
https://ukaq.co.uk/
```

### 14.1 Default-message counter

While the operator types, show the literal/non-variable template count dynamically:

```text
68 / 120
```

The count must use Unicode graphemes. Recognised placeholder tokens are not counted towards 120, while all literal spaces, punctuation and line breaks outside them are counted.

Prevent Save when:

- literal text exceeds 120 graphemes;
- an unknown placeholder is present;
- the template is otherwise structurally invalid under the agreed bounded parser.

Backend validation is authoritative and must enforce the same rules even if browser validation is bypassed.

### 14.2 Generic expanded example count

The fixed example preview must update live as the template changes and show a second count against the current Bluesky post limit, currently 300 graphemes:

```text
154 / 300
```

Label this clearly as an **example**. Real post length varies with the article title, publisher and optional publisher mention, and the backend performs the authoritative expansion/check at publication time.

The preview and backend should share the same grapheme-counting/post-building logic as far as practical so the UI does not teach different rules from the publisher.

### 14.3 Settings mutations

Add bounded authenticated admin endpoints to:

- perform the one-time first activation safely;
- enable/disable publishing after activation;
- update the global default-message template;
- update the cooldown duration.

Cooldown is stored in D1 as seconds with default `600`, even if the dashboard presents minutes.

Use a bounded positive integer range that fits normal editorial use and document the selected limit. Do not use a Wrangler environment variable for an ordinary cooldown or default-message edit.

The first activation action must capture the current maximum article-event id as the activation watermark so old approvals are not posted.

Saving message/cooldown changes must not itself enqueue or repost any article.

## 15. Phase 11: article pop-up/dashboard controls

Update the article pop-up using the article's authoritative current status and thumbnail state.

### Pending

When a thumbnail exists, approval will automatically create a Bluesky job after activation. The UI may say:

```text
Will be queued to Bluesky
```

Do not add an optional Bluesky checkbox for normal Pending -> Approved.

### Rejected

When moving to Approved, show:

```text
[ ] Post to Bluesky @ukaq.co.uk
```

Default unchecked.

Disable/unavailable when no eligible thumbnail exists.

### Hidden

When restoring to Approved, show the same optional checkbox, default unchecked and unavailable without an eligible thumbnail.

### Publication history

Add useful bounded visibility in the pop-up, preferably:

- queued/posted/failed status;
- posted timestamp;
- public Bluesky link when URI is known;
- number of previous posts for the article;
- last bounded error code when relevant.

Do not expose credentials or raw upstream error bodies.

## 16. Phase 12: cooldown and ordering mechanics

The consumer must enforce:

```text
next_allowed_at = last_successful_post_at + current cooldown_seconds
```

If now is earlier than `next_allowed_at`:

- do not claim the next post permanently;
- leave it eligible/queued;
- arrange a delayed Queue wake-up for the remaining interval.

After a successful post, update `last_successful_post_at` atomically with the durable publication success where practical.

Use D1's oldest publication id as the deterministic backlog order. This gives the desired manual behaviour:

```text
approve A
approve B
approve C

-> A posts first
-> B posts after the cooldown
-> C posts after the next cooldown
```

Cloudflare Queue ordering is not relied upon.

Changing the dashboard cooldown affects the next calculation immediately. Do not pre-write fixed posting timestamps for the entire backlog.

## 17. Phase 13: failure and retry semantics

Classify failures into bounded categories rather than persisting raw remote messages.

Examples of useful categories:

```text
bluesky_auth_failed
bluesky_api_transient
bluesky_post_rejected
thumbnail_missing
thumbnail_fetch_failed
thumbnail_invalid
thumbnail_too_large
message_template_invalid
post_text_too_long
publication_state_conflict
```

Exact names may follow existing repository conventions.

Transient Bluesky/transport failures may return the publication to queued state and use bounded delayed retry/backoff.

Permanent thumbnail/payload/template failures should remain visible as failed/blocked and must not loop forever.

Remote idempotency must cover the crash window where Bluesky accepts a post but D1 has not yet stored success.

Do not make a social failure fail the article approval or discovery run after those have committed successfully.

## 18. Repository documentation handover

As part of implementation, update `TEST-uk-aq/uk-aq-media` README/handover documentation to describe:

- the new queue and bindings;
- D1 Bluesky settings/publication tables;
- approval-to-social rules;
- the no-thumbnail/no-post rule;
- the global Articles-page Bluesky button/settings modal;
- title-first plus blank-line plus default-message construction;
- the 120-grapheme literal template limit and dynamic counters;
- recognised template placeholders;
- the generic fixed example preview rule;
- dashboard cooldown/settings and optional article repost checkbox;
- secret/resource setup;
- queue consumer/cooldown behaviour;
- reconciliation behaviour;
- real TEST validation procedure;
- rollback/kill-switch procedure.

Do not duplicate secrets in documentation.

The system-docs contract is authoritative for product behaviour. If implementation discovers a genuine design conflict, update the contract deliberately rather than silently changing runtime semantics.

## 19. Post-implementation structural checks

Before deployment, run only the repository's existing structural validation needed to prove the changed code/configuration can be deployed, for example:

```text
npm ci
npm run types
npm run check
Wrangler deploy --dry-run paths already exercised by npm run check
local migration application against a disposable/local D1 database
```

Also inspect the migration and generated bindings to confirm:

- existing article/event constraints are preserved;
- old approval events are not backfilled;
- the default message is seeded without exceeding the 120-grapheme literal limit;
- settings storage accepts only the agreed placeholder syntax;
- the new queue bindings are typed correctly;
- discovery Queue messages still route to the existing discovery handler;
- Bluesky Queue messages route only to the Bluesky consumer;
- no secret value exists in source or generated output.

Do not attempt a live Bluesky post as a pre-deployment test.

## 20. Deployment tasks outside Codex Cloud

After code review, the operator performs the real TEST rollout:

1. create `uk-aq-media-bluesky` in the UK AQ Media Cloudflare account;
2. create a dedicated Bluesky app password for `@ukaq.co.uk`;
3. install the credential through the established encrypted Media deployment path;
4. deploy the Media changes and apply the forward migration;
5. confirm the Articles-page Bluesky modal shows the seeded default message, 10-minute cooldown and publishing as not yet activated/disabled;
6. perform the deliberate first activation, which captures the current event watermark;
7. keep the cooldown at the default 10 minutes for initial operation.

The feature must not publish merely because migrations/code were deployed.

## 21. Functional validation after TEST deployment

Functional behaviour is validated through real TEST operations after deployment.

Use controlled real articles with valid thumbnails.

Validate, in real operation:

1. open the global Articles-page Bluesky modal and confirm it is generic, not populated from a random or selected real article;
2. edit the default message and confirm the literal grapheme counter updates dynamically and Save is blocked beyond 120;
3. confirm the generic expanded preview and its full-post counter update from fixed dummy values;
4. save a valid template/cooldown edit and confirm it persists through D1 without deployment and does not enqueue any article;
5. approve one Pending article and confirm exactly one queued publication appears and then exactly one Bluesky post is created;
6. confirm its text begins with display title, otherwise original-title fallback, followed by one blank line and the expanded current default message;
7. allow one newly discovered auto-approved article to confirm the automatic discovery path;
8. confirm an article without a thumbnail does not create/post a Bluesky publication;
9. move a Rejected article to Approved with the checkbox unchecked and confirm no social job is created;
10. repeat an appropriate Rejected -> Approved cycle with the checkbox checked and confirm a deliberate post is created;
11. restore a Hidden article with the checkbox unchecked and confirm no social post;
12. on a later deliberate Hidden -> Approved restore, tick the checkbox and confirm another post for the same article is allowed;
13. retry the same admin request/idempotency key and confirm it does not create an extra post;
14. approve several suitable Pending articles one at a time and confirm D1 creation order is respected while successful posts are separated by the configured cooldown;
15. change the cooldown in the global modal and confirm the next eligible posting calculation uses the new value;
16. use an article whose chosen title requires shortening and confirm only the rendered title presentation is deterministically shortened while the stored Media title and configured default message remain unchanged;
17. confirm every Bluesky post has the expected thumbnail-backed external card for the canonical article URL;
18. confirm successful D1 rows contain the returned URI/CID;
19. confirm bounded failures remain visible without altering Media article approval/public-feed state;
20. confirm the two-hour scheduler can wake stranded queued work as a recovery path without becoming the normal posting cadence.

These are real TEST operational checks, not a speculative pre-implementation test suite.

## 22. Rollback and kill switch

The first response to unexpected social behaviour is:

```text
publishing_enabled = 0
```

Disabling publishing must stop outbound Bluesky calls without disabling Media discovery or editorial approval.

Leave durable publication rows and settings intact for diagnosis. Do not delete audit history to roll back code.

If required, remove/disable only the Bluesky Queue consumer binding after publishing has been disabled. Existing discovery Queue operation must remain independent.

Previously created Bluesky posts are not automatically deleted by rollback. Remote deletion is separate future functionality.

## 23. Deferred scope

Do not expand this implementation into:

- per-article custom default-message editing for normal automatic posts;
- automatic post deletion;
- bulk historical posting;
- promotional repeat schedules;
- engagement analytics;
- Mastodon or other platforms;
- AI-written social copy;
- guessed publisher social accounts;
- dynamic Bluesky banners/profile mutation.

Those remain separate product work.
