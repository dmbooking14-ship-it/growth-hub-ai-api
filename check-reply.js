// ============================================================
// api/check-reply.js
//
// Endpoint: https://growth-hub-ai-api.vercel.app/api/check-reply
//
// POST body: { workspaceId, threadId }
// Response:  { hasReply: boolean, reply: { from, body, receivedAt } | null }
//
// On-demand only (Option A from planning) — checked when the
// founder taps "Check for Reply" on a lead's detail screen. No
// background polling or scheduled job exists yet; that would be a
// separate, later addition (Option B) built on top of this same
// endpoint once it's proven correct.
//
// How it determines "is there a reply": fetches the full Gmail
// thread by threadId (stored on the lead by send-email.js), then
// looks for any message in that thread NOT sent by the connected
// Gmail account itself. If found, the most recent such message is
// treated as "the reply."
//
// Uses the same FIREBASE_SERVICE_ACCOUNT_KEY, GMAIL_CLIENT_ID,
// GMAIL_CLIENT_SECRET env vars as gmail-callback.js/send-email.js —
// no new placeholders introduced by this file.
// ============================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getAdminDb() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_THREAD_URL = (threadId) => `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`;

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

  const { workspaceId, threadId } = request.body || {};

  if (!workspaceId || !threadId) {
    return response.status(400).json({ error: 'Missing required field(s): workspaceId, threadId' });
  }

  const db = getAdminDb();

  try {
    // Step 1: get the workspace's stored refresh token + connected email
    const workspaceSnap = await db.collection('workspaces').doc(workspaceId).get();
    const workspace = workspaceSnap.data();

    if (!workspace?.gmailRefreshToken) {
      return response.status(400).json({ error: 'Gmail is not connected for this workspace. Connect it in Settings first.' });
    }

    // Step 2: exchange refresh token for a fresh access token
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: workspace.gmailRefreshToken,
        client_id: process.env.GMAIL_CLIENT_ID,
        client_secret: process.env.GMAIL_CLIENT_SECRET,
        grant_type: 'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Access token refresh failed:', tokenData);
      return response.status(401).json({ error: 'Gmail connection expired or was revoked. Please reconnect in Settings.' });
    }

    // Step 3: fetch the full thread
    const threadRes = await fetch(GMAIL_THREAD_URL(threadId), {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (!threadRes.ok) {
      const errData = await threadRes.json().catch(() => ({}));
      console.error('Thread fetch failed:', errData);
      return response.status(502).json({ error: 'Could not read this Gmail thread.', detail: errData });
    }

    const threadData = await threadRes.json();
    const messages = threadData.messages || [];

    // Step 4: find the most recent message NOT sent by us.
    //
    // BUG FIX (found via on-screen debugInfo, July 2026): previously
    // used `!fromHeader.includes(ourEmail)` with ourEmail possibly
    // being an empty string (when workspace.gmailEmail wasn't
    // populated) — String.includes('') is always true, so EVERY
    // message, including real replies, got misclassified as "sent
    // by us" and silently filtered out. Two fixes applied:
    //   1. Defensive guard: if ourEmail is empty, fall back to
    //      Gmail's own SENT label instead of string comparison —
    //      this is more reliable anyway, since it's Gmail's own
    //      classification rather than us re-deriving it from a
    //      possibly-stale stored email.
    //   2. Even when ourEmail IS populated, prefer the label check
    //      as primary signal, with the string comparison only as
    //      fallback for edge cases.
    const ourEmail = (workspace.gmailEmail || '').toLowerCase();
    const incomingMessages = messages.filter(msg => {
      const labels = msg.labelIds || [];
      if (labels.includes('SENT')) return false; // Gmail's own classification — most reliable signal
      if (labels.includes('INBOX') || labels.includes('UNREAD')) return true; // clearly incoming

      // Fallback for messages with ambiguous/missing labels: compare
      // From header, but only if we actually have ourEmail to compare
      // against (an empty ourEmail here means "unknown," not "match
      // everything" — this is the specific bug that was fixed).
      if (!ourEmail) return true; // can't determine sender — assume incoming rather than silently dropping it
      const fromHeader = (getHeader(msg, 'From') || '').toLowerCase();
      return !fromHeader.includes(ourEmail);
    });

    if (incomingMessages.length === 0) {
      return response.status(200).json({
        hasReply: false,
        reply: null,
        debugInfo: {
          messageCount: messages.length,
          checkedAgainstEmail: ourEmail,
          allSenders: messages.map(m => getHeader(m, 'From'))
        }
      });
    }

    // Messages come back in chronological order — take the last incoming one
    const latestReply = incomingMessages[incomingMessages.length - 1];
    const replyBody = extractPlainTextBody(latestReply);
    const fromHeader = getHeader(latestReply, 'From') || '';
    const dateHeader = getHeader(latestReply, 'Date') || '';

    return response.status(200).json({
      hasReply: true,
      reply: {
        from: fromHeader,
        body: replyBody,
        receivedAt: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString()
      }
    });

  } catch (err) {
    console.error('check-reply handler error:', err);
    return response.status(500).json({ error: 'Unexpected error while checking for a reply.', detail: err.message });
  }
}

/**
 * Reads a header value (e.g. "From", "Date") from a Gmail API message object.
 */
function getHeader(message, headerName) {
  const headers = message.payload?.headers || [];
  const found = headers.find(h => h.name.toLowerCase() === headerName.toLowerCase());
  return found?.value || null;
}

/**
 * Extracts a plain-text body from a Gmail API message object. Gmail
 * messages can have nested multipart structures (text/plain,
 * text/html, attachments, etc.) — this walks the parts looking for
 * the first text/plain part, falling back to the top-level body if
 * the message isn't multipart at all.
 */
function extractPlainTextBody(message) {
  const payload = message.payload;
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    const plainPart = findPlainTextPart(payload.parts);
    if (plainPart?.body?.data) {
      return decodeBase64Url(plainPart.body.data);
    }
  }

  // Fallback: top-level body, whatever its type (better than nothing)
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return '(Could not extract message body)';
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
