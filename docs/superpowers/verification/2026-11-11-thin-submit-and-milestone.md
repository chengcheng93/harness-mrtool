# Thin Submission and Future Milestone Verification

Date: 2026-11-11. Status: **implemented local 0.1.11 candidate; scoped acceptance passed; complete legacy suite is not green**.

Branch: `codex/thin-submit-future-milestone`. Product/test head: `96cd26e3d3064f96a4684bb51fb48ddee96243c0`. Implementation base: `9454ae94df70a633b2f2ac4cf251fbe7cef0a06a`. No production GitLab writes, shared push, release, signing or global installation were performed.

## Goals and method

- G1: a Windows PowerShell5.1 thin runner invokes existing schema/profiles/context/create contracts and returns Stopwatch total/step timings. CLI retains business/schema/auth authority.
- G2: fast submission fetches active project/ancestor milestones before ticket consumption and selects the nearest strictly future Gregorian due date under one frozen Shanghai date, tie-breaking by global numeric ID. Both initial POSTs share milestone_id; the existing three labels remain.
- G3: default Skill body is65lines; standalone/plugin mirrors and generated instructions agree; legacy/install/manual detail is loaded on demand.
- G4: use approved design, a detailed task plan, RED/GREEN implementations with separate owners, serial commits, fresh task reviews, one whole-branch review and one combined fix wave/scoped re-review.

Design: ../specs/2026-11-11-thin-submit-and-milestone-design.md
Plan: ../plans/2026-11-11-thin-submit-and-milestone.md

## Commits and reviews

| Commit | Change | Independent result |
|---|---|---|
| bfe2e24 | short Skill, references, package/CI/version0.1.11 | Task3 Approved; no findings |
| a7bd1be | native PS5.1 runner and behavioral fixtures | Task2 Approved; one minor test close-event issue |
| 1bbf614 | milestone API, selector, default preflight and POST metadata | Task1 Approved; no findings |
| 96cd26e | one combined final fix wave,9owned paths | all5Important+1Minor ADDRESSED; no new Critical/Important/Minor |

Final review caught and the fix wave proved: normal installer discovery; strict complete CLI JSON framing; drain bytes before UTF8 decoding; fully qualified Windows paths; complete source read before child launch; close-event output collection. The Windows built-in JSON parser adds no user runtime package. Request buffering uses memory proportional to raw input and does not add content/length rules.

## Acceptance evidence

| Requirement | Evidence |
|---|---|
| Active/future/today/past/null/invalid/leap-day/same-date global-ID rules | selector unit tests and175/175 focused batch |
| Project and ancestor inclusion, complete bounded pages, second-page closest, duplicate/malformed handling | gitlab-milestones contract; include_ancestors/state query assertions |
| Frozen Shanghai date, same optional ID on both initial POSTs, exact3labels | default-write-performance and create-submission assertions |
| Milestone read errors before consume/POST; no-candidate structured reason | actual default service/context-store tests; later explicit attempt preserves ticket |
| Issue then MR POST, zero subsequentGET/PUT/GraphQL/retry/readback | default request sequence and fault-injection tests |
| Explicit legacy workItem and dry-run preserved | focused production-default-label regression tests; actualGit dry-run retest |
| Raw file/stdin bytes, Unicode/duplicate keys/invalid encoding, unchanged caller file | native C# fixture hashes in final34/34runner suite |
| Known CLI errors, original full envelope/numeric spelling, one JSON, safe diagnostics | native framing and early5MBrefusal cases; real0.1.11 CLI local smoke |
| SamePID beyond30seconds; controlled cancellation cleanup; no implicit recovery | final long case32.85s and controlledStop2.31s, one native start |
| Malformed output and source IO safety | strict JSON matrix,0xff+3MBnaturalexit0, reallockedtail Request zerochild |
| Default install/PATH/explicit executable and all3absolute path boundaries | native installer-discovery and6relative-path rejection cases |
| Default<=80lines, mirror/generated semantics, actual package contents | finalasset43/43; actualZIP byte audit,65linebody,6standalone/14pluginfiles |
| No new runtime deps/schema/history/Bundle mutation | package/lock diff, source reviews, no productTS in finalfix |
| ActualGit new/omitted default paths | new35.84s pass; omitted33.64s pass after one localprocesslock transient |

## Commands and timing

Toolchain: Node24.16.0, WindowsPowerShell5.1, native Windows exe. All long jobs were observed as the same process with logs.

- Baseline focused batch104/104,136.91s. Milestone/affected regression batch175/175,342.59s.
- Final runner34/34,97.13s; no skips/cancellations. SEA/migration fixtures13/13,3.61s.
- Two complete Bash workflow contract files21/21,31.75s with existingGit/bin onPATH. Cache fixture24/24,111.40s. Sanitized text case1/1,3.61s. Finalasset43/43,3.58s.
- Global typecheck exit0,14.27s; after finalfix typecheck exit0,23.21s. Application build exit0,4.20s.
- SEA build produced a fresh source-bound receipt; its original child exitcode was not retained because of a REPL binding issue. Receipt/hash/input verification and5native probes independently passed. Build log has preexistingCJS import.meta and PE-signature injection warnings; the self-test/contract/renderer/schema/profiles probes exit0 from an emptydirectory.
- Final realCLI runner negative smoke: INPUT_ERROR, remoteWrite=not-attempted,1create,nativeexit2,step519ms,total728ms. This is not successful liveGitLab latency.
- No fixed1-1.5minute production performance claim is made; the next authorized real submission can measure the delivered timings.

## Complete inventory and honest limitations

All4existing WindowsCIgroups ran, each internallyserial. Exactly163testfiles completed once, none missing/duplicated. Initial aggregate: **2493tests,2397passed,23failed,73skipped,0cancelled**, wall31m31.8s. Group elapsed:13m5.7s,29m38.5s,17m12.5s,31m31.8s. This raw run was notgreen and was not silently replaced with a synthetic sum of later retests.

18initial failures were subsequently covered by correctedenvironment/fixtures or passing targeted reruns: GitBashPATH10; staleSEA/migration/text3; cache2; actualGitdry-run/new/omitted3. The actualGit omitted first rerun had a localcandidate process-lock failure before writes; its isolated rerun passed, and both results are retained.

Five initial failures remain in four baselinefiles. Relevant tests and production implementations byte-match the preimplementationbase; they were not bypassed:

| Baseline area | Remaining initial failures | Evidence/limit |
|---|---:|---|
| native-executable-store |1| aftersealing,realpath(executablePath) throwsEPERM; protectedACLmetadata rules=[]; exactfailure reproduced |
| native-readiness |2| first case calls>=2 assertion fails under1500mstotaldeadline; secondinitialfailure not separately classified |
| production-channel |1|304race test expects securityrejection but operation resolves; exactfailure reproduced |
| immutable Bundle |1| bundledschema8568B vs current request8771B; workItem required/default mismatch already present; preserveBundle1.2.0bytes |

These keep the broad release/regression gate open. They do not change the tested scope acceptance above. This delivery preserves the local branch and evidence; no merge/release/global installation is implied.

## Artifact audit

- Nativeexe94541312B, SHA256 `cb60f481235d383a4279ec1edbad86aac22a280e8c6324e301ee7c55fb3fa393`.
- StandaloneSkill ZIP64927B, SHA256 `7e1bcdf2abf70b7c9a74bc6f9a1607baa80ac42784bb0a9a23769be7656901c8`.
- PluginZIP126485B, SHA256 `bb2ee30ae893ade3dc2b181edd755259da290f7c875fae0423e7c767a8d06134`.
- NoNode/node_modules/.git/.env/runtime executable in either Skill/pluginZIP. Actual packagedSKILL/runner/reference bytes match canonical sources; both runner ASTs parse underPS5.1.

Local delivery: outputs/harness-mrtool-0.1.11 under the Codex workspace. Evidence includes full-inventory-results.json, full-failure-dispositions.json, allfocusedlogs, reviewreports and artifact-audit.json. The app executable receipt remains valid because the finalfix changes only PSassets/tests, not application buildinputs.
