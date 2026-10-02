# Gensite v1 recovery and verification

Gensite v1 is a router over serving models. These changes improve its request policy and error transport; they do not train model weights, guarantee repairs, or create an autonomous agent inside the API gateway.

## Implemented

- Preserve Anthropic `tool_result.is_error` as internal metadata and forward explicit failures as SDK `error-text` results. Successful output that quotes an error remains successful when explicitly marked so.
- Issue an advisory recovery reminder after two recurring shell quoting or stale edit failures, even with intervening inspections and changed arguments. A successful attempt with the same tool resets that pattern. Pending calls suppress diagnosis of earlier calls.
- Retain existing detection of three identical calls/results and four consecutive failures. Error families are deliberately narrow to avoid treating changing compiler errors as no progress.
- Strengthen Gensite's working guidance: small verified changes, only exposed tools, respect caller permissions/budgets, untrusted tool/source content, and truthful completion evidence. Zero executed tests are not coverage; source presence is not deployment proof.

Client tool names, arguments, call IDs and result text are retained. The gateway does not execute client tools, insert retries, compact/delete client history, change permissions, or select a new serving model because of a failure. Recovery reminders use the existing Gensite reminder path and apply only to gensite-v1. Explicit Anthropic error transport is shared across models as a protocol correction. An advisory reminder can affect the next answer; this is not a guarantee that every consumer harness behaves identically.

## Offline trace replay

Run against a saved Claude Code stream JSONL file:

```powershell
pnpm exec tsx scripts/evaluate-gensite-recovery.mts 'E:\path\coding-stream.jsonl'
```

An optional `--out 'E:\path\new-report.json'` writes a new summary without overwriting an existing file. The replay does not execute commands in the trace, call APIs, or print source/tool arguments/results. It reports observed failures and reminder positions. Its counts are diagnostics, not coding-success scores. Unsupported or invalid events are counted as skipped; inspect that count before trusting coverage.

## What still belongs in the consumer agent

The consumer controls tool execution, repair attempts, local checkpoints, rollback, build/test runs and time/cost limits. It should run a relevant check after each coherent change, change strategy after repeated errors, and report an unresolved failure when its budget expires. The gateway cannot verify a local file or a passing build unless the consumer supplies trustworthy results. Never claim the prompt alone enforces these checks.

## Controlled improvement process

Use the Orbit failure as a regression task with explicit acceptance checks: valid configuration, passing typecheck/build, nonzero meaningful tests, actual rendered review findings, separate local service ports, authenticated integration or an honest disconnected state, and no invented completion claims. Compare baseline and candidate with identical tools, deadlines, output limits and source snapshots. Record completed-task rate, first-output latency, duration, errors, retries and credits. Repeat across multiple tasks and runs as described in GENSITE_V1_CODING_EVAL.md.

Maintain a consumer compatibility matrix for OpenAI chat, Anthropic Messages and Responses paths, including streaming fragmented arguments, error results, cancellation, MCP discovery and authentication failure. Local adapter regression tests do not substitute for actual Cline, Roo Code, OpenCode and CLI trials.

Promote prompt/router/model changes only after repeatable gains; keep versioned baselines and a rollback path. Do not automatically train or route from unverified generated corrections, silently record customer source as training data, or treat a single successful run as proof. Changing the coder tier requires separate model comparisons; no tier change is included here.

No database migration, production rebuild/restart, or automatic training is required or performed by this change.

## Local validation (2026-09-29)

The adapter/recovery/request suites passed 304 tests across 14 files. Streaming/API-route checks passed another 15 tests across three files. TypeScript checking passed. Offline replay of the original Orbit coding trace processed 34 events without skips, found five failed tool calls, and issued a recurring shell-quoting signal at event 34. This confirms the detector sees the observed failure pattern; the model's response to the improved guidance has not yet been benchmarked live.
