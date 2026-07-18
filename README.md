# Growth Hub — AI Manager + Gmail Integration API

Serverless functions for two things, in one Vercel project:
- **AI generation**: outreach emails, follow-ups, and reply analysis
  using Gemini (primary) with OpenRouter as fallback.
- **Gmail integration**: OAuth connect, sending, and reply detection.

Both live here together (not two separate projects) — keeps every
API key and OAuth secret server-side, same pattern as the email
verification project.

## Where to put your real API keys

Same rule as the verification project: **no `.js` file ever contains
a real key.** Every provider file reads from `process.env`.

### Step-by-step:
1. Push this folder to a GitHub repo.
2. Go to vercel.com → **New Project** → import this repo.
3. Go to **Project → Settings → Environment Variables** and add:

   **AI generation:**

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY_1` | (your first Gemini key from aistudio.google.com/apikey) |
   | `GEMINI_API_KEY_2` | (your second Gemini key) |
   | `OPENROUTER_API_KEY_1` | (your first OpenRouter key) |
   | `OPENROUTER_API_KEY_2` | (your second OpenRouter key) |

   You can add up to `OPENROUTER_API_KEY_5` if you have more keys —
   `openrouter.js` checks for all 5 automatically and skips any that
   aren't set. Same for a future 3rd Gemini key — just add it to the
   `KEYS` array in `providers/gemini.js`.

   **Gmail integration:**

   | Name | Value |
   |---|---|
   | `GMAIL_CLIENT_ID` | (from Google Cloud Console → OAuth credentials) |
   | `GMAIL_CLIENT_SECRET` | (same place) |
   | `GMAIL_REDIRECT_URI` | (must exactly match what's registered in Google Cloud Console) |
   | `FIREBASE_SERVICE_ACCOUNT_KEY` | (full JSON key, as one line, from Firebase project settings → Service Accounts) |
   | `APP_URL` | (your deployed frontend's URL — gmail-callback.js redirects here after connecting) |

4. Also check: **Settings → Deployment Protection → Disabled** (this
   defaults to "on" for new projects and will block the frontend
   from reaching these endpoints if left on).
5. Redeploy after adding the env vars (Deployments tab → ⋯ → Redeploy).

## Files in this project

AI generation:
- `api/generate-email.js` — endpoint for outreach + follow-up email generation
- `api/analyze-reply.js` — endpoint for reply analysis (summary, sentiment, extracted knowledge). Built and working standalone, but not yet called from anywhere in the frontend — nothing currently saves its output into a Knowledge Base.
- `api/aiManager.js` — **the only file with provider fallback order.** Edit this to add a 3rd provider.
- `api/promptManager.js` — all prompt templates live here, not scattered in code
- `api/providers/gemini.js` — Gemini adapter, tries both keys internally
- `api/providers/openrouter.js` — OpenRouter adapter, tries up to 5 keys internally

Gmail integration:
- `api/gmail-callback.js` — OAuth callback, exchanges auth code for a refresh token, stores it on the workspace
- `api/send-email.js` — sends via the connected Gmail account, writes status/followUpDate/sentFromEmail etc. back to the lead
- `api/check-reply.js` — checks a Gmail thread for any incoming (non-sent) message

## Testing once deployed

Outreach email:
```bash
curl -X POST https://YOUR-PROJECT-NAME.vercel.app/api/generate-email \
  -H "Content-Type: application/json" \
  -d '{
    "type": "outreach",
    "lead": {
      "name": "Jane Doe",
      "company": "XYZ Realty",
      "role": "Broker",
      "city": "Austin",
      "personalization": "Specializes in first-time buyers, 10 years experience"
    }
  }'
```

Reply analysis:
```bash
curl -X POST https://YOUR-PROJECT-NAME.vercel.app/api/analyze-reply \
  -H "Content-Type: application/json" \
  -d '{"replyBody": "We currently use Follow Up Boss but it is expensive. Would love Google Calendar sync. Happy to test a beta."}'
```

## Important: generation and sending are separate steps

Per the spec's own principle: AI assists, it never acts without
explicit approval. `generate-email.js` only generates text — it has
no ability to send anything. The frontend always shows the generated
email for review before `send-email.js` (this same project) is ever
called to actually send it.
