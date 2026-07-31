// ============================================================
// api/gmail-callback.js
//
// Endpoint: https://growth-hub-ai-api.vercel.app/api/gmail-callback
//
// This is the REDIRECT URI Google sends the user back to after
// they approve (or deny) Gmail access in the consent popup. Google
// appends `code` (a short-lived auth code) and `state` (whatever
// we originally passed when starting the flow — we use this to
// carry the workspaceId, since OAuth redirects carry no other
// session context).
//
// MULTI-ACCOUNT UPDATE: this workspace can now have several
// connected Gmail accounts (Settings > Connected Accounts), stored
// as workspace.gmailAccounts (array), NOT the old single
// gmailRefreshToken/gmailEmail flat fields. Each element is:
//   { id, email, refreshToken, connectedAt, dailyCap, isDefault }
//
// `dailyCap` is intentionally NOT set here — this endpoint has no
// way to show the account-age-tier picker (Google's OAuth consent
// screen is Google's UI, not ours). It's written with a temporary
// placeholder cap and the app prompts for the real one immediately
// on return (see main.js's gmail=connected handling), same
// principle as the old flow already used for the success toast.
//
// BACKWARD COMPATIBILITY: workspaces created before this change
// have gmailRefreshToken/gmailEmail as flat fields with no
// gmailAccounts array yet. This endpoint does NOT migrate those on
// its own — connecting a NEW account here always appends to
// gmailAccounts going forward. The one-time migration of an
// existing single connection into gmailAccounts[0] happens
// client-side on next app load (src/services/gmailAccounts.js),
// since that's pure data reshaping with no OAuth involved and
// doesn't need a server round-trip.
//
// Flow:
//   1. Read `code` + `state` (workspaceId) from the query string
//   2. Exchange `code` for tokens at Google's token endpoint
//      (this exchange MUST happen server-side — the refresh token
//      it returns is long-lived and must never reach the browser)
//   3. Use the access token to fetch the connected Gmail address
//   4. Append a new entry to workspaces/{workspaceId}.gmailAccounts
//      via Firebase Admin (or update the existing entry's token, if
//      this exact email was already connected — see "reconnect"
//      case below)
//   5. Redirect the user back into the app with a simple success/
//      failure indicator in the URL (the app itself never sees the
//      tokens — only Firestore does)
//
// >>> PLACEHOLDERS TO REPLACE (Vercel env vars, not in this file) <<<
//   GMAIL_CLIENT_ID
//   GMAIL_CLIENT_SECRET
//   GMAIL_REDIRECT_URI          (must exactly match what's registered
//                                 in Google Cloud Console)
//   FIREBASE_SERVICE_ACCOUNT_KEY (full JSON, as a single-line string)
//   APP_URL                      (your Firebase Hosting URL, where we
//                                 redirect the user back to when done)
// ============================================================

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';

// Firebase Admin must only be initialized once per serverless
// instance — guard against re-initializing on warm invocations.
function getAdminDb() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// Placeholder used until the app's post-connect age-tier prompt
// sets a real value. Deliberately LOW (not a generous default) —
// if a founder somehow sends before setting the real cap (e.g.
// closes the tab immediately after connecting), better to
// under-send than risk a fresh account's reputation.
const PENDING_DAILY_CAP = 10;

export default async function handler(request, response) {
  const { code, state, error: oauthError } = request.query;
  const appUrl = process.env.APP_URL || '/';

  // User denied access, or Google sent an error back
  if (oauthError) {
    return response.redirect(302, `${appUrl}?gmail=denied`);
  }

  const workspaceId = state;
  if (!code || !workspaceId) {
    return response.redirect(302, `${appUrl}?gmail=error&reason=missing_code_or_state`);
  }

  try {
    // Step 1: exchange the auth code for tokens
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GMAIL_CLIENT_ID,
        client_secret: process.env.GMAIL_CLIENT_SECRET,
        redirect_uri: process.env.GMAIL_REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.refresh_token) {
      // Common cause: user had already connected before and Google
      // only issues a refresh_token on the FIRST consent. If this
      // happens on a reconnect attempt, the fix is to force
      // re-consent (prompt=consent) on the frontend's auth URL,
      // which gmailAuthUrl-building code should already include.
      console.error('Token exchange failed or no refresh_token:', tokenData);
      return response.redirect(302, `${appUrl}?gmail=error&reason=no_refresh_token`);
    }

    // Step 2: find out which Gmail address was actually connected
    const userInfoRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userInfo = await userInfoRes.json();

    if (!userInfoRes.ok || !userInfo.email) {
      // Bug history: this previously failed silently and stored
      // gmailEmail: null, which broke check-reply.js's sender
      // comparison in a way that was hard to diagnose (see that
      // file's fix notes). Logging loudly now so this is caught
      // immediately in Vercel logs if it ever happens again — most
      // likely cause is the OAuth consent not including the email
      // scope (see gmailService.js's GMAIL_SCOPES).
      console.error('userinfo fetch failed or returned no email:', userInfo);
    }

    const connectedEmail = userInfo.email || null;

    // Step 3: append to (or refresh a token within) gmailAccounts.
    // Firestore Admin has no atomic "upsert into array by field"
    // operation, so this is a read-modify-write — acceptable here
    // since OAuth callbacks for the same workspace are inherently
    // rare/sequential (a human clicking through a consent screen),
    // not a high-concurrency path.
    const db = getAdminDb();
    const workspaceRef = db.collection('workspaces').doc(workspaceId);
    const workspaceSnap = await workspaceRef.get();
    const workspace = workspaceSnap.data() || {};
    const existingAccounts = Array.isArray(workspace.gmailAccounts) ? workspace.gmailAccounts : [];

    // Reconnect case: this exact email is already in the list (e.g.
    // its refresh token was revoked and the founder is re-approving
    // it) — update that entry's token in place rather than create a
    // duplicate. Everything else about that account (dailyCap,
    // sentToday history, isDefault) is preserved.
    const existingIndex = connectedEmail
      ? existingAccounts.findIndex(acc => acc.email?.toLowerCase() === connectedEmail.toLowerCase())
      : -1;

    let newAccountId = null;

    if (existingIndex >= 0) {
      existingAccounts[existingIndex] = {
        ...existingAccounts[existingIndex],
        refreshToken: tokenData.refresh_token,
        reconnectedAt: new Date().toISOString()
      };
    } else {
      newAccountId = randomUUID();
      existingAccounts.push({
        id: newAccountId,
        email: connectedEmail,
        refreshToken: tokenData.refresh_token,
        connectedAt: new Date().toISOString(),
        dailyCap: PENDING_DAILY_CAP,
        capPending: true, // cleared once the app's age-tier prompt sets a real cap
        isDefault: existingAccounts.length === 0 // first account connected becomes default automatically
      });
    }

    // Also keep the old flat fields in sync, pointing at the FIRST/
    // default account — some older code paths (or a workspace that
    // hasn't loaded the migration yet) may still read
    // gmailEmail/gmailRefreshToken directly. This is a transitional
    // safety net, not the source of truth going forward.
    const defaultAccount = existingAccounts.find(acc => acc.isDefault) || existingAccounts[0];

    await workspaceRef.update({
      gmailConnected: true,
      gmailAccounts: existingAccounts,
      gmailEmail: defaultAccount?.email || null,
      gmailRefreshToken: defaultAccount?.refreshToken || null
    });

    // Tell the app which account (if newly created) needs its
    // age-tier cap set — carried through the redirect since this
    // serverless function has no other way to hand data back.
    const suffix = newAccountId ? `&accountId=${newAccountId}` : '';
    return response.redirect(302, `${appUrl}?gmail=connected${suffix}`);

  } catch (err) {
    console.error('gmail-callback error:', err);
    return response.redirect(302, `${appUrl}?gmail=error&reason=exchange_failed`);
  }
}
