# Privacy and data handling: Tatoma Future Self (prototype)

This document is for Tatoma's privacy contact and future developers. It describes what the prototype stores, where,
and for how long. **It is not legal advice.** The lawful basis, the DPIA and the processor agreements still need
a decision by Tatoma.

## Where data lives
- **Database:** a local SQLite file at `%LOCALAPPDATA%\Tatoma\AI-Twin\data\future-self.db`. It can be moved with
  `FUTURE_SELF_DB`.
  - It is outside the repository, and the app refuses cloud-synced folders such as OneDrive.
- **Encryption:**
  - Personal content and email addresses are encrypted (AES-256-GCM) before they reach the database.
  - The key, `DATA_ENCRYPTION_KEY`, lives in the external `secrets.env`, so a copied database file alone is unreadable.
  - Losing the key means losing the saved twins. Keep a private backup of `secrets.env`.
- **Code boundary:** only `lib/store.mjs` knows about the database. A hosted EU database later replaces that one module.

## Data inventory
| Data | Sensitivity | Stored? | Retention | Protection |
|---|---|---|---|---|
| Email | Personal, identifying | Yes | Until the account is deleted | HMAC hash for lookup; the address is encrypted |
| Password | Credential | Hash only | Until the account is deleted | scrypt, per-user salt |
| Login sessions | Credential | Hash of the session ID | 12 h absolute, 30 min idle | HttpOnly, SameSite=Strict cookie |
| Interview transcript (raw answers) | **High**: may mention colleagues, health or employer issues | Only while unfinished | Deleted at profile confirmation, or after 30 days unfinished | Encrypted |
| Confirmed profile and short evidence quotes | Personal, participant-approved | Yes | While the account exists | Encrypted; editable; exportable |
| Top problems | Personal | Yes | While the account exists | Encrypted |
| Twin and problem conversations | Personal; drafts may name third parties | Yes | While the account exists | Encrypted |
| Pasted work sample | **High**: may be confidential company or client data | **No**, held in memory for one session | None | Never written to disk |
| Voice audio | Biometric-adjacent | **No** | None | Streamed or sent once for transcription only |
| Appearance description (for the face) | Personal; describes how the participant looks | Yes, with the picture | While the account exists, or until the face is removed | Encrypted |
| Face picture (AI-drawn cartoon) | Personal; may resemble the participant | Yes | While the account exists, or until the face is removed | Encrypted; exportable; removable |
| Reflection | Personal | Yes | While the account exists | Encrypted |
| Consent record | Accountability | Yes | While the account exists | Version and timestamp |
| Admin audit log | Accountability | Yes | 12 months | Who, what and when, never content |
| Server logs | Low | Console only | Not persisted | No content or credentials |

**Retention rules:**
- Participant accounts inactive for 6 months are deleted automatically, together with their sessions and twin.
- Admin accounts are not purged.
- Participants can export their data and delete their account at any time.

**Guest mode:** "try without saving" keeps everything in memory and writes nothing to the database.

## Roles
- **Participant:** sees only their own data.
- **Tatoma admin:** can list accounts (email, created date, last active, whether a twin exists), delete accounts and issue a one-time password-reset code.
  - **An admin cannot read profiles, interviews or conversations.**
  - Admin actions are recorded in the audit log.

## Outside processors
- **Anthropic** (Claude): interview, profile and twin generation. Processing happens in the US, under Anthropic's commercial terms and DPA. API data is not used for training. Consider zero data retention.
- **Mistral** (Voxtral): speech-to-text in voice mode, EU. Inputs may be kept for up to 30 days for abuse monitoring unless zero data retention is approved. Still to request.
- **OpenAI** (GPT Image): draws the optional face from the participant's description of how they look. Only that
  description and the fixed style board are sent, never the profile or conversation. Processing is in the US under
  OpenAI's API terms and DPA; API data is not used for training by default. OpenAI may keep API inputs and outputs for
  up to 30 days for abuse monitoring unless zero data retention is approved. Still to request.
- **Anthropic** also receives the drawn picture once, to locate the eyes and mouth for the animation.
- The browser's own speech service may receive the text when an online read-aloud voice is chosen. The app says so next to the voice picker.

## Open before real participants
- Choose a lawful basis (consent, or legitimate interest) and record it.
- Run a DPIA: this is AI-supported profiling of people's work.
- Check the DPAs with Anthropic, Mistral and OpenAI, and request ZDR.
- Decide whether a face that may resemble the participant needs its own consent line; the app currently shows a
  notice next to the description field.
- Add a privacy notice page.
- Never give employers access to individual profiles without the participant's explicit, freely given consent.
- Hosted version: EU hosting, HTTPS, backups that follow deletions, and an email service for verification and password reset.
