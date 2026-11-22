// Settings saved to the player's account (2026-11-20): the board, Confirm moves, Engine arrows, Sound and the PTN Ninja
// look follow a named account from device to device. This browser's prefs stay the working copy; the server keeps one
// object per account (POST /api/settings; /api/me, /api/login and /api/register bring it back as `settings`). Guests and
// signed-out players sync nothing. What app.js decides is here, so node can test it (scripts/test-prefsync.mjs).
import { boardFrom, confirmOn, arrowsOn, soundOf, SOUND_DEFAULT } from './settings.js?v=1795314232';
import { cleanLook } from './ninja-look.js?v=1795314232';

export const SYNCED = ['board', 'confirm', 'arrows', 'sound', 'ninja'];
export const DEFAULTS = { board: 'tinue', confirm: false, arrows: true, sound: SOUND_DEFAULT, ninja: '' };
// The synced settings out of a prefs-shaped object, each read by the same reader the page uses (settings.js), so a
// value from the server is cleaned exactly as one from this browser's storage is: junk reads as the default.
export function syncedOf(p) {
  const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  return { board: boardFrom('', o), confirm: confirmOn(o), arrows: arrowsOn(o), sound: soundOf(o), ninja: cleanLook(o.ninja) };
}
// Keys whose values differ (a and b both syncedOf's shape).
export const diff = (a, b) => SYNCED.filter((k) => a[k] !== b[k]);
const isDefault = (s) => diff(s, DEFAULTS).length === 0;

// What to do when the account's settings arrive (/api/me, a sign-in, a name claimed, the answer to a post):
//   device: syncedOf(this browser's prefs); dirty: the keys changed here that this account hasn't confirmed yet
//   (unsentKeys); server: the answer's `settings` (an object, or null for none stored).
// → { apply: { key: value } to take on here, post: the keys to send (an array; empty: nothing to send) }.
// Key by key: a change made here and not yet confirmed wins (it is sent again); every other key takes the account's
// value, so a setting changed on another device still arrives while this one's own change is on its way. An account
// with nothing stored gets this device's settings, once, if any isn't the default (else nothing is worth storing yet).
export function decide({ device, dirty = [], server }) {
  const mine = SYNCED.filter((k) => dirty.includes(k));
  if (server == null || typeof server !== 'object' || Array.isArray(server))
    return { apply: {}, post: isDefault(device) && !mine.length ? [] : [...SYNCED] };
  const s = syncedOf(server), apply = {};
  for (const k of diff(device, s)) if (!mine.includes(k)) apply[k] = s[k];
  return { apply, post: mine };
}
// The post (POST /api/settings): only the keys changed here, which the server lays over what the account holds. So an
// out-of-date tab or device never puts back its old values of the settings it didn't change.
export const changesBody = (device, keys) => ({ changes: Object.fromEntries(SYNCED.filter((k) => keys.includes(k)).map((k) => [k, device[k]])) });
// The unsent mark, as stored ({ o: the account, as app.js owner()'s hash of its token; k: the keys }): this account's
// keys, or none (another account's mark, or junk, is never read as this one's).
export function unsentKeys(mark, owner) {
  if (!owner || !mark || typeof mark !== 'object' || mark.o !== owner || !Array.isArray(mark.k)) return [];
  return SYNCED.filter((k) => mark.k.includes(k));
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
