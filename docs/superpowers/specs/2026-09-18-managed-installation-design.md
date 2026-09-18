# Managed installation / recovery design — reviewed, 2026-09-18

Status: **technical design review passed; production enablement held**. Independent scoped re-review on September 18, 2026 closed all four original P1 findings in draft SHA-256 `7ee183b8d1b341fac9fa58b6e7d68369cf765e0fcd778d1911c0a19b104fb460`. GO for non-I/O parser/classifier/data-only types and native primitives in isolated test roots. This is not native correctness proof, human approval, or permission to enable real-root mutation before the native/crash/installer convergence gates. The full release/install goal and original requirements remain binding.

Revision scope: this spec only, plus the requested external revision report. Production/test code, fixture implementation, builds, tests, commits and subagents are outside this revision. The independent review is `/Users/lxc/Documents/Codex/2026-09-18/gong-2/work/execution-20260918/managed-design-review.md`.

## Controller rulings for the first implementation slice

- Preserve existing `ReleaseSetRecord.transactionId`, deterministically derived from authenticated provenance (not a new field signed into the channel); installation attempts use a separate random `attemptId`. Archive hashes and extracted native hashes are distinct.
- Existing template receipt/history sequence is 42. The shared native fixture family uses signed channel sequences **43, 44, 45**, not the earlier plan's invalid sequence-41 example or a divergent native42 seeded from the origin's placeholder42 trust state. This preserves historical receipt anchors rather than rewriting them.
- The initial code slice is test fixture construction and its contract tests only. Native files, markers and active pointers are not mutated by that slice. Later journal/authority/installation slices require the review below to resolve architectural blockers first.
- A cache-only recovery must not run before outer installation reconciliation. Windows invocation N with canonical P is explicitly pending; it is not installed N.
- This design is an argument from the existing requirements, not a weakening of rollback authorization, path safety, or truthful output.

---

## Historical analysis baseline and revision scope

**Date:** September 18, 2026. **Disposition:** revised proposal for re-review, not implementation approval.

**Inspected checkout:** `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918`, HEAD `2c6b681631f9630c0ab7bd4f5d08ec95554406ae`; working tree clean at initial inspection. This analysis is independent of T01/Windows CI. The original analysis wrote only its external analysis document and performed no repository edits, commits, builds, tests, installation, credential use or network requests. The present follow-up edits this draft spec and its external revision report only. Source observations below are static evidence, not native-platform validation.

**Concurrent-work audit:** on final inspection, HEAD had advanced externally to `1825ad77aa259cbdcaee555dec6eb07301cd889d` and CI/test files had concurrent uncommitted edits. They were left untouched. A read-only `git diff` against the requested baseline showed no drift in the inspected production source, requirements file, or native release fixture; their line references below still describe `2c6b681`. This is not a claim that the whole worktree remained clean.

## 1. Recommendation and non-goals

Add **one outer installation transaction/recovery coordinator**, with the existing active release-set record as the sole committed release-selection pointer. It coordinates three different things: actual canonical executable bytes, the existing installer marker, and the authenticated cached CLI/Template tuple. Neither a cache record nor a platform adapter's return value is an installed proof.

Use a durable write-ahead installation journal, authenticated snapshots, a single branded update lease per mutation epoch, and pinned filesystem authorities. Publish the pointer only after the canonical executable and marker match the proposed snapshot and pass final verification. Normal startup must resolve the outer journal before choosing a Bundle or permitting side effects. This is recoverable consistency, **not a multi-file atomic rename**. [P:7,135–176,202–220,266–315; R:386–412]

Considered alternatives:

1. **Wrap `activateReleaseSet()` with an executable copy:** reject. Cache recovery can commit next before any canonical-file proof, and that API has no marker/native dependency. [A:164–193,253–265]
2. **Restore the rejected managed adapter and put a service over it:** reject. It retains the false-success, one-update-only, pathname-race, and in-process-only compensation problems documented in the review. [V:16–75; X:51–56]
3. **Outer coordinator + narrowly extended existing primitives:** recommend. Reuse signed acquisition, snapshot authentication, cache staging, immutable native materialization, and lock identity. Extend the missing authority/durability seams rather than treating observations or callback booleans as capabilities.

Do not redesign MR behavior, Skill activation, signing, channel schema, or CI. No permanent launcher, arbitrary-path rollback, alternate trust root, or generic untrusted installer dependency is proposed. T07 wiring remains a later integration slice; it is not evidence that T02/T03 already implement installation.

## 2. What the baseline actually proves

| Existing component | Reuse safely for | What it does **not** prove / required restriction |
|---|---|---|
| `createProductionReleasePreparer().prepare(force)` | Fresh signed acquisition, compatibility, archive download, authentication, and a second channel payload comparison. | Does not install, activate, or authorize under the future installation lease; loaded Skill protocol is currently `null`. Recheck current accepted policy under the mutation lease. [Q:37–57] |
| `authenticateReleaseSnapshot()` / `createReleaseSetSnapshotVerifier()` | Source-pinned signature/provenance, exact platform archive size/hash, receipt/history, Bundle files, archive members, executable header; equivalence of exact signed channel payloads. | Authentication uses the snapshot's recorded trust history, not automatically the newest persisted policy. Header validity is not successful SEA execution. [S:43–64,68–103,131–139] |
| `UpdateCache.stageVerifiedReleaseSet()` / `loadStagedReleaseSet()` | Persist/re-authenticate an immutable candidate without selecting it. Load previous/next snapshot by validated record. | `cli.bin` is archive content, not the canonical executable. `storeVerifiedReleaseSet()` publishes the pointer; it is not a harmless staging call. [C:46–52,324–337,989–1034] |
| `commitStagedReleaseSet()` | Final cache publication after the outer coordinator authorizes it. | It does not itself compare predecessor sequence/current policy/canonical CLI/marker. Its `writesBlocked:false` result is not policy authorization. [C:1038–1075] |
| `activateReleaseSet()` / `recoverReleaseSet()` | Existing cache-only semantics; tuple digest and forward-sequence/equivalence rules are useful. | Unmodified recovery can advance P→N based solely on cache evidence; new managed startup must not call it first. Existing cleanup is not aware of outer installation ownership. [A:164–219,239–265] |
| Activation journal helpers | Strict JSON/canonical encoding, bounded record shape, tuple digest patterns. | Current reader opens with `"r"`; writer/remover use pathnames, no branded lease/root handle, and no full owner/link checks. They cannot simply become the installation writer. [J:56–69,84–112,142–185] |
| `createNativeExecutableStore()` | Materialize/reverify authenticated executable bytes under the branded state-root lease; bounded fixed members, sealed storage, anchored creation. | Produces private state-root files, not install-root same-volume stage; returned path/hash is an observation, not permission to execute or mutate. [N:43–90,109–138] |
| `verifyNativeReadiness()` | Bounded probes, isolated environment, reverify before and after every child, including failed probes. | Hard-wired to the state native store; it does not probe the install-root stage or canonical path. Extract an internal verified-target runner, not a public arbitrary-path self-test hook. [D:92–103,125–160] |
| `verifyInstalledRelease()` | Strong point-in-time comparison of canonical native bytes and strict v1 marker against signed snapshot; optional same-root branded lease. | Explicitly not an execution/mutation capability; no subprocess or latest-policy grant. Windows ACL enforcement belongs elsewhere. Closes its handles before returning. [I:16–25,74–115] |
| `withUpdateLock()` / `assertUpdateLockLease()` | Module-private WeakMap brand, normalized state-root binding, frozen system lease, process-lock lifetime. | A lease protects cooperating participants, not arbitrary filesystem paths or an installation root bound to another state directory. Must also pin installation/state roots. [L:20–38,85–120; K:138–163,289–304] |
| `writeAnchoredFile()` | Fixed executable exclusive creation using inherited directory authority on POSIX / pinned ancestor handles on Windows; helper completion requires `close`. | Only accepts two executable basenames; does not replace, write marker/journal/pointer, remove backups, or authorize latest policy. A separate narrowly typed extension is necessary. [W:9–14,26–57,60–110,124–170,173–204] |
| Windows rotation/recovery | Existing three-phase rotation cases and interruption tests; no business replay in persistence helper. | No lease, outer attempt ID, signed expected hashes, marker, ACL capability, or release-set commit binding. Removes inner journal early; rotation also removes existing `.old`. Must be adapted, not exposed as the managed transaction. [H:19–60,88–114,498–584] |
| Windows write-through mover | Existing no-replace move/flush behavior and its tests inform the native adapter. | `File.Move` by absolute pathname is not anchored replacement. Timeout settles after a grace period even without observed child close; a managed transaction cannot compensate while a writer might still mutate. This is a reuse boundary, not a T01 CI diagnosis. [M:13–37,56–58,202–211] |
| `runBoundedUpdateHandoff()` | Bounded explicit piped-input transport, detached input copies, output/exit forwarding building block. | Caller supplies executable and spawn function; envelope is descriptive, not authenticated launch authority. It consumes its input stream and is not the TTY route; no outer transaction claim or live-child recovery protocol. [F:20–55,87–124,135–169] |

**Two compatibility traps:**

- `ReleaseSetRecord.cliSha256` is the **CLI ZIP/archive** digest. The native executable digest must be independently derived from `authenticateReleaseSnapshot(...).executableBytes`. The v1 marker already contains both. The rejected rollback compared these different digests. [C:324–333; S:123–127; I:89–106; X:56]
- The record's `transactionId` is deterministically derived from its authenticated record, including provenance digest; the verifier recomputes it. Do not replace it with a random installation ID. Use **`attemptId`** for the installation attempt and carry `next.transactionId` unchanged. Windows inner journal carries both bindings. [S:42,92,123–127]

## 3. Invariants and managed roots

### 3.1 The objects that must agree

Let **P** be the last committed tuple and **N** the proposed tuple. A tuple comprises authenticated snapshot/provenance, CLI archive digest, extracted executable digest/size, Template archive and verified Bundle contents, schema/compatibility, and signed release identity. Let **C**, **M**, **A** be canonical executable, v1 marker, and active pointer.

`installed(N)` requires, in one validated lease epoch:

1. Re-authenticate N from actual cached bytes, not paths or journal hashes alone.
2. C's native member digest/size and stable file identity match N.
3. M has exactly `{schemaVersion, repository, tag, archiveSha256, executableSha256}` and matches the authenticated CLI component. Keep schema v1: adding releaseSetId/state-path fields would break the existing verifier's exact-field contract. [I:100–106]
4. Bounded canonical probes complete; afterwards re-open/rehash C and reread/pin M and root identities. A version string is insufficient. Then A is exactly N, and the authenticated Template is N's Template. Compare observation releaseSetId, CLI version, channel payload digest, archive/member digests separately.
5. Current locally accepted policy permits use. A historically authenticated record may still be revoked by newer accepted policy.
6. No unresolved mutation or possibly live writer remains. Only then mint public `installed`/`unchanged`.

Pointer publication is the transaction's **commit decision**; installed reporting happens later, after post-publication readback and verification. A committed journal alone is not proof. `unchanged` requires the same physical checks, not merely equal versions. Same authenticated payload acquired through different valid provenance histories can keep the existing record via the verifier's equivalence check. [A:242–248]

An invocation must use one frozen, authenticated CLI/Bundle selection. Existing running P code does not become N merely because the pathname now names N. After replacing C, the updater hands off to N or ends with a repair/update-required result; it must not continue the original business in P code with N's Bundle. Future invocations select after recovery. Already authorized invocations pin their Bundle/launch identity and are not silently rebound by later pointer changes.

### 3.2 Reciprocal enrollment: one installation, one activation namespace

An enrolled pair is **one-to-one in both directions**: installation identity I binds exactly one state-root activation namespace S, and S binds exactly one I. Sharing S between two installations is forbidden even if their current bytes match: S has one active pointer, so serialization cannot keep two canonical paths coherent. Current lease branding alone does not enforce either direction. [L:23–37,107–119; R:411–412]

Use two bounded, strict, canonical enrollment records, separate from the unchanged v1 installer marker:

- installation slot `.harness-mrtool-managed.json`;
- state slot `installation-owner.json`.

Both contain the same version, random `enrollmentId`, permanent `installationId`, repository/platform/trust-config fingerprint, **both** stable root identities and fixed locators, bootstrap policy generation/digest, and phase `preparing | enrolled`. Locators are equality checks against explicitly opened roots, never authority to follow a record to a new path. Both records must agree, and roots/ACLs/ancestry must meet the native authority contract. A legitimate root move or replacement is an explicit migration, never silently new enrollment.

**Fixed lock order:** any enrollment/repair operation that can change either binding acquires the installation-root enrollment guard **E(I) first**, then the bound/requested state-root update lock **U(S)**; it releases U then E. Never hold U while acquiring E, acquire two installations/states, or redirect to another root discovered in JSON. Ordinary activation takes U only and validates both records; it never changes enrollment. Enrollment waits on U before changing either record, so it cannot race ordinary activation. Different installations contending for S serialize on U and inspect S's owner before publication; different states contending for I serialize on E and inspect I's owner. Conflicting nonempty evidence is never overwritten or deleted. A worker modifying enrollment must itself retain E+U or acquire both in this order (§4.5).

**T08 enablement gate:** versioned installer, adoption/repair, CLI, and native workers must implement this same enrollment and U-lock namespace before installation is enabled against real roots. “Do not run them concurrently” is not a substitute. T03/T04 development may use explicitly pre-enrolled isolated fixtures. No permanent second activation lock or launcher is introduced; E is the setup/repair guard only.

### 3.3 Enrollment publication and crash outcomes

Bootstrap is reachable only through explicit installer/adoption entry under E→U. Normal startup never creates missing enrollment or trust evidence. New roots must be explicitly selected user-owned directories with no prior managed state, activation/journal/retention evidence, or unexplained transaction artifacts. Adoption of a legacy installation additionally needs the authenticated immutable snapshot proving its canonical executable and marker; an embedded Bundle or version string alone is insufficient. Existing accepted trust, if any, is preserved, not replaced with bootstrap keys. Source-mode Node is never a canonical install target.

Ordered writes (all through the required anchored executor, with file and supported parent durability barriers):

1. Under E→U, inspect both roots and all existing evidence without quarantine/deletion. If either binding exists, do not allocate another enrollment ID: use the outcomes below. Derive fixed logical slots and a fresh enrollment ID only for a proven explicit new enrollment.
2. Exclusively publish **S:preparing** first, reserving its activation namespace for I. It records the intended bootstrap-policy slot/digest; it does not grant activation. This first reservation is the only pre-control registration write: the native enrollment executor already owns E+U and cannot spawn a mutating descendant. Initialize `installation-control.json` for this exact enrollment ID/first executor, then exclusively publish matching **I:preparing**. No canonical replacement occurs in enrollment.
3. Verify/bootstrap accepted policy as allowed above, then durably establish the complete accepted-policy checkpoint and head in §4.3, and the required initial authenticated active/installed evidence for the bootstrap/adoption transition. Read back both preparing records and all initial evidence. Ordinary apply/rollback still reject `previous:null`.
4. Replace only the expected matching I record with **I:enrolled** and sync. Then replace S's matching record with **S:enrolled** and sync. Read back both exact records, root identities, policy head, C/M/A and initial `installation-control.json` plus empty retention-catalog initialization. Only this final conjunction enables normal managed entry. No single record is a commit pointer for executable selection.
5. Keep both enrollment records for the lifetime of the installation. Removal/rebinding is outside ordinary update/cleanup; explicit migration must preserve current policy and cannot infer an empty installation from missing files.

| Durable enrollment observation | Required outcome |
|---|---|
| Neither binding and no managed evidence | `unenrolled`; normal entry rejects. Explicit installer can start step 1 only with proven new/adoptable roots. |
| S:preparing, I absent; or matching preparing records | `enrolling`; no channel/bootstrap fallback on ordinary entry. Explicit repair under E→U may finish **the same enrollment ID** after proving intended roots and bootstrap state; otherwise retain evidence and block. |
| I:enrolled, S:preparing, matching IDs/evidence | `enrolling`; repair verifies all step-3 evidence and completes S. Never claim enrollment from I alone. |
| Both enrolled, exact reciprocal identity and complete policy/bootstrap evidence | `enrolled`; normal recovery may proceed under U. |
| Missing counterpart after recorded enrollment, conflicting owner/ID/root, invalid record, missing required policy, or unsupported durability | `inconsistent`; security/repair block, no reallocation, guessing, or overwrite. |
| Crash before the first durable reservation | No activation was permitted; unknown temporary artifacts remain untrusted. Do not auto-delete them or treat their presence as proven fresh roots. |

A one-sided reservation does not atomically reserve the other volume. If another explicit enrollment wins the still-unreserved root after a crash, the old reservation becomes conflicting and stays repair-only; **neither recovery path may force its binding over the winner**. At most the fully matching reciprocal pair can activate. This acknowledges the cross-volume boundary instead of claiming atomic dual-record publication.

Enrollment records are local ownership/continuity evidence, not signatures or protection against an adversary rewriting every same-user file. Root pins and handles constrain writes and detect the specified substitutions; fully hostile same-UID code is not made harmless by the process lock.

## 4. Capabilities, lease epochs, policy and filesystem authority

### 4.1 Authority ladder

`prepared bytes` → `authenticated snapshot` → `current-policy approval under lease` → `pinned installation authority` → `verified target launch/publication` → `final observation`.

No step is interchangeable. The new coordinator keeps owned byte copies and frozen records in private module state. An internal `InstallationEpoch` is branded in a WeakMap and binds the actual lease object, both root identities, installation ID, attempt ID, snapshot digests, current trust-state generation/payload, and opened native authorities. No caller-created structural object, serialized journal, boolean self-test, or TypeScript-only brand can manufacture it. `assertUpdateLockLease()` remains necessary on entry and at asynchronous boundaries; do not mutate or wrap away the existing frozen lease behavior.

Journal decoding yields untrusted evidence, not an epoch. Restart re-acquires a fresh lease, reopens roots, re-authenticates snapshots, loads the latest locally accepted policy, and creates new private authority. A lease cannot be serialized to a helper or transferred as JSON; a helper/child obtains its own lease after the prior epoch is released.

### 4.2 Channel and trust-state lock gap

Before any acquisition, enforce the enrolled-policy gate in §4.3; missing enrolled state must not reach the current preparer/channel bootstrap path. Acquisition then stays outside the long installation lease (its policy load/save epochs still use U and the enrolled-policy gate). Under the installation lease: inspect/recover prior state; load current accepted trust; reconfirm candidate policy; authenticate owned candidate again; record intent; stage/install; reverify; publish.

Do **not** call the current `channel.check()` unchanged while holding the installation lease. `check(force)` calls state `load()` and `save()` without a lease. State `load(lease?)` exists, but `save(value)` lacks the optional lease even though its internal locking helper supports it. This would nest acquisition. [Q:37–57; G:78–116; U:325–349,572–574,647–652,738]

Propose backward-compatible additions:

- `ProductionChannelClient.check(force: boolean, lease?: ProcessLockLease)`;
- `UpdateStateStore.save(value: UpdateStateValue, lease?: ProcessLockLease)`;
- propagate that same lease through **all** load/save/fallback paths; validate root binding at the entry;
- perform the final bounded channel check under the installation lease for explicit fresh apply/rollback; compare exact payload identity with the prepared candidate and re-evaluate minimum/revoked/Skill compatibility. If it changed, exit `CONCURRENT_UPDATE` before canonical mutation and reacquire a candidate outside the lease. Do not silently install the stale download.

Use the existing fixed network and readiness budgets; no polling/retry expansion. Freshness means most recently successfully checked/accepted policy at this boundary, not an impossible guarantee that a remote publisher cannot change it a moment later. Recheck local policy at later launch/commit epochs, particularly deferred Windows persistence. Recovery may use durable authenticated local policy when offline, never downgrade its high-watermark.

### 4.3 Accepted-policy continuity: enrolled absence is not bootstrap

Verified source gap: current state `load()` returns null for `ENOENT`; `assertPermittedTransition(null, next)` accepts a first state; channel checking then uses `createTrustState(bootstrapKeys)`. Historical snapshot authentication instead uses its own recorded accepted history. None proves that a later accepted high-watermark/revocation was never lost. [U:452–475,490–498; G:104–115; S:81–85]

**Mandatory admission rule:** normal code derives mode from reciprocal enrollment, not a caller boolean. In `enrolled`, `enrolling`, or `inconsistent` mode, missing, malformed, identity-unprovable, or discontinuous accepted-policy evidence is `UPDATE_SECURITY_ERROR`/repair-only **before network acquisition, cache selection, business admission, or any save that could replace it**. The gate applies to prepare/check/status/preflight/apply/rollback/helper/repair and to every under-lock save, including 304/unavailable paths; an earlier successful check does not excuse later disappearance. No `stored ?? createTrustState(...)` branch is reachable for enrolled roots. Only explicit first enrollment under E→U can use cold bootstrap. Resuming a proven, still-incomplete **first** enrollment may initialize only its recorded bootstrap generation/digest from the original authenticated full checkpoint; no channel advancement is allowed until both bindings are enrolled. This narrow step-3 exception never applies to an enrolled installation or to normal entry into an `enrolling` root.

To make a claim of policy recovery concrete, require a bounded **accepted-policy checkpoint protocol**, not an arbitrary historical backup:

- fixed state-root `accepted-policy-head.json` binds installation/enrollment IDs, trust-config fingerprint, monotonically increasing local generation, complete accepted-state digest/size, highest sequence and accepted payload digest;
- the head names a logical generation slot containing the **entire** validated `StoredUpdateState`: accepted envelope, keys/rotation proofs, immutable history anchors, accepted transition and validators. The slot name is derived from the generation; no journal-provided pathname. Signed policy is reauthenticated using the production trust root and prior transition, not trusted because its digest matches;
- `update-state.json` remains the existing API's compatibility record, but managed loading additionally requires it to match the current head/checkpoint exactly. This is a required new storage gate, not baseline behavior. At most current, predecessor and one in-flight checkpoint are retained; no unbounded ledger is required.

Policy acceptance under U: (a) require complete current head/checkpoint/compatibility record; validate the proposed monotonic transition; (b) exclusively write/flush the proposed full checkpoint; (c) atomically publish/flush the expected head to the proposed generation; this is the **policy acceptance decision**; (d) publish/flush and read back matching `update-state.json`; only then return a normal successful check. An ambiguous head-write result is inspected, never treated as definitely unchanged. Same-sequence exact-policy replays may update validators/generation but cannot change trust or signed payload.

| Policy interruption/loss | Allowed action |
|---|---|
| Proposed checkpoint exists but head is still previous and compatibility record matches previous | No new policy was accepted. Preserve current state; reclaim only registered unreferenced checkpoint evidence after safe settlement. |
| Head is new; compatibility record is old/absent; exact new full checkpoint authenticates | Enter trust-repair gate. Explicit repair under U may restore **exactly that head-selected checkpoint**, then read back; never choose the lower-sequence record because it is easier to load. Ordinary acquisition cannot bootstrap/save around this condition. |
| Head/checkpoint missing, invalid, or mismatch cannot be proved; enrolled C/M/A still authenticate | Block. P/N provenance, installation-journal preparation digest, enrollment's initial policy digest, and a fresh channel response do not prove the latest previously accepted policy. They cannot reconstruct current authority. |
| Head authenticates current checkpoint but an older valid state file was substituted | Reject discontinuity; repair only to the head-selected complete state. Do not silently lower sequence/history. |
| Both policy witnesses lost | No reset-to-zero or “reinstall to forget” path in this protocol. Recovery needs independently preserved evidence of the **latest complete accepted state**; without it the installation remains repair-blocked. |

Repair validates the complete history/transition and head binding, not just `highestSequence`. A stale checkpoint is never fallback merely because its signature is valid. Existing storage code does not implement this protocol or anchored policy/head mutation [U:711–728]; it is required implementation plus native crash tests. Loss/replay of **all** local continuity witnesses by the same-user adversary remains outside the local integrity guarantee; this does not authorize ignoring a detected loss.

### 4.4 Native authority primitives, not more path checks

The installed verifier already pins reads; the anchored writer already demonstrates descriptor/ancestor-pinning creation. Reuse those approaches, but their current APIs do not provide the required mutation set. [I:27–66; W:26–110,167–204]

Add a **closed set** of internal anchored operations: create bounded transaction file; read bounded metadata; replace expected canonical member; replace expected metadata member; restore verified backup; remove only expected owned file; sync appropriate parents. The logical-slot inventory explicitly includes reciprocal enrollment, accepted-policy head/checkpoints and compatibility state, outer/Windows journals and worker receipts, marker, active pointer, retention catalog/backup members, and identity-checked cleanup. All mutating operations, including metadata and cleanup, obey the executor lifetime protocol in §4.5. Select logical slots, not arbitrary paths. POSIX operations are relative to held directory authorities, not `lstat(path); rename(path, ...)`; Windows mutation must hold suitable native ancestors/file identities and enforce ACLs/reparse/link checks through the operation. Reject unsupported assurance rather than falling back to pathname-only mutation.

The extension must cover **metadata and active-pointer publication**, not just the executable. Current activation-journal/cache atomic writers are pathname based; merely hardening the installer would leave the state-side authority weaker than T03's proposed contract. Preserve public cache semantics, but add an internal anchored publisher for managed commits and a non-destructive recovery reader. Cached snapshots still need their existing cryptographic and complete-tree checks. [J:142–185; C:505–535,791–820,1128–1139]

State root and install root can be different volumes: cache/archives stay in state storage; **copy authenticated member bytes into a private transaction stage inside the installation volume**, rehash and flush there, then publish with same-volume native operations. Do not rename from the state native store or inherit the rejected blanket cross-volume failure. Multi-volume journal and install writes are ordered durable operations, not one physical atomic transaction.

Durability rule: durable intent → native mutation → file/required directory durability barrier → durable progress receipt. Every barrier may fail. Failure never means “nothing happened”; inspect actual files on restart. Directory-sync suppression in existing helpers is not blanket evidence of installation durability. Where the platform cannot guarantee a recoverable barrier, retain evidence and expose repair/pending, not installed.

### 4.5 Native writer lifetime: lock-owning executor and stale-work fencing

**Selected required protocol:** each mutating epoch uses a temporary native executor that is **both the OS owner of U and the only process performing that epoch's managed filesystem writes**. Enrollment writes additionally retain E→U. The executor does not delegate a mutation to an independently living descendant. The coordinator performs authentication/selection through the bounded protocol; cross-process plans remain descriptive until the executor authenticates current evidence and admits them while holding U. It never serializes a JavaScript lease as authority.

This is **not** the baseline implementation: its lock helper can release on coordinator EOF while a separate Perl/PowerShell writer remains alive. Waiting for writer `close` protects a live caller, not a caller killed before that wait. The existing write-through mover can even settle its timeout without observed close. [K:248–275; W:124–164,191–200; M:202–211] Retaining a directory handle alone is also not retaining the update lock. The required executor/lock integration must be implemented and tested natively before any managed mutation path is enabled; no fallback to today's uncontained writer is allowed.

A fixed, bounded `installation-control.json`, initialized at enrollment, records installation/root IDs, monotonically increasing `authorityEpoch`, current/queued operation IDs, attempt/revision/tuple digests, logical mutation slots, and worker status `scheduled | running | drained | revoked`. It contains no business requests, tokens or arbitrary paths. Missing/corrupt control in an enrolled root blocks. At most one worker is `running` under U; allow at most four queued bounded operation descriptors, rejecting excess rather than unbounded accumulation.

| Executor boundary | Exact authority and crash rule |
|---|---|
| Schedule a future helper/writer | Under U durably record its random worker/operation ID, expected attempt/revision, allowed operation and tuple digest **before spawn**. A scheduled process has no mutation permission. |
| Spawn delayed/unknown worker | Pass only the private descriptor/IPC binding. Before **any** write it must acquire U itself, validate reciprocal roots and current policy/control/journal, and consume its still-current scheduled entry. Wrong/missing/retired attempt or stale revision rejects without mutation. No recorded PID is an exception. |
| Open a new coordinator/recovery epoch | Native executor acquires the same pinned U, inspects prior evidence, and advances the persistent authority epoch. Its first bounded write is its control registration while already owning U; no pre-registration mutation or spawned mutating descendant exists. A torn/uncertain registration blocks until inspected. Revoke stale scheduled entries before restoring, cleaning or retiring an attempt. |
| Admit a mutating operation | While retaining U, authenticate its complete bounded plan, durably record `running` and write-ahead slot intent, then mutate via held native authorities. Require exact current attempt/revision; restrict to one admitted operation at a time. |
| Coordinator dies/IPC closes during operation | Executor still owns U. It may finish only the already admitted bounded operation and its durability/receipt writes, then drains; it must not admit more buffered commands after owner loss. Alternatively it can fail with evidence intact. No successor may compensate while U is held. |
| Executor dies or becomes hung | On death its OS-owned lock/handles are released only when it can no longer write; on hang U remains held and callers time out/preserve evidence. Never break a lock, remove its pathname, or infer quiescence from elapsed time/PID absence. |
| Drain / release | Stop accepting frames, complete or abandon the bounded operation with durable outcome/uncertainty, persist `drained` when possible, close all mutation authority, and release U. Release permanently invalidates the epoch; a still-live process must reacquire and validate a **new** epoch before any further mutation. |
| Recovery acquires U after an orphan | Acquisition of the same identity-bound OS lock proves no compliant old executor still holds write authority, regardless of stale PID/`running` evidence. Advance the epoch, revoke queued old operations, inspect the actual mutation outcome, then recover. A late worker must reacquire and will reject the revoked/missing/stale entry. This proof relies on the required single-process executor contract, not process enumeration. |
| Timeout / kill request | Neither settles a writer. Preserve the reservation and request drain/termination; only direct process/authority settlement or successful successor U acquisition **with the above fencing guarantee** permits compensation. If the guarantee is unavailable, return pending/repair-blocked. |

Readers/business children are a different lifecycle: they cannot mutate installation metadata directly and must use a new executor epoch for any such operation. Their live executable/Bundle pins still prevent retirement/cleanup (§7.1). A dead parent or all recorded PIDs absent proves neither writer nor launch quiescence.

**Required native primitives and tests — absent or insufficient in baseline:**

1. OS lock ownership co-located with the mutation executor, independent of the coordinator's pipe lifetime; no outstanding mutation descendants at release; stale queued-command rejection after release/reacquisition. Fault tests kill coordinator and executor before/during every write on both Darwin ARM64 and Windows x64.
2. Anchored expected-identity metadata replacement and deletion for **all** slots in §4.4, including control, policy, enrollment and retention. Atomic no-replace/replace semantics, file/parent durability and lock identity must be characterized on supported local filesystems. Until native tests establish them, only isolated fixtures are in scope; network/unsupported filesystems fail closed.
3. Gated spawn / private one-child channel / trustworthy process and launch-use settlement (§7.1), with no managed-write authority in the unregistered child and no inherited grant channel in unrelated descendants. Kernel process handles or equivalent tested launch supervision must prove settlement; PID checks, process-group kill requests, or a timeout alone are insufficient. Unsupported launch settlement blocks admission/cleanup rather than assuming success.
4. A mutation result that is ambiguous after native failure must remain journaled. Parent/helper shutdown cannot convert it to “no mutation” or an installed result. No native implementation is claimed by the interfaces in this spec.

## 5. Outer journal and mutation protocol

### 5.1 Durable record

Propose bounded, canonical, strict-JSON `installation-journal.json`, version 1, under the enrolled state root. Cap at 64 KiB; reject duplicate keys, unknown fields/phases, noncanonical encodings, oversized values, invalid identifiers, accessors at in-process validation boundaries, and trailing bytes. Each nested record has an exact discriminated schema.

Required evidence:

- `attemptId` (fresh random identifier), `transactionId` (`next.transactionId`, unchanged), operation `apply | rollback`, platform, installation ID, stable state/install root identities;
- phase and monotonic revision; explicit terminal outcome `next | previous` when resolving;
- full validated previous and next `ReleaseSetRecord`; tuple digests; signed payload digests; independently derived executable member hashes and sizes; expected marker bytes/digests;
- exact locally accepted authorization sequence/payload and trust-state digest at preparation; references to durable authenticated snapshots, not arbitrary URLs or paths;
- transaction-owned slot inventory and observed identities as created: staged executable/marker, previous backup executable/marker, and Windows inner-journal identity/binding;
- for **every** mutating operation: control authority epoch, worker/operation ID, expected journal revision, admitted logical slots and running/drained/revoked receipt binding (§4.5);
- for deferred execution: launch/reservation ID, private descriptor digest and issued-grant digest, parent/child launch identities and lifecycle `reserved | registered | claimed | ack-issued | admitted | completed | outcome-unknown | revoked`, plus launch-use settlement evidence (§7.1). No raw grant, stdin payload, tokens, auth values, or replayable business request in the installation journal.

All paths are derived from fixed roots, platform constants, and a restricted random attempt ID. Prefer logical slots in the record. Any serialized root locator is only compared against the enrolled root; it is not accepted as a write target. A recorded hash is not self-authenticating: rederive it from authenticated archives.

Use `next.transactionId` for existing cache-directory identity and `attemptId` for temporary ownership. Retain P as a verified snapshot plus transaction-specific backup pair; “retained” is not “unfinished.” Never reject a new transaction merely because a previous committed backup exists.

### 5.2 Phases

```text
stable(P)
  → preparing                 durable slot intent; build/verify cache + install stage + backup pair
  → prepared                  all candidate and predecessor evidence durable; no canonical mutation
  → execution-pending         Windows only; N executes under a claimed invocation, A remains P
  → publish-intent            decide to persist; no further business launch in this transaction
  → canonical-published      C=N, M may still be P, A=P
  → marker-published         C=N, M=N, A=P
  → commit-intent            precommit canonical probe + rehash passed; pointer may be P or N
  → committed                A=N; re-read all evidence before reporting installed
  → retention-transfer       publish/read back terminal slot ownership in catalog
  → ownership-transferred    derived from matching catalog receipt; terminal journal stays frozen
  → journal-retired          catalog/control now preserve ownership and stale-worker fence
  → cleanup                  identity-scoped retirement; retain deliberate predecessor
  → stable(N)

Any precommit failure:
  → compensating             explicit durable restore intent
  → aborted(previous)        C=P, M=P, A=P verified; never reports N installed
  → retention-transfer / journal-retired / cleanup / stable(P)

Unprovable evidence / live unknown writer:
  → blocked                  retain journal/backups; repair/diagnostics only
```

Phases are **write-ahead intent/evidence, not truth**. A crash can happen after a rename but before the phase write; recovery classifies physical evidence first. Do not require metadata timestamps that an owned rename/chmod legitimately changes to equal pre-mutation timestamps; require the intended file ID/content and operation-specific allowed transition, then pin full observed metadata again.

For Darwin, prefer making a verified private **copy** of P and its marker before publication, then atomically replacing C with N through anchored same-volume operations. Do not introduce an unnecessary canonical-absent window by moving P away first. Backup copying is an optimization-neutral implementation choice: backups are authenticated by bytes and recorded new identities, not assumed to share P's inode. Windows may still need its two-rename protocol; that missing-canonical case is explicit below.

Before pointer publication, any failure restores the **whole** predecessor executable/marker pair only after current executor authority fences all old writers and required launch-use settlement is proved (§4.5/§7.1); do not merely restore the executable. A remains P. If safe restoration cannot be proven, stop with evidence intact. After A=N, normal recovery rolls **forward to N**, not backward to P; a user-requested downgrade is a different higher-sequence signed transaction.

## 6. Recovery table: interrupted mutations, not just recorded phases

Notation: P/N = exact authenticated expected content and allowed identity; `∅` = genuinely absent (`ENOENT` only); `?` = malformed/foreign/corrupt/unreadable/identity-unstable. “Prove N/P” includes cache/Template/marker/native binding, current locally known policy, and appropriate probes. Tables describe the **new** coordinator, not existing behavior.

| Interrupted boundary / observation | Recovery under a newly acquired bound lease | Result / business gate |
|---|---|---|
| No journal, C/M/A all P | Require reciprocal enrollment, intact current accepted policy, valid control/retention catalog and no unsettled launch. Authenticate P and verify installed bytes/execution selection. | Stable P. Only this or equivalent complete N permits normal entry. |
| Reciprocal binding absent/partial/conflicting, or another I owns S | Apply §3.3 under fixed E→U only for explicit enrollment repair; normal startup never reallocates ownership. | `enrolling`/`inconsistent`; no normal activation. |
| Enrolled trust state/head/checkpoint missing or discontinuous; C/M/A intact | Enforce §4.3 **before channel acquisition/save**. Exact head-selected checkpoint recovery is explicit repair only; otherwise preserve evidence and block. | Never bootstrap sequence zero from a historical snapshot. |
| Control/retention evidence missing/invalid | Do not synthesize an empty control/catalog or infer writer/backup absence. | Repair-only; no cleanup authority. |
| No journal but C/M/A disagree, active cache corrupt, or unexplained inner journal exists | Never infer clean install from absence of outer journal. Preserve evidence; repair/adoption needed. | Block; do not load embedded Bundle to conceal inconsistency. |
| Before/during `preparing`, C/M/A=P; stage/backup incomplete | Do not trust or execute stage. Abort without canonical mutation; clean only registered identities. Unowned/identity-ambiguous orphan is preserved and surfaced. | P usable only after resolution and policy check; N never installed. |
| `prepared`, C/M/A=P and all N stage/backup evidence complete | On restart, default abort to P before publish intent; a fresh explicit apply may reuse verified bytes under new approval. | Idempotent abort, no automatic business replay. |
| `execution-pending`, launch reserved/registered/claimed/ack-issued but not admitted | Under a current U epoch revoke a stranded unadmitted launch; a received ACK can admit only if it wins the serialized transition before revocation. Keep resources until native launch settlement. | No business from claim/ACK issuance alone; no request replay. |
| `execution-pending`, admitted child still holds launch-use ownership | Do not rotate, clean, steal reservation or launch another copy. Bound waits and expose diagnostics. | Authorized child may finish N after parent loss; canonical persistence remains P. |
| `execution-pending`, native launch settlement proved and old mutators fenced by current U/control epoch | Persist N only if its recorded transaction/current policy allows it. A missing completion receipt remains `outcome-unknown`; do not replay business. | Pending→publish path; PID absence never substitutes for either proof. |
| Coordinator died during writer operation; helper may be late/orphaned | Acquire the same pinned U through the required executor, advance authority epoch/revoke stale schedules, then inspect actual files. If U/settlement cannot be obtained, preserve pending. | No compensation based on parent exit, timeout or a kill request. |
| After publish intent, before mutation: C/M/A=P | If N and backups validate, finish forward; if N readiness/policy fails, compensate/abort P. | No side effects until complete selection. |
| Windows old moved: C=∅, backup=P, M=P or journal-accounted temporary state, A=P | Resolve/validate the matching inner journal first. Restore P or complete N only with all required evidence; outer marker/pointer resolution follows. | Recovery in an available verified helper/repair process. No canonical CLI may exist to launch. |
| Canonical changed, progress write lagged: C=N, M=P, A=P | If N fully authentic/readiness-valid, publish authenticated N marker then proceed; otherwise restore verified P pair and keep A=P. | Mixed state is blocked, not installed. |
| Marker replace interrupted: C=N, M=∅ or a known owned temporary marker, A=P | Recreate/publish exact N marker from authenticated data if operation evidence permits; otherwise compensate P. Foreign `?` marker is not blindly overwritten. | No mixed-state business. |
| C=N, M=N, A=P; crash before/after canonical probe | Repeat bounded verification/probe and post-probe rehash; enter durable commit intent, then publish N. Probe failure→safe compensation before commit. | Cannot reuse a pre-crash self-test boolean. |
| Commit intent, pointer operation outcome uncertain | Non-destructively inspect A. If A=P, repeat N verification and publish. If A=N, take postcommit path. If A=∅ or `?`, block for repair rather than guess overwrite authority. | Pointer error is not proof publication failed. |
| A=N, C=M=N, journal still says marker/commit-intent | Treat as committed, reauthenticate/reobserve N; finish terminal evidence, transfer retention ownership, then retire/clean. | Exactly the “pointer moved, phase not recorded” crash window. |
| A=N but C/M not N | No downgrade through cache commit API. Reconstruct N only from durable authenticated N evidence and safe expected destination identities; otherwise block. | Never report old installed against A=N. No direct pointer reset to P. |
| Committed N; transfer/cleanup not started or partly complete | Verify N; resolve exact catalog transfer receipt before any journal retirement. Resume only catalog-authorized delete-intents after launch/writer settlement. Repeat safely. | Installed truth remains N. Cleanup failure is separately visible, not a rollback trigger. |
| Compensation interrupted, A=P, C/M partly restored | Resume the journaled compensating direction using verified P backups and known identities. Never discard N/current evidence before P is proven. | Return to complete P, or block with both evidence sets retained. |
| Any phase: foreign lease/root, changed snapshot hash, bad marker, same-sequence payload conflict, unknown live writer, mismatched inner/outer attempt | Stop mutation/cleanup. Preserve artifacts; emit stable security/repair error. | No “empty cache” fallback, no fabricated installed/pending success. |

A second recovery must yield the same stable selection, pending reservation, or explicit blocked condition; it must never lower trust sequence or re-execute a business request. Test crashes **before and after** each filesystem operation and each progress write, not just after named phases.

**Native launch limit:** if all processes die while Windows canonical is absent, the missing canonical executable cannot recover itself. A surviving verified temporary helper can recover; otherwise versioned install/repair must do it. This is the explicit §7.6 repair boundary, not a reason to add a permanent launcher or claim guaranteed restart from an absent binary. [R:401–406]

**Cleanup:** do not run current cache-wide stale cleanup while the outer transaction is unresolved. New recovery reads must not quarantine away their own evidence as a side effect. Unknown orphan artifacts are bounded: block another attempt or require repair instead of repeatedly creating random new stages. Catalog-owned retained predecessors are not unknown orphans; ownership survives journal retirement through §8.1, and only retiring debt—not the mere presence of a retained backup—can block a new attempt. Registered incomplete stages are cleaned under anchored identity checks. Cleanup must never recurse through a newly substituted directory, override the primary failure, or remove the only recoverable backup. [C:872–898,981; V:50–66]

## 7. Windows: executing N is not canonical N

### 7.1 Candidate spawn, claim, acknowledgment and completion

The legal Windows pending state remains:

```text
executing CLI + invocation-selected authenticated Bundle = N
canonical CLI + installer marker + active pointer        = P
outer journal                                             = execution-pending(P → N)
output                                                    = executedVersion N,
                                                            installedVersion P,
                                                            persistencePending true
```

There is no second active pointer. The N child receives an invocation-scoped authenticated proposal; it never executes with P's active Bundle. Actual launch identity/bytes, loaded Skill compatibility, current accepted policy and one-shot admission must all agree. Flags (`--no-update` included), envelopes, PID identity or cache observation alone grant no business execution or installation authority. [R:378–402; F:20–55,135–169]

**Durable launch binding:** `launchId`, installation/enrollment/attempt IDs, authority epoch and expected journal revision, exact N tuple and native identity/digests, parent launch identity, registered child identity, private invocation-descriptor digest, and optional issued-grant digest. The descriptor's argv/cwd/allowed environment names and optional stdin reference remain in a private bounded handoff channel/file, not the installation journal. No token values, raw claim/ACK secrets or replayable business request are journaled. The private channel has exactly the intended parent/child endpoints; unrelated descendants do not inherit them.

Use a **gated spawn primitive**: before registration the spawned stub has no managed-write authority and cannot start business; it waits on the private parent channel. Parent death/EOF before a grant permits only exit, not self-authorizing from a journal. The stub cannot bypass the native executor to mutate installation state. How Darwin/Windows implement the gate and prove process/launch-use settlement is required native work, not assumed current behavior (§4.5).

Parent and child never wait for each other's U-taking step while retaining U. Each durable transition below uses a fresh valid executor epoch. A **claim consumes the one-shot request but is not yet business admission**; only the `admitted` transition authorizes business. ACK means a private one-use grant was actually delivered, not merely an `ack-issued` record.

| Durable stage / boundary | Protocol and allowed parent-crash behavior |
|---|---|
| `reserved` | Parent under U writes exact launch/descriptor binding and pins N's stage/Bundle, then releases U before waiting. Spawn is not business permission. Before/after-spawn crash without registration leaves `spawn-uncertain`, not “owners dead.” Revoke the reservation under U; no late child can claim it. Keep launch resources until settlement is proved. |
| `registered` | Native gated-spawn evidence identifies the exact child; parent records it under U after verifying N's launch target and private-channel binding. Child remains gated; no business yet. Parent loss before claim/ACK permits revocation, not replay or another child using this request. |
| `claimed` | Child acquires U, verifies the complete proposal/current policy/registered identity and private claim proof, durably consumes the claim, then releases U and requests ACK. A claim without a grant cannot execute business. Parent loss here means revoke/cancel; the consumed request is not reissued. |
| `ack-issued` | Parent acquires U, verifies the exact claimed child/descriptor, durably records the digest of a fresh one-use grant and the current launch revision, releases U, then sends the raw grant only on the private channel. Crash before delivery gives the child no grant. Crash after possible delivery is explicitly uncertain; journal status does not prove receipt. |
| ACK received → `admitted` | Child acquires U, proves the received grant and current unrevoked claim/attempt, rechecks policy/launch/Bundle, and durably records `admitted` **before any business effect**. This is the admission linearization point. If recovery revoked first, admission fails; if child admitted first, recovery cannot treat it as an unstarted request. Raw grant is consumed and discarded. |
| Parent lost around ACK/admission | No not-yet-delivered ACK may be reconstructed from journal evidence. A received valid ACK may attempt admission even if the parent has since died, but only if a fresh U epoch finds the launch unrevoked. Recovery can revoke every non-admitted launch under U; the race has exactly one durable winner. Parent loss cannot undo already admitted business or justify replay. |
| `admitted`, child running | Child may finish with its frozen N Bundle after parent loss, subject to known policy/write gates. Durable launch-use ownership pins its files; helper/recovery cannot persist over a running required image or retire its assets. It cannot independently replay installation mutations; those require a new current executor epoch. |
| Child completion | After observing business exit, record `completed` and observed exit/outcome diagnostics under U. Parent forwards only the child's stdout/stderr/exit when present. Helper never emits another business result. Crash before completion receipt leaves `outcome-unknown`, even if business may have succeeded. |
| Child/parent disappeared, no completion | OS launch settlement, not PID absence, establishes stopped execution. An admitted request becomes `outcome-unknown`; preserve diagnostics and never replay it. If launch/descendant-use settlement is unprovable, remain pending/repair-blocked with pinned resources. |
| Delayed persistence helper | It carries only a scheduled worker/attempt/revision descriptor, not a transferable lease or business input. It must acquire U, revalidate control/journal/policy and settlement, then consume its still-current scheduled entry. Recovery that advanced/revoked/retired the attempt wins; a late helper rejects without writes. Its mutations obey §4.5. |

After a non-admitted claim is revoked, a delayed compliant child has no route to business admission. That is an **authority** fact, not proof it or an unknown writer is physically gone: preserve its executable/descriptor/Bundle pins until native launch settlement permits deletion. Before persistence, separately prove required canonical/candidate users are settled and all mutators are fenced; do not collapse those checks into one `ownersDead` flag. A reachable but unresponsive worker/launch is pending, not safely absent.

After completion/unknown-outcome settlement, the helper may persist authenticated N without replaying business, under current policy and exact recorded attempt. A private descriptor or stdin file is deleted only after its consumer is settled and its owned identity matches; uncertainty preserves it private for repair. This prevents updater-induced duplicate execution, not impossible exactly-once guarantees for a GitLab write followed by process death before its response.

Persistence failure does not change a business exit already observed. Recoverable file-in-use/transient access denial is pending only with provable root/ACL/identity authority; a security failure is repair-required, never installed. Parent death may prevent delivering any final output; do not fabricate a successful business response later. A completed helper is reported on a later status invocation, not by retroactively rewriting prior stdout.

The public pending `executing` result requires evidence N actually ran/admitted the authorized command, not merely a scheduled helper or downloaded candidate. With no N execution, unresolved persistence is an internal diagnostic/error, not a fabricated pending-result branch. `installed` still requires complete canonical/marker/pointer verification after persistence.

### 7.2 Two journals, one owner and decision

The current Windows journal validates caller paths and hashes, but has no outer transaction ID and deletes itself when executable rotation alone completes. [H:104–114,338–360,510–529,552–584]

Narrowly extend its managed mode:

- bind inner journal to `attemptId`, unchanged `next.transactionId`, both tuple digests, expected native member hashes, fixed root/slot identities;
- derive `canonical/staged/old` internally; optional managed context is a runtime-branded capability, not an untrusted struct with accepted hashes;
- require matching outer `publish-intent`/later state before rotation/recovery can mutate;
- preserve the inner receipt until outer canonical/marker/pointer reconciliation is complete; do not remove an older retained backup without the outer ownership/retention decision;
- route native mutations/journal writes through anchored ACL-aware operations and required durability barriers.

Recovery order: **validate reciprocal enrollment/accepted policy/control → obtain fenced executor authority and settle launch users → validate outer journal/snapshots → inspect matching inner journal → recover native file state → reconcile marker → final canonical verification → publish/read back A → finish outer outcome → durably transfer retention ownership (§8.1) → retire journal evidence → identity-scoped cleanup**. A crash between retirement steps is covered by committed outer evidence. The outer record owns release selection; the inner journal is subordinate physical-mutation evidence, never a competing installed result.

The managed path never creates a cache-only `activation-journal.json`. Startup must nevertheless inspect that legacy journal before any automatic recovery: a fully terminal record whose actual C/M/A all authenticate as its next tuple may be retired through guarded cleanup; a nonterminal, mismatched, or contradictory legacy journal requires explicit migration/repair. Never let the legacy auto-roll-forward path publish a pointer ahead of native verification.

Do not call `recoverReleaseSet()` first, and do not call `rotateWindowsExecutable()` directly as a managed adapter without this binding. Preserve legacy exports/tests for their existing limited contract, but require the managed context for the production installation path. An unmatched legacy Windows journal goes to explicit repair/migration rather than being silently adopted.

## 8. Exact rollback authorization, retries and retention

Requirements permit rollback through a **higher-sequence signed channel selecting exact older immutable assets**. There is no necessary new “rollback:true” payload field; the signed complete target tuple is the authorization. [R:268–275,360–366; P:22,176,279]

For fresh rollback authorization, capture prior accepted watermark `H` and committed P before acquisition. Accept a signed manifest at `S > H` through the existing trust transition rules. Under the installation lease require:

1. Its exact payload is the presently accepted channel payload, with `S = current highestSequence` at fresh authorization; no same-sequence different payload and no candidate/policy drift while waiting for the lease.
2. For a different new activation, `S > P.manifestSequence`; compatibility, minimum allowed version, CLI/release-set revocations, and loaded Skill protocol permit the complete target.
3. Manifest repository, CLI immutable tag, platform asset name/size/archive digest, Template tag/asset/size/archive digest, schema, release-set ID/versions, and indexed signed Template receipt all match the candidate being installed. Derive native hash from the authenticated CLI archive. Retained local executable or a matching version string alone proves none of this.
4. If reusing retained archives, build a **new authenticated snapshot from the new branded manifest and exact retained bytes**. Do not edit the old record's sequence/ID, copy its old provenance, or roll back the trust store. A newly authorized rollback release-set ID/provenance may differ from the original release while selecting the same old immutable assets.
5. Run exactly the same stage/readiness/backup/publication/final-verification protocol as apply. A failing rollback cannot delete the current verified installation before its replacement/compensation is safe.

**Retry nuance:** channel acquisition may already have durably accepted S before physical installation succeeds. Retrying that same exact accepted S/payload or recovering its recorded transaction must not require S+1 every time. Accept an exact, still-permitted accepted authorization with `S > P.manifestSequence`; if already fully installed, verify and return `unchanged`. Same-sequence different payload always fails. Restart authentication uses stored signing history plus current locally accepted policy; never feed the historical snapshot into a trust transition that lowers the persisted high-watermark. [U:452–475; A:239–251]

**Compensation is not public rollback.** Before commit, restoring the already committed P tuple after a failed attempt is recovery, not an unauthorized requested downgrade. It does not reduce trust state. If newly accepted policy revoked P, restoration may preserve a coherent diagnosis/repair target, but never restores P's side-effect permission. After A=N, selecting older assets requires a separate higher-sequence authorization, not `commitStagedReleaseSet(previous)`.

`rollback()` has no arbitrary target parameter, consistent with T02. The current parser requires `self-update rollback --version <semver>` [CLI:316–322], whereas requirements show parameterless rollback [R:1374]. For compatibility, first retain `--version` solely as an **assertion/filter** against the authorized signed target selected internally; a mismatch returns a stable required/security error without mutating. Later make it optional to expose parameterless rollback; it never drives archive/path selection. `rollback()` rejects a channel that authorizes no actual downgrade/reversion relative to installed artifacts, except an idempotent retry of its already completed authorization. Versions are diagnostic; exact complete signed artifacts govern the choice.

### 8.1 Durable retention catalog and journal ownership handoff

Use fixed state-root `installation-retention.json`, version 1, maximum 64 KiB, canonical strict JSON, initialized at enrollment and read under U. It binds the reciprocal installation/enrollment/root IDs, a monotonic catalog generation, one `retainedPredecessor` entry (or null), bounded `retiring` groups, and one terminal ownership-transfer receipt. Missing/corrupt catalog in an enrolled installation is a repair block, not an empty-retention assumption.

Each entry contains the complete retained authenticated `ReleaseSetRecord`/tuple digest and signed payload identity; cache snapshot reference derived from the record; original owning `attemptId`; exact logical backup/marker slots derived from that attempt; stable file/directory identities; separate archive/native/marker digests and sizes; and disposition `retained | retiring`. No arbitrary absolute deletion paths or bare `.old` filenames are accepted. File identity plus authenticated content is required before use/removal. A path merely resembling a retained slot is neither ownership nor rollback authorization.

The catalog is **ownership evidence, not another active pointer**. Only A selects the installed release. A live outer journal owns its candidate, backup and temporary slots; the catalog owns explicitly transferred terminal slots. Backups remain at their attempt-derived names during handoff: do not add a cross-directory rename just to call them retained. In managed Windows mode use derived per-attempt old/stage names rather than unconditionally deleting a fixed `.old`; preserve the helper's same-parent constraint until the native adapter contract changes deliberately. [H:147–157,552–584]

**Bound:** one retained predecessor, at most two retiring groups (superseded predecessor and current-attempt residuals), at most eight identity-listed members per group, plus the current live journal's bounded slots. Before starting another installation attempt, drain existing retiring debt safely or return a specific cleanup/repair block; an ordinary retained predecessor alone **never** blocks another update. Current/retained/live-launch-referenced snapshots cannot be garbage-collected. This bounds failed cleanup without silently deleting an unknown backup or accumulating attempts forever.

Transfer protocol, all mutations through the current lock-owning executor:

1. Read back the terminal physical result: committed N means C/M/A=N; aborted-before-commit means verified C/M/A=P. Prove current accepted policy, fenced writer outcomes and settled/revoked launch resources before transferring/deleting their slots. A committed result cannot be relabeled aborted to simplify cleanup.
2. Compute a frozen `terminalEvidenceDigest` over attempt ID, outcome, selected active tuple, completed worker/revocation receipts and exact owned-slot inventory. It excludes mutable phase/catalog-reference fields. Store it in the terminal journal. Terminal outcome remains `next` or `previous`, never “some phase succeeded.”
3. Construct catalog generation g+1 by expected-generation replacement. Its transfer receipt includes a durable `retire-intent` for the exact frozen terminal outer/inner journal identities/digests; absence is allowed only after this intent, never as proof that no transaction existed. For committed P→N: transfer **that attempt's verified P backup/snapshot pair** to `retainedPredecessor`; move prior retained material (if any) to an identity-listed retiring group; register current attempt's unneeded stage/marker residuals as another retiring group. Journal identities belong to the transfer receipt's retire-intent, not a second ambiguous garbage owner. For aborted attempt: retain the catalog's previous retained predecessor unchanged; transfer only aborted attempt-owned garbage for retirement. Never adopt unknown user backups.
4. Durably publish and read back g+1 with a transfer receipt `{attemptId, outcome, terminalEvidenceDigest, fromGeneration:g, toGeneration:g+1}`. Re-authenticate transferred retained evidence. A crash or duplicate call with the same receipt is an idempotent readback, **not** another promotion/generation increment. Conflicting receipt/generation or changed member identity blocks.
5. `ownership-transferred` is a state **derived from the matching durable catalog receipt**, not another outer-journal rewrite: freeze the terminal journal so its catalog-recorded identity/digest remains exact. Only now may matching Windows inner evidence and the outer journal be retired under expected-identity checks and required directory barriers. If an inner journal is removed first, its retire-intent/evidence is already in the catalog receipt. A missing journal with that matching retire-intent is an idempotent retirement, not an empty-installation signal. **Never remove/replace the sole outer journal before durable catalog ownership exists.**
6. After journal retirement, cleanup consults the catalog alone. For each `retiring` member, write durable `delete-intent` for its exact identity/digest, prove no active/retained/live-launch reference, then perform native expected-identity unlink and sync. Mark that member removed after readback. ENOENT following its own durable delete-intent can complete idempotently; a foreign/replaced object, permission/I/O error, or missing retained member is not permission to delete/forget it. Do not recursively remove unenumerated contents. Catalog generations advance through identity-bound expected replacement; no unknown backup is swept by glob.

| Crash boundary / next invocation | Required recovery |
|---|---|
| Terminal journal written; catalog still g | Journal still owns all attempt slots. Repeat step 3 using expected g; never infer ownership transfer from the terminal phase alone. |
| Catalog g+1 durable; journal still terminal or catalog write result uncertain | Exact receipt/inventory proves handoff. Validate terminal C/M/A, skip duplicate promotion, derive `ownership-transferred`, then retire the unchanged terminal journals. |
| Catalog transfer/retire-intent recorded; one/both journals remain | Validate matching receipt and remove only remaining matching journal identities. Outcome does not change. |
| Journals absent; catalog has transfer receipt and retained P | Stable N with deliberately retained P; no unresolved transaction is invented. The next N→Z attempt may create a distinct N backup without deleting P or rejecting it as `.old`. |
| N→Z commits | The new journal owns N's backup until a new catalog transfer; new catalog retains N and lists P as retiring. No unowned interval occurs when the single outer journal is reused. |
| Crash after delete-intent/unlink before member completion | Exact absent member with matching intent is completed; matching existing member can be retried. Foreign identity blocks without deletion. Other members remain catalog-owned throughout. |
| Cleanup failure | Preserve catalog and receipt; installed truth remains the terminal N/Z tuple. Next recovery resumes bounded cleanup; a new attempt waits if retiring capacity/debt cannot safely be cleared. |
| Journal absent and no matching catalog ownership for a leftover file | Unknown artifact; preserve it and require explicit repair. It is not retained merely because its name/hash resembles an old backup. |

Test distinct P→N→Z updates across **every transfer/delete boundary**, then repeat recovery twice. Assert actual selected native/marker/Template/pointer tuple and predecessor catalog contents. User-created `.old` files and replaced sentinels must remain untouched. Current helpers remove their journals/old files without this durable catalog [H:510–529,552–584]; implementing the catalog and native expected deletion is required new work, not an existing guarantee.

### 8.2 Independent Template compatibility remains a gate

Retention bounds storage; it never authorizes rollback. Every retained target still needs the exact current higher-sequence authorization or permitted exact retry described above.

**Existing compatibility limit to preserve, not bypass:** snapshot authentication requires the CLI archive's bundled receipt to equal the selected Template receipt [S:100–101]. An independently chosen old CLI/new Template combination may therefore fail today even if superficially version-compatible. This remains an unresolved gate against the requirements for independently versioned CLI/Template releases, not a permanent waiver. T02 must not weaken authentication to make rollback pass; any resolution of the independent Template/embedded-receipt contract needs separate specification review.

## 9. Concrete interface proposal, preserving the planned public API

These are proposed TypeScript contracts only, not implemented code. Existing named imports/types retain their current meanings. Authority-bearing factories are internal; public types/`readonly` fields are not runtime security.

```ts
// Keep the T02 external shape; pending never contains an InstalledReleaseObservation.
type InstallationResult =
  | { readonly status: 'installed' | 'unchanged';
      readonly active: ReleaseSetRecord;
      readonly observed: InstalledReleaseObservation }
  | { readonly status: 'persistence-pending';
      readonly executing: ReleaseSetRecord;
      readonly persistencePending: true };

interface ProductionInstallationOptions extends ProductionReleasePreparationOptions {
  readonly stateDirectory: string;
  readonly installationDirectory: string;
}
interface ProductionInstallationService {
  apply(force: boolean): Promise<InstallationResult>;
  rollback(): Promise<InstallationResult>;
  recover(): Promise<void>;
}
declare function createProductionInstallationService(
  options: ProductionInstallationOptions,
): ProductionInstallationService;
```

`recover(): Promise<void>` returns only after stable physical/cache coherence is verified. It must throw on unresolved pending/repair conditions instead of pretending there is no installation. Internally a richer result lets startup/status explain pending without granting side effects:

```ts
type RecoveryDisposition =
  | { readonly kind: 'stable'; readonly active: ReleaseSetRecord;
      readonly observed: InstalledReleaseObservation }
  | { readonly kind: 'pending'; readonly attemptId: string;
      readonly canonical: ReleaseSetRecord; readonly proposed: ReleaseSetRecord;
      readonly reason: 'live-execution' | 'native-in-use' }
  | { readonly kind: 'blocked'; readonly attemptId: string | null;
      readonly code: 'UPDATE_SECURITY_ERROR' | 'UPDATE_REQUIRED' };

// Internal, never a deserialized object or externally injected writer adapter.
// Factory uses private WeakMap membership; authority expires with the lease epoch.
interface InstallationEpoch { readonly attemptId: string }
interface VerifiedTarget { readonly slot: 'stage' | 'canonical' | 'previous' }
interface MutationReceipt {
  readonly attemptId: string;
  readonly mutation: 'canonical' | 'marker' | 'restoration';
  readonly journalRevision: number;
}
interface ManagedPlatformAdapter {
  prepare(epoch: InstallationEpoch): Promise<VerifiedTarget>;
  probe(epoch: InstallationEpoch, target: VerifiedTarget): Promise<void>;
  publishCanonical(epoch: InstallationEpoch): Promise<MutationReceipt>;
  publishMarker(epoch: InstallationEpoch): Promise<MutationReceipt>;
  restorePrevious(epoch: InstallationEpoch): Promise<MutationReceipt>;
  recoverNative(epoch: InstallationEpoch): Promise<'previous' | 'next' | 'unresolved'>;
}
```

Adapter methods read immutable authorized snapshots and logical slots from the private epoch, not caller-provided executable paths/hashes. They do not publish A or return `installed:true`. The coordinator independently re-reads/compares real files after the receipt. `probe()` must accept only a privately branded verified target, not arbitrary pathname or test-supplied boolean; reuse the native-readiness probe runner internally with pre/post target verification.

Narrow compatible extensions required in existing APIs:

```ts
// Optional lease additions leave existing callers source-compatible.
interface ProductionChannelClient {
  check(force: boolean, lease?: ProcessLockLease): Promise<ProductionChannelCheckResult>;
}
// On UpdateStateStore:
// save(value: UpdateStateValue, lease?: ProcessLockLease): Promise<StoredUpdateState>;

// Internal cache recovery path: observe without quarantine/cleanup or publication.
// Absent differs from invalid; non-ENOENT I/O is an error, never `absent`.
type ActivePointerInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly record: ReleaseSetRecord }
  | { readonly kind: 'invalid'; readonly code: 'UPDATE_SECURITY_ERROR' };
// inspectActivePointer(epoch): Promise<ActivePointerInspection>
// Authenticated cached contents are loaded separately by validated record + same lease.
```

The pointer inspection is an internal capability-bound API; it avoids triggering existing quarantine paths during interrupted-install analysis. `commitStagedReleaseSet(record, lease)` can retain its public signature, with an internal anchored state-side writer and outer admission checks; do not redefine all cache callers as installers. The new managed flow stages via `stageVerifiedReleaseSet`, validates A's expected predecessor, then commits via the guarded publication path. No automatic cache recovery/pointer mutation happens before native reconciliation.

Pure model proposed for the first transaction slice:

```ts
// Strict parser returns evidence only, never authority.
declare function parseInstallationJournal(bytes: Uint8Array): InstallationJournal;

// Facts are derived by I/O adapters in production; synthetic facts are ideal unit inputs.
// An observation can match both P and N when native bytes are legitimately unchanged.
type FileMatch = 'previous' | 'next' | 'both' | 'absent' | 'invalid';
interface RecoveryFacts {
  readonly canonical: FileMatch;
  readonly marker: FileMatch;
  readonly active: 'previous' | 'next' | 'absent' | 'invalid';
  readonly previousComplete: boolean;
  readonly nextComplete: boolean;
  readonly enrollment: 'enrolled' | 'unenrolled' | 'enrolling' | 'inconsistent';
  readonly policyContinuity: 'current' | 'exact-checkpoint-repair' | 'unprovable';
  readonly writerAuthority: 'fenced-current-epoch' | 'held-elsewhere' | 'unproven';
  readonly launch: 'none' | 'pre-admission' | 'admitted-live' |
    'settled-completed' | 'settled-outcome-unknown' | 'unsettled';
  readonly retention: 'current' | 'transfer-pending' | 'transferred' | 'invalid';
  readonly knownPolicyAllowsPrevious: boolean;
  readonly knownPolicyAllowsNext: boolean;
  readonly innerBinding: 'none' | 'matching' | 'mismatched';
}
type RecoveryDecision =
  | 'verify-stable-previous' | 'verify-stable-next'
  | 'abort-preparation' | 'restore-previous' | 'finish-next'
  | 'wait-settlement' | 'revoke-unadmitted-launch'
  | 'transfer-retention' | 'finish-cleanup' | 'block';
declare function decideInstallationRecovery(
  journal: InstallationJournal | null, facts: RecoveryFacts,
): RecoveryDecision;
```

Enrollment/policy/control/retention failures dominate tuple classification: a complete-looking P/N does not bypass them. `fenced-current-epoch` requires the native executor proof, not a boolean derived from absent PIDs; settled launch states require native settlement evidence.

A decision is not a capability and cannot itself execute any operation. Production executor re-observes after each effect, under the same epoch, before advancing. This also avoids treating same executable bytes as proof of the same release tuple: P/N can share CLI bytes while differing in signed authorization or Template. A, signed snapshots, and journal bindings—not C alone—disambiguate selection.

For T07, add an internal `selectInvocationRelease(...)` returning a frozen authenticated Bundle plus actual executing identity and persistence diagnostics, and an internal `prepareInvocationHandoff(...)` taking the parsed invocation and one-shot launch authority. Do not overload `apply(force)` with a business request it cannot represent. Default `production-main` constructs the real coordinator rather than requiring `updateService` injection. Existing check/status-only composition and unconditional embedded selection are insufficient. [MAIN:105–129,139–174,357–373; E:35–45]

## 10. Failure/output policy and startup ordering

Startup ordering for normal managed entry:

1. Parse enough to recognize controlled internal probes/helper/child entries; those have separate constrained gates and must not recursively preflight.
2. Resolve fixed roots; require reciprocal enrollment, current accepted-policy continuity and valid control/retention evidence before any acquisition/save. Obtain the fenced native executor epoch; non-destructively inspect all transaction/launch evidence; recover or surface a safe diagnostic block.
3. Authenticate the committed tuple and actual executing CLI, or claim the exact Windows invocation-scoped N proposal. Select the corresponding Bundle before constructing business handlers.
4. Perform the required channel/policy check (unless explicit offline), evaluate loaded Skill protocol, then either prepare/handoff to N or retain authenticated P according to §7.8.
5. Grant side-effect admission only for the chosen complete allowed tuple; never execute in a mixed tuple. Read-only diagnostics can report corruption/revocation without pretending a valid business selection exists.

| Condition | Ordinary business | Explicit apply/rollback |
|---|---|---|
| Trusted, complete local tuple; remote unavailable | Continue with disclosed warning/LKG, no latest claim. | Fail without fabricated installation success when fresh authorization is required. |
| Remote invalid signature, older sequence, bad candidate asset hash; local still trusted and not known revoked | Warning with security anomaly, keep local; isolate candidate safely. | `UPDATE_SECURITY_ERROR`; no pointer/native success. |
| Local cannot authenticate, transaction unprovable, or known signed revocation/minimum-version violation | Block side effects; diagnostic commands only as permitted. | Fail/repair or install a permitted newly authorized tuple. |
| `--no-update` | Do not install a new release; still check manifest/revocation and perform startup integrity/recovery gating. | Not a bypass for authorization or corruption. |
| `--offline` | No network; authenticate local/recover using durable evidence and enforce already known policy. | Cannot invent a new rollback authorization; exact durable authorized retry is distinct from a fresh request. |
| Windows authorized N invocation while canonical P remains | Preserve child stdout/exit; report N executed, P installed, pending. | Same truth rule; neither scheduled helper nor cache commit alone is installed. |

The current `UpdateService` returns early for `noUpdate`, and the default production preflight only validates trust configuration; both need deliberate T07 work. [SV:107–119; E:29–45] `runBoundedUpdateHandoff` is only the explicit-pipe transport: keep the 2 MiB/once-only input contract, separate TTY inheritance, reject undeclared non-TTY input, preserve cwd/argv, and pass environment values only through controlled process inheritance (not serialized secret-bearing envelope). Existing envelope environment fields need reconciliation with the requirement's **allowed environment names** contract, not promotion into authority. [R:395–401; F:20–55,87–124]

## 11. Smallest first slice and discriminating tests

### First mergeable implementation slice: T02 fixture contract only

**Fixture code is owned by a separate worker. This spec revision specifies its contract only and does not duplicate, edit or claim approval/completion of that implementation.** Its authorized write scope remains the native fixture helper and its contract test:

- `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/test/helpers/native-release-fixture.ts`;
- `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/test/contract/managed-release-fixture.test.ts`.

A family factory or explicit shared source must create `exactReleaseFixture()` **once per family** and retain its key/bootstrap config, receipt42 bytes, immutable Template archive/files, and exact history anchor. Same key ID alone is not a shared public key: baseline calls generate a new Ed25519 key, and native fixture verification starts fresh each time. [FIX:9–26; HF:28,37–41,110–135; SG:15–20]

**Chosen series:** keep the original signed placeholder channel42 as the family's predecessor and seed with its verified `origin.trustState`. Construct native P43→N44→Z45 and verify them successively through **one evolving trust state/root**, carrying each result's `nextTrustState` forward and using the same trust configuration for all snapshots. Preserve exact receipt/history signing sequence42 and Template bytes. Never feed a rewritten native42 into `origin.trustState`: that state already accepted a different payload42, which must fail same-sequence divergence. Do not change the base receipt/history to make sequence41 work. [HF:62–81,110–135; MF:445,595–603]

Family contract:

1. Each upgrade uses a distinct non-header native byte variant **and a distinct CLI version/tag and release-set ID**. Recompute SHA256SUMS/ZIP/channel asset metadata/signature on owned copies. Within a family, an immutable `(repository, CLI tag, platform asset name)` maps to exactly one byte array/size/digest; changing bytes under an already used tag is rejected, even with a higher sequence. [R:268–275]
2. Return detached bytes/records so negative tests cannot mutate the family's retained artifacts or poison later candidates. Authenticate P43/N44/Z45 with the same root and persist/advance one test trust lineage, rather than independently authenticating under three roots.
3. A rollback authorization at sequence46 selects **exact retained P43 tag/archive/member bytes**, with a new signed release authorization/record and the same immutable receipt/history. It does not rebuild the old CLI artifact or require rollback native bytes to differ from P43. Distinct-byte assertions apply to upgrades, not to reproducing the authorized rollback target.
4. Assert unchanged receipt42/Template/history; archive hash distinct from native hash; sequential acceptance 42→43→44→45→46; old-call defaults; cross-root rejection; sequence41-with-receipt42 rejection; same-sequence different-payload rejection; immutable tag→asset consistency; and isolated mutation of returned buffers. Any independent legacy native42 fixture must start from fresh bootstrap trust, **never** the origin's already accepted placeholder42 state; it is not this sequential family.

No installation I/O, CLI wiring, lease changes, platform writer or native execution belongs in this slice. Header-shaped 512-byte fixtures prove signed-byte/schema contracts only, not SEA readiness, installed truth, Windows behavior or crash durability. The four P1 native design holds are independent of fixture implementation.

### First transaction-logic slice: strict journal parser + pure recovery classifier

Next, before filesystem mutation, implement the proposed strict schema and `decideInstallationRecovery()` with table-driven unit tests. Keep it pure: no process spawning, directory creation, pointer commit, network, or production wiring. Tests cover every recovery row and every unknown/mismatched case, same-byte/different-authorization tuples, precommit compensation versus postcommit roll-forward, frozen/copy-safe inputs, and repeat decisions. It must **not** claim actual crash recovery: durable I/O/real process restarts are the following T03 slice.

### Later gates (must not be silently included in the first slice)

1. Reciprocal enrollment/crash-order/lock-order tests, accepted-policy head/checkpoint loss and publication tests, and native lock-owning executor/anchored operations for every metadata slot. Include two I sharing S and two S sharing I, deletion/substitution of trust state with intact C/M/A, same-enrollment repair, and installer/CLI lock convergence. No production enablement until these native gates pass.
2. Real T03 recovery harness using distinct signed P/N/Z; kill a child at every before/after operation boundary and restart a new process. Assert actual C hash, marker, active record, Template hash, and no side-effect callback before stable selection.
3. Darwin adapter: two distinct successful upgrades, idempotent same release, authorized rollback, pre/post-self-test mutation, staged/canonical self-test failure, source-mode rejection, concurrent installers, cross-volume cache/install stage copy, safe compensation, partial cleanup, linked/hardlinked/writable/replaced roots and external sentinel safety.
4. Windows adapter: native running EXE, sharing failures, wrong ACL/reparse/hardlinks, parent loss after every reserve/spawn/register/claim/ACK/admit/completion transition, identity reuse, unknown launch-use settlement, delayed helper versus recovery, executor orphaned after coordinator death, queued write after lease release, inner/outer mismatch, before/after both renames, marker/pointer interruptions, and P→N→Z plus catalog-transfer/delete-intent crashes and exact signed rollback. Mac-format fixtures are not Windows execution evidence.
5. T06 real-coordinator tests: channel advances/revokes during download and before lock; same-sequence divergent payload; forged/foreign/released lease; wrong root; false adapter receipt; final canonical hash/marker mismatch; restore/readback/cleanup failures; trust never decreases.
6. T07 default-entry black-box tests without injected installation service; active Bundle and executing identity; no-update/offline security matrix; original command/stdio/exit exactly forwarded without updater replay. Native SEA/default-entry evidence is a later gate, not parser/fixture coverage.

### Rejected findings → invariant/test mapping

| Rejected evidence | New invariant and decisive test |
|---|---|
| Production bridge unconditionally prints `installed:true`, equal executed/installed versions and `persistencePending:false` [B:10–42] | Result is constructed only after actual observation; forged receipt/cache-only success rejected; legal Windows pending never equals installed. Default entry works without injection. |
| Prior service design omitted unified recovery/lock-time policy/precise rollback [T:67–78] | Outer journal owns C/M/A; lock-time payload/current-policy equality; exact higher-sequence rollback tests. Archived bridge is incomplete evidence of the original service internals; do not claim those internals were present in that patch. |
| `.old` blocks the second update [V:16–22] | Completed retention differs from unresolved transaction; A→B→C with distinct bytes succeeds and selected marker/pointer are checked. |
| Rollback swaps before verification and cannot compensate [V:24–30] | Prevalidate/probe retained target; current remains verified after failure, or journal explicitly blocks with evidence retained. Wrong/missing old marker and failed target probe tests. |
| Self-test modifies executable but verification reports old hash [V:32–38] | Rehash/re-pin after every probe and final publication; mutate bytes while preserving version output and assert failure. |
| Journal written but never recovered after process death [V:40–46] | New-process interruption tests at all mutation/progress boundaries; repeated recovery proves complete P or N, otherwise zero side effects. |
| Marker symlink, pathname races, recursive cleanup [V:50–54] | Anchored operations/no-follow/ACL/link checks, changed ancestor/file identity tests, external sentinels unchanged. |
| All `exists()` errors treated as absent [V:56–60] | Inject EACCES/EIO/type error separately from ENOENT; preserve journal/backups, never infer missing predecessor. |
| Failed stage test leaks executables [V:62–66] | Stage creation covered by journal-owned cleanup; delete only pinned owned stage after child close; unknown orphan blocks further accumulation. |
| Identical bodies and misleading test names [V:68–75] | Signed distinct-byte fixtures, concrete separate assertions for each promised condition, and native SEA smoke separate from header parsing. |
| Rejected code equates old native hash with archive hash [X:56] | Authenticate retained archive member; assert archive/native hashes differ and rollback still succeeds only with exact new signed authorization. |

## 12. Review decisions and remaining proof obligations

Approval requested for these specific choices, not for installation code:

1. Outer installation journal owns the complete transaction; managed flow bypasses cache-only activation recovery until canonical/marker reconciliation.
2. Preserve the authenticated-provenance-derived release `transactionId`, random `attemptId` and strict marker v1; add reciprocal enrollment with fixed E→U ordering and no enrolled-policy bootstrap fallback.
3. Precommit recovery may compensate P only with fenced writers/settled launch users; post-pointer recovery finishes N or blocks. Windows pending uses the explicit claim/ACK/admission state machine and never replays business.
4. Require the native lock-owning executor, anchored operations for all metadata, accepted-policy checkpoint/head continuity, durable retention transfer before journal retirement, and same-lease channel/state signatures. Existing writer/rotator APIs do not supply these guarantees.
5. Fixture work remains with the separate worker: same-root 43/44/45 family, receipt42 unchanged, immutable tags, exact P43 rollback at46. Re-review these four P1 protocols before any native mutation implementation; next transaction slice is pure parsing/classification.

Native filesystem behavior, existing-platform regressions, crash durability, executor/launch lifetime, policy checkpoint recovery, catalog deletion, exact runtime compatibility and SEA smoke remain **unverified by this spec revision**. All four findings await independent re-review; no native implementation is approved or complete. Enrolled bootstrap/legacy migration and installer lock convergence are explicit T08 prerequisites for real adoption, not silent assumptions. The current CLI parser's rollback `--version` requirement and verifier's embedded receipt coupling are compatibility issues to resolve deliberately. No rejected implementation is restored or recommended for cherry-pick.

## Source index (absolute paths; baseline source lines, not implementation claims)

Production references were checked against the current source during this revision. Fixture references describe baseline `2c6b681`; the separately assigned fixture worker may change those helpers concurrently. This revision used baseline fixture evidence and did not edit or verify the worker's implementation.

- **P** — `/Users/lxc/Documents/Codex/2026-09-18/gong-2/outputs/mrtool-superpowers-plan-2026-09-18.md` — architecture/constraints 7–26; T02 135–199; T03 202–220; T04 222–243; T05 245–263; T06 266–286; T07 288–315.
- **R** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/docs/requirements/harness-mrtool-requirements.md` — §7 assets 256–275; signed schema/trust 277–366; preflight 370–384; single binary/Windows 386–406; active tuple/Skill 408–420; warning/revocation 422–439; bootstrap 441–448; rollback example 1374.
- **A** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/activation.ts` — recovery 154–219; activation/equivalence/publication 222–268.
- **J** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/journal.ts` — schema 14–75; reads 84–124; writes/removal 127–185; tuple digest 189–191.
- **C** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/cache.ts` — record/snapshot 46–140,280–337; reader/writer 407–535; lease 735–746; quarantine 791–820,1128–1139; staging cleanup 872–898; persistence 913–985; stage/commit/load 989–1165.
- **H** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/windows-helper.ts` — persistence 11–60; inner contract 64–114; validation 147–180,254–303,338–360; journal 375–462; recovery/rotation 498–589.
- **I** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/installed-release-verification.ts` — observation 16–25; pinned reads 27–71; exact signed canonical verification and marker 74–117.
- **N** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/native-executable-store.ts` — boundaries 43–65; materialization 66–108; final verification 109–138.
- **F** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/invocation-handoff.ts` — envelope/spawn contract 20–55; validation 87–124; transport 135–169.
- **Q** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/production-release-preparation.ts` — public options 9–16; acquisition and final payload check 26–59.
- **S** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/release-set-verifier.ts` — deterministic ID 42,92,123–127; archive/native checks 43–64,68–103; candidate construction/equivalence 108–139.
- **D** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/native-readiness.ts` — bounded child lifecycle 47–85; readiness boundary 92–103; isolated target verification/probes 125–178.
- **L** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/platform/lock.ts` — lease brand 20–38; root/lock lifecycle 85–120.
- **K** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/platform/process-lock.ts` — frozen helper lease 138–163; Darwin identity-pinned lease 238–304; platform provider 308–325.
- **W** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/platform/anchored-file-writer.ts` — restricted API 9–14; POSIX 26–57; Windows 60–121; helper lifecycle 124–164; limitations/entry 167–204.
- **M** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/platform/windows-write-through-move.ts` — move/flush 13–37; no-replace API 56–58; timeout/termination settlement 202–211.
- **G** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/production-channel.ts` — API 14–33; state operations/freshness 78–116.
- **U** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/state-store.ts` — existing optional-lease helper 325–349; trust transition 452–475; load 572–574; save 647–738.
- **PID** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/platform/process-identity.ts` — process identity/status interface 11–24; Windows start-time inspection 35–45.
- **MAIN** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/production-main.ts` — default check/status 105–129; embedded Bundle/default composition 139–174; internal self-test/default preflight 351–373.
- **SV** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/service.ts` — current check/status-only service 20–32; no-update/offline 107–119.
- **E** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/preflight.ts` — default trust-config-only preflight 29–45.
- **CLI** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/cli/program.ts` — rollback parser 316–322.
- **FIX** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/test/helpers/native-release-fixture.ts` — baseline fixed native bytes and signed tuple construction 9–26.
- **HF** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/test/helpers/default-historical-fixture.ts` — per-call key 28; receipt sequence 37–41; history/bootstrap 110–124.
- **SG** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/test/helpers/signing.ts` — fresh key generation 15–20.
- **MF** — `/Users/lxc/harness-mrtool-release-candidate-0.1.0-v2/.worktrees/release-closure-20260918/src/update/manifest.ts` — history sequence bound 445; high-watermark/payload checks 595–603.
- **V** — `/Users/lxc/Documents/Codex/2026-09-18-managed-install/managed-review.md` — decision/runtime caveat 5–12; repeat install 16–22; rollback 24–30; self-test 32–38; recovery 40–46; path/errors/leaks/tests 50–75.
- **X** — `/Users/lxc/Documents/Codex/2026-09-18-managed-install/managed-installation-rejected.patch` — archived prototype inputs/journal 14–19; verification/install/rollback 51–56. These are patch-document line numbers, not live checkout code.
- **B** — `/Users/lxc/Documents/Codex/2026-09-14/m-r/work/release-2026-09-17/production-install-service-rejected.patch` — archived installed-only bridge/result 10–42; version-based rollback bridge 58–60; injected-only wiring 77–94. The file contains a bridge/wiring diff, not the complete rejected installation service implementation.
- **T** — `/Users/lxc/Documents/Codex/2026-09-18/gong-2/outputs/mrtool-takeover-and-scope-2026-09-18.md` — accepted capability distinctions 63–65; rejected prototype findings and prohibition on reuse 67–78.
