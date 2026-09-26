/**
 * Multi-account registry.
 *
 * The HYROS MCP is stateless and authenticates every call with an API key, so
 * an "account" here is a key plus the label we learned from it. Keys are
 * encrypted at rest (AES-256-GCM under ACCOUNT_KEY_SECRET) and never leave
 * the server: the browser only ever sees ids and labels.
 *
 * Every account lives in the registry (added from the dashboard). The legacy
 * id "env" (a HYROS_API_KEY from the environment) is no longer an account;
 * requests naming it fall to the default account.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { callTool, runWithKey } from './_mcp.js';
import { readAccounts, writeAccounts, deleteAccountData, readSnapshot, storeConfigured, PRIMARY_ID } from './_store.js';
import { keySecrets } from './_setup.js';
import { logEvent } from './_log.js';
import { deleteAccountCalls } from './_calls.js';
import { deleteAccountPay } from './_paylinks.js';

export { PRIMARY_ID };

/**
 * Encryption secret: ACCOUNT_KEY_SECRET from the env, else the one generated
 * on first load (KV, see _setup.js). Both are tried on decrypt so moving the
 * secret into Vercel never locks a stored key out.
 */
function secret() {
  return keySecrets()[0] || null;
}

export function accountsEnabled() {
  return storeConfigured() && Boolean(secret());
}

export function encryptKey(apiKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret(), iv);
  const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptKey(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((b) => Buffer.from(b, 'base64'));
  let lastErr = null;
  for (const key of keySecrets()) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch (err) { lastErr = err; }
  }
  throw Object.assign(new Error('Stored API key cannot be decrypted — ACCOUNT_KEY_SECRET changed since it was added. Replace the key.'), { status: 409, code: 'secret_mismatch', cause: lastErr });
}

export const accountIdFor = (apiKey) => `acc_${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;

const CLIENT_BATCH = 5;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

/** Public shape — no key material. */
function publicAccount(a) {
  return {
    id: a.id, kind: a.kind || 'key', label: a.label, email: a.email || null, company: a.company || null,
    addedAt: a.addedAt || null, primary: a.id === PRIMARY_ID,
    agency: Boolean(a.agency), parentId: a.parentId || null, status: a.status || 'APPROVED',
    keyStatus: a.keyStatus || 'ok', keyError: a.keyError || null,
    clientMode: a.clientMode || null, clientModeStatus: a.clientModeStatus || null,
    clientsSyncedAt: a.clientsSyncedAt || null, lastError: a.lastError || null,
  };
}

/** Every account the dashboard can show: the registry. */
export async function listAccounts({ withStatus = false } = {}) {
  const out = [];
  if (storeConfigured()) for (const a of await readAccounts()) out.push(publicAccount(a));
  // A client inherits its agency's key health.
  const byId = new Map(out.map((a) => [a.id, a]));
  for (const a of out) if (a.parentId && byId.get(a.parentId)?.keyStatus === 'invalid') { a.keyStatus = 'invalid'; a.keyError = byId.get(a.parentId).keyError; }
  if (withStatus) {
    for (const a of out) {
      const snap = await readSnapshot(a.id);
      a.lastRefresh = snap?.generatedAt || null;
      if (snap?.account?.email) { a.email = a.email || snap.account.email; if (a.primary) a.label = snap.account.email; }
    }
  }
  return out;
}

/** Validate a key against the MCP and learn the account label + agency clients from it. */
export async function probeKey(apiKey, extra = {}) {
  const started = Date.now();
  let user;
  try {
    user = await runWithKey(apiKey, () => callTool('hyros_get_user_info', {}, { timeoutMs: 15000 }), extra);
  } catch (err) {
    // Setup / import / sync failures leave a trace (codes and timings only, never the key).
    logEvent('probe.failed', { code: err.code || err.name || 'error', message: err.message, client: extra.accessibleAccountId || null, mode: extra.clientMode || null, ms: Date.now() - started });
    throw err;
  }
  const p = user?.userProfile || {};
  const clients = (Array.isArray(user?.accessibleAccounts) ? user.accessibleAccounts : []).map((c) => ({
    accountId: c.accountId ? String(c.accountId) : null, email: c.email || null, company: c.companyName || null,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null, status: c.status || 'UNKNOWN',
  })).filter((c) => c.accountId);
  return { email: p.email || null, company: p.companyName || null, name: [p.firstName, p.lastName].filter(Boolean).join(' ') || null, clients };
}

/**
 * Does the MCP honor accessible_account_id — and how? Decisive test: ask for
 * user info AS the client; if the email comes back as the client's (not the
 * agency's) the mode works. Tries the argument form, then the header form.
 */
export async function detectClientMode(apiKey, client, agencyEmail) {
  let lastError = null;
  for (const mode of ['arg', 'header']) {
    try {
      const info = await probeKey(apiKey, { accessibleAccountId: client.accountId, clientMode: mode });
      if (info.email && info.email !== agencyEmail) return { mode, status: 'verified', email: info.email };
      lastError = `mode ${mode}: MCP ignored accessible_account_id (returned the agency profile)`;
    } catch (err) { lastError = `mode ${mode}: ${err.message}`; }
  }
  return { mode: null, status: 'unsupported', error: lastError };
}

async function saveAccounts(accounts) {
  if (!(await writeAccounts(accounts))) throw new Error('Could not save accounts (KV write failed).');
}

export async function addAccount(apiKey, { agency = false } = {}) {
  const key = String(apiKey || '').trim();
  if (key.length < 8) throw fail('That does not look like a HYROS API key.', 400);
  const id = accountIdFor(key);
  const info = await probeKey(key); // throws McpError on a bad key
  const accounts = await readAccounts();
  const label = info.email || info.company || id;
  const entry = {
    id, kind: 'key', label, email: info.email, company: info.company, addedAt: new Date().toISOString(),
    keyEnc: encryptKey(key), agency: agency || info.clients.length > 0, keyStatus: 'ok',
  };
  await saveAccounts([...accounts.filter((a) => a.id !== id), entry]);
  return { account: publicAccount(entry), clientsFound: info.clients.length, clientsApproved: info.clients.filter((c) => c.status === 'APPROVED').length };
}

const clientIdFor = (agencyId, accountId) => `cli_${createHash('sha256').update(`${agencyId}:${accountId}`).digest('hex').slice(0, 12)}`;

/**
 * Register an agency's client accounts, CLIENT_BATCH per call so a 40-client
 * agency never hammers the MCP in one request. The first batch also detects
 * (and records on the agency) how accessible_account_id must be sent; if the
 * MCP does not honor it, clients are still listed — marked unsupported — so
 * the UI can say exactly why they cannot load yet.
 */
export async function importClients(agencyId, { offset = 0 } = {}) {
  const accounts = await readAccounts();
  const agency = accounts.find((a) => a.id === agencyId && a.kind !== 'client');
  if (!agency) throw fail(`Unknown agency account "${agencyId}".`, 404);
  const apiKey = decryptKey(agency.keyEnc);
  const info = await probeKey(apiKey);
  const clients = info.clients.filter((c) => c.status === 'APPROVED');
  const batch = clients.slice(offset, offset + CLIENT_BATCH);

  if (offset === 0 && batch.length) {
    const det = await detectClientMode(apiKey, batch[0], info.email);
    agency.clientMode = det.mode; agency.clientModeStatus = det.status; agency.clientModeError = det.error || null;
  }
  agency.agency = true;
  agency.clientsSyncedAt = new Date().toISOString();
  agency.clientCount = clients.length;

  let added = 0;
  for (const c of batch) {
    const id = clientIdFor(agency.id, c.accountId);
    const existing = accounts.find((a) => a.id === id);
    const entry = {
      id, kind: 'client', parentId: agency.id, clientAccountId: c.accountId,
      label: c.company || c.email || c.name || c.accountId, email: c.email, company: c.company,
      status: c.status, addedAt: existing?.addedAt || new Date().toISOString(),
    };
    if (existing) Object.assign(existing, entry); else { accounts.push(entry); added += 1; }
  }
  await saveAccounts(accounts);
  return {
    added, batch: batch.length, total: clients.length, offset: offset + batch.length,
    remaining: Math.max(0, clients.length - offset - batch.length),
    pending: info.clients.length - clients.length,
    clientMode: agency.clientMode, clientModeStatus: agency.clientModeStatus, clientModeError: agency.clientModeError || null,
  };
}

/** Re-read an agency's client list: add new clients, mark vanished ones REVOKED. */
export async function syncClients(agencyId) {
  const accounts = await readAccounts();
  const agency = accounts.find((a) => a.id === agencyId && a.agency);
  if (!agency) return null;
  let info;
  try { info = await probeKey(decryptKey(agency.keyEnc)); }
  catch (err) {
    logEvent('sync.failed', { accountId: agencyId, code: err.code || err.name || 'error', message: err.message });
    // Only a rejected key (401) invalidates the agency; a 403 is a refresh error, not a bad key.
    if (err.code === 'auth') await markKeyStatus(agencyId, 'invalid', err.message);
    throw err;
  }
  const seen = new Set();
  let added = 0;
  for (const c of info.clients) {
    const id = clientIdFor(agency.id, c.accountId);
    seen.add(id);
    const existing = accounts.find((a) => a.id === id);
    if (existing) { existing.status = c.status; existing.label = c.company || c.email || existing.label; }
    else if (c.status === 'APPROVED') { accounts.push({ id, kind: 'client', parentId: agency.id, clientAccountId: c.accountId, label: c.company || c.email || c.accountId, email: c.email, company: c.company, status: c.status, addedAt: new Date().toISOString() }); added += 1; }
  }
  for (const a of accounts) if (a.kind === 'client' && a.parentId === agency.id && !seen.has(a.id)) a.status = 'REVOKED';
  agency.clientsSyncedAt = new Date().toISOString();
  agency.keyStatus = 'ok'; agency.keyError = null;
  await saveAccounts(accounts);
  return { added, total: info.clients.length };
}

/** Record whether an account's key works (an agency's status covers its clients). */
export async function markKeyStatus(id, status, error = null) {
  const accounts = await readAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  const target = a.kind === 'client' ? accounts.find((x) => x.id === a.parentId) : a;
  if (!target) return;
  target.keyStatus = status; target.keyError = status === 'ok' ? null : (error || null);
  await saveAccounts(accounts);
}

/** Note the outcome of a refresh so the selector can show it. */
export async function noteRefresh(id, ok, error = null) {
  const accounts = await readAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  a.lastError = ok ? null : (error || 'refresh failed');
  a.lastAttemptAt = new Date().toISOString();
  await saveAccounts(accounts);
}

/** Swap the key behind an existing account (rotation / invalid key). */
export async function replaceKey(id, apiKey) {
  const key = String(apiKey || '').trim();
  if (key.length < 8) throw fail('That does not look like a HYROS API key.', 400);
  const accounts = await readAccounts();
  const a = accounts.find((x) => x.id === id && x.kind !== 'client');
  if (!a) throw fail(`Unknown account "${id}".`, 404);
  const info = await probeKey(key);
  if (a.email && info.email && a.email.toLowerCase() !== info.email.toLowerCase()) {
    throw fail(`That key belongs to ${info.email}, not ${a.email}. Add it as a separate account instead.`, 409);
  }
  a.keyEnc = encryptKey(key); a.keyStatus = 'ok'; a.keyError = null; a.email = a.email || info.email;
  await saveAccounts(accounts);
  return publicAccount(a);
}

export async function removeAccount(id) {
  const accounts = await readAccounts();
  if (!accounts.some((a) => a.id === id)) return false;
  // Removing an agency removes its clients too.
  const gone = accounts.filter((a) => a.id === id || a.parentId === id).map((a) => a.id);
  await saveAccounts(accounts.filter((a) => !gone.includes(a.id)));
  for (const g of gone) { await deleteAccountData(g); await deleteAccountCalls(g); await deleteAccountPay(g); }
  return true;
}

/** Resolve an account id to how to call the MCP as it. */
export async function resolveAccount(id) {
  if (!id || id === PRIMARY_ID) return null;
  const accounts = await readAccounts();
  const a = accounts.find((x) => x.id === id);
  if (!a) return null;
  if (a.kind === 'client') {
    const agency = accounts.find((x) => x.id === a.parentId);
    if (!agency) throw fail('This client\u2019s agency account was removed.', 409, 'orphan');
    if (agency.keyStatus === 'invalid') throw fail(`The agency key for ${agency.label} is invalid — replace it to load this client.`, 409, 'key_invalid');
    if (a.status !== 'APPROVED') throw fail(`Client access is ${String(a.status).toLowerCase()} — HYROS must approve it first.`, 409, 'not_approved');
    if (agency.clientModeStatus === 'unsupported') throw fail('The HYROS MCP does not honor accessible_account_id yet, so client accounts cannot be read through the agency key.', 409, 'unsupported');
    return { apiKey: decryptKey(agency.keyEnc), accessibleAccountId: a.clientAccountId, clientMode: agency.clientMode || 'arg', agencyId: agency.id };
  }
  if (a.keyStatus === 'invalid') throw fail(`The key for ${a.label} is invalid — replace it.`, 409, 'key_invalid');
  return { apiKey: decryptKey(a.keyEnc) };
}

export async function resolveKey(id) {
  const r = await resolveAccount(id);
  return r?.apiKey || null;
}

/** Run fn as the given account; throws 404-ish when the id is unknown. */
export async function asAccount(id, fn) {
  const r = await resolveAccount(id);
  if (!r) throw fail(`Unknown account "${id}".`, 404);
  const { apiKey, ...extra } = r;
  return runWithKey(apiKey, fn, extra);
}

/**
 * The account shown when none is asked for: the first usable account in the
 * registry, else null (nothing connected yet — the dashboard opens on the
 * Demo account).
 */
export async function defaultAccountId() {
  if (!storeConfigured()) return null;
  const tops = (await readAccounts()).filter((a) => a.kind !== 'client');
  return (tops.find((a) => a.keyStatus !== 'invalid') || tops[0])?.id || null;
}

const ID_SHAPE = /^(acc_[0-9a-f]{12}|cli_[0-9a-f]{12})$/;

/** Account id from a request (?account=), else the default; null when nothing is connected. */
export async function accountFromReq(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const id = url.searchParams.get('account') || '';
  if (ID_SHAPE.test(id)) return id;
  return defaultAccountId();
}
