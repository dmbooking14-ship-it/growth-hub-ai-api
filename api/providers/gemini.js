// ============================================================
// api/providers/gemini.js
//
// Adapter for Google's Gemini API. Speaks Gemini's specific
// request/response format; returns our normalized shape.
//
// Supports TWO keys for the same provider (spec Part 4 §4: "Gemini
// Key 1 -> Rate Limited -> Gemini Key 2"). Both keys are tried here,
// in order, before falling through to a different provider entirely
// (OpenRouter) — that fallback-between-providers logic lives one
// level up, in aiManager.js, not in this file.
//
// >>> PLACEHOLDERS TO REPLACE: GEMINI_API_KEY_1, GEMINI_API_KEY_2 <<<
// Set in Vercel dashboard -> Project Settings -> Environment Variables.
// Never hardcoded here.
// ============================================================

const KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2
].filter(Boolean); // skips any key that isn't set, so partial setup doesn't crash

const MODEL = 'gemini-flash-latest'; // stable alias Google maintains to always point at their current
                                       // recommended Flash model (gemini-2.0-flash was shut down June 1,
                                       // 2026 — using a versioned name risks this breaking again the same
                                       // way when Google deprecates the next one)
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/**
 * Calls Gemini with the given prompt, trying each configured key in
 * order. Distinguishes quota/rate-limit errors (try next key) from
 * other errors (still try next key, but log differently — spec
 * Part 4 §12 distinguishes retry-worthy vs terminal failures).
 *
 * @param {string} prompt - fully assembled prompt text
 * @returns {Promise<{ text: string, provider: string, model: string }>}
 * @throws if all configured Gemini keys fail
 */
export async function callGemini(prompt) {
  if (KEYS.length === 0) {
    throw new Error('No Gemini API keys configured');
  }

  const errors = [];

  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[i];
    try {
      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2500 }
        })
      });

      if (response.status === 429) {
        // Rate limited / quota exhausted on this specific key — try the next one.
        errors.push(`Gemini key ${i + 1}: rate limited (429)`);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        errors.push(`Gemini key ${i + 1}: HTTP ${response.status} - ${body.slice(0, 200)}`);
        continue;
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      const finishReason = candidate?.finishReason;

      // DIAGNOSTIC LOGGING (temporary — investigating truncated
      // outputs reported July 2026). Check Vercel's function logs
      // after a test generation for this exact line. finishReason
      // tells us definitively why generation stopped:
      //   STOP        = completed normally (truncation is NOT this)
      //   MAX_TOKENS   = hit maxOutputTokens (raise the limit)
      //   SAFETY       = content filter triggered
      //   RECITATION   = flagged as reproducing source text (likely
      //                  culprit — we feed a real reference email
      //                  into the prompt, which may trip this)
      //   OTHER        = unspecified
      console.log('[Gemini diagnostic] finishReason:', finishReason, '| text length:', text?.length, '| key index:', i + 1);

      if (!text) {
        errors.push(`Gemini key ${i + 1}: empty response (finishReason: ${finishReason || 'unknown'})`);
        continue;
      }

      if (finishReason && finishReason !== 'STOP') {
        // Generation was cut short for a reason other than natural
        // completion. Still return the (partial) text rather than
        // failing outright — a partial email is more useful than
        // none, and the finishReason is now visible in logs — but
        // flag it clearly so the caller/UI could eventually surface
        // "this response may be incomplete" if desired.
        errors.push(`Gemini key ${i + 1}: finished early (${finishReason})`);
        console.warn(`[Gemini diagnostic] Non-STOP finishReason: ${finishReason}. Returning partial text anyway.`);
      }

      return { text, provider: 'gemini', model: MODEL, finishReason: finishReason || 'STOP' };

    } catch (err) {
      // Network-level failure (timeout, DNS, etc.) — treat as transient, try next key.
      errors.push(`Gemini key ${i + 1}: ${err.message}`);
      continue;
    }
  }

  throw new Error(`All Gemini keys failed: ${errors.join('; ')}`);
}
