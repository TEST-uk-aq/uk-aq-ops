# UK AQ Media Bluesky publication contract

**Status:** Current TEST implementation authority, agreed 15 September 2026 and amended 18 September 2026  
**Implementation repository:** private `TEST-uk-aq/uk-aq-media`  
**Runtime owner:** UK AQ Media Cloudflare account  
**Bluesky account:** `@ukaq.co.uk`

## 1. Authority and scope

This contract defines the load-bearing behaviour for publishing UK AQ Media articles to Bluesky.

It is current authority for the deployed TEST implementation. It does not by itself imply that Bluesky publishing is enabled, that every deployed path has completed operational acceptance, or that the public/LIVE UK AQ website depends on Media.

Where this contract is narrower than the broad Media contract, this contract owns Bluesky-specific behaviour. Existing Media contracts continue to own article discovery, editorial state, preview-image permissions, public API behaviour, source policy and core Media availability.

The feature MUST preserve these boundaries:

- D1 remains authoritative for Media and Bluesky publication state;
- Cloudflare Workers and Queues run the feature;
- Codex Cloud is a development environment only and is not part of runtime;
- article approval and Bluesky publication remain separate outcomes;
- automatic Media approval and operator-selected manual approval are distinct Bluesky decision paths;
- a Bluesky failure MUST NOT fail article approval, discovery, the public Media feed or the UK AQ website;
- no public Worker or browser code receives Bluesky credentials;
- no article body is required to publish a Bluesky post;
- no additional AI call is required to write social copy.

## 2. Account and credentials

The publishing account is:

```text
@ukaq.co.uk
```

The Worker MUST authenticate with a dedicated Bluesky application credential suitable for automation. The normal interactive account password MUST NOT be used.

The application password MUST be stored as a Cloudflare Worker secret and MUST NOT be stored in source, committed Wrangler vars, D1, Queue messages, logs, dashboard HTML or system documentation.

The account handle/identifier is not secret and MAY be a normal bounded configuration value. The deployed publisher MUST fail closed if authentication resolves to an unexpected account identity.

The authenticated Media dashboard MAY expose connection state and the public account handle, but MUST NOT expose the credential.

## 3. Publication eligibility

Bluesky publication is driven by Media approval state transitions, not by periodically scraping the public feed.

Only articles with an eligible thumbnail at the publication decision point may create a Bluesky publication job.

The required transition behaviour is:

| Media transition | Bluesky behaviour |
| --- | --- |
| New article is auto-approved by source/author policy | Automatically create one Bluesky publication job if an eligible thumbnail exists |
| Pending -> Approved by an operator | Do not post automatically; show an optional `Post to Bluesky @ukaq.co.uk` control |
| Rejected -> Approved by an operator | Do not post automatically; show the same optional control |
| Hidden -> Approved by an operator | Do not post automatically; show the same optional control |
| Approved -> Hidden | No Bluesky action |
| Any other transition | No Bluesky action unless a later contract explicitly adds one |

Every operator-driven transition whose selected destination is **Approved** MUST expose the same Bluesky checkbox in both the individual article pop-up and any bulk approval surface.

The checkbox MUST default to unchecked. Leaving it unchecked means the editorial approval proceeds without creating a Bluesky publication job.

The distinction is deliberate: automatic source/author approval may create a Bluesky job automatically, but manually choosing Approved never implies consent to post socially.

An article approved without an eligible thumbnail remains a valid approved Media article. The missing thumbnail prevents Bluesky publication only.

If an article had no eligible thumbnail at the approval decision point and receives one later through metadata/image repair, that later image change MUST NOT unexpectedly create a historical Bluesky post.

## 4. Explicit manual publication and repost semantics

Selecting `Post to Bluesky @ukaq.co.uk` while manually moving an article to Approved is an explicit operator instruction to create a Bluesky publication job.

For Pending -> Approved this is normally the article's first explicit manual social publication. For Rejected -> Approved or Hidden -> Approved it may be a first publication or a deliberate repost depending on publication history.

An explicit manual publication MUST NOT be blocked merely because the same article has been posted to Bluesky before. Article-level uniqueness therefore MUST NOT be used for manual publication requests.

The same admin request MUST remain idempotent. Retrying an identical status-transition request with the same `Idempotency-Key` MUST NOT create multiple publication jobs or multiple remote posts.

A later deliberate status transition with a different valid request identity MAY create another Bluesky post for the same article.

If `post_to_bluesky=true` is requested but the article has no eligible thumbnail, the backend MUST reject that explicit social-publication request rather than silently accepting the checkbox and dropping the post. The dashboard SHOULD disable or otherwise make the checkbox unavailable when no eligible thumbnail exists.

For a bulk manual approval with `post_to_bluesky=true`, eligibility MUST be all-or-nothing for the selected set. The backend MUST validate every target before applying the combined approval/social-publication request. If any selected article cannot create an eligible Bluesky publication job, the request MUST fail clearly rather than silently approving the set while posting only a subset.

When a bulk manual approval is submitted with the checkbox unchecked, normal article approval does not depend on Bluesky eligibility and MUST create no Bluesky publication rows.

## 5. Thumbnail and external-card rule

Every UK AQ article post on Bluesky MUST contain a proper external website card for the canonical publisher article URL and MUST contain a thumbnail.

No thumbnail means no Bluesky post.

The external embed MUST use:

```text
app.bsky.embed.external
```

with the canonical publisher article URL as `external.uri`.

The thumbnail is not an external URL inside the Bluesky record. The publisher MUST:

1. obtain the permitted article preview image bytes through the existing Media image-policy boundary;
2. validate and, where the implementation safely supports it, normalise the image to the current Bluesky requirements;
3. upload the image bytes to the authenticated Bluesky/PDS account as a blob;
4. use the returned blob reference as the external card thumbnail;
5. create the post only after a valid thumbnail blob exists.

The image bytes MUST NOT be carried in the Cloudflare Queue message. Queue messages carry only bounded publication/wake-up identity.

Bluesky thumbnail creation MUST NOT broaden Media's existing image permissions. The implementation MUST reuse the existing permitted remote-preview/image-fetch boundary rather than add a new arbitrary URL fetcher.

If a stored thumbnail cannot be fetched, validated or converted into a valid Bluesky thumbnail at publish time, the publication MUST NOT fall back to a thumbnail-less post. The durable publication row must record a bounded failure/blocked reason for operator visibility.

### 5.1 External-card title and description

The text inside the Bluesky external card represents the publisher article and is separate from the UK AQ-generated post text defined in section 6.

The external card MUST NOT use the UK AQ `display_title` merely because that title is selected for the post body.

At publication time, `external.title` SHOULD use the best available publisher headline in this order:

```text
og:title
    -> twitter:title
    -> HTML <title>
    -> stored original publisher title
```

The stored original publisher title is the normal Media article `title`, not `display_title` and not a pending AI title suggestion.

At publication time, `external.description` SHOULD use the best available publisher description in this order:

```text
og:description
    -> twitter:description
    -> <meta name="description">
    -> empty string
```

The publisher MUST NOT synthesise `From {publisher}` or equivalent attribution into `external.description`. Publisher attribution belongs in the UK AQ post body/default message and is therefore not repeated in the external-card description.

Publisher title and description metadata MUST be obtained only through the existing bounded, policy-permitted article-head metadata boundary. This rule MUST NOT add article-body fetching, AI-generated card copy, arbitrary URL fetching or broader source/image permissions.

External-card text metadata acquisition is best effort and is not a new publication eligibility requirement. If current publisher-head text metadata cannot be fetched or parsed, publication MAY continue when the mandatory thumbnail is valid. The fallback MUST be the stored original publisher title for `external.title` and an empty string for `external.description`.

Failure to obtain optional current card text metadata MUST NOT turn an otherwise valid thumbnail-backed publication into a failed or blocked publication. Existing Bluesky posts MUST NOT be backfilled or edited solely to apply this external-card text rule.

## 6. Post content and default message

The post MUST reuse already-publishable Media metadata. It MUST NOT invoke AI to create a separate social summary.

The UK AQ-generated Bluesky post text MUST use the stored original publisher headline:

```text
media_articles.title
```

`display_title` MUST NOT be used for the Bluesky post body, even when a human or accepted AI display title is currently public on UK AQ. A Pending AI title suggestion MUST likewise never be used for the Bluesky post body.

This deliberate separation lets UK AQ continue editing a compact website display title without changing or creating ambiguity around an already-published automated social post. The external-card title remains governed separately by the publisher-metadata priority in section 5.1.

Every normal post text MUST start with the original publisher headline. The configured global default-message template follows on the **very next line**, with exactly one newline character between the rendered headline and the first line of the default message. There MUST NOT be an empty line between them:

```text
{original publisher title}
{default_message}
```

Therefore, when the default message starts with `From {publisher} {publisher_mention}`, that `From` line is always line 2 of the post.

Existing Bluesky posts MUST NOT be edited, deleted or reposted solely to adopt the original-headline or single-newline layout rule. The change applies to posts created after the updated publisher code is deployed.

The title block is fixed by the publisher and cannot be moved into, omitted from or reordered by the configurable default message.

The default message is a global Bluesky setting stored in D1. It is not configured per article and it MUST NOT require a Worker deployment to edit.

The initial default message SHOULD be:

```text
From {publisher} {publisher_mention}

Live and historical UK air quality data:
https://ukaq.co.uk/
```

Supported V1 placeholders are:

```text
{publisher}
{publisher_mention}
```

`{publisher_mention}` expands to a real configured Bluesky mention when an explicit publisher social identity exists, otherwise it expands to an empty string. The renderer MUST clean up whitespace caused by an empty optional mention so the published text does not contain an accidental trailing or doubled space.

Unknown placeholders MUST be rejected by the authenticated settings API rather than passed through literally.

The canonical publisher article URL does not have to appear in the text template. The canonical article remains the mandatory external card destination independently of the default-message text.

The external card MUST therefore continue to use the canonical article URL even if the editable default message contains no article URL, contains the UK AQ URL, or is later changed to other bounded text.

Publisher Bluesky handles MUST be explicit configuration. They MUST NOT be guessed from publisher names.

Every newly created UK AQ `app.bsky.feed.post` record MUST include explicit UK English language metadata:

```ts
langs: ['en-GB']
```

This is a fixed UK AQ publication value. The publisher MUST NOT use `en` instead, dynamically detect the language, infer it from the source article, publisher or article metadata, or omit `langs` when an optional publisher mention is absent. Existing Bluesky posts MUST NOT be backfilled or edited solely to add this metadata. The metadata describes the UK AQ-generated post text; it does not guarantee that Bluesky clients will suppress or display any particular translation control.

### 6.1 Default-message product limit

The editable non-variable portion of the default message MUST be limited to:

```text
120 graphemes
```

This is a UK AQ product limit, deliberately lower than Bluesky's full post limit.

For this calculation, recognised placeholder tokens are excluded from the 120-grapheme count. All literal text, punctuation, spaces and line breaks outside those placeholder tokens count towards the limit.

The authenticated settings API MUST enforce this limit using Unicode grapheme semantics, not JavaScript UTF-16 code-unit length or byte length. The dashboard counter is guidance, but backend validation is authoritative.

### 6.2 Full-post limit and deterministic title shortening

The complete expanded post MUST also satisfy the current Bluesky/AT Protocol post-text limits at publication time. At the time this contract was agreed, `app.bsky.feed.post` permits 300 graphemes and 3,000 bytes. Provider limits MUST be re-verified during implementation and deployment.

The publisher MUST calculate the real expanded message for the actual article, including publisher and optional mention, then reserve the remaining grapheme budget for the original publisher headline plus the required single-newline separator.

If the stored original publisher headline is too long to fit, shorten only the rendered social-post headline deterministically, with an ellipsis or equivalent fixed truncation marker. Do not alter the title stored in Media and do not silently truncate the operator's configured default message.

If the expanded default message itself leaves no valid room for a title under the current provider limit, the publication MUST fail safely with a bounded text-length error rather than sending malformed or unexpectedly rewritten copy.

## 7. Durable publication state

D1, not Cloudflare Queue delivery order, is authoritative for the social backlog and publication result.

Add durable Bluesky publication state with the logical equivalent of:

```text
media_bluesky_publications

id
article_id
approval_event_id          # nullable for explicit manual publications/reposts
publication_key            # unique request/publication identity
publication_reason         # auto_approved, pending_approved, rejected_repost, unhidden_repost
status                     # queued, posting, posted, failed/blocked as implemented
attempt_count
record_key                 # when deterministic remote identity is supported
post_uri
post_cid
last_error_code
created_at
last_attempted_at
posted_at
updated_at
```

The exact physical schema may be refined during implementation, but these invariants are required:

- each automatically eligible auto-approval event can create at most one automatic publication row;
- manual publication/repost requests are not unique by `article_id`;
- manual publication/repost requests are unique by their admin request/publication identity;
- a `pending_approved` reason denotes the Pending -> Approved origin of the manual request and does not imply that such rows should be created automatically;
- returned Bluesky URI and CID are stored after successful publication;
- raw credentials, response bodies containing sensitive material and unbounded remote errors are never stored;
- historical publication rows are retained as audit state and are not deleted merely because an article is later hidden or an operator cancels an unposted request.

Internal reason/error codes SHOULD be rendered as human-readable labels in the dashboard rather than exposing raw snake_case values as the primary operator-facing wording.

## 8. Automatic and explicit outbox creation

The existing append-only `media_article_events` stream remains the durable source for automatic Bluesky eligibility evidence, but automatic outbox creation is limited to genuine automatic approvals.

Automatic outbox creation MUST recognise:

```text
auto_approved
```

An operator-driven approval event, including:

```text
approved where from_status = 'pending'
approved where from_status = 'rejected'
unhidden where from_status = 'hidden'
```

MUST NOT create a Bluesky publication row merely because the article became Approved.

For those manual transitions, a publication row may be created only when the authenticated admin mutation explicitly carries `post_to_bluesky=true` and the request satisfies the eligibility rules in sections 3 and 4.

The preferred implementation is a forward-only D1/runtime change that preserves durable approval-event provenance while moving manual Bluesky creation behind the explicit admin request. It MUST NOT backfill old approval events merely because the change is installed.

Historical `pending_approved` rows created under the earlier automatic Pending -> Approved behaviour remain audit state. They MUST NOT be reactivated or recreated automatically.

## 9. Dedicated Cloudflare Queue

Use a dedicated Cloudflare Queue for Bluesky wake-up work:

```text
uk-aq-media-bluesky
```

Recommended Worker binding name:

```text
MEDIA_BLUESKY_QUEUE
```

Do not put Bluesky work into `uk-aq-media-discovery`; its message schema and retry behaviour remain discovery-specific.

Both `media-discovery` and `media-admin` may produce wake-up messages because eligible approvals originate in both paths.

The preferred consumer is the existing `media-discovery` Worker, using its queue handler to distinguish the discovery queue from the Bluesky queue. A fourth Worker is not required unless implementation-time structural validation shows that the current deployed Worker configuration cannot safely support the second consumer binding.

The Bluesky queue consumer MUST be serialised for this workload. Configure the Bluesky consumer with the logical equivalent of:

```text
max_batch_size: 1
max_concurrency: 1
```

The Queue is a wake-up/retry mechanism. It MUST NOT be the only durable record of work and MUST NOT define publication ordering.

## 10. Cooldown and ordering

The default cooldown between successful Bluesky posts is:

```text
600 seconds
```

The cooldown MUST be stored in authoritative D1 settings so it can be changed from the authenticated Media development/editorial dashboard without redeploying Workers.

It MUST NOT be a Wrangler variable that requires a deployment for an ordinary editorial change.

Cooldown is measured from the actual last successful post, not from when jobs entered the backlog:

```text
next_allowed_at = last_successful_post_at + current_cooldown
```

Changing the configured cooldown changes the next eligibility calculation without rewriting already queued jobs.

When the consumer wakes, it MUST select the oldest eligible queued D1 publication using durable monotonic ordering, normally the smallest publication id. This means sequential manual publications are published in the same order in which their durable publication rows were created even though Cloudflare Queue delivery order is not guaranteed.

General ordering among articles created in the same discovery burst is not a product requirement beyond this deterministic oldest-first backlog rule.

If the cooldown has not elapsed, the consumer MUST leave the publication queued and arrange a delayed wake-up for the remaining interval rather than busy-looping or posting early.

## 11. Publish enable/disable and operator cancellation

D1 MUST contain an operator-controlled Bluesky publishing enable/disable setting.

The initial deployment to TEST MUST default to disabled so applying migrations or deploying code cannot unexpectedly publish historical or TEST activity to the public `@ukaq.co.uk` account.

When publishing is disabled:

- eligible future publication rows may remain durably queued;
- the consumer MUST NOT call Bluesky;
- the dashboard MUST clearly show that publishing is disabled;
- re-enabling publication resumes processing from the oldest queued eligible job, subject to the current cooldown.

An operator MUST be able to cancel a queued, not-yet-posted publication without deleting its audit row. The canonical durable cancellation representation is:

```text
status = 'blocked'
last_error_code = 'operator_cancelled'
next_attempt_at = NULL
```

A cancelled publication MUST NOT be selected by reconciliation or automatically reactivated when publishing is re-enabled. The dashboard SHOULD present this state with a friendly `Cancelled`-style label while retaining the durable internal status/error code for audit.

Cancellation MUST NOT change the Media article's editorial state and MUST NOT delete publication history.

## 12. Queue wake-up and reconciliation

After a D1 transaction creates a queued Bluesky publication row, the relevant Worker SHOULD send a bounded wake-up message to `MEDIA_BLUESKY_QUEUE` immediately.

Failure to send that Queue message MUST NOT roll back or fail the underlying article approval once the D1 approval/publication state is durable.

The existing two-hour Media scheduler remains a reconciliation safety net only. Each normal scheduler invocation SHOULD check for stranded queued Bluesky work and issue a generic Bluesky wake-up when appropriate.

Normal Bluesky publishing MUST NOT wait for the two-hour Media discovery cadence.

This gives the required behaviour:

```text
eligible publication decision -> durable D1 job -> near-immediate Queue wake-up
```

with the existing scheduler providing bounded recovery if a wake-up send is lost after the D1 commit.

## 13. Remote idempotency

Cloudflare Queues is at-least-once infrastructure, and a Worker may fail after Bluesky accepts a post but before D1 records success.

The implementation MUST therefore provide remote duplicate protection in addition to D1 publication-key uniqueness.

Before implementation, verify the current AT Protocol API/SDK path for supplying a deterministic valid record key for `app.bsky.feed.post`.

If supported by the chosen current client, derive/store a stable valid record key from the publication identity so retrying the same publication converges on the same remote record rather than creating another post.

If the chosen API/client cannot safely provide that semantic, implementation MUST document and implement an alternative reconciliation/idempotency approach before public publishing is enabled.

This targeted check is required because it changes correctness design. It is not a speculative functional test suite.

## 14. Dashboard and admin API

The authenticated Media Articles page MUST include a global **Bluesky** button. This button is not attached to a particular article and MUST open a generic Bluesky settings modal.

The global settings modal MUST expose at least:

```text
Bluesky account: @ukaq.co.uk
Publishing enabled: true/false
Default message: <editable template>
Post cooldown: <minutes>
```

The modal MUST NOT choose a random or current real article merely to display a preview.

The default-message editor MUST show a live dynamic counter using grapheme semantics:

```text
<fixed graphemes> / 120
```

The modal MUST also show a clearly labelled **Example preview** built from fixed dummy/example article values rather than live article data, while rendering the currently edited default-message template. The dummy headline MUST represent an original publisher headline, not a UK AQ display title. The example must mirror the real post layout, including the single newline between headline and default message:

```text
Example original publisher headline for an air-quality article
From Example Publisher @example.bsky.social

Live and historical UK air quality data:
https://ukaq.co.uk/
```

If the currently edited default-message template differs from the initial example above, the preview MUST show that current template with the fixed dummy publisher values. It MUST NOT insert an extra blank line between the example headline and the first rendered default-message line.

The example preview MUST show a second dynamic full-post count against the current Bluesky grapheme limit, currently:

```text
<expanded example graphemes> / 300
```

The UI MUST make clear that this second count is an example only because real article titles, publisher names and mentions vary. The actual publisher performs the authoritative full-post calculation immediately before posting.

The modal SHOULD display the available placeholders beside or beneath the editor:

```text
{publisher}
{publisher_mention}
```

Saving the modal MUST call bounded authenticated Media admin endpoints. Browser code MUST NOT talk directly to Bluesky or Cloudflare Queues.

The authenticated Media dashboard MUST expose the article-specific Bluesky control whenever an operator chooses **Approved** as the destination state, both in the individual article pop-up and in bulk approval controls.

For Pending -> Approved, Rejected -> Approved and Hidden -> Approved:

- show `Post to Bluesky @ukaq.co.uk`;
- default it to unchecked;
- make it unavailable when the requested social publication cannot satisfy the thumbnail rule;
- with the checkbox unchecked, perform only the editorial state change and create no Bluesky publication job;
- with the checkbox checked, create the explicit Bluesky publication job only after backend eligibility validation succeeds.

The individual pop-up and bulk controls MUST follow the same rule. Pending -> Approved is not a special automatic case.

For bulk approval with the checkbox checked, the UI MUST make clear that the option applies to the whole selected set. If any selected article is ineligible for Bluesky publication, the backend MUST reject the combined request and return enough bounded information for the UI to explain which article(s) prevent the operation. It MUST NOT silently queue only an eligible subset.

The dashboard SHOULD expose publication history/status for an article, including queued/posted/failed/cancelled state, posted time, post link and multiple-post count where applicable. Operator-facing wording SHOULD use friendly labels rather than raw internal reason/status/error codes.

Changing global Bluesky settings MUST be a bounded authenticated admin mutation. The settings MUST include:

- publishing enabled/disabled;
- default message template;
- cooldown duration.

The backend MUST validate recognised placeholders, the 120-grapheme fixed-text limit, and the bounded cooldown value before storing a new template/settings state.

## 15. Failure handling

Bluesky publication is downstream of Media approval.

Failures MUST be isolated and observable:

- Bluesky authentication/API outage does not change article approval status;
- thumbnail fetch/validation failure does not publish a thumbnail-less fallback;
- Queue wake-up failure does not remove the durable D1 job;
- malformed Queue messages are rejected safely and cannot select arbitrary URLs or credentials;
- an invalid or over-limit stored message template cannot be published silently;
- a real expanded post that cannot fit within current provider limits fails with a bounded text-length error;
- bounded retry/backoff is allowed;
- repeated permanent failure remains visible in D1/dashboard rather than retrying forever without operator visibility;
- an operator-cancelled queued row remains durable and non-runnable;
- logs use bounded error codes and MUST NOT include secrets.

Hiding or rejecting an article after it has already been posted does not automatically delete the Bluesky post in this version. Remote deletion requires a separate explicit product decision.

## 16. Post-publication data and links

After success, store the returned AT URI and CID. The admin surface may derive or store a safe public Bluesky link so the operator can open the actual post.

Publication success is defined by the remote post being created and its URI/CID being durably recorded, not merely by a Queue message being acknowledged.

## 17. Deferred scope

This contract does not add:

- per-article custom social copy for normal automatic posts;
- automatic Bluesky post deletion when Media state changes;
- bulk historical publication;
- periodic promotional reposting;
- AI-written social commentary;
- automatic publisher-handle guessing;
- engagement analytics;
- Mastodon or other social platforms;
- Bluesky banner/profile automation.

Future banner/profile work is tracked separately in the existing Phase 2 plan and MUST NOT weaken this article-publication contract.

## 18. 17 September 2026 transition note

The earlier contract automatically created Bluesky publication rows for manual Pending -> Approved transitions. Real TEST use showed that this coupled ordinary editorial approval to social publication too tightly, particularly during multi-article approval.

The authoritative rule is now:

```text
automatic Media approval -> automatic Bluesky publication when eligible
manual choice of Approved -> Bluesky publication only when the operator explicitly ticks the checkbox
```

Existing queued rows created under the superseded Pending -> Approved automatic rule are historical state. If they are not intended for publication, they should be cancelled durably rather than deleted. The `blocked` / `operator_cancelled` representation in section 11 is the agreed audit-preserving form.

Implementation of this amendment MUST be forward-only. It MUST NOT create a speculative historical backfill or reinterpret prior posted records.

## 19. External protocol references

Implementation must verify current provider requirements at implementation time. Relevant current references include:

- Bluesky post, link, mention, image/blob and external-card creation: <https://docs.bsky.app/docs/tutorials/creating-a-post>
- current `app.bsky.feed.post` lexicon, including text `maxGraphemes`: <https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/feed/post.json>
- AT Protocol record-key requirements: <https://atproto.com/specs/record-key>
- Cloudflare Queue behaviour: <https://developers.cloudflare.com/queues/reference/how-queues-works/>
- Cloudflare Queue retries/delayed delivery: <https://developers.cloudflare.com/queues/configuration/batching-retries/>

Provider limits may change. The implementation must conform to the provider's current accepted limits at deployment time while retaining UK AQ's separate 120-grapheme default-message product limit.