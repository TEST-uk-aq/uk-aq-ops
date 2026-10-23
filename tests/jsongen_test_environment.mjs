// Explicit synthetic process configuration before static schema imports. Never
// selects an operational target or supplies operation-specific credentials.
process.env.UK_AQ_ENV_NAME = 'TEST';
process.env.UK_AQ_GITHUB_REPO = 'fixture-org/fixture-ops';
process.env.UK_AQ_JSONGEN_R2_BUCKET = 'fixture-derived-bucket';
process.env.UK_AQ_JSONGEN_R2_ENDPOINT = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`;
