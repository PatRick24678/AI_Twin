# Gaps, authority and first repository audit

## The missing transcript is an accepted constraint

The original conversation export is unavailable. The user explicitly authorised proceeding without it. This handover reconstructs project-relevant context; it does not prove every nuance or exact message is preserved. Do not ask for the export again, invent a dialogue transcript, or refuse to proceed solely because it is missing.

Other unavailable evidence is equally important: the outgoing assistant did not inspect the user's present filesystem, current GitHub HEAD, external secrets file, Console settings or live-model usage during this handover revision.

## Which source answers which question?

| Question | Source to use |
| --- | --- |
| What does the user want? | Latest explicit instructions and decision records in this handover. |
| What code is installed now? | Actual working tree and branch contents, including uncommitted changes. |
| What was historically delivered? | The named archived ZIP/patch/code-reference artifacts, read as references. |
| Did current tests pass? | A newly approved local test run, with command/result recorded. |
| Does the live model behave well? | An approved live evaluation using fictional data; mocks do not answer this. |
| Are providers/model IDs/prices available today? | Approved account information and official current documentation, not historical assistant statements. |

Do not collapse these categories. Code may implement an unapproved behaviour; the handover may describe a feature not installed yet. Report the discrepancy instead of declaring one document globally authoritative.

## Safe orientation sequence

### 1. Locate the actual checkout

Establish the project root from the editor/workspace, not from an archived ZIP. Inspect branch, HEAD, working-tree state and relevant recent commits. Intended development branch: `Pat`; integration branch: `main`. Historical `4845725` is a clue, not today's verified HEAD. Do not switch, fetch, merge, reset, stage or push automatically.

The known Windows path was:
`C:\Users\pa3kg\OneDrive\Документи\Fontys ICT Year 3\Tatoma_Future_Self_Local_Starter\future-self-local`

The actual editor folder may have moved. Work from it rather than hardcoding that old path.

### 2. Establish the runnable project before executing it

Read package.json, test scripts, README, runtime entry points and fixture imports. Identify which scripts preload the external secret and which tests make no provider requests. Do not print environment values, open `.env`/`secrets.env`, start servers or execute a credential checker merely for orientation.

There is no need to access `%LOCALAPPDATA%\Tatoma\AI-Twin\secrets.env`. Source-level secret-loading logic can be reviewed without reading the file it loads.

### 3. Determine Phase 3 state by behaviour

Presence of `profile-core.mjs` alone is insufficient. Trace:
- Interview completion to the sample/profile-preparation endpoint.
- Active/superseded/retracted interview observations used for profile entries.
- Clarification generation, skip, retry and limited-context continuation.
- Explicit participant approval, profile versioning and stale-entry protection.
- Approved scoped entries passed to suggestions and the twin.
- Raw sample restricted to explicit draft/demo actions.
- Grouped profile UI wired to the new response shape.
- Regression tests/fixtures updated consistently with routes and payloads.

Classify absent / partially applied / integrated in source / verified by tests, rather than using a single unsupported “done.” A green mock suite does not establish real conversational quality.

Never apply the Phase 3 patch simply because the handover lists it. Compare it to relevant working files and report differences first.

### 4. Inspect safety boundaries and regressions

Check session isolation, request ownership, stale IDs, cancellation, failed-turn storage, evidence references and bounds. Confirm suggestions are generated once for the approved profile version, not selected from fixed runtime templates. Confirm button clicks and samples do not become reply-length evidence. Preserve the loading indicator and refused-topic rules.

Mock interview/profile fixtures deliberately contain scripts; do not mistake them for a runtime fixed questionnaire. Inspect imports to distinguish runtime from test support.

### 5. Propose the minimal test command

After reviewing scripts, propose the offline/mock test run, normally `npm.cmd test`. Obtain approval before executing in the receiving assistant's workflow. No actual key should be necessary for the known mock tests. If the local test script differs, report that rather than passing a key to make it run.

Do not force the historical expected totals 87 or 129 by deleting or weakening tests. Report the observed count and failures. Investigate actual failed response bodies with credentials redacted; do not repeat speculative replacements.

### 6. Return an evidence-based orientation report

Report the branch/commit, local changes, implemented flow, Phase 3 classification, tests inspected/run, requirement mismatches, genuine unknowns and the next smallest proposed increment. Reference repository paths in that report. Wait for user approval before implementation.

## What can remain unresolved without blocking code orientation

The missing raw transcript, exact old phrasing, prior consumer-model preference, provider price table, eventual avatar renderer and final production host are not reasons to stop inspecting the interview/profile code.

If live settings are uncertain, use the existing adapter interface and mocks while recording the gap. Do not silently change provider/model. If a final UX decision is open, retain the existing reviewed design until explicitly changed.

## What should trigger a narrow clarification

An actual conflict between current user instructions and delivered product behaviour; a proposed paid/live call; a request to process real participant documents; a destructive Git action; an irreversible schema/data migration; or a consequential requirement absent from both code and the handover.

Ask about that specific point. Do not ask the user to recreate the whole chat or restate confirmed decisions.

## Continuing safely after the audit

Keep the handover current in ordinary repository documentation after approved increments. Record observed state, what changed, tests actually run, untested aspects and the next agreed action. Separate verified facts from recommendations. Maintain the known deferred features instead of dropping them because the original chat is missing.
