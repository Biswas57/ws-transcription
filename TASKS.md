# Tasks

Use this file as the working ticket list for future AI-agent turns. Work on only the requested ticket ID. Keep backend-local IDs canonical here; keep frontend/product tickets in the cross-repo reference section instead of mixing them into the backend backlog.

## Active

| ID | Status | Notes |
| --- | --- | --- |
| _None._ | | |

## Backlog

| ID | Status | Notes |
| --- | --- | --- |
| T-017 Long-session rolling synthesis | Backlog | P3, backend scaling. Add rolling checkpoint digests only if sessions beyond the current cap need bounded final-pass memory/cost. |
| T-070 Evaluate VAD-first audio filtering | Backlog | P2/P3, risky backend optimisation. Investigate pre-buffer Notes silence filtering with speech-clipping, CPU, false-skip, and stop-flush safety risks. |
| T-097/T-098 Transform quality evals | Backlog | P2, backend evals. Add Summarise compression and Reorganise preservation fixtures before further transform prompt/model changes. |
| T-100–T-103 Long-running and stateful Responses research | Backlog | P3, backend research. Assess streaming, background mode, stateful Responses, and stateless multi-step Notes before production adoption. |
| T-104–T-108 Future integrations and tool workflows | Backlog | P3, product/backend research. Explore app-owned tools, recording Q&A, document grounding, template recommendations, and external integrations with explicit consent. |
| T-109 Reject computer-use backend workflows | Backlog | P4, backend architecture. Document why desktop-style computer-use automation is not appropriate for the recording pipeline without a strong future requirement. |

## Completed Milestones

| ID | Status | Notes |
| --- | --- | --- |
| T-001–T-004 WS server bootstrap and auth hardening | Completed | P1, backend reliability. Stabilised manual clients, load-test defaults, token auth, and smoke recording flow. |
| T-005/T-009/T-010/T-013/T-062/T-065/T-069/T-094/T-095 Notes long-session reliability | Completed | P1/P2, Notes reliability. Improved continuation, transcript windows, cap enforcement, reconnect cap continuity, bounded live context, and long-session cost estimates. |
| T-006/T-015/T-016/T-067 Forms extraction and session stability | Completed | P1, Forms reliability. Hardened locked/excluded fields, short values, fail-open revision, idempotent stop, queue caps, safe logs, and mode-aware revision gates. |
| T-012/T-014/T-066–T-068 VAD, batching, overload, and latency | Completed | P1/P2, backend reliability. Added Notes VAD, adaptive batching, overload pause/recovery, queue pressure controls, and unused-constant cleanup. |
| T-008/T-011/T-011a/T-063/T-064/T-071/T-072/T-096/T-110–T-117 Notes live/final quality | Completed | P1/P2, Notes quality. Improved live append patches, markdown structure, current-notes preservation, Summarise identity, Reorganise reasoning, and live Responses rollout. |
| T-007/T-019/T-020/T-099 Notes transforms and async jobs | Completed | P1/P2, backend transforms. Added Summarise/Reorganise routes, strict preview outputs, and app-owned async transform jobs without changing WS contracts. |
| T-073/T-081/T-082/T-086/T-092/T-093 OpenAI privacy and usage posture | Completed | P1/P2, privacy/cost-safety. Added `store: false`, safe usage diagnostics, output-budget tuning, prompt-cache guidance, and data-retention documentation. |
| T-075–T-077/T-089/T-091/T-130–T-133 GPT modules, parsers, and diagnostics | Completed | P2, backend architecture. Split GPT modules, consolidated safe diagnostics/parsers, hardened provider logs, and kept `parse-gpt.ts` as the compatibility facade. |
| T-083–T-085e/T-090/T-094a/T-094b GPT eval infrastructure and decisions | Completed | P2, backend evals. Added offline fixtures, opt-in OpenAI eval runner, live Chat-vs-Responses comparisons, and model/reasoning decision reports. |
| T-123–T-126 Runtime architecture stabilisation | Completed | P1, backend architecture. Removed experiment flags, centralised `GPT_FLOW_CONFIG`, separated eval-only scaffolding, and documented stable runtime behaviour. |
| T-127–T-134 Backend cleanup and documentation compaction | Completed | P2/P3, backend cleanup. Removed repo bloat, hardened diagnostics/parsers, reviewed GPT boundaries, compacted tickets, and archived detailed history. |
| T-135 Add short-window Notes finalisation recovery | Completed | P1/P2, backend reliability. Added short-lived app-owned recovery for completed Notes finalisation results with owner/session guards and safe metadata-only diagnostics. |

## Cross-Repo References

| Product ID | Status | Notes |
| --- | --- | --- |
| T-180 Notes transform pending/cancel/stale UX | Completed | Web repo reference. Preview/apply transforms use run IDs so stale results cannot overwrite newer notes. |
| T-181 Safe performance observability | Needs verification | Web/backend reference. Verify safe metadata logs for template queries, Notes transform bridge latency/errors, and backend observability. |
| T-182 Add multi-step Notes undo/redo history | Backlog | Web repo reference. Add bounded undo/redo for manual edits, transform Apply, final replacements, and template-related note changes. |
| T-186 Frontend recovery UX for interrupted finalisation/transforms | Backlog | Web repo reference. Persist short-lived recovery descriptors and poll backend/web bridge recovery endpoints with session/source guards and no stale auto-apply. |
