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
// Revision history worth knowing about (each fixed a real,
// observed problem — not theoretical):
//   - Removed "avoid the not-selling-anything disclaimer" rule:
//     a real manually-written, higher-performing example proved
//     that line works fine when phrased naturally.
//   - Removed "match this style closely" instruction: risks every
//     generated email converging on one template, which reads as
//     templated if two agents ever compare notes. Reference
//     examples are now framed as tone/structure guides only —
//     the model is explicitly told not to copy wording.
//   - Added an explicit anti-AI-phrase list and success criteria,
//     since large language models respond measurably better to
//     concrete "avoid this / hit this bar" instructions than to
//     abstract tone descriptions alone.
// ============================================================

const SHARED_RULES = `
Success criteria — a successful email:
- Feels personal, not mass-sent.
- Can be read in under 30 seconds.
- Gives the recipient exactly ONE simple decision to make.
- Sounds like it was written by a founder in under five minutes, not a copywriter.
- Makes the recipient comfortable replying, with zero pressure.

Never use these phrases or anything equivalent to them — they are the clearest signals of AI-generated or templated writing:
- "I hope this message finds you well"
- "I wanted to reach out"
- "I would love to"
- "I hope you're doing well"
- "I thought I'd connect"
- "I'd like to introduce myself"
- "Revolutionary" / "Game-changing" / "Streamline your workflow"
- Any phrase that sounds like a LinkedIn connection request.

Avoid:
- Long introductions before getting to the point.
- Asking more than one question.
- Marketing language of any kind.
- Long paragraphs — short, plain sentences only.
- Explaining the product's features in detail.
- Overusing the word "I" at the start of consecutive sentences.

Other rules:
- Keep the email body under 140 words.
- Use the single most distinctive, relevant detail from the lead's personalization notes. If nothing genuinely specific is available, do not invent one or fall back to a generic compliment — write a shorter, more direct email instead.
- Write like one professional emailing another professional.
- Do NOT include any sign-off, closing line, name, or signature at the end (no "Best,", no name, nothing after the last sentence of the message). The application appends the sender's real signature automatically — if you include your own, it will appear twice.
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

Here is a real, higher-performing example. Use it ONLY as a reference for tone, clarity, structure, and length — do NOT copy its wording, phrases, or sentence structure. Generate an original email tailored specifically to this recipient's actual details above:
"""
Subject: Could I learn from your experience?

Hi Rick,

I came across your website and noticed the wide range of buyers you work with, especially first-time homebuyers and clients looking at new construction across the Las Vegas Valley.

I'm currently speaking with independent real estate agents to better understand how they manage leads, follow-ups, and client communication before building a new lead management platform.

If you have 10 minutes for a quick conversation sometime this or next week, I'd really appreciate learning from your experience. I'm not selling anything—I'm simply trying to build something that's genuinely useful for agents.

Thank you for your time, and I hope to hear from you.
"""

Structure to follow (using the reference above as a guide to tone and pacing, not a script to copy):
1. Open by referencing the single most distinctive, concrete detail from the lead's personalization notes — phrase it as something you noticed/observed, not a generic compliment. If no genuinely specific detail exists, skip this and open more directly instead.
2. State plainly that you're speaking with independent agents to understand how they manage leads/follow-ups/communication before building further.
3. The ask: request a short call (10 minutes) with a soft timeframe ("this or next week"), phrased so the only decision is yes or no.
4. A brief, natural disclaimer that this isn't a sales pitch.
5. A short thank-you line before the sign-off.

${SHARED_RULES}

Respond in exactly this format, nothing else:
SUBJECT: <subject line, under 6 words, should feel personal — like "Could I learn from your experience?" or "Quick question" — never like a newsletter or marketing subject>
BODY:
<email body>`.trim(),

  // Follow-up to an unanswered first email. Objective: bring the
  // original back to the top of the inbox without pressure — not
  // a mechanical "it's been N days" reminder.
  followUp: (lead, ctx, extra) => `
You are writing a brief follow-up email on behalf of ${ctx.founderName || 'a solo founder'}. The recipient hasn't replied to the original email below. Assume they're busy, not uninterested — your only goal is to bring the original email back to the top of their inbox without creating any pressure or guilt.

Original email that was sent:
"""
${extra.previousEmailBody}
"""

Recipient: ${lead.name || 'Unknown'} at ${lead.company || 'Unknown'}

Here are two real reference examples of the tone to aim for. Use them ONLY as a guide — do not copy their wording, generate something original:
"""
Example 1:
Hi Jane,

Just wanted to follow up on my previous email in case it got buried in your inbox.

If you'd still be open to a quick 10-minute conversation sometime this or next week, I'd really appreciate learning from your experience.

Thank you for your time.

---

Example 2:
Hi Jane,

I know things get busy, so I thought I'd check back on the email I sent a few days ago.

If now isn't a good time, no worries at all. If you're open to a brief chat later on, I'd really value your perspective.
"""

Write a short follow-up (under 50 words). Rules:
- Reference the original email in one short clause — do not repeat its content or re-explain the ask in detail.
- Do not apologize for following up, and do not mention how many days it's been.
- End with a simple next step. Usually this means restating the invitation for a short conversation, but if a lighter touch feels more natural for this recipient, use that instead — you don't have to repeat the exact same ask every time.
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
