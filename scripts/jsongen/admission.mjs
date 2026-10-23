// Repository identity comes only from explicit configuration; GitHub metadata
// verifies it and never supplies a fallback or operational authorisation.
import { isEnvironmentName } from './environment.mjs';
import { evidence } from './limits.mjs';

export function assertConfiguredIdentity(env) {
  const repository = env.UK_AQ_GITHUB_REPO;
  const github = env.GITHUB_ACTIONS === 'true';
  evidence(isEnvironmentName(env.UK_AQ_ENV_NAME) && typeof repository === 'string'
    && repository === repository.trim()
    && /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(repository)
    && (env.GITHUB_REPOSITORY === undefined ? !github : env.GITHUB_REPOSITORY === repository),
  'unapproved_environment', 'Explicit environment and configured repository identity required');
}
export function assertOpsEnvironment(env) {
  assertConfiguredIdentity(env);
  evidence(env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME === 'workflow_dispatch',
    'unapproved_environment', 'Manual workflow_dispatch required for consumer operations');
}
// Source-compatible name for earlier callers. It grants no environment default.
export const assertTestOpsEnvironment = assertOpsEnvironment;
