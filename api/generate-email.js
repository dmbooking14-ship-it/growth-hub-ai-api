// ============================================================
// api/generate-email.js
//
// Endpoint: https://<project>.vercel.app/api/generate-email
//
// POST body:
//   {
//     "templateKey": "validationCall",   // or "followUp", "betaInvitation" — see promptManager.js TEMPLATES
//     "lead": {...},
//     "workspaceContext": {...},          // optional: founderName, productDescription, etc.
//     "extra": {                          // only needed for "followUp"
//       "previousEmailBody": "...",
//       "daysSinceSent": 3
//     }
//   }
//
// If "templateKey" is omitted, defaults to "validationCall" (the
// standard first-touch outreach email).
//
// Response: { subject, body, provider, model, templateKey }
//
// This endpoint ONLY generates content — spec Part 4 §2 principle:
// "Never automatically send emails without explicit user
// confirmation." Sending is a completely separate step (Gmail
// Engine, later) that always requires the founder's approval first.
// ============================================================

import { generateWithAI, parseEmailResponse } from './aiManager.js';
import { buildEmailPrompt, getAvailableTemplates } from './promptManager.js';

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Use POST' });
  }

  const { templateKey = 'validationCall', lead, workspaceContext = {}, extra = {} } = request.body || {};

  const available = getAvailableTemplates();
  if (!available.includes(templateKey)) {
    return response.status(400).json({
      error: `Unknown templateKey "${templateKey}". Available: ${available.join(', ')}`
    });
  }
  if (!lead || typeof lead !== 'object') {
    return response.status(400).json({ error: 'Missing "lead" object in request body' });
  }
  if (templateKey === 'followUp' && !extra.previousEmailBody) {
    return response.status(400).json({ error: '"extra.previousEmailBody" is required for templateKey "followUp"' });
  }

  const prompt = buildEmailPrompt(templateKey, lead, workspaceContext, extra);

  try {
    const result = await generateWithAI(prompt);
    const { subject, body } = parseEmailResponse(result.text);

    return response.status(200).json({
      subject,
      body,
      provider: result.provider,
      model: result.model,
      templateKey
    });
  } catch (err) {
    console.error('generate-email handler error:', err);
    return response.status(502).json({ error: 'AI generation failed. All providers unavailable.', detail: err.message });
  }
}
