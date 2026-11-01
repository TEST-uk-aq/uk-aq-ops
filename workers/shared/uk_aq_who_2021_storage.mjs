// WHO output identity is independent of observation-history generation.
export function resolveWho2021Prefix(env = {}) {
  const raw = env.UK_AQ_WHO_2021_R2_PREFIX;
  if (typeof raw !== "string" || !raw || raw !== raw.trim()
      || !/^(?:[a-z0-9][a-z0-9_-]*\/)*who_2021\/?$/.test(raw)) {
    throw new Error("UK_AQ_WHO_2021_R2_PREFIX must be an explicit safe directory ending in who_2021");
  }
  return raw.replace(/\/$/, "") + "/";
}
export function whoRelativeKey(prefix, key) {
  if (resolveWho2021Prefix({UK_AQ_WHO_2021_R2_PREFIX: prefix}) !== prefix || !key.startsWith(prefix)) throw new Error("WHO key outside configured root");
  const relative = key.slice(prefix.length);
  const day = "[0-9]{4}-[0-9]{2}-[0-9]{2}";
  const partition = "connector_id=[1-9][0-9]*/pollutant_code=(?:pm25|pm10|no2)/part-[0-9]{5}\\.parquet";
  if (relative !== "latest_who_2021.json"
      && !new RegExp(`^summaries/as_of_day_utc=${day}/who_2021_summary\\.json$`).test(relative)
      && !new RegExp(`^daily_status/day_utc=${day}/${partition}$`).test(relative)
      && !new RegExp(`^rolling_year_status/as_of_day_utc=${day}/${partition}$`).test(relative)
      && !new RegExp(`^calendar_year_status/calendar_year=[0-9]{4}/period_type=complete_year/${partition}$`).test(relative)) throw new Error("Unclassified WHO object key: " + key);
  return relative;
}
export const whoLatestKey = (prefix) => prefix + "latest_who_2021.json";
