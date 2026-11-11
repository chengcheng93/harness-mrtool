# Required Issue before every new MR

User correction is approved: a new MR must always follow successful automatic Issue creation and contain that Issue association. This is a CLI/domain hard constraint, not a default. Base 3b52c5cf32ebb337fc7f7eaf1d90c1aff933e755; continue isolated branch codex/thin-submit-future-milestone.

## Binding decisions
- Ordinary create accepts omitted workItem or relation:new only. Reject explicit none/closes/related and --upsert before GitLab planning/ticket consumption. Existing MR updates use update.
- Historical --resume may operate only on its authenticated existing IID and must never create; preserve historical read/update/verify structures.
- Legacy domain/adapter/HTTP creation paths cannot create a fresh MR. Remove fresh-creation behavior rather than add a bypass flag.
- Disable manual MR creation handoff before repository/push/render side effects; no second Issue creator. Preview is a new submission view and rejects legacy relations.
- Keep shared internal historical Request union and immutable Bundle1.2.0. New schema/context expose a small new-only view, not a second schema engine.
- Shared module src/contracts/new-submission.ts (Task2 owner) exports assertNewIssueSubmission(request:Request):void and newSubmissionRequestSchema (JSON value) for new-only public schema. Omission is normalized to new before assertion.
- Keep Issue POST then MR POST; Issue rejected/unknown/invalid receipt stops MR. No post-firstPOST queries/retries/compensation. Success includes Issue identity/URL and MR closes association.
- Version0.1.12, no new dependencies/config/protocol/AI calls. Skill<=80lines, static mirrors identical, generated semantics consistent.
- No changes to MR!168 or other production resources; this goal repairs the tool. Build/commit/push the authorized current branch after verification, no formal release/global install.

## Tasks
1. Write boundary: default-write-services, app/create-mr, commands/merge-request, GitLabclient legacycreate gate; regression freshlegacy/upsert rejection and resume cannotcreate. Preserve useful historical update coverage via seeded existing fixtures.
2. Public contract: new-submission helper, schema.show/context view, preview validation and manualdisabled error; tests new schema onlynew, legacy historical unchanged, no manualpush/network.
3. Skill/docs/version: remove explicitlegacy/manual newcreate advice, keep history-only operations, version0.1.12 and actual package contracts.
4. Migrate affected legacy tests to seed already-existing historical states rather than invoke now-prohibited creation. Do not delete historical security/audit coverage or add test-only production switches.
5. Independent combined spec/quality review; focused/related regression, typecheck, SEA build+native smoke, actual ZIP/size audit, all unit/contract test files across the broad and scoped runs, and the affected integration files. Unchanged native installation/platform matrices are outside this focused repair. Record every failure/skip and coveringretest honestly; source/payload invariants audited.

## Execution
Separate owned paths, parallel implementation, serialized commits. Root owns integration and push. Use TDD logs/reports in this workspace, no repeated design approval. Keep changes small; no new generic workflow or permission engine.
