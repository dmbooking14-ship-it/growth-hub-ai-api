// ============================================================
// api/aiManager.js
//
// The ONLY file that knows the AI provider fallback order (spec
// Part 4 §3-4): Gemini (both keys tried internally) -> OpenRouter
// (all keys tried internally) if Gemini fully fails.
//
// Adding a new provider later: write api/providers/newProvider.js
// in the same shape as gemini.js/openrouter.js (a single
// callX(prompt) function returning { text, provider, model }),
// import it here, add one line to the PROVIDERS array.
// ============================================================

import { callGemini } from './providers/gemini.js';
import { callOpenRouter } from './providers/openrouter.js';

const PROVIDERS = [
  { name: 'gemini', fn: callGemini },
  { name: 'openrouter', fn: callOpenRouter }
  // To add a provider: import above, add one line here.
];

/**
 * Sends a prompt through the provider fallback chain. Returns the
 * first successful response. Throws only if every provider fails
 * entirely (spec Part 4 §12: retry once implicitly via multi-key,
 * switch provider, notify only if all fail).
 *
 * @param {string} prompt
 * @returns {Promise<{ text: string, provider: string, model: string }>}
 */
export async function generateWithAI(prompt) {
  const errors = [];

  for (const provider of PROVIDERS) {
    try {
      const result = await provider.fn(prompt);
      return result; // first success wins
    } catch (err) {
      console.error(`AI provider ${provider.name} failed:`, err.message);
      errors.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(`All AI providers failed: ${errors.join(' | ')}`);
}

/**
 * Parses the "SUBJECT: ... BODY: ..." format our outreach/follow-up
 * prompts request. Returns { subject, body }. Falls back gracefully
 * if the model didn't follow the format exactly, rather than throwing.
 */
export function parseEmailResponse(rawText) {
  const subjectMatch = rawText.match(/SUBJECT:\s*(.+)/i);
  const bodyMatch = rawText.match(/BODY:\s*([\s\S]+)/i);

  return {
    subject: subjectMatch ? subjectMatch[1].trim() : '',
    body: bodyMatch ? bodyMatch[1].trim() : rawText.trim() // fallback: whole response as body
  };
}

/**
 * Parses the JSON format the reply-summary prompt requests. Strips
 * markdown code fences if the model added them despite instructions
 * not to (models do this often enough that it's worth handling).
 */
export function parseReplyAnalysis(rawText) {
  const cleaned = rawText.replace(/```json\s*|\s*```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('Failed to parse reply analysis JSON:', err.message, cleaned);
    // Return a safe fallback shape rather than throwing, so one bad
    // AI response doesn't break the whole reply-handling flow.
    return {
      summary: 'Could not automatically analyze this reply.',
      sentiment: 'Neutral',
      painPoints: [],
      featureRequests: [],
      competitorsMentioned: [],
      objections: [],
      betaInterest: 'Unclear',
      suggestedNextAction: 'Review manually'
    };
  }
}

