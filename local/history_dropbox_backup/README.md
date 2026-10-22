# One-off Mac R2 history backup

This optional package runs one explicitly initiated complete backup under macOS
launchd. It prepares TEST operational acceptance after merge and installation.
LIVE remains inactive until separately authorised. Use a stable checkout of the
merged TEST commit; do not move, update or switch it during an operation.

**Release prerequisite:** apply and verify the linked TEST ObsAQIDB schema change
before enabling this health-enabled package. See
[daily_task_health_dependency.md](daily_task_health_dependency.md) for the exact
RPC contract, linked PRs, migration and release order. This PR does not apply SQL,
install itself, alter schedules or start a backup.

## Canonical backup and global lock

The existing coordinator owns the PostgreSQL global operation lock with owner
`r2_history_dropbox_backup`. Each attempt has a distinct run ID containing the
same durable one-off operation UUID. The complete protected sequence remains:

```text
existing lock coordinator
 -> existing uk_aq_run_locked_history_backup.mjs --generation v3
    -> canonical pack publisher (automatically builds missing v3 packs)
    -> canonical hierarchical inventory
    -> canonical Dropbox sync, verification and checkpoint publication
```

Controls are `pack`, `--allow-experimental-pack-only`, explicit `full` Parquet
copying, `max-days-per-run=0`, and the existing configurable checkpoint batch/flush
controls. The packs-only proving option is never used. The shared generation
resolver selects all v3 prefixes, including generation-qualified binding packs
and Dropbox checkpoint state. No backup algorithm, transport, restore behaviour,
source repair, checkpoint deletion, pack cleanup, individual binding deletion or
core pruning is added. Existing observation stale-Parquet handling is preserved.

Lock acquisition is bounded at 60 seconds; existing same-session checks remain
at five seconds. Contention cannot bypass the lock. Lock loss stops protected
children and fails closed; no force recovery or SOS-specific recovery profile is
selected. The existing liveness-pipe child supervisor also wraps the coordinator,
so death of this local parent tears down the protected process tree.

## Daily Task Health lifecycle

The package reuses `workers/shared/daily_task_health.mjs` and the existing
`uk_aq_public` Started, Finished, Failed and recompute RPCs, with task key
`ops.r2_history_dropbox_backup_mbpro`, named **R2 history Dropbox backup (MacBook
Pro)** with platform `MBPro`. This separate active task is dashboard-visible, but
excluded from daily missing-task checks and email because each backup is optional
and explicitly initiated; it has no scheduled/due time. The scheduled GitHub task
`ops.r2_history_dropbox_backup`, its history, workflow, 345-minute timeout and
configuration are unchanged.
The established local Integrity reporting path uses the same RPCs and local
provenance, but did not provide this package's durable lost-response recovery.

A local run records `source_repo=uk-aq-ops`, the repository supervisor path as
`source_worker`, the real operation UUID as `platform_run_id`, and summary fields
`execution_source=macbook_pro_launchd`, `platform=MBPro`, environment and actual
launchd label/domain. Before initial reporting the supervisor verifies that the
registered job PID is its own. No GitHub run IDs, workflow names or URLs are
fabricated, and no credential/log-file paths are sent in the health summary.

Before any backup attempt, the supervisor atomically saves the operation UUID,
configuration fingerprint, original UTC start time/date and exact Started payload,
then sends that UUID through the explicit `p_run_id` RPC argument. The existing
`daily_task_runs.id` primary key supplies uniqueness; no extra identity column or
index is needed. Concurrent/repeated requests return that same UUID, including
after Finished/Failed, without reopening the run. Conflicting task/source/worker/
platform/date/start/explicit-attempt reuse is rejected. An unmigrated server must
reject the new argument before insertion. The saved run UUID is accepted only if
it equals the operation UUID, so a committed response/local-save loss is recovered
by exact replay. All automatic backup
attempts remain within this health run. Network/process interruption that remains
eligible for backup retry does not report terminal Failed.

After a zero locked exit and acceptance of the current invocation's reports,
`accepted.json` and local backup completion become durable first. A separate
Finished obligation contains immutable completion time, accepted report identity,
verified source/processed-root identities and complete required-domain evidence.
It reuses the normal supplemental-summary builder for timings/Parquet details.
Only the missing health update/recompute is retried after an outage. Accepted
backup evidence is never cleared and the backup cannot be invoked again merely
to repair reporting. A crash between accepted.json and active.json is recovered
by revalidating that exact invocation's reports, hashes and locked receipt.

Finished/Failed confirmation and daily-status recompute are separate durable
progress points. The supervisor suppresses the shared client's automatic terminal
recompute, then explicitly sends `uk_aq_rpc_recompute_daily_task_status` for the
original scheduled-for UTC date. Only a successful RPC response confirms that
obligation; a failed or lost response leaves recompute pending without resending
the confirmed terminal update or running the accepted backup again. Local
operational completion is confirmed only after both succeed. Health RPCs have a
15-second timeout. Transient/network/408/429/5xx errors
use persistent 300/600/1200/2400/up-to-3600-second delays, bounded by `max_attempts`
per health phase/review. Other 4xx and identity/configuration failures block for
review. Unknown responses are never accepted as success. Health attempts do not
consume backup-attempt counts. Normal health traffic is three REST RPCs per
one-off (Started, terminal, recompute), plus bounded recovery requests. No polling
or additional task-health table/service is introduced. The existing lock adds
approximately 720 checks per protected hour; actual platform log bytes need TEST
observation under the low-log contract.

A permanent backup failure, exhausted backup retry budget or deliberate stop is
terminal Failed, with its original timestamp/payload retained for reporting.
`retry` repairs an unconfirmed health obligation without reopening a terminal
health run. After Failed and recompute are confirmed, use `start-new.sh` for an
ordinary exhausted backup attempt, or reviewed `new --operation UUID` when manual
review is required. That new one-off can reuse canonical authenticated Dropbox
checkpoints; it does not discard remote progress or reinterpret failure as success.
A temporary Started-reporting
outage before backup can be reviewed and retried using the same operation.

The health record is version 2. Earlier unreleased version-1 records are refused
for review: preserve their evidence and reconcile the prior task/server revision
before changing versions. Never silently reassign an existing run to the new task
or erase an accepted backup to repair health reporting.

## Protected TEST configuration

Prerequisites: macOS, Node >=20 at a stable executable path, rclone with normal
Dropbox OAuth refresh, repository dependencies and an operator-reviewed valid v3
source. Obtain approved TEST R2, lock database, **ObsAQIDB REST** and Dropbox values
locally. The global lock's `SUPABASE_DB_URL` is separate from health REST credentials.
Installation checks local configuration only and makes no remote probe.

From the merged TEST Ops checkout, after the schema prerequisite:

```bash
umask 077
export BACKUP_HOME="$HOME/Library/Application Support/UK AQ/history-dropbox-backup"
export BACKUP_CONFIG="$BACKUP_HOME/TEST/config/backup.json"
mkdir -p "$BACKUP_HOME/TEST/config"
chmod 700 "$BACKUP_HOME/TEST" "$BACKUP_HOME/TEST/config"
mkdir -p "$BACKUP_HOME/TEST/config/certs/ingestdb"
chmod 700 "$BACKUP_HOME/TEST/config/certs" "$BACKUP_HOME/TEST/config/certs/ingestdb"
cp local/history_dropbox_backup/config.example.json "$BACKUP_CONFIG"
chmod 600 "$BACKUP_CONFIG"
touch "$BACKUP_HOME/TEST/config/rclone.conf"
chmod 600 "$BACKUP_HOME/TEST/config/rclone.conf"
npm ci --ignore-scripts
```

Replace every placeholder in a local editor. Never paste credentials into chat,
Git, command arguments or logs. Configuration must be an explicitly supplied
absolute canonical path ending `/TEST/config/backup.json`, outside the repository.
Private directories must be owned by the current user with mode 700 and files
with mode 600. Symlinked paths are refused. Avoid cloud-synchronised storage.
JSON is parsed as data; an arbitrary .env file is never executed.

The `identity` section pins endpoint, bucket, lock PostgreSQL project, separate
`obs_aqidb_project_ref`, and Dropbox root/directory. Runtime values must agree
exactly. These are reviewed pins, not discovery; verify them together against the
approved TEST configuration. The Dropbox root's first component must equal TEST.
The lock URL in the existing `env.SUPABASE_DB_URL` accepts either the approved
direct `db.<project-ref>.supabase.co:5432/postgres` endpoint (direct port omission
also means 5432), or the approved shared Supabase **session** pooler:

```text
postgresql://postgres.<project-ref>:<URL-encoded-password>@aws-<pooler-number>-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full
```

On the MacBook Pro, reuse the existing approved TEST IngestDB session-pooler URL
in the protected local JSON. Keep its actual pooler hostname and credentials,
select port **5432** and database `postgres`, and use exactly
`?sslmode=verify-full`. The decoded username must be exactly `postgres.<project-ref>`, with
the same reviewed `identity.postgres_project_ref`; do not change the pin to make
a different project pass. URL-encode credentials locally. No new environment key,
project discovery or direct-endpoint DNS workaround is required.

Both routes require explicit `sslmode=verify-full` as the
only query parameter. Duplicate parameters, identity overrides, `ssl`,
`uselibpqcompat` and other query settings are refused because the PostgreSQL
driver can otherwise override the validated target or disable certificate checks.
Certificate-chain and hostname verification remain enabled. `require` is now
refused so this boundary does not depend on driver-version aliases. Never disable
certificate verification. Transaction pooling (especially port **6543**), other
ports/hosts, missing credentials and mismatched projects are refused.

Health requires existing names `OBS_AQIDB_SUPABASE_URL` and `OBS_AQIDB_SECRET_KEY`.
The URL must exactly match the separately pinned ObsAQIDB project. It is never
inferred from the lock database or an inherited environment. Health credentials
are excluded from the backup child's environment. All inherited backend, Node,
rclone, lock-held and debug overrides are excluded. Plists contain only executable,
repository/config/CA paths, environment label and output paths. No new shared
repository environment variable or env-sync target is required; the JSON pin is
local-only because health and lock projects must be reviewed independently.

Existing R2/Dropbox/checkpoint key names are retained in the example. A fingerprint
binds source/destination, installation, generation/mode, both reviewed database
identities and retry/checkpoint controls. Credential rotation does not change it;
identity/control changes require a new operation after settling prior reporting.
CA path/certificate rotation and selecting `verify-full` do not change the
fingerprint or durable operation UUID; reinstall the plist while safely idle.
`max_attempts` is 1–20 (default example 5). Unreported old backup-only state is not
silently retrofitted with a fictitious Started event; retain it for operator review.

Configure only these two remotes in the dedicated file:

```bash
rclone --config "$BACKUP_HOME/TEST/config/rclone.conf" config
chmod 600 "$BACKUP_HOME/TEST/config/rclone.conf"
```

Enter secrets at interactive prompts. `uk_aq_r2` uses S3/Cloudflare, explicit
`env_auth=false`, and exactly the JSON's endpoint, region and access/secret keys;
optional `acl=private` and `no_check_bucket=true` are supported. `uk_aq_dropbox`
uses the approved app's client ID/secret and token JSON with access token, refresh
token and expiry. These must match `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and
`DROPBOX_REFRESH_TOKEN` in protected JSON. Normal OAuth refresh updates this
writable file; access-token-only or password-prompt encrypted configs are not
supported. Do not substitute `rclone obscure` output for literal service secrets.

The existing shared remote guard inspects local `config providers` and `config
dump`, with 15-second bounds, to verify backend credential representation and
exact effective identities. The dump is captured only in memory, never logged or
saved. Unsupported account/path/backend overrides fail closed. Review the actual
Dropbox account and manifest pins; the program cannot infer intent from labels.

### Protected PostgreSQL CA

The required top-level `postgres_ca_file` in protected `backup.json` selects the
operator-approved public CA certificate. There was no equivalent protected field;
this local JSON setting is separate from `env` and introduces no shared secret or
environment-sync target. Use an absolute canonical path directly inside the
selected installation's `config/certs/ingestdb/` directory:

```text
history-dropbox-backup/
  TEST/config/backup.json
  TEST/config/certs/ingestdb/prod-ca-2021.crt
  LIVE/config/backup.json
  LIVE/config/certs/ingestdb/prod-ca-2021.crt
```

Each JSON uses its own absolute path; the example is a placeholder to replace
locally. TEST and future separately authorised LIVE installations run identical
code and may hold distinct approved CA files. A path in the other environment,
outside `certs/ingestdb/`, relative, noncanonical or through a symlink is refused.
The environment root, config, certs and ingestdb directories must satisfy the
existing current-user/private-path rules (normally 700); the regular certificate
file must satisfy the same rules (normally 600). The file must contain exactly
one PEM CA certificate within its validity period, with no key or bundle.
Missing, malformed, expired or insecure certificates block configuration; there
is no inherited-shell or alternative-certificate fallback. This validates local
structure, not provenance: obtain/review the approved certificate independently.

The existing approved TEST file is `prod-ca-2021.crt`, subject
`CN=Supabase Root 2021 CA`, valid until 26 April 2031. These are operator reference
facts, not application constants or automatic discovery rules. For a new install,
copy only the independently approved public CA into the protected directory and
set mode 600. Do not copy keys or credentials there or commit certificate contents.

Installation validates the configured file and renders its path into launchd's
`EnvironmentVariables.NODE_EXTRA_CA_CERTS`. Node reads extra CAs when its process
starts; setting `process.env` after startup cannot configure the supervisor's TLS
trust. The plist therefore supplies it before the supervisor starts, including
after logout/login or reboot. The supervisor blocks with `postgres_ca_startup`
if its startup environment does not match the protected configured path; it
does not proceed with stale plist trust. `childEnvironment()` revalidates and pins the same
protected path for the shared PostgreSQL coordinator and subsequent Node children;
an inherited `NODE_EXTRA_CA_CERTS` cannot override it. Existing environment
sanitisation and health-secret exclusions remain. Only the CA path goes into the
plist; neither certificate contents nor credentials are rendered or logged.

### Update an existing idle TEST installation without starting

This procedure applies to the existing `Ready`, backup attempts `0`, operation
UUID `null`, task health `not_started` installation. Before replacing its stable
checkout, use the existing checkout's status command to confirm those values.
If an operation exists, preserve it and review its state before changing code;
do not use `new`, delete state, or stop/cancel it as an installation shortcut.

Set these local path variables; they contain no credentials:

```bash
umask 077
export BACKUP_HOME="$HOME/Library/Application Support/UK AQ/history-dropbox-backup"
export BACKUP_CONFIG="$BACKUP_HOME/TEST/config/backup.json"
export BACKUP_PLIST="$HOME/Library/LaunchAgents/uk.co.ukaq.history-dropbox-backup.test.plist"
./local/history_dropbox_backup/status.sh --environment TEST --config "$BACKUP_CONFIG"
```

After confirming that idle state, ensure the job is unregistered before updating
the checkout or protected configuration. This only unregisters the confirmed idle
job; it does not invoke the package's cancellation command or create state:

```bash
if launchctl print "gui/$(id -u)/uk.co.ukaq.history-dropbox-backup.test" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/uk.co.ukaq.history-dropbox-backup.test"
fi
```

Use a stable TEST Ops checkout containing the merged CA-support PR, with existing
dependencies installed. In a local editor, update the existing `backup.json` only:
add `postgres_ca_file` with the absolute canonical path to the **already installed
approved TEST** certificate, and ensure the existing approved session-pooler URL's
only query is `sslmode=verify-full`. Keep all project/target pins and credentials.
Do not replace the JSON with the example or recreate `rclone.conf`.

```bash
chmod 700 "$BACKUP_HOME/TEST/config/certs" "$BACKUP_HOME/TEST/config/certs/ingestdb"
chmod 600 "$BACKUP_CONFIG" "$BACKUP_HOME/TEST/config/certs/ingestdb/prod-ca-2021.crt"
./local/history_dropbox_backup/install.sh --environment TEST --config "$BACKUP_CONFIG"
plutil -lint "$BACKUP_PLIST"
/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:NODE_EXTRA_CA_CERTS' "$BACKUP_PLIST"
./local/history_dropbox_backup/status.sh --environment TEST --config "$BACKUP_CONFIG"
```

Compare the single printed CA path with the expected protected TEST certificate
path. This inspects only the CA entry, without printing JSON, credentials or
certificate contents. Confirm the status is still `Ready`, attempts `0`, operation
UUID `null`, health `not_started`, and that `launchctl print` reports no registered
job. Installation only validates and atomically replaces the plist: it does not
bootstrap, kickstart, run the supervisor, create an operation or send health RPCs.
All existing state, reports, logs, configuration and rclone OAuth credentials are
retained. No backup starts until a later separately authorised explicit `start`.
Reinstall again while safely idle whenever the CA path or certificate is changed.

If installation fails, keep the job unregistered and retain all evidence while
correcting the reported category. For rollback, retain/restore the prior stable
checkout and plist while idle; do not start an older version without reviewing its
CA startup configuration. Never erase an operation or weaken TLS to roll back.

## Scheduling, installation and operation

The shared PostgreSQL global operation lock normally serialises participating
backup and writer operations. Routine blanket pausing or checking of scheduled
TEST jobs is not required. Contention remains a visible, bounded failure; never
bypass the lock. Separately coordinate known non-participating writers and
incompatible migrations, and retain source-readiness, generation-coupled
Core/binding and first-post-v3 write acceptance gates. This package never changes
schedules automatically. This follows the authoritative TEST
[MacBook Pro lifecycle and concurrency contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/backup_and_recovery/r2_history_dropbox_backup_contract.md#optional-macbook-pro-supervised-one-off-r2-backup).

Use the intended Node on your interactive PATH, without sudo. Installation records
its resolved absolute executable path and leaves the agent idle:

```bash
./local/history_dropbox_backup/install.sh --environment TEST --config "$BACKUP_CONFIG"
./local/history_dropbox_backup/status.sh --environment TEST --config "$BACKUP_CONFIG"
```

Only after separate authorisation for the real one-off, explicitly start the
first backup (this immediately begins real backup work):

```bash
node local/history_dropbox_backup/control.mjs start --environment TEST --config "$BACKUP_CONFIG"
./local/history_dropbox_backup/status.sh --environment TEST --config "$BACKUP_CONFIG"
launchctl print "gui/$(id -u)/uk.co.ukaq.history-dropbox-backup.test"
tail -F "$BACKUP_HOME/TEST/launchd/stdout.log" "$BACKUP_HOME/TEST/launchd/stderr.log"
```

Status includes backup status, health status/UUID/original scheduled date, last
bounded error, next reporting time and `operational_completion_confirmed`.
A completed backup with pending/blocked health is explicitly distinguished from
backup-plus-health confirmed. Ready, Running, Retrying, Blocked and Not configured
remain local backup/config states; they do not invent remote task-health statuses.

For subsequent authorised one-offs, the convenience command retrieves the previous
operation UUID automatically; no copy/paste of the status UUID is needed:

```bash
# Immediately creates and STARTS one real backup; do not run start afterwards.
./local/history_dropbox_backup/start-new.sh --environment TEST --config "$BACKUP_CONFIG"
```

`start-new.sh` delegates to the existing controller. With no previous operation it
uses `start`, which creates the first UUID. With a completed operation it requires
the accepted completion/report identities plus confirmed Started, terminal
Finished and daily recompute. It then uses `new --operation PREVIOUS_UUID`, which
archives the previous operation and immediately starts exactly one new UUID.
After an ordinary definitively failed backup (`command_failed`, `unexpected_failure`,
`interrupted` or `retry_budget_exhausted`), confirmed Started, terminal Failed and
daily recompute likewise permit a new one-off. The failed UUID, diagnostics and
reporting evidence remain preserved, and the canonical checkpoint rules can reuse
previously verified progress.

Selection uses the existing local mutex and configuration fingerprint, with the
observed previous UUID (including its absence) checked again under that mutex.
A competing invocation that replaces it causes `previous_operation_changed`,
without another rollover. An active mutex reports `already_running`; after a new
operation has been selected, another invocation refuses its unfinished state.
There is no separate lock, UUID generator, scheduler or automatic backup trigger.

Running, ready, retrying, delayed or non-terminal blocked operations are refused,
as are pending Started/Finished/Failed/recompute, missing health evidence,
configuration mismatch, malformed/inconsistent state, and missing installation.
Any stop or supervision marker requires review, even after confirmed reporting.
Configuration, authentication, lock-loss or backup-evidence failures also require
review; `start-new` never clears protections to get past them. Errors expose only
safe categories such as `previous_operation_unfinished`,
`settle_previous_health_first`, `operator_stop_review`, `supervision_review`,
`configuration_changed` or `previous_failure_requires_review`. Inspect private
status/log/report evidence and use the appropriate reviewed recovery command;
never delete state or markers just to make this wrapper proceed.

The same interface accepts `--environment LIVE` with its own protected LIVE
`backup.json`, rclone configuration, CA and explicit activation authorisation.
This change does not authorise a LIVE installation or run.

Command distinctions:

| Command | Purpose |
| --- | --- |
| `start` | First one-off; an already completed backup is never repeated and only pending reporting may be reconciled. |
| `start-new.sh` | First or subsequent one-off with automatic previous-UUID confirmation and strict automatic-rollover guards; immediately starts real work. |
| `retry --operation UUID` | Reviewed recovery of the same operation or unresolved reporting; never reopens confirmed terminal health. |
| `stop.sh` | Deliberate cancellation; retains evidence and stop intent, and queues Failed when applicable. |
| `new --operation UUID` | Explicit reviewed rollover with manual previous-UUID confirmation; preserves the prior operation and immediately starts a new one. |

```bash
# Deliberately cancel; retain evidence and queue terminal Failed if backup was active.
./local/history_dropbox_backup/stop.sh --environment TEST --config "$BACKUP_CONFIG"

# After review, reset only the pending reporting budget when backup is terminal.
node local/history_dropbox_backup/control.mjs retry --environment TEST --config "$BACKUP_CONFIG" --operation REPLACE_WITH_OPERATION_UUID

# Lower-level reviewed rollover, once prior reporting is confirmed.
# This already STARTS the new operation; do not also run start.
node local/history_dropbox_backup/control.mjs new --environment TEST --config "$BACKUP_CONFIG" --operation REPLACE_WITH_PREVIOUS_OPERATION_UUID

# Remove only this agent/plist, keeping all configuration, reports and state.
./local/history_dropbox_backup/uninstall.sh --environment TEST --config "$BACKUP_CONFIG"
```

`new` refuses unresolved prior health obligations. A deliberate bootout stops the
reporter too: use reviewed `retry` to reconcile its retained obligation before
creating another one-off or uninstalling. If uninstall is necessary first, reports
remain pending; reinstall then retry reporting. Starting a completed one-off only
reconciles pending health or exits; it never repeats accepted backup work. A
confirmed terminal health run cannot be reopened by `retry`; use `start-new.sh`
when its automatic guards pass, otherwise review before using explicit `new`.

Launchd uses RunAtLoad, KeepAlive/SuccessfulExit=false, Background process type,
300-second throttle and separate stdout/stderr. There is no overall job timeout
or unconditional successful-backup repetition. Blocked exits zero to quiesce
launchd; that alone never means operational success. Nonzero/crashed attempts are
eligible for restart. Backup retry delays are also durable and bounded; a reboot
consumes the recorded interrupted attempt and adds a five-minute delay. Agents
resume **after user login**, not necessarily before login following a reboot.
Keep the Mac powered, awake, online and with adequate private disk space.

Private directories are `config/`, `state/`, `reports/<operation>/<UTC_UUID>/`,
`attempt-logs/<operation>/<UTC_UUID>/` and `launchd/`. `state/active.json` carries
separate `successful_completion` and `health` evidence; prior operations are
retained under `state/operations/`. Stop intent and supervision-review markers
survive reboot. Atomic publications use same-directory temporary files, fsync,
rename, directory fsync, mode 600 and umask 077. The local boot/PID mutex is not
the PostgreSQL lock. An incomplete owner record requires stopping and verifying
all descendants are gone before retaining/renaming the local lock directory;
never force a remote lock based on it. Normal logs redact known secrets and
credential-shaped values. Error summaries contain fixed categories. Reports and
logs remain private evidence; review before sharing. Monitor disk space; no
automatic evidence deletion or log rotation is introduced.

## Post-merge real TEST acceptance and rollback

1. Record both merged commits. Separately apply/verify the TEST ObsAQIDB migration
   and PostgREST schema refresh; confirm approved configuration, permissions,
   source generation and any separate writer/migration/readiness gates. Install idle;
   no backup should start.
2. Initiate a real authorised one-off. Confirm exactly one Started row for the
   MBPro task key, genuine local provenance, original UTC date and run UUID equal
   to the saved operation UUID. Verify dashboard visibility and exclusion from
   daily missing-task/email expectations; the GitHub task must remain unchanged;
   inspect normal lock diagnostics and 15-second elapsed-time heartbeats.
   For session-pooler acceptance, retain evidence that the existing coordinator
   acquires `uk_aq:r2_history:v2:observations_global_operation` in the pinned TEST
   IngestDB `postgres` database as owner `r2_history_dropbox_backup`. Confirm its
   five-second same-session heartbeats continue successfully. From the approved
   TEST database SQL console, take bounded read-only lock/session samples during
   pack publication, inventory, copy, verification and final checkpoint publication:

   ```sql
   SELECT a.pid, a.datname, a.application_name,
          l.classid, l.objid, l.objsubid, l.mode, l.granted
   FROM pg_stat_activity AS a
   JOIN pg_locks AS l USING (pid)
   WHERE a.datname = 'postgres'
     AND a.application_name = 'uk-aq-observations-global-operation-lock:r2_history_dropbox_backup'
     AND l.locktype = 'advisory' AND l.objsubid = 2 AND l.granted;
   ```

   Confirm the same owning backend PID and exclusive granted lock across those
   stages. Compare `classid`/`objid` with the existing shared helper's derived
   `class_id`/`object_id` (unsigned 32-bit representation in `pg_locks`) and the
   coordinator's diagnostics. Confirm explicit release after protected completion.
   Elapsed-time messages alone do not prove lock ownership. During a separately
   authorised controlled overlap, use
   the normal shared coordinator with a harmless protected command to confirm a
   contender cannot enter and times out/defer cleanly; do not run a second backup
   or a mutating writer as the contender. Do not force/unlock the owning session.
3. During justified TEST work, observe interruption/network loss/reboot and login.
   Confirm the same health UUID and authenticated checkpoint resume, no unlocked
   progress and no duplicate logical row. Observe persistent failures through
   bounded breaker behaviour. A deliberate stop is terminal cancellation.
   Confirm loss of the pooler lock session stops protected descendants, prevents
   further copy/checkpoint progress and never records completion for the failed
   attempt. A retry must acquire a fresh lock before any protected work resumes.
4. Allow a complete backup, inspect accepted report hashes/locked exit and exact
   v3 observation/binding roots plus all required domains. Observe a health outage
   if available: local backup evidence must remain complete while only reporting
   retries. Confirm Finished and recompute, immutable completion time, correct
   summary and `operational_completion_confirmed=true`.
5. Start/login again: no extra backup attempt. Review Failed/report-only retry,
   explicit new-operation creation, retention and TEST/LIVE separation. Record
   actual Supabase log impact. Restore any schedules separately paused for a known
   incompatible operation after the protected process is gone and the operator
   accepts completion; routine blanket pausing is not required.

Pre-deployment checks are documented in the linked integration guide: syntax,
JSON/plist/whitespace, existing relevant checks and focused UUID recovery,
accepted-backup reporting and real-client recompute boundary checks. No real RPC,
migration, backup or
launchd installation was performed during implementation. Rollback stops/uninstalls
only this agent and retains all evidence; settle pending health first where
possible. Restore only operator-paused schedules. Existing normal backup execution
can consume authenticated checkpoints. Do not delete packs/bindings/checkpoints.
If session pooling is not accepted, keep the installation idle and retain its
protected configuration/state. Revert to the prior merged checkout after stopping
all descendants; its validator requires a reachable approved direct endpoint.
Do not weaken TLS or substitute transaction pooling to work around DNS failure.

Chat-mode system-doc handover: amend the optional MBPro lifecycle in
`system_docs/backup_and_recovery/r2_history_dropbox_backup_contract.md` and route
its runbook from the area README as needed. Preserve the approved direct/session
pooler identity on 5432, database `postgres`, exact project-qualified pooler
username and shared lock. Record required local `postgres_ca_file`, private
environment-separated `config/certs/ingestdb/`, fail-closed canonical-path/CA
validation and explicit `sslmode=verify-full`. launchd sets `NODE_EXTRA_CA_CERTS`
before supervisor startup; children pin the validated path. CA changes do not
change operation fingerprints. Idle reinstallation never starts a backup or
resets state/health. Changes are confined to the backup config/control/supervisor/template,
example, operator docs, focused configuration check and required code archives.
There are no schema, shared environment-key, coordinator, Integrity, scheduling or
LIVE changes and no new Supabase traffic/log cadence. Local syntax, configuration
and plist checks establish structure; authorised real TEST TLS/lock/backup
acceptance follows merge and idle update. Authoritative `system_docs/` was not edited.

## Complete future LIVE promotion scope

Promote identical application files after TEST acceptance and separate explicit
LIVE authorisation, excluding TEST archives and all credentials/runtime evidence:

```text
local/history_dropbox_backup/config.mjs
local/history_dropbox_backup/control.mjs
local/history_dropbox_backup/supervisor.mjs
local/history_dropbox_backup/reports.mjs
local/history_dropbox_backup/health.mjs
local/history_dropbox_backup/LaunchAgent.plist.template
local/history_dropbox_backup/config.example.json
local/history_dropbox_backup/install.sh
local/history_dropbox_backup/status.sh
local/history_dropbox_backup/stop.sh
local/history_dropbox_backup/uninstall.sh
local/history_dropbox_backup/README.md
local/history_dropbox_backup/daily_task_health_dependency.md
workers/shared/daily_task_health.mjs
```

The Schema promotion includes the canonical owner and new migration named in the
linked guide. Validation sources are `tests/local_history_backup_health.test.mjs`
in Ops and `tests/check_daily_task_started_execution_identity.py` plus the updated
`tests/test_daily_task_started_github_idempotency.py` in Schema. Existing canonical
backup coordinator, child supervisor, runner, publisher, inventory, sync, shared
generation/lock/remote guards and transitive dependencies/package lock must already
match the accepted TEST version, including `history_backup_targets.mjs` and the
changes listed in `scripts/backup_r2/README.shared_binding_pack_promotion.md`.

LIVE needs its own applied/verified ObsAQIDB migration, independently reviewed
LIVE lock/health/R2/Dropbox identities, `LIVE/config`, and explicit
`live_activation_authorized=true`. Source promotion alone does not apply SQL or
activate the agent. No LIVE repository or service was changed. Chat-mode system-doc
handover is in the linked guide; authoritative system_docs remains unchanged.
