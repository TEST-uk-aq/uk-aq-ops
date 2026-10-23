// Structural identity only. A historical label never grants runtime authority.
// Deployment selects one explicit canonical name; targets/repositories cannot
// infer it, and neither TEST nor any other environment receives a default.
export const isEnvironmentName = value => typeof value === 'string'
  && /^[A-Z][A-Z0-9_]{0,31}$/.test(value);
export function configuredEnvironment(env = process.env) {
  if (!isEnvironmentName(env.UK_AQ_ENV_NAME)) throw Object.assign(
    new TypeError('Explicit canonical UK_AQ_ENV_NAME required'), { code: 'unapproved_environment' });
  return env.UK_AQ_ENV_NAME;
}
