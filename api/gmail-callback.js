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
// Flow:
//   1. Read `code` + `state` (workspaceId) from the query string
//   2. Exchange `code` for tokens at Google's token endpoint
//      (this exchange MUST happen server-side — the refresh token
//      it returns is long-lived and must never reach the browser)
//   3. Use the access token to fetch the connected Gmail address
//   4. Write refreshToken + email + gmailConnected=true onto
//      workspaces/{workspaceId} via Firebase Admin
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

    // Step 3: store the refresh token on the workspace doc
    const db = getAdminDb();
    await db.collection('workspaces').doc(workspaceId).update({
      gmailConnected: true,
      gmailEmail: userInfo.email || null,
      gmailRefreshToken: tokenData.refresh_token,
      gmailConnectedAt: new Date().toISOString()
    });

    return response.redirect(302, `${appUrl}?gmail=connected`);

  } catch (err) {
    console.error('gmail-callback error:', err);
    return response.redirect(302, `${appUrl}?gmail=error&reason=exchange_failed`);
  }
}
