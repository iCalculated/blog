// Settings saved to the player's account (2026-11-20): Confirm moves, Sound and the board's look follow a
// named account from device to device. This browser's prefs stay the working copy; the server keeps one object per
// account (POST /api/settings; /api/me, /api/login and /api/register bring it back as `settings`). Guests and signed-out
// players sync nothing. What app.js decides is here, so node can test it (scripts/test-prefsync.mjs).
//
// The same account (and, on the same site, the same browser storage) may also hold settings this page no longer has:
// the beta's Engine arrows (2026-11, now no setting: arrows are on wherever the analysis view is). This page never
// reads, applies or changes those: they are carried as they are (OTHER). So is the Board setting (2026-11-22: PTN Ninja
// is the only board): a stored 'board' is never read, and never rewritten or dropped either.
import { confirmOn, soundOf, SOUND_DEFAULT } from './settings.js?v=1795581795';
import { cleanLook } from './ninja-look.js?v=1795581795';

export const SYNCED = ['confirm', 'sound', 'ninja'];
export const DEFAULTS = { confirm: false, sound: SOUND_DEFAULT, ninja: '' };
// Settings no page of this site has any more that may be in this browser's prefs and on the account.
export const OTHER = ['arrows', 'board'];
// The synced settings out of a prefs-shaped object, each read by the same reader the page uses (settings.js), so a
// value from the server is cleaned exactly as one from this browser's storage is: junk reads as the default.
export function syncedOf(p) {
  const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  return { confirm: confirmOn(o), sound: soundOf(o), ninja: cleanLook(o.ninja) };
}
// Keys whose values differ (a and b both syncedOf's shape).
export const diff = (a, b) => SYNCED.filter((k) => a[k] !== b[k]);
const isDefault = (s) => diff(s, DEFAULTS).length === 0;

// What to do when the account's settings arrive (/api/me, a sign-in, a name claimed, the answer to a post):
//   device: syncedOf(this browser's prefs); dirty: the keys changed here that this account hasn't confirmed yet
//   (unsentKeys); server: the answer's `settings` (an object, or null for none stored).
// → { apply: { key: value } to take on here, post: the keys to send (an array; empty: nothing to send), first: the
// account has nothing stored (the post then carries the OTHER settings too, see carried) }.
// Key by key: a change made here and not yet confirmed wins (it is sent again); every other key takes the account's
// value, so a setting changed on another device still arrives while this one's own change is on its way. An account
// with nothing stored gets this device's settings, once, if any isn't the default (else nothing is worth storing yet).
export function decide({ device, dirty = [], server }) {
  const mine = SYNCED.filter((k) => dirty.includes(k));
  if (server == null || typeof server !== 'object' || Array.isArray(server))
    return { apply: {}, post: isDefault(device) && !mine.length ? [] : [...SYNCED], first: true };
  const s = syncedOf(server), apply = {};
  for (const k of diff(device, s)) if (!mine.includes(k)) apply[k] = s[k];
  return { apply, post: mine, first: false };
}
// The post (POST /api/settings): only the keys changed here, which the server lays over what the account holds. So an
// out-of-date tab or device never puts back its old values of the settings it didn't change.
export const changesBody = (device, keys) => ({ changes: Object.fromEntries(SYNCED.filter((k) => keys.includes(k)).map((k) => [k, device[k]])) });
// The OTHER settings as this browser stores them, for the first post to an account with nothing stored: the page that
// has them reads a missing key as its default, so without them that page would take its defaults over this device's
// choices. Only plain values the server takes (true/false or short text) go; anything else stays out, as if unset.
export function carried(prefs) {
  const o = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {}, out = {};
  for (const k of OTHER) if (Object.hasOwn(o, k) && (typeof o[k] === 'boolean' || (typeof o[k] === 'string' && o[k].length <= 40))) out[k] = o[k];
  return out;
}
// The unsent mark, as stored ({ o: the account, as app.js owner()'s hash of its token; k: the keys }): this account's
// keys, or none (another account's mark, or junk, is never read as this one's).
export function unsentKeys(mark, owner) {
  if (!owner || !mark || typeof mark !== 'object' || mark.o !== owner || !Array.isArray(mark.k)) return [];
  return SYNCED.filter((k) => mark.k.includes(k));
}
// The mark to store for this account with these of SYNCED's keys unsent (null: none at all). A key in the mark this
// page doesn't sync (another page's own unsent change) stays in it, for that page to send.
export function withUnsent(mark, owner, keys) {
  const others = mark && typeof mark === 'object' && mark.o === owner && Array.isArray(mark.k)
    ? mark.k.filter((k) => typeof k === 'string' && /^[a-z][A-Za-z0-9]{0,23}$/.test(k) && !SYNCED.includes(k)) : [];
  const k = [...SYNCED.filter((x) => keys.includes(x)), ...new Set(others)];
  return owner && k.length ? { o: owner, k } : null;
}
// After a post the account confirmed: the keys still unsent are those changed again since (sent with another value),
// and any that weren't in it.
export const afterPost = (dirty, sent, device) => SYNCED.filter((k) => dirty.includes(k) && (!Object.hasOwn(sent, k) || sent[k] !== device[k]));
// The Settings page's status line.
//   blocked: site storage is unavailable; named: signed in to a named account; state: 'saved' | 'saving' | 'unsent'.
export function syncStatus({ blocked, named, state }) {
  if (blocked) return "Settings can't be saved in this browser.";
  if (!named) return 'Saved on this device. Claim a username or sign in to keep them on every device.';
  if (state === 'unsent') return 'Could not save to your account. tinue will try again.';
  if (state === 'saving') return 'Saving to your account…';
  return 'Saved to your account.';
}
