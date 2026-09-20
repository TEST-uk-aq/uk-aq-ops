import { ArticleStatus, bearerMatches, boundedLimit, HttpError, httpFailure, json, reconcileHomepageLatestSix, z,
  BLUESKY_PLACEHOLDERS, BLUESKY_POST_BYTES, BLUESKY_POST_GRAPHEMES,
  BLUESKY_TEMPLATE_LITERAL_GRAPHEMES, validateBlueskyTemplate,
  FACEBOOK_PLACEHOLDERS, FACEBOOK_TEMPLATE_MAX_LENGTH,
  validateFacebookTemplate,
  loadSource, type Status } from '@uk-aq-media/core';
import {
  discoverGuardianPreviewForArticle, GUARDIAN_ROUTES,
  type GuardianPreviewCandidate, type GuardianPreviewLookup,
} from '@uk-aq-media/discovery';
import {
  D1DisplayTitleNeuronLedger, LocalRequestBudget, WorkersAiDisplayTitleProvider,
  displayTitleNeuronRates, suggestDisplayTitleExplicit,
} from '@uk-aq-media/enrichment';
import {
  applyGuardianImageRepairPlan, buildGuardianImageRepairPlan,
  requireCurrentGuardianImageRepairPlan,
} from './guardian-image-bulk';
import { handleEditorialDashboard } from './editorial-dashboard';
import { directPublishState, facebookEligibility, requireFacebookEligibility } from './direct-publish-eligibility';

type Action = 'approve' | 'reject' | 'hide' | 'unhide';
const transitions: Record<Action, { from: Status[]; to: Status; event: string }> = {
  approve: { from: ['pending', 'rejected'], to: 'approved', event: 'approved' },
  reject: { from: ['pending', 'approved', 'hidden'], to: 'rejected', event: 'rejected' },
  hide: { from: ['approved'], to: 'hidden', event: 'hidden' },
  unhide: { from: ['hidden'], to: 'approved', event: 'unhidden' },
};

type AdminStatusRequestRow = {
  article_id: number;
  action: Action;
  post_to_bluesky: number;
  post_to_facebook: number;
};

type AdminStatusEventRow = {
  article_id: number;
  event_type: string;
  from_status: Status | null;
  to_status: Status;
  revision: number;
};

type AdminBlueskyPublicationRow = {
  id: number;
  article_id: number;
  publication_reason: string;
  status: string;
};

type AdminFacebookPublicationRow = AdminBlueskyPublicationRow;

const ManualDisplayTitleBody = z.object({ display_title: z.string().nullable() }).strict();
const GuardianImagePreviewBody = z.object({
  route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
}).strict();
const GuardianImageApplyBody = z.object({
  route_key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  expected_current_image_url: z.string().min(1).max(2048).nullable(),
  proposed_image_url: z.string().min(1).max(2048),
  confirm_replace_existing: z.literal(true),
}).strict();
const GuardianBulkImageApplyBody = z.object({
  confirm_bulk_replace: z.literal(true),
  repair_token: z.string().regex(/^guardian-image-repair-v1:[a-f0-9]{64}$/),
}).strict();
const BlueskySettingsBody = z.object({
  publishing_enabled: z.boolean(),
  default_message_template: z.string().min(1).max(2000),
  cooldown_minutes: z.number().int().min(1).max(1440),
}).strict();
const FacebookSettingsBody = z.object({
  publishing_enabled: z.boolean(),
  default_message_template: z.string().min(1).max(FACEBOOK_TEMPLATE_MAX_LENGTH),
  cooldown_minutes: z.number().int().min(1).max(1440),
}).strict();
const StatusMutationBody = z.object({
  post_to_bluesky: z.boolean().optional(),
  post_to_facebook: z.boolean().optional(),
}).strict();
const BulkApproveBody = z.object({
  article_ids: z.array(z.number().int().positive()).min(1).max(50),
  post_to_bluesky: z.boolean().optional(),
  post_to_facebook: z.boolean().optional(),
}).strict();
const DirectPublishBody = StatusMutationBody.refine(value =>
  value.post_to_bluesky === true || value.post_to_facebook === true);
const BulkDirectPublishBody = BulkApproveBody.refine(value =>
  value.post_to_bluesky === true || value.post_to_facebook === true);
const MAX_ADMIN_BODY_BYTES = 4096;
const MAX_HUMAN_DISPLAY_TITLE_CHARACTERS = 500;
const NEURON_MICRO_UNITS = 1_000_000;

type TitleMutationRow = {
  id: number;
  status: Status;
  title: string;
  display_title: string | null;
  display_title_origin: 'publisher' | 'human' | 'ai' | null;
  ai_title_suggestion: string | null;
  ai_title_suggestion_state: 'pending' | 'accepted' | 'rejected' | null;
  ai_title_decided_at: string | null;
};

type ExplicitTitleArticleRow = TitleMutationRow & {
  publisher: string;
  author: string | null;
  approval_method: string | null;
  approved_at: string | null;
  ai_title_attempted_at: string | null;
  ai_title_model: string | null;
  ai_title_prompt_version: string | null;
  ai_title_generated_at: string | null;
};

type GuardianImageRow = {
  id: number;
  source_key: string;
  canonical_url: string;
  title: string;
  status: Status;
  og_image_url: string | null;
  image_policy: string;
  preview_metadata_checked_at: string | null;
};

export type AiUsageRow = {
  usage_date: string;
  ai_requests: number;
  ai_titles_attempted: number;
  legacy_usage_unknown_requests: number;
  titles_generated_successfully: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calculated_neuron_microunits: number;
  outstanding_reserved_neuron_microunits: number;
  accounted_neuron_microunits: number;
  media_daily_budget_neuron_microunits: number;
  account_free_neuron_microunits: number;
};

function configuredAiUsageLimits(env: MediaAdminEnv): {
  dailyBudgetNeurons: number;
  accountFreeNeurons: number;
  maximumTitlesPerRequest: number;
  model: string;
} {
  const dailyBudgetNeurons = Number(env.MEDIA_AI_DAILY_NEURON_BUDGET);
  const accountFreeNeurons = Number(env.MEDIA_AI_ACCOUNT_FREE_NEURONS_PER_DAY);
  const maximumTitlesPerRequest = Number(env.MEDIA_AI_MAX_TITLES_PER_REQUEST);
  const model = String(env.MEDIA_AI_MODEL).trim();
  if (!Number.isSafeInteger(dailyBudgetNeurons) || dailyBudgetNeurons < 1 ||
      !Number.isSafeInteger(accountFreeNeurons) || accountFreeNeurons < 1 ||
      dailyBudgetNeurons > accountFreeNeurons ||
      !Number.isSafeInteger(dailyBudgetNeurons * NEURON_MICRO_UNITS) ||
      !Number.isSafeInteger(accountFreeNeurons * NEURON_MICRO_UNITS) ||
      !Number.isSafeInteger(maximumTitlesPerRequest) || maximumTitlesPerRequest < 1 ||
      maximumTitlesPerRequest > 5 || !/^@cf\/[a-z0-9._/-]+$/i.test(model) ||
      model.length > 200 || displayTitleNeuronRates(model) === null) {
    throw new HttpError(503, 'ai_usage_configuration_invalid');
  }
  return { dailyBudgetNeurons, accountFreeNeurons, maximumTitlesPerRequest, model };
}

function neurons(microunits: number): number {
  return microunits / NEURON_MICRO_UNITS;
}

export function presentAiUsage(row: AiUsageRow) {
  const mediaRemaining = Math.max(0,
    row.media_daily_budget_neuron_microunits - row.accounted_neuron_microunits);
  const estimatedCloudflareRemaining = Math.max(0,
    row.account_free_neuron_microunits - row.accounted_neuron_microunits);
  return {
    utc_date: row.usage_date,
    ai_requests: row.ai_requests,
    ai_titles_attempted: row.ai_titles_attempted,
    legacy_usage_unknown_requests: row.legacy_usage_unknown_requests,
    titles_generated_successfully: row.titles_generated_successfully,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    total_tokens: row.total_tokens,
    calculated_neurons_used: neurons(row.calculated_neuron_microunits),
    outstanding_reserved_neurons: neurons(row.outstanding_reserved_neuron_microunits),
    media_neurons_accounted_or_reserved: neurons(row.accounted_neuron_microunits),
    media_daily_neuron_budget: neurons(row.media_daily_budget_neuron_microunits),
    media_budget_remaining: neurons(mediaRemaining),
    configured_cloudflare_free_allocation_neurons:
      neurons(row.account_free_neuron_microunits),
    estimated_cloudflare_free_neurons_remaining: neurons(estimatedCloudflareRemaining),
    exact_neuron_microunits: {
      calculated_used: row.calculated_neuron_microunits,
      outstanding_reserved: row.outstanding_reserved_neuron_microunits,
      accounted_or_reserved: row.accounted_neuron_microunits,
      media_budget_remaining: mediaRemaining,
      estimated_cloudflare_free_remaining: estimatedCloudflareRemaining,
    },
  };
}

async function aiUsage(env: MediaAdminEnv, limit: number): Promise<Response> {
  const configured = configuredAiUsageLimits(env);
  const { results } = await env.MEDIA_DB.prepare(`SELECT usage_date,
      coalesce(sum(CASE WHEN request_started_at IS NOT NULL THEN request_count ELSE 0 END), 0)
        AS ai_requests,
      coalesce(sum(CASE WHEN request_started_at IS NOT NULL THEN titles_attempted ELSE 0 END), 0)
        AS ai_titles_attempted,
      coalesce(sum(CASE WHEN record_kind = 'legacy_daily_call_counter'
        THEN request_count ELSE 0 END), 0) AS legacy_usage_unknown_requests,
      coalesce(sum(titles_generated), 0) AS titles_generated_successfully,
      coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
      coalesce(sum(completion_tokens), 0) AS completion_tokens,
      coalesce(sum(total_tokens), 0) AS total_tokens,
      coalesce(sum(CASE WHEN accounting_state = 'reconciled'
        THEN actual_neuron_microunits ELSE 0 END), 0) AS calculated_neuron_microunits,
      coalesce(sum(CASE WHEN accounting_state = 'reserved'
        THEN reserved_neuron_microunits ELSE 0 END), 0)
        AS outstanding_reserved_neuron_microunits,
      coalesce(sum(CASE WHEN accounting_state = 'reconciled'
        THEN actual_neuron_microunits ELSE reserved_neuron_microunits END), 0)
        AS accounted_neuron_microunits,
      min(media_daily_budget_neuron_microunits) AS media_daily_budget_neuron_microunits,
      min(account_free_neuron_microunits) AS account_free_neuron_microunits
    FROM media_ai_neuron_requests GROUP BY usage_date
    ORDER BY usage_date DESC LIMIT ?`).bind(limit).all<AiUsageRow>();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [...results];
  if (!rows.some(row => row.usage_date === today)) {
    rows.unshift({ usage_date: today, ai_requests: 0, ai_titles_attempted: 0,
      legacy_usage_unknown_requests: 0,
      titles_generated_successfully: 0, prompt_tokens: 0, completion_tokens: 0,
      total_tokens: 0, calculated_neuron_microunits: 0,
      outstanding_reserved_neuron_microunits: 0, accounted_neuron_microunits: 0,
      media_daily_budget_neuron_microunits: configured.dailyBudgetNeurons * NEURON_MICRO_UNITS,
      account_free_neuron_microunits: configured.accountFreeNeurons * NEURON_MICRO_UNITS });
    if (rows.length > limit) rows.pop();
  }
  return json({
    usage_days: rows.map(presentAiUsage),
    configured_limits: {
      media_daily_neuron_budget: configured.dailyBudgetNeurons,
      configured_cloudflare_free_allocation_neurons: configured.accountFreeNeurons,
    },
    accounting: {
      fixed_point_unit: 'one-millionth of a neuron',
      microunits_per_neuron: NEURON_MICRO_UNITS,
      cloudflare_remaining_is_estimate: true,
      cloudflare_estimate_scope: 'Media D1-recorded requests only; unrelated or manual account calls are not visible',
    },
  });
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'json_content_type_required');
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_ADMIN_BODY_BYTES) {
    throw new HttpError(413, 'request_body_too_large');
  }
  if (!request.body) throw new HttpError(400, 'invalid_json');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ADMIN_BODY_BYTES) throw new HttpError(413, 'request_body_too_large');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json');
  } finally {
    try { await reader.cancel('admin body read complete or rejected'); } catch { /* best effort */ }
  }
  try { return JSON.parse(body) as unknown; }
  catch { throw new HttpError(400, 'invalid_json'); }
}

async function boundedOptionalJson(request: Request): Promise<unknown> {
  if (request.body === null || request.headers.get('content-length') === '0') return {};
  return boundedJson(request);
}

function normaliseHumanDisplayTitle(value: string | null): string | null {
  if (value === null) return null;
  if (/[\r\n\u2028\u2029]/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HttpError(400, 'invalid_display_title');
  }
  const title = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!title || [...title].length > MAX_HUMAN_DISPLAY_TITLE_CHARACTERS) {
    throw new HttpError(400, 'invalid_display_title');
  }
  return title;
}

async function decideAiTitle(db: D1Database, id: number,
  decision: 'accept' | 'reject'): Promise<Response> {
  const now = new Date().toISOString();
  const changed = decision === 'accept'
    ? await db.prepare(`UPDATE media_articles SET
        display_title = ai_title_suggestion, display_title_origin = 'ai',
        ai_title_suggestion_state = 'accepted', ai_title_decided_at = ?, updated_at = ?
        WHERE id = ? AND ai_title_suggestion_state = 'pending'
          AND ai_title_suggestion IS NOT NULL
        RETURNING id, status, title, display_title, display_title_origin,
          ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at`)
      .bind(now, now, id).first<TitleMutationRow>()
    : await db.prepare(`UPDATE media_articles SET
        ai_title_suggestion_state = 'rejected', ai_title_decided_at = ?, updated_at = ?
        WHERE id = ? AND ai_title_suggestion_state = 'pending'
          AND ai_title_suggestion IS NOT NULL
        RETURNING id, status, title, display_title, display_title_origin,
          ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at`)
      .bind(now, now, id).first<TitleMutationRow>();
  if (changed) {
    await reconcileHomepageLatestSix(db);
    return json({ article: changed });
  }
  const exists = await db.prepare('SELECT id FROM media_articles WHERE id = ?').bind(id).first();
  throw new HttpError(exists ? 409 : 404,
    exists ? 'no_pending_ai_title_suggestion' : 'article_not_found');
}

async function setHumanDisplayTitle(request: Request, db: D1Database,
  id: number): Promise<Response> {
  const parsed = ManualDisplayTitleBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_display_title_body');
  const displayTitle = normaliseHumanDisplayTitle(parsed.data.display_title);
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE media_articles SET
    display_title = ?,
    display_title_origin = CASE WHEN ? IS NULL THEN NULL ELSE 'human' END,
    ai_title_suggestion_state = CASE
      WHEN ? IS NOT NULL AND ai_title_suggestion_state = 'pending' THEN 'rejected'
      ELSE ai_title_suggestion_state END,
    ai_title_decided_at = CASE
      WHEN ? IS NOT NULL AND ai_title_suggestion_state = 'pending' THEN ?
      ELSE ai_title_decided_at END,
    updated_at = ?
    WHERE id = ?
    RETURNING id, status, title, display_title, display_title_origin,
      ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at`)
    .bind(displayTitle, displayTitle, displayTitle, displayTitle, now, now, id)
    .first<TitleMutationRow>();
  if (!changed) throw new HttpError(404, 'article_not_found');
  await reconcileHomepageLatestSix(db);
  return json({ article: changed });
}

const EXPLICIT_TITLE_RETURNING = `id, status, title, display_title, display_title_origin,
  ai_title_suggestion, ai_title_suggestion_state, ai_title_decided_at, publisher, author,
  approval_method, approved_at, ai_title_attempted_at, ai_title_model,
  ai_title_prompt_version, ai_title_generated_at`;

export const EXPLICIT_DISPLAY_TITLE_UPDATE_SQL = `UPDATE media_articles SET
  ai_title_attempted_at = ?, ai_title_suggestion = ?, ai_title_suggestion_state = 'pending',
  ai_title_model = ?, ai_title_prompt_version = ?, ai_title_generated_at = ?,
  ai_title_decided_at = NULL, updated_at = ? WHERE id = ? RETURNING ${EXPLICIT_TITLE_RETURNING}`;

async function explicitTitleArticle(db: D1Database, id: number): Promise<ExplicitTitleArticleRow | null> {
  return db.prepare(`SELECT ${EXPLICIT_TITLE_RETURNING} FROM media_articles WHERE id = ?`)
    .bind(id).first<ExplicitTitleArticleRow>();
}

function presentExplicitGeneration(article: ExplicitTitleArticleRow, replayed: boolean) {
  return json({ article, generation: {
    outcome: article.ai_title_suggestion === article.title
      ? 'no_change' : 'suggested',
    replayed,
  } });
}

async function replayExplicitGeneration(db: D1Database, id: number,
  logicalRequestKey: string): Promise<Response | null> {
  const ledger = await db.prepare(`SELECT request_started_at, completed_at, titles_generated
    FROM media_ai_neuron_requests WHERE logical_request_key = ?`).bind(logicalRequestKey)
    .first<{ request_started_at: string | null; completed_at: string | null;
      titles_generated: number }>();
  if (!ledger) return null;
  if (!ledger.completed_at) throw new HttpError(409, 'ai_title_generation_in_progress');
  const article = await explicitTitleArticle(db, id);
  if (!article) throw new HttpError(404, 'article_not_found');
  if (ledger.titles_generated === 1 && article.ai_title_generated_at === ledger.completed_at &&
      article.ai_title_suggestion) return presentExplicitGeneration(article, true);
  throw new HttpError(409, ledger.titles_generated === 0
    ? 'ai_title_generation_produced_no_valid_suggestion'
    : 'ai_title_generation_replay_result_no_longer_current');
}

async function generateExplicitAiTitle(request: Request, env: MediaAdminEnv,
  id: number): Promise<Response> {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
    throw new HttpError(400, 'idempotency_key_required');
  }
  const logicalRequestKey = `admin-display-title:${id}:${key}`;
  const replay = await replayExplicitGeneration(env.MEDIA_DB, id, logicalRequestKey);
  if (replay) return replay;
  const article = await explicitTitleArticle(env.MEDIA_DB, id);
  if (!article) throw new HttpError(404, 'article_not_found');
  const configured = configuredAiUsageLimits(env);
  const outcome = await suggestDisplayTitleExplicit({
    publisher: article.publisher,
    title: article.title,
    title_context: null,
    author: article.author,
    categories: [],
  }, new WorkersAiDisplayTitleProvider(env.AI, configured.model),
  new LocalRequestBudget(1),
  new D1DisplayTitleNeuronLedger(env.MEDIA_DB, configured.maximumTitlesPerRequest),
  logicalRequestKey, configured.dailyBudgetNeurons, configured.accountFreeNeurons,
  configured.maximumTitlesPerRequest);
  if (outcome.status === 'skipped' && outcome.reason === 'duplicate_request') {
    const duplicate = await replayExplicitGeneration(env.MEDIA_DB, id, logicalRequestKey);
    if (duplicate) return duplicate;
  }
  if (outcome.status === 'skipped') {
    throw new HttpError(outcome.reason === 'daily_neuron_budget' ? 429 : 503,
      `ai_title_generation_${outcome.reason}`);
  }
  if (outcome.status === 'failed') {
    throw new HttpError(502, `ai_title_generation_${outcome.reason}`);
  }
  const stored = await env.MEDIA_DB.prepare(EXPLICIT_DISPLAY_TITLE_UPDATE_SQL)
    .bind(outcome.provenance.generated_at, outcome.title, outcome.provenance.model,
      outcome.provenance.version, outcome.provenance.generated_at,
      outcome.provenance.generated_at, id).first<ExplicitTitleArticleRow>();
  if (!stored) throw new HttpError(404, 'article_not_found');
  return presentExplicitGeneration(stored, false);
}

function presentGuardianImageCandidate(candidate: GuardianPreviewCandidate | null) {
  return candidate ? {
    url: candidate.url,
    kind: candidate.kind,
    width: candidate.width,
    height: candidate.height,
  } : null;
}

async function guardianImageRefreshProposal(db: D1Database, id: number,
  routeKey: string): Promise<{ row: GuardianImageRow; lookup: GuardianPreviewLookup }> {
  if (!GUARDIAN_ROUTES.some(route => route.route_key === routeKey)) {
    throw new HttpError(400, 'invalid_guardian_route_key');
  }
  const row = await db.prepare(`SELECT id, source_key, canonical_url, title, status,
      og_image_url, image_policy, preview_metadata_checked_at
    FROM media_articles WHERE id = ?`).bind(id).first<GuardianImageRow>();
  if (!row) throw new HttpError(404, 'article_not_found');
  if (row.source_key !== 'the-guardian') {
    throw new HttpError(409, 'guardian_image_refresh_requires_guardian_article');
  }
  if (row.image_policy !== 'remote_preview') {
    throw new HttpError(409, 'guardian_image_refresh_blocked');
  }
  const source = await loadSource(db, 'the-guardian');
  if (!source || !source.enabled || source.image_policy !== 'remote_preview') {
    throw new HttpError(409, 'guardian_image_refresh_blocked');
  }
  let lookup: GuardianPreviewLookup;
  try {
    lookup = await discoverGuardianPreviewForArticle(source, routeKey,
      row.canonical_url, row.og_image_url);
  } catch {
    throw new HttpError(502, 'guardian_rss_preview_unavailable');
  }
  if (!lookup.article_found) {
    throw new HttpError(409, 'guardian_article_not_in_current_route');
  }
  if (!lookup.proposed) {
    throw new HttpError(409, 'guardian_rss_preview_unavailable');
  }
  return { row, lookup };
}

function guardianImageRefreshView(row: GuardianImageRow, lookup: GuardianPreviewLookup,
  routeKey: string) {
  const proposed = lookup.proposed;
  const replacementRequired = proposed !== null && row.og_image_url !== proposed.url;
  return {
    article: {
      id: row.id,
      title: row.title,
      canonical_url: row.canonical_url,
      status: row.status,
    },
    route_key: routeKey,
    current_image: row.og_image_url === null ? null : {
      url: row.og_image_url,
      kind: lookup.current?.kind ?? null,
      width: lookup.current?.width ?? null,
      height: lookup.current?.height ?? null,
      present_in_current_rss: lookup.current !== null,
      origin: 'unknown',
    },
    proposed_image: presentGuardianImageCandidate(proposed),
    replacement_required: replacementRequired,
    individual_confirmation_required: row.og_image_url !== null && replacementRequired,
  };
}

async function previewGuardianImageRefresh(request: Request, db: D1Database,
  id: number): Promise<Response> {
  const parsed = GuardianImagePreviewBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_guardian_image_preview_body');
  const { row, lookup } = await guardianImageRefreshProposal(db, id, parsed.data.route_key);
  return json({ refresh: guardianImageRefreshView(row, lookup, parsed.data.route_key) });
}

async function applyGuardianImageRefresh(request: Request, db: D1Database,
  id: number): Promise<Response> {
  const parsed = GuardianImageApplyBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_guardian_image_apply_body');
  const input = parsed.data;
  const { row, lookup } = await guardianImageRefreshProposal(db, id, input.route_key);
  if (row.og_image_url !== input.expected_current_image_url) {
    throw new HttpError(409, 'guardian_image_refresh_stale_current_image');
  }
  if (lookup.proposed?.url !== input.proposed_image_url) {
    throw new HttpError(409, 'guardian_image_refresh_stale_proposal');
  }
  if (row.og_image_url === lookup.proposed.url) {
    return json({ changed: false,
      refresh: guardianImageRefreshView(row, lookup, input.route_key) });
  }
  const now = new Date().toISOString();
  const changed = await db.prepare(`UPDATE media_articles SET
      og_image_url = ?, preview_metadata_checked_at = ?, updated_at = ?
    WHERE id = ? AND source_key = 'the-guardian' AND image_policy = 'remote_preview'
      AND og_image_url IS ?
    RETURNING id, source_key, canonical_url, title, status, og_image_url, image_policy,
      preview_metadata_checked_at`).bind(lookup.proposed.url, now, now, id,
        input.expected_current_image_url).first<GuardianImageRow>();
  if (!changed) throw new HttpError(409, 'guardian_image_refresh_stale_current_image');
  await reconcileHomepageLatestSix(db);
  return json({ changed: true,
    refresh: guardianImageRefreshView(changed, {
      ...lookup,
      current: lookup.proposed,
    }, input.route_key) });
}

async function previewBulkGuardianImageRefresh(db: D1Database): Promise<Response> {
  return json({ repair: await buildGuardianImageRepairPlan(db) });
}

async function applyBulkGuardianImageRefresh(request: Request,
  db: D1Database): Promise<Response> {
  const parsed = GuardianBulkImageApplyBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_guardian_bulk_image_apply_body');
  const plan = await buildGuardianImageRepairPlan(db);
  requireCurrentGuardianImageRepairPlan(plan, parsed.data.repair_token);
  const changedArticleIds = await applyGuardianImageRepairPlan(db, plan);
  await reconcileHomepageLatestSix(db);
  return json({ repair: {
    ...plan,
    apply: {
      changed_rows: changedArticleIds.length,
      changed_article_ids: changedArticleIds,
      unchanged_rows: plan.counts.already_best_rows,
      skipped_rows: plan.counts.ambiguous_existing_image_rows +
        plan.counts.rows_outside_current_rss + plan.counts.conflicting_proposal_rows +
        plan.counts.no_permitted_candidate_rows +
        (plan.changes.length - changedArticleIds.length),
      compare_and_swap_skipped_rows: plan.changes.length - changedArticleIds.length,
    },
  } });
}

async function blueskySettings(request: Request, env: MediaAdminEnv): Promise<Response> {
  const present = (settings: Record<string, unknown> | null, replayed?: boolean) => {
    const template = typeof settings?.default_message_template === 'string'
      ? settings.default_message_template : '';
    let literalGraphemes: number | null = null;
    try { literalGraphemes = validateBlueskyTemplate(template).literalGraphemes; } catch { /* invalid D1 state */ }
    return { account: '@ukaq.co.uk', settings: settings ? { ...settings,
      publishing_enabled: Boolean(settings.publishing_enabled),
      default_message_literal_graphemes: literalGraphemes } : null,
    constraints: { default_message_literal_graphemes: BLUESKY_TEMPLATE_LITERAL_GRAPHEMES,
      post_graphemes: BLUESKY_POST_GRAPHEMES, post_bytes: BLUESKY_POST_BYTES,
      cooldown_minutes_min: 1, cooldown_minutes_max: 1440,
      placeholders: [...BLUESKY_PLACEHOLDERS] },
    example: { title: 'Example display title for an air-quality article',
      publisher: 'Example Publisher', publisher_mention: '@example.bsky.social' },
    ...(replayed === undefined ? {} : { replayed }) };
  };
  if (request.method === 'GET') {
    const settings = await env.MEDIA_DB.prepare(`SELECT publishing_enabled, cooldown_seconds,
      default_message_template, activation_event_id, last_successful_post_at, updated_at
      FROM media_bluesky_settings WHERE id = 1`).first();
    return json(present(settings));
  }
  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const parsed = BlueskySettingsBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_bluesky_settings');
  try { validateBlueskyTemplate(parsed.data.default_message_template); }
  catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'message_template_invalid'); }
  const requestJson = JSON.stringify(parsed.data);
  const replay = await env.MEDIA_DB.prepare(`SELECT request_json FROM media_bluesky_settings_requests
    WHERE request_key = ?`).bind(key).first<{ request_json: string }>();
  if (replay && replay.request_json !== requestJson) throw new HttpError(409, 'idempotency_key_conflict');
  const now = new Date().toISOString();
  // COALESCE captures the high watermark once only, in the same D1 statement that enables.
  if (!replay) await env.MEDIA_DB.batch([
    env.MEDIA_DB.prepare(`UPDATE media_bluesky_settings SET publishing_enabled = ?,
      cooldown_seconds = ?, default_message_template = ?,
      activation_event_id = CASE WHEN ? = 1 THEN coalesce(activation_event_id,
        (SELECT coalesce(max(id), 0) FROM media_article_events)) ELSE activation_event_id END,
      updated_at = ? WHERE id = 1`).bind(Number(parsed.data.publishing_enabled),
        parsed.data.cooldown_minutes * 60, parsed.data.default_message_template,
        Number(parsed.data.publishing_enabled), now),
    env.MEDIA_DB.prepare(`INSERT INTO media_bluesky_settings_requests
      (request_key, request_json, created_at) VALUES (?, ?, ?)`).bind(key, requestJson, now),
  ]);
  // Replays also reissue the harmless generic wake so a lost post-commit Queue
  // send is repaired without waiting for the two-hour scheduler reconciliation.
  if (parsed.data.publishing_enabled) {
    try { await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed' })); }
  }
  const settings = await env.MEDIA_DB.prepare(`SELECT publishing_enabled, cooldown_seconds,
    default_message_template, activation_event_id, last_successful_post_at, updated_at
    FROM media_bluesky_settings WHERE id = 1`).first();
  return json(present(settings, Boolean(replay)));
}

async function facebookSettings(request: Request, env: MediaAdminEnv): Promise<Response> {
  const present = (settings: Record<string, unknown> | null, replayed?: boolean) => ({
    settings: settings ? { ...settings,
      publishing_enabled: Boolean(settings.publishing_enabled),
      last_identity_name_drift: Boolean(settings.last_identity_name_drift),
      cooldown_minutes: Number(settings.cooldown_seconds) / 60 } : null,
    constraints: { message_template_max_length: FACEBOOK_TEMPLATE_MAX_LENGTH,
      cooldown_minutes_min: 1, cooldown_minutes_max: 1440,
      placeholders: [...FACEBOOK_PLACEHOLDERS] },
    ...(replayed === undefined ? {} : { replayed }),
  });
  const select = `SELECT publishing_enabled, page_id, page_name, graph_api_version,
    default_message_template, cooldown_seconds, last_identity_checked_at, last_identity_verified_at,
    last_identity_observed_name, last_identity_name_drift, last_identity_error_code,
    last_successful_post_at, updated_at FROM media_facebook_settings WHERE id = 1`;
  if (request.method === 'GET') return json(present(await env.MEDIA_DB.prepare(select).first()));
  if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
    throw new HttpError(400, 'idempotency_key_required');
  }
  const parsed = FacebookSettingsBody.safeParse(await boundedJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_facebook_settings');
  try { validateFacebookTemplate(parsed.data.default_message_template); }
  catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'message_template_invalid');
  }
  const requestJson = JSON.stringify(parsed.data);
  const replay = await env.MEDIA_DB.prepare(`SELECT request_json
    FROM media_facebook_settings_requests WHERE request_key = ?`).bind(key)
    .first<{ request_json: string }>();
  if (replay && replay.request_json !== requestJson) {
    throw new HttpError(409, 'idempotency_key_conflict');
  }
  if (replay) {
    if (parsed.data.publishing_enabled) {
      try { await env.MEDIA_FACEBOOK_QUEUE.send({ type: 'facebook_wakeup' }); }
      catch { console.error(JSON.stringify({ event: 'facebook_wakeup_failed' })); }
    }
    return json(present(await env.MEDIA_DB.prepare(select).first(), true));
  }
  if (parsed.data.publishing_enabled) {
    const connection = await env.MEDIA_DB.prepare(`SELECT page_id, graph_api_version,
      last_identity_verified_at, last_identity_error_code FROM media_facebook_settings WHERE id = 1`)
      .first<{ page_id: string; graph_api_version: string | null;
        last_identity_verified_at: string | null; last_identity_error_code: string | null }>();
    if (!connection || connection.page_id !== '1336337862891538' ||
        connection.graph_api_version !== 'v26.0' || !connection.last_identity_verified_at ||
        connection.last_identity_error_code !== null) {
      throw new HttpError(409, 'facebook_identity_not_verified');
    }
  }
  const now = new Date().toISOString();
  await env.MEDIA_DB.batch([
    env.MEDIA_DB.prepare(`UPDATE media_facebook_settings SET publishing_enabled = ?,
      cooldown_seconds = ?, default_message_template = ?, updated_at = ? WHERE id = 1`)
      .bind(Number(parsed.data.publishing_enabled), parsed.data.cooldown_minutes * 60,
        parsed.data.default_message_template, now),
    env.MEDIA_DB.prepare(`INSERT INTO media_facebook_settings_requests
      (request_key, request_json, created_at) VALUES (?, ?, ?)`)
      .bind(key, requestJson, now),
  ]);
  if (parsed.data.publishing_enabled) {
    try { await env.MEDIA_FACEBOOK_QUEUE.send({ type: 'facebook_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'facebook_wakeup_failed' })); }
  }
  return json(present(await env.MEDIA_DB.prepare(select).first(), false));
}

async function facebookConnectionCheck(request: Request, env: MediaAdminEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  await env.MEDIA_FACEBOOK_QUEUE.send({ type: 'facebook_identity_check' });
  return json({ accepted: true }, 202);
}

function manualPublicationReason(action: Action,
  fromStatus: Status | null): 'pending_approved' | 'rejected_repost' | 'unhidden_repost' | null {
  if (action === 'approve' && fromStatus === 'pending') return 'pending_approved';
  if (action === 'approve' && fromStatus === 'rejected') return 'rejected_repost';
  if (action === 'unhide' && fromStatus === 'hidden') return 'unhidden_repost';
  return null;
}

async function statusMutationReceipt(db: D1Database, key: string, id: number,
  action: Action, requestedBluesky: boolean, requestedFacebook: boolean): Promise<{
    event: AdminStatusEventRow;
    blueskyPublication: Pick<AdminBlueskyPublicationRow, 'id' | 'status'> | null;
    facebookPublication: Pick<AdminFacebookPublicationRow, 'id' | 'status'> | null;
  } | null> {
  const requestIdentity = await db.prepare(`SELECT article_id, action, post_to_bluesky,
    post_to_facebook
    FROM media_admin_status_requests WHERE request_key = ?`).bind(key)
    .first<AdminStatusRequestRow>();
  if (requestIdentity && (requestIdentity.article_id !== id ||
      requestIdentity.action !== action ||
      Boolean(requestIdentity.post_to_bluesky) !== requestedBluesky ||
      Boolean(requestIdentity.post_to_facebook) !== requestedFacebook)) {
    throw new HttpError(409, 'idempotency_key_conflict');
  }

  const event = await db.prepare(`SELECT article_id, event_type, from_status, to_status, revision
    FROM media_article_events WHERE event_key = ?`).bind(`admin:${key}`)
    .first<AdminStatusEventRow>();
  if (!requestIdentity && !event) return null;
  if (!event) throw new HttpError(409, 'publication_state_conflict');
  if (event.article_id !== id || event.event_type !== transitions[action].event) {
    throw new HttpError(409, 'idempotency_key_conflict');
  }

  const blueskyPublication = await db.prepare(`SELECT id, article_id, publication_reason, status
    FROM media_bluesky_publications WHERE publication_key = ?`).bind(`admin-request:${key}`)
    .first<AdminBlueskyPublicationRow>();
  const facebookPublication = await db.prepare(`SELECT id, article_id, publication_reason, status
    FROM media_facebook_publications WHERE publication_key = ?`).bind(`admin-request:${key}`)
    .first<AdminFacebookPublicationRow>();
  if (!requestIdentity && (requestedBluesky !== Boolean(blueskyPublication) || requestedFacebook)) {
    // Events created before the durable request-identity table remain replayable.
    throw new HttpError(409, 'idempotency_key_conflict');
  }
  const expectedReason = manualPublicationReason(action, event.from_status);
  if (requestedBluesky !== Boolean(blueskyPublication) || (blueskyPublication &&
      (blueskyPublication.article_id !== id || blueskyPublication.publication_reason !== expectedReason)) ||
      requestedFacebook !== Boolean(facebookPublication) || (facebookPublication &&
      (facebookPublication.article_id !== id || facebookPublication.publication_reason !== expectedReason))) {
    throw new HttpError(409, 'publication_state_conflict');
  }
  return { event,
    blueskyPublication: blueskyPublication
      ? { id: blueskyPublication.id, status: blueskyPublication.status } : null,
    facebookPublication: facebookPublication
      ? { id: facebookPublication.id, status: facebookPublication.status } : null };
}

async function statusMutationResponse(env: MediaAdminEnv, id: number, receipt: NonNullable<
  Awaited<ReturnType<typeof statusMutationReceipt>>>, replayed: boolean): Promise<Response> {
  await reconcileHomepageLatestSix(env.MEDIA_DB);
  if (receipt.blueskyPublication) {
    try { await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed', article_id: id })); }
  }
  if (receipt.facebookPublication) {
    try { await env.MEDIA_FACEBOOK_QUEUE.send({ type: 'facebook_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'facebook_wakeup_failed', article_id: id })); }
  }
  return json({ article: { id, status: receipt.event.to_status, revision: receipt.event.revision },
    bluesky_publication: receipt.blueskyPublication,
    facebook_publication: receipt.facebookPublication, replayed });
}

type BulkRequestRow = { article_ids_json: string; post_to_bluesky: number; post_to_facebook: number };
type BulkTargetRow = { id: number; status: Status; og_image_url: string | null;
  image_policy: string; source_image_policy: string; title: string; publisher: string;
  canonical_url: string };
type DirectTargetRow = BulkTargetRow & {
  bluesky_has_in_progress: number; bluesky_post_count: number;
  facebook_has_in_progress: number; facebook_has_unknown_remote_state: number;
  facebook_post_count: number;
};
type DirectRequestRow = { request_kind: 'single' | 'bulk'; article_ids_json: string;
  post_to_bluesky: number; post_to_facebook: number };
type DirectPublicationRow = { id: number; article_id: number; status: string;
  publication_reason: 'manual_post' | 'manual_repost' };
async function bulkApprove(request: Request, env: MediaAdminEnv): Promise<Response> {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const parsed = BulkApproveBody.safeParse(await boundedOptionalJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_bulk_approve_body');
  const ids = [...parsed.data.article_ids].sort((left, right) => left - right);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'duplicate_article_id');
  const requestedBluesky = parsed.data.post_to_bluesky === true;
  const requestedFacebook = parsed.data.post_to_facebook === true;
  const idsJson = JSON.stringify(ids);
  const existing = await env.MEDIA_DB.prepare(`SELECT article_ids_json, post_to_bluesky,
    post_to_facebook
    FROM media_admin_bulk_status_requests WHERE request_key = ?`).bind(key).first<BulkRequestRow>();
  if (existing && (existing.article_ids_json !== idsJson ||
      Boolean(existing.post_to_bluesky) !== requestedBluesky ||
      Boolean(existing.post_to_facebook) !== requestedFacebook)) {
    throw new HttpError(409, 'idempotency_key_conflict');
  }

  if (!existing) {
    const placeholders = ids.map(() => '?').join(', ');
    const { results } = await env.MEDIA_DB.prepare(`SELECT a.id, a.status, a.og_image_url,
      a.image_policy, s.image_policy AS source_image_policy, a.title, a.publisher, a.canonical_url
      FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
      WHERE a.id IN (${placeholders}) ORDER BY a.id`).bind(...ids).all<BulkTargetRow>();
    const byId = new Map(results.map(row => [row.id, row]));
    const failures = ids.flatMap(id => {
      const row = byId.get(id);
      if (!row) return [{ article_id: id, error: 'article_not_found' }];
      if (!['pending', 'rejected', 'hidden'].includes(row.status)) {
        return [{ article_id: id, error: 'invalid_state_transition' }];
      }
      if (requestedBluesky && (!row.og_image_url || row.image_policy !== 'remote_preview' ||
          row.source_image_policy !== 'remote_preview')) {
        return [{ article_id: id, error: 'thumbnail_missing' }];
      }
      return [];
    });
    if (failures.length) return json({ error: 'bulk_approval_ineligible', failures }, 409);
    if (requestedFacebook) await requireFacebookEligibility(env.MEDIA_DB, results);

    const now = new Date().toISOString();
    const eligibleImages = requestedBluesky
      ? `AND a.og_image_url IS NOT NULL AND a.image_policy = 'remote_preview'
         AND s.image_policy = 'remote_preview'` : '';
    const statements: D1PreparedStatement[] = [env.MEDIA_DB.prepare(`
      INSERT INTO media_admin_bulk_status_requests
        (request_key, article_ids_json, post_to_bluesky, post_to_facebook, created_at)
      SELECT ?, ?, ?, ?, ?
      WHERE (SELECT count(*) FROM media_articles a
        JOIN media_sources s ON s.source_key = a.source_key
        WHERE a.id IN (${placeholders}) AND a.status IN ('pending', 'rejected', 'hidden')
        ${eligibleImages}) = ?
      ON CONFLICT(request_key) DO NOTHING`)
      .bind(key, idsJson, Number(requestedBluesky), Number(requestedFacebook), now, ...ids, ids.length),
    env.MEDIA_DB.prepare(`UPDATE media_articles SET status = 'approved',
      mutation_key = 'admin-bulk:' || ? || ':' || id, revision = revision + 1,
      updated_at = ?, approval_method = 'manual', approval_author_rule_key = NULL,
      approved_at = ?, hidden_at = NULL
      WHERE id IN (${placeholders}) AND status IN ('pending', 'rejected', 'hidden')
        AND EXISTS (SELECT 1 FROM media_admin_bulk_status_requests
          WHERE request_key = ? AND article_ids_json = ? AND post_to_bluesky = ?
            AND post_to_facebook = ?)`)
      .bind(key, now, now, ...ids, key, idsJson, Number(requestedBluesky),
        Number(requestedFacebook))];
    if (requestedBluesky) {
      statements.push(env.MEDIA_DB.prepare(`INSERT INTO media_bluesky_publications
        (article_id, approval_event_id, publication_key, publication_reason, status,
         created_at, updated_at)
        SELECT e.article_id, NULL, 'admin-bulk-request:' || ? || ':' || e.article_id,
          CASE e.from_status WHEN 'pending' THEN 'pending_approved'
            WHEN 'rejected' THEN 'rejected_repost' ELSE 'unhidden_repost' END,
          'queued', ?, ? FROM media_article_events e
        WHERE e.event_key = 'admin-bulk:' || ? || ':' || e.article_id
          AND e.article_id IN (${placeholders}) AND e.to_status = 'approved'
        ON CONFLICT(publication_key) DO NOTHING`)
        .bind(key, now, now, key, ...ids));
    }
    if (requestedFacebook) {
      statements.push(env.MEDIA_DB.prepare(`INSERT INTO media_facebook_publications
        (article_id, approval_event_id, publication_key, publication_reason, status,
         created_at, updated_at)
        SELECT e.article_id, NULL, 'admin-bulk-request:' || ? || ':' || e.article_id,
          CASE e.from_status WHEN 'pending' THEN 'pending_approved'
            WHEN 'rejected' THEN 'rejected_repost' ELSE 'unhidden_repost' END,
          'queued', ?, ? FROM media_article_events e
        WHERE e.event_key = 'admin-bulk:' || ? || ':' || e.article_id
          AND e.article_id IN (${placeholders}) AND e.to_status = 'approved'
        ON CONFLICT(publication_key) DO NOTHING`).bind(key, now, now, key, ...ids));
    }
    await env.MEDIA_DB.batch(statements);
  }

  const receipt = await env.MEDIA_DB.prepare(`SELECT article_ids_json, post_to_bluesky,
    post_to_facebook
    FROM media_admin_bulk_status_requests WHERE request_key = ?`).bind(key).first<BulkRequestRow>();
  if (!receipt) throw new HttpError(409, 'bulk_approval_state_conflict');
  if (receipt.article_ids_json !== idsJson ||
      Boolean(receipt.post_to_bluesky) !== requestedBluesky ||
      Boolean(receipt.post_to_facebook) !== requestedFacebook) {
    throw new HttpError(409, 'idempotency_key_conflict');
  }
  const eventPrefix = `admin-bulk:${key}:`;
  const { results: articles } = await env.MEDIA_DB.prepare(`SELECT article_id AS id,
    to_status AS status, revision FROM media_article_events
    WHERE event_key GLOB ? ORDER BY article_id`).bind(`${eventPrefix}*`).all();
  if (articles.length !== ids.length) throw new HttpError(409, 'bulk_approval_state_conflict');
  const { results: publications } = requestedBluesky
    ? await env.MEDIA_DB.prepare(`SELECT id, article_id, status FROM media_bluesky_publications
        WHERE publication_key GLOB ? ORDER BY article_id`)
      .bind(`admin-bulk-request:${key}:*`).all()
    : { results: [] };
  if (requestedBluesky && publications.length !== ids.length) {
    throw new HttpError(409, 'bulk_approval_state_conflict');
  }
  const { results: facebookPublications } = requestedFacebook
    ? await env.MEDIA_DB.prepare(`SELECT id, article_id, status FROM media_facebook_publications
        WHERE publication_key GLOB ? ORDER BY article_id`)
      .bind(`admin-bulk-request:${key}:*`).all()
    : { results: [] };
  if (requestedFacebook && facebookPublications.length !== ids.length) {
    throw new HttpError(409, 'bulk_approval_state_conflict');
  }
  await reconcileHomepageLatestSix(env.MEDIA_DB);
  if (publications.length) {
    try { await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed', request_key: key })); }
  }
  if (facebookPublications.length) {
    try { await env.MEDIA_FACEBOOK_QUEUE.send({ type: 'facebook_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'facebook_wakeup_failed', request_key: key })); }
  }
  return json({ articles, bluesky_publications: publications,
    facebook_publications: facebookPublications, replayed: Boolean(existing) });
}

function directPublicationKey(key: string, platform: 'bluesky' | 'facebook', id: number): string {
  return `admin-direct:${key}:${platform}:${id}`;
}

async function directPublishReceipt(db: D1Database, key: string, kind: 'single' | 'bulk',
  ids: number[], bluesky: boolean, facebook: boolean): Promise<{
    bluesky: DirectPublicationRow[]; facebook: DirectPublicationRow[]
  } | null> {
  const identity = await db.prepare(`SELECT request_kind, article_ids_json,
    post_to_bluesky, post_to_facebook FROM media_admin_publish_requests WHERE request_key = ?`)
    .bind(key).first<DirectRequestRow>();
  if (!identity) return null;
  if (identity.request_kind !== kind || identity.article_ids_json !== JSON.stringify(ids) ||
      Boolean(identity.post_to_bluesky) !== bluesky || Boolean(identity.post_to_facebook) !== facebook) {
    throw new HttpError(409, 'idempotency_key_conflict');
  }
  const placeholders = ids.map(() => '?').join(', ');
  const read = async (platform: 'bluesky' | 'facebook'): Promise<DirectPublicationRow[]> => {
    const keys = ids.map(id => directPublicationKey(key, platform, id));
    const { results } = await db.prepare(`SELECT id, article_id, status, publication_reason
      FROM media_${platform}_publications WHERE publication_key IN (${placeholders})
      ORDER BY article_id`).bind(...keys).all<DirectPublicationRow>();
    if (results.length !== ids.length || results.some((row, index) => row.article_id !== ids[index] ||
        !['manual_post', 'manual_repost'].includes(row.publication_reason))) {
      throw new HttpError(409, 'direct_publish_state_conflict');
    }
    return results;
  };
  return { bluesky: bluesky ? await read('bluesky') : [],
    facebook: facebook ? await read('facebook') : [] };
}

async function directPublishResponse(env: MediaAdminEnv, key: string,
  kind: 'single' | 'bulk', ids: number[], receipt: NonNullable<
    Awaited<ReturnType<typeof directPublishReceipt>>>, replayed: boolean): Promise<Response> {
  if (receipt.bluesky.length) {
    try { await env.MEDIA_BLUESKY_QUEUE.send({ type: 'bluesky_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'bluesky_wakeup_failed', request_key: key })); }
  }
  if (receipt.facebook.length) {
    try { await env.MEDIA_FACEBOOK_QUEUE.send({ type: 'facebook_wakeup' }); }
    catch { console.error(JSON.stringify({ event: 'facebook_wakeup_failed', request_key: key })); }
  }
  if (kind === 'single') return json({ article: { id: ids[0], status: 'approved' },
    bluesky_publication: receipt.bluesky[0] ?? null,
    facebook_publication: receipt.facebook[0] ?? null, replayed });
  return json({ articles: ids.map(id => ({ id, status: 'approved' })),
    bluesky_publications: receipt.bluesky, facebook_publications: receipt.facebook, replayed });
}

async function directPublish(request: Request, env: MediaAdminEnv,
  kind: 'single' | 'bulk', ids: number[], bluesky: boolean, facebook: boolean): Promise<Response> {
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
    throw new HttpError(400, 'idempotency_key_required');
  }
  const db = env.MEDIA_DB;
  const replay = await directPublishReceipt(db, key, kind, ids, bluesky, facebook);
  if (replay) return directPublishResponse(env, key, kind, ids, replay, true);
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT a.id, a.status, a.og_image_url,
    a.image_policy, s.image_policy AS source_image_policy, a.title, a.publisher, a.canonical_url,
    EXISTS (SELECT 1 FROM media_bluesky_publications p WHERE p.article_id = a.id
      AND p.status IN ('queued', 'posting')) AS bluesky_has_in_progress,
    (SELECT count(*) FROM media_bluesky_publications p WHERE p.article_id = a.id
      AND p.status = 'posted') AS bluesky_post_count,
    EXISTS (SELECT 1 FROM media_facebook_publications p WHERE p.article_id = a.id
      AND p.status IN ('queued', 'posting')) AS facebook_has_in_progress,
    EXISTS (SELECT 1 FROM media_facebook_publications p WHERE p.article_id = a.id
      AND p.status = 'unknown_remote_state') AS facebook_has_unknown_remote_state,
    (SELECT count(*) FROM media_facebook_publications p WHERE p.article_id = a.id
      AND p.status = 'posted') AS facebook_post_count
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id IN (${placeholders}) ORDER BY a.id`).bind(...ids).all<DirectTargetRow>();
  const byId = new Map(results.map(row => [row.id, row]));
  const facebookCheck = facebook ? await facebookEligibility(db, results)
    : { template: null, failures: [] };
  const facebookErrors = new Map(facebookCheck.failures.map(failure =>
    [failure.article_id, failure.error]));
  const failures: Array<{ article_id: number; platform: 'bluesky' | 'facebook' | null;
    error: string }> = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { failures.push({ article_id: id, platform: null, error: 'article_not_found' }); continue; }
    if (bluesky) {
      const eligibleImage = Boolean(row.og_image_url) && row.image_policy === 'remote_preview' &&
        row.source_image_policy === 'remote_preview';
      const state = directPublishState('bluesky', row.status, {
        hasInProgress: Boolean(row.bluesky_has_in_progress), hasUnknownRemoteState: false,
        postCount: row.bluesky_post_count,
      }, eligibleImage ? null : 'thumbnail_missing');
      if (!state.direct_publish_available) failures.push({ article_id: id, platform: 'bluesky',
        error: state.direct_publish_unavailable_reason! });
    }
    if (facebook) {
      const state = directPublishState('facebook', row.status, {
        hasInProgress: Boolean(row.facebook_has_in_progress),
        hasUnknownRemoteState: Boolean(row.facebook_has_unknown_remote_state),
        postCount: row.facebook_post_count,
      }, facebookErrors.get(id) ?? null);
      if (!state.direct_publish_available) failures.push({ article_id: id, platform: 'facebook',
        error: state.direct_publish_unavailable_reason! });
    }
  }
  if (failures.length) {
    const racedReplay = await directPublishReceipt(db, key, kind, ids, bluesky, facebook);
    if (racedReplay) return directPublishResponse(env, key, kind, ids, racedReplay, true);
    const first = failures[0]!;
    if (kind === 'single') throw new HttpError(first.error === 'article_not_found' ? 404 : 409,
      first.error);
    return json({ error: 'bulk_publish_ineligible', failures }, 409);
  }

  const guard: string[] = [`(SELECT count(*) FROM media_articles
    WHERE id IN (${placeholders}) AND status = 'approved') = ?`];
  const guardBindings: unknown[] = [...ids, ids.length];
  if (bluesky) {
    guard.push(`NOT EXISTS (SELECT 1 FROM media_articles a JOIN media_sources s
      ON s.source_key = a.source_key WHERE a.id IN (${placeholders})
      AND (a.og_image_url IS NULL OR a.image_policy <> 'remote_preview'
        OR s.image_policy <> 'remote_preview'))`);
    guardBindings.push(...ids);
    guard.push(`NOT EXISTS (SELECT 1 FROM media_bluesky_publications p
      WHERE p.article_id IN (${placeholders}) AND p.status IN ('queued', 'posting'))`);
    guardBindings.push(...ids);
  }
  if (facebook) {
    guard.push(`EXISTS (SELECT 1 FROM media_facebook_settings WHERE id = 1
      AND publishing_enabled = 1 AND default_message_template = ?)`);
    guardBindings.push(facebookCheck.template);
    guard.push(`NOT EXISTS (SELECT 1 FROM media_facebook_publications p
      WHERE p.article_id IN (${placeholders})
        AND p.status IN ('queued', 'posting', 'unknown_remote_state'))`);
    guardBindings.push(...ids);
  }
  const idsJson = JSON.stringify(ids);
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO media_admin_publish_requests
    (request_key, request_kind, article_ids_json, post_to_bluesky, post_to_facebook, created_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.join(' AND ')}
    ON CONFLICT(request_key) DO NOTHING`).bind(key, kind, idsJson, Number(bluesky),
      Number(facebook), now, ...guardBindings)];
  const appendPublication = (platform: 'bluesky' | 'facebook'): void => {
    statements.push(db.prepare(`INSERT INTO media_${platform}_publications
      (article_id, approval_event_id, publication_key, publication_reason, status,
       created_at, updated_at)
      SELECT a.id, NULL, 'admin-direct:' || ? || ':${platform}:' || a.id,
        CASE WHEN EXISTS (SELECT 1 FROM media_${platform}_publications prior
          WHERE prior.article_id = a.id AND prior.status = 'posted')
          THEN 'manual_repost' ELSE 'manual_post' END,
        'queued', ?, ? FROM media_articles a
      JOIN media_admin_publish_requests r ON r.request_key = ?
        AND r.request_kind = ? AND r.article_ids_json = ?
        AND r.post_to_bluesky = ? AND r.post_to_facebook = ?
      WHERE a.id IN (${placeholders}) AND a.status = 'approved'
      ORDER BY a.id ON CONFLICT(publication_key) DO NOTHING`)
      .bind(key, now, now, key, kind, idsJson, Number(bluesky), Number(facebook), ...ids));
  };
  if (bluesky) appendPublication('bluesky');
  if (facebook) appendPublication('facebook');
  const batchResults = await db.batch(statements);
  const receipt = await directPublishReceipt(db, key, kind, ids, bluesky, facebook);
  if (!receipt) throw new HttpError(409, 'direct_publish_state_conflict');
  return directPublishResponse(env, key, kind, ids, receipt,
    Number(batchResults[0]?.meta.changes ?? 0) === 0);
}

async function publishSingle(request: Request, env: MediaAdminEnv, id: number): Promise<Response> {
  const parsed = DirectPublishBody.safeParse(await boundedOptionalJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_publish_body');
  return directPublish(request, env, 'single', [id], parsed.data.post_to_bluesky === true,
    parsed.data.post_to_facebook === true);
}

async function publishBulk(request: Request, env: MediaAdminEnv): Promise<Response> {
  const parsed = BulkDirectPublishBody.safeParse(await boundedOptionalJson(request));
  if (!parsed.success) throw new HttpError(400, 'invalid_bulk_publish_body');
  const ids = [...parsed.data.article_ids].sort((left, right) => left - right);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'duplicate_article_id');
  return directPublish(request, env, 'bulk', ids, parsed.data.post_to_bluesky === true,
    parsed.data.post_to_facebook === true);
}

async function mutate(request: Request, env: MediaAdminEnv, id: number, action: Action): Promise<Response> {
  const db = env.MEDIA_DB;
  const key = request.headers.get('Idempotency-Key');
  if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new HttpError(400, 'idempotency_key_required');
  const eventKey = `admin:${key}`;
  const transition = transitions[action];
  const parsedBody = StatusMutationBody.safeParse(await boundedOptionalJson(request));
  if (!parsedBody.success) throw new HttpError(400, 'invalid_status_mutation_body');
  const requestedBluesky = parsedBody.data.post_to_bluesky === true;
  const requestedFacebook = parsedBody.data.post_to_facebook === true;
  const replay = await statusMutationReceipt(db, key, id, action,
    requestedBluesky, requestedFacebook);
  if (replay) return statusMutationResponse(env, id, replay, true);
  const before = await db.prepare(`SELECT status, og_image_url, image_policy,
    title, publisher, canonical_url,
    (SELECT image_policy FROM media_sources WHERE source_key = a.source_key) AS source_image_policy
    FROM media_articles a WHERE id = ?`).bind(id).first<{
      status: Status; og_image_url: string | null; image_policy: string; source_image_policy: string;
      title: string; publisher: string; canonical_url: string }>();
  if (!before) {
    const racedReplay = await statusMutationReceipt(db, key, id, action,
      requestedBluesky, requestedFacebook);
    if (racedReplay) return statusMutationResponse(env, id, racedReplay, true);
    throw new HttpError(404, 'article_not_found');
  }
  const manualReason = manualPublicationReason(action, before.status);
  if ((requestedBluesky || requestedFacebook) && !manualReason) {
    const racedReplay = await statusMutationReceipt(db, key, id, action,
      requestedBluesky, requestedFacebook);
    if (racedReplay) return statusMutationResponse(env, id, racedReplay, true);
    throw new HttpError(400, requestedBluesky
      ? 'post_to_bluesky_not_available' : 'post_to_facebook_not_available');
  }
  if (requestedBluesky && (!before.og_image_url || before.image_policy !== 'remote_preview' ||
      before.source_image_policy !== 'remote_preview')) {
    const racedReplay = await statusMutationReceipt(db, key, id, action,
      requestedBluesky, requestedFacebook);
    if (racedReplay) return statusMutationResponse(env, id, racedReplay, true);
    throw new HttpError(409, 'thumbnail_missing');
  }
  if (requestedFacebook) await requireFacebookEligibility(db, [before]);
  const now = new Date().toISOString();
  const placeholders = transition.from.map(() => '?').join(', ');
  // D1 batch is transactional. The durable full request identity owns the key;
  // every later statement is conditional on that exact identity.
  const statements = [db.prepare(`INSERT INTO media_admin_status_requests
      (request_key, article_id, action, post_to_bluesky, post_to_facebook, created_at)
    SELECT ?, ?, ?, ?, ?, ? FROM media_articles
    WHERE id = ? AND status IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM media_article_events WHERE event_key = ?)
    ON CONFLICT(request_key) DO NOTHING`)
    .bind(key, id, action, Number(requestedBluesky), Number(requestedFacebook), now,
      id, ...transition.from, eventKey),
  db.prepare(`UPDATE media_articles SET status = ?, mutation_key = ?,
    revision = revision + 1, updated_at = ?,
    approval_method = CASE WHEN ? IN ('approve', 'unhide') THEN 'manual' ELSE approval_method END,
    approval_author_rule_key = CASE WHEN ? IN ('approve', 'unhide') THEN NULL ELSE approval_author_rule_key END,
    approved_at = CASE WHEN ? IN ('approve', 'unhide') THEN ? ELSE approved_at END,
    rejected_at = CASE WHEN ? = 'reject' THEN ? ELSE rejected_at END,
    hidden_at = CASE WHEN ? = 'hide' THEN ? WHEN ? = 'unhide' THEN NULL ELSE hidden_at END
    WHERE id = ? AND status IN (${placeholders})
      AND EXISTS (SELECT 1 FROM media_admin_status_requests
        WHERE request_key = ? AND article_id = ? AND action = ? AND post_to_bluesky = ?
          AND post_to_facebook = ?)
      AND NOT EXISTS (SELECT 1 FROM media_article_events WHERE event_key = ?)
    `).bind(transition.to, eventKey, now,
      action, action, action, now, action, now, action, now, action, id,
      ...transition.from, key, id, action, Number(requestedBluesky),
      Number(requestedFacebook), eventKey)];
  if (requestedBluesky && manualReason) {
    statements.push(db.prepare(`INSERT INTO media_bluesky_publications
        (article_id, approval_event_id, publication_key, publication_reason, status, created_at, updated_at)
        SELECT e.article_id, NULL, ?, ?, 'queued', ?, ?
        FROM media_article_events e JOIN media_admin_status_requests r
          ON r.request_key = ? AND r.article_id = e.article_id
          AND r.action = ? AND r.post_to_bluesky = 1
        WHERE e.event_key = ? AND e.article_id = ? AND e.event_type = ?
          AND e.from_status = ? AND e.to_status = 'approved'
        ON CONFLICT(publication_key) DO NOTHING`)
      .bind(`admin-request:${key}`, manualReason, now, now, key, action,
        eventKey, id, transition.event, before.status));
  }
  if (requestedFacebook && manualReason) {
    statements.push(db.prepare(`INSERT INTO media_facebook_publications
        (article_id, approval_event_id, publication_key, publication_reason, status, created_at, updated_at)
        SELECT e.article_id, NULL, ?, ?, 'queued', ?, ?
        FROM media_article_events e JOIN media_admin_status_requests r
          ON r.request_key = ? AND r.article_id = e.article_id
          AND r.action = ? AND r.post_to_facebook = 1
        WHERE e.event_key = ? AND e.article_id = ? AND e.event_type = ?
          AND e.from_status = ? AND e.to_status = 'approved'
        ON CONFLICT(publication_key) DO NOTHING`)
      .bind(`admin-request:${key}`, manualReason, now, now, key, action,
        eventKey, id, transition.event, before.status));
  }
  const results = await db.batch(statements);
  const changed = Number(results[1]?.meta.changes ?? 0) > 0;
  const receipt = await statusMutationReceipt(db, key, id, action,
    requestedBluesky, requestedFacebook);
  if (receipt) return statusMutationResponse(env, id, receipt, !changed);
  const exists = await db.prepare('SELECT id FROM media_articles WHERE id = ?').bind(id).first();
  throw new HttpError(exists ? 409 : 404, exists ? 'invalid_state_transition' : 'article_not_found');
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      // MEDIA_SYNC_TOKEN is reserved for future read-only sync routes; never accepted here.
      if (!await bearerMatches(request, env.MEDIA_ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
      const url = new URL(request.url);
      if (url.pathname === '/admin/bluesky/settings') return await blueskySettings(request, env);
      if (url.pathname === '/admin/facebook/settings') return await facebookSettings(request, env);
      if (url.pathname === '/admin/facebook/connection-check') {
        return await facebookConnectionCheck(request, env);
      }
      const editorialResponse = await handleEditorialDashboard(request, env, url);
      if (editorialResponse) return editorialResponse;
      if (url.pathname === '/admin/articles/bulk/approve') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        return await bulkApprove(request, env);
      }
      if (url.pathname === '/admin/articles/bulk/publish') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        return await publishBulk(request, env);
      }
      const directPublishMatch = /^\/admin\/articles\/([1-9]\d*)\/publish$/.exec(url.pathname);
      if (directPublishMatch) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(directPublishMatch[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await publishSingle(request, env, id);
      }
      const bulkImageRefresh = /^\/admin\/guardian-image-refresh\/(preview|apply)$/.exec(url.pathname);
      if (bulkImageRefresh) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        return bulkImageRefresh[1] === 'preview'
          ? await previewBulkGuardianImageRefresh(env.MEDIA_DB)
          : await applyBulkGuardianImageRefresh(request, env.MEDIA_DB);
      }
      const imageRefresh = /^\/admin\/articles\/([1-9]\d*)\/guardian-image-refresh\/(preview|apply)$/.exec(url.pathname);
      if (imageRefresh) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(imageRefresh[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return imageRefresh[2] === 'preview'
          ? await previewGuardianImageRefresh(request, env.MEDIA_DB, id)
          : await applyGuardianImageRefresh(request, env.MEDIA_DB, id);
      }
      const titleDecision = /^\/admin\/articles\/([1-9]\d*)\/display-title\/(accept-ai|reject-ai)$/.exec(url.pathname);
      if (titleDecision) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(titleDecision[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await decideAiTitle(env.MEDIA_DB, id,
          titleDecision[2] === 'accept-ai' ? 'accept' : 'reject');
      }
      const titleGeneration = /^\/admin\/articles\/([1-9]\d*)\/display-title\/generate-ai$/.exec(url.pathname);
      if (titleGeneration) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(titleGeneration[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await generateExplicitAiTitle(request, env, id);
      }
      const titleEdit = /^\/admin\/articles\/([1-9]\d*)\/display-title$/.exec(url.pathname);
      if (titleEdit) {
        if (request.method !== 'PUT') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(titleEdit[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await setHumanDisplayTitle(request, env.MEDIA_DB, id);
      }
      if (url.pathname === '/admin/ai-usage') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        return await aiUsage(env, boundedLimit(url));
      }
      const match = /^\/admin\/articles\/([1-9]\d*)\/(approve|reject|hide|unhide)$/.exec(url.pathname);
      if (match) {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) throw new HttpError(400, 'invalid_article_id');
        return await mutate(request, env, id, match[2] as Action);
      }
      if (!['/admin/articles', '/admin/sources', '/admin/runs', '/admin/runs/gdelt'].includes(url.pathname)) {
        return json({ error: 'not_found' }, 404);
      }
      if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      const limit = boundedLimit(url);
      if (url.pathname === '/admin/articles') {
        const status = url.searchParams.get('status');
        if (status !== null && !ArticleStatus.safeParse(status).success) throw new HttpError(400, 'invalid_status');
        const statement = env.MEDIA_DB.prepare(`SELECT * FROM media_articles
          ${status ? 'WHERE status = ?' : ''} ORDER BY ${status ? 'feed_sort_at DESC' : 'updated_at DESC'}, id DESC LIMIT ?`);
        const { results } = await (status ? statement.bind(status, limit) : statement.bind(limit)).all();
        return json({ articles: results });
      }
      if (url.pathname === '/admin/sources') {
        const { results } = await env.MEDIA_DB.prepare(`SELECT * FROM media_sources
          WHERE retired_at IS NULL ORDER BY source_key LIMIT ?`).bind(limit).all();
        return json({ sources: results });
      }
      if (url.pathname === '/admin/runs/gdelt') {
        const { results } = await env.MEDIA_DB.prepare(
          'SELECT * FROM media_gdelt_runs ORDER BY started_at DESC, id DESC LIMIT ?',
        ).bind(limit).all();
        return json({ runs: results });
      }
      const { results } = await env.MEDIA_DB.prepare(
        'SELECT * FROM media_discovery_runs ORDER BY started_at DESC, id DESC LIMIT ?',
      ).bind(limit).all();
      return json({ runs: results });
    } catch (error) { return httpFailure(error); }
  },
} satisfies ExportedHandler<MediaAdminEnv>;
