# One-off Mac R2 history backup

This package prepares a real **TEST** acceptance run after merge and installation
on the always-on MacBook Pro. It does not install itself, start a backup, alter
schedules or activate LIVE. Use a stable checkout of the merged TEST commit.
Do not move, update or switch that checkout during an operation.

The application code is environment independent. The same files derive distinct
TEST/LIVE labels and private directories from the explicit environment. The
canonical pack publisher and its shared `history_backup_targets.mjs` identity
guard already support explicitly configured environments on current TEST main.
This package reuses those guards unchanged. LIVE requires separate authorisation,
canonical dependency review/promotion and real TEST acceptance.

## Existing authority preserved

Read the authoritative sibling `uk-aq-system-docs/system_docs/SYSTEM_OVERVIEW.md`
and its backup/recovery route. The current complete-generation side-by-side and
website-cut-over amendments supersede the older mixed v2/v3 backup topology.
The existing shared generation resolver owns every effective prefix. This runs:

```text
existing PostgreSQL lock coordinator, owner r2_history_dropbox_backup
  -> existing uk_aq_run_locked_history_backup.mjs --generation v3
     -> canonical pack publisher (build missing packs automatically)
     -> canonical hierarchical inventory
     -> canonical Dropbox sync and checkpoint verification
```

The selected controls are `pack`, explicit `full` Parquet mode,
`max-days-per-run=0`, and `--allow-experimental-pack-only`. This is the **complete**
backup; it does not use the packs-only proving option. Checkpoint batch/flush
values come from the protected configuration. No alternate transport, backup
algorithm, source repair, checkpoint deletion, binding deletion, pack cleanup or
core pruning is introduced. Existing observation stale-Parquet handling remains
inside the canonical sync.

Each attempt acquires the ordinary database-local global lock with a distinct
run ID containing the durable operation UUID and attempt number. The lock spans
publisher, inventory, copy, verification and checkpoint publication. Acquisition
is bounded at 60 seconds; the existing session check remains at five seconds.
Contention does not bypass the lock. Lock loss stops descendants and blocks the
operation for review; no force recovery or SOS-only recovery profile is selected.
The existing liveness-pipe child supervisor also wraps the lock coordinator, so
unexpected death of the local supervisor tears down the protected process tree.

Only the existing lock connection generates Supabase traffic: roughly one
acquisition/release pair and 720 same-session checks per hour of protected work,
plus bounded acquisition polling on contention. There are no new database tables,
RPCs, task-health writes or status polls. Request/log volume is the same as the
equivalent canonical operation, with at most the configured attempt budget per
operator review. Actual platform log bytes must be observed during TEST acceptance.
Local completion does not create a GitHub Daily Task Health success; do not use
this package as evidence that the dashboard freshness gate has been refreshed.

## Protected configuration

Prerequisites: macOS, Node >=20 at a stable absolute executable path, repository
`npm ci --ignore-scripts` dependencies, and an installed rclone supporting Dropbox
OAuth refresh. Review the existing TEST source bucket/endpoint, database project
and normal Dropbox destination with the operator. Installation performs local
configuration checks only, never a remote connectivity probe.

Run from the merged TEST repository checkout:

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

Edit `backup.json` in a local editor. Replace **every** placeholder locally; never
paste credentials into chat, Git, shell arguments or logs. The config file must
be an absolute canonical path ending `/TEST/config/backup.json` (or `/LIVE/...`
for separately authorised future activation), outside this checkout. The root
and configuration directories must be owned by the current user with mode 700;
configuration files must be owned by that user with mode 600. Symlinked paths
are refused. Avoid a cloud-synchronised configuration directory.

Configuration is JSON, never executable shell or a sourced `.env`. Unknown
environment keys and arbitrary backup options are rejected. The `identity`
section pins the reviewed endpoint, bucket, database project ref and Dropbox
root/directory. Corresponding existing environment keys must agree exactly.
Pins are an operator-reviewed environment manifest, not automatically discovered
authority; review them against the existing TEST configuration before filling
credentials. The Dropbox root's first component must equal `environment`.
The direct PostgreSQL URL must select `db.<project-ref>.supabase.co:5432/postgres`
with `sslmode=require` or `verify-full`; transaction poolers are refused. If the
Mac cannot reach the direct endpoint, resolve that networking prerequisite rather
than substituting an unapproved pooler. URL-encode the database password locally.

Use the existing `CFLARE_R2_*`, `SUPABASE_DB_URL`, `DROPBOX_APP_KEY`,
`DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`, `UK_AQ_DROPBOX_ROOT`,
`UK_AQ_R2_HISTORY_DROPBOX_DIR`, `UK_AQ_R2_HISTORY_VERSION` and checkpoint keys as
shown in the example. There are no new shared environment variables or env-sync
targets. Local-only JSON keys select the rclone executable/config, reviewed
identity, retry budget and inactive-by-default LIVE activation. `max_attempts`
must be 1–20; five is the recommended starting budget. Credential rotation is
allowed during a stopped operation without changing its source identity;
changing identity, destination, installation root, retry budget or checkpoint
controls requires an explicit new operation.

Configure **only** these two remotes in the dedicated protected file:

```bash
rclone --config "$BACKUP_HOME/TEST/config/rclone.conf" config
chmod 600 "$BACKUP_HOME/TEST/config/rclone.conf"
```

Enter secrets at the interactive prompts; do not pass them as arguments.

* `uk_aq_r2`: `type=s3`, `provider=Cloudflare`, `env_auth=false`, the same endpoint,
  region and R2 access/secret keys as the JSON. Optional `acl=private` and
  `no_check_bucket=true` are supported. No other remote options are accepted.
* `uk_aq_dropbox`: `type=dropbox`, the existing approved Dropbox application's
  `client_id`/`client_secret`, and its OAuth `token` JSON containing access token,
  refresh token and expiry. Complete the usual rclone OAuth consent procedure
  for the approved account. Existing `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET` and
  `DROPBOX_REFRESH_TOKEN` values in `backup.json` must match these rclone settings
  exactly. The shared canonical guard checks the installed rclone provider schema
  and the effective literal secret representation; do not insert `rclone obscure`
  output in place of the actual service secrets. Normal rclone refresh updates this
  dedicated writable file. Do not configure an access-token-only remote.

Do not use an encrypted rclone config requiring an interactive password here.
Before every attempt the shared guard uses local-only captured `rclone config
providers` and `rclone config dump` to validate remote types, supported credential
representation, the exact R2 endpoint/region/credentials and Dropbox application
and refresh-token identities. Each local command has a 15-second timeout. The
dump is never printed or saved. The dedicated Dropbox token/account and manifest pins need operator
review; the program cannot infer the intended account from a label alone.
Inherited R2/Dropbox/rclone settings, lock-held variables, arbitrary env overrides,
Node options and debug settings are not passed to the child. The plist contains
only executable, repository/config paths, environment label and output paths.

## Pause coordination before starting

An operator must pause the TEST R2 backup dispatch and conflicting scheduled
Prune/Integrity/SOS-light/migration operations through their normal authorised
Cloudflare/GitHub controls before this extended run. Record precisely what was
paused and its previous values, wait for active conflicting operations to finish,
and verify any required first-post-v3-write acceptance gates independently.
Coordinate generation-coupled Core/binding publishers as required by the normal
runbook. The global lock remains mandatory despite the pause. This package
never disables a schedule or changes GitHub/Cloudflare settings automatically.

## Install, initiate, inspect and stop TEST

Commands use the installed Node from your interactive PATH. Install records its
resolved absolute path for launchd. Do not use `sudo`; this is a per-user agent.

```bash
# Write and validate the TEST plist; no bootstrap and no backup.
./local/history_dropbox_backup/install.sh --environment TEST --config "$BACKUP_CONFIG"

# Explicitly create the first one-off and bootstrap/kickstart its LaunchAgent.
node local/history_dropbox_backup/control.mjs start --environment TEST --config "$BACKUP_CONFIG"

./local/history_dropbox_backup/status.sh --environment TEST --config "$BACKUP_CONFIG"
launchctl print "gui/$(id -u)/uk.co.ukaq.history-dropbox-backup.test"
tail -F "$BACKUP_HOME/TEST/launchd/stdout.log" "$BACKUP_HOME/TEST/launchd/stderr.log"

# Publish durable stop intent, boot out only this service, wait for graceful exit.
./local/history_dropbox_backup/stop.sh --environment TEST --config "$BACKUP_CONFIG"
```

The status JSON gives the current report/log directories, operation UUID, attempt
counts, last bounded error category, next eligible attempt, timestamps and
completed report identity. Follow an individual attempt using the paths it prints:

```bash
tail -F "/absolute/attempt-log-directory/stdout.log" "/absolute/attempt-log-directory/stderr.log"
```

After operator review and correction, copy the exact UUID from status:

```bash
# Same one-off, retained attempt count/checkpoints; resets only its review budget.
node local/history_dropbox_backup/control.mjs retry --environment TEST --config "$BACKUP_CONFIG" --operation REPLACE_WITH_OPERATION_UUID

# A different backup after a terminal operation; archives previous local state first.
node local/history_dropbox_backup/control.mjs new --environment TEST --config "$BACKUP_CONFIG" --operation REPLACE_WITH_PREVIOUS_OPERATION_UUID

# Stop and remove only this plist, retaining all config, state, reports and logs.
./local/history_dropbox_backup/uninstall.sh --environment TEST --config "$BACKUP_CONFIG"
```

`retry` accepts only a blocked operation with unchanged identity. `new` accepts
only a terminal completed/blocked operation and its exact previous UUID. Neither
can reset an active supervisor. If starting/retrying was interrupted before
bootstrap, run `start` again. Repeated `start` on a completed task does no work.
Stop/uninstall do not require working remote credentials. Reinstallation alone
does not clear the durable stop marker; use reviewed `retry` to resume.

## Restart, evidence and circuit breaker

Launchd has `RunAtLoad=true`, `KeepAlive={SuccessfulExit=false}`, background
process type and `ThrottleInterval=300`. It has no total job timeout and never
unconditionally repeats successful backups. It restarts nonzero/crashed attempts
after throttling. The supervisor also persists exponential eligibility delays
of 300, 600, 1200, 2400, then at most 3600 seconds. A start before eligibility
returns nonzero without contacting any remote. A crash/reboot consumes the
already-recorded attempt and adds a minimum five-minute delay. A reboot resumes
the LaunchAgent **after this user logs in**, not necessarily before login.
Keep the Mac powered, awake, online and with adequate private disk space.

Status meanings:

| Status | Meaning |
|---|---|
| Not configured | Protected JSON is absent. |
| Ready | Valid local config; no active operation, or explicit operation awaiting launch. |
| Running | An attempt is active. |
| Retrying | An interrupted/transient failure awaits launchd and its durable delay. |
| Blocked | Operator stop, permanent/config/auth/lock-loss failure, invalid evidence or exhausted attempt budget; review required. |
| Completed | This operation's accepted reports and successful completion marker were atomically published. |

The circuit breaker stops immediately on detected permanent authentication,
configuration/identity or lock-loss errors. Other nonzero exits, network errors
and unclassified failures get at most the configured budget. A novel permanent
failure that cannot be classified therefore still stops after that budget; no
endless R2/Dropbox/PostgreSQL retry loop is possible. Blocked runs deliberately
exit zero to quiesce launchd, so **launchd exit zero alone is not backup success**.
Status and the completion marker distinguish blocked from completed. Before
rearming, inspect retained stderr/reports and correct the underlying cause.

The retry runs the exact canonical command again. Only authenticated current
Dropbox checkpoints decide what work is already complete; local attempt logs
never substitute for checkpoint authority. Neither stop nor retry removes remote
progress. No old report path is reused: every invocation has a fresh timestamped
UUID directory, a run receipt, distinct logs and report hashes. Completion requires
zero locked command exit, the same run's lock-held receipt, current publisher and
inventory success, full non-dry-run v3/pack reports, matching observation and
binding source/processed roots, verified pack root/checkpoint evidence, complete
Core/runs/latest-timeseries and any active verification domain. Incomplete, absent,
contradictory or stale reports block completion.

Directories under the environment root are separate:

```text
config/                 protected JSON and writable dedicated rclone.conf
state/active.json       durable one-off identity, attempts, status and completion
state/operations/       retained prior terminal operation snapshots
state/stop.json         durable deliberate stop intent
state/supervision-block.json  fail-closed local supervision errors requiring review
state/supervisor.lock/  local same-installation exclusion (not the PostgreSQL lock)
reports/<operation>/<UTC timestamp_UUID>/  invocation, domain reports and acceptance
attempt-logs/<operation>/<UTC timestamp_UUID>/  redacted stdout/stderr/supervisor logs
launchd/                separate environment stdout/stderr
```

State is written by same-directory temporary file, fsync, rename and directory
fsync with mode 600; private directories use 700 and umask 077. State is retained
before explicitly initiating a new operation. Same-boot live local-lock owners
are never displaced; dead owners/previous boot IDs are reclaimable. An incomplete
local lock owner record fails closed for manual review: boot out the service,
verify no supervisor/coordinator/backup descendants remain, retain the directory
as evidence and rename it locally before retrying. Never infer that the remote
PostgreSQL lock should be broken or recovered from this local record.

Normal logs redact known R2/DB/OAuth secrets and credential-shaped fields; no
configuration or command environments are dumped. Error summaries contain only
bounded categories. Reports and logs are still private operational evidence;
review before sharing. Existing domain reports are retained unchanged in private
directories. No automatic evidence/log deletion or rotation is added; monitor
disk capacity and archive retained local evidence only after the run is stopped.

## Post-merge TEST acceptance (operator-authorised real work)

1. Verify merged commit, Node/rclone/dependencies, protected permissions, reviewed
   TEST identity pins, accepted v3 source and any post-write verification gates.
   Record scheduler pauses and an initial Dropbox checkpoint identity.
2. Install idle. Status must be Ready and no backup should start. Initiate one
   one-off explicitly; confirm Running, fresh per-attempt reports/logs, redacted
   output, approximately 15-second elapsed-time heartbeats and the expected
   lock owner/run ID. Inspect existing canonical lock diagnostics; do not add
   database modifications or broad polling merely for acceptance.
3. During authorised real TEST work, stop deliberately and verify checkpoint
   evidence survives. Review and retry the same UUID; verify it resumes through
   canonical authenticated checkpoints and does not duplicate accepted work.
   Also observe an unexpected process failure/network interruption and a reboot
   with login under operator control. Confirm no orphan protected command and
   no unlocked publisher/inventory/sync progress.
4. Observe a real contention/failure condition when available. Confirm nonzero
   attempts are bounded/delayed, lock loss fails closed, persistent/auth failures
   become Blocked, and manual reviewed retry preserves total attempt history.
   Do not manufacture a bad credential or change live remote state just to test.
5. Allow a full real TEST run to finish. Inspect `accepted.json`, its report
   hashes and `locked-exit.json`; inspect the current generation-scoped Dropbox
   checkpoint and exact observation/binding roots under the normal runbook.
   Require all listed domains and verified packs complete, no dry-run/packs-only
   shortcut, and the matching successful completion marker.
6. Start/login again: the same one-off must remain Completed without another
   backup attempt. Review status/stop/retry/uninstall behaviour, retained evidence
   and TEST/LIVE local separation. Record actual Supabase log impact and any
   missing acceptance evidence. Restore precisely the paused scheduler settings
   after the lock is released and the operator accepts completion.

These are post-deployment real-operation acceptance steps, not a speculative
pre-deployment suite. Implementation verification is limited to Node/shell syntax,
JSON parsing, plist parsing and whitespace checks; no backup was run for this PR.

## Future LIVE promotion and rollback

After TEST operational acceptance and separate explicit LIVE authorisation, the
complete new-file promotion scope is exactly:

```text
local/history_dropbox_backup/config.mjs
local/history_dropbox_backup/control.mjs
local/history_dropbox_backup/supervisor.mjs
local/history_dropbox_backup/reports.mjs
local/history_dropbox_backup/LaunchAgent.plist.template
local/history_dropbox_backup/config.example.json
local/history_dropbox_backup/install.sh
local/history_dropbox_backup/status.sh
local/history_dropbox_backup/stop.sh
local/history_dropbox_backup/uninstall.sh
local/history_dropbox_backup/README.md
```

Promote these complete identical files; exclude TEST archives, credentials,
generated plists, runtime directories and acceptance evidence. The existing
canonical coordinator, child supervisor, locked backup runner, pack publisher,
inventory, sync, shared generation/lock helpers and their transitive modules,
`package.json` and lockfile must already be the accepted matching version in the
destination checkout. In particular, `scripts/backup_r2/lib/history_backup_targets.mjs`
and the canonical entrypoint changes documented in
`scripts/backup_r2/README.shared_binding_pack_promotion.md` must be promoted and
accepted together before LIVE activation. This PR modifies none of those canonical
files. Never bypass their provider-schema, credential or remote-identity guards.

Only then prepare a separately reviewed protected LIVE config and remotes under
`LIVE/config`, with LIVE source/database/destination identities and explicit
`live_activation_authorized=true`. Use the same commands with `--environment LIVE`
and the LIVE config path. Do not reuse TEST state, rclone files or destination
paths. LIVE scheduling pause, installation, initiation and acceptance each remain
part of that future authorised operation; none is performed by this PR.

Rollback: stop/uninstall this one LaunchAgent and retain all evidence. This PR
changes no existing service or schedule. Restore only the schedules the operator
paused, after verifying no local protected process remains. Existing normal
workflow execution can consume the same authenticated remote checkpoints; do
not delete packs, bindings or completion evidence to roll back the local runner.

System-doc handover for Chat mode: document this optional local one-off execution
profile, its launchd lifecycle, protected JSON pins, durable breaker/completion
semantics, preserved global-lock/canonical backup boundary and operational TEST
acceptance once performed. There are no schema migrations or shared env-sync
changes. Authoritative `system_docs/` has not been edited.
