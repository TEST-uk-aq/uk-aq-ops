# Operator execution observability contract

## Status

**Future implementation contract.** This is agreed behaviour for upcoming operator-tooling changes. It MUST NOT be treated as evidence that all current scripts already comply.

## Purpose

This contract defines the common operator-facing execution behaviour for long-running or operationally significant UK AQ scripts.

Its purpose is to prevent long unexplained silent periods, make progress understandable without flooding the terminal, and ensure every important invocation leaves a durable record that can be inspected later or shared for diagnosis.

## Scope

This contract applies to operator-facing script invocations that can take materially noticeable time, mutate external state, perform migration/recovery work, or carry out significant verification.

The observation-history index-v3 tooling is the first implementation target. The same shared mechanism SHOULD then be reused by other qualifying UK AQ operator tooling instead of each script inventing separate progress and logging behaviour.

Domain contracts continue to own what an operation does. This contract owns how that operation's execution is surfaced and recorded.

## Per-invocation work directory

Every script invocation covered by this contract MUST create a fresh per-invocation work directory when the run starts and before substantial work begins.

The work-directory identity MUST include the run start timestamp in UTC to seconds using the compact form `YYYYMMDDTHHMMSSZ`, together with enough operation identity to distinguish the run. For example:

```text
<operation-work-root>/runs/20260906T001530Z_rollback/
```

A new invocation MUST NOT reuse or overwrite a previous invocation's work directory. If two runs would otherwise receive the same name, the implementation MUST add a deterministic or unique suffix rather than overwrite existing evidence.

The created work-directory path MUST be printed near the start of the operator output.

A subsystem MAY retain a longer-lived operation/authority root when several invocations belong to the same logical operation. For example, a migration plan, migration, resume, verification and rollback may need to share immutable authority/checkpoint material. In that case:

- the shared operation/authority root MAY persist across invocations;
- every individual invocation MUST still receive its own timestamped run work directory beneath or alongside that root;
- run-local logs and run reports MUST go into the invocation's run work directory;
- existing authority/checkpoint identities MUST NOT be moved, rewritten or reinterpreted merely to satisfy this directory convention.

Existing command-line argument names do not need to be renamed solely to implement this contract. What matters is that every qualifying invocation has a distinct timestamped run directory while any domain-specific shared authority root remains intact.

## 15-second progress rule

Any operator-visible phase that remains active for 15 seconds MUST provide a time-driven progress heartbeat at approximately 15-second intervals until that phase completes or fails.

The cadence MUST be based on elapsed wall-clock time, not on object count, row count, partition count or any other unit of work. Work units MAY be included as useful context, but they MUST NOT determine when progress is printed.

The required operator pattern is:

1. print an immediate phase-start message;
2. if the phase is still active at 15 seconds, print a heartbeat;
3. continue heartbeats at approximately 15-second intervals while the phase remains active;
4. print an immediate phase-completion or phase-failure message.

A phase that completes in under 15 seconds does not need a heartbeat between its start and completion messages.

A parent wrapper waiting for a silent child process MUST still satisfy the 15-second rule. The implementation MUST NOT rely on the child happening to print output in order to prove that the operation is still alive.

Only one standard heartbeat source SHOULD own a given operator-visible phase. Components MUST avoid duplicate 15-second reporters for the same work where a shared reporter already covers it.

Progress output SHOULD use stderr where stdout is reserved for machine-readable output.

## Progress content

Every heartbeat MUST include elapsed time for the active phase.

Where a meaningful bounded total exists, the heartbeat SHOULD also include useful progress measures such as bytes, objects, partitions, rows or other domain-appropriate units. The selected measure SHOULD reflect real work rather than merely the easiest counter to expose.

Object counts or similar counters MAY be displayed even when individual objects vary greatly in cost. They are context only and MUST NOT drive the heartbeat cadence.

Examples:

```text
Rollback: restoring canonical v2 elapsed=00:01:15 objects=412/1789 bytes=326 MiB/1.34 GiB ETA~00:04:10
```

```text
Rollback: authenticating recovery authority elapsed=00:00:45 ETA=unknown
```

## ETA behaviour

An ETA SHOULD be shown when the implementation has both:

- a meaningful remaining-work denominator; and
- enough observed progress to derive a useful rate.

An ETA MUST NOT be invented when the total amount of work is genuinely unknown or the measured units do not give a credible basis for prediction.

Before enough rate information exists, use an explicit state such as:

```text
ETA=calculating
```

When no defensible ETA can be calculated, use:

```text
ETA=unknown
```

Displayed ETAs are operational estimates, not acceptance criteria. They SHOULD be clearly approximate and MUST NOT affect operation ordering, retries, checkpointing, recovery or success/failure status.

## Persistent run log

Every qualifying invocation MUST create a persistent human-readable log inside its timestamped run work directory.

The log MUST capture the operator-visible execution stream, including:

- run identity and start metadata;
- phase-start messages;
- 15-second heartbeats;
- warnings and errors;
- normal stdout/stderr that is useful to the operator;
- completion status and exit code when the process reaches normal finalisation.

The log MUST be written without suppressing the same useful output from the terminal.

At minimum the start metadata SHOULD identify, where applicable:

- environment;
- operation/mode;
- transition or profile;
- logical run/operation ID;
- repository and Git HEAD;
- UTC start time;
- process ID;
- run work-directory path.

The final log output SHOULD identify, where available:

- UTC completion time;
- elapsed duration;
- exit code;
- final status;
- structured report path;
- important domain evidence/report paths.

The logging implementation MUST preserve the real command exit status. Piping through `tee` or an equivalent mechanism MUST NOT turn a failed operation into a successful shell exit.

## Structured run report

Every qualifying invocation that has a meaningful structured result MUST leave a bounded machine-readable JSON report in, or directly referenced from, its timestamped run work directory.

The report SHOULD make it easy to determine without parsing the full log:

- what ran;
- where it ran;
- when it started and finished;
- how long it took;
- whether it succeeded or failed;
- its final domain status;
- which important evidence/report files belong to the run.

Where a subsystem already has an authoritative or established domain-specific report name and schema, that existing report MAY serve as the structured run report or be referenced by a small run summary. This contract MUST NOT silently replace, rename or weaken an existing domain report or authority boundary.

Large per-object/per-row detail SHOULD remain out of the bounded final report when it already exists in checkpoints, journals or other dedicated evidence. The persistent log is the operator-readable execution history; the JSON report is the concise structured outcome.

## Logs and authority

Operator logs are diagnostic records. They MUST NOT become migration authority, rollback authority, checkpoint authority, object identity authority or a source for cryptographic reconstruction merely because they are persistent.

A generic run-summary report introduced under this contract is also diagnostic unless a domain contract explicitly assigns authority to that report.

Existing reports and evidence that already have authority under a subsystem contract retain that existing meaning. This contract neither promotes nor demotes them.

Progress heartbeats, elapsed-time values, ETAs and logging metadata MUST NOT participate in hashes, deterministic schedules, checkpoints or success/failure decisions.

## Failure behaviour

The run work directory and initial log file MUST be creatable before an operation begins external mutation. If they cannot be created, a mutating operation MUST fail before mutation starts.

Once external mutation has begun, failure of diagnostic progress formatting or a non-authoritative heartbeat MUST NOT alter the domain operation's mutation, recovery or correctness control flow.

A later log-write failure MUST be surfaced clearly to the operator. It MUST NOT be allowed to falsify the underlying operation result or silently change its exit status.

On abrupt process termination, the run directory and partial log SHOULD remain available for diagnosis even when no final structured report could be completed.

## Secret handling

Logs and run reports MUST NOT expose credentials, tokens, passwords, private keys or other secret values.

Implementations MUST NOT dump complete process environments for convenience. Command summaries and metadata MUST omit or redact secret-bearing arguments and environment variables.

## Initial index-v3 adoption

For observation-history index-v3 work, the common execution layer SHOULD cover every potentially long operator phase, including where applicable:

- preflight checks;
- recovery-journal authentication;
- rollback-plan reconstruction;
- migration-plan/recovery reconstruction;
- Parquet verification/publication;
- canonical manifest verification/publication;
- v3 index publication;
- independent final verification;
- canonical v2 rollback restoration;
- v2 index rebuild;
- v2 index completeness verification;
- pinned runtime restoration and verification.

The implementation SHOULD centralise the 15-second cadence, elapsed-time formatting, ETA states, run-directory creation and log/report lifecycle rather than adding unrelated bespoke mechanisms to each phase.

## Validation principle

Before deployment, validate only that the shared mechanism is structurally viable: it can create distinct run directories, route operator output to terminal plus log, preserve the true exit status, and keep progress callbacks diagnostic-only.

Functional acceptance occurs through real operation on TEST, where the operator should be able to confirm that no qualifying long-running phase remains silent for more than about 15 seconds and that each invocation leaves its expected log/report artefacts.
