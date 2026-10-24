# Manual TEST Prune signer readiness

This is an operator handover, not an authoritative system contract. The manual
`UK AQ Prune signer preflight (TEST)` workflow checks configuration in the actual
GitHub Actions process without contacting the signer or any data service. It is
independent of normal Prune and does not depend on the pending-source enable flag.

## Root cause and bounded correction

At TEST Ops `483d333e`, `resolvePruneSignerConfig()` calls
`managedR2TargetConfig()`, whose `assertConfiguredIdentity()` requires an explicit
`UK_AQ_GITHUB_REPO` matching `GITHUB_REPOSITORY` in Actions. Prune's workflow did
not pass that configuration, and the sync target classified it as `local`.
The optional handover therefore failed admission before an upload intent.

Prune now passes `${{ vars.UK_AQ_GITHUB_REPO }}` directly, with no fallback.
`config/uk_aq_github_env_targets.csv` routes that existing key to a repository
variable. The production identity, R2 and signer admission functions are unchanged.
No new mandatory validation step is added to normal Prune. Its existing optional
configuration-error handling continues to isolate JSONgen failure from canonical
publication and deletion.

The user-reported historical run `40125105670` completed canonical Prune but lost
the optional AURN source handover. This correction neither recovers that source
nor upgrades its incomplete outbox evidence to VERIFIED. Do not replay that event
or run Prune as a readiness diagnostic.

The first real Actions preflight failed before admission with
`ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`, imported from
`workers/shared/uk_aq_r2_history_writer.mjs` through the production admission
import chain. The preflight workflow now runs `npm ci --ignore-scripts` after
Node.js setup and before execution, matching Prune Daily. `pg` is already declared
in `package.json`; no package or lockfile change is needed. Installing dependencies
does not invoke Prune, data clients or signer transport.

This dependency-install correction receives focused structural validation only;
functional validation is the next real TEST Actions preflight after merge. To
roll back this correction, revert its dependency-install step and documentation
through normal review; that restores the missing-package failure.

## Configuration and local catalogue

The operator must explicitly configure the **Actions repository variable**
`UK_AQ_GITHUB_REPO` on the TEST Ops repository. Its value must be that repository's
exact `OWNER/REPO` identity, including case. GitHub's runtime identity is used only
to check equality; it never supplies the configured value.

The preflight uses the same existing settings as Prune:

| Setting | Source / validation |
| --- | --- |
| `UK_AQ_ENV_NAME` | Explicit `TEST` in both workflows; preflight rejects any other process identity. |
| `UK_AQ_GITHUB_REPO` | Actions repository variable; explicit valid `OWNER/REPO`, exactly equal to GitHub's actual `GITHUB_REPOSITORY`. |
| `UK_AQ_JSONGEN_R2_ENDPOINT` | Existing repository variable; account-scoped HTTPS R2 S3 endpoint, no credentials/query/path overrides. |
| `UK_AQ_JSONGEN_R2_BUCKET` | Existing repository variable; valid explicit bucket, available before module import. |
| `UK_AQ_JSONGEN_PRUNE_SIGNER_URL` | Existing repository variable; reviewed HTTPS Access hostname and exact `/v1/upload-intents` route, with production URL restrictions. |
| `UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN` | Existing secret; HTTP-header validity, no whitespace, production minimum 32 characters and dedicated-secret checks. |
| `UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID`, `UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET` | Existing secrets; present, no whitespace, valid HTTP-header values, production admission. |
| `CFLARE_R2_SECRET_ACCESS_KEY` | Existing secret, supplied only for the production equality check preventing reuse as a signer secret. No R2 client is constructed. |

No new key or environment-specific alias is introduced. The existing sync script
already supports `variable` targets and needs no implementation change.
Local `.env` sourcing and local admission remain supported: local callers keep
the explicit existing `UK_AQ_GITHUB_REPO` and may omit GitHub runtime metadata.
The preflight itself deliberately requires a genuine manual Actions context.

`env-vars-master.csv` is operator-owned, ignored by Git and absent in this cloud
checkout. Its only discovered mechanism here is the existing private catalogue
used to maintain local env files, followed by the tracked target mapping and
`scripts/uk_aq_sync_github_secrets.sh`; there is no tracked master-file generator.
Before any later configuration sync, retain/add its existing
`UK_AQ_GITHUB_REPO` entry using its current columns, mark it as an Actions
repository variable, and preserve its sourced local value. Do not create a second
catalogue or commit private values. No variables, secrets or private env files
were changed by this implementation.

## Run the preflight after review and merge

In the TEST Ops repository's Actions tab, select
**UK AQ Prune signer preflight (TEST)**, choose the reviewed `main` revision and
**Run workflow**. This dispatch is an operator step; it was not performed during
implementation. Start a new run from the updated `main`; rerunning the old failed
job would reuse its original workflow revision. There are no workflow inputs.
Alternatively:

```sh
gh workflow run uk_aq_prune_signer_preflight.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref main
```

Expected success: all `PASS` lines, ending with
`Prune signer configuration is structurally ready in this TEST Actions context.`
The job summary and log also say remote authentication, target ownership, uploads
and VERIFIED handover remain unverified. Success is configuration admission only.

Expected failure: nonzero step/job exit and `FAIL: Check <configuration item>`.
An absent/mismatched repository identifies `UK_AQ_GITHUB_REPO` and
`GITHUB_REPOSITORY`; malformed target/URL and missing/invalid credentials identify
their setting names. Correct the named configuration through the operator's
normal process, then rerun this preflight. Reports contain only fixed messages;
they never include supplied values, exception details or resolved credentials.

The script calls `assertConfiguredIdentity()`, `managedR2TargetConfig()` and the
actual `resolvePruneSignerConfig()`. It does not call transport functions, create
data clients, read/write R2, connect to PostgreSQL/Supabase, insert outbox events,
initialise/update managed control, generate monthly files or execute Prune.
Checkout and Node setup use GitHub infrastructure, and `npm ci --ignore-scripts`
installs the locked repository dependencies needed by the inert production
admission imports, including `pg`. Lifecycle scripts are disabled; no data-service
request is part of the diagnostic.

## Ordered safe TEST acceptance

1. Review this PR and separately merge the accepted source to TEST `main`.
   Keep Prune scheduling paused and monthly selection disabled. No Worker
   deployment is required by this configuration-only fix; do not redispatch the
   separate signer deployment workflow as a diagnostic.
2. Configure the explicit TEST Ops `UK_AQ_GITHUB_REPO` repository variable and
   align the private catalogue/local env through the existing mechanism above.
   Review the existing JSONgen target, signer URL and dedicated credentials.
   This task does not change any remote setting or the pending-source flag.
3. Dispatch only the new preflight at the reviewed revision. Require a successful
   job and retain its run URL, source SHA and fixed-message summary. This proves
   the settings visible to that Actions execution can construct the signer config.
4. Before requesting another source-consuming run, review the actual deployed
   signer version/TEST target and Access policy, credential custody, original
   outbox permissions, independent consumer readiness and applicable source/
   final-authority evidence requirements. Use the existing
   [integration readiness handover](prune-integration-readiness.md) for those
   separate prerequisites. Preflight cannot authenticate the remote signer,
   prove its enabled state, permissions, target ownership or network availability,
   or establish that an upload/immutable readback/receipt will succeed.
5. Review genuine first-publication candidate eligibility, the effective dry-run
   setting, all eligible connector/day work and normal deletion consequences,
   current TEST schedule pause and optional-source flag. Normal Prune has no
   diagnostic-only signer mode or date/connector dispatch filter. Its existing
   extended 190-minute job / 180-minute command / 10,740-second Phase B envelope
   is preserved. A preflight pass does not authorise source consumption.
6. Obtain separate authorisation for one genuine TEST Prune operation at the
   reviewed source revision, including its normal deletion effects. Only that
   authorised integration operation can prove remote signer authentication,
   upload intent issuance and signed upload success in the real writer context.
   No synthetic integration test or Prune replay is included in this change.
7. Assess the actual canonical publication/gates/deletion and optional transport
   outcomes separately. Authenticate the new private pending bytes, original
   committed outbox and retained source/status/scope/finalisation evidence using
   the supported independent consumer. Prune verifies canonical observations
   once; JSONgen must not repeat a canonical Parquet scan. A PUT acknowledgement
   or gate-only row is never VERIFIED. If optional evidence is incomplete, report
   missing coverage; normal safe Prune may still consume the source. Never claim
   the failed historical event was recovered or automatically rerun it.
8. Keep monthly publication selection disabled and the schedule paused after this
   bounded acceptance unless each is separately reviewed and authorised.

## Preserved behaviour and rollback

The earlier identity/admission correction reported these checks on Node v24.19.0
(the dependency-install correction does not repeat these functional probes):

- `node --check scripts/jsongen/prune-signer-preflight.mjs` and `git diff --check`.
- YAML parsing and direct comparison of both workflow environments; manual-only
  triggers, read-only token permissions and exact pre-change archive bytes.
  The original Prune workflow has exactly one added configuration binding.
- Twelve one-off offline admission probes: valid settings; missing/mismatched
  repository; non-TEST/non-manual context; malformed R2 endpoint/bucket/signer
  URL; missing, short or invalid-header credentials; canonical-secret reuse.
  Expected exits and named failures passed without value disclosure. Network
  calls were trapped and counted zero; Node filesystem-write permissions were
  denied. Existing local admission without GitHub metadata also passed.
- The existing environment-sync script's `--dry-run`, with a synthetic one-key
  env file and an offline `gh` stub, selected repository-variable routing.
  `bash -n scripts/uk_aq_sync_github_secrets.sh` passed.

The one-off checkers/inputs are scratch files under `/workspace/work/prune-jsongen`,
not a new repository test suite. No broad regression suite or operational check
was run: canonical control flow and production admission implementations are
unchanged. The real Actions preflight itself remains an operator acceptance step.

No canonical source, publication, recovery, deletion, finalisation, same-run
evidence reuse, eight-concurrent-GET optimisation, runtime budget, signer security,
descriptor, receipt, retention or control implementation changes. There is no
schedule addition or monthly selector change.

Before merge, close the PR to abandon the correction. After merge, revert this
bounded commit through normal review to restore the old wiring and remove the
manual preflight. That restores the missing-identity optional handover failure;
it is not a source recovery. No SQL/data migration or R2/outbox cleanup is needed.
The exact pre-change Prune workflow is preserved at
`archive/2026-10-24/.github/workflows/uk_aq_prune_daily.yml` for reference only.
Never execute archived code. If optional JSONgen transport must be disabled,
review a separate operator change to the existing pending-source flag; do not
weaken identity/security checks or alter canonical deletion gates.

## ChatGPT authoritative-documentation handover

No `system_docs/` file was edited. For the dependency-install correction, record
that the first real preflight failed on missing `pg`, the workflow now installs
locked dependencies with lifecycle scripts disabled, and real TEST Actions
preflight acceptance remains pending. There is no schema, configuration or Worker
deployment change for this correction.

ChatGPT in Chat mode should update the relevant
Prune/JSONgen operational status and configuration guidance: explicit repository
identity is now an Actions variable as well as a sourced local setting; a manual
local-only Actions signer preflight exists; its pass establishes structural
admission only. Record the user-reported historical canonical-success / optional
`signer_config_unavailable` failure separately from any later observed preflight
or genuine integration evidence. Do not mark a historical incomplete event
VERIFIED, claim remote authentication/upload acceptance from preflight, enable
publication or infer scheduler resumption. No schema, Worker deployment, R2
layout, wire-contract or canonical-safety change is required.
