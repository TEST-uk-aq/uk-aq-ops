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
`ops.r2_history_dropbox_backup`. The existing GitHub workflow, task definition,
dashboard statuses, 345-minute timeout and scheduled configuration are unchanged.
The established local Integrity reporting path uses the same RPCs and local
provenance, but did not provide this package's durable lost-response recovery.

A local run records `source_repo=uk-aq-ops`, the repository supervisor path as
`source_worker`, the real operation UUID as `platform_run_id`, and summary fields
`execution_source=macbook_pro_launchd`, `platform=MBPro`, environment and actual
launchd label/domain. Before initial reporting the supervisor verifies that the
registered job PID is its own. No GitHub run IDs, workflow names or URLs are
fabricated, and no credential/log-file paths are sent in the health summary.

Before any backup attempt, the supervisor atomically saves the local identity
key/fingerprint, original UTC start time/date and exact Started payload, then
confirms the Started UUID. The new optional RPC argument enables safe replay if
the server committed but its response/local save was lost. All automatic backup
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
progress points. Local operational completion is confirmed only after both
succeed. Health RPCs have a 15-second timeout. Transient/network/408/429/5xx errors
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
health run. After Failed is confirmed, recovery requires explicit `new` with the
previous UUID. That new one-off can reuse canonical authenticated Dropbox
checkpoints; it does not discard remote progress. A temporary Started-reporting
outage before backup can be reviewed and retried using the same operation.

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
The lock URL must select `db.<project-ref>.supabase.co:5432/postgres` with
`sslmode=require` or `verify-full`; transaction poolers are refused. URL-encode the
password locally. Resolve direct-endpoint networking rather than substituting
an unapproved database transport.

Health requires existing names `OBS_AQIDB_SUPABASE_URL` and `OBS_AQIDB_SECRET_KEY`.
The URL must exactly match the separately pinned ObsAQIDB project. It is never
inferred from the lock database or an inherited environment. Health credentials
are excluded from the backup child's environment. All inherited backend, Node,
rclone, lock-held and debug overrides are excluded. Plists contain only executable,
repository/config paths, environment label and output paths. No new shared
repository environment variable or env-sync target is required; the JSON pin is
local-only because health and lock projects must be reviewed independently.

Existing R2/Dropbox/checkpoint key names are retained in the example. A fingerprint
binds source/destination, installation, generation/mode, both reviewed database
identities and retry/checkpoint controls. Credential rotation does not change it;
identity/control changes require a new operation after settling prior reporting.
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

## Scheduling, installation and operation

Before an extended run, an authorised operator must pause the TEST backup dispatch
and conflicting scheduled Prune/Integrity/SOS-light/migration operations through
normal Cloudflare/GitHub controls. Record previous settings and wait for active
conflicting operations to finish. Coordinate generation-coupled Core/binding
publishers as required by the normal runbook, and verify any required first-post-v3
write acceptance gates. This package never changes schedules automatically.
The global lock remains mandatory despite the pause.

Use the intended Node on your interactive PATH, without sudo. Installation records
its resolved absolute executable path and leaves the agent idle:

```bash
./local/history_dropbox_backup/install.sh --environment TEST --config "$BACKUP_CONFIG"
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

```bash
# Deliberately cancel; retain evidence and queue terminal Failed if backup was active.
./local/history_dropbox_backup/stop.sh --environment TEST --config "$BACKUP_CONFIG"

# After review, reset only the pending reporting budget when backup is terminal.
node local/history_dropbox_backup/control.mjs retry --environment TEST --config "$BACKUP_CONFIG" --operation REPLACE_WITH_OPERATION_UUID

# Once prior reporting is confirmed, explicitly create another one-off.
node local/history_dropbox_backup/control.mjs new --environment TEST --config "$BACKUP_CONFIG" --operation REPLACE_WITH_PREVIOUS_OPERATION_UUID

# Remove only this agent/plist, keeping all configuration, reports and state.
./local/history_dropbox_backup/uninstall.sh --environment TEST --config "$BACKUP_CONFIG"
```

`new` refuses unresolved prior health obligations. A deliberate bootout stops the
reporter too: use reviewed `retry` to reconcile its retained obligation before
creating another one-off or uninstalling. If uninstall is necessary first, reports
remain pending; reinstall then retry reporting. Starting a completed one-off only
reconciles pending health or exits; it never repeats accepted backup work. A
confirmed terminal health run cannot be reopened by `retry`; use `new`.

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
   source generation and writer/scheduler gates. Install idle; no backup should start.
2. Initiate a real authorised one-off. Confirm exactly one Started row for the
   existing task key, genuine local provenance, original UTC date and saved UUID;
   inspect normal lock diagnostics and 15-second elapsed-time heartbeats.
3. During justified TEST work, observe interruption/network loss/reboot and login.
   Confirm the same health UUID and authenticated checkpoint resume, no unlocked
   progress and no duplicate logical row. Observe persistent failures through
   bounded breaker behaviour. A deliberate stop is terminal cancellation.
4. Allow a complete backup, inspect accepted report hashes/locked exit and exact
   v3 observation/binding roots plus all required domains. Observe a health outage
   if available: local backup evidence must remain complete while only reporting
   retries. Confirm Finished and recompute, immutable completion time, correct
   summary and `operational_completion_confirmed=true`.
5. Start/login again: no extra backup attempt. Review Failed/report-only retry,
   explicit new-operation creation, retention and TEST/LIVE separation. Record
   actual Supabase log impact and restore precisely the paused schedules after
   the protected process is gone and the operator accepts completion.

Pre-deployment checks are documented in the linked integration guide: syntax,
JSON/plist/whitespace, existing relevant checks and only the two focused identity
and accepted-backup reporting boundary checks. No real RPC, migration, backup or
launchd installation was performed during implementation. Rollback stops/uninstalls
only this agent and retains all evidence; settle pending health first where
possible. Restore only operator-paused schedules. Existing normal backup execution
can consume authenticated checkpoints. Do not delete packs/bindings/checkpoints.

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
