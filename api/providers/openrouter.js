// ============================================================
// api/providers/openrouter.js
//
// Adapter for OpenRouter. This is the FALLBACK provider — only
// called if all Gemini keys fail. Also supports multiple keys
// internally (you have several OpenRouter keys), tried in order.
//
// >>> PLACEHOLDERS TO REPLACE: OPENROUTER_API_KEY_1, OPENROUTER_API_KEY_2,
// OPENROUTER_API_KEY_3, OPENROUTER_API_KEY_4, OPENROUTER_API_KEY_5 <<<
// Set in Vercel dashboard -> Project Settings -> Environment Variables.
// Only the ones you actually set will be used — unset ones are
// skipped automatically, so you don't need all 5 filled in to start.
// ============================================================

const KEYS = [
  process.env.OPENROUTER_API_KEY_1,
  process.env.OPENROUTER_API_KEY_2,
  process.env.OPENROUTER_API_KEY_3,
  process.env.OPENROUTER_API_KEY_4,
  process.env.OPENROUTER_API_KEY_5
].filter(Boolean);

const MODEL = 'google/gemini-2.0-flash-001'; // reasonable default; swap freely, this is just a starting choice
const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Calls OpenRouter with the given prompt, trying each configured
 * key in order.
 *
 * @param {string} prompt
 * @returns {Promise<{ text: string, provider: string, model: string }>}
 * @throws if all configured OpenRouter keys fail
 */
export async function callOpenRouter(prompt) {
  if (KEYS.length === 0) {
    throw new Error('No OpenRouter API keys configured');
  }

  const errors = [];

  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[i];
    try {
      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 1500
        })
      });

      if (response.status === 429) {
        errors.push(`OpenRouter key ${i + 1}: rate limited (429)`);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        errors.push(`OpenRouter key ${i + 1}: HTTP ${response.status} - ${body.slice(0, 200)}`);
        continue;
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;

      if (!text) {
        errors.push(`OpenRouter key ${i + 1}: empty response`);
        continue;
      }

      return { text, provider: 'openrouter', model: MODEL };

    } catch (err) {
      errors.push(`OpenRouter key ${i + 1}: ${err.message}`);
      continue;
    }
  }

  throw new Error(`All OpenRouter keys failed: ${errors.join('; ')}`);
}
