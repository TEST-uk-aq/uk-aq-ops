

We need to reduce R2 Class B/read operations caused by integrity repairs repeatedly rebuilding the full R2 history index.

Please make the following changes carefully.

Goal

Integrity backfills should still use the real existing backfill runner for the actual repair work, but they must not trigger the full R2 history index rebuild from uk_aq_backfill_local.sh.

Instead, uk_aq_integrity_backfill.sh should run one targeted R2 history index update at the end, scoped to the affected day range and connector where possible.

Files to inspect first

Please inspect the repo before changing anything, especially:

* scripts/uk_aq_backfill_local.sh
* scripts/uk_aq_integrity_backfill.sh
* scripts/backup_r2/uk_aq_build_r2_history_index.mjs
* any existing tests or scripts around R2 history index generation
* any docs or env examples that mention backfill or integrity backfill behaviour

Required change 1: allow uk_aq_backfill_local.sh to skip its full R2 history index rebuild

Add a new env var:

UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX

Behaviour:

* Default should be true, preserving current behaviour for normal/manual backfills.
* Accept normal boolean values using the script’s existing boolean parser style, for example true/false, 1/0, yes/no, on/off.
* If invalid, fail clearly before the backfill starts.
* If set to false, skip the final full R2 history index rebuild block completely.
* Log clearly whether the final full index rebuild is enabled or skipped.
* Update the usage/help text for uk_aq_backfill_local.sh.

Important:

* Do not change the default behaviour of uk_aq_backfill_local.sh.
* Normal manual backfills should still rebuild the full index unless the new env var explicitly disables it.

Required change 2: make uk_aq_integrity_backfill.sh call the real backfill runner with full rebuild disabled

In uk_aq_integrity_backfill.sh, before calling the nested real backfill runner, set:

export UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX="false"

This should ensure the inherited full rebuild in uk_aq_backfill_local.sh does not run during integrity repairs.

The integrity script should still set and pass the existing strict defaults:

UK_AQ_BACKFILL_RUN_MODE
UK_AQ_BACKFILL_OUTPUT_SCOPE
UK_AQ_BACKFILL_TRIGGER_MODE
UK_AQ_BACKFILL_DRY_RUN
UK_AQ_BACKFILL_FORCE_REPLACE
UK_AQ_BACKFILL_FROM_DAY_UTC
UK_AQ_BACKFILL_TO_DAY_UTC
UK_AQ_BACKFILL_CONNECTOR_IDS
UK_AQ_BACKFILL_TIMESERIES_IDS

Add log output showing:

full_r2_history_index_rebuild: disabled

or equivalent.

Required change 3: targeted R2 history index update at the end of uk_aq_integrity_backfill.sh

After the real backfill runner exits successfully, and only when --dry-run is not set, run a targeted R2 history index update.

It must be scoped by:

* --from-day ${FROM_DAY_UTC}
* --to-day ${TO_DAY_UTC}
* --connector-id ${CONNECTOR_ID} when a connector ID was provided

For --observs-only, the targeted update should update the observations part of the history index for the affected day range and connector where possible.

For --aqi-only, the targeted update should update the AQI levels part of the history index for the affected day range and connector where possible.

Please inspect how the existing R2 history index is structured before implementing this.

Preferred implementation:

1. Add targeted options to the existing script if this is clean:

node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
  --targeted \
  --from-day "${FROM_DAY_UTC}" \
  --to-day "${TO_DAY_UTC}" \
  --kind observations|aqilevels \
  ${CONNECTOR_ID:+--connector-id "${CONNECTOR_ID}"}

2. If the existing builder is not suitable for targeted updates, create a new script, for example:

scripts/backup_r2/uk_aq_update_r2_history_index_targeted.mjs

Then call that from uk_aq_integrity_backfill.sh.

Use whichever approach is least risky and avoids duplicating large amounts of existing index-building logic.

Failure behaviour

* If the actual backfill runner fails, do not run the targeted index update.
* If the targeted index update fails, the integrity backfill script should exit non-zero.
* If --dry-run is used, do not run the targeted index update. Log that it was skipped because this is a dry run.
* Preserve set -euo pipefail safety.
* Keep the existing recursion guard in uk_aq_integrity_backfill.sh.

Logging

Add clear logs around the targeted index update, including:

=== Targeted R2 History Index Update ===
from_day_utc: ...
to_day_utc: ...
connector_id: ... or all
kind: observations or aqilevels

The logs should make it obvious that integrity repair is not doing a full-history rebuild.

Backwards compatibility

Please preserve existing behaviour unless the new env var or integrity script path is involved.

Expected behaviours after this change:

1. Running uk_aq_backfill_local.sh normally still does the full index rebuild by default.
2. Running uk_aq_backfill_local.sh with UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX=false skips the full index rebuild.
3. Running uk_aq_integrity_backfill.sh --observs-only ... uses the real backfill runner, disables its full rebuild, then runs one targeted observations index update.
4. Running uk_aq_integrity_backfill.sh --aqi-only ... uses the real backfill runner, disables its full rebuild, then runs one targeted AQI index update.
5. Running uk_aq_integrity_backfill.sh --dry-run ... disables the full rebuild and skips the targeted index update.

Tests and validation

Please add or update tests if the repo already has a suitable test setup.

At minimum, add safe validation steps or documented commands showing how to verify:

* the default rebuild setting remains true for normal backfill
* UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX=false skips the full rebuild
* integrity backfill exports the skip flag before calling the real backfill runner
* integrity backfill runs the targeted index update only after successful non-dry-run backfills
* failed backfills do not run the targeted index update

Please also run shell syntax checks where appropriate, for example:

bash -n scripts/uk_aq_backfill_local.sh
bash -n scripts/uk_aq_integrity_backfill.sh

If there is an existing JS lint/test command for the R2 scripts, run that too.

Do not do

* Do not remove the full rebuild capability from uk_aq_backfill_local.sh.
* Do not make normal manual backfills skip rebuilding by default.
* Do not make integrity repairs run both the full rebuild and the targeted update.
* Do not point wrappers at archive paths.
* Do not weaken the existing environment safety checks.
* Do not change unrelated ingest, dashboard, or website code.

One small thing I would watch in the Codex output: make sure the “targeted update” really updates or rewrites only the affected index sections. If Codex just adds CLI flags but still scans all 513 days internally, that fixes the log wording but not the R2 usage.