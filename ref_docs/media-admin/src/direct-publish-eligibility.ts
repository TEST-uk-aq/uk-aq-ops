import { HttpError, renderFacebookPost, type Status } from '@uk-aq-media/core';

type FacebookArticle = { id?: number; title: string; publisher: string; canonical_url: string };
type FacebookSettings = { publishing_enabled: number; default_message_template: string };

export type FacebookEligibilityFailure = { article_id: number | null; error: string };

export async function facebookEligibility(db: D1Database,
  articles: FacebookArticle[]): Promise<{ template: string | null; failures: FacebookEligibilityFailure[] }> {
  const settings = await db.prepare(`SELECT publishing_enabled, default_message_template
    FROM media_facebook_settings WHERE id = 1`).first<FacebookSettings>();
  const unavailable = !settings ? 'facebook_settings_missing'
    : !settings.publishing_enabled ? 'facebook_publishing_disabled' : null;
  if (unavailable) return { template: null,
    failures: articles.map(article => ({ article_id: article.id ?? null, error: unavailable })) };
  const failures: FacebookEligibilityFailure[] = [];
  for (const article of articles) {
    try { renderFacebookPost({ ...article, template: settings!.default_message_template }); }
    catch (error) { failures.push({ article_id: article.id ?? null,
      error: error instanceof Error ? error.message : 'facebook_render_invalid' }); }
  }
  return { template: settings!.default_message_template, failures };
}

export async function requireFacebookEligibility(db: D1Database,
  articles: FacebookArticle[]): Promise<void> {
  const result = await facebookEligibility(db, articles);
  if (result.failures[0]) throw new HttpError(409, result.failures[0].error);
}

export type DirectPublishState = {
  direct_publish_available: boolean;
  direct_publish_reason: 'manual_post' | 'manual_repost' | null;
  direct_publish_unavailable_reason: string | null;
};

export type DirectPublicationHistory = {
  hasInProgress: boolean;
  hasUnknownRemoteState: boolean;
  postCount: number;
};

export function directPublishState(platform: 'bluesky' | 'facebook', status: Status,
  history: DirectPublicationHistory, platformError: string | null): DirectPublishState {
  let unavailable: string | null = null;
  if (status !== 'approved') unavailable = 'article_not_approved';
  else if (platform === 'facebook' && history.hasUnknownRemoteState) {
    unavailable = 'unknown_remote_state';
  } else if (history.hasInProgress) {
    unavailable = 'publication_in_progress';
  } else unavailable = platformError;
  return { direct_publish_available: unavailable === null,
    direct_publish_reason: unavailable === null
      ? (history.postCount > 0 ? 'manual_repost' : 'manual_post') : null,
    direct_publish_unavailable_reason: unavailable };
}
