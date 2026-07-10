# Growth Hub — AI Manager API

Serverless functions that generate outreach emails, follow-ups, and
reply analysis using Gemini (primary) with OpenRouter as fallback.
Keeps every API key server-side, same pattern as the email
verification project.

## Where to put your real API keys

Same rule as the verification project: **no `.js` file ever contains
a real key.** Every provider file reads from `process.env`.

### Step-by-step:
1. Push this folder to a **new** GitHub repo (separate from
   `growth-hub-verify-api` — this is its own project).
2. On GitHub mobile: use **Add file → Create new file**, type the
   full path (e.g. `api/providers/gemini.js`) into the filename box
   to auto-create folders, same as last time.
3. Go to vercel.com → **New Project** → import this new repo.
4. Go to **Project → Settings → Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `GEMINI_API_KEY_1` | (your first Gemini key from aistudio.google.com/apikey) |
   | `GEMINI_API_KEY_2` | (your second Gemini key) |
   | `OPENROUTER_API_KEY_1` | (your first OpenRouter key) |
   | `OPENROUTER_API_KEY_2` | (your second OpenRouter key) |

   You can add up to `OPENROUTER_API_KEY_5` if you have more keys —
   `openrouter.js` checks for all 5 automatically and skips any that
   aren't set. Same for a future 3rd Gemini key if you ever get one —
   just add it to the `KEYS` array in `providers/gemini.js`.

5. Also check: **Settings → Deployment Protection → Disabled** (same
   issue as last time — this defaults to "on" for new projects).
6. Redeploy after adding the env vars (Deployments tab → ⋯ → Redeploy).

## Files in this project

- `api/generate-email.js` — endpoint for outreach + follow-up email generation
- `api/analyze-reply.js` — endpoint for reply analysis (summary, sentiment, extracted knowledge)
- `api/aiManager.js` — **the only file with provider fallback order.** Edit this to add a 3rd provider.
- `api/promptManager.js` — all prompt templates live here, not scattered in code
- `api/providers/gemini.js` — Gemini adapter, tries both keys internally
- `api/providers/openrouter.js` — OpenRouter adapter, tries up to 5 keys internally

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

## Important: this endpoint only generates/analyzes — it never sends

Per the spec's own principle (Part 4 §2): AI assists, it never acts
without explicit approval. This project has no ability to send email
at all — that's a separate, later piece (Gmail integration) that will
always show you the generated email for approval first.
