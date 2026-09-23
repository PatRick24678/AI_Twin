# Tatoma Future Self — local prototype

An English, text-first research demonstrator. It uses one downloaded Ollama model, not a separate trained model per participant.

## Run

Install a supported Node.js LTS release (22.12 or newer) and Ollama. Download the model named in .env.example. Disable Ollama cloud features and keep Ollama bound to loopback. Copy .env.example to .env, then run npm start from this folder. Open the address printed by the server. No npm install step is needed: there are no npm dependencies.

For an older laptop, try qwen3:1.7b-q4_K_M and set OLLAMA_THINK=false in .env. The default instruct model needs OLLAMA_THINK=omit. Download whichever model you select before running the experience.

## Included flow

Four scripted intake questions; optional user work sample; optional preference among fictional writing examples; source-linked AI observations; editable confirmation; a streamed future-self conversation; small draft demonstrations; explicit profile correction with scene reset; reflection and optional local export.

The example bank is fictional. It is not a validated personality assessment or a set of real employee records. Quote matching verifies provenance, not whether the model's interpretation is correct. Users must review it.

## Testing

Run npm test. The six automated tests use an explicitly named fake model and a simulated Ollama HTTP stream. They test application behavior, not model intelligence. Syntax checks and those tests passed on Node.js 22.16.0. A Chromium UI walk-through was also exercised using test-only local HTTP bridging because direct browser navigation was restricted in the authoring environment. Real Ollama inference, laptop speed, and actual model output quality were NOT tested in that environment. Benchmark and evaluate them on the demonstration computer.

## Limits and data handling

This is a local, single-generation-at-a-time demonstration, not a public service. Do not expose either server to the internet. Session tokens are kept in browser memory. Server sessions are held in RAM, with inactivity expiry after about 30 minutes and cleanup checked each minute. Reset drops the session; it is not a certified memory wipe of the model runtime or operating system. Refreshing the browser loses its token; the abandoned server session expires. Stop the Node server to clear all application sessions.

There is no database, cloud inference, participant training, analytics service, account integration, voice cloning or action execution. Inputs go only to the configured loopback Ollama service. Model downloads and software installation need internet access. Exported notes deliberately contain participant text; collect consent before sharing them. Keep confidential information out of the prototype.

The twin retains the confirmed profile and recent exchanges within a conservative context budget. Editing the profile starts a fresh scene so old mistaken claims are not kept in conversation history. The future scene is fictional, not a career forecast. The colors and layout are a prototype, not Tatoma-approved branding.
