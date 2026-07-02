const HOUR_MS = 60 * 60 * 1000;

export function groupFingerprintRechecksByHour(initialMismatches) {
  const groupsByHour = new Map();

  for (const mismatch of initialMismatches) {
    const hourStart = new Date(mismatch.hour_start);
    if (Number.isNaN(hourStart.getTime())) {
      throw new Error(`Invalid mismatch hour_start: ${mismatch.hour_start}`);
    }

    const windowStart = hourStart.toISOString();
    const existing = groupsByHour.get(windowStart);
    if (existing) {
      existing.mismatches.push(mismatch);
      continue;
    }

    groupsByHour.set(windowStart, {
      window_start: windowStart,
      window_end: new Date(hourStart.getTime() + HOUR_MS).toISOString(),
      mismatches: [mismatch],
    });
  }

  return [...groupsByHour.values()].sort(
    (left, right) => left.window_start.localeCompare(right.window_start),
  );
}
