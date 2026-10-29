# Tatoma Future Self — private development prototype

A text-first research demonstrator. The Node application runs locally, but the model-led interview, profile extraction,
personal conversation starters and future-self replies now use Anthropic's hosted Claude API.
The current default is `claude-haiku-5-5`. This is not an offline application.

## Requirements and startup

Use Node.js 22.12 or newer. There are no npm dependencies in this version.
The previously added `lib/load-secrets.mjs` startup module must remain in place, together
with the `--import=./lib/load-secrets.mjs` flags in the start/dev scripts.

Store the API key only in the private local secrets file:
`%LOCALAPPDATA%\Tatoma\AI-Twin\secrets.env`, outside the repository and OneDrive.
Alternatively supply ANTHROPIC_API_KEY through the backend environment on an approved host.
Do not commit credentials or store them in frontend files.

Add the non-secret settings from `.env.example` to your existing `.env`, then run:

```powershell
npm.cmd run check:secrets
npm.cmd test
npm.cmd start
```

Open the local address printed by the server. Ollama does not need to be running.
The first browser health check retrieves Claude model metadata; it does not generate text.
Starting a new interview now requests its opening from Claude. Normal answers/skips request the next turn.
These are billable model requests, followed later by profile, suggestion and conversation requests.
A verified metadata request does not guarantee that generation will succeed or fit within the budget.

## Optional voice mode (interview and conversation)

A 🎤 toggle at the side of the interview and the future-self conversation switches voice mode on or off.
It is off by default and remembered for the browser tab. When it is on, each interviewer question (and the
closing line) and each finished future-self reply is read aloud with the browser's `speechSynthesis`.
A voice picker lists the browser's English voices; the default is one that runs on this device, and the
choice is remembered for the tab. Online voices send the text to the browser's speech service, and the note
under the toggle says so. In voice mode the interviewer and the twin are asked for speakable wording (no
lists, markdown or symbols); an explicit request for detail still wins. Spoken messages to the twin count
like typed ones for the reply-length default. Recording then starts
(Stop / Cancel, at most 60 seconds). The recording is sent once to `POST /api/transcribe`, which forwards it
to Mistral's speech-to-text API (`voxtral-mini-latest` by default, EU processing by default). The transcript
is put in the answer or message box for the participant to check and edit. Nothing is sent until they press Send.

**Hands-free** ("Send automatically after a pause", on by default in voice mode): the browser measures the
microphone level (Web Audio) and `public/voice-activity.js` ends the turn after about 2 seconds of quiet
following speech. Short noises do not count as speech, the room's noise floor is calibrated first, and nothing
is sent if nobody speaks within 8 seconds. Twin messages are then sent immediately. Interview answers become
profile notes, so they show a 3-second "Sending in 3…" countdown with Send now / Edit first; clicking or typing
in the text cancels it. Saying "skip this question" or "stop" works as typed. Listening starts only after the
voice has finished reading (no interrupting yet). Untick the option, or use a browser without Web Audio, for
the manual Stop and Send flow. The thresholds are prototype defaults to tune with real use.

Audio is bounded (2 MB, webm/ogg/mp4/wav), held in memory for that one request, never stored or logged, and
the transcript is not saved in the session. There are at most 40 transcriptions per session. Mistral may keep
API inputs for up to 30 days for abuse monitoring unless zero data retention has been approved for the account.

To enable it, add `MISTRAL_API_KEY=...` to the same external `secrets.env` (or the host environment).
Without that key the toggle stays hidden and the app is text-only. `MISTRAL_STT_MODEL` in `.env` can name
another Voxtral model.

### Live transcription: words appear while you speak
Live transcription is on by default when voice is configured. It uses Mistral's realtime model,
`voxtral-mini-transcribe-realtime-2602`, which `MISTRAL_REALTIME_MODEL` can override.

**How it connects**
1. For each recording, `POST /api/transcribe/live` mints a short-lived token. The server calls `POST /v1/client/sessions`, and the token is scoped to one model and lasts about 15 minutes.
2. The browser opens Mistral's realtime WebSocket with that token. **The API key never leaves the server.**
3. An AudioWorklet (`public/pcm-worklet.js`) captures the microphone. `public/live-transcript.js` converts it to 16 kHz PCM and sends it in roughly 100 ms chunks.
4. Recognised words appear in the box as you speak; the box is read-only while recording.
5. When you stop or pause, Mistral's final transcript replaces the live words. Then the usual steps follow: send at once in the twin, or the 3-second countdown in the interview.

**Fallback**
- The audio is also recorded locally.
- If the token, connection or final transcript fails, or the browser lacks AudioWorklet support, that recording goes to `/api/transcribe` as before.
- Audio reaches Mistral twice only in that failure case.

**Settings and limits**
- `MISTRAL_LIVE=off` restores record-then-transcribe.
- Live recordings count towards the same 40-per-session limit.
- The page's CSP allows `wss://api.mistral.ai`, only when live transcription is configured.
- Realtime is billed per audio minute, roughly twice the batch price. Check the current rate and retention on Mistral's pricing page.

## Model-led interview — increment 2

The fixed question list is removed. Claude asks the opening and contextual follow-ups while
updating source-linked tentative notes in the same structured response. The controller from
increment 1 validates evidence IDs, participant boundaries, corrections and stopping limits.
The normal controls are Send and Skip this question. Retry appears only when a response failed;
Continue appears only after the interview has ended. No mid-interview review or rephrasing button.

The participant answer is retained before generation. On failure the app retries the pending
response, not the answer. Requests are tied to the active question/request ID, so stale requests
and double submission cannot silently become another turn. Reset cancels pending generation.
Some exact stop/skip phrases are handled without model interpretation. Nuanced natural-language
refusal/stopping intent and semantic relevance still depend on model behaviour and need real tests.
A quote check alone does not establish whether the interpretation is correct.
A skip has no text, so any notes, boundaries, retractions or stop signal the model returns for a
skip are ignored rather than failing the turn; the skipped topic is paused by the controller itself.
When a turn finally fails validation, the server terminal prints the validator's rule messages
(`Interview turn rejected: …`), never participant text or provider errors.

Normal turns make one model call. Invalid generated content gets at most one repair per request;
manual retries are capped at four API attempts for the same turn, and 40 across an interview.
The interview aims for about 6 questions: the opening says so, the interviewer signposts from question 5,
and one question is marked `last` (allowed from question 5 once the core areas are addressed, required
at 6 with the core addressed, and at 8 regardless). The controller sets or clears that flag itself rather
than rejecting the turn. The answer or skip to the last question ends the interview with the model's
closing line. Hard cap: 10 turns, 3,000 characters per answer, 24,000 in total. "Stop" or three consecutive
skipped/uninformative turns still end it earlier; a question such as "how much longer?" does not.
The interviewer leads: each question is a `follow_up` or a `new_area`. A new area must open a topic not yet
asked, chosen from a person-first agenda (role, what they keep/enjoy, friction, AI, communication, desired
change, then process details). After a skip, or after one follow-up, the next question must be a new area.
That rule relaxes once no unasked topics remain.
The prompt asks for a warm, curious voice: optional, specific acknowledgements and varied question shapes
(curiosity, small hypotheticals, either/or). As a safety net, the controller strips stock filler sentences
("Thanks for letting me know.", "That makes sense.", "X can definitely be Y") from acknowledgements on
question turns instead of rejecting the turn. Closing lines are left as written.
Interview turns use a 2,400-token output ceiling and a 120,000-byte prompt
budget inside the adapter's 160,000-byte request limit. Exhausting a
processing budget ends with an honest partial-state message, never invented profile details.
The developer usage panel accumulates reported interview tokens (including completed invalid
outputs). Failed/aborted requests with unavailable usage are marked incomplete. These are not invoices.
No prompt caching is enabled by this commit; cache counters are recorded if returned by the API.

### Top problems: tracked live during the interview
Next to its notes, the interviewer keeps up to 5 "problems AI could help with":
- They must be recurring, concrete burdens, described in the person's own words and each backed by an exact quote.
- Each turn may add, update or drop at most 2. Most turns change nothing.
- When the list is full, the interviewer has to update or drop one, so the 5 kept are the strongest.

Safeguards:
- A dropped problem's title cannot come back.
- Declining a topic drops that topic's problems.
- Skips and plain acknowledgements ("okay") cannot create problems.

These updates are optional extras. An invalid update is discarded and the server terminal prints
`Problem updates discarded: …` (rule text only). It never fails or repairs the interview turn.

The interview itself is unchanged: about 6 questions, and the list is never shown during the interview.
The only nudge: when wrapping up with fewer than two problems, the interviewer prefers friction or
desired change for its next new area.

In the profile check, the tracked problems appear as "Problems your future self could help with".

Seeding:
- They are seeded from the interview only after each quote is re-checked against its original answer.
- Problems whose quotes all fail the re-check are left out.

What the participant can do:
- Reword, remove or add problems, up to 5. None is also fine.
- Each one has a "Why this appeared" section.

On confirmation:
- `confirmProfile` stores `profile.problems` with an origin: `interview`, `participant_edited` or `participant`.
- `profileContext()` passes only `{id, title, detail}` to the twin, never the quotes.

In the twin, the confirmed problems appear as "Your top problems" cards. "Work on this" opens a focused session:
- **Thread:** each session has its own thread, `session.problemThreads[id]`, and its own limit of 6 exchanges. It sits next to the main conversation (8 exchanges) and the starter buttons, which are unchanged.
- **Opening:** a clearly hypothetical scene of how the future self handles the problem with AI support, what still needs the person, two or three first steps to try now, and one question.
- **Later turns:** the session can produce drafts, checklists, reusable prompts or a structure for their information. These are labelled as unsent, unverified drafts.
- **Honesty:** it never claims the problem is solved and never promises time savings.

`/api/twin` takes an optional `problemId`:
- It must belong to the current confirmed profile.
- In a problem session only `open` and `say` are allowed.
- Editing the profile resets all problem sessions.

The problem text is sent as reference data, not as instructions. Voice mode works the same way in problem sessions.

## Structured profile — increment 3

This increment replaces the six-flat-statement handoff. Active interview observations are copied
without generative rewording into source-linked categories. Exact same-topic duplicates are merged;
unknown areas remain unknown. Superseded or withdrawn observations never seed a new profile.
Only a participant answer with a matching quote can seed an interview entry. This is provenance
validation, NOT semantic truth verification. The original interviewer can still misinterpret an answer.

One normal Claude request checks for consequential ambiguity and optionally examines a work sample.
It may propose zero to two targeted clarification questions, not a compulsory extra questionnaire.
A sample supports at most four contextual writing observations only when the participant says it is
self-authored and typical. Borrowed samples remain drafting artifacts, not evidence of personality,
responsibilities, tools, clients or professional history. Fictional style examples contribute only an
explicitly selected exercise preference, never their fictional events.

Send and Skip remain the clarification controls. A skipped or unresolved clarification leaves its
related entries excluded by default. One answer produces at most one interpretation request; there
are no recursive follow-up questions. Common explicit stopping/refusal phrases work without a model
call. Participant-ending and blocked-topic state from the interview is respected during preparation.
The model must identify the right focus/meaning; semantic boundary compliance still needs testing.

The grouped final check is retained as a prototype handoff, not a decision that every final design
must use a separate review screen. Participants can edit, remove, exclude or add statements and
specify their audience/context. An acknowledgement is required before the backend marks included
entries confirmed. Confirmation means user approval, not independent verification. Edits are labelled
as participant changes; original quotes explain provenance, not proof of the edited wording.

Profiles may contain more than six statements (up to 112 as a technical safety ceiling, not a target),
with up to 240 characters per statement, 180 per context and 16,000 combined characters. One meaningful
approved statement is sufficient for a limited twin. Zero entries cannot start a personalised twin;
the participant can optionally supply a statement or reset. No fictional fallback impersonates them.

An approved profile has a schema/version, category-scoped entries, unknown topics and unresolved
areas. The old `facts` array is now a display/compatibility projection, not the source of truth.
The twin and suggestions use the approved structured profile. They do not receive the original
interview transcript, retired notes or evidence quotations during ordinary conversation. A sample
is sent to the twin only for the explicit draft suggestion / demo action, labelled as an artifact,
never as biography. A typed request cannot make the model read a sample that is not in its context:
use the existing generated draft button. A dedicated comparison panel remains a later feature.

Profile edits increment the version, clear chat/style history, and regenerate the three suggestions.
This is still an in-memory session, NOT persistence across restarts or a login implementation.

### Failure and cost controls

`/api/sample` prepares a profile snapshot; `/api/profile/retry` processes a saved pending step;
`/api/profile/clarify` records one answer or skip; `/api/profile/notes` explicitly falls back to available
notes after a failure; `/api/profile` approves the current version. Requests carry the current draft,
request, question or profile-version IDs where appropriate. Stale/foreign IDs are rejected.

Normal profile processing is one audit request, plus at most two answer-interpretation requests.
Grouping, editing, confirmation and skipping do not require inference. Invalid generated content gets
one repair attempt. Connection/provider errors are not automatically retried. Retries are limited to
four attempts per pending step and twelve across this profile workflow; input is preserved, not submitted
again. Reset aborts pending work and cannot resurrect a deleted session. A labelled notes-only path
remains available if the model fails or a limit is reached; it does not claim analysis succeeded.

The profile output ceiling is 2,800 tokens per call, bounded server-side, while ordinary chat and
other structured calls retain their previous defaults. A separate profile-usage panel accumulates
returned usage, including rejected outputs and cache counters, and flags requests with unknown usage.
A skipped analysis may leave ambiguities undetected; the participant must still check the notes.

## Behaviour preserved

Optional work samples, participant confirmation in the existing prototype, adaptive conversational
length, three model-generated suggestions per profile version,
streamed replies, loading indicators, profile correction, reflection and temporary sessions.

The exact-size, length, uniqueness and source-evidence checks remain in the application.
The Claude adapter simplifies unsupported schema constraints for the API; it does not remove the
original local validation or turn model interpretations into independently verified facts.

## Limits and data handling

Use fictional, non-confidential material during this migration. Relevant participant answers,
work samples, confirmed profile and recent conversation are sent to Anthropic. This application
cannot promise that resetting its session erases provider-side records. Confirm Tatoma's permitted
data use and the provider settings before using real professional information.

No account login, durable database, voice or avatar implementation is added by this commit.
Sessions are still held in application memory and expire after about 30 minutes of inactivity.
Keep this version private and bound to loopback. The single-generation lock remains deliberately
in place for development. It is not a multi-user production deployment.

## Cost and error controls

The adapter restricts prompt payload size, uses bounded output tokens, disables automatic HTTP
retries, refuses redirects and sends credentials only to the fixed Anthropic API origin.
The existing suggestion validator may request one repair when structured content is invalid.
There are no model tools or automatic switches to more expensive models.
The browser shows usage for the latest completed model response, not a monthly total.
Use Tatoma's provider-side spending limit and Console reports for total spending controls.
Interrupted requests can still incur provider usage; local cancellation is not a refund.

Haiku 5.5 uses disabled thinking; optional Sonnet 5.5 uses its supported between-tools mode.
Changing the model in `.env` is an explicit developer choice and can change usage cost.

## Tests

`npm.cmd test` uses fake models, in-memory mocked Claude responses and local HTTP test servers.
It does not load the private secrets file, contact Anthropic, or use billable inference.
The adapter suite covers request construction, schema conversion, Unicode SSE streaming,
usage accounting, HTTP failures, refusal/truncation, timeout, cancellation, metadata checks and
an application-level profile-to-chat journey. Live credentials and real model quality must be
checked locally by the developer.

After the interview pacing, agenda and voice changes (26 Oct 2026) the suite passed **137 tests** on Node 24.21.0.
With the optional voice mode in the interview and conversation (29 Oct 2026) it passed **147 tests**: `test/speech.test.mjs` uses fake
fetchers and a fake speech service, so it never contacts Mistral. With hands-free voice it passes **152 tests**:
`test/voice-activity.test.mjs` drives the silence detector with synthetic levels. The browser audio itself is a manual check. The Phase 3 snapshot passed **129 tests** on Node 22.16.0: 87 prior scenarios retained/adapted to the new
profile request shape, 28 new profile-core/builder tests, 12 new profile HTTP tests, and two adapter
output-limit checks. The five older suites changed only where the old six-string confirmation setup
no longer matched the structured profile contract. `test-support/profile-fixture.mjs` drives the real
manual-draft and confirmation endpoints for regression scenarios; it is never imported by production.

Focused checks: `node --test test/profile-core.test.mjs test/profile-http.test.mjs` (40 tests).
Browser checks used simulated model responses and an HTTP bridge to the local test server, covering
source-linked review, sample clarification, skipping, confirmation, editing, errors/retry, notes-only
fallback, one-statement profiles, reset, and 390px mobile layout. No live Claude calls were made.
Real model interpretation quality, inference latency and actual billed cost remain to be evaluated.

The old Ollama adapter and its tests are intentionally retained. Normal startup uses Anthropic;
changing back would require deliberately restoring the old adapter as the server default.

## Official references

- Claude Haiku 5.5: https://platform.claude.com/docs/en/models/haiku-5-5/overview
- Haiku prompting/settings: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5
- Structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Streaming: https://platform.claude.com/docs/en/build-with-claude/streaming
- Model metadata: https://platform.claude.com/docs/en/api/models/retrieve
- Stop reasons: https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
- Sonnet settings: https://platform.claude.com/docs/en/models/sonnet-5-5/overview
