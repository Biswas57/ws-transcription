# T-095 Long-Session Token / Cost Measurement Scaffolding

> Historical note: this report is an offline synthetic measurement scaffold. Current runtime architecture is documented in `DECISIONS.md` and `AI_AGENT_CONTEXT.md`; use this report as cost-shape evidence, not as runtime configuration.

This report is an offline, synthetic measurement scaffold. It does not call
OpenAI and it is not billing truth. Estimates use a simple 4-chars-per-token
approximation so the backend can reason about long-session cost shape before
and after bounded live Notes context.

## Scope

- Fixtures are synthetic process, meeting, study, and correction scenarios.
- Measurements compare the old unbounded live Notes patch input shape
  (full canonical `current_notes` plus the next `transcript_segment`) with the
  T-094 bounded context shape.
- No raw production transcript, notes, generated markdown, secrets, user IDs, or
  customer content are included.
- Runtime behaviour, WebSocket contracts, HTTP contracts, model routing, and
  prompts are unchanged by this scaffold.

## Fixture Estimates

| Fixture | Live patch calls | Current notes chars start | Current notes chars end | Unbounded input chars | Bounded input chars | Saved input chars | Saved est. tokens | Sample output chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `long-session-steady-meeting` | 6 | 7218 | 7764 | 46375 | 27062 | 19313 | 4828 | 534 |
| `long-session-topic-shifts` | 6 | 7105 | 7616 | 45720 | 26894 | 18826 | 4707 | 499 |
| `long-session-repetition-heavy` | 6 | 7147 | 7516 | 45456 | 26707 | 18749 | 4688 | 357 |
| `long-session-correction-late` | 6 | 7062 | 7519 | 45160 | 26527 | 18633 | 4659 | 445 |

## T-094 Bounded Live Context Estimate

The synthetic fixtures now begin above the live compaction threshold so the
offline estimator can show the T-094 before/after shape. In each fixture, the
first live patch call uses compact context because the current notes are already
larger than 6000 characters.

| Fixture | First compacted step | Unbounded est. tokens | Bounded est. tokens | Saved est. tokens |
| --- | ---: | ---: | ---: | ---: |
| `long-session-steady-meeting` | 1 | 11596 | 6768 | 4828 |
| `long-session-topic-shifts` | 1 | 11433 | 6726 | 4707 |
| `long-session-repetition-heavy` | 1 | 11367 | 6679 | 4688 |
| `long-session-correction-late` | 1 | 11292 | 6633 | 4659 |

## Paid Eval Alignment Note

The offline estimator remains the bounded-context savings source for T-094
because it compares unbounded and bounded live patch input directly. A paid full
eval run completed after T-094 and showed strong Notes live quality, but that
earlier run built Notes live eval inputs directly from fixture notes and should
not be treated as bounded-context proof.

T-094a aligns the paid Notes live eval runner with the runtime
`buildNotesLivePatchRequest(...)` path. Future runs with
`OPENAI_EVAL_FLOWS=notes-live` can now report bounded context metadata such as
original chars, context chars, saved chars, compaction state, and heading count
without logging raw notes or transcripts.

## T-094b Paid Eval Confirmation

A paid Notes-live-only eval now uses the runtime `buildNotesLivePatchRequest(...)`
path. The long-current-notes fixture reported bounded context metadata with
`currentNotesChars=6408`, `currentNotesContextChars=4313`,
`contextSavedChars=2095`, `contextCompacted=true`, and `headingCount=21` for
both Chat and Responses variants.

This confirms paid eval runtime-path alignment. The offline estimator remains
the source for broad before/after savings estimates because it compares
unbounded and bounded input shapes directly; paid eval token usage is useful
quality and provider-shape evidence, not billing truth.

## Observations

- Input cost grows with canonical note length even when each pending transcript
  segment is small; bounded context reduces that growth without mutating
  canonical notes.
- Topic-shift sessions increase heading and context surface area, which can make
  section selection more expensive over time.
- Repetition-heavy sessions can spend input budget on already-captured context
  unless duplicate suppression and future context reduction are effective.
- Late corrections require enough prior context to avoid preserving stale facts,
  so context trimming needs care.
- T-094 uses a deterministic outline plus recent-tail context for live patch
  prompts only. Full canonical notes remain available for patch application and
  finalisation.

## Non-Goals

- No paid eval run.
- No committed provider outputs.
- No user-facing limits, tiers, upgrades, or paywalls.
