// ============================================================
// api/generate-email.js
//
// Endpoint: https://<project>.vercel.app/api/generate-email
//
// POST body:
//   { "type": "outreach", "lead": {...}, "workspaceContext": {...} }
//   OR
//   { "type": "followup", "lead": {...}, "previousEmailBody": "...",
//     "daysSinceSent": 3, "workspaceContext": {...} }
//
// Response: { subject, body, provider, model }
//
// This endpoint ONLY generates content — spec Part 4 §2 principle:
// "Never automatically send emails without explicit user
// confirmation." Sending is a completely separate step (Gmail
// Engine, later) that always requires the founder's approval first.
// ============================================================

import { generateWithAI, parseEmailResponse } from './aiManager.js';
import { buildOutreachPrompt, buildFollowUpPrompt } from './promptManager.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Use POST' });
  }

  const { type, lead, workspaceContext, previousEmailBody, daysSinceSent } = request.body || {};

  if (!type || !['outreach', 'followup'].includes(type)) {
    return response.status(400).json({ error: '"type" must be "outreach" or "followup"' });
  }
  if (!lead || typeof lead !== 'object') {
    return response.status(400).json({ error: 'Missing "lead" object in request body' });
  }
  if (type === 'followup' && !previousEmailBody) {
    return response.status(400).json({ error: '"previousEmailBody" is required for type "followup"' });
  }

  const prompt = type === 'outreach'
    ? buildOutreachPrompt(lead, workspaceContext)
    : buildFollowUpPrompt(lead, previousEmailBody, daysSinceSent || 3, workspaceContext);

  try {
    const result = await generateWithAI(prompt);
    const { subject, body } = parseEmailResponse(result.text);

    return response.status(200).json({
      subject,
      body,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error('generate-email handler error:', err);
    return response.status(502).json({ error: 'AI generation failed. All providers unavailable.', detail: err.message });
  }
}
