// ============================================================
// api/promptManager.js
//
// Prompt Manager (spec Part 4 §6): prompts live here as named
// templates — not hardcoded inline wherever AI gets called.
//
// TEMPLATES is the registry of available outreach email styles.
// Adding a new one (e.g. "Beta Invitation") means adding one entry
// here — nothing in aiManager.js, generate-email.js, or the
// frontend needs to change to support it, since the endpoint
// already accepts a `templateKey` and looks it up here.
//
// The default "validationCall" template encodes specific, tested
// guidance (not just "write an outreach email") because vague
// instructions produce generic-sounding output. Every rule below
// exists because it fixes a specific failure mode observed in an
// earlier draft — see inline comments.
// ============================================================

const SHARED_RULES = `
- Keep the email body under 140 words.
- Use exactly ONE specific detail from the lead's personalization notes or role/city — do not stack multiple personalization points, and do not use generic flattery.
- Do not explain that you're "not selling anything" or otherwise pre-defend the email — it reads as defensive and people already assume you might be selling something. Just be direct and genuine instead.
- Never use buzzwords, hype, exclamation points, or phrases like "I'd love to pick your brain."
- Write like one professional emailing another professional, not like a marketing email or a newsletter.
- Do NOT include any sign-off, closing line, name, or signature at the end (no "Best,", no name, nothing after the last sentence of the message). The application appends the sender's real signature automatically after your response — if you include your own, it will appear twice.
`.trim();

const TEMPLATES = {

  // Default first-touch outreach. Objective: get a "yes" to a short
  // call, not a written essay reply — the ask must be a single,
  // low-friction decision (yes/no), never an open-ended question
  // that requires the recipient to think and compose a real answer.
  validationCall: (lead, ctx) => `
You are writing a cold outreach email on behalf of ${ctx.founderName || 'a solo founder'}, who is building ${ctx.productDescription || 'a lead management platform for independent real estate agents'}.

YOUR OBJECTIVE IS NOT TO SOUND PROFESSIONAL OR INSIGHTFUL. Your objective is to maximize the chance that a busy, independent real estate professional agrees to a short call. Everything below serves that one goal.

Lead information:
- Name: ${lead.name || 'Unknown'}
- Company: ${lead.company || 'Unknown'}
- Role: ${lead.role || 'Unknown'}
- City: ${lead.city || 'Unknown'}
- Personalization notes: ${lead.personalization || 'None provided'}

Structure to follow:
1. One sentence referencing the specific personalization detail (what makes this email clearly not a mass blast).
2. One sentence stating you're building a lead management tool for independent agents and are learning directly from agents before building further.
3. The ask: request a short call (10 minutes) sometime this week to hear how they currently manage leads and what's frustrating about it. This must be phrased as something answerable with yes or no — NOT as an open question requiring a written answer.
4. One short closing line making clear there's no sales pitch.

${SHARED_RULES}

Respond in exactly this format, nothing else:
SUBJECT: <subject line, under 6 words, should feel personal — like "Could I learn from your experience?" or "Quick question" — never like a newsletter or marketing subject>
BODY:
<email body>`.trim(),

  // Follow-up to an unanswered first email. Objective: reference the
  // prior email naturally, lower the bar for replying even further
  // than the first email did, without sounding like a guilt trip.
  followUp: (lead, ctx, extra) => `
You are writing a brief follow-up email on behalf of ${ctx.founderName || 'a solo founder'}. It has been ${extra.daysSinceSent || 3} days since the original email below was sent, with no reply.

Original email that was sent:
"""
${extra.previousEmailBody}
"""

Recipient: ${lead.name || 'Unknown'} at ${lead.company || 'Unknown'}

Write a short follow-up (under 50 words). Rules:
- Reference the original email in one short clause — do not repeat its content or re-explain the ask.
- Assume they're busy, not uninterested. Do not apologize for following up.
- Repeat the same low-friction yes/no ask as the original (a short call), phrased even more simply than before.
${SHARED_RULES}

Respond in exactly this format, nothing else:
SUBJECT: <subject line, under 6 words>
BODY:
<email body>`.trim(),

  // Invite an already-validated, warm contact to try the beta.
  // Objective: different from cold outreach — this lead has already
  // engaged, so the ask can be slightly more direct.
  betaInvitation: (lead, ctx) => `
You are writing an email inviting ${lead.name || 'this contact'} to try an early beta of ${ctx.productDescription || 'a lead management platform for independent real estate agents'}, on behalf of ${ctx.founderName || 'a solo founder'}.

This person has already had a prior conversation and expressed interest — this is NOT cold outreach. You can be warmer and more direct than a first-touch email.

Lead notes: ${lead.notes || 'None provided'}
Validation notes: ${lead.personalization || 'None provided'}

Write a short email (under 120 words) that:
- Thanks them briefly for the earlier conversation, referencing one specific thing they mentioned if available.
- Invites them to be one of the first to try the product.
- Makes clear there's no cost and their feedback directly shapes what gets built.
- Ends with one clear next step (e.g. reply "yes" and you'll send access).

${SHARED_RULES}

Respond in exactly this format, nothing else:
SUBJECT: <subject line, under 6 words>
BODY:
<email body>`.trim(),

};

/**
 * Builds the prompt for a given template. `templateKey` selects
 * which style to use (defaults to 'validationCall', the standard
 * first-touch outreach). `extra` carries template-specific data
 * (e.g. previousEmailBody + daysSinceSent for 'followUp').
 */
export function buildEmailPrompt(templateKey, lead, workspaceContext = {}, extra = {}) {
  const template = TEMPLATES[templateKey] || TEMPLATES.validationCall;
  return template(lead, workspaceContext, extra);
}

/**
 * Returns the list of available template keys, so the frontend can
 * offer a picker (spec's "Validation Call, Beta Invitation,
 * Follow-up, Customer Interview, Feature Feedback" idea) without
 * hardcoding the list in two places.
 */
export function getAvailableTemplates() {
  return Object.keys(TEMPLATES);
}

/**
 * Reply Summarizer (unchanged from before — analysis, not outreach
 * generation, so it isn't part of the TEMPLATES registry above).
 */
export function buildReplySummaryPrompt(replyBody) {
  return `Analyze this email reply and extract structured information. Reply text:
"""
${replyBody}
"""

Respond ONLY with valid JSON (no markdown fences, no preamble) in exactly this shape:
{
  "summary": "<1-2 sentence plain-language summary>",
  "sentiment": "<Positive | Neutral | Negative | Highly Interested>",
  "painPoints": ["<short phrase>", "..."],
  "featureRequests": ["<short phrase>", "..."],
  "competitorsMentioned": ["<name>", "..."],
  "objections": ["<short phrase>", "..."],
  "betaInterest": "<Yes | No | Unclear>",
  "suggestedNextAction": "<one short actionable next step>"
}

If a field has no relevant content, use an empty array (for lists) or "Unclear" (for betaInterest). Do not invent information not present in the reply.`;
}
