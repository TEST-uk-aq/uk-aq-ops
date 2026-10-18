// Shared manual TEST admission. Repository identity comes only from the sourced
// environment; GitHub runtime metadata can verify it, never supply a fallback.
import { evidence } from './limits.mjs';

export function assertTestOpsEnvironment(env) {
  const repository = env.UK_AQ_GITHUB_REPO;
  const github = env.GITHUB_ACTIONS === 'true';
  evidence(env.UK_AQ_ENV_NAME === 'TEST' && typeof repository === 'string'
    && repository === repository.trim()
    && /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(repository)
    && (env.GITHUB_REPOSITORY === undefined ? !github : env.GITHUB_REPOSITORY === repository)
    && (!github || env.GITHUB_EVENT_NAME === 'workflow_dispatch'),
  'unapproved_environment', 'Manual TEST Ops environment and configured repository identity required');
}
