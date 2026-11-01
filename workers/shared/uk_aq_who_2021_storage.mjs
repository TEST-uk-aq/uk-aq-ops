// WHO output identity is independent of observation-history generation.
export function resolveWho2021Prefix(env = {}) {
  const raw = env.UK_AQ_WHO_2021_R2_PREFIX;
  if (typeof raw !== "string" || !raw || raw !== raw.trim()
      || !/^(?:[a-z0-9][a-z0-9_-]*\/)*who_2021\/?$/.test(raw)) {
    throw new Error("UK_AQ_WHO_2021_R2_PREFIX must be an explicit safe directory ending in who_2021");
  }
  return raw.replace(/\/$/, "") + "/";
}
export const whoLatestKey = (prefix) => prefix + "latest_who_2021.json";
