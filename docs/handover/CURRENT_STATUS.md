# Current status at handover

Prepared 26 October 2026 from the available conversation and its supplied artifacts.
This file has NOT been reconciled with the user's current filesystem or live GitHub repository.

## Transfer constraint confirmed by the user
The original conversation export is unavailable. The user explicitly asked to move forward without it. This package is the standalone requirements/context handover; no future transcript delivery is expected. Read the decision history and gaps checklist, then inspect the real repository. This transfer changes documentation only, not application implementation status.

## The next assistant's first task
Read the repository without changing it, establish its exact state, and report whether Interview Phase 3 is unapplied, partly applied, or already present. Do not immediately start a new feature or reapply the patch.

Inspect current branch/HEAD, `git status`, relevant diffs, `package.json`, README, runtime files and test files. Then run the existing mock test suite with approval after checking it does not load credentials or perform billable calls. Record actual results, not expected historical totals.

## Last user-confirmed state
- Repository: `PatRick24678/AI_Twin` on GitHub.
- The user committed the model-led adaptive interview overhaul on main as historical commit `4845725` (not necessarily the current HEAD).
- A push was rejected because GitHub had newer commits; the user subsequently confirmed the merge/push worked.
- The real development branch is `Pat`, not the initially described `Patrik`.
- Switching to `Pat` printed a Windows directory-removal warning for `test-support`. The user chose `n`; Git then confirmed the branch switch and a clean working tree.
- The branch was then instructed to fast-forward from `origin/main` and push `Pat`; the user proceeded to the next phase. Verify today's branch/HEAD rather than reconstructing history from that exchange.
- The user intends private development for most of the internship, restricted deployment near the end, and no personal long-term maintenance obligation.

## Latest delivered change — not confirmed applied
Interview Phase 3 was delivered as a patch, a 19-file ZIP and a complete code reference. It adds grouped source-linked profiles, up to two sample clarifications, scoped approval and a richer twin context.

The user's last implementation decision was: “I'll just implement the changes we did for phase 3.” No subsequent successful application, test run or commit was supplied before this handover request.

Therefore: **delivered / planned to apply, local installation and live behaviour unverified**.

Possible indicators (inspect contents and diffs, not filenames alone):
- `lib/profile-core.mjs` and `lib/profile-builder.mjs`.
- `test/profile-core.test.mjs`, `test/profile-http.test.mjs`.
- Structured profile entries, provenance, scope, clarification state and unknown topics.
- Changes to `/api/sample`, profile review and the context sent to the twin.

## Historical test reports — not current verification
The earlier assistant reported these counts on reconstructed versions with mock models:

| Delivered stage | Reported full-suite count |
| --- | ---: |
| Starter | 6 |
| Adaptive reply length | 18 |
| Personalised buttons / loading UI | 31 |
| Anthropic adapter | 45 |
| Interview Phase 1 | 66 |
| Interview Phase 2 | 87 |
| Interview Phase 3 | 129 |

These are useful clues about revisions, not acceptance targets to force. Different collaborator changes may legitimately change counts. No live provider quality, deployment security or current local test run is established by those old reports.

## Not implemented by the delivered Phase 3 artifacts
Persistent database, secure user login, returning-user memory, voice, avatar creation and original-versus-draft comparison are separate future features.
Work samples are still pasted text, with a 1,600-character cap in the delivered Phase 3 input. No PDF/DOCX/XLSX upload parser is included.

## Update after local inspection (26 Oct 2026, Claude Code)
- Inspected commit/branch: `Pat` at `37a934c`. `main` is at `3ccf48e` (one commit behind, no Phase 3).
  The last local `git fetch` was 15 Oct, so GitHub may hold newer collaborator commits not seen here.
- Working-tree changes at inspection: only untracked `CLAUDE.md` and `docs/`.
- Phase 3 status: **integrated in source and committed** as `37a934c` (the same 19 files as the delivered ZIP).
  Interview → sample → audit/clarify → grouped review → suggestions → twin is wired; the twin and suggestions use `profileContext()` only.
- Baseline test: `npm.cmd test` (mock only, no secrets loaded) → **129/129 pass** on Node 24.21.0.
- Live model behaviour: NOT VERIFIED.

## Increment: thorough interview (approved 26 Oct 2026; committed together with the skip fix below)
Problem reported: live interviews ended after about four questions.
Cause found in code: the interviewer could finish on "coverage" once the five core topics each had one note, which a few rich answers satisfy.
The prompt also said "no artificial minimum". The token budget was not the limiting factor.
User decision: a thorough interview, **minimum 10 answered/skipped turns before a coverage finish, cap 24**. Spending more of the $150/month allocation is acceptable.
- `lib/interview-contract.mjs`: `turns` 16 → 24 and new `minTurnsBeforeFinish: 10`.
- `lib/interview-state.mjs`: a coverage finish requires the core areas AND the minimum turns. Three consecutive empty/skipped turns, or "stop", still end early.
- `lib/interviewer.mjs`:
  - Budget: `attemptsTotal` 48 → 72, `answerCharactersTotal` 12,000 → 24,000, `promptBytes` 48,000 → 120,000.
  - New `maxOutputTokens: 2400` for interview turns.
  - Prompt asks for depth across the secondary topics, without pressure.
- `lib/anthropic-model.mjs`: request limit exported as `MAX_PAYLOAD_BYTES`, 64,000 → 160,000.
- `lib/profile-builder.mjs`: profile `promptBytes` 46,000 → 90,000, so more notes don't hit a new limit there.
- Tests (intentional assertion changes):
  - The one-answer coverage finish is now rejected.
  - The turn-limit test uses `INTERVIEW_LIMITS.turns`.
  - The adapter journey call count is 8 → 11.
  - The oversized-prompt test uses `MAX_PAYLOAD_BYTES`.
  - The fixture pads with three skips after the supplied answers.
  - Added: a full-length prompt-budget test and an output-ceiling assertion.
- Result: `npm.cmd test` → **130/130 pass**.
- Not verified: live interview length/quality and real token cost per interview.
  The later turns send a larger transcript, so prompt caching is a sensible follow-up increment.
## Fix: skipping a question ended the interview (same commit, 26 Oct 2026)
Reported live, twice: Skip → "interviewer failed" → Retry → "stopped at its processing limit".
The arithmetic shows Claude's reply to the skip failed validation four times in a row:
- 2 attempts per call (normal + repair) × 2 calls = the per-turn cap of 4.
- Provider errors are not repaired, so they could not use up 4 attempts in two clicks.
An offline replay of the reported interview showed the controller accepts a correct skip reply. It rejects a skip recorded as a "declined" boundary or a note quoting an earlier answer, and the repair message ("Evidence must reference the current participant answer") gives the model nothing actionable.
The exact model output was not captured. This cause is the most likely one, **not proven**.
- `lib/interview-state.mjs`: on a skip, ignore model-returned observations/boundaries/retractions/stopQuote. The opening still rejects them.
- `lib/interviewer.mjs`:
  - The prompt says not to record a skip as a boundary.
  - A failed turn carries `error.reasons` (validator rule text only).
- `server.mjs`: prints `Interview turn rejected: …` to the terminal on a failed turn, so the next failure has evidence.
- Tests:
  - The skip-evidence test now asserts that stray fields are *ignored* (it used to assert a rejection). The guarantee is unchanged: a skip never becomes evidence or a refusal.
  - Added an opening-evidence test and a rejection-reason test.
- Result: `npm.cmd test` → **132/132 pass**.
- Committed as `045c96e` and pushed to `origin/Pat`. A live run confirmed that skipping no longer ends the interview.

## Interview redesign after live feedback (26 Oct 2026, three commits on `Pat`, not pushed)
Live feedback on `045c96e`:
- The participant steered the interview: questions grew out of the last answer, even after a skip.
- It was too long, the end was unclear, and "how much longer?" ended it abruptly.
- Acknowledgements were formulaic.

User decisions:
- About 6 questions (5–8), hard cap 10. The 10-question minimum is dropped.
- Signposting in the interviewer's words only, with no UI progress element.
- Stay on Haiku 5.5 and improve the prompt first.

1. `ba4e505`, **pace and a signposted ending.** `INTERVIEW_LIMITS` is `turns: 10, targetTurns: 6, latestLastQuestion: 8`.
   - `interviewPace()` gives the question number, `exploring`/`wrapping_up`, `lastAllowed` (from question 5 with the core covered) and `lastRequired` (question 6 with the core covered, or question 8).
   - The controller sets or clears `question.last` itself. Answering or skipping the last question ends the interview with the model's closing line.
   - `none` is only accepted after 3 empty turns. A question about the interview is not a stop. `attemptsTotal` is 40.
2. `0b1c12c`, **the interviewer leads.** `question.move` is `follow_up` or `new_area`.
   - A `new_area` must open an unasked topic. After a skip, or after one follow-up, a `new_area` is required.
   - The rule relaxes when none remain. Rejection messages list the allowed topics.
   - The turn data carries the person-first `unexploredAgenda` (`INTERVIEW_AGENDA` in the contract) and `mustChangeSubject`.
3. `e56e42c`, **voice.**
   - A VOICE prompt section: optional, specific acknowledgements; banned stock phrases; varied question shapes; two tone illustrations from other domains.
   - `withoutStockPhrases()` strips stock filler sentences from question-turn acknowledgements instead of rejecting the turn. Closing lines are untouched.
- Intentional test changes:
  - The min-10 tests were replaced by pace tests.
  - The adapter journey call count is 11 → 9.
  - The opening-finish message is now "end abruptly".
  - Tests that re-ask a topic now declare `move: 'follow_up'`.
  - The fixture offers `last` from question 5.
- Result: `npm.cmd test` → **137/137 pass**.
- **Not verified live.**
  - Next: one live run with a fictional persona. Include a Skip, and ask "how much longer?" midway.
  - Check that the end is signposted at about 6–8 questions, the skip changes subject, at least one question is about the person, and the acknowledgements vary.
  - If the voice is still formulaic, discuss Sonnet for interview turns only.
  - Limitation: the model sees `pace` from before its own notes on the current answer, so the controller can occasionally mark a question as last without "one last thing" wording.
- The three commits were pushed to `origin/Pat` on 28 Oct 2026 (`045c96e..e56e42c`).

## Roadmap review and voice mode V1 (28 Oct 2026)
The approved plan (roadmap order):
1. Phase 0: live-test the interview, PR `Pat` → `main`, optional prompt caching.
2. **Voice** first.
3. Then: draft comparison panel, profile-review UX, evaluation pass, file uploads, avatar (description route), saved profiles/login, deployment.

**V0 provider decision: Mistral Voxtral** (user decision), compared with Groq Whisper.
- Mistral: EU processing by default, about $0.0035/min (secondary sources), 30-day abuse-monitoring retention unless ZDR is approved.
- Groq: US storage, self-serve ZDR.
- Before real participants: confirm the price in Mistral's console and request ZDR.

**V1, voice mode for the interview** (one commit on `Pat`, not pushed):
- A side 🎤 toggle, off by default and remembered in `sessionStorage`.
- Questions and the closing line are read aloud with browser `speechSynthesis`, preferring a local English voice. Then recording starts with `MediaRecorder` (Stop/Cancel, 60 s).
- `POST /api/transcribe` → Mistral → the transcript goes into the answer box for checking. Nothing is an answer until Send.
- New `lib/speech-model.mjs` (`MistralSpeech`, injectable fetcher, safe errors).
- `lib/load-secrets.mjs` also reads the optional `MISTRAL_API_KEY` from the same external file, and never stops the app without it.
- `/api/info` gains a `voice` field.
- Audio: 2 MB cap, webm/ogg/mp4/wav, in memory only, not logged. The transcript is not stored in the session. 40 transcriptions per session.
- Tests: `test/speech.test.mjs`, 7 tests with fake fetchers and a fake service. `npm.cmd test` → **144/144 pass**.
- **Not verified:**
  - The real Mistral request: multipart upload is assumed; the docs were ambiguous.
  - Browser recording and playback in Chrome/Edge.
  - Microphone permission flow.
  - Voice quality.
  - The user must add `MISTRAL_API_KEY` to the external secrets file themselves.
- Next: a manual voice test. Then V2, the same toggle in the twin chat with speakable replies.

## Voice mode V2: conversation + voice picker (29 Oct 2026, one commit on `Pat`, not pushed)
- The live test of V1 showed the voice works ("passable"). It also showed the "invalid turn" after two vague answers, fixed in `4e89254`: closed topics are now explained, and the cause is likely but not confirmed.
- The same 🎤 toggle now also appears in the future-self conversation. The shared voice bar is moved into the active panel.
  - Finished twin replies are read aloud.
  - Speech is transcribed into the message box. `/api/transcribe` now also accepts the `twin` stage.
- Voice picker: a list of the browser's English voices, remembered per tab, with a "Hear it" preview. The note discloses when a voice is online.
- A `voice` flag on `/api/interview/next`, `/api/answer` and `/api/twin` adds speakable-wording instructions (`INTERVIEW_VOICE_MODE`, `TWIN_VOICE_MODE`). It never changes state or evidence.
- User decision: spoken messages to the twin count like typed ones for reply length (the existing `say` path).
- Result: `npm.cmd test` → **147/147 pass**. The browser behaviour needs a manual check.
- Committed as `65c83a5`.

## Hands-free voice (29 Oct 2026, `e9579b6`, pushed to `origin/Pat`)
User request: auto-send after a pause, for immersion.
User decisions:
- A **2 s** pause ends a turn.
- A **3 s review countdown for interview answers only**. Twin messages send immediately.
- **On by default** in voice mode, with a checkbox to switch it off.

Implementation:
- New `public/voice-activity.js`: a pure silence detector with noise-floor calibration, 400 ms of speech minimum, 8 s with no speech means nothing is sent, and a 60 s maximum.
- `app.js` runs a Web Audio analyser while recording. After transcription, twin messages call `requestSubmit` straight away; interview answers get the countdown with Send now / Edit first, and touching the text cancels it.
- No barge-in.
- Tests: `test/voice-activity.test.mjs` (5 tests). `npm.cmd test` → **152/152 pass**.
- Live check by the user (29 Oct 2026, one microphone and room, interview only):
  - The turn ends close to when they stop talking, without cutting them off.
  - About 8 s of silence turns the microphone off and sends nothing.
  - The defaults stay as they are.
- Not yet verified live: the twin chat with hands-free (sending immediately, then listening again), profile finalisation after a voice interview, and other microphones or noisier rooms.

## Prompt caching: considered and deferred (29 Oct 2026)
- Measured with the mock interview:
  - About 2,000 cacheable tokens per interview turn: the fixed instructions.
  - The changing state grows from about 500 to 1,800 tokens per turn.
- At Haiku 5.5 prices that saves well under a cent per participant.
- The user chose to skip caching for now.
- Revisit if the model changes to Sonnet, or volume grows.

## Product decision: "Top problems" (Sander, Tatoma, 29 Oct 2026)
- The tool identifies the participant's top problems that AI could help with, and the twin then helps them work on each one.
- This is a second key feature next to free chat, starter buttons and drafting. It does not replace them.

User decisions:
- Problems are identified **live during the interview**, and the person reviews them in the profile check.
- **Up to 5, never invented.**
- Only a **light nudge** in the interview: still about 6 questions.
- In the twin, **problem cards open a focused session**.

Planned in three increments:
1. The interview tracks problems.
2. The profile check confirms them.
3. Problem cards and focused sessions in the twin.

### Increment 1: the interview tracks problems (committed on `Pat`, not pushed)
- `PROBLEM_UPDATE_SCHEMA` in `lib/interview-contract.mjs`: the turn schema gets `problems`, with at most 2 add/update/drop updates per turn, each with an exact quote. `INTERVIEW_LIMITS.problems = 5`.
- `lib/interview-state.mjs` `applyProblem`:
  - Each update is validated on its own. An invalid one is discarded into `state.problemDiscards` and never fails the turn. The server logs `Problem updates discarded: …`.
  - At most 5 active problems; a full list forces an update or drop.
  - Dropped titles cannot return.
  - Declined or not-applicable topics drop their problems.
  - Skips and acknowledgement-only answers are ignored.
  - `workingProfile().problems` returns the active list.
- `lib/interviewer.mjs`: a PROBLEMS prompt section, plus `trackedProblems` and `droppedProblemTitles` in the turn data. When wrapping up with fewer than 2 problems, the interviewer prefers friction or desired_change.
- Not visible in the UI yet: that comes in increment 2.
- `npm.cmd test` → **155/155 pass** (3 new tests).
- Not verified live: whether Haiku tracks sensible problems, and how often updates are discarded.

### Increment 2: confirm the problems in the profile check (committed on `Pat`, not pushed)
- `lib/profile-core.mjs`:
  - `createProfileDraft` seeds `draft.problems`, re-checking every quote against its source answer. Manual mode starts with none.
  - `confirmProfile` checks `body.problems`:
    - At most 5. An empty list is allowed.
    - Only the fields `{id, title, detail}`.
    - Unknown IDs, duplicate titles and empty titles are rejected.
    - Origin is `interview`, `participant_edited` or `participant`.
  - `profileContext().problems` passes `{id, title, detail}` only, without quotes.
- `publicSession` exposes `profileDraft.problems`.
- UI: a "Problems your future self could help with" group at the top of the profile check, using the existing claim-card style.
  - Each problem has an editable title, an optional context field, "Why this appeared", and Remove.
  - "Add a problem" is available while there are fewer than 5.
  - When there are none, an honest line says so.
  - Confirm sends `problems`.
- `npm.cmd test` → **158/158 pass**.
- Not verified live: the review UI in a browser, and the quality of problems from real interviews.

### Increment 3: problem cards and focused sessions in the twin (committed on `Pat`, not pushed)
- `lib/prompts.mjs`:
  - The shared twin rules are now `twinSystem()`.
  - New `problemMessages()`. It adds a PROBLEM SESSION section and `focusProblem` as reference data, and uses that thread's own history and pacing.
  - `PROBLEM_EXCHANGES = 6`.
  - The main twin prompt notes that `confirmedProfile.problems` exist and should be mentioned only when relevant.
- `server.mjs` `/api/twin` accepts an optional `problemId`:
  - It uses `s.problemThreads[id]`; only `open` and `say` are allowed; the limit is 6 exchanges.
  - It reuses the same streaming and commit-only-when-complete path.
  - `/api/profile` resets `problemThreads`, and `publicSession` exposes them.
- UI:
  - "Your top problems" cards sit above the conversation. "Work on this" opens a new session; "Continue" resumes one.
  - A "Working on: …" bar has a "Back to the conversation" button.
  - Starter buttons are hidden while focused.
  - Voice listening follows the active thread and its limit, and switching threads doesn't re-read old replies.
  - The export includes `problemSessions`.
- New `test/problems.test.mjs` (2 tests). `npm.cmd test` → **160/160 pass**.
- Not verified live:
  - The browser UI.
  - The quality of the problem-session opening.
  - Voice mode inside problem sessions.
  - How the twin uses problems in the main chat.

### Fix: question shown twice (29 Oct 2026, reported live)
- The opening greeting repeated the question that `question.text` also held, so the app showed it twice. In voice mode it was also read aloud twice.
- The prompt now says never to put the question in the acknowledgement.
- Safety net, `withoutQuestion()` in `lib/interview-state.mjs`: it drops acknowledgement sentences that contain the question, or are a reworded copy of it (a question sentence sharing at least 75% of its words).
- `npm.cmd test` → **161/161 pass**.

## Live transcription (29 Oct 2026, one commit on `Pat`, not pushed)
User request: see words appear while speaking.
User decisions:
- Use Mistral realtime, the same EU provider.
- Keep the interview countdown; the twin still sends at once.

Implementation:
- **`lib/speech-model.mjs` `liveSession()`**:
  - Mints a short-lived `rt_` token via `POST /v1/client/sessions` with `{purpose:'realtime', model}`. Fixed URL, no redirects, safe errors, token format checked.
  - Returns `{url, token, expiresAt}`.
  - Settings: `MISTRAL_REALTIME_MODEL` (default `voxtral-mini-transcribe-realtime-2602`); `MISTRAL_LIVE=off` disables it.
- **`server.mjs`**:
  - `POST /api/transcribe/live` has the same stage gate and shares the 40-per-session limit.
  - `/api/info` reports `voice.live`.
  - The CSP adds `connect-src wss://api.mistral.ai` only when live is configured.
  - Static routes added for `/live-transcript.js` and `/pcm-worklet.js`.
- **`public/live-transcript.js`** holds pure helpers: 16 kHz PCM conversion, base64, protocol messages and the event reducer.
- **`public/pcm-worklet.js`** is the capture worklet.
- **`public/app.js`**:
  - One shared AudioContext runs the pause detector and the live capture.
  - Audio is queued until the socket opens, so the first words aren't lost.
  - Deltas fill the read-only box; `transcription.done` replaces the live text.
  - Waits up to 5 s for the final transcript.
  - Falls back to the locally recorded audio via `/api/transcribe`.
  - Cancel and no-speech restore the box.
- **Fix:** voice controls in a problem session no longer depend on the main chat having started.

Tests: `test/live-transcript.test.mjs` (4) plus 3 in `test/speech.test.mjs`. `npm.cmd test` → **168/168 pass**.
- One existing assertion was extended for the new `voice.live` field in `/api/info`. That is a contract addition, not a loosened check.

Not verified live:
- The Mistral realtime handshake: the subprotocol token and message format follow the docs, untested against the service.
- Latency, and the quality of the final transcript.
- The fallback path in a real browser.
- AudioWorklet behaviour across browsers.

Open before real participants:
- Confirm realtime pricing (third-party sources say about $0.006–0.008/min), retention and ZDR on Mistral's site.

## Fixes after the user's live test (29 Oct 2026)
- **Voice in the profile clarification:**
  - Server: `voiceAllowed()` in `server.mjs` allows transcription while a clarification question is waiting.
  - Client: the question is read aloud and answered by speaking, with the same 3 s review countdown as interview answers. The countdown now submits whichever form is active.
- **The interviewer recovers by itself:** when a response fails and the turn still has budget, the browser retries `/api/interview/next` automatically, twice at most, after 1.5 s and then 4 s. The Retry button appears only after that. The budget is unchanged: 4 attempts per turn, 40 per interview.
- **"Limit reached" after Reset:** not reproduced. Reset deletes the server session; 25 sessions were created and reset in a row without hitting the 20-session cap.
  - Possible other causes: Claude's 429 rate or spending limit, or "Another AI request is running".
  - Asked the user for the exact message.
- **Interview failures:** the root cause is still unknown. Asked the user for the terminal's `Interview turn rejected:` lines.
- `npm.cmd test` → **169/169 pass**.

## Accounts, saved twins and privacy (2 Nov 2026)
- Pat was merged into main by the user (main == Pat at 8693778).
- User decisions:
  - Local first, cloud-ready: node:sqlite behind lib/store.mjs.
  - Roles: participants plus a Tatoma admin who cannot read content.
  - Login: email + password.
  - Retention: Claude to recommend; see PRIVACY.md.
- Plan: (1) storage foundation, (2) accounts + saved twins, (3) privacy controls, (4) admin, (5) later, the hosted step.

### Increment 1: storage foundation (committed on Pat, not pushed)
- lib/crypto-box.mjs: AES-256-GCM with row-bound context; HMAC lookups; key DATA_ENCRYPTION_KEY from the external secrets.env.
- lib/store.mjs:
  - SQLite with migrations (PRAGMA user_version), foreign keys cascading on delete, WAL mode.
  - Covers users, auth_sessions, twins (one encrypted document each) and audit_log.
  - purge(): 6 months inactive (participants only), expired sessions, audit entries after 12 months.
  - The database path defaults to %LOCALAPPDATA%\Tatoma\AI-Twin\data and refuses cloud-synced folders.
- scripts/init-storage.mjs (npm run init:storage): appends the key without printing it, and is idempotent.
- PRIVACY.md: the data inventory, roles, processors and open legal items.
- engines >=22.13.0. Not wired into the server yet.
- npm.cmd test -> 175/175 pass (6 new store tests).

### Increment 2: accounts and saved twins (committed on Pat, not pushed)
- lib/auth.mjs:
  - scrypt password hashes with a decoy hash for unknown emails.
  - 12-128 character passwords with a small deny-list.
  - Login IDs are kept in an HttpOnly SameSite=Strict cookie (fs_session) and stored hashed; 12 h absolute, 30 min idle.
  - Throttle: 5 failures per email, then a 15 min wait.
- lib/load-secrets.mjs loads the optional DATA_ENCRYPTION_KEY. Without it the app is guest-only.
- server.mjs:
  - Routes: /api/auth/signup, /login, /logout and /me.
  - One in-memory working copy per account (the accounts map), opened from the saved twin.
  - Saved after every POST on response finish. savedDocument() strips work-sample text and runtime fields.
  - A saved workspace requires the matching login cookie.
  - Purge runs at start-up and daily. /api/info reports accounts.
- UI:
  - Welcome screen offers Log in, Create account (privacy notice and consent) and Try without saving.
  - A header shows who is signed in, with Log out.
  - A lapsed login returns to the welcome screen.
  - A new or resumed account starts or continues the interview.
- Tests: test/accounts.test.mjs (6). npm.cmd test -> 181/181 pass.
- Not verified in a browser yet.

### Increment 3: privacy controls (committed on Pat, not pushed)
- savedDocument():
  - After confirmation it drops answers, intake, interview messages, questions, observations and problems, boundary quotes, draft entries and pending answers.
  - It keeps the profile with its evidence quotes, the draft question metadata and answerWordCounts. replyStyle uses the counts.
- Purge: twins without a confirmed profile, untouched for 30 days, are deleted (store.staleTwins, RETENTION.unfinishedDays); the account stays.
- /api/account/export returns the account details and the twin, and is audited.
- /api/account/delete needs the password (throttled) and cascades to logins and twin; the cookie is cleared.
- UI: Export my data, and Delete account (a dialog with password). The done-screen export uses the server export for accounts.
- npm.cmd test -> 184/184 pass (3 new).

### Increment 4: admin (committed on Pat, not pushed)
- scripts/create-admin.mjs (npm run create-admin): asks for email and password (hidden) and creates role=admin. Tested with a temp DB: create, duplicate and mismatch cases.
- Admin login returns no working copy (token empty, session null). The UI shows the admin panel.
- /api/admin/accounts lists account metadata and the last 50 audit entries. /api/admin/accounts/delete cannot target your own account.
- /api/admin/accounts/reset issues a one-time code: 10 characters, 30 min, stored as a hash, audited without the value.
- /api/auth/reset (throttled) sets a new password, ends other logins and closes the old working copy.
- UI: Accounts table with Reset code and Delete, a recent-activity list, and a "Forgot your password?" form.
- npm.cmd test -> 185/185 pass.
- Not verified in a browser yet (increments 2-4).

### Fix: clarification answer could not be validated (2 Nov 2026, reported live)
- Cause: applyProfileAnswer rejected the whole model reading on any single rule break (e.g. one affected entry undecided, or a paraphrased quote). After a call and one repair the step failed, and nothing was logged.
- Now each decision and addition is checked on its own:
  - Valid ones apply; invalid ones are set aside in draft.ignored. The server logs "Profile answer parts set aside: ..." (rule text only).
  - An affected entry without a valid decision stays excluded and the question becomes unresolved, so the participant decides at the final check.
  - The schema shape is still strict (extra fields are rejected).
- Failed profile responses now log "Profile response rejected: ..." like the interview.
- Two tests that expected a thrown error were rewritten to assert the same safeguards on the outcome: unrelated entry unchanged, fabricated quote confirms nothing, bare yes cannot rewrite, extra fields still throw. This was a deliberate behaviour change, reported to the user.
- npm.cmd test -> 185/185 pass.

## Hosting: Google Cloud Run + Neon Postgres (18 Nov 2026, branch `test`)
User decisions in planning:
- Host the proof of concept for free, with a hosted database. Chosen for user experience: **Cloud Run**
  (europe-west4), where the server wakes in about 1–2 s.
- Ruled out:
  - Vercel: serverless, so it needs a stateless rewrite and storing guests and samples.
  - Cloudflare Workers Free: not a Node runtime, and a 10 ms CPU limit.
  - Render Free: about 1 minute to wake.
  - Fly.io, Railway and Koyeb: no free plan.
- Database: **Neon** (Frankfurt). Access: a **shared access code**.
- The work happens on `test`, fast-forwarded from `Pat` (94f99f1), so the working build stays untouched.
  `origin/Evy` has 2 newer commits (OpenUI in the final chat, wallpaper). They were not included; they merge cleanly.
- Local Node is now **v26.13.1**, not 24. Baseline before the changes: `npm.cmd test` → **204/204 pass**.

1. `d8c23cf`, **hosting-ready server.** All settings are optional and default to the old local behaviour:
   - `PUBLIC_ORIGINS`: the allowed Host/Origin values.
   - `HOST`: the listen address.
   - `TRUST_PROXY`: X-Forwarded-For entries from the right.
   - `ACCESS_CODE`: required for `/api/session` and sign-up, with a hashed constant-time compare, throttled per
     visitor. The UI field appears only when the code is required.
   - `AI_CONCURRENCY`: replaces the global `modelBusy` lock with a counter. The default 1 keeps
     `test/interviewer.test.mjs:342` unchanged.
   - `MAX_SESSIONS`.
   - Also: HSTS with secure cookies, a good `/api/health` result cached for 10 minutes, purge on a request once a day
     has passed, and a graceful SIGTERM.
   - New `test/hosting.test.mjs`. Result: **211/211 pass**.
2. `6119a7d`, **hosted database.**
   - New `lib/store-postgres.mjs`, using `postgres` 3.4.9: the first npm dependency, with no transitive dependencies.
     Version 4 is three weeks old, so it was avoided.
   - The store interface is now async. The SQLite store wraps its unchanged synchronous methods.
   - `createStore()` uses Postgres when `DATABASE_URL` is set.
   - An account's change is now saved **before** the reply (`json()` and the twin stream's `done` event wait for it).
     This replaces the save on `finish`.
   - `load-secrets` reads an optional `DATABASE_URL`. `create-admin` uses the configured store.
     `init:storage --production` writes a separate production key to `production.env` (outside the repo).
   - Test changes:
     - `store.test.mjs` and `accounts.test.mjs` only gained `await`.
     - `assert.throws` became `assert.rejects` for the integrity check, which is now async. The same safeguard is
       asserted.
     - The purge test awaits `server.purged`.
     - New: `test/store-contract.test.mjs` runs on SQLite, and on Postgres only with `TEST_DATABASE_URL`. A slow-save
       ordering test was added.
   - Result: **215/215 pass**.
   - `create-admin` and `init-storage --production` were checked by hand against a temporary folder and a temporary
     SQLite database: create, duplicate, mismatch, and idempotent setup.
3. **Container and runbook:** `Dockerfile` (`node:26-slim`), `.dockerignore`, `.gcloudignore`, `docs/DEPLOYMENT.md`,
   README Hosting section, `PRIVACY.md` (hosted processors and backups) and `.env.example`.

Not verified:
- `lib/store-postgres.mjs` has **not run against a real Postgres**. Starting a local throwaway Postgres (PGlite) was
  not approved in this session. Run the contract test against Neon `dev` (see DEPLOYMENT.md).
- The Docker build: Docker isn't installed locally, and Cloud Build builds it during the first deploy.
- Anything on Cloud Run:
  - the `X-Forwarded-For` position (`TRUST_PROXY=1`);
  - long portrait requests, streaming and wake-up times;
  - the free-tier coverage in europe-west4.
- The user still has to create the Google Cloud and Neon accounts, the secrets and the first deploy (DEPLOYMENT.md
  steps 1–8). Whose billing card to use is undecided.
