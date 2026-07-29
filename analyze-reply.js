// ============================================================
// api/analyze-reply.js
//
// Endpoint: https://<project>.vercel.app/api/analyze-reply
//
// POST body: { "replyBody": "raw text of the reply" }
// Response: { summary, sentiment, painPoints, featureRequests,
//              competitorsMentioned, objections, betaInterest,
//              suggestedNextAction, provider, model }
//
// This is the piece that feeds the Knowledge Base (spec Part 4 §10,
// Part 2 §11) — but this endpoint only ANALYZES; saving the result
// into Firestore's knowledge collection happens on the frontend
// side, once Gmail reply-detection exists to actually feed it real
// replies.
// ============================================================

import { generateWithAI, parseReplyAnalysis } from './aiManager.js';
import { buildReplySummaryPrompt } from './promptManager.js';

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

  const { replyBody } = request.body || {};

  if (!replyBody || typeof replyBody !== 'string') {
    return response.status(400).json({ error: 'Missing "replyBody" in request body' });
  }

  const prompt = buildReplySummaryPrompt(replyBody);

  try {
    const result = await generateWithAI(prompt);
    const analysis = parseReplyAnalysis(result.text);

    return response.status(200).json({
      ...analysis,
      provider: result.provider,
      model: result.model
    });
  } catch (err) {
    console.error('analyze-reply handler error:', err);
    return response.status(502).json({ error: 'AI analysis failed. All providers unavailable.', detail: err.message });
  }
}
