# Tatoma Future Self / AI Twin — implementation handover

**Edition: no-transcript handover, 26 October 2026.** The user could not extract the conversation and explicitly asked to proceed without it. Do not ask for the export again or make implementation conditional on obtaining it.

This is a curated reconstruction from the conversation available to the outgoing assistant and the supplied artifacts, not a verbatim or guaranteed lossless transcript. The earlier project handover is retained and supplemented by `DECISIONS_AND_HISTORY.md` and `GAPS_AND_AUDIT.md`. No invented dialogue is supplied as a substitute for the missing archive. Historical artifacts are indexed in `ARTIFACTS.md`.

Read this beside the user's actual checkout. It describes intent and delivered work; code inspection establishes what is installed. The absence of a transcript is not evidence that a requirement was never discussed. Resolve implementation uncertainty from code/tests and report remaining material gaps. Ask only a narrow question when a genuinely blocking product decision cannot be resolved from these records. Do not make the user repeat the whole project.

## 1. Purpose, people and scope

Tatoma helps professionals make the possible impact of AI on their own work tangible. This project is a story-driven demonstrator: describe current work, encounter a recognisable possible AI-supported future, interact with a future-self/twin element, and reflect on a change that could apply to real work.

The intended outcome is recognition and a concrete understanding, not simply a list of AI features. The twin is a framing device for the experience, not a claim to accurately duplicate someone's complete judgment or predict their future. It may talk as a future version of the participant and demonstrate a small task. It must not claim to have accessed accounts, sent messages, scheduled work or completed external actions when it has only generated a draft.

The user, Patrik, handles the technical implementation and some research. Evy contributes media/design. Tatoma contact Israel Roldán manages provider access; Benjamin suggested Anthropic. Sander is the project stakeholder in the original plan. No contact details or credentials are needed for implementation.

The user explicitly rejected narrowing the early audience to one profession: target office/desk workers. Narrow the experience and technical scope rather than silently restricting the profession. First prioritise an interesting, recognisable, “alive” encounter; deeper usefulness follows. Both dialogue and small work demonstrations remain relevant.

Development stays private for most of the internship, with deployment near its end. The user does not promise maintenance after leaving. Deliver a working, tested demonstrator and understandable handover; do not turn this into a large multi-tenant enterprise platform or long-term infrastructure programme. Security, access control and truthful data handling are still required before collecting real participant information.

## 2. Source hierarchy and implementation status

The current repo and actual test results establish implemented behaviour. The latest explicit user decisions establish desired behaviour. The original plan and historical research provide context, but do not overrule later decisions. Earlier assistant proposals are not automatically approved requirements.

Read `CURRENT_STATUS.md`: Phase 3 was delivered and the user planned to implement it, but completion was not confirmed. Do not label it installed solely because its patch exists in the handover archive. The exact latest HEAD and any Evy/upstream edits were not supplied here.

The current codebase must be inspected directly in the user's project folder or checked-out `Pat` branch. Downloadable historical update bundles contain only changed files; none should be mistaken for today's whole repository. Do not reconstruct the production checkout by blindly overlaying them.

The archive includes a research report, concept rationale and source project plan. The research describes six comparator cases (Future You, Delphi, Generative Agents, interview-grounded agents, Personal AI and CoachHub AIMY) and proposes comparison with an ordinary assistant given the same profile/task/model. It is desk research, not evidence that paid tools or Tatoma outcomes were tested. Time-sensitive claims, provider/model names and prices in earlier documents require verification if reused.

## 3. Working style and Git

- Keep compact formatting in code and tests. The user explicitly preferred the compact ZIP versions after seeing shorter test files. Do not expand everything for cosmetic reasons, or delete behaviour to shorten files.
- Provide logically separated, testable increments so the user can commit each one.
- Explain relevant changes, commands and testing honestly. Mock tests do not establish the quality of real model dialogue.
- Use Windows/PowerShell syntax and `npm.cmd`. The user has had pasted multiline commands concatenate, so individual command blocks or explicit separators help.
- Work on `Pat`; `main` is the integration branch. The repo is `PatRick24678/AI_Twin`.
- Preserve cleanly merged collaborator changes; GitHub had newer main commits than the local branch before.
- Inspect before modifying. Do not force-push, reset hard, overwrite local work or auto-apply a historical patch. Get approval before commits/pushes.
- LF/CRLF warnings were line-ending warnings, separate from non-fast-forward push failures. Do not initiate mass normalization to solve an unrelated issue.
- A previous profile-version bug was a case typo: `profileversion: 0` instead of `profileVersion: 0`. `undefined += 1` became `NaN`, serialised as `null`, causing preparation HTTP 409s. Diagnose actual response bodies safely rather than repeatedly guessing.
- The user wants to learn what changes, not have a huge unexplained rewrite. Avoid silently reintroducing rejected controls.

## 4. Current architecture and credential boundaries

Delivered baseline: a small Node.js HTTP server (`server.mjs`) with ES modules (`.mjs`), browser HTML/CSS/JavaScript under `public`, domain/prompt/model modules under `lib`, and Node's built-in test runner. React was considered earlier but is not the implemented baseline. Do not rewrite the framework merely to add features.

Original in-memory sessions drive the stages, hold temporary conversation/profile state and expire after inactivity. Initial loopback-only access, request validation, server-generated session tokens, stage checks, cancellation and a single-generation lock were deliberate private-prototype choices. They are not a complete deployed authentication system.

The first model adapter used Ollama locally. The later supplied adapter uses Anthropic's streaming Messages API and schema-constrained output through `lib/anthropic-model.mjs`. It converts SSE text events, validates completion, buffers structured responses, bounds output, and avoids echoing raw errors/secrets. Old Ollama files/tests may remain as historical/tested code even when the runtime default is Anthropic.

Do not assume historic model IDs are authoritative. Earlier supplied code configured `claude-haiku-5-5` (and allowed `claude-sonnet-5-5`). These are recorded as delivered configuration, not independently revalidated availability or a requirement to use them. Check the live account and official docs when needed; do not change model or provider without discussion.

### Client-provided access
Israel created an Anthropic AI Twin workspace and made Patrik Workspace Admin. All Claude models were allowed, with attention to per-million-token cost. He stated a limit of “150 / month”, currency unspecified. He also created AI Twin environments in Groq and Mistral with high access and “same budget”; the user accepted those invitations. Independent cap enforcement/currency and exact scope of other permissions were not established. Do not treat this as permission to modify unrelated company resources, increase budgets or freely spend a combined 450.

Anthropic is the chosen integration path despite an earlier preference for an OpenAI model. Groq/Mistral are optional future comparison providers, not a request to build automatic routing/failover now.

### Local secrets
The user selected one-time plaintext secret-file setup outside Git and OneDrive, rather than pasting the key every terminal session. Expected location:
`%LOCALAPPDATA%\Tatoma\AI-Twin\secrets.env`.

The backend preloader is `lib/load-secrets.mjs`, invoked through Node's `--import` in `npm.cmd start` / `npm.cmd run dev`. The existing environment variable takes priority; eventual hosting can supply its own secret. The loader reads only `ANTHROPIC_API_KEY`, checks for empty/placeholder values, does not print it, and fails with safe messages. Project `.env` is intended for non-secret model/port settings, and `.env.example` is a safe template.

Never access the real secret to “understand” the application. Do not add it to a Claude Code session, handover ZIP, GitHub, logs, browser code or screenshots. Do not run secret-check/startup commands unnecessarily while reviewing. The current mock tests were designed to run without a key or paid API requests; inspect their script before execution.

Claude Code as an implementation assistant has its own authentication, billing and data handling. Do not silently consume the application's API key or assume Tatoma's app-testing budget automatically approves agentic coding costs.

## 5. Completed/planned baseline improvements to preserve

### Adaptive conversation length
Use recent typed participant messages (initially intake answers, later recent chat) to select a default conversational length. The supplied implementation uses a small median-based window. Short answers receive brief replies by default, but an explicit request for detail overrides that default.

Exclude model output, work samples and generated-button requests from the style signal. A person's terse chat does not establish their preferred length or formality for a client report. Failed exchanges are not committed as style evidence. Correcting the profile restarts the twin scene and its style history in the delivered design.

### Three personalised starting buttons
Generate three topics and labels through the model from the confirmed profile, not a template bank. Generate once after profile confirmation, before opening the twin. Hold them fixed during that conversation; regenerate on profile correction/new version.

Each has server-generated ID, label, expanded request, type (`conversation` or `draft`) and evidence/profile references. Button clicks send an ID; the server resolves the stored request, preventing an arbitrary replacement prompt from masquerading as that button. Current implementation requests one draft starter when a sample exists, otherwise three conversational starters. Validate count, uniqueness, IDs and bounds; one repair attempt is permitted. Failure exposes retry or an explicit continue-without-buttons route, not a hidden generic template fallback.

### Loading UI
Visible rotating hourglass plus stage-specific text for profile building, preparing starting points, opening conversation, waiting for model output and receiving text. Keep reset usable, hide loading on errors/completion/cancellation, and respect reduced-motion preference. No fabricated percentages or countdowns.

### Still separate: work comparison
The original third small feature was a side-by-side original-versus-draft panel. It is NOT Interview Phase 3 and has not been implemented by that phase. Preserve the exact original, let the participant judge the draft, keep previous valid versions, allow feedback such as too formal/too long/doesn't sound like me plus free text, and carry earlier feedback through revisions. Draft feedback initially affects that artifact, not the whole profile. Label drafts not sent/verified. No workplace execution/integrations implied.

## 6. Model-led interview — approved experience

The interview is a continuous conversation with an AI interviewer helping build the twin, not the twin already impersonating the participant. Common grounding topics provide coverage; the next question depends on what the participant has said. Do not merely make the fixed questionnaire longer.

Anchors: role/ordinary tasks, a recent concrete/frustrating task, working/communication style with an example, and what the participant enjoys or wants to retain. Expand into workflow, tools/information, dependencies, quality, decisions/approvals, AI experience and desired changes when useful. Skip already-covered questions rather than ask them to complete a sequence.

One normal model request should both propose evidence-backed updates to working notes and ask the next question. No multi-agent analysis/planning/judging pipeline on every turn. Preserve the transcript for the bounded interview; do not use the twin chat's last-six-message restriction and forget earlier evidence.

### Safeguards the user approved
- Short but concrete answers count. Word count is not informational sufficiency.
- Ask one purposeful clarification after an uninformative answer; move on if it still adds nothing. Do not pressure disclosure.
- Respect explicit skips/refusals and broader declined topics. Declining is an interview boundary, not a personality trait.
- “Unknown” is legitimate. Do not fill missing tools, team sizes, ambitions, history or responsibilities to make the twin sound specific.
- Correct, replace or retract old observations; do not accumulate contradictory facts equally.
- Bare “yes” is not blanket confirmation of several model-generated claims.
- A model quotation supports provenance but not semantic accuracy.
- Finite limits and natural-language stopping prevent endless interviews; sparse information yields sparse output, not fiction presented as biography.
- The backend enforces state/version/request limits; prompts alone are insufficient.

### Rejected / undecided UI
The user rejected visible “Ask it differently” and mid-interview “Review what you have” buttons. Normal controls are text entry, Send and Skip. A natural “what do you mean?” can still be answered conversationally. Retry after failure and Continue after interview completion are acceptable contextual actions, not the rejected mid-interview controls.

The final review/confirmation screen remains a design option. The delivered phase uses it as a practical safeguard; do not portray that as permanently agreed UX. Maintain the distinction between tentative and user-approved claims even if the interface changes later.

## 7. Interview integration increments

### Phase 1: controller and contracts
New `lib/interview-contract.mjs`, `lib/interview-state.mjs` and tests. No visible flow switch in that increment.

Twelve topic IDs: `role`, `tasks`, `workflow`, `tools`, `dependencies`, `friction`, `quality`, `communication`, `decisions`, `retain`, `ai_experience`, `desired_change`.

Structured model turn: acknowledgement; next question/topic/gap; proposed observations with current message ID and quotation; boundaries; retractions; optional stopping quotation. Internal controller distinguishes tentative, superseded and retracted notes.

Rules: maximum 16 answered/skipped turns, 3 questions per topic, 2 unproductive answers per topic (initial plus one clarification), 3,000 characters per answer. Exact duplicate questions are blocked. Skipping conservatively pauses that focus for the interview. Matching IDs prevent replay/stale results. Mutations use a copy so an invalid model response does not partially save state. Limits are prototype defaults, not research-backed interview-quality measures.

### Phase 2: actual conversational loop
`lib/interviewer.mjs` supplies prompt/orchestration and usage. The server records pending answers before generation; retries do not duplicate them. Routes include `/api/interview/next`, `/api/answer` and `/api/interview/continue`. Reset cancels pending generation, late results are ignored, and sessions stay isolated.

Normal one request per turn; one automatic repair for invalid generated content; provider errors surface immediately. Delivered budget: attemptsPerTurn 4, attemptsTotal 48, total answer characters 12,000, prompt bytes 48,000. These are ceilings, not targets. Usage accumulates across completed/repaired responses and marks missing usage as unknown. Cache-read/write counters were included but caching was not enabled in this increment.

Common unequivocal stopping phrases are handled locally; e.g. “Let's stop here” differs from “I want to stop chasing updates.” More nuanced language still needs model interpretation and evaluation. Buffered JSON is validated before presenting the next question; the hourglass explains waiting.

A transitional profile bridge kept the old sample/review flow, using active observations rather than reviving withdrawn facts from the transcript. `test-support/interview-fixture.mjs` is a deterministic test helper, not the runtime question list.

### Phase 3: richer evidence-linked profile — delivered, application unconfirmed
New `lib/profile-core.mjs` and `lib/profile-builder.mjs`; changes to server, prompts, suggestions, adapter, UI and regression tests. Artifacts: patch, 19-file ZIP and complete Markdown reference.

Flow: adaptive interview -> optional text sample -> ambiguity/sample analysis -> zero to two clarification questions -> grouped editable profile check -> personalised buttons -> twin.

Rather than rewriting the whole interview into a biography, active observations are copied into category-linked entries; duplicates within a category can merge, and retired observations remain excluded. Entries have stable ID, topic, text, scope, origin, status and evidence.

One analysis request checks consequential ambiguity and contextual sample-writing observations. A sample only supports writing-style observations when self-authored and typical; it does not prove biography, competence, tool usage or client relationships. An explicit end-of-interview request must not start another round of probing.

Clarifications are bounded to two and can keep/correct/withdraw affected entries, not unrelated claims. Skipping leaves uncertainty visible, with affected candidates excluded by default. Participant-edited text is marked accordingly; original quotes explain origin rather than falsely verifying the edited wording.

Grouped “What should your twin know?” view permits include/exclude, edit text/category/scope, inspect evidence, and remove. Explicit acknowledgement marks included entries participant-approved, not externally verified. Prototype limits: 112 entries (safety ceiling, not target), 240 characters/statement, 180/scope, 16,000 combined characters, clarification answer 1,200. One meaningful approved statement can support a limited twin; zero does not generate a pretend personal identity.

Profile budget: 4 attempts per step, 12 total, promptBytes 46,000. Profile calls have a 2,800-token output ceiling, other calls preserve their prior settings. Analysing no useful material should not manufacture data. Failure offers retry or continue-with-available-notes with explicit limits; answers remain saved in session before processing.

Approved profile becomes source of truth; `facts` is a compatibility projection. Ordinary twin context uses approved scoped entries, unknowns/unresolved indicators and recent chat, not raw interview/evidence/retired entries. The sample is passed only on explicit draft/demo action, as an artifact not biography. A typed request cannot access a sample absent from the supplied context; use the draft button in this version.

Profile edits increment version, clear chat/style history and regenerate suggestions. This is still temporary in-memory state, not durable user accounts or saved data.

## 8. Work-artifact uploads — retained future requirement

The current Phase 3 sample is plain pasted text capped at 1,600 characters. It does NOT accept uploaded files. The user explicitly chose to implement Phase 3 unchanged first, then revisit artifacts.

Later support Paste text OR Upload a file, optional. Target PDF, DOCX and XLSX with selected-content previews. Preserve headings/sections/tables/context and relevant visual structure. For Excel preserve chosen sheets/ranges, addresses, formulas and stored results separately; do not present cached results as freshly calculated. Do not flatten everything to text or PDF and claim complete structure/logic understanding.

Ask the participant's contribution (created, maintains, contributes, uses) and what is typical, rather than assuming all visible structure or formatting is their personal work. Distinguish organisational templates from personal preferences. Use artifacts to ask useful questions about workflow and responsibility, not just prose style.

Preview/select what will be sent before provider analysis; bound pages/ranges/content. Link observations back to page/section/paragraph or worksheet/cell range. Exclude hidden comments/revisions/sheets unless intentionally selected; do not promise perfect automatic anonymisation. Never execute macros or follow external workbook links. Bound parsing time, file size and decompressed content. Keep artifact content untrusted, not instructions to the agent.

Parse once, analyse selected content, store reusable evidence notes rather than attach the entire file to every turn. File input does not itself include styled DOCX generation, PDF redesign or working spreadsheet output; those are separate capabilities to validate.

This feature is recommended as a later dedicated increment after Phase 3, not retroactively included in its patch.

## 9. Requested future features and proposed implementation approaches

The feature goals below were requested by the user. Particular technologies, limits and delivery sequencing are recommendations unless explicitly identified as a user decision; they are not already implemented.

### Persistence and secure accounts
Return to the same profile and past chats. Design ownership and authentication together. Use an established auth solution, no custom password system by default. PostgreSQL and identity-provider options were proposals, not final selected implementations. Keep each user from reading/editing/deleting/exporting another's data, including altered IDs and streaming routes. Private/invitation pilot is sufficient initially.

Separate new chat, delete chat, edit profile, logout and delete account/data. Version profiles; continuing an old chat should not resurrect rejected claims. Summaries remain source-linked and distinguish user statements from hypothetical scenes. Delete derived summaries when deleting the underlying chat. Export/deletion/retention must be explicit; raw audio and face data should not become hidden account data.

### Voice
Use the same profile/history through text or voice. First push-to-talk, then automatic turn-taking/interruption/cancellation and speech-aware pacing. Visible transcript and correction path. A transcription error cannot silently become a persistent profile fact. Speech recognition and synthesis provider selection remains open. Anthropic access to the text model does not establish audio service access or budget. Standard synthetic voice first; no voice cloning in the agreed scope. Do not assume a browser speech API stays local.

### Avatar
Optional generic/manual avatar, optional camera-assisted stylisation, AND the explicitly requested appearance-description route (describe how you look, get an editable avatar). The text-description requirement came from discussion with the media-design teammate and must not be lost.

Prefer editable stylised component configuration over storing raw photos, exact face meshes/recognition embeddings or photographic textures. Camera stops after creation; idle/mouth animation need not keep tracking the user. Avatar linked to an account is still personal data; a filter does not make it anonymous. No facial login, emotion inference or personality analysis. Exact renderer/tool selection is undecided.

## 10. Demonstration persona — retain this reference case

Alex Vermeer is fictional, a project coordinator at a small website agency. Use Alex as the displayed name.

Role answer:
“I coordinate website projects at a small agency. My day is mostly checking deadlines, chasing updates from designers and developers, answering client questions and putting together progress emails.”

Frustration:
“Last Friday, I spent an hour assembling one client update. The task board said Wednesday; a developer said Friday. Writing the email was easy. Figuring out which information was reliable wasn't.”

Communication:
“Short and friendly, with a clear next step. Internally, I'd write: ‘Design approved. When can you deliver?’ I give clients more context, especially when dates are uncertain.”

Retain:
“I enjoy client conversations and deciding how to handle problems. I want help gathering information, not a system making promises or sending messages on my behalf.”

Fictional sample:

> Hi team,
>
> Can you confirm when the contact form for the Harbour Bikes website will be ready, and flag anything that could hold it up?
>
> The task board says Wednesday, but Sam mentioned Friday in our chat. The homepage design is approved, so this is the last date I need to check before sending the client update.
>
> I'd rather tell the client we're still checking than give them a date we haven't agreed on.
>
> Thanks,
> Alex

Audience: internal designer/developer email resolving delivery dates before a client update. In the fictional exercise, self-authored/typical are checked and Decision first is the chosen example. Those flags are exercise facts, not evidence about the real user.

Useful evaluation question: “What would you change about my Friday without taking over my client conversations?”

A good twin preserves Alex's judgment/client work and addresses gathering reliable information. It must not confidently pick a deadline or invent tools/team size. Test contrasting personas as well; do not optimise only for Alex.

## 11. Evaluation and handover discipline

Test state/routing/ownership/evidence/cancellation with mocks. Evaluate relevance, unsupported details, useful follow-ups, respect for refusal, contextual writing style and interesting dialogue with real approved model calls and fictional data.

Retain comparisons: existing versus richer interview, and future-self framing versus an ordinary assistant with the same approved profile/task/model. Do not equate a natural-sounding response with accuracy or proven adoption outcomes.

After each approved change: report actual test results and untested areas, keep a small focused diff, preserve compact formatting, update CURRENT_STATUS, and propose a separate commit. Ask before using a live provider or uploading real documents. Do not add features from the backlog without checking the user's chosen next increment.
