// ============================================================
// api/send-email.js
//
// Endpoint: https://growth-hub-ai-api.vercel.app/api/send-email
//
// POST body: { workspaceId, leadId, to, subject, body }
// Response:  { success: true, messageId, threadId }
//
// This is the ONLY endpoint that actually sends an email — it is
// only ever called after the founder has reviewed and approved the
// AI-generated preview in the app (spec Part 4 §2: never send
// without explicit confirmation). This endpoint has no concept of
// "auto-send" and never will; that's enforced by it requiring the
// exact final subject/body as input, not a lead ID it generates
// content for itself.
//
// Flow:
//   1. Look up the workspace's stored Gmail refresh token
//   2. Exchange it for a fresh short-lived access token (refresh
//      tokens can't be used directly to call the Gmail API)
//   3. Build a raw RFC 2822 email message, base64url-encode it
//      (Gmail's API requires this exact format)
//   4. Send via Gmail's API
//   5. Write the sent-email record back onto the lead (spec Part 2
//      §9 Email Collection fields — kept minimal for now, stored
//      directly on the lead rather than a separate `emails`
//      collection until reply-tracking actually needs that split)
//
// Uses the same FIREBASE_SERVICE_ACCOUNT_KEY, GMAIL_CLIENT_ID,
// GMAIL_CLIENT_SECRET env vars as gmail-callback.js — no new
// placeholders introduced by this file.
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
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

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

  const { workspaceId, leadId, to, subject, body } = request.body || {};

  if (!workspaceId || !to || !subject || !body) {
    return response.status(400).json({ error: 'Missing required field(s): workspaceId, to, subject, body' });
  }

  const db = getAdminDb();

  try {
    // Step 1: get the workspace's stored refresh token
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
      // A revoked/expired refresh token is the most likely cause —
      // surface this clearly so the UI can prompt reconnection
      // rather than showing a generic failure.
      return response.status(401).json({ error: 'Gmail connection expired or was revoked. Please reconnect in Settings.' });
    }

    // Step 3: build the raw RFC 2822 message and base64url-encode it
    const rawMessage = buildRawEmail({ to, from: workspace.gmailEmail, subject, body });

    // Step 4: send via Gmail API
    const sendRes = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ raw: rawMessage })
    });
    const sendData = await sendRes.json();

    if (!sendRes.ok) {
      console.error('Gmail send failed:', sendData);
      return response.status(502).json({ error: 'Gmail rejected the send request.', detail: sendData });
    }

    // Step 5: update the lead record, if a leadId was provided.
    // Marks status as Contacted and schedules the same 3-day
    // follow-up the manual "Contacted" button applies (leadDetail.js)
    // — sending an email is equivalent to manually marking Contacted,
    // so both paths should produce the same resulting lead state.
    if (leadId) {
      const leadRef = db.collection('workspaces').doc(workspaceId).collection('leads').doc(leadId);
      const leadSnap = await leadRef.get();
      const currentEmailCount = leadSnap.data()?.emailCount || 0; // bug fix: was reading workspace.emailCount, which doesn't exist — always reset to 1 instead of incrementing

      const followUpDate = new Date();
      followUpDate.setDate(followUpDate.getDate() + 3);

      await leadRef.update({
        status: 'Contacted',
        nextAction: 'Waiting for Reply',
        lastContacted: new Date().toISOString(),
        followUpDate: followUpDate.toISOString(),
        messageId: sendData.id,
        threadId: sendData.threadId,
        emailCount: currentEmailCount + 1,
        // Stored so a later follow-up can reference the actual sent
        // content (promptManager.js's followUp template requires
        // this as input) — without it, follow-ups would have nothing
        // real to "follow up on."
        lastEmailSubject: subject,
        lastEmailBody: body,
        // Which connected Gmail account sent this — matters if the
        // workspace ever switches accounts (Settings > Disconnect >
        // Connect a different one). A reply arrives in whichever
        // account sent the original message, so knowing this per
        // lead avoids confusion about which inbox to check.
        sentFromEmail: workspace.gmailEmail || null,
        updatedAt: new Date().toISOString()
      });
    }

    return response.status(200).json({
      success: true,
      messageId: sendData.id,
      threadId: sendData.threadId
    });

  } catch (err) {
    console.error('send-email handler error:', err);
    return response.status(500).json({ error: 'Unexpected error while sending.', detail: err.message });
  }
}

/**
 * Builds a minimal RFC 2822 email and base64url-encodes it, as
 * required by Gmail's API `raw` field format.
 */
function buildRawEmail({ to, from, subject, body }) {
  const message = [
    `To: ${to}`,
    from ? `From: ${from}` : '',
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body
  ].filter(Boolean).join('\r\n');

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
