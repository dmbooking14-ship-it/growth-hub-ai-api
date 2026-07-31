// ============================================================
// api/_gmailAccounts.js
//
// Shared helper used by send-email.js and check-reply.js (and any
// future endpoint that needs "the right Gmail account's token").
// NOT itself an API route (underscore prefix — Vercel won't deploy
// this as an endpoint) — same convention as aiManager.js/
// promptManager.js being internal modules used BY routes.
//
// Centralizes:
//   - looking up one specific connected account by id (or falling
//     back to the default account when no id is given, for
//     backward compatibility with any caller not yet passing one)
//   - refreshing that account's access token
//   - checking/recording daily send capacity, computed from actual
//     send timestamps rather than a counter that needs a scheduled
//     reset job (Vercel has no built-in cron here) — "sent in the
//     last rolling 24h" is recomputed on demand each time, which is
//     also more correct: Gmail's own limit is a rolling window, not
//     a midnight reset, so this mirrors real Gmail behavior exactly
//     rather than approximating it.
// ============================================================

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Finds a specific Gmail account on a workspace doc's gmailAccounts
 * array. Falls back to the flat gmailEmail/gmailRefreshToken fields
 * (pre-multi-account workspaces, or a caller that hasn't been
 * updated to pass accountId yet) when gmailAccounts is missing/empty
 * or accountId isn't given.
 *
 * @param {object} workspace - workspace doc data (NOT the ref)
 * @param {string} [accountId]
 * @returns {{ id: string|null, email: string|null, refreshToken: string|null, dailyCap: number } | null}
 */
export function resolveGmailAccount(workspace, accountId) {
  const accounts = Array.isArray(workspace.gmailAccounts) ? workspace.gmailAccounts : [];

  if (accountId) {
    const found = accounts.find(acc => acc.id === accountId);
    if (found) return found;
    // An accountId was explicitly requested but doesn't exist —
    // this is a real error, not a case to silently fall back on,
    // since silently using a DIFFERENT account than the one the
    // founder picked would send from the wrong inbox.
    return null;
  }

  // No accountId given — legacy caller or single-account workspace.
  // Prefer an explicit isDefault account if gmailAccounts exists...
  if (accounts.length > 0) {
    return accounts.find(acc => acc.isDefault) || accounts[0];
  }

  // ...otherwise fall all the way back to the old flat fields, for
  // a workspace that hasn't gone through the client-side migration
  // yet (see gmailAccounts.js's migrateSingleAccountIfNeeded).
  if (workspace.gmailRefreshToken) {
    return {
      id: null,
      email: workspace.gmailEmail || null,
      refreshToken: workspace.gmailRefreshToken,
      dailyCap: workspace.dailyLimit || 50
    };
  }

  return null;
}

/**
 * Exchanges a refresh token for a fresh access token. Throws with a
 * message suitable for direct use in an API error response — every
 * caller of this function is already inside a try/catch that
 * returns err.message to the client.
 */
export async function getAccessToken(refreshToken) {
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    console.error('Access token refresh failed:', tokenData);
    throw new Error('Gmail connection expired or was revoked. Please reconnect in Settings.');
  }

  return tokenData.access_token;
}

/**
 * Counts how many emails a specific account has sent in the
 * trailing 24 hours, by querying the leads collection for
 * sentFromAccountId matches with a recent lastContacted/sentAt.
 *
 * Deliberately NOT a stored/incremented counter on the account
 * object — a counter needs a reset mechanism (cron), and this
 * project has none. Recomputing from real send records is slightly
 * more expensive per check but requires no scheduled job, can never
 * drift from reality, and matches Gmail's own rolling-window
 * behavior rather than a fixed midnight reset.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} workspaceId
 * @param {string|null} accountId - null means "the legacy single account", matched by sentFromEmail instead
 * @param {string|null} accountEmail
 * @returns {Promise<number>}
 */
export async function countSentInLast24h(db, workspaceId, accountId, accountEmail) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // sentFromAccountId is the field going forward (see send-email.js);
  // sentFromEmail is the older field, kept as a fallback match for
  // any lead sent before this field existed, so a workspace's
  // existing send history still counts toward today's cap correctly
  // rather than starting back at zero.
  let query = db.collection('workspaces').doc(workspaceId).collection('leads')
    .where('lastContacted', '>=', since);

  const snap = await query.get();
  let count = 0;
  snap.forEach(doc => {
    const lead = doc.data();
    if (accountId && lead.sentFromAccountId === accountId) count++;
    else if (!accountId && accountEmail && lead.sentFromEmail === accountEmail) count++;
  });
  return count;
}
