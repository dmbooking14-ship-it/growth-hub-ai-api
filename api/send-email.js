// ============================================================
// api/send-email.js
//
// Endpoint: https://growth-hub-ai-api.vercel.app/api/send-email
//
// POST body: { workspaceId, leadId, to, subject, body, threadId?, inReplyTo?, accountId? }
// Response:  { success: true, messageId, threadId, sentFromEmail, sentFromAccountId }
//
// MULTI-ACCOUNT UPDATE: `accountId` is OPTIONAL — omitting it falls
// back to the workspace's default/only connected account (see
// _gmailAccounts.js's resolveGmailAccount), so any existing caller
// that hasn't been updated yet keeps working exactly as before.
// When provided, that SPECIFIC account's token is used, and its
// email is what gets recorded as sentFromEmail on the lead — this
// is how the founder's account choice (single-lead picker, or the
// bulk auto-router) actually takes effect.
//
// DAILY CAP ENFORCEMENT lives here, not just in the frontend's
// pre-send planning — the frontend decides which account SHOULD
// send each message in a batch, but this endpoint is the last line
// of defense against actually exceeding a cap, since it's the one
// place that can't be raced or skipped by a bug elsewhere. If the
// resolved account is already at/over its dailyCap, the send is
// refused with a specific error code the frontend's batch
// orchestrator watches for, so it can fall through to the next
// account rather than just failing that lead outright.
//
// threadId/inReplyTo are OPTIONAL and only used for in-app replies
// (leadDetail.js's Reply button, after Check for Reply finds a
// message) — when present, Gmail's `threadId` field is included in
// the send request AND the raw message gets In-Reply-To/References
// headers set to inReplyTo (the original message's Message-ID
// header, from check-reply.js's response). Both are required
// together for Gmail to actually thread the message correctly —
// threadId alone is not sufficient. Omitting both (the normal
// first-contact/follow-up case) sends a new, unthreaded message
// exactly as before — this is fully backward compatible.
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
//   1. Resolve which Gmail account to send from (accountId, or the
//      workspace's default) and check it against its daily cap
//   2. Exchange its refresh token for a fresh short-lived access
//      token (refresh tokens can't be used directly to call the
//      Gmail API)
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
import { resolveGmailAccount, getAccessToken, countSentInLast24h } from './_gmailAccounts.js';

function getAdminDb() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

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

  const { workspaceId, leadId, to, subject, body, threadId, inReplyTo, accountId } = request.body || {};

  if (!workspaceId || !to || !subject || !body) {
    return response.status(400).json({ error: 'Missing required field(s): workspaceId, to, subject, body' });
  }

  const db = getAdminDb();

  try {
    // Step 1: resolve which account to send from
    const workspaceSnap = await db.collection('workspaces').doc(workspaceId).get();
    const workspace = workspaceSnap.data();

    if (!workspace) {
      return response.status(404).json({ error: 'Workspace not found.' });
    }

    const account = resolveGmailAccount(workspace, accountId);

    if (!account || !account.refreshToken) {
      return response.status(400).json({ error: 'Gmail is not connected for this workspace. Connect it in Settings first.' });
    }

    // Daily cap check — last line of defense. The frontend's batch
    // planner should already be routing around a full account, but
    // this check exists so the cap is enforced even if that
    // planning logic has a bug, is bypassed, or the batch spans
    // more than 24h and an account "refills" mid-batch (in which
    // case this correctly allows sending again, since it's a live
    // check, not a cached count from when the batch started).
    const sentToday = await countSentInLast24h(db, workspaceId, account.id, account.email);
    const cap = account.dailyCap || 50;
    if (sentToday >= cap) {
      // Specific error code (not just a message) so the frontend's
      // bulk orchestrator can reliably detect "this account is
      // full, try the next one" versus a real failure worth
      // reporting as failed rather than retried elsewhere.
      return response.status(429).json({
        error: `This account (${account.email}) has reached its daily limit of ${cap} emails.`,
        code: 'DAILY_CAP_REACHED',
        accountId: account.id,
        sentToday,
        dailyCap: cap
      });
    }

    // Step 2: exchange refresh token for a fresh access token
    let accessToken;
    try {
      accessToken = await getAccessToken(account.refreshToken);
    } catch (err) {
      return response.status(401).json({ error: err.message, accountId: account.id });
    }

    // Step 3: build the raw RFC 2822 message and base64url-encode it
    const rawMessage = buildRawEmail({ to, from: account.email, subject, body, inReplyTo });

    // Step 4: send via Gmail API — threadId is included ONLY when
    // replying to an existing thread; Gmail creates a new thread
    // automatically when it's omitted, exactly as before.
    const sendPayload = { raw: rawMessage };
    if (threadId) sendPayload.threadId = threadId;

    const sendRes = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sendPayload)
    });
    const sendData = await sendRes.json();

    if (!sendRes.ok) {
      console.error('Gmail send failed:', sendData);
      return response.status(502).json({ error: 'Gmail rejected the send request.', detail: sendData, accountId: account.id });
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

      // A threaded reply (inReplyTo set) means the founder is
      // responding to a lead who already replied — that's a
      // different situation from cold outreach or a follow-up, and
      // should NOT reset status back to "Contacted" or schedule a
      // fresh 3-day follow-up as if this were a first message. The
      // lead stays wherever its status already reflects (e.g.
      // "Replied") and just gets its content/count fields updated.
      const updates = {
        messageId: sendData.id,
        threadId: sendData.threadId,
        emailCount: currentEmailCount + 1,
        // Stored so a later follow-up can reference the actual sent
        // content (promptManager.js's followUp template requires
        // this as input) — without it, follow-ups would have nothing
        // real to "follow up on."
        lastEmailSubject: subject,
        lastEmailBody: body,
        // Which connected Gmail account sent this — matters now that
        // a workspace can have several. A reply arrives in whichever
        // account sent the original message, so knowing this per
        // lead avoids confusion about which inbox to check.
        // sentFromAccountId is the new, stable identifier (survives
        // an account being renamed/reconnected under the same
        // email); sentFromEmail is kept alongside it since it's a
        // human-readable field already shown directly on Lead
        // Detail with no lookup needed.
        sentFromEmail: account.email || null,
        sentFromAccountId: account.id || null,
        updatedAt: new Date().toISOString()
      };

      if (!inReplyTo) {
        // Normal cold-outreach or follow-up send — same behavior as
        // before this change, unaffected. Cadence now comes from
        // workspace.followUpCadenceDays (Settings screen), defaulting
        // to 3 for any workspace created before that field existed.
        const cadenceDays = typeof workspace.followUpCadenceDays === 'number' && workspace.followUpCadenceDays > 0
          ? workspace.followUpCadenceDays
          : 3;
        const followUpDate = new Date();
        followUpDate.setDate(followUpDate.getDate() + cadenceDays);
        updates.status = 'Contacted';
        updates.nextAction = 'Waiting for Reply';
        updates.lastContacted = new Date().toISOString();
        updates.followUpDate = followUpDate.toISOString();
      } else {
        updates.lastContacted = new Date().toISOString();
        updates.nextAction = 'Waiting for Reply';
      }

      await leadRef.update(updates);
    }

    return response.status(200).json({
      success: true,
      messageId: sendData.id,
      threadId: sendData.threadId,
      sentFromEmail: account.email || null,
      sentFromAccountId: account.id || null
    });

  } catch (err) {
    console.error('send-email handler error:', err);
    return response.status(500).json({ error: 'Unexpected error while sending.', detail: err.message });
  }
}

/**
 * Builds a minimal RFC 2822 email and base64url-encodes it, as
 * required by Gmail's API `raw` field format.
 *
 * When inReplyTo is provided (the original message's Message-ID
 * header, e.g. "<abc123@mail.gmail.com>"), In-Reply-To and
 * References headers are added — these, together with the
 * `threadId` passed separately in the send request, are what make
 * Gmail (and the recipient's mail client) treat this as a genuine
 * reply within the existing conversation rather than a new,
 * disconnected message.
 */
function buildRawEmail({ to, from, subject, body, inReplyTo }) {
  const message = [
    `To: ${to}`,
    from ? `From: ${from}` : '',
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    inReplyTo ? `References: ${inReplyTo}` : '',
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
