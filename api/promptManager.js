// ============================================================
// api/promptManager.js
//
// Prompt Manager (spec Part 4 §6): prompts live here as named,
// versioned templates — not hardcoded inline wherever AI gets
// called. Adding a new AI feature later (reply summarizer, feature
// extractor, etc.) means adding one function here, not touching
// provider or routing code.
//
// Each function takes structured data and returns a plain-text
// prompt string ready to send to whichever provider answers.
// ============================================================

/**
 * Outreach Email Generator (spec Part 4 §8, first sub-section).
 * Builds the prompt for a first-touch personalized outreach email.
 *
 * @param {object} lead - lead fields (name, company, role, city, personalization, etc.)
 * @param {object} workspaceContext - workspace memory (spec Part 4 §5)
 * @returns {string} the assembled prompt
 */
/**
 * Outreach Email Generator (spec Part 4 §8, first sub-section).
 * Builds the prompt for a first-touch personalized outreach email.
 *
 * Supports per-workspace customization (feature request: let users
 * outside real estate — salons, tattoo studios, any niche — adapt
 * the prompt without needing a code change):
 *   - Default mode: structured fields on workspaceContext
 *     (founderName/productDescription/targetMarket/tone/
 *     validationGoal/askFor/avoidTopics) are safely assembled into
 *     the prompt below. The required SUBJECT:/BODY: response format
 *     is always enforced by this function, never overridable —
 *     that's what the rest of the app (parseEmailResponse in
 *     aiManager.js) depends on to work at all.
 *   - Freeform mode (workspaceContext.customPromptMode === 'freeform'
 *     AND workspaceContext.customOutreachPrompt is set): the user's
 *     own full prompt text replaces everything above the format
 *     instruction — they get complete control over tone/goal/
 *     structure, but the SUBJECT:/BODY: requirement (and the
 *     no-sign-off rule, since appendSignature() in aiService.js
 *     always runs regardless of prompt source) are still appended
 *     after their text, non-negotiably.
 *
 * @param {object} lead - lead fields (name, company, role, city, personalization, etc.)
 * @param {object} workspaceContext - workspace memory (spec Part 4 §5)
 * @returns {string} the assembled prompt
 */
export function buildOutreachPrompt(lead, workspaceContext = {}) {
  const {
    founderName = 'the founder',
    productDescription = 'a lead management platform for independent agents',
    targetMarket = 'independent real estate agents',
    tone = 'professional, conversational, founder-to-founder',
    validationGoal = 'validate the product idea and learn what real agents need',
    askFor = '',
    avoidTopics = '',
    customPromptMode = 'structured',
    customOutreachPrompt = ''
  } = workspaceContext;

  const formatInstruction = `\n\nRespond in exactly this format, nothing else:\nSUBJECT: <subject line, under 8 words>\nBODY:\n<email body — must end right after the last sentence of the message itself, no closing/sign-off. Do NOT include any sign-off, closing line, or name — the real signature is appended automatically after your response.>`;

  if (customPromptMode === 'freeform' && customOutreachPrompt.trim()) {
    return `${customOutreachPrompt.trim()}\n\nRecipient details for this email:\n- Name: ${lead.name || 'Unknown'}\n- Company: ${lead.company || 'Unknown'}\n- Role: ${lead.role || 'Unknown'}\n- City: ${lead.city || 'Unknown'}\n- Website: ${lead.website || 'Unknown'}\n- Personalization notes: ${lead.personalization || 'None provided'}\n- General notes: ${lead.notes || 'None provided'}${formatInstruction}`;
  }

  return `You are writing a short, personalized cold outreach email on behalf of ${founderName}, a solo founder building ${productDescription} for ${targetMarket}.

Your goal for this email is to ${validationGoal} — this is a genuine validation conversation, not a sales pitch. The tone should be ${tone}.

Here is what's known about the recipient:
- Name: ${lead.name || 'Unknown'}
- Company: ${lead.company || 'Unknown'}
- Role: ${lead.role || 'Unknown'}
- City: ${lead.city || 'Unknown'}
- Website: ${lead.website || 'Unknown'}
- Personalization notes: ${lead.personalization || 'None provided'}
- General notes: ${lead.notes || 'None provided'}

Write a short outreach email (under 130 words for the body). Requirements:
- Reference something specific and genuine from the personalization notes or their role/city — avoid generic flattery.
- Ask one clear, low-pressure question that invites a real reply (not a yes/no question).${askFor ? ` Specifically, try to learn: ${askFor}.` : ''}
- Do not oversell the product. This is about learning, not closing a sale.
- Do not use corporate buzzwords or exclamation points.${avoidTopics ? `\n- Avoid mentioning: ${avoidTopics}.` : ''}
- Do NOT include any sign-off, closing line, or name at the end (no "Best," no "Thanks," no name) — the real signature is appended automatically after your response, so anything you add here would create a duplicate.${formatInstruction}`;
}

/**
 * Follow-up Generator (spec Part 4 §8, second sub-section; Part 5 §15).
 * Builds a follow-up that references the prior email rather than
 * repeating it.
 *
 * @param {object} lead
 * @param {string} previousEmailBody - the body of the email being followed up on
 * @param {number} daysSinceSent
 * @param {object} workspaceContext
 * @returns {string}
 */
/**
 * Follow-up Generator (spec Part 4 §8, second sub-section; Part 5 §15).
 * Builds a follow-up that references the prior email rather than
 * repeating it. Same structured/freeform customization support as
 * buildOutreachPrompt above — see that function's comment for the
 * full explanation of both modes.
 *
 * @param {object} lead
 * @param {string} previousEmailBody - the body of the email being followed up on
 * @param {number} daysSinceSent
 * @param {object} workspaceContext
 * @returns {string}
 */
export function buildFollowUpPrompt(lead, previousEmailBody, daysSinceSent, workspaceContext = {}) {
  const {
    founderName = 'the founder',
    tone = 'professional, conversational, founder-to-founder',
    customPromptMode = 'structured',
    customFollowUpPrompt = ''
  } = workspaceContext;

  const formatInstruction = `\n\nRespond in exactly this format, nothing else:\nSUBJECT: <subject line, under 8 words>\nBODY:\n<email body — must end right after the last sentence of the message itself, no closing/sign-off. Do NOT include any sign-off, closing line, or name — the real signature is appended automatically after your response.>`;

  if (customPromptMode === 'freeform' && customFollowUpPrompt.trim()) {
    return `${customFollowUpPrompt.trim()}\n\nOriginal email that was sent ${daysSinceSent} days ago, with no reply yet:\n"""\n${previousEmailBody}\n"""\n\nRecipient: ${lead.name || 'Unknown'} at ${lead.company || 'Unknown'}${formatInstruction}`;
  }

  return `You are writing a brief, natural follow-up email on behalf of ${founderName}. It has been ${daysSinceSent} days since the original email below was sent, with no reply yet.

Original email that was sent (NOTE: this includes its own closing/signature at the bottom — that was fine for that email, but do not copy or imitate that closing in your follow-up; see the requirement below):
"""
${previousEmailBody}
"""

Recipient: ${lead.name || 'Unknown'} at ${lead.company || 'Unknown'}

Write a short follow-up (under 60 words). Requirements:
- Reference the original email naturally — do not repeat its content.
- Assume they're busy, not uninterested. Tone should be light, not pushy or apologetic.
- End with a very easy way to respond (e.g. a single question they can answer in one line).
- Tone: ${tone}.
- Do NOT include any sign-off, closing line, or name at the end (no "Best," no "Thanks," no name) — the real signature is appended automatically after your response, so anything you add here would create a duplicate.${formatInstruction}`;
}

/**
 * Reply Summarizer (spec Part 4 §8; Part 2 §10 Reply Collection fields).
 * Extracts structured signal from a raw reply.
 *
 * @param {string} replyBody - raw text of the reply
 * @returns {string}
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
