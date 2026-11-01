// Shared operation faults must escape every per-scope continuation boundary.
export function rethrowInvocationFault(error) {
  if (error.invocationFatal || [401, 403].includes(error.status)
    || /(?:invocation wall-time limit|Dropbox (?:read-command|source-byte) budget|source-object budget|decoded-row limit|output-byte limit|invocation physical-series limit)/i.test(error.message)
    || /Dropbox read failed \((?:authentication_or_permission|invalid_configuration|executable_start|syntax_or_usage|resource_limit|wall_time_limit|interrupted|local_stream_error)/.test(error.message)
    || ['ENOSPC', 'ENOMEM', 'EMFILE', 'EACCES', 'EPERM'].includes(error.code)) throw error;
}

export function failureReason(error) {
  if (/mismatch|changed during|failed their original identity/i.test(error.message)) return 'hash_or_identity_mismatch';
  if (/missing|not found|missing_object_or_path/i.test(error.message)) return 'required_source_missing';
  return 'authority_not_established';
}
