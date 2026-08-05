// ============================================================
// api/check-bounces.js
//
// Endpoint: https://growth-hub-ai-api.vercel.app/api/check-bounces
//
// POST body: { workspaceId, accountId? }
// Response:  { scanned: number, bouncesFound: number, hardBounces: number, softBounces: number }
//
// The core of real bounce detection. Gmail's send API only confirms
// SUBMISSION succeeded — it has no idea whether the recipient's
// server actually accepted the message. When a send fails, the
// recipient's mail server (or Gmail itself, for Gmail-to-Gmail
// failures) sends an automated "Delivery Status Notification"
// bounce email BACK INTO the sending account's own inbox, usually
// from an address like mailer-daemon@googlemail.com. There is no
// other reliable signal — this is genuinely how every bounce-
// tracking system works, not a workaround specific to this app.
//
// This endpoint searches the connected account's inbox for exactly
// those notification emails (via Gmail's search query syntax, not
// by fetching every message — far more efficient), parses each one
// to recover the original recipient address and failure reason, and
// matches it back to the most recent SENT email_logs entry for that
// address. On a match:
//   - deliveryStatus is set to 'hard_bounce' or 'soft_bounce'
//     (classified from the bounce email's own status code/wording)
//   - bounceReason is stored (human-readable, from the notification)
//   - bouncedAt is set
//   - a HARD bounce additionally adds the address to the workspace's
//     suppressionList, which send-email.js checks before every
//     future send (spec requirement: never re-send to a confirmed-
//     dead address)
//
// On-demand only, same as check-reply.js — triggered by the founder
// (Deliverability Center's "Scan for Bounces" button), no background
// polling. A future scheduled version (Vercel Cron) could call this
// automatically; not built yet, this endpoint doesn't care how it's
// invoked.
//
// Uses the same FIREBASE_SERVICE_ACCOUNT_KEY, GMAIL_CLIENT_ID,
// GMAIL_CLIENT_SECRET env vars as every other Gmail endpoint here —
// no new placeholders introduced.
// ============================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { resolveGmailAccount, getAccessToken } from './_gmailAccounts.js';

function getAdminDb() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

const GMAIL_SEARCH_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GMAIL_MESSAGE_URL = (id) => `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;

// Gmail search query for bounce/delivery-failure notifications.
// Covers the common sender addresses/subject patterns used by
// Gmail's own bounce system and most other mail servers' standard
// DSN (Delivery Status Notification) format. Scoped to the last 30
// days so a scan doesn't re-walk months of old notifications every
// time — email_logs entries older than that are treated as
// permanently "unknown" outcome rather than re-checked forever.
const BOUNCE_SEARCH_QUERY = '(from:mailer-daemon OR from:"Mail Delivery Subsystem" OR subject:"Delivery Status Notification" OR subject:"Undelivered Mail Returned" OR subject:"Delivery incomplete") newer_than:30d';

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

  const { workspaceId, accountId } = request.body || {};

  if (!workspaceId) {
    return response.status(400).json({ error: 'Missing required field: workspaceId' });
  }

  const db = getAdminDb();

  try {
    const workspaceSnap = await db.collection('workspaces').doc(workspaceId).get();
    const workspace = workspaceSnap.data();

    if (!workspace) {
      return response.status(404).json({ error: 'Workspace not found.' });
    }

    const account = resolveGmailAccount(workspace, accountId);

    if (!account || !account.refreshToken) {
      return response.status(400).json({ error: 'Gmail is not connected for this workspace. Connect it in Settings first.' });
    }

    let accessToken;
    try {
      accessToken = await getAccessToken(account.refreshToken);
    } catch (err) {
      return response.status(401).json({ error: err.message, accountId: account.id });
    }

    // Step 1: search for candidate bounce-notification messages.
    const searchUrl = `${GMAIL_SEARCH_URL}?q=${encodeURIComponent(BOUNCE_SEARCH_QUERY)}&maxResults=100`;
    const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (!searchRes.ok) {
      const errData = await searchRes.json().catch(() => ({}));
      console.error('Bounce search failed:', errData);
      return response.status(502).json({ error: 'Could not search Gmail for bounce notifications.', detail: errData });
    }

    const searchData = await searchRes.json();
    const candidateIds = (searchData.messages || []).map(m => m.id);

    let scanned = 0;
    let bouncesFound = 0;
    let hardBounces = 0;
    let softBounces = 0;

    // Step 2: fetch and parse each candidate, one at a time. Gmail's
    // API has no batch-get for full message content via this simple
    // fetch pattern, so this is sequential — acceptable since bounce
    // volume is normally a small fraction of total send volume, not
    // every message in the account.
    for (const messageId of candidateIds) {
      scanned++;
      try {
        const msgRes = await fetch(GMAIL_MESSAGE_URL(messageId), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!msgRes.ok) continue;
        const message = await msgRes.json();

        const parsed = parseBounceNotification(message);
        if (!parsed) continue; // didn't look like a real bounce on closer inspection

        bouncesFound++;
        if (parsed.bounceType === 'hard_bounce') hardBounces++;
        else softBounces++;

        await applyBounceToLog(db, workspaceId, parsed);

      } catch (msgErr) {
        console.error(`Failed to process candidate bounce message ${messageId}:`, msgErr);
        // Continue scanning the rest — one malformed message
        // shouldn't abort the whole scan.
      }
    }

    return response.status(200).json({ scanned, bouncesFound, hardBounces, softBounces });

  } catch (err) {
    console.error('check-bounces handler error:', err);
    return response.status(500).json({ error: 'Unexpected error while scanning for bounces.', detail: err.message });
  }
}

/**
 * Parses a candidate Gmail message and determines whether it's a
 * genuine delivery-failure notification, and if so, extracts the
 * original recipient address, a human-readable reason, and whether
 * it's a hard (permanent) or soft (temporary) bounce.
 *
 * Returns null if the message doesn't actually look like a bounce
 * on closer inspection (the search query is intentionally broad —
 * this is the precise filter).
 */
function parseBounceNotification(message) {
  const subject = (getHeader(message, 'Subject') || '').toLowerCase();
  const bodyText = extractPlainTextBody(message).toLowerCase();

  const looksLikeBounce =
    subject.includes('delivery status notification') ||
    subject.includes('undelivered mail') ||
    subject.includes('delivery incomplete') ||
    subject.includes('failure notice') ||
    bodyText.includes('delivery to the following recipient') ||
    bodyText.includes('message wasn') || // "wasn't delivered"
    bodyText.includes('permanent error') ||
    bodyText.includes('temporary error');

  if (!looksLikeBounce) return null;

  // Extract the original recipient — most DSN bounce bodies contain
  // the failed address explicitly, often after phrases like
  // "the following recipient" or "Original-Recipient:" (RFC 3464
  // machine-readable DSN part) or simply as the only email address
  // mentioned outside the mailer-daemon's own address.
  const recipientEmail = extractOriginalRecipient(bodyText, message);
  if (!recipientEmail) return null; // can't act on a bounce we can't attribute to an address

  // Hard vs soft classification. RFC 3463 status codes: 5.x.x =
  // permanent failure (hard), 4.x.x = temporary failure (soft).
  // Fall back to keyword matching when no explicit status code is
  // present, since not every mail server includes one.
  const hasPermanentCode = /\b5\.\d\.\d\b/.test(bodyText);
  const hasTemporaryCode = /\b4\.\d\.\d\b/.test(bodyText);
  const permanentKeywords = ['does not exist', "doesn't exist", 'no such user', 'user unknown',
    'address not found', 'invalid recipient', 'permanent error', 'mailbox not found'];
  const temporaryKeywords = ['mailbox full', 'over quota', 'temporarily', 'try again later',
    'temporary error', 'greylist'];

  let bounceType;
  if (hasPermanentCode || permanentKeywords.some(k => bodyText.includes(k))) {
    bounceType = 'hard_bounce';
  } else if (hasTemporaryCode || temporaryKeywords.some(k => bodyText.includes(k))) {
    bounceType = 'soft_bounce';
  } else {
    // Ambiguous — default to soft. A false "hard" classification has
    // a real cost (permanently suppresses an address that might
    // actually be fine), while a false "soft" just means it may get
    // re-checked or re-sent later. Erring toward the reversible
    // outcome when genuinely unsure.
    bounceType = 'soft_bounce';
  }

  const reason = extractBounceReason(bodyText) || (bounceType === 'hard_bounce' ? 'Permanent delivery failure' : 'Temporary delivery failure');

  return {
    recipientEmail: recipientEmail.toLowerCase(),
    bounceType,
    reason,
    bouncedAt: getHeader(message, 'Date') ? new Date(getHeader(message, 'Date')).toISOString() : new Date().toISOString()
  };
}

/**
 * Best-effort extraction of the original failed recipient address
 * from a bounce notification body. Tries, in order: an explicit
 * "Original-Recipient:" or "Final-Recipient:" DSN field (most
 * reliable, machine-readable), then a labeled line like "The
 * following recipient(s) could not be delivered", then falls back
 * to the first email address found in the body that ISN'T the
 * mailer-daemon's own address.
 */
function extractOriginalRecipient(bodyText, message) {
  const dsnMatch = bodyText.match(/(?:original-recipient|final-recipient)\s*:\s*(?:rfc822;)?\s*([^\s<>]+@[^\s<>]+)/i);
  if (dsnMatch) return dsnMatch[1].replace(/[.,;]+$/, '');

  const labeledMatch = bodyText.match(/(?:recipient|address)s?\s*:?\s*\n?\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  if (labeledMatch) return labeledMatch[1];

  // Fallback: any email address in the body that isn't a
  // mailer-daemon/postmaster address (those are the sender of the
  // bounce itself, never the failed recipient).
  const allEmails = bodyText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  const realRecipient = allEmails.find(e =>
    !e.toLowerCase().includes('mailer-daemon') &&
    !e.toLowerCase().includes('postmaster') &&
    !e.toLowerCase().includes('mail-delivery')
  );
  return realRecipient || null;
}

/**
 * Best-effort extraction of a short, human-readable reason from a
 * bounce body, for display in the Bounce History table. Looks for
 * common DSN "Diagnostic-Code" or explanatory lines; falls back to
 * null (caller supplies a generic default) rather than showing raw
 * technical SMTP dump text.
 */
function extractBounceReason(bodyText) {
  // Check for a friendly, known reason FIRST — a raw SMTP diagnostic
  // code like "smtp; 550 5.1.1 ..." is accurate but not pleasant to
  // read in the Bounce History table; prefer the plain-English
  // version whenever the body clearly matches one.
  const commonReasons = [
    { pattern: /does not exist|doesn't exist|no such user|user unknown/i, reason: "Mailbox doesn't exist" },
    { pattern: /mailbox full|over quota/i, reason: 'Mailbox full' },
    { pattern: /domain.*not found|no mx record/i, reason: 'Domain not found' },
    { pattern: /blocked|spam|reputation/i, reason: 'Blocked by recipient server (spam/reputation)' },
    { pattern: /invalid recipient|address not found/i, reason: 'Invalid recipient address' }
  ];
  for (const { pattern, reason } of commonReasons) {
    if (pattern.test(bodyText)) return reason;
  }

  // Fall back to the raw diagnostic code, cleaned up a little, only
  // when none of the friendly patterns matched.
  const diagMatch = bodyText.match(/diagnostic-code\s*:\s*([^\n]+)/i);
  if (diagMatch) return diagMatch[1].replace(/^smtp;\s*/i, '').trim().slice(0, 200);

  return null;
}

/**
 * Applies a parsed bounce to the matching email_logs entry (most
 * recent SENT entry for that recipient, since a lead could have
 * been emailed more than once — the bounce almost always corresponds
 * to the latest send) and, for a hard bounce, adds the address to
 * the suppression list.
 */
async function applyBounceToLog(db, workspaceId, parsed) {
  const logsRef = db.collection('workspaces').doc(workspaceId).collection('email_logs');

  const matchSnap = await logsRef
    .where('recipientEmail', '==', parsed.recipientEmail)
    .orderBy('sentAt', 'desc')
    .limit(1)
    .get();

  if (!matchSnap.empty) {
    const logDoc = matchSnap.docs[0];
    // Don't downgrade an already-confirmed hard bounce back to soft,
    // or overwrite one bounce record with a second, less-specific
    // notification about the same failure — only update if this log
    // entry hasn't already been marked bounced.
    const existing = logDoc.data();
    if (existing.deliveryStatus !== 'hard_bounce') {
      await logDoc.ref.update({
        deliveryStatus: parsed.bounceType,
        bounceReason: parsed.reason,
        bouncedAt: parsed.bouncedAt
      });
    }
  }

  if (parsed.bounceType === 'hard_bounce') {
    // Suppression is keyed by email itself (not tied to one log
    // entry), since the whole point is "never send here again,"
    // regardless of which send or which lead triggered it.
    await db.collection('workspaces').doc(workspaceId).collection('suppressionList')
      .doc(parsed.recipientEmail).set({
        email: parsed.recipientEmail,
        reason: parsed.reason,
        suppressedAt: parsed.bouncedAt
      });
  }
}

function getHeader(message, headerName) {
  const headers = message.payload?.headers || [];
  const found = headers.find(h => h.name.toLowerCase() === headerName.toLowerCase());
  return found?.value || null;
}

function extractPlainTextBody(message) {
  const payload = message.payload;
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    const plainPart = findPlainTextPart(payload.parts);
    if (plainPart?.body?.data) return decodeBase64Url(plainPart.body.data);
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return '';
}

function findPlainTextPart(parts) {
  for (const part of parts) {
    if (part.mimeType === 'text/plain') return part;
    if (part.parts) {
      const nested = findPlainTextPart(part.parts);
      if (nested) return nested;
    }
  }
  return null;
}

function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}
