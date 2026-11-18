# Deploying Future Self (Google Cloud Run + Neon)

The hosted proof of concept runs the normal Node server in one container on **Google Cloud Run** (europe-west4,
Netherlands). Saved accounts live in **Neon Postgres** (AWS Frankfurt). Both have a free tier that covers a proof of
concept. Guests, live working copies and pasted work samples stay in the server's memory, as they do locally.

```
Browser ──HTTPS──> Cloud Run "future-self" (max 1 instance, sleeps when idle)
                    ├──> Neon Postgres: accounts, logins, encrypted twins, audit log
                    └──> Anthropic / OpenAI / Mistral (keys from Google Secret Manager)
Browser ──WSS────> Mistral realtime (live transcription, directly)
```

Commands are for PowerShell, one per block. Never paste a key into a command or a chat: keys go into the private
files below or into the Google Cloud console.

## What to expect
- **Cost:** $0 within the free tiers. Google Cloud still needs a billing account with a card. Decide first whose
  card that is (Tatoma's or yours) and set a budget alert (step 3).
- **Waking up:** after about 15 idle minutes the server sleeps. The next visit waits about 1–3 s while the server
  and the database wake.
- **Lost guest sessions:** a sleeping server forgets guest sessions and unsaved work samples. A deploy does the same.
  Accounts are saved after every step. A paid fix exists if this matters later: `--min-instances 1`.
- **Capacity:** one server, up to `AI_CONCURRENCY` AI requests at a time (4) and `MAX_SESSIONS` open sessions (20).

## 1. Neon (database)
1. Sign up at neon.com and create a project in **AWS Europe Central 1 (Frankfurt)**.
2. The default branch (`main` or `production`) is the production database. Also create a branch called `dev` for
   local testing.
3. Under **Connect**, copy the connection strings:
   - Production, **pooled** (its host contains `-pooler`): for the hosted app.
   - Dev, **direct** (not pooled): for the optional database test, as `TEST_DATABASE_URL`.

## 2. The production key file (on your computer)
This creates a NEW encryption key for the hosted database, separate from your local one. The value is never shown.
```powershell
npm.cmd run init:storage -- --production
```
Open `%LOCALAPPDATA%\Tatoma\AI-Twin\production.env` in Notepad and paste the production pooled connection string
after `DATABASE_URL=`. Save a copy of the whole file in a password manager: **without this key the saved twins
cannot be read.** The file is outside the repository and OneDrive. Never commit or share it.

## 3. Google Cloud project
1. Install the Google Cloud CLI from cloud.google.com/sdk, then sign in:
   ```powershell
   gcloud auth login
   ```
2. In the console (console.cloud.google.com):
   - Create a project, for example `future-self-poc`, and link a billing account.
   - Under **Billing → Budgets & alerts**, create a budget of €1 with email alerts.
   - A new Google account may start on a 90-day free trial. Check whether it has to be upgraded to keep the service
     running after the trial; usage within the free tier still costs nothing.
3. Point the CLI at the project and region:
   ```powershell
   gcloud config set project future-self-poc
   ```
   ```powershell
   gcloud config set run/region europe-west4
   ```
4. Switch on the services that are needed:
   ```powershell
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
   ```

## 4. Secrets (in the console, so values never touch the command line)
In **Security → Secret Manager → Create secret**, create six secrets with exactly these names. That's within the free
tier of 6 active versions; when you change a value, disable the old version.

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | The Claude key Tatoma supplied (the same one as in your local `secrets.env`, or a separate one for production) |
| `MISTRAL_API_KEY` | The Mistral key (voice) |
| `OPENAI_API_KEY` | The OpenAI key (faces) |
| `DATA_ENCRYPTION_KEY` | The value from `production.env`, NOT the local one |
| `DATABASE_URL` | The Neon production pooled connection string from `production.env` |
| `ACCESS_CODE` | A code you choose, for example three random words. Testers need it to start. |

Let Cloud Run read them. First get your project number:
```powershell
gcloud projects describe future-self-poc --format="value(projectNumber)"
```
Then give the default runtime account access, putting the number in place of `PROJECT_NUMBER`:
```powershell
gcloud projects add-iam-policy-binding future-self-poc --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

## 5. First deploy
Run this from the repository folder, on the branch you want to deploy. Copy the model settings from your local
`.env` if they differ from `.env.example`.
```powershell
gcloud run deploy future-self --source . --region europe-west4 --allow-unauthenticated --max-instances 1 --min-instances 0 --memory 512Mi --cpu 1 --timeout 600 --set-env-vars "FUTURE_SELF_SECURE_COOKIES=1,TRUST_PROXY=1,AI_CONCURRENCY=4,ANTHROPIC_MODEL=claude-haiku-5-5,ANTHROPIC_TIMEOUT_MS=120000,MISTRAL_STT_MODEL=voxtral-mini-latest,MISTRAL_REALTIME_MODEL=voxtral-mini-transcribe-realtime-2602,MISTRAL_LIVE=on,OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst,OPENAI_IMAGE_QUALITY=medium" --set-secrets "ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,MISTRAL_API_KEY=MISTRAL_API_KEY:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,DATA_ENCRYPTION_KEY=DATA_ENCRYPTION_KEY:latest,DATABASE_URL=DATABASE_URL:latest,ACCESS_CODE=ACCESS_CODE:latest"
```
When asked to create an Artifact Registry repository, answer yes. The build takes a few minutes.

The server refuses every request until it knows its own address: that is the next step.

## 6. Tell the server its public address
Show the service address:
```powershell
gcloud run services describe future-self --region europe-west4 --format="value(status.url)"
```
Set it as the only allowed origin, putting the address from the previous command (`https://…run.app`) in place of
`URL`:
```powershell
gcloud run services update future-self --region europe-west4 --update-env-vars "PUBLIC_ORIGINS=URL"
```
Open that address. The welcome screen should say "Claude model access verified" and show the access-code fields.

## 7. The first admin account
This creates an admin in the **production** database, using `production.env`. The Claude key comes from your local
`secrets.env` as usual. The password is typed without being shown.
```powershell
node --env-file="$env:LOCALAPPDATA\Tatoma\AI-Twin\production.env" --import=./lib/load-secrets.mjs scripts/create-admin.mjs
```
It prints `Database: Postgres at …neon.tech`. If it shows a local path instead, `DATABASE_URL` is missing from
`production.env`.

## 8. Spending limits at the providers
- Anthropic console: set a monthly limit within the $150/month allocation.
- OpenAI: set a project budget for the image key.
- Mistral: set a spending limit.
- Artifact Registry: in the console, open the `cloud-run-source-deploy` repository and add a cleanup policy that keeps
  the 2 most recent images. The free storage is 0.5 GB.

## Updating, rolling back and changing the code
Deploy again from the branch you want to publish (normally `main` after a reviewed merge). The settings and secrets
from step 5 are kept:
```powershell
gcloud run deploy future-self --source . --region europe-west4
```
List the revisions:
```powershell
gcloud run revisions list --service future-self --region europe-west4
```
Send all traffic back to an earlier revision, putting its name in place of `REVISION`:
```powershell
gcloud run services update-traffic future-self --region europe-west4 --to-revisions REVISION=100
```
To change the access code: in Secret Manager add a new version of `ACCESS_CODE` and disable the old one, then load it:
```powershell
gcloud run services update future-self --region europe-west4 --update-secrets "ACCESS_CODE=ACCESS_CODE:latest"
```
Logs are in the console under **Cloud Run → future-self → Logs**. They contain rule text and error messages only,
never answers or keys.

## Optional: test the database code against Neon `dev`
`npm.cmd test` never contacts a database. To also run the store tests against real Postgres, give the run the **dev,
direct** connection string. The tests use a temporary schema and remove it afterwards. Put the string in place of
`DEV_DIRECT_URL`, and don't share the terminal output if the URL appears in it.
```powershell
$env:TEST_DATABASE_URL = "DEV_DIRECT_URL"; node --test test/store-contract.test.mjs; Remove-Item Env:TEST_DATABASE_URL
```

## Hosted smoke test (fictional persona)
1. A missing or wrong access code is refused; the right one starts a guest session.
2. A full guest run: the interview (with one Skip), the sample, the profile, a streamed twin reply, and a problem
   session.
3. An account: sign up, answer 2 questions, close the tab, log in from another browser and resume, then export and
   delete.
4. Draw a face. It may take over a minute, and must finish.
5. Voice: the live transcription and the fallback both work.
6. Two browsers at the same time both get AI replies.
7. Leave it idle for 20 minutes, then reopen: note the wake-up time, and check the account is intact.
8. Check that the visitor address is right: five wrong access codes from your laptop block the laptop, but not a phone
   on mobile data. If they block everyone, change `TRUST_PROXY`.
9. In Neon's SQL editor, `SELECT email_enc, data_enc FROM users JOIN twins ON twins.user_id = users.id LIMIT 1;`
   shows only `v1.` ciphertext.

## Shutting it down (end of the internship)
1. Give participants time to export their data.
2. Delete the Cloud Run service:
   ```powershell
   gcloud run services delete future-self --region europe-west4
   ```
3. Delete the six secrets and the `cloud-run-source-deploy` repository in the console.
4. Delete the Neon project.
5. Delete `production.env` and its password-manager copy once nothing needs restoring.
