# Decisions and reconstructed development history

## How to use this record

This is reconstructed from messages available to the outgoing assistant and supplied artifacts. It is not an export, timestamped transcript, audit log of every event, or proof of current implementation. The original chat could not be extracted; the user has approved moving forward without it.

The short quotations below reproduce user instructions visible in that context. The explanations and chronology are summaries. Exact dates are deliberately omitted where the conversation does not establish them reliably. Read the actual code and commit history to verify installed behaviour.

## Decisions that matter most

| Decision | Provenance/status | Consequence for future implementation |
| --- | --- | --- |
| Broad office/desk-worker audience | User: “no I don't want to narrow it down so soon let's just say its for office/desk workers” | Do not quietly restrict the product to project coordinators just because Alex is the demo persona. |
| Interesting and alive before full productivity | User: “focus on making it seem interesting and 'alive' and after we can REALLY delve into how to make it useful” | Personal recognition and interaction matter; do not turn this into an autonomous employee or generic business assistant. |
| Both future-self dialogue and small work demonstrations | User explicitly wanted both, with early emphasis on engaging aspects | Preserve scope for drafting; claiming to perform real external work is not authorised. |
| Use conversation together with an optional anonymised example | User liked comparing what someone says with an example | Treat samples as evidence in context, not a substitute for asking what the person actually did. |
| Adaptive reply length | User singled out short user responses leading to shorter twin replies | Explicit requests for detail override defaults; length is not a quality score or workplace-writing preference. |
| Personal starting buttons must be generated | User rejected a preselected template bank and wanted three generated buttons before chat opens | Generate from the confirmed profile once; do not regenerate after every ordinary reply. |
| Side-by-side work comparison | User: “I really like this” about original versus draft | Retained future feature; it has NOT been implemented merely by completing Interview Phase 3. |
| Separate increments/commits | User requested code “one by one so that I can commit all the changes one by one” | One focused, testable change at a time, with clear file scope and test instructions. |
| Compact code style | User: “I actually prefer the compact versions you should keep those for the future” | Preserve compact conventions. Do not expand the entire repo cosmetically or reduce tests to shorten it. |
| Visible loading state | User reported profile/chat preparation looked frozen | Preserve hourglass/status messages, cancellation/recovery and reduced-motion behaviour. |
| Hosted API, private app during development | User wants private development and deployment only near internship end | Do not treat a hosted model as a requirement to publicly deploy the application now. |
| No long-term personal maintenance obligation | User explicitly limited responsibility after internship | Deliver a reliable demonstrator/handover, not a years-long operations programme; do not abandon security or client ownership. |
| Anthropic is the implementation path | Client created AI Twin workspace; user proceeded with credential setup and adapter work | Earlier OpenAI preference is historical, not a current instruction to switch providers. |
| Local secret-file setup | User selected automatic reading of an external private file | Do not revert to entering the key each terminal session or move it into the synced project. |
| Model-led interview | User asked for the entire interview to be a conversation with a model helping build the twin | Keep grounding topics but dynamically ask useful follow-ups; do not substitute a longer rigid questionnaire. |
| Cost-aware interviewing | User raised cost as a concern | Normally one request interprets the answer and generates the next question; bounded repairs, no multi-agent cascade per turn. |
| Respect brief/declined answers | User explicitly asked for safeguards and approved the proposals other than two rejected controls | Do not pressure disclosure or interpret brevity as low competence, low engagement or missing information by itself. |
| No “Ask it differently” button | User called the visible control unhelpful | A typed “what do you mean?” can still be answered; no extra visible rephrasing control. |
| No mid-interview “Review what you have” control | User said review belongs, if used, at the end | Use Send/Skip and natural stopping. A dedicated final review screen is not a settled final design. |
| Avatar by appearance description | User's media-design collaborator requested it as an alternative to face capture | Retain this option alongside optional camera/manual/generic approaches. |
| File uploads are deferred | User chose “I'll just implement the changes we did for phase 3” after discussing files | Keep Phase 3 text-only; PDF/DOCX/XLSX is a separate future increment. |
| Real branch name is Pat | User's terminal showed origin/Pat and successful switch to Pat | Use exact capitalisation; do not use earlier guessed Patrik. |
| Proceed without full chat export | Latest user instruction | No export prerequisite, repeated extraction instructions or promise of later transcript delivery. |

## Chronology: what changed and why

### 1. Project framing and research

The initial request sought a competitor/feasibility document grounded in the supplied project plan, starting with MIT Future You, Delphi and Generative Agents but not limited to them. A research report and a shorter concept-rationale document were delivered. They were meant to explain the twin as a way of conveying Tatoma's message about concrete changes to a professional's work, rather than proving an accurate digital replica of a person.

Those historical documents contain research/model/provider claims. They are retained as context, not newly verified facts. Use the supplied project plan for its original framing and the latest user decisions for subsequent scope changes.

### 2. Initial prototype and local inference

The user wanted an initial demonstrator for a weekly meeting without relying on an unapproved API budget. The delivered starter used a Node ES-module backend, plain browser HTML/CSS/JS and an Ollama adapter. There was no React build, database or login. The flow was a short fixed intake, optional pasted sample, editable profile, future-self chat, small generated example and reflection. The user received Windows setup and Git instructions.

Local inference was an early pragmatic choice, not a permanent requirement. Historical Ollama tests/files may remain even after Claude becomes the runtime default.

### 3. Original three experience improvements

The selected improvements were (1) adaptive conversational brevity, (2) three generated personalised starting buttons, and (3) a side-by-side original/draft demonstration with revision feedback. Code for the first two was delivered in separate increments. The third was deferred while foundational Version 2 work took priority. Do not confuse this third improvement with Interview Phase 3.

A test initially saw a 400-token ceiling instead of 768; the user confirmed the file was unsaved and the test passed after saving. Later failures around `/api/suggestions` were traced through actual response output: `profileversion: 0` did not initialise `profileVersion`, so incrementing the latter produced NaN and JSON null. The user corrected the capital V. The lesson is to inspect the saved code and safe response bodies before repeatedly guessing at edits.

### 4. Loading feedback and the demo persona

A stakeholder reported the UI looked paused while generating a profile or starting chat. A rotating hourglass/status-card increment was supplied, including reduced-motion handling and cleanup on failure/reset. It did not change the underlying model behaviour.

Alex Vermeer was created as a fictional demo persona: a website-project coordinator who dislikes reconciling/chasing information but enjoys writing and client conversations. The full answers and fictional Harbour Bikes email are in PROJECT_HANDOVER.md. Do not treat Alex's details as facts about the real developer or every participant.

### 5. Version 2 roadmap and client-funded access

The user requested a more complete interview/profile, saved profiles and chat, secure login, optional voice, and optional avatar creation without retaining a raw face photograph. Text-description avatar creation was added later. Authentication/database/speech/avatar tools were discussed as candidates, not all selected.

The user clarified that the app would remain private for most development, deploy near the internship end, and not carry a personal long-term maintenance promise. Provider comparisons and cost estimates were discussed; do not carry old prices into a new budget proposal without verification.

Israel created an Anthropic AI Twin workspace, gave the user Workspace Admin access, allowed all Claude models and stated a 150/month test limit. He subsequently added AI Twin environments in Groq and Mistral with “same budget.” Currency, independent enforcement and any coding-assistant billing arrangement were not established. This is not authorisation to increase spending limits or alter unrelated company resources.

### 6. Credentials and Anthropic integration

The user chose a persistent local secrets file outside the repository and OneDrive, rather than re-entering the key for every terminal. A Node preload module loads it at application startup. Do not access the key to perform an orientation. The startup secret check only checks configuration; it is not a live-provider test.

An Anthropic adapter and UI wording changes were delivered, preserving streaming, structured responses, errors, output limits and mock tests. Historical code used named model IDs that must be checked against current official availability when relevant. They are not a requirement to maintain obsolete or erroneous identifiers. No automatic switch to a higher-cost model was requested.

### 7. Interview redesign decisions

The user wanted contextual, invented follow-up questions within a consistent agenda, not the fixed intake. One call should update evidence-backed working notes and propose the next question. Short useful answers should be accepted; refusals and unresolved gaps should remain boundaries/unknowns.

The user rejected two proposed visible controls: “Ask it differently” and “Review what you have” during the interview. Final review/confirmation was left open. The ordinary UI therefore uses answer/send/skip, with contextual retry on failure and continuation after completion. Natural-language clarification and stopping remain supported.

### 8. Interview Phase 1 and Phase 2

Phase 1 delivered contract/state modules, source-linked tentative observations, correction/retraction state, topic boundaries, finite question limits and stale-request checks. It was a backend foundation without switching the visible flow.

Phase 2 connected the model-led interviewer, pending-answer retry logic, new endpoints, usage reporting and UI. It preserved an old sample/profile bridge so the prototype remained usable. Historical full-suite reports were 66 tests after Phase 1 and 87 after Phase 2, using mocked models. These are reports, not current test evidence.

The user showed a Phase 2 commit `4845725` on main. A push rejection was resolved by integrating remote changes. Later they moved to the branch actually named Pat. A Windows failure to delete `test-support` did not prevent the switch; Git reported Pat and a clean tree. The subsequent fast-forward/push was instructed, but exact current history still requires local inspection.

### 9. Interview Phase 3

Phase 3 was delivered as a patch, 19-file ZIP and complete changed-file reference. It adds grouped source-linked profile entries, limited work-sample clarification, scope/provenance, participant approval and a richer context passed to suggestions/the twin. The historical assistant reported 129 mock tests passing. No live-account evidence or current local test result follows in the supplied conversation.

The user asked about real files before applying it. It was explained that this Phase 3 sample is still a 1,600-character text box, not file upload. PDF/DOCX/XLSX with selected previews, structural evidence and no macro execution was proposed as a future dedicated increment. The user accepted deferral and said they would implement Phase 3 first. Installation remains unconfirmed, not necessarily absent.

### 10. Transfer to Claude

The user wants implementation to move to Claude with access to the whole codebase and project context. A handover was prepared that originally expected a separate chat export. The user cannot extract the conversation and has now explicitly asked to proceed with that limitation. This edition removes that dependency. No further export instructions are necessary.

The initial task is to reconcile this record with the actual local repo, especially Phase 3, then agree the next small increment. The absence of the transcript does not authorise a rewrite or automatic implementation of the whole roadmap.

## Decisions that are still open

- Whether the final end-of-interview UX retains the grouped review screen, uses a conversational recap or adopts another confirmation mechanism. The tentative/approved distinction must still be protected.
- Exact authentication library/provider, database hosting and durable session design.
- Exact transcription/TTS service, eventual hands-free behaviour, renderer and avatar-generation tools.
- Specific PDF/DOCX/XLSX parsers, visual rendering and selection limits; these are not part of the delivered text-sample patch.
- How long real participant data may be retained, who approves real-data processing, deployment ownership and final environment shutdown/handover.
- Current Claude model availability/configuration and actual live quality/performance. Verify when needed; do not retroactively treat old assistant claims as client requirements.
- Which feature to implement after auditing Phase 3. Artifact uploads were retained for a later increment; the audit is not blanket permission to begin them immediately.
