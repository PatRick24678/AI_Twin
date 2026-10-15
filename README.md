
# Tatoma Future Self — local prototype
[ALL WORKS & DESCRIPTIONS SUBJECT TO CHANGE]

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

Normal turns make one model call. Invalid generated content gets at most one repair per request;
manual retries are capped at four API attempts for the same turn, and 48 across an interview.
The interview has at most 16 answered/skipped turns, 3,000 characters per answer and 12,000 total
participant-answer characters. Request payload checks provide another limit. Exhausting a
processing budget ends with an honest partial-state message, never invented profile details.
The developer usage panel accumulates reported interview tokens (including completed invalid
outputs). Failed/aborted requests with unavailable usage are marked incomplete. These are not invoices.
No prompt caching is enabled by this commit; cache counters are recorded if returned by the API.

### Temporary handoff (profile redesign is still increment 3)

The optional work-sample screen and the existing editable profile check remain after the interview.
Only active tentative observations and their original source quotes are bridged to that builder;
superseded/retracted claims are not re-extracted from the full transcript. Source IDs are no longer
restricted to answer1 through answer4. This is not yet the final structured-profile design.
The existing six-statement review limit remains, and the current twin still needs at least two
participant-confirmed statements. Sparse interviews can end honestly; they do not produce a
fictional professional disguised as a personalised twin. Manual statements remain optional.
Sample-based interview follow-ups, a fictional demo fallback and the final review design are deferred.

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

After this update the reconstructed previous code plus these changes passes 87 tests: the 66
previous checks (with four legacy test fixtures updated to complete the new interview) plus 21
new interview-runtime/HTTP checks. `test-support/interview-fixture.mjs` is a deterministic test
helper, not a runtime question bank. Production code never imports it.

Focused checks: `node --test test/interview-state.test.mjs test/interviewer.test.mjs` (42 tests).
Browser checks used simulated model responses and an HTTP bridge to the local test server,
covering loading, failure/retry, skip, stop, reset, mobile rendering and the profile-to-twin flow.
Real Claude behaviour, measured costs and live latency have not been validated by these tests.

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
