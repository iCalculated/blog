import { Game } from './shared/tak.js?v=1795581795';
import { unplayedPlies } from './shared/ptn.js?v=1795581795';
import { syntaksBoard } from './shared/judge.js?v=1795581795';
import { THEMES, GLOSSARY } from './shared/themes.js?v=1795581795';
import { provisional, PLAYER_START } from './shared/rating.js?v=1795581795';
import { buildPTN, focusedByPointer, hooks } from './board-kit.js?v=1795581795';
import { NinjaBoard } from './ninja.js?v=1795581795';
import * as engine from './engine.js?v=1795581795';
import { showLineOn, moveSquares } from './lines.js?v=1795581795';
import * as tiltak from './tiltak.js?v=1795581795';
import * as syntaks from './syntaks.js?v=1795581795';
import { API, api, store, token, setToken, guestId, notice, setNotice, onNotice, WAIT_NOTICE } from './api.js?v=1795581795';
import { createNext } from './next.js?v=1795581795';
import { BUSY_MS, busy, busyUntil, endLocked, barHide } from './busy.js?v=1795581795';
import { createOutbox, ownerOf } from './outbox.js?v=1795581795';
import * as sound from './sound.js?v=1795581795';
import { confirmOn, soundOn, soundOf, holds, phaseKey, pending, pendingAct, settingsNote, takesHeldKey } from './settings.js?v=1795581795';
import { defender, ending, legalMove, gameRated, unratedWhy, winRated, lossRated, lossWhy, provenPlayOut, heldDisplaced, quickOutcome, capWait, provenLossLead, deferredResendOk, answerOwnsToken, stalls, heldResend, settledHeld, legalPrefix, pliesLeftOf, slowerWinsAt, playOutOf, applyProofLength, defenderName, upgradeToProven, measureProof, isTak, countTak, outOfMoves, takLeft, TAK_COUNTDOWN, replyEntry, logOk, leftRunsOn, runOnHeld, noEnding, REFUTED, ENGINE_MS } from './playon.js?v=1795581795';
import { copy } from './playon-copy.js?v=1795581795';
import { OTHER, syncedOf, decide, diff, changesBody, carried, unsentKeys, withUnsent, afterPost, syncStatus } from './prefsync.js?v=1795581795';
import { parseLook, encodeLook, cleanLook, lookReport, THEMES as NINJA_THEMES, themeOf, withTheme, themeName, showLook } from './ninja-look.js?v=1795581795';
import * as defend from './defend.js?v=1795581795';
import { ninjaUrl, fromSyntaks, fromTiltak, fromChild, quickLine, mergeLines, pickCandidates, pinnedAt, threatGroups, chipLabel, numberedPV, ptnParts } from './analysis.js?v=1795581795';
import { whenText, symFromRecord } from './rush-rules.js?v=1795581795';
import { freeOffer, freeFrom, freeExit, freeOverText, takeBack, freeDefender, freeFailKey, cardSplice, freeFocus } from './freeplay.js?v=1795581795';
import { orientPage, puzzleHash, symOf, toServer } from './pagesym.js?v=1795581795';

const $ = (s) => document.querySelector(s);
// C2 (docs/plan/PLAN.md): each ply is also posted to /api/move, in shadow, beside /api/result (outbox.js). Only when
// /api/next says `judge: 'shadow'` and the visitor already has a token; nothing on the page waits for it or reads it.
// shadow() runs such a call so that it can never throw into the page.
const outbox = (() => { try {
  let ss = null; try { ss = sessionStorage; } catch {}
  return createOutbox({ url: API + '/api/move', fetch: (...a) => fetch(...a), storage: ss, token: () => token, build: +window.TINUE_BUILD || 0 });
} catch { return null; } })();
const shadow = (f) => { try { if (outbox) f(outbox); } catch {} };
// /api/next's answer says whether the judge is listening (an error answer says nothing either way).
const judgeSeen = (r) => { if (r && typeof r === 'object' && !r.error) shadow((o) => o.setMode(r.judge)); return r; };
// Leaving an attempt (Next, another puzzle, the page going away): held plies go as they stand, and an attempt the
// page has not settled (no result sent yet, a check or a play-out still running) gets the explicit act.
function shadowLeave(s, act) {
  shadow((o) => {
    const a = s?.ob;
    if (!a || a.closed) return;
    a.closed = true;
    o.release(a);
    if (a.n && (!s.resultSent || s.checkPending || s.quickCheck || (s.playOn && !s.playOn.end)))
      o.act(a, act, { ms: elapsed(s), ...(s.playOn ? { seen: Math.floor(s.playOn.line.length / 2) } : {}) });
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A puzzle's address is a real path, <app>/puzzle/<id>, so pasting it into Discord unfurls: the static build writes
// a small page there with the puzzle's embed tags that forwards to #/puzzle/<id>, and the app then shows the path
// again. Other pages stay hash routes. APP is the app's directory (/tinue/ on shydrie.xyz, / on a dev server).
const APP = location.pathname.replace(/(puzzle\/[^/]+|glossary|me|leaderboard)\/?$/, '').replace(/[^/]*$/, '');
// The query string (an old ?board= link's too, which nothing reads any more) rides along on every address the app shows or shares.
// A build without those pages (the beta: build-static.sh STUBS=none) keeps puzzles on the hash route, so a reload works.
// s: the visit's symmetry (pagesym.js; a puzzle opened from a Rush run). Under one (1..7) the puzzle is on the hash route
// on both builds, #/puzzle/<id>/<s>: a per-puzzle page forwards to #/puzzle/<id> and would drop it.
const STUBS = window.TINUE_STUBS !== false;
const puzzlePath = (id, s = 0) => Number.isInteger(s) && s > 0 && s < 8 ? APP + location.search + '#/puzzle/' + encodeURIComponent(id) + '/' + s : STUBS ? APP + 'puzzle/' + encodeURIComponent(id) + location.search : APP + location.search + '#/puzzle/' + encodeURIComponent(id);
const showPuzzleURL = (id, s = 0) => { if (location.pathname + location.search + location.hash !== puzzlePath(id, s)) history.replaceState(null, '', puzzlePath(id, s)); };
// The symmetry of the visit on screen (0: the puzzle's own orientation).
const symNow = (s = S) => s?.p?.sym || 0;
const showHashURL = (h) => { if (location.pathname !== APP || location.hash !== h) history.replaceState(null, '', APP + location.search + h); };

// Share (phones only): the system share sheet with the puzzle's own address (see above). On desktop the address bar
// already shows that address, so there's no button (Shy, 2026-11-15).
const canShare = () => !!navigator.share && matchMedia('(pointer: coarse)').matches;
async function sharePuzzle(p) {
  try { await navigator.share({ title: 'tinue puzzle', url: location.origin + puzzlePath(p.id, p.sym || 0) }); } catch {}
}

// The server rates everyone. me: the player it knows us as, an account (name) or a guest (name null: has played
// without claiming a name), identified by the token (api.js). A first-time visitor has neither until their first
// result (or claiming a name), whose answer brings the token.
let me = null;
// Until 2026-11-15 guests were rated in this browser. Until the first result here makes a guest a server user (whose
// rating the server replays from the results this browser sent then), that rating and the puzzles seen steer the
// next puzzle and show as "your rating".
const legacyGuest = token ? null : store.get('guest', null), legacySeen = token ? [] : store.get('seen', null) || [];
const guestSeed = () => ({ gid: guestId() ?? undefined });
// A result held while its check runs (or settled but not yet acknowledged by the server), kept per tab: sessionStorage
// survives this tab's reload, and flushHeld sends it then (playon.js heldResend). Other tabs can't see it, except one
// duplicated from this tab, which copies it: the record names this page (pageId, in memory only), and from its first
// record until it goes away this page holds a Web Lock of that name, so a copy whose page is still alive is dropped, not
// sent out from under it. (Not released when the record goes: the page may settle it while a copy waits for the lock,
// and its result may not be sent yet.) It also carries the build that wrote it and whose result it is (owner: a hash
// of the token, never the token).
const pageId = (() => { try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); } })();
const owner = () => ownerOf(token);
let pageLock = false; // this page holds its lock (taken with its first record, kept for the page's life)
const heldRec = {
  get() { try { return JSON.parse(sessionStorage.getItem('tinue.held')); } catch { return null; } },
  set(v) {
    // A settled record of another puzzle (its upload failed, kept for a resend) mustn't be lost by this one replacing it:
    // send it now, as flushHeld would (quiet, not awaited; its page is this one, so it isn't checked for being alive).
    // If its first upload is still on its way, only resend when that one fails (else it would be sent twice).
    const prev = heldRec.get(), send = heldDisplaced(prev, v.id, owner()), epoch = authEpoch;
    if (send) {
      const go = (si = signIn) => api(withBuild('/api/result', send.build), { ...send.body, ...(token ? {} : { guest: guestSeed() }) }, { quiet: true })
        .then((r) => { if (r?.token && answerOwnsToken(si, signIn)) { setToken(r.token); ownHeld(); } }, () => {});
      const first = uploading.get(prev.id);
      if (first) first.then((r) => ({ ok: true, r }), () => ({ ok: false })).then((u) => { if (deferredResendOk(u, epoch, authEpoch)) go(); });
      else go();
    }
    if (!pageLock && navigator.locks) { pageLock = true; navigator.locks.request('tinue.held.' + pageId, () => new Promise(() => {})).catch(() => {}); }
    try { sessionStorage.setItem('tinue.held', JSON.stringify({ ...v, b: BUILD, owner: owner(), page: pageId })); } catch {}
  },
  del(id) { try { if (id == null || heldRec.get()?.id === id) sessionStorage.removeItem('tinue.held'); } catch {} },
};
// A token a result just made for this browser (its first result made it a guest): a record held from before it had
// one is this guest's, so it is stamped as theirs (only the owner: its build stays the one that wrote it).
const ownHeld = () => { try { const h = heldRec.get(); if (h?.id && h.owner === '') sessionStorage.setItem('tinue.held', JSON.stringify({ ...h, owner: owner() })); } catch {} };
// Whether the page that wrote a held record is still open (its lock is taken). A lock a reload has just let go of may
// take a moment to free, so it gets 1.5 s; without Web Locks, as before (sent).
const pageAlive = (page) => {
  if (!page || page === pageId || !navigator.locks) return Promise.resolve(false);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 1500);
  return navigator.locks.request('tinue.held.' + page, { signal: ctl.signal }, () => false)
    .catch((e) => e?.name === 'AbortError').finally(() => clearTimeout(t));
};
// Your rating as shown: the server's, else (no result yet) the browser's from before, else the start.
const myRating = () => me || (legacyGuest?.games ? { rating: legacyGuest.rating, provisional: provisional(legacyGuest) } : { rating: PLAYER_START.rating, provisional: true });
// "1650?" while a rating is still provisional (high deviation), as on Lichess.
const fmtRating = (r, prov) => `${Math.round(r)}${prov ? '<span class="prov" title="Provisional: it settles after about 15 rated puzzles">?</span>' : ''}`;
const prefs = store.get('prefs', {});
if (!prefs.v2) { prefs.size = '6'; prefs.v2 = true; } // 6×6 by default
// 2026-11-14: the default moved from 5×5 to 6×6 (where serious Tak is played). Anyone still on the old 5×5 default
// moves too, once; "Any size" and later choices stay.
if (!prefs.v3) { if (prefs.size === '5') prefs.size = '6'; prefs.v3 = true; }
prefs.difficulty ||= 'normal';
// The PTN Ninja look as stored (ninja-look.js): kept only in its clean form, so what index.html put in the iframe's
// address and what ninja.js sends agree from here on.
if ('ninja' in prefs) { const c = cleanLook(prefs.ninja); if (c) prefs.ninja = c; else delete prefs.ninja; }
store.set('prefs', prefs);
// Whether this browser keeps site storage at all (the Settings page says so when it doesn't).
const STORAGE_OK = (() => { try { localStorage.setItem('tinue.probe', '1'); const ok = localStorage.getItem('tinue.probe') === '1'; localStorage.removeItem('tinue.probe'); return ok; } catch { return false; } })();
// This sitting's results {id, win, delta}: kept per tab, so a reload (e.g. into a newer build) doesn't wipe the streak.
const session = (() => { try { return JSON.parse(sessionStorage.getItem('tinue.session')) || []; } catch { return []; } })();
const saveSession = () => { try { sessionStorage.setItem('tinue.session', JSON.stringify(session.slice(-200))); } catch {} };
const reporting = new Set(); // result uploads still on their way
const uploading = new Map(); // puzzle id -> its result upload while on its way (heldRec.set: no double send)
// Bumped when the player signed in, out, or switched accounts (not when a first result mints this browser's token):
// a result held from before mustn't go out under the new identity (heldRec.set's deferred resend).
let authEpoch = 0;
// Bumped whenever the page signs in, out or claims a name (a first claim included, whether its token comes back in the
// answer or only as the cookie):
// a result's answer that left before keeps its own minted token and user to itself (answerOwnsToken).
let signIn = 0;

// The board: PTN Ninja's, in an iframe (ninja.js), for everyone (tinue's own, board.js, is retired; a stored Board
// setting or a ?board= in the address is ignored). A finished move goes through moveIn (Confirm moves). While PTN
// Ninja is loading or down, nothing can be played and the page waits (renderAll keeps Hint and Solution off); a move held
// for Confirm is dropped, so it can't be judged on a board that isn't there.
const board = new NinjaBoard($('#board'), { onMove: (ptn) => moveIn(ptn), look: prefs.ninja, onState: () => { syncClock(); if (!S) return; if (!board.available) pendingEvent({ type: 'leave' }); renderAll(); } });
// Sounds (sound.js): every move played or appended on any board (this page's, Rush's, PTN Ninja's) sounds what it set
// down and where (board-kit.js landOf); a jump to another position stops drops still queued (onCut). The audio unlocks on the first press,
// tap or key. A beta build may play the sound lab's recipes stored on this device (sound.js loadCustom).
// A board out of sight makes no sound: the puzzle page's keeps moving under Rush or History (its intro, its reply, a
// solution playing out), and its cut would stop Rush's own drops.
const inSight = (b) => !b?.away && (!b?.el?.getClientRects || b.el.getClientRects().length > 0); // (away: PTN Ninja's, lent to Rush)
hooks.onPly = (ptn, smash, info, b) => { if (inSight(b)) sound.playMove(ptn, smash, info); };
hooks.onLand = (list, b) => { if (inSight(b)) sound.playLanding(list); };
hooks.onCut = (b) => { if (inSight(b)) sound.cut(); };
sound.loadCustom();
sound.setEnabled(soundOn(prefs)); sound.setVoice(soundOf(prefs));
sound.listen();
board.ui({ disableBoard: true }); // no input until a puzzle is loaded
let S = null; // current puzzle state
onNotice(() => renderAll()); // api() shows and clears the server notice

// ---------- user box ----------
const NO_ANSWER = { error: 'Can’t reach the puzzle server.' }; // (what a form says when api() throws)
function renderUser() {
  const box = $('#userbox');
  store.set('me', me ? { name: me.name } : null); // a guest is { name: null }
  renderSyncStatus(); // (the Settings page says whether settings follow the account)
  if (me) { store.set('myRating', me.rating); store.set('myProv', !!me.provisional); } // shown before /api/me answers next time
  if (me?.name) {
    // Name with a small menu on hover/focus: History, Sign out (with an inline confirm).
    box.innerHTML = `<div class="menu"><button class="link name" aria-haspopup="true">${esc(me.name)}</button>
      <div class="pop" role="menu"><a href="#/me" role="menuitem">History</a><a href="#/settings" role="menuitem">Settings</a><button class="link" id="logout" role="menuitem">Sign out</button>
        <div class="confirm hidden" id="logout-confirm"><p>You’ll need your login token (on your History page) to sign back in on this device.</p><button class="danger" id="logout-yes">Sign out</button><p class="err hidden" id="logout-err">Couldn’t sign out: the server didn’t answer.</p></div></div></div>`;
    // (a keyboard press moves focus onto the confirm: the button it pressed hides, and the menu lives on focus)
    $('#logout').onclick = (e) => { $('#logout-err').classList.add('hidden'); $('#logout-confirm').classList.remove('hidden'); $('#logout').classList.add('hidden'); if (!e.detail) $('#logout-yes').focus(); };
    // Once the menu closes (neither hovered nor focused), the confirm folds back into Sign out, so the menu never
    // reopens stuck on it.
    const menu = box.querySelector('.menu'), fold = () => setTimeout(() => {
      if (!menu.isConnected || menu.matches(':hover, :focus-within')) return;
      menu.querySelector('#logout-confirm').classList.add('hidden'); menu.querySelector('#logout').classList.remove('hidden');
    });
    menu.addEventListener('mouseleave', fold); menu.addEventListener('focusout', fold);
    $('#logout-yes').onclick = async () => {
      await abandonAll({ auth: true }); restoreLeft();
      // (signed out only once the server says so: its cookie would keep naming the player)
      try { const r = await api('/api/logout', {}); if (r?.error) throw new Error(r.error); } catch { $('#logout-err')?.classList.remove('hidden'); return; }
      authEpoch++; signIn++; setToken(null); forgetNext(); me = null; serverSettings = null; syncState = 'saved'; // (this device keeps its settings)
      session.length = 0; saveSession(); renderUser(); refreshPage(); };
  } else {
    // One quiet button; claiming a name (or pasting a token) happens in a small popover.
    box.innerHTML = `<div class="menu click"><button class="link name" id="claim-open" aria-haspopup="dialog" aria-expanded="false">Claim a username</button>
      <div class="pop wide" role="dialog" aria-label="Claim a username">
        <form id="claim"><label class="field"><span>Username</span><input name="name" id="claim-name" maxlength="20" autocomplete="username" placeholder="2–20 letters, digits, _ or -"></label>
          <button class="primary" type="submit">Claim</button><p class="err hidden" id="claim-err"></p>
          <p class="hint">No password: your browser remembers you. <button type="button" class="link" id="token-open">Have a login token?</button></p>
          <p class="hint"><a href="#/settings" class="link" id="settings-open">Settings</a></p></form>
        <form id="tok" class="hidden"><label class="field"><span>Login token</span><input name="token" id="tok-in" autocomplete="off" placeholder="From the History page on your other device"></label>
          <button class="primary" type="submit">Sign in</button><p class="err hidden" id="tok-err"></p></form>
      </div></div>`;
    const menu = box.querySelector('.menu');
    $('#claim-open').onclick = () => {
      const open = menu.classList.toggle('open');
      $('#claim-open').setAttribute('aria-expanded', open);
      if (!open) return;
      // always start from the claim form (not a token form left open last time)
      $('#claim').classList.remove('hidden'); $('#tok').classList.add('hidden');
      for (const id of ['#claim-err', '#tok-err']) $(id).classList.add('hidden');
      $('#claim-name').focus();
    };
    $('#settings-open').onclick = () => closeMenu(menu, false);
    $('#token-open').onclick = () => { $('#claim').classList.add('hidden'); $('#tok').classList.remove('hidden'); $('#tok-in').focus(); };
    const showErr = (id, msg) => { const el = $(id); el.textContent = msg; el.classList.remove('hidden'); };
    $('#claim').onsubmit = async (e) => {
      e.preventDefault();
      // A guest's row just gets the name (rating and history stay); a first-time visitor's is created like a guest's.
      const r = await api('/api/register', { name: $('#claim-name').value.trim(), ...(token ? {} : { guest: guestSeed() }) }).catch(() => NO_ANSWER);
      if (r.error) return showErr('#claim-err', r.error);
      if (r.token && token && r.token !== token) authEpoch++; // another account now (a guest naming its own row isn't)
      signIn++; // signed in as the named account now (its token may come only as a cookie): an answer on its way stays out
      if (r.token) setToken(r.token);
      me = r.user; renderUser(); settingsArrived(r); refreshPage();
    };
    $('#tok').onsubmit = async (e) => {
      e.preventDefault();
      const t = $('#tok-in').value.trim();
      const r = await api('/api/login', { token: t }).catch(() => NO_ANSWER);
      if (r.error) return showErr('#tok-err', r === NO_ANSWER ? r.error : 'That token doesn’t match an account.');
      await abandonAll({ auth: true }); restoreLeft(); // a held result goes out under the identity that played it
      authEpoch++; signIn++; setToken(t); forgetNext(); me = r.user; session.length = 0; saveSession(); serverSettings = null; renderUser(); settingsArrived(r); refreshPage();
    };
  }
}
function closeMenu(m, refocus) {
  m.classList.remove('open');
  m.querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false');
  if (refocus) m.querySelector('.name')?.focus();
}
document.addEventListener('keydown', (e) => {
  const m = e.key === 'Escape' && document.querySelector('.menu.open');
  if (m) closeMenu(m, m.contains(document.activeElement));
});
document.addEventListener('click', (e) => { // close the claim popover when clicking elsewhere
  const m = document.querySelector('.menu.click.open');
  if (m && !m.contains(e.target)) closeMenu(m, false);
});
// Focus gone into PTN Ninja's frame (a click on its board): no click or key from there reaches the page, so what a click
// elsewhere or Escape would end here ends now. The claim popover closes, and a move waiting for Confirm keeps the
// keyboard (Esc cancels, Enter confirms; PTN Ninja's board is off meanwhile). Otherwise Escape stays PTN Ninja's own.
addEventListener('blur', () => setTimeout(() => {
  const f = document.activeElement;
  if (f?.tagName !== 'IFRAME' || !$('#board').contains(f)) return;
  const m = document.querySelector('.menu.click.open');
  if (m) closeMenu(m, false);
  if (pend && !$('#view-puzzle').classList.contains('hidden')) f.blur(); // (Rush, borrowing the frame, has its own)
}));
// After signing in or out: re-render whichever page is showing (History shows the account and its token).
function refreshPage() {
  if ($('#view-puzzle').classList.contains('hidden')) route(); else renderAll();
}

// ---------- puzzle flow ----------
// The load generation: every loadNext/loadById and every route() bumps it, and a load checks it after each await, so
// a late reply never starts its puzzle after the player navigated elsewhere (back to the puzzle on screen, to Rush, to
// another page): starting it would abandon the puzzle on screen (a play-out left is a rated miss) and rewrite the address.
let loadSeq = 0;
const nextQuery = (skip) => { // skip: a puzzle id to leave out (one whose result may not have reached the server)
  const q = new URLSearchParams({ difficulty: prefs.difficulty });
  if (prefs.size) q.set('size', prefs.size);
  if (prefs.theme) q.set('theme', prefs.theme);
  const ex = [...(token ? [] : legacySeen.slice(-200)), ...(skip ? [skip] : [])];
  if (!token) q.set('rating', Math.round(myRating().rating));
  if (ex.length) q.set('exclude', ex.join(','));
  return q.toString();
};
// What comes after this puzzle (the win/loss pair, a settled player's batch queue, the stored next one): next.js.
const filterKey = () => [prefs.difficulty, prefs.size || '', prefs.theme || ''].join('|');
const nextQ = createNext({
  get: (path) => api(path, null, { quiet: true }).then(judgeSeen), store, filterKey, playerKey: () => (token ? token.slice(0, 8) : ''), query: nextQuery,
  settled: () => !!(token && me && !me.provisional), rating: () => me?.rating ?? null, currentId: () => S?.p?.id,
});
const forgetNext = () => nextQ.forgetNext(); // another player now

// ---------- a newer build ----------
// Next never reloads the page, so an open tab keeps the code it was opened with (2026-11-15: every regular was still
// on the old still-wins timeout an hour after the fix shipped). The static build stamps window.TINUE_BUILD and
// version.json (scripts/build-static.sh); the tab compares them on each puzzle, when it comes back into view and every
// 10 min. Once a newer build is out, moving on to the next puzzle reloads the page into it (the stored next puzzle and
// the queue are in localStorage, so nothing is lost), unless a result is held or still being checked; mid-puzzle or on
// a result card it only shows the bar. Off on the dev server (no stamp).
const BUILD = +window.TINUE_BUILD || 0;
// The beta build (scripts/build-beta.sh) wears a badge naming the branch and commit it was built from.
if (window.TINUE_BETA) {
  const b = Object.assign(document.createElement('span'), { className: 'beta-badge', textContent: 'beta', title: `Beta build of ${window.TINUE_BETA}. It uses the real server: results here count.` });
  b.append(Object.assign(document.createElement('small'), { textContent: String(window.TINUE_BETA) }));
  document.querySelector('.brand')?.after(b);
  // The sound lab (#/sounds, sound-lab.js): its page, and the link to it under the Settings page's Sound, exist only here.
  const lab = Object.assign(document.createElement('main'), { id: 'view-sounds', className: 'page hidden' });
  document.querySelector('#view-rush')?.after(lab);
}
const withBuild = (path, b = BUILD) => (b ? path + (path.includes('?') ? '&' : '?') + 'b=' + b : path); // logged by the server
let newBuild = 0, buildBarHidden = false, buildCheck = null, lastBuildCheck = 0;
// A reload into a build the CDN doesn't serve yet would come back to the old page: one try per build every 2 min.
const reloadedFor = () => { try { return JSON.parse(sessionStorage.getItem('tinue.reloadedFor')) || {}; } catch { return {}; } };
// Any other build counts (a rollback too); the server's clock doesn't matter.
function checkBuild() {
  if (!BUILD) return Promise.resolve(0);
  if (buildCheck) return buildCheck;
  lastBuildCheck = Date.now();
  const req = buildCheck = fetch(APP + 'version.json?t=' + Date.now(), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const v = +j?.v || 0, tried = reloadedFor();
      if (v && v !== BUILD && !(tried.v === v && Date.now() - tried.at < 120e3) && v !== newBuild) { newBuild = v; renderBuildBar(); }
      return newBuild;
    })
    .catch(() => newBuild).finally(() => { if (buildCheck === req) buildCheck = null; });
  return req;
}
if (BUILD) {
  setInterval(() => { if (!document.hidden) checkBuild(); }, 10 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastBuildCheck > 30e3) checkBuild(); });
}
// The bar never appears in the middle of a puzzle the player has started, a miss included (it would push the board
// down under their pointer, and its Reload would leave a held check): it waits for the puzzle's end (solved, or the
// solution shown). Before the first move it stays if it was up as the puzzle started (fresh: start()), but doesn't
// newly appear: the check answers after the board is playable, maybe as the player taps (busy.js barHide).
// renderAll calls this too.
const BAR_TEXT = 'tinue was updated. Reload to get the fixes. Your rating and puzzle queue are kept.';
function renderBuildBar(fresh = false) {
  const bar = $('#build-bar'), live = $('#build-live');
  if (!bar) return; // an older index.html
  const hide = barHide({ newBuild, dismissed: buildBarHidden, s: S, shown: !bar.hidden, fresh });
  if (bar.hidden === hide) return;
  bar.hidden = hide;
  if (!hide && !bar.firstChild) {
    bar.innerHTML = '<span class="msg">tinue was updated. <span class="muted">Reload to get the fixes. Your rating and puzzle queue are kept.</span></span>'
      + '<button type="button" class="primary reload">Reload</button><button type="button" class="x" aria-label="Dismiss" title="Dismiss">×</button>';
    bar.querySelector('.reload').addEventListener('click', reloadNow);
    bar.querySelector('.x').addEventListener('click', () => { buildBarHidden = true; renderBuildBar(); }); // until the next puzzle
  }
  if (live) live.textContent = hide ? '' : BAR_TEXT; // an always-present live region, so screen readers announce it
  try { fitDock(); } catch {} // the phone dock sizes the board from where it starts
}
// The Reload button: from a result card on to the next puzzle (a reload of this one would replay it); before the
// first move, this puzzle again.
function reloadNow() {
  if (justEnded()) return; // the bar shows once the result does, pushing the board down: a tap aimed at the board
  if (S?.playOn) return; // never in the middle of a play-on game (leaving it is a miss); the bar is hidden then anyway
  if (S && !S.placeholder && (S.resultSent || S.status !== 'play' || S.quickCheck)) loadNext({ reload: true }); // (a move being checked is sent as it leaves)
  else reloadInto(S?.p?.id, S?.theme, symNow()); // (the same visit: under its symmetry)
}
// A full page load opening puzzle id (or the start). theme: the Theme its result counts under (see start()). s: the
// visit's symmetry, only when reloading the puzzle on screen (never the next one).
function reloadInto(id, theme = '', s = 0) {
  try {
    sessionStorage.setItem('tinue.reloadedFor', JSON.stringify({ v: newBuild, at: Date.now() }));
    if (id) sessionStorage.setItem('tinue.reloadTheme', JSON.stringify({ id, theme: theme || '' }));
  } catch {}
  history.replaceState(null, '', APP + location.search + (id ? puzzleHash(id, s) : '#/'));
  location.reload();
}
const reloadTheme = (() => { try { const t = JSON.parse(sessionStorage.getItem('tinue.reloadTheme')); sessionStorage.removeItem('tinue.reloadTheme'); return t; } catch { return null; } })();

async function loadNext({ reload = false } = {}) {
  const t = ++loadSeq;
  // A held result is sent (unrated) first, so the server knows this puzzle was played and won't serve it again; if
  // that upload is slow, the request below excludes it anyway.
  const leaving = S?.checkPending || S?.quickCheck ? S.p.id : null;
  const left = abandonCheck(S);
  if (left) await Promise.race([left, new Promise((r) => setTimeout(r, 3000))]);
  if (t !== loadSeq) return;
  const pre = nextQ.take(); // (a stored one stays until this puzzle's result: leaving halfway comes back to it)
  // A prefetch still in flight gets 3 s (it is quiet: no waiting notice), then a normal request takes over.
  let r = pre && (await Promise.race([pre, new Promise((res) => setTimeout(() => res(null), 3000))]));
  if (t !== loadSeq) return;
  if (!r?.puzzle || r.puzzle.id === S?.p.id) { // (a "no match" answer is re-asked too)
    if (pre && !r) { setNotice(WAIT_NOTICE); renderAll(); }
    try { r = judgeSeen(await api('/api/next?' + nextQuery(leaving))); } catch { restoreLeft(); return; } // api() has shown the error
  }
  const { puzzle } = r;
  if (t !== loadSeq) return; // a newer request superseded this one
  if (!puzzle) { // nothing to play: clear the old puzzle rather than leave it playable under the new filters
    engine.interrupt(); tiltak.stop(); anaCtl?.abort();
    S = null;
    setNotice({ kind: 'none', title: 'No puzzles match', body: 'Try another theme, difficulty or board size.' });
    showHashURL('#/');
    await board.ui({ disableBoard: true, showRoads: false, dropOnStray: false });
    await board.load(buildPTN({ size: +(prefs.size || 6) }));
    renderAll(); setTitle(); return;
  }
  // Between puzzles, a newer build (as last checked: Next doesn't wait on the network) reloads into this one. Not while
  // a result is held or still uploading (the reload would cut it off), unless the player pressed Reload: then an
  // upload in flight gets 3 s, and a held one is sent at the reload anyway (flushHeld).
  if (newBuild && (reload || (!leaving && !heldRec.get() && !reporting.size))) {
    if (reporting.size) await Promise.race([Promise.allSettled([...reporting]), new Promise((res) => setTimeout(res, 3000))]);
    if (t !== loadSeq) return;
    reloadInto(puzzle.id, prefs.theme); return;
  }
  showPuzzleURL(puzzle.id);
  start(puzzle, prefs.theme);
}
// Does the puzzle fit the current Theme / Board filters?
const matchesFilters = (p) => (!prefs.theme || (p.themes || []).includes(prefs.theme)) && (!prefs.size || String(p.size) === String(prefs.size));

// s: the visit's symmetry, from the address (route). look: a Rush record stored before records kept their symmetry (rush.js
// lookFrom), whose symmetry is worked out from the puzzle once it is here (rush-rules.js symFromRecord).
async function loadById(id, s = 0, look = null) {
  const t = ++loadSeq;
  // Reloaded into a newer build on the way to this puzzle: it's the stored next one (no request needed, even with the
  // server unreachable), and it keeps the Theme it was picked under (start() checks it against the puzzle's themes).
  const reloaded = reloadTheme?.id === id, stored = reloaded && store.get('next', null)?.puzzle;
  let puzzle = stored?.id === id ? stored : null;
  // (judgeSeen: a fresh tab opened on a puzzle link learns here whether the judge listens, before start() opens the attempt)
  if (!puzzle) { try { ({ puzzle } = judgeSeen(await api('/api/puzzle/' + encodeURIComponent(id)))); } catch { restoreLeft(); return; } }
  if (t !== loadSeq) return;
  if (puzzle && !s && look?.id === puzzle.id) {
    try { s = symFromRecord(puzzle, look); } catch { s = 0; }
  }
  // The one place a puzzle is oriented (pagesym.js): the page works in the turned labels from here on; the server's
  // object is kept beside it (S.p0) and nothing that goes out is taken from the turned one (toServer).
  if (puzzle) { showPuzzleURL(puzzle.id, s); start(orientPage(puzzle, s), reloaded ? reloadTheme.theme : '', puzzle); } else loadNext();
}

const colorName = (c) => (c === 1 ? 'White' : 'Black');

// PTN for everything shown so far: the game's history (if known) plus moves played in the puzzle.
function currentPTN() { return ptnFor(officialLine()); }

// ---- lines: the official line (game history + puzzle moves) and, after the puzzle, your own exploration ----
const officialLine = () => [...S.hist, ...S.moves.map((m) => m.ptn)];
const shownLine = () => (S.branch && S.onBranch ? [...officialLine().slice(0, S.branch.at), ...S.branch.moves] : officialLine());
// The source game's players go in the PTN's headers, unless the history ends in a line they never played (a dragon
// sub-position): then the PTN would credit them with moves they didn't make, so it gets the default White/Black.
const gameNames = (p) => (p.meta?.white && !unplayedPlies(p.meta) ? { white: p.meta.white, black: p.meta.black } : {});
function ptnFor(plies) {
  const { p } = S;
  const names = gameNames(p);
  return S.hist.length ? buildPTN({ size: p.size, komi: p.komi, moves: plies, ...names }) : buildPTN({ size: p.size, komi: p.komi, tps: p.tps, moves: plies, ...names });
}
function gameAt(plies) {
  const g = S.hist.length ? Object.assign(new Game(S.p.size), { komi: S.p.komi || 0 }) : Game.fromTPS(S.p.tps, S.p.komi || 0);
  for (const m of plies) g.play(m);
  return g;
}
// Position description for the engine worker: in the puzzle's own orientation (S.x, pagesym.js toServer), so the
// budgeted still-wins check that decides a result runs exactly as in an ordinary visit; its answers come back through
// fromEngine.
const enginePos = (plies) => ({ size: S.p.size, komi: S.p.komi || 0, tps: S.hist.length ? null : S.p0.tps, plies: plies.map(S.x.back) });
const fromEngine = (s, r) => s.x.answer(r);

// PTN Ninja links (the step buttons, and with the analysis view the puzzle's info too; only once the puzzle is over,
// since they carry its solution): the line on the board, at the position shown. Built from the puzzle, not the board, so
// they are the same on either board. No theme or look rides along: ptn.ninja opened on its own ignores them (it shows
// that browser's own PTN Ninja look). lz-string (public/vendor) loads on the first puzzle over; until it arrives the
// links have no href.
// Under a symmetry (pagesym.js) the link opens what the player is looking at, in the shown labels: PTN Ninja is not the
// server (nothing is recorded or judged there), and a board that turned on the way over would read as a different game.
let lz = null, lzLoad = null;
const ninjaHref = () => lz && ninjaUrl({ ptn: ptnFor(shownLine()), ply: S.view ?? shownLine().length, name: 'tinue #' + S.p.id }, lz);
function loadLz() {
  lzLoad ||= import('./vendor/lz-string.js?v=1795581795').then((m) => { lz = m.compressToEncodedURIComponent; refreshNinja(); }, () => { lzLoad = null; });
}
function refreshNinja() {
  if (!S || S.placeholder || S.status !== 'solved') return;
  const href = ninjaHref();
  if (href) for (const a of document.querySelectorAll('a[data-ninja]')) if (a.href !== href) a.href = href;
}

// The analysis view (window.TINUE_ANALYSIS, config.js as scripts/build-static.sh writes it: on in the beta build, off in
// the production build, on in local development). Off, the page after a puzzle is production's as it was before the
// analysis view (main, 2026-11-21): one engine row, line 1 only (its chance bar, who's better, its moves, the source),
// from the same engines and the same one request per position; no further lines, no candidate chips or candidate
// searches, no tactics facts (threats, pinned moves), nothing marked on the board.
// On only where config.js says true (fail closed): a config.js without the line, such as production's before this
// release, still cached beside the new app.js, gets production's page.
const ANALYSIS = window.TINUE_ANALYSIS === true;
// The analysis view's own stylesheet (public/analysis.css), loaded only with the view on, over style.css, which
// holds what it shares with production's row. Stamped as this module is (build-static.sh's ?v=), so a beta release never mixes them.
if (ANALYSIS) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('./analysis.css' + new URL(import.meta.url).search, import.meta.url).href }));
// After the puzzle: the analysis of the position on the board, as up to three lines (public/analysis.js, the line
// model), each from the mover's side:
// - every size: our solver (tactics worker, ~20 ms): every win in 1 and 2 (proven), the opponent's threats, tinuë,
//   and its verdict on the moves pinned here (the puzzle's move, yours);
// - 6×6: Syntaks on the server (much stronger there, and it knows every half-point komi), three lines in one search;
//   a move you missed here that isn't among them gets one search of its own;
// - 4×4/5×5: Tiltak in the browser, streamed as it searches, then a short search of each of a few candidate moves;
// - boards neither engine plays, and 6×6 when the server can't answer: the solver's forced-win line (never Tiltak on
//   6×6, Sasha 2026-11-21: "we shouldn't have any tiltak analysis in 6x6"; tiltak.js supports).
// Everything is keyed on the position (S.evalKey): an answer for a position no longer shown is dropped (live()).
let anaCtl = null; // the in-flight Syntaks requests; aborted when the position changes, so the server drops them
// The puzzle's own plies in S.moves (analysis.js pinnedAt's tree): its tree's moves up to the first that isn't one (a
// slow win, a play-on game: nothing proved those move by move), or a last move that wins at once; at each of the
// solver's, the plies the tree has left there (playon.js pliesLeftOf), the defender's null.
function treePlies() {
  const out = [], won = gameAt(officialLine()).result()?.winner === S.solver;
  let node = S.p.tree;
  for (let i = 0; i < S.moves.length; i += 2) {
    const m = S.moves[i].ptn;
    if (i === S.moves.length - 1 && won) { out.push(1); break; }
    if (!node || node === 'win' || !Object.prototype.hasOwnProperty.call(node, m)) break;
    out.push(pliesLeftOf(node));
    if (S.moves[i + 1]?.ptn !== node[m]?.r) break;
    out.push(null); node = node[m].n;
  }
  return out;
}
async function runEngine() {
  if (!S || S.status !== 'solved') return;
  const line = shownLine();
  const at = S.view ?? line.length;
  const plies = line.slice(0, at);
  const key = plies.join(' ');
  // Already analysed: the lines stand, but a reload of the board (back to the solution at the fork) wiped its mark
  if (S.evalKey === key) return paintShapes();
  const s = S;
  // The last position's lines and mark go now, before anything is awaited.
  S.evalKey = key; S.eval = null; S.eng = null; S.lines = []; S.sol = null; S.sel = 0; S.selUser = false; S.pins = []; S.posG = null;
  board.shapes?.([]);
  anaCtl?.abort(); anaCtl = null;
  tiltak.stop();
  const live = () => S === s && S.evalKey === key;
  const g = gameAt(plies);
  const res0 = g.result();
  if (res0) { S.eval = { kind: 'over', winner: res0.winner, how: res0.kind }; renderAll(); return; }
  const mover = g.toMove, official = officialLine();
  S.posG = g;
  S.eng = { thinking: true, src: null, lines: [] };
  const go = syntaksBoard(S.p.size, S.p.komi || 0) ? runServer : runTiltak;
  if (!ANALYSIS) { // (production's engine row: no tactics facts, no pinned moves; line 1 from the engine below)
    setLines(s, key);
    return go(s, key, g, plies);
  }
  S.pins = pinnedAt({ official, histLen: S.hist.length, at, onBranch: !!(S.onBranch && S.branch && at > S.branch.at), solver: S.solver, mover,
    misses: S.misses, tree: treePlies() });
  setLines(s, key);
  // (the worker sees the puzzle's own orientation, like every engine: enginePos and the pinned moves turned back, its
  // facts turned forward again; pagesym.js toServer)
  engine.lines({ ...enginePos(plies), pinned: S.pins.map((p) => s.x.back(p.move)) }).then((r) => { if (r && live()) { S.sol = s.x.facts(r); setLines(s, key); } });
  go(s, key, g, plies);
}
// GET /api/analyze, aborted with ctl (the position changed) or after 6 s (the search plus a short queue on crux; past
// that, the solver answers: runServer). A plain GET without the Authorization header: no CORS preflight (every
// position is a new URL, so a preflight was never reused); the server knows the player by the cookie when the page
// sends one, else by address. One line asks as before (same URL, so the browser's cache of it still answers).
function serverAnalyze(tps, komi, lines, ctl) {
  const tmo = new AbortController(), timer = setTimeout(() => tmo.abort(), 6000), stop = () => tmo.abort();
  ctl.signal.addEventListener('abort', stop);
  if (ctl.signal.aborted) stop(); // (an abort listener added after the abort never fires)
  return fetch(`${API}/api/analyze?tps=${encodeURIComponent(tps)}&komi=${komi}${lines > 1 ? '&lines=' + lines : ''}`, { credentials: 'include', signal: tmo.signal })
    .then((r) => r.json()).finally(() => { clearTimeout(timer); ctl.signal.removeEventListener('abort', stop); });
}
function runServer(s, key, g, plies) {
  const live = () => S === s && S.evalKey === key;
  if (!live()) return;
  const komi = S.p.komi || 0, mover = g.toMove;
  S.eng = { thinking: true, src: 'syntaks', lines: [] };
  const ctl = anaCtl = new AbortController();
  const fallback = () => { if (live()) runSolver(s, key, plies); }; // (never Tiltak on 6×6: tiltak.js supports)
  // (the server is asked about the position in the puzzle's own orientation, byte for byte what an ordinary visit
  // sends, and every line it answers is turned to the page's labels: pagesym.js toServer)
  serverAnalyze(s.x.tps(g.toTPS(), komi), komi, ANALYSIS ? 3 : 1, ctl).then((r) => { // (off: one line, production's URL)
    if (!live()) return;
    r = s.x.analysis(r);
    if (r?.engine !== 'syntaks') return fallback();
    const lines = (r.lines ?? [r]).map((l, i) => fromSyntaks(l, mover, i));
    S.eng = { thinking: false, src: 'syntaks', lines, multipv: !!r.multipv, depth: r.depth, ms: r.ms };
    setLines(s, key);
    if (!ANALYSIS) return;
    // Your misses the server's lines don't have: each judged exactly first (quickLine: it ends the game, or hands over a
    // win in 1: nothing to search), so a second miss is never left at the solver's "no win ≤2"; the first that needs a
    // search gets one of its own, once you stay here a moment.
    let ask = null;
    for (const p of S.pins.filter((x) => x.tags.includes('yours') && !lines.some((l) => l.move === x.move))) {
      const pc = g.clone();
      try { pc.play(p.move); } catch { continue; }
      const q = quickLine(pc, p.move, mover, s.x.back);
      if (q) { S.eng = { ...S.eng, lines: [...S.eng.lines, q] }; setLines(s, key); } else ask ||= { p, pc };
    }
    if (!ask) return;
    const miss = ask.p, c = ask.pc;
    setTimeout(() => {
      // (live() alone is not enough: stepping away and back within the 400 ms gives the same key, and this visit's
      // own search, under a new ctl, asks again)
      if (!live() || ctl.signal.aborted) return;
      serverAnalyze(s.x.tps(c.toTPS(), komi), komi, 1, ctl).then((cr) => {
        if (!live() || cr?.engine !== 'syntaks') return; // (busy or refused: the solver's verdict stays)
        cr = s.x.answer(cr);
        S.eng = { ...S.eng, lines: [...S.eng.lines, fromChild(cr, miss.move, mover)] };
        setLines(s, key);
      }, () => {});
    }, 400);
  }, fallback);
}
// Tiltak: line 1 streamed (repainted at most every 250 ms), then a short search of each candidate (its runner-ups seen
// in the stream, the solver's wins, your miss): 2 on a mouse, 1 on a phone. Searches are by time (ms), never by
// nodes, so tiltak.stop() ends them at once.
function runTiltak(s, key, g, plies) {
  const live = () => S === s && S.evalKey === key;
  if (!live()) return;
  if (!tiltak.supports(S.p.size, S.p.komi || 0)) { tiltak.stop(); return runSolver(s, key, plies); }
  const size = S.p.size, komi = S.p.komi || 0, mover = g.toMove;
  S.eng = { thinking: true, src: 'tiltak', lines: [] };
  setLines(s, key);
  let lastPaint = 0;
  const runnerUps = [];
  // If Tiltak can't load or crashes, use the solver instead of thinking forever.
  const fallback = () => { if (live() && S.eng?.src === 'tiltak' && S.eng.thinking) runSolver(s, key, plies); };
  // (Tiltak too sees the puzzle's own orientation, so its lines are an ordinary visit's turned: s.x.tps / s.x.answer)
  tiltak.analyze({ tps: s.x.tps(g.toTPS(), komi), size, komi, ms: 2000, onInfo: (r) => {
    if (!live()) return;
    r = s.x.answer(r);
    const m = r.pv?.[0];
    if (m && r.nodes >= 300 && !runnerUps.includes(m)) runnerUps.push(m);
    S.eng = { thinking: true, src: 'tiltak', lines: [fromTiltak(r, mover)], depth: r.depth, nodes: r.nodes };
    const now = performance.now(); if (now - lastPaint > 250) { lastPaint = now; setLines(s, key); }
  } }).then(async (r) => {
    if (!live()) return;
    r = s.x.answer(r);
    if (!r || (!r.pv?.length && r.winProb == null)) return fallback();
    const l1 = fromTiltak(r, mover);
    const cands = ANALYSIS ? pickCandidates({ line1: l1.move, solver: S.sol, pinned: S.pins, runnerUps, max: finePointer.matches ? 2 : 1 }) : [];
    S.eng = { thinking: false, more: cands.length > 0, src: 'tiltak', lines: [l1], depth: r.depth, nodes: r.nodes, ms: r.timeMs };
    setLines(s, key);
    for (const m of cands) {
      const c = g.clone();
      try { c.play(m); } catch { continue; }
      let cl = quickLine(c, m, mover, s.x.back); // (ends the game or hands over a win in 1: Tiltak would only say "0%")
      if (!cl) {
        const cr = await tiltak.analyze({ tps: s.x.tps(c.toTPS(), komi), size, komi, ms: 600 }).catch(() => null);
        if (!live()) return;
        if (!cr) continue;
        cl = fromChild(s.x.answer(cr), m, mover);
      }
      if (!live()) return;
      S.eng = { ...S.eng, lines: [...S.eng.lines, { ...cl, cand: true }] };
      setLines(s, key);
    }
    if (!live()) return;
    S.eng = { ...S.eng, more: false };
    setLines(s, key);
  }, fallback);
}
// Boards neither engine plays (and engine failures): the solver's forced-win line (9 plies); the solver's facts
// (every win in 1 and 2, verdicts on the pinned moves) join it through setLines like any other line.
async function runSolver(s, key, plies) {
  const live = () => S === s && S.evalKey === key;
  if (!live()) return;
  // down: an engine plays this board but didn't answer (the server, Tiltak): the panel says so in plain words
  const komi = S.p.komi || 0, down = syntaksBoard(S.p.size, komi) || tiltak.supports(S.p.size, komi);
  S.eng = { thinking: true, src: 'solver', down, lines: [] };
  setLines(s, key);
  const res = fromEngine(s, await engine.analyze({ ...enginePos(plies), maxPlies: 9 }));
  if (!res || !live()) return;
  const win = res.kind === 'win' && res.pv?.length;
  // none: the words for a search without a win (engine.js noWinText: a search its budget cut off is inconclusive, not
  // "No forced win")
  S.eng = { thinking: false, src: 'solver', down, none: res.kind === 'none' ? engine.noWinText(res, colorName(res.side)) : null,
    lines: win ? [{ move: res.pv[0], pv: res.pv, ev: { kind: 'win', n: Math.ceil(res.plies / 2), proven: true }, src: 'solver', tags: [] }] : [] };
  setLines(s, key);
}
// The panel's lines from what has arrived for this position, then the panel and the board's mark. A line you picked
// stays picked by its move as lines arrive and reorder; otherwise line 1 is the one selected (a selection kept by move
// when nobody chose it jumped to row 2 when the engine's rows came in above the puzzle's: five1 at its start).
const canonG = new Map(); // size -> an empty Game, to canonicalise moves (parseMove/moveToPTN depend on the size only)
function setLines(s, key) {
  if (S !== s || S.evalKey !== key) return;
  const cg = canonG.get(S.p.size) || canonG.set(S.p.size, new Game(S.p.size)).get(S.p.size);
  const was = S.selUser ? S.lines[S.sel]?.move : null;
  S.lines = mergeLines(S.eng?.lines || [], S.sol, S.pins, 3, (m) => cg.canon(m));
  S.sel = was == null ? 0 : Math.max(0, S.lines.findIndex((l) => l.move === was));
  renderEngine();
  paintShapes();
}
// The board's mark for the analysis: PTN Ninja highlights the squares of line 1's move (ninja.js shapes), whichever line
// is selected below it; the rest is in the text. Only for the position shown.
function paintShapes() {
  if (!ANALYSIS || !S || S.placeholder || S.status !== 'solved' || !S.posG) return;
  const line = shownLine();
  if (S.evalKey !== line.slice(0, S.view ?? line.length).join(' ')) return;
  board.shapes?.(S.lines[0] ? [{ role: 'best', sqs: moveSquares(S.lines[0].move) }] : []);
}

// Play line L on the board, up to and including its move k (as your line).
async function playPV(L, k) {
  const line = shownLine();
  const at = S.view ?? line.length;
  // only lines made for the position shown (PTN Ninja's board loads a line in ~60 ms, before runEngine clears them)
  if (S.evalKey !== line.slice(0, at).join(' ')) return;
  // (only the line's legal moves from here: an engine that printed a bad one would break the branch)
  let pv; try { pv = legalPrefix(gameAt(line.slice(0, at)), S.lines?.[L]?.pv); } catch { return; }
  if (!pv.length) return;
  k = Math.min(k, pv.length - 1);
  const official = officialLine();
  const prefix = S.onBranch && S.branch && at > S.branch.at ? S.branch.moves.slice(0, at - S.branch.at) : [];
  const base = S.onBranch && S.branch ? Math.min(at, S.branch.at) : at;
  const moves = [...prefix, ...pv.slice(0, k + 1)];
  // If the engine's line is exactly the solution continuing, just step along the solution.
  if (!S.onBranch && official.slice(at, at + k + 1).join(' ') === pv.slice(0, k + 1).join(' ')) {
    const to = at + k + 1;
    S.view = to >= official.length ? null : to;
    await showLine(official, to); return afterExplore();
  }
  S.branch = { at: base, moves }; S.onBranch = true; S.view = null; S.loadedKey = null;
  await showLine(shownLine(), shownLine().length);
  afterExplore();
}

// Load a line onto the board and show the position after `idx` plies (no animation).
// (lines.js: a newer call made while this one's load is still waiting wins, so rapid line switches end on the last one)
function showLine(line, idx) { return showLineOn(board, S, line, idx, ptnFor); }

// p: the puzzle as shown (oriented by loadById, pagesym.js); p0: the same puzzle as the server sent it.
// The opponent's threats shown or not (the analysis view's Threats button, or x): their line under the engine lines. Off
// with every new puzzle (S.thr unset); kept while stepping through this one.
function toggleThreats() {
  if (!ANALYSIS || !S || S.placeholder || S.status !== 'solved') return;
  S.thr = !S.thr;
  renderEngine();
}
// x: the Threats button's key (as on Lichess), only while the analysis view is shown, never in a field or with a modifier
window.addEventListener('keydown', (e) => {
  if (!ANALYSIS || e.key !== 'x' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || pend) return;
  if (e.target?.closest?.('input, select, textarea, [contenteditable]') || $('#view-puzzle').classList.contains('hidden')) return;
  if (!S || S.placeholder || S.status !== 'solved' || !$('#moves [data-thr]')) return;
  e.preventDefault(); toggleThreats();
});

async function start(p, theme = '', p0 = p) {
  if (S?.free) leaveFree(S, 'left'); // (its engine stops; nothing to send)
  abandonCheck(S); // leaving a puzzle whose check is still running (any route: Next, a link, a filter change)
  for (const r of runningOn) if (r.p.id === p.id) abandonCheck(r, { again: true }); // (leftRunsOn: no second try while it runs on)
  board.forget(); // nothing begun on the last puzzle's board (stones in hand, a held number key, a touch) carries over
  dropPending(); // a move held on the last puzzle is gone with it (the new position is loaded below)
  engine.interrupt(); tiltak.stop(); anaCtl?.abort(); // nothing from the previous puzzle should still be thinking
  const g = Game.fromTPS(p.tps, p.komi || 0);
  const hist = p.meta?.history || [];
  // theme: the Theme filter this puzzle was picked with (its result is damped as a themed attempt)
  const s = S = { p, p0, x: toServer(p.sym, p.size), g, node: p.tree, solver: g.toMove, hist, moves: [], snaps: [g.toTPS()], view: null, status: 'play', resultSent: false, hinted: false, delta: null, busy: true,
        misses: [], outcome: null, branch: null, onBranch: false, theme: theme && (p.themes || []).includes(theme) ? theme : '',
        t0: null, born: performance.now(), hiddenMs: 0, hiddenAt: null, log: [] };
  board.lock(busyUntil('board', s.born)); // the same lock on the board itself: no stack lifted or cap picked meanwhile
  shadow((o) => { s.ob = o.open(p, s.theme); });
  nextQ.prefetchPair(p);
  buildBarHidden = false; renderBuildBar(true); checkBuild(); // a dismissed bar comes back with the next puzzle
  setNotice(null);
  setTitle();
  renderAll(); // side panel right away
  await board.ui({ disableBoard: true, showRoads: false, dropOnStray: false });
  if (S !== s) return;
  if (hist.length) {
    // Show the game up to just before the opponent's last move, then play that move (Lichess-style).
    const names = gameNames(p);
    await board.load(buildPTN({ size: p.size, komi: p.komi, moves: hist.slice(0, -1), ...names }));
    await board.last();
    if (S !== s) return;
    renderAll();
    setTimeout(async () => {
      if (S !== s) return;
      await board.append(hist.at(-1));
      await board.last();
      if (S !== s) return;
      S.busy = false;
      await board.setPlayer(S.solver);
      await board.ui({ disableBoard: false });
      startClock(s);
      renderAll();
      flushHint(s);
    }, 650);
  } else {
    await board.load(currentPTN());
    await board.last();
    if (S !== s) return;
    S.busy = false;
    await board.setPlayer(S.solver);
    await board.ui({ disableBoard: false });
    startClock(s);
  }
  renderAll();
  flushHint(s);
}

// Solve time: milliseconds the puzzle was actually on screen since the board became playable (a hidden tab, another
// page of the site, or the board loading or down (PTN Ninja's message in its place) pauses the clock). Sent with the result for signed-in players, with each of the solver's moves (and
// any hint or solution view), to calibrate puzzle ratings later.
const offScreen = () => document.hidden || $('#view-puzzle').classList.contains('hidden') || !board.available;
function startClock(s) {
  if (s.t0 != null) return;
  s.t0 = performance.now(); s.hiddenAt = offScreen() ? s.t0 : null;
  setTimeout(() => { if (S === s) wakeActions(); }, BUSY_MS.actions + 30); // Hint and Solution come alive (fresh)
}
// A new puzzle's Hint and Solution take no presses until it has been playable for a second (busy.js 'actions'), and they show as disabled
// until then. Next puzzle sits where they appear (in the card, and on a phone in the dock over the same spot), so the
// second tap of a double tap on Next landed on Solution: a rated miss 16 ms into a puzzle nobody had looked at
// (rabbitboy84, 2026-11-16). A press during the intro isn't remembered for later either (see flushHint).
const fresh = (s) => s.t0 == null || busy('actions', s.t0);
// Turns the card's Hint and Solution on where they stand once the first second is over. Redrawing the card instead
// would have a screen reader read it out a second time (it's a live region) and would cut a "Best move!" short.
// If the card's HTML ever stops matching these strings, the next render simply redraws it.
function wakeActions() {
  if (!board.available) return; // (the board loading or down: they come alive with it, renderAll)
  const fb = $('#feedback');
  for (const b of fb.querySelectorAll(':scope > .actions > [data-act="hint"], :scope > .actions > [data-act="solution"]')) b.disabled = false;
  if (fb._html) fb._html = fb._html.replace('data-act="hint" disabled>', 'data-act="hint">').replace('data-act="solution" disabled title=', 'data-act="solution" title=');
}
// The same double tap can land on the board instead. On a phone the board grows back into the space the dock held, and
// a puzzle with no intro is playable at once, so the second tap put down a flat: a miss. So does the tap after one
// that hit the dock's Next by accident (the player sees their board change and taps again). A move in a puzzle's
// first 700 ms is dropped (busy.js 'board'; with an intro the board is still off for 650 ms of that anyway), on either
// board: both report moves through userMove, and the restore puts PTN Ninja's back too. Only a new puzzle starts it:
// the defender's reply and the reset after a miss stay on the same puzzle, whose result is already sent.
const tooSoon = (s) => busy('board', s.born ?? 0);
// And the other way round: Next puzzle appears where Solution was pressed, so a double tap on Solution skipped the
// solution it asked for. Next takes no press for a moment after Solution.
const justViewed = () => S?.viewT0 != null && busy('next', S.viewT0);
// And when the result first shows (busy.js 'ended'): on a phone the dock with Next puzzle appears over the board's
// lower rows and the tray (fitDock shrinks the board above it), so a tap aimed at the board as a play-out ends on the
// defender's instant last move pressed Next, and the tap after that landed on the new puzzle: a rated miss. Next
// (card, dock), Enter and the update bar's Reload take no press until the result has been up for a second.
const justEnded = () => S?.status === 'solved' && !S.placeholder && endLocked(S.endT0);
function elapsed(s = S) {
  if (s?.t0 == null) return null;
  const t = performance.now();
  return Math.round(t - s.t0 - s.hiddenMs - (s.hiddenAt != null ? t - s.hiddenAt : 0));
}
// Pause or resume the clock to match whether the puzzle is on screen.
function syncClock() {
  if (!S || S.t0 == null) return;
  const t = performance.now(), off = offScreen();
  if (off) S.hiddenAt ??= t;
  else if (S.hiddenAt != null) { S.hiddenMs += t - S.hiddenAt; S.hiddenAt = null; }
}
// ms: when the move was made (callers read it before any engine check, which can take seconds).
// (logOk: within what the server keeps, else nothing more is added: a long play-out keeps its log's head)
const logMove = (k, m, ms = elapsed()) => { if (S && !S.resultSent && S.t0 != null && logOk(S.log, ms)) S.log.push(m ? { m, ms, k } : { ms, k }); };
document.addEventListener('visibilitychange', syncClock);

const pliesLeft = () => pliesLeftOf(S.node); // (playon.js: Rush's play-outs use it too)

// Put the board back to exactly the moves we've accepted (after a wrong move, or after browsing history).
// s: the puzzle it was asked for; if another one has started meanwhile (PTN Ninja's load really waits), it stops.
async function restoreBoard(s = S) {
  await board.load(currentPTN());
  if (S !== s) return;
  S.loadedKey = null;
  await board.last();
  if (S !== s) return;
  S.view = null;
  const live = S.status === 'play' || S.status === 'retry';
  await board.ui({ disableBoard: !live });
  if (S !== s) return;
  if (live) await board.setPlayer(S.solver);
  if (live && S.hint?.node === S.node && S.hint.at === S.moves.length) await board.highlight(S.hint.sqs); // a reload clears it
  if (S !== s) return;
  renderAll();
}

async function userMove(ptn) {
  if (!S || S.placeholder) return; // the board is disabled until a puzzle arrives
  if (S.status === 'solved') return explore(ptn);
  if (S.free) return freeMove(ptn); // the free game after a miss (its own section: nothing there is judged)
  if (S.playOn) return playOnMove(ptn);
  if (tooSoon(S)) { restoreBoard(); return; } // a tap meant for the last puzzle's Next, landing on the new board
  if (!S || S.placeholder || S.busy || S.view != null || !(S.status === 'play' || S.status === 'retry')) { if (S) restoreBoard(); return; }
  const g = S.g;
  let canon;
  try { canon = g.canon(ptn); } catch { restoreBoard(); return; }
  if (!g.legalMoves().some((m) => g.moveToPTN(m) === canon)) { restoreBoard(); return; }
  const node = S.node, tMove = elapsed();
  let correct = false, reply = null, next = null, wonNow = false, said = null; // said: fills this move's shadow ply
  const u = g.apply(g.parseMove(canon));
  const res = g.result();
  if (res && res.winner === S.solver) { correct = true; wonNow = true; }
  else if (node !== 'win' && node && Object.prototype.hasOwnProperty.call(node, canon) && !res) {
    correct = true; reply = node[canon]?.r; next = node[canon]?.n;
  }
  // A proven win the puzzle's tree doesn't list is a solve, whatever its length; where Syntaks defends (6×6) it is first
  // played out to a road (a proven play-out: startPlayOn with proven; playon.js provenPlayOut / lossRated). Where 7+ plies are left (the root of
  // a deep puzzle included) the tree has Tak threats only, so such a win can be slower, the same length or (a quiet
  // move: pd575074 38. 4c3+, alion 2026-11-16) faster; only where ≤5 plies are left is the tree exhaustive, so there
  // it is slower.
  // Precomputed lists (alts at the root, altsAt in 5-ply lines) answer at once. Any other off-tree move, at any node
  // of any puzzle, gets ~2.5 s of the engine to prove it wins or to find that no Tak-threat win exists (the lists don't
  // cover 7×7/8×8, the first moves the precompute left undecided, or anything past the root of a deep puzzle: rated
  // misses on crux 2026-11-15 were real wins there). Undecided by then: where an engine can defend (6×6 Syntaks, 4×4/5×5
  // Tiltak) the move is played out on the board (startPlayOn); elsewhere the board carries on as after a miss, but the
  // result is held while the search runs on (≤60 s, settleCheck): a 'no' (no forced win made of Tak threats; quiet or
  // flat-count wins are invisible to the prover) sends the miss, a proof makes it a solve, and no answer sends it
  // unrated. A timeout is never a miss: Boris's f5 on pd616580 won but took ~20 s to prove, and was charged.
  // A 'win' node (road-in-1 on the board) is the same: a move that still forces the win, e.g. a double threat instead
  // of the road, is a solve too (Shy, 2026-11-15; alion02 on pd528655).
  const s = S;
  if (!correct) {
    g.undo(u);
    // The move being checked, played again where it was: still being checked, not a second miss.
    if (S.checkPending?.miss === canon && S.checkPending.at === S.moves.length) { restoreBoard(); return; }
    shadow((o) => { said = o.hold(s.ob, canon, { ms: tMove }); });
    const say = (v) => shadow(() => said?.(v));
    S.busy = true;
    const plies = [...officialLine(), canon];
    let pending = null;
    if (!res && node) {
      const key = provenKey(canon), known = S.proven?.get(key);
      let wins = known === 'wins' || (node !== 'win' && slowerWins().includes(canon));
      const po = playOnDefender();
      if (!wins && !known) {
        S.checking = canon;
        renderAll();
        // Only the first unsettled check can decide the result; a later one is only worth its quick answer, so it
        // gets a small budget (each worker can take hundreds of MB).
        const minor = !!(S.checkPending || S.resultSent);
        const chk = engine.checkStill({ ...enginePos(plies), attacker: S.solver }, minor ? { budgets: [[3e4, 5e3]] } : {});
        // Leaving (or reloading) during the quick check mustn't be a free retry: the attempt is held from here
        // (abandonCheck sends it, unrated: the move was never settled), and the stored next puzzle mustn't be this one.
        const qc = minor ? null : (S.quickCheck = { miss: canon, chk, tMove });
        if (qc) { heldRec.set({ id: S.p.id, ms: tMove }); if (store.get('next', null)?.puzzle?.id === S.p.id) store.del('next'); }
        const quick = await chk.quick;
        if (S !== s || (qc && s.quickCheck !== qc)) { chk.cancel(); return; } // (left: abandonCheck has sent it)
        S.checking = null;
        // Decided: sent as usual. A 'no' goes out now (fail); a win only after the board is put back (slowSolve), so its
        // record stays until report() re-stamps it as the solve (left in between, a reload sends it unrated).
        if (qc) { S.quickCheck = null; if (quick === 'no') heldRec.del(S.p.id); }
        // An earlier held check settled the puzzle while this one ran (solved): this move no longer counts for anything.
        if (S.status !== 'play' && S.status !== 'retry') {
          say('ignored');
          chk.cancel();
          if (S.status === 'solved') { S.loadedKey = null; await showLine(shownLine(), S.view ?? shownLine().length); if (S === s) afterExplore(); }
          return;
        }
        wins = quick === 'wins';
        const out = quickOutcome(quick, minor);
        if (out === 'wins' || out === 'no') (S.proven ||= new Map()).set(key, out);
        if (out === 'wins') (S.proofPlies ||= new Map()).set(key, chk.info?.plies ?? null); // (for a proven play-out's cap)
        else if (out === 'unchecked') { chk.cancel(); (S.uncheckedMoves ||= new Set()).add(canon); }
        else if (out === 'pending') pending = chk;
      }
      if (pending && po) { say('play'); return startPlayOn(s, canon, plies, pending, tMove); }
      // A proven win is played out to a road where Syntaks defends (a proven play-out, 6×6); with Tiltak (4×4/5×5) or no
      // defender (7×7/8×8) it is solved on the spot. (Not while another move's check is still held: that one owns the
      // held result.)
      if (wins) { const out = provenPlayOut(po) && !S.checkPending; say(out ? 'play' : 'solved'); return out ? startPlayOn(s, canon, plies, null, tMove, true, S.proofPlies?.get(key)) : slowSolve(canon, tMove, node); }
    }
    say(pending ? 'pending' : 'missed');
    const hadMs = S.decidedMs != null, logged = S.log.length;
    logMove('miss', canon, tMove); S.decidedMs ??= tMove;
    S.misses.push({ at: S.moves.length, ptn: canon });
    if (pending) {
      S.checkPending = { miss: canon, at: S.moves.length, key: provenKey(canon), chk: pending, hadMs, logLen: S.log.length,
        logEntry: S.log.length > logged ? S.log.at(-1) : null, flags: { hinted: S.hinted } };
      // In case the page dies before the result is sent: a reload of this tab sends it unrated (flushHeld), and the
      // stored next puzzle mustn't be this one (the server will count it as played either way).
      heldRec.set({ id: S.p.id, ms: tMove });
      if (store.get('next', null)?.puzzle?.id === S.p.id) store.del('next');
      pending.final.then((v) => { if (s.checkPending?.chk === pending) settleCheck(s, v); });
    }
    const remaining = pliesLeft();
    S.refutation = { miss: canon, kind: 'thinking' };
    engine.refute({ ...enginePos(plies), attacker: S.solver, remaining }).then((r) => {
      r = fromEngine(s, r);
      if (r && S === s && S.refutation?.miss === canon) { S.refutation = { miss: canon, ...r }; renderAll(); }
    });
    fail(tMove);
    setTimeout(() => {
      if (S !== s) return;
      S.busy = false;
      // A held check proved a win meanwhile (settleCheck): the puzzle is solved, so its board stays open for exploring.
      if (S.status === 'solved') { S.loadedKey = null; showLine(shownLine(), S.view ?? shownLine().length).then(() => { if (S === s) afterExplore(); }); return; }
      restoreBoard().then(() => flushHint(s));
    }, 700);
    return;
  }
  logMove('ok', canon, tMove);
  shadow((o) => o.move(s.ob, canon, { clientVerdict: wonNow ? 'solved' : 'ok', ms: tMove }));
  if (wonNow) S.decidedMs ??= tMove;
  S.moves.push({ ptn: canon, me: true }); S.snaps.push(g.toTPS());
  S.refutation = null;
  if (wonNow) return solved();
  S.node = next;
  S.status = 'play';
  S.busy = true;
  renderAll('good');
  setTimeout(async () => {
    if (!reply || S !== s || S.status !== 'play') return; // (a held check may have ended the puzzle meanwhile)
    g.play(reply);
    S.moves.push({ ptn: reply, me: false }); S.snaps.push(g.toTPS());
    await board.append(reply);
    await board.last();
    if (S !== s) return;
    S.busy = false;
    renderAll();
    flushHint(s);
  }, 450);
}

// flags: the hint state the result is judged by (a held miss is judged as it was when it was played).
async function report(win, s = S, flags = s, { keepalive = false, ms } = {}) {
  if (s.resultSent) return;
  if (s.checkPending) { // sent once the check settles (settleCheck), judged as it stands now
    (s.held ||= []).push({ win, hinted: flags.hinted, ms: ms ?? elapsed(s) });
    renderAll(); return;
  }
  s.resultSent = true;
  // Unrated: a hint before the result, or a miss whose check never answered (it may have been a win).
  // A game won against Tiltak (playon.js gameRated) is an unrated solve.
  s.casual = flags.hinted || (!win && !!s.unchecked) || (win && !!flags.playOn?.unrated);
  s.casualWhy = flags.hinted ? 'hint' : !s.casual ? null : win ? 'tiltak' : 'unchecked';
  // (the log's moves in the puzzle's own orientation: pagesym.js toServer)
  const p = s.p, timing = { ms: (s.decidedMs ?? elapsed(s)) ?? undefined, log: s.log.length ? s.x.log(s.log) : undefined };
  let answered = false;
  // Sent as the page goes away: this request carries the result, so the held copy isn't flushed again (unrated) on the
  // next load; otherwise which of the two reached the server first would decide (a play-on left by reloading is rated).
  if (keepalive) heldRec.del(p.id);
  // A held result settled now: if the page reloads before the server has it, flushHeld sends this result (under this
  // build), not an unrated miss (the server keeps only the first, so a resend of one that landed changes nothing).
  else if (heldRec.get()?.id === p.id) heldRec.set(settledHeld(p.id, timing, win, s.casual, s.theme));
  try { // a failed upload (network, server restart) loses this result (a held one waits for a reload), not the session
    // noWait: a slow upload mustn't swap the card (and its Hint button) for the waiting notice; a failed one still says so
    const si = signIn; // (a sign-in while this is on its way keeps its token: answerOwnsToken)
    const req = api(withBuild('/api/result'), { puzzleId: p.id, win, ...(s.casual ? { casual: true } : { theme: s.theme || undefined }), ...timing,
      ...(token ? {} : { guest: guestSeed() }) }, { noWait: true, keepalive }); // the first result makes a first-time visitor a guest
    reporting.add(req); req.catch(() => {}).finally(() => reporting.delete(req)); // (a reload for a newer build waits for it)
    uploading.set(p.id, req); req.catch(() => {}).finally(() => { if (uploading.get(p.id) === req) uploading.delete(p.id); });
    const r = await req;
    if (uploading.get(p.id) === req) uploading.delete(p.id); // answered: done now, not a tick later in its finally(), so the card below is drawn once
    const ours = answerOwnsToken(si, signIn);
    if (r.token && ours) { setToken(r.token); ownHeld(); }
    // Refused: 429 (too many results, or too many new guests from one address) or any other error; nothing was rated.
    if (!r.user && r.error) s.notCounted = /^too many/i.test(r.error) ? 'rate' : 'error';
    if (r.user) {
      heldRec.del(p.id); // recorded: nothing left to resend (a failed upload keeps it for the next load)
      answered = true;
      s.delta = r.rated ? r.userDelta : null; s.serverRated = !!r.rated;
      s.repeat = !r.rated && !s.casual; // played before, or a miss from an out-of-date page (the server doesn't say which)
      // Like Lichess, the info panel keeps the rating the puzzle had when you played it (what you were up
      // against), not the one your result just moved it to.
      if (r.rated) p.attempts++;
      if (ours) { me = r.user; renderUser(); } // (else it's the guest this result went in under, not who's signed in now)
    }
  } catch { s.delta = null; s.notCounted = 'lost'; }
  // Not recorded, but the held copy is still there: a reload of this tab sends it (flushHeld). The cards say which.
  s.resend = !answered && !keepalive && heldRec.get()?.id === p.id;
  session.push({ id: p.id, win, delta: s.delta }); saveSession();
  renderAll();
  // The pair assumed this result counts (or is a repeat, which it allows for); if unrated or lost, ask again.
  if (S === s) nextQ.prefetchNext(win, p.id, !s.casual && answered);
}

// A held result once its slow check settles (s may no longer be the puzzle on screen). 'wins': the miss was a proven
// win after all, which is a solve (see below). 'no': no Tak-threat win was found, so the miss is sent as it stood when
// played (rated, unless a hint came first). 'unknown': it might have won, so the miss is sent unrated.
function settleCheck(s, verdict, opts) {
  const c = s.checkPending, held = s.held || [];
  if (!c) return;
  s.checkPending = null; s.held = null; runningOn.delete(s);
  let sent;
  if (verdict === 'wins' || verdict === 'no') (s.proven ||= new Map()).set(c.key, verdict);
  if (verdict === 'wins') {
    // The "miss" was a proven win, and any proven win is a solve (slowSolve): it is the result, sent as a win at the time
    // it was played; whatever happened after it doesn't count. Still on that puzzle, it ends there as solved.
    // (Misses after it went in with it, as did any later move left unchecked.)
    const i = s.misses.findIndex((m) => m.ptn === c.miss && m.at === c.at);
    if (i >= 0) s.misses.length = i;
    s.uncheckedMoves = null;
    if (c.logEntry) c.logEntry.k = 'slow';
    s.log.length = Math.min(s.log.length, c.logLen);
    if (!c.hadMs) s.decidedMs = held[0]?.ms;
    s.slowWin = { move: c.miss, fastest: c.fastest ?? null, playOn: c.flags.playOn };
    // The result is this win, whether or not the solution was looked at after it. While the solution is still being
    // played out, its end (showSolution) finishes the puzzle; the board is left to the animation until then.
    const viewing = s.status === 'viewing';
    if (s.status !== 'solved' && !viewing) { s.status = 'solved'; s.refutation = null; }
    s.outcome = s.misses.length ? 'miss' : 'clean';
    sent = report(true, s, c.flags, opts);
    if (S === s && !viewing) { S.busy = false; openExploration(); }
  } else {
    // A move played out that wasn't won is a miss whatever the check says: rated only if Syntaks defended throughout
    // and moved at least once (gameRated: Tiltak, a dropout or no defender move make it unrated). Without play-on,
    // the check decides.
    // (a proven play-out: lossRated, see playon.js)
    const po = c.playOn, unrated = !po ? verdict !== 'no' : !lossRated(po, po.end);
    if (unrated) { s.unchecked = c.miss; s.uncheckedWhy = po ? { why: po.end === 'noengine' ? 'noengine' : lossWhy(po, po.end), at: po.fallbackAt || 0, engine: defenderName(po), rule: po.rule } : null; }
    s.log.length = Math.min(s.log.length, c.logLen); // the miss decided it: nothing after it belongs in its log
    sent = report(false, s, c.flags, opts);
  }
  if (S === s) renderAll();
  return sent;
}

// Leaving a puzzle (or the page) while its check runs: there's no answer to wait for, so the miss goes in unrated.
// opts.auth: a log-out or log-in (the result goes out now, under the identity that played it); opts.again: the same
// puzzle opened again (its result goes out now, before the new attempt's could land first and stand instead).
function abandonCheck(s, opts) {
  shadowLeave(s, opts?.keepalive ? 'unload' : 'leave');
  if (!s?.checkPending) return s?.quickCheck ? abandonQuick(s, opts) : null;
  // Out under the Tak rule with the check still running, and on to another puzzle: the check isn't stopped; it settles
  // this puzzle in the background (startPlayOn's handler), so a proof that lands then still makes it unrated (leftRunsOn).
  if (leftRunsOn(s.checkPending, opts?.keepalive ? 'unload' : opts?.auth ? 'auth' : opts?.again ? 'again' : 'left')) { runningOn.add(s); return null; }
  // Leaving in the middle of a play-on counts as giving up (rated miss), or leaving would be the way out of a lost game.
  // ('unload': the page itself is going away (pagehide); 'left': on to another puzzle in this page. Ordinary play-on
  // treats them alike; a proven play-out lost to the page going away is unrated: playon.js lossRated.)
  if (s.playOn && !s.playOn.end) { const sent = endPlayOn(s, opts?.keepalive ? 'unload' : 'left', opts); if (!s.checkPending) return sent; }
  s.checkPending.chk.cancel();
  return settleCheck(s, 'unknown', opts);
}
// Left during a first move's quick check (userMove): the same, an unrated miss. The move is logged on s itself (S may
// be on its way to the next puzzle), and if this puzzle stays on screen after all (restoreLeft) it goes on as after a
// miss; the check's late answer is ignored (userMove sees quickCheck gone).
function abandonQuick(s, opts) {
  const { miss, chk, tMove: ms } = s.quickCheck;
  s.quickCheck = null; s.checking = null; chk.cancel();
  if (s.resultSent) return null;
  if (s.t0 != null && logOk(s.log, ms)) s.log.push({ m: miss, ms, k: 'miss' });
  s.decidedMs ??= ms;
  s.misses.push({ at: s.moves.length, ptn: miss });
  s.unchecked = miss; s.status = 'retry'; s.refutation = null; s.needsRestore = true;
  return report(false, s, s, { ...opts, ms });
}
// Puzzles left while their check runs on (abandonCheck, leftRunsOn): each leaves the set when it settles (settleCheck).
// The page going away, or a log-out or log-in, settles them all now (a rated miss each: the card said so).
const runningOn = new Set();
const abandonAll = (opts) => Promise.all([abandonCheck(S, opts), ...[...runningOn].filter((s) => s !== S).map((s) => abandonCheck(s, opts))]);
addEventListener('pagehide', () => { abandonAll({ keepalive: true }); shadow((o) => o.pagehide()); });
// A result held when the page died (crash, a keepalive that didn't make it, or an upload that failed), before anything
// is served: what it goes as, or whether it's dropped, is playon.js heldResend. Unreachable: kept for the next load.
async function flushHeld() {
  const h = heldRec.get();
  if (!h?.id) return null;
  const send = heldResend(h, owner(), await pageAlive(h.page));
  if (!send) return heldRec.del(h.id);
  try {
    // (registered like report()'s, so a record that is still being flushed when the first puzzle displaces it waits)
    const si = signIn;
    const req = api(withBuild('/api/result', send.build), { ...send.body, ...(token ? {} : { guest: guestSeed() }) }, { quiet: true });
    uploading.set(h.id, req); req.catch(() => {}).finally(() => { if (uploading.get(h.id) === req) uploading.delete(h.id); });
    const r = await req;
    if (r?.token && answerOwnsToken(si, signIn)) setToken(r.token);
    heldRec.del(h.id);
  } catch {}
}

// ---------- play on ----------
// A move the still-wins check can't decide in 2.5 s is played out on the board: the move stays and an engine defends
// (Syntaks on the server for 6×6, Tiltak in the browser for 4×4/5×5; spec agreed with Shy 2026-11-15). Your road or
// flat win within capMoves (playon.js) is a solve like any other proven win (3421d53): the game
// becomes the puzzle's line and the puzzle ends there. Syntaks holding (out of moves, its road, flats or a draw), Give
// up or leaving is a miss. Which of these count toward rating is playon.js's gameRated / winRated (only a game Syntaks
// defended throughout; Tiltak, a dropout, no defender move or a stalled reply make it unrated both ways, while a proof
// always counts). The check runs on meanwhile: a proof makes it a proven play-out (or, against Tiltak, a solve at once),
// and a 'no' ends the game there as a miss (Sasha, 2026-11-21: judge.js endsOnNo, playon.js noEnding; it used to be
// ignored, the game deciding, which left unlimited rated tries at catching the engine out). The result is held as for
// a pending check (checkPending with .playOn), so settleCheck sends it, and a reload resends what was settled
// (flushHeld). No engine at all ('noengine') sets po.fallback: unrated whatever the check says.
const playOnDefender = () => defender(S.p.size, S.p.komi || 0, tiltak.supports);
// (defenderName, playon.js: 6×6 is Syntaks's even where it can't run in this browser (no WebAssembly SIMD): crux answers
// every reply then.)
// (gameRated, playon.js: a weak reply can let a move that doesn't force the win "win", so only a game Syntaks defended
// throughout counts toward rating; a win against Tiltak is an unrated solve. A proof always counts.)

// proven: the move is already proven to win (a proven play-out: playon.js winRated / lossRated); chk is then null.
// proofPlies: that proof's length if known (the cap is at least its moves: provenCap); unknown, it's measured now (proofLength).
function startPlayOn(s, canon, plies, chk, tMove, proven = false, proofPlies) {
  const hadMs = s.decidedMs != null, logged = s.log.length, left = pliesLeft();
  logMove(proven ? 'slow' : 'miss', canon, tMove); s.decidedMs ??= tMove;
  if (!proven) s.misses.push({ at: s.moves.length, ptn: canon }); // (a proven play-out's move is a miss only if it fails)
  chk ||= { final: new Promise(() => {}), cancel() {} }; // nothing left to check
  // (the Tak rule: the move played out is counted too, playon.js playOutOf)
  const g = gameAt(plies), po = s.playOn = playOutOf({ miss: canon, at: s.moves.length, base: plies.slice(0, -1), g, proven, left, key: provenKey(canon), engine: playOnDefender(), tak: isTak(g, s.solver) });
  if (proven) setProofLength(s, po, proofPlies);
  s.checkPending = { miss: canon, at: s.moves.length, key: provenKey(canon), chk, hadMs, logLen: s.log.length, playOn: po,
    fastest: s.node === 'win' ? finisher(s.g) : Object.keys(s.node)[0], // the puzzle's own move here, for the solved card
    logEntry: s.log.length > logged ? s.log.at(-1) : null, flags: { hinted: s.hinted } };
  // (a page that dies mid-game: an unrated miss, flushHeld; none once the result is in, e.g. a proven move after a miss)
  if (!s.resultSent) heldRec.set({ id: s.p.id, ms: tMove });
  if (store.get('next', null)?.puzzle?.id === s.p.id) store.del('next');
  chk.final.then((v) => {
    const c = s.checkPending;
    if (c?.chk !== chk) return;
    // (after 'noengine', or after running out under the Tak rule: the check runs on. A proof then makes that 'out' an
    // unrated miss, never a rated one: lossRated provedAtOut)
    if (c.playOn.end === 'out' && v === 'wins') { po.proven = po.provedAtOut = true; return settleCheck(s, 'unknown'); }
    if (c.playOn.end) return settleCheck(s, v);
    if (v === 'wins') return makeProven(s, po); // a proof makes it a proven play-out
    c.final = v; // an 'unknown' waits (the game decides), and so does a 'no' in a proven play-out (none: proven has no check)
    // A 'no' ends the play-out as a miss (judge.js endsOnNo, Sasha 2026-11-21): now on the player's turn, else once the
    // defender's reply is on the board (defenderTurn), or as 'out' at the end of the wait it is answering (playon.js noEnding).
    if (noEnding(po, v, { busy: s.busy }) === 'now') endPlayOn(s, REFUTED);
  });
  defend.warmDefender(po, s.p.size, s.p.komi || 0); // (Syntaks fetched on first use, or Tiltak started: defend.js)
  // Give up sits where Hint was: it ignores clicks for its first 1.5 s, so one meant for Hint can't end the game
  po.t0 = performance.now(); setTimeout(() => { if (S === s && s.playOn === po) renderAll(); }, BUSY_MS.giveup + 100);
  s.status = 'playon'; s.refutation = null; s.checking = null;
  s.pendingHint = s.pendingSolution = false; // pressed during the quick check: not meant for after the game
  report(false, s, s, { ms: tMove }); // held until the game (and the check) settle
  defenderTurn(s, po);
}

// The check proved the move wins in the middle of the game. Against Syntaks it goes on as a proven play-out (to a road;
// the win always counts; failing it, giving up, the solution or leaving is a rated miss once Syntaks has defended and
// moved, the page going away isn't: lossRated), its cap raised to cover the proof if need be. Against Tiltak (from the
// start, or after Syntaks dropped out) there's no proven play-out: it ends as a solve now.
function makeProven(s, po) {
  const c = s.checkPending;
  if (po.proven || po.end || c?.playOn !== po) return;
  if (!upgradeToProven(po)) return endPlayOn(s, 'proved'); // (playon.js: Tiltak defends, so no proven play-out)
  // Proved while waiting at the end under the Tak rule (playOnMove): the countdown has run down, so it ends 'out', but
  // unrated (lossRated provedAtOut). (Under the cap the proof could raise the cap and the game went on.)
  if (po.rule === 'tak' && po.waiting === 'proof') po.provedAtOut = true;
  c.final = 'wins';
  (s.proven ||= new Map()).set(c.key, 'wins');
  if (c.logEntry) c.logEntry.k = 'slow';
  const i = s.misses.findIndex((m) => m.ptn === po.miss && m.at === po.at);
  if (i >= 0) s.misses.splice(i, 1);
  const plies = c.chk.info?.plies;
  if (Number.isFinite(plies)) (s.proofPlies ||= new Map()).set(c.key, plies); // (a retry of this move uses it)
  setProofLength(s, po, plies);
  if (S === s) renderAll();
}
// A proven play-out's cap: the puzzle's moves left plus spare, or the proof's own moves if more (playon.js provenCap;
// never lower than the cap already shown, whose note then stays). A length not known yet is measured in the engine
// worker; until it is (or if it can't be), running out of moves is unrated.
function setProofLength(s, po, plies) {
  if (applyProofLength(po, plies)) { if (S === s) renderAll(); return; } // (playon.js: the cap and its note)
  if (plies === null) return; // measured, but not measurable: stays unknown
  // (po.lengthP while it's measured: at the cap the game waits for it, playOnMove; a result is kept for a retry)
  measureProof(po, () => engine.proofLength({ ...enginePos([...po.base, po.miss]), attacker: s.solver, budget: 1e5 }), (r) => {
    if (!r) return; // superseded or stopped (another puzzle): not measured
    (s.proofPlies ||= new Map()).set(po.key, Number.isFinite(r.plies) ? r.plies : null);
    if (S !== s || s.playOn !== po || po.end) return;
    if (Number.isFinite(r.plies)) setProofLength(s, po, r.plies);
  });
}

// Syntaks's reply: defend.js (in the browser, else crux's /api/defend; Rush's play-outs call the same). s.x: crux is
// asked about the position in the puzzle's own orientation, and its move comes back in the page's labels.
async function syntaksReply(s, po, tps, komi, live) { return defend.syntaksReply(po, tps, komi, live, s.x); }

// The defender's reply: Syntaks (syntaksReply), else Tiltak in the browser for the rest of this game.
async function defenderTurn(s, po) {
  const live = () => S === s && s.playOn === po && !po.end;
  const typed = document.activeElement?.id === 'ptn-in'; // a keyboard player gets the move box back after the reply
  po.thinking = true; po.thinkingSince = performance.now(); s.busy = true;
  await board.ui({ disableBoard: true });
  renderAll();
  const komi = s.p.komi || 0, tps = po.g.toTPS();
  // Syntaks, else Tiltak (defend.js; Syntaks dropping out sets po.fallback and redraws)
  const d = await defend.defenderMove(po, { size: s.p.size, komi, tps, live, onFallback: renderAll, reply: (po, tps, komi, live) => syntaksReply(s, po, tps, komi, live) });
  if (!d) return;
  // Syntaks dropped out of a proven play-out: no playing it out against Tiltak; the proven move is the solve.
  if (d.end === 'proved') { po.thinking = false; return endPlayOn(s, 'proved'); }
  if (d.end) return endPlayOn(s, 'noengine'); // (no engine moved: po.fallback is set)
  const mv = d.mv;
  po.thinking = false; // the reply is in hand: leaving while the board plays it isn't the defender being overdue (stalls)
  po.g.play(mv); po.line.push(mv);
  logMove('po', replyEntry(mv)); // (so a play-out can be judged again from its log: playon.js replyEntry)
  await board.append(mv); await board.last();
  if (!live()) return;
  const end = ending(po.g.result(), s.solver);
  if (end) return endPlayOn(s, end);
  // A 'no' that came while the reply was being chosen or played: the play-out ends here, before the player's turn opens
  // (playon.js noEnding 'reply'; the reply's own ending, just above, stands first).
  const c = s.checkPending;
  if (c?.playOn === po && noEnding(po, c.final) === 'now') return endPlayOn(s, REFUTED);
  po.thinking = false; s.busy = false;
  await board.setPlayer(s.solver);
  await board.ui({ disableBoard: false });
  renderAll();
  if (typed && live()) $('#ptn-in').focus();
}

// Your move in the game: checked against the game's own position, then the defender answers.
async function playOnMove(ptn) {
  const s = S, po = s.playOn;
  const back = () => showPlayOn(s);
  if (po.end || po.thinking || s.busy) return back();
  let canon;
  try { canon = po.g.canon(ptn); } catch { return back(); }
  if (!legalMove(po.g, canon)) return back();
  po.g.play(canon); po.line.push(canon); po.mine++;
  logMove('po', canon);
  const end = ending(po.g.result(), s.solver);
  shadow((o) => o.move(s.ob, canon, { clientVerdict: !end ? 'reply' : end === 'win' ? 'solved' : 'missed', ms: elapsed(s) }));
  if (end) return endPlayOn(s, end);
  if (po.rule === 'tak') countTak(po, isTak(po.g, s.solver)); // (the Tak rule: one winMove call, microseconds)
  if (outOfMoves(po)) {
    // Out of moves (the cap, or the Tak rule's countdown run down), unless what's still being worked out could change
    // that: the proof's length (proven) or the proof itself (unproven, Syntaks). Wait for it (moves blocked; Give up,
    // Solution and leaving still work, and the wait isn't the defender being overdue), then go on if the cap rose.
    const c = s.checkPending;
    const why = capWait(po, { lengthPending: !!po.lengthP, checkLive: c?.playOn === po && c.final === undefined });
    if (why) {
      po.waiting = why; s.busy = true; await board.ui({ disableBoard: true }); renderAll();
      await defend.waitAtCap(po, why, c.chk.final); // (CAP_WAIT_MS, visible time; makeProven runs first)
      if (S !== s || s.playOn !== po || po.end) return;
      po.waiting = null;
    }
    if (outOfMoves(po)) return endPlayOn(s, 'out');
  }
  defenderTurn(s, po);
}
// Put the board back to the game as played (after a refused move).
async function showPlayOn(s) {
  if (S !== s || !s.playOn) return;
  await board.load(ptnFor([...s.playOn.base, ...s.playOn.line]));
  S.loadedKey = null;
  await board.last();
}

// The game is over. A win (your road or the check's proof) is a solve; anything else makes it a
// miss, sent once the check has answered too (a later proof still makes it a solve).
function endPlayOn(s, kind, opts) {
  const po = s.playOn, c = s.checkPending;
  if (!po || po.end) return;
  if (kind === 'gaveup') shadow((o) => o.act(s.ob, 'giveup', { ms: elapsed(s), seen: Math.floor(po.line.length / 2) }));
  // Left while Syntaks was overdue with a reply (Give up, Solution, leaving): that game doesn't count (gameRated).
  if (stalls(po, kind, performance.now())) po.stalled = true;
  po.end = kind; po.thinking = false; po.ctl?.abort();
  if (c?.playOn === po) c.logLen = s.log.length; // the game's moves belong in this result's log
  if (kind === 'win' || kind === 'proved') {
    // The game becomes the puzzle's line (the board already shows it) and the puzzle ends there, solved (settleCheck).
    s.playOn = null; s.loadedKey = null;
    po.line.forEach((m, j) => { s.g.play(m); s.moves.push({ ptn: m, me: j % 2 === 0, po: j > 0 }); s.snaps.push(s.g.toTPS()); });
    if (c?.playOn === po) {
      c.flags.playOn = { how: kind, engine: defenderName(po), unrated: !winRated(po, kind), why: unratedWhy(po), proven: !!po.proven };
      settleCheck(s, 'wins', opts); c.chk.cancel();
    }
    return;
  }
  s.playOn = null;
  s.status = 'retry';
  if (S === s && kind !== 'left' && kind !== 'unload') sound.verdict('wrong', 120); // a lost play-out (not one left), after its last move's sounds
  if (po.proven) s.misses.push({ at: po.at, ptn: po.miss }); // a proven play-out not finished: a miss on the card
  // byYou: the last ply was the player's (line[0] is theirs), e.g. a move that completed only the defender's road
  s.refutation = { miss: po.miss, kind: 'playon', how: kind, n: po.mine, engine: defenderName(po), proven: !!po.proven, rule: po.rule,
    byYou: po.line.length % 2 === 1 };
  if (kind === 'noengine') s.refutation = { miss: po.miss, kind: 'unknown' };
  // A lost game (Syntaks held, out of moves, Give up, left) is final: the check is stopped and the miss sent now, rated
  // only if gameRated (settleCheck). With no engine at all ('noengine', po.fallback set) the check still runs, so a
  // proof can make it a solve, but a miss is unrated whatever it says.
  let sent = null;
  // Out under the Tak rule with the check still running (it outlasted the wait at the end): it runs on, and the result
  // is held until it answers (startPlayOn's handler), so running out never pre-empts a proof (2026-11-21).
  const runOn = kind === 'noengine' || (kind === 'out' && po.rule === 'tak');
  // Ended by the check's 'no' (judge.js endsOnNo): a move waiting for Confirm was never accepted, so it is dropped (a
  // later Confirm would play it on the retry position), and the miss goes in as the 'no' it is (settleCheck: rated as
  // any other lost play-out, lossRated; the verdict is kept, so the same move played again is a miss at once).
  if (kind === REFUTED) { if (pend?.s === s) dropPending(); if (c?.playOn === po) sent = settleCheck(s, 'no', opts); }
  else if (c?.playOn === po) {
    if (!runOn || po.proven) { c.chk.cancel(); sent = settleCheck(s, 'unknown', opts); } // (proven: nothing to wait for)
    else if (c.final) sent = settleCheck(s, c.final, opts);
    // (held on: the game's log goes into the held record, so a page that dies before the check answers resends the
    // unrated miss with it, playon.js heldResend)
    if (s.checkPending === c && !s.resultSent && heldRec.get()?.id === s.p.id) heldRec.set(runOnHeld(heldRec.get(), s.log.length ? s.x.log(s.log) : null));
  }
  if (kind === 'left' || kind === 'unload') { s.needsRestore = true; return sent; } // the board is put back only if this puzzle stays (restoreLeft)
  s.busy = true;
  if (S === s) { renderAll(); restoreBoard().then(() => { if (S !== s) return; s.busy = false; renderAll(); flushHint(s); }); }
  return sent;
}
// A puzzle left mid-game that is still on screen after all (Next failed to load, or the page came back from the
// back/forward cache): put the board back to its accepted moves.
function restoreLeft() {
  if (!S?.needsRestore) return;
  const s = S;
  s.needsRestore = false; s.busy = false;
  restoreBoard().then(() => flushHint(s));
}
addEventListener('pageshow', (e) => { if (e.persisted) restoreLeft(); });

// ---------- free game (Play on after a miss: freeplay.js) ----------
// A game after the judging is over: the miss is decided and sent, and nothing in this section reports, logs, holds or
// changes a result, or starts, ends or rates a play-out (scripts/test-freeplay.mjs checks this section's source). It
// shares only the board with the rated play-out; S.free and S.playOn are
// never both set (freeOffer). The puzzle's clock stops meanwhile, so the retry position comes back as it was left.
// Its engines run in the browser only (freeDefender): crux's /api/defend is the rated play-outs' lane.
// The engine to play on against, or null: no Play on button (freeplay.js freeOffer).
const freeWake = new WeakSet();
// Engines that didn't answer a free game, by freeFailKey: for this page only (a reload tries them again).
const freeFails = new Map();
const freeFailed = (s, fg, engine) => { const k = freeFailKey(s.p.id, fg.base, fg.miss); freeFails.set(k, [...(freeFails.get(k) ?? []), engine]); };
function freeEngine(s = S) {
  if (!s || s.placeholder) return null;
  // (report() draws the card before its upload is marked done: draw it again once it is, so the button can appear)
  const up = uploading.get(s.p.id);
  if (up && !freeWake.has(up)) { freeWake.add(up); up.catch(() => {}).finally(() => setTimeout(() => { if (S === s) renderAll(); })); }
  const k = s.p.komi || 0, here = { syntaksHere: syntaks.supports(s.p.size, k), tiltakHere: tiltak.supports(s.p.size, k), syntaksStatus: syntaks.status(),
    failed: s.misses?.length ? freeFails.get(freeFailKey(s.p.id, freeBase(s), freeFrom(s))) ?? [] : [] };
  const e = freeOffer(s, { defender: freeDefender(playOnDefender(), here), held: heldRec.get()?.id === s.p.id, uploading: !!up });
  return e && !gameAt([...freeBase(s), freeFrom(s)]).result() ? e : null; // (a miss that ended the game: nothing to play)
}
function freeBase(s) { return [...s.hist, ...s.moves.map((m) => m.ptn)]; }
function startFree() {
  const s = S, engine = freeEngine(s);
  if (!engine) return;
  dropPending();
  const miss = freeFrom(s), base = freeBase(s);
  const fg = s.free = { miss, at: s.moves.length, base, line: [miss], g: gameAt([...base, miss]), engine,
    name: engine === 'syntaks' ? 'Syntaks' : 'Tiltak', thinking: false, over: null, e0: elapsed(s) };
  s.freeNote = null;
  if (engine === 'syntaks') syntaks.load();
  else Promise.resolve().then(tiltak.warmup).catch(() => {});
  s.busy = true;
  board.highlight([]); // the hint belongs to the retry position (restoreBoard draws it again)
  showFree(s).then(() => { if (S === s && s.free === fg) freeTurn(s, fg); });
}
// The board shows the free game as played (its start, or after a refused move or a take back).
async function showFree(s) {
  if (S !== s || !s.free) return;
  await board.load(ptnFor([...s.free.base, ...s.free.line]));
  s.loadedKey = null;
  await board.last();
}
// The engine's move, in the browser: Syntaks (its first reply waits for the download), or Tiltak, which also takes
// over if Syntaks stops answering here (not on 6×6: tiltak.js supports). No answer from either: back to the puzzle.
async function freeTurn(s, fg) {
  const live = () => S === s && s.free === fg && !fg.over;
  const typed = document.activeElement?.id === 'ptn-in';
  fg.thinking = true; s.busy = true;
  await board.ui({ disableBoard: true });
  renderAll();
  const komi = s.p.komi || 0, tps = fg.g.toTPS();
  let mv = null;
  const within = (p, ms, v = null) => Promise.race([p, new Promise((res) => setTimeout(res, ms, v))]);
  if (fg.engine === 'syntaks') {
    const wait = syntaks.status() === 'ready' ? 0 : ENGINE_MS.download;
    const r = await within(syntaks.search({ tps, komi, ms: 1500, nodes: 1.5e6 }).catch(() => null), ENGINE_MS.local + wait);
    if (!live()) return;
    mv = legalMove(fg.g, r?.move);
    if (!mv) freeFailed(s, fg, 'syntaks');
    if (!mv && tiltak.supports(s.p.size, komi)) { fg.engine = 'tiltak'; fg.name = 'Tiltak'; fg.swapped = true; renderAll(); }
  }
  if (!mv && fg.engine === 'tiltak') {
    const up = await within(Promise.resolve().then(tiltak.warmup).then(() => true, () => false), ENGINE_MS.tiltakUp, false);
    if (!live()) return;
    const t = up && await within(tiltak.analyze({ tps, size: s.p.size, komi, ms: 1500 }).catch(() => null), ENGINE_MS.tiltak);
    if (!live()) return;
    mv = legalMove(fg.g, t?.bestmove);
  }
  if (!mv) { if (fg.engine === 'tiltak') freeFailed(s, fg, 'tiltak'); return leaveFree(s, 'failed'); }
  fg.thinking = false;
  fg.g.play(mv); fg.line.push(mv);
  await board.append(mv); await board.last();
  if (!live()) return;
  s.busy = false;
  if (freeOver(s, fg)) return;
  await board.setPlayer(s.solver);
  await board.ui({ disableBoard: false });
  renderAll();
  if (typed && live()) $('#ptn-in').focus();
}
// The player's move: checked against the free game's own position, then the engine answers.
function freeMove(ptn) {
  const s = S, fg = s.free;
  if (fg.over || fg.thinking || s.busy) return showFree(s);
  const canon = legalMove(fg.g, ptn);
  if (!canon) return showFree(s);
  fg.g.play(canon); fg.line.push(canon);
  if (freeOver(s, fg)) return;
  freeTurn(s, fg);
}
// The game is over: the card says how; Back to the puzzle, Take back, Hint and Solution stay.
function freeOver(s, fg) {
  const res = fg.g.result();
  if (!res) return false;
  fg.over = res; fg.thinking = false; s.busy = false;
  board.ui({ disableBoard: true });
  renderAll();
  return true;
}
function freeTakeBack() {
  const s = S, fg = s?.free, n = fg && takeBack(fg.line.length);
  if (n == null || fg.thinking || s.busy) return;
  dropPending();
  fg.line.length = n; fg.g = gameAt([...fg.base, ...fg.line]); fg.over = null;
  s.busy = true; renderAll();
  showFree(s).then(async () => {
    if (S !== s || s.free !== fg) return;
    s.busy = false;
    await board.setPlayer(s.solver);
    await board.ui({ disableBoard: false });
    renderAll();
  });
}
// Leaving the free game (freeplay.js freeExit says what each way out does). The clock picks up where it stopped.
function leaveFree(s, how) {
  const fg = s?.free;
  if (!fg) return;
  const x = freeExit(how, fg.name);
  s.free = null;
  if (fg.engine === 'tiltak' && fg.thinking) tiltak.stop();
  if (s.t0 != null && fg.e0 != null) s.hiddenMs += elapsed(s) - fg.e0;
  if (!x.restore) return;
  dropPending();
  s.freeNote = x.note ? { text: x.note, n: s.misses.length } : null;
  if (x.press === 'hint') s.pendingHint = true; else if (x.press === 'solution') s.pendingSolution = true;
  s.busy = true; renderAll();
  restoreBoard().then(() => { if (S !== s) return; s.busy = false; renderAll(); flushHint(s); });
}
// ---------- end free game ----------
// Proven off-tree wins at the current attacker node: alts at the root, altsAt[path of moves so far] deeper in.
function slowerWins() { return slowerWinsAt(S.p, S.moves.map((m) => m.ptn)); } // (playon.js: Rush reads them too)

function fail(ms) { S.status = 'retry'; report(false, S, S, { ms }); renderAll(); sound.verdict('wrong', 120); } // (after the move's own sounds: a spread's last drop, a smash's slap)
// Still-wins verdicts already known in this puzzle, by position and move, so a repeat doesn't search again.
const provenKey = (canon) => S.moves.map((m) => m.ptn).join(' ') + '|' + canon;

// s: the puzzle solved. before: what to await between reporting it and opening exploration (slowSolve: the board put
// back); another puzzle may be on screen by then, and it is left alone.
async function solved(s = S, before = null) {
  s.status = 'solved';
  s.outcome = s.viewed ? 'viewed' : s.misses.length ? 'miss' : 'clean';
  if (!s.resultSent) report(true, s);
  if (before) await before();
  if (S === s) await openExploration();
}

// A proven forced win the puzzle's line doesn't take is a solve, whatever its length (with 7+ plies left the tree has
// Tak threats only, so it can be slower, the same length or faster: see userMove); longer wins count as wins (Shy,
// 2026-11-15: "People don't like having to play for shortest"). The move stays on the board, the puzzle ends there,
// and the card names the move the puzzle's line plays at that node (not claimed faster: the page doesn't know the
// lengths). node: the attacker node the move was played at.
function slowSolve(canon, tMove, node) {
  const g = S.g;
  logMove('slow', canon, tMove); S.decidedMs ??= tMove;
  S.slowWin = { move: canon, fastest: node === 'win' ? finisher(g) : Object.keys(node)[0] };
  g.play(canon);
  S.moves.push({ ptn: canon, me: true }); S.snaps.push(g.toTPS());
  S.refutation = null; S.busy = false;
  // The win is this puzzle's, decided now: it is reported before the board's await. On PTN Ninja that await yields
  // for 60 ms or more, and a filter change or puzzle link in between used to start the next puzzle, which solved()
  // (reading S) then marked solved and reported as a rated win while this one was never reported.
  const s = S;
  solved(s, () => restoreBoard(s));
}

// After the puzzle the board is free: play any legal move, for either side, from any position.
async function openExploration() {
  await board.ui({ disableBoard: false, dropOnStray: true }); // roads are drawn only where one is complete (the board does that by itself)
  await board.setPlayer(gameAt(shownLine().slice(0, S.view ?? shownLine().length)).toMove);
  renderAll();
  runEngine();
}

async function explore(ptn) {
  const line = shownLine();
  const at = S.view ?? line.length;
  const base = line.slice(0, at);
  const g = gameAt(base);
  let canon;
  try { canon = g.canon(ptn); } catch { return showLine(line, at); }
  if (g.result() || !g.legalMoves().some((m) => g.moveToPTN(m) === canon)) return showLine(line, at);
  const official = officialLine();
  if (at < line.length && line[at] === canon) { S.view = at + 1 >= line.length ? null : at + 1; await showLine(line, at + 1); return afterExplore(); } // next move of the line you're on
  if (S.onBranch && S.branch && at <= S.branch.at && at < official.length && official[at] === canon) { // the solution's own move from the shared prefix
    S.onBranch = false; S.view = at + 1 >= official.length ? null : at + 1; await showLine(official, at + 1); return afterExplore();
  }
  if (S.onBranch && S.branch && at === line.length) S.branch.moves.push(canon); // extend your line
  else {
    const branchAt = S.onBranch && S.branch ? Math.min(at, S.branch.at) : at;
    const prefix = S.onBranch && S.branch && at > S.branch.at ? S.branch.moves.slice(0, at - S.branch.at) : [];
    S.branch = { at: branchAt, moves: [...prefix, canon] };
  }
  S.onBranch = true;
  S.view = null;
  const now = shownLine();
  // The board already shows this line (the move was just made on it): keep it, so the move animates.
  const bs = board.snaps;
  if (bs.length === now.length + 1 && board.cur === now.length && bs.at(-1).ptn === canon) S.loadedKey = now.join(' ');
  else { S.loadedKey = null; await showLine(now, now.length); }
  afterExplore();
}
async function afterExplore() {
  const line = shownLine();
  const g = gameAt(line.slice(0, S.view ?? line.length));
  await board.setPlayer(g.toMove);
  renderAll();
  runEngine();
}
async function backToSolution() {
  // Return to where your line split off (not the end of the solution, a finished game where no move can be played).
  const at = Math.min(S.branch?.at ?? officialLine().length, officialLine().length);
  S.branch = null; S.onBranch = false; S.loadedKey = null;
  S.view = at < officialLine().length ? at : null;
  await showLine(officialLine(), at);
  afterExplore();
}

function finisher(g) {
  for (const m of g.legalMoves()) { const u = g.apply(m); const r = g.result(); g.undo(u); if (r && r.winner === S.solver) return g.moveToPTN(m); }
  return null;
}

// Play out the main line (first-listed move at each node) for "View solution".
async function showSolution() {
  // Pressed while the board is busy (the puzzle's intro, the opponent's reply, the reset after a miss): play it out
  // once the board is free (flushHint), as with Hint.
  if (S?.free) return leaveFree(S, 'solution'); // from a free game: the retry position comes back, then as from there
  if (S && S.busy && (S.status === 'retry' || S.status === 'play') && !S.placeholder) { S.pendingSolution = true; return; }
  // In the middle of a play-on: give up (a miss), then show it once the board is back
  if (S?.playOn) { if (!S.playOn.end) { S.pendingSolution = true; endPlayOn(S, 'gaveup'); } return; }
  if (!S || S.placeholder || S.status === 'solved' || S.status === 'viewing' || S.busy) return;
  const s = S;
  if (!S.resultSent) { const at = elapsed(); S.decidedMs ??= at; logMove('view', null, at); report(false, S, S, { ms: at }); }
  shadow((o) => o.act(s.ob, 'view', { clientVerdict: 'missed', ms: elapsed(s) }));
  S.status = 'viewing'; S.viewT0 = performance.now(); // (justViewed)
  await restoreBoard();
  if (S !== s) return;
  await board.ui({ disableBoard: true });
  const g = S.g;
  const step = async () => {
    if (S !== s) return;
    const node = S.node;
    const mv = node === 'win' ? finisher(g) : Object.keys(node)[0];
    if (!mv) return;
    g.play(mv); S.moves.push({ ptn: mv, me: true, shown: true }); S.snaps.push(g.toTPS());
    await board.append(mv); await board.last();
    if (S !== s) return;
    if (g.result()) { S.viewed = true; S.status = 'solved'; S.outcome = S.slowWin ? (S.misses.length ? 'miss' : 'clean') : 'viewed'; S.view = null; await openExploration(); return; } // (a held move proved to win meanwhile: that's the result)
    const { r: reply, n } = node[mv];
    renderAll();
    setTimeout(async () => {
      if (S !== s) return;
      g.play(reply); S.moves.push({ ptn: reply, me: false }); S.snaps.push(g.toTPS());
      await board.append(reply); await board.last();
      if (S !== s) return;
      S.node = n; renderAll();
      setTimeout(step, 750);
    }, 750);
  };
  step();
}

// A Hint (or Solution) pressed while the board is busy (the opponent's reply, the reset after a wrong move) would be
// lost: remember it and show it once the board is free. Solution wins over a pending hint. Not during a new puzzle's
// intro or its first second: those presses are dropped (fresh), since they are usually meant for the last puzzle.
function flushHint(s) {
  if (S !== s) return;
  if (s.pendingSolution) { s.pendingSolution = s.pendingHint = false; showSolution(); }
  else if (s.pendingHint) { s.pendingHint = false; showHint(); }
}
function showHint() {
  if (S?.free) return leaveFree(S, 'hint'); // (as Solution)
  if (S && S.busy && (S.status === 'retry' || S.status === 'play') && !S.placeholder) { S.pendingHint = true; return; }
  if (!S || S.placeholder || S.busy || S.playOn || S.status === 'solved' || S.status === 'viewing') return;
  // Looking at an earlier position: go back to the live one and show the hint there.
  if (S.view != null) { const s = S; restoreBoard().then(() => { if (S === s && S.view == null) showHint(); }); return; }
  const g = S.g;
  const mv = S.node === 'win' ? finisher(g) : Object.keys(S.node)[0];
  if (!mv) return;
  if (!S.hinted) { logMove('hint'); const s = S; shadow((o) => o.act(s.ob, 'hint', { clientVerdict: 'hint', ms: elapsed(s) })); }
  S.hinted = true;
  // Each press at the same position says more: 1, the square to play on or move from; 2, the whole path of a stack
  // move; 3, the stone to place or how to drop the stack. A miss that already used those squares skips ahead.
  const path = moveSquares(mv), at = S.moves.length, lastMiss = S.misses.at(-1);
  let level = S.hint?.node === S.node && S.hint.at === at ? S.hint.level + 1 : 1;
  if (lastMiss?.at === at) {
    const missed = moveSquares(lastMiss.ptn);
    if (missed[0] === path[0]) level = Math.max(level, 2);
    if (missed.join() === path.join()) level = Math.max(level, 3);
  }
  if (path.length === 1 && level === 2) level = 3; // a placement has no path to show
  level = Math.min(level, 3);
  S.hint = { node: S.node, at, level, sqs: level >= 2 ? path : path.slice(0, 1), note: level === 3 ? moveNote(mv) : '' };
  board.highlight(S.hint.sqs);
  renderAll();
}
// The last hint step in words: which stone to place, or how many to carry and how to drop them.
function moveNote(ptn) {
  const m = /^(\d?)[a-h][1-8]([<>+-])(\d*)/.exec(ptn);
  if (!m) return `Place a ${{ S: 'wall', C: 'capstone' }[ptn[0]] || 'flat'} there.`;
  const n = +m[1] || 1, drops = m[3] ? m[3].split('').map(Number) : [n];
  if (drops.length === 1) return n === 1 ? 'Move the top piece one square.' : `Carry ${n} pieces one square.`;
  return `Carry ${n} pieces and drop ${drops.join(', then ')}.`;
}
// Browse any earlier position (game history or puzzle moves). Index = number of plies shown.
async function viewPly(i, branch = S.onBranch) {
  if (!S || S.placeholder) return;
  if (S.playOn || S.free) return; // a play-on game is played, not browsed (a free game too)
  if (S.status === 'solved') {
    S.onBranch = !!(branch && S.branch);
    const line = shownLine();
    i = Math.max(0, Math.min(line.length, i));
    S.view = i === line.length ? null : i;
    await showLine(line, i);
    return afterExplore();
  }
  if (S.busy || S.status === 'viewing') return; // the board is mid-animation; browse once it settles
  const total = S.hist.length + S.moves.length;
  i = Math.max(0, Math.min(total, i));
  if (i === total) { if (S.view != null) await restoreBoard(); return; }
  S.view = i;
  await board.highlight([]); // the hint belongs to the live position; restoreBoard redraws it
  await board.ui({ disableBoard: true });
  if (i === 0) await board.first(); else await board.goTo(i - 1);
  renderAll();
}

// Before a puzzle arrives, render the real panels with dummy values (masked by CSS), so nothing jumps.
let fbFocus = null; // data-act of the feedback button that had keyboard focus before a re-render
const finePointer = matchMedia('(pointer: fine)');
const PLACEHOLDER = {
  placeholder: true, solver: 1, status: 'play', moves: [], view: null, delta: null, misses: [], branch: null, onBranch: false,
  hist: 'a1 e5 c3 b4 d3 c4 b3 d4 e3 a4 c2 e4 b2 a5 d2'.split(' '),
  p: { id: '', size: 5, themes: [], meta: {}, komi: 0, tps: 'x5/x5/x5/x5/x5 1 1', rating: 0, attempts: 0 },
};

// Engine lines at the top of the move panel (the analysis view), in the look of Gaelet's and PTN Ninja's lists, with no
// panel of their own: a header (the engine's name, small; the verdict on the position, large; a thin chance bar only
// when the verdict is a chance), then up to three lines on hairline rules, each an evaluation chip (filled in the colour
// of the side ahead, its number spoken for that side, as the header's), the line's moves numbered as the move list
// numbers them (click one to play the line up to there) and its tags, then the opponent's threats in one short red line.
// Docked on a phone: a row of two-part chips (evaluation | move), and under it the selected line's moves.
// The threats (the red line here) are off by default, as on Lichess (Sasha,
// 2026-11-22: "threat should be toggle-able (and off by default) like on lichess"): a small Threats button beside the
// lines, or x, shows them (S.thr). Each puzzle starts with them off (S is new); stepping through it keeps them as set.
// Their line's room is held either way, so nothing above it moves when they come and go.
const TAG_WORDS = { puzzle: 'the puzzle’s move', yours: 'your move', played: 'played in the game' };
const SRC = {
  syntaks: (t) => `<a class="src" href="https://github.com/Ciekce/syntaks" target="_blank" rel="noopener" title="Evaluation by Syntaks, a 6×6 engine by Ciekce and contributors, running on the puzzle server${t}">Syntaks</a>`,
  tiltak: (t) => `<a class="src" href="https://github.com/MortenLohne/tiltak" target="_blank" rel="noopener" title="Evaluation by Tiltak, running in your browser${t}">Tiltak</a>`,
  solver: (t) => `<span class="src" title="tinue’s own solver: proven wins only${t}">solver</span>`,
};
const listAnd = (xs) => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1);
// The opponent's threats (the solver's facts, exact): { short: "Tak by Black: a4 2b3+" | "Tinuë by Black: a4 e2" |
// "Black threatens: d1" (a win on flats), long: "Black threatens a road: a4 and 2b3+." (its title, and what a screen reader says) } or null
function threatText() {
  const sol = S?.sol, g = S?.posG;
  if (!sol?.threats?.length || !g) return null;
  const them = 3 - g.toMove, ts = threatGroups(sol.threats, g.size), moves = ts.map(esc);
  if (sol.tinue) return { short: `Tinuë by ${colorName(them)}: ${moves.join(' ')}`, long: `${colorName(them)} has tinuë: ${listAnd(moves)}.` };
  const h = g.clone(); h.toMove = them;
  const road = ts.every((t) => { try { const u = h.apply(h.parseMove(t)); const r = h.result(); h.undo(u); return r?.kind === 'road'; } catch { return false; } });
  return { short: `${road ? `Tak by ${colorName(them)}` : `${colorName(them)} threatens`}: ${moves.join(' ')}`, long: `${colorName(them)} threatens ${road ? 'a road' : 'to win'}: ${listAnd(moves)}.` };
}
// White's chance for the bar (null: no evaluation to show)
const whiteChance = (ev, mover) => ev.kind === 'prob' ? (mover === 1 ? ev.p : 1 - ev.p)
  : ev.kind === 'win' ? +(mover === 1) : ev.kind === 'loss' ? +(mover !== 1) : null;
// A move, its parts quietly told apart (analysis.js ptnParts): count and drops muted, direction teal, S/C/* bold
const mvHtml = (ptn) => ptnParts(ptn).map((x) => x.c === 'q' ? esc(x.t) : `<i class="${x.c}">${esc(x.t)}</i>`).join('');
function engineMarkup(docked = DOCK_MQ.matches && S?.status === 'solved') {
  if (!S || S.status !== 'solved' || !(S.eng || S.eval)) return '';
  if (!ANALYSIS) return engineRow();
  const mover = S.posG?.toMove, ply0 = S.posG?.ply ?? 0, lines = S.lines || [], l1 = lines[0], e = S.eng || {};
  const busy = e.thinking || e.more;
  const pvHtml = (L, pv) => numberedPV((pv || []).slice(0, 8), ply0)
    .map(({ num, ptn }, k) => `${num ? `<span class="mn">${num}</span>` : ''}<button class="pvm" data-pv="${L}.${k}">${mvHtml(ptn)}</button>`).join('');
  let verdict = '', pw = null;
  if (S.eval?.kind === 'over') verdict = S.eval.winner === 0 ? 'Draw' : `${colorName(S.eval.winner)} won`;
  // (no line, but the solver's exact tinuë: the opponent wins in 1 whatever is played)
  else if ((!l1 || l1.ev.kind === 'pending') && S.sol?.tinue && mover) verdict = `${colorName(3 - mover)} wins in 1`;
  else if (!l1 || l1.ev.kind === 'pending') verdict = e.none ? `<span class="muted">${/inconclusive/i.test(e.none) ? 'No win found' : 'No forced win'}</span>` : busy ? '<span class="muted">…</span>' : '';
  else {
    const ev = l1.ev, who = (me) => colorName(me ? mover : 3 - mover);
    pw = whiteChance(ev, mover);
    verdict = (ev.kind === 'win' ? `${who(true)} wins in ${ev.n}` : ev.kind === 'loss' ? `${who(false)} wins${ev.n ? ` in ${ev.n}` : ''}`
      : ev.kind === 'nowin' ? `No forced win in ${ev.n}` : Math.abs(pw - 0.5) < 0.05 ? 'Even' : `${pw > 0.5 ? 'White' : 'Black'} ${Math.round(Math.max(pw, 1 - pw) * 100)}%`)
      + (busy ? '<span class="muted dots" title="Still searching">…</span>' : '');
  }
  // the bar: only for a chance (a forced result says it all), never in the dock
  const bar = l1?.ev.kind === 'prob' && pw != null && !docked ? `<span class="cbar" title="White’s chances"><i style="width:${(pw * 100).toFixed(1)}%"></i></span>` : '';
  const detail = [e.depth ? `depth ${e.depth}` : '', e.nodes ? `${e.nodes} nodes` : '', e.ms ? `${e.ms} ms` : ''].filter(Boolean).join(', ');
  const over = S.eval?.kind === 'over'; // (a finished game: the verdict only, no source)
  const src = over ? '' : e.src === 'solver' ? `<span class="src" title="tinue’s own solver: proven wins only">${e.down ? 'Engine unavailable' : 'Solver'}</span>`
    : SRC[e.src]?.(detail ? ` (${detail})` : '') || '';
  const label = (l) => { const c = chipLabel(l.ev, mover); return `${l.move}${l.tags.map((t) => TAG_WORDS[t] ? ', ' + TAG_WORDS[t] : '').join('')}: ${c.side ? colorName(c.side) + ' ' : ''}${c.text}${l.ev.proven ? ', proven' : ''}${l.cand ? ' (a candidate move, searched on its own)' : ''}`; };
  const ev = (l) => { const c = chipLabel(l.ev, mover); return [c, `s${c.side}${l.ev.proven ? ' pr' : ''}`]; };
  const tt = S.thr ? threatText() : null, threatP = tt ? `<p class="threat" title="${tt.long}" aria-label="${tt.long}">${tt.short}</p>` : '';
  const thrB = `<button type="button" class="thr-t" data-thr aria-pressed="${!!S.thr}" title="The opponent’s threats (x)">Threats</button>`;
  if (docked) {
    const sel = lines[S.sel] || l1;
    const seg = (l, i) => { const [c, k] = ev(l); return `<button class="chip" data-line="${i}" aria-pressed="${i === S.sel}" aria-label="${esc(label(l))}" title="${esc(label(l))}"><span class="ev ${k}">${esc(c.text)}</span><span class="mv">${mvHtml(l.move)}</span></button>`; };
    const rowA = lines.length ? lines.map(seg).join('') + (busy ? '<span class="muted">…</span>' : '') : `<b class="vd">${verdict}</b>`;
    // (the threat line is the third row, in the dock's held room, so it is never behind the dock; its button ends the
    // second row, a finger's size, where the third row's 17 px would be too small)
    return `<div class="eng ana docked"><div class="chips" role="group" aria-label="Engine lines">${rowA}</div>`
      + `<div class="eng-b"><span class="pvline">${sel ? pvHtml(lines.indexOf(sel), sel.pv) : ''}</span>${src}${thrB}</div>${threatP}</div>`;
  }
  const chip = (l, i) => { const [c, k] = ev(l); return `<button class="chip ${k}" data-line="${i}" aria-pressed="${i === S.sel}" aria-label="${esc(label(l))}" title="${esc(label(l))}">${esc(c.text)}</button>`; };
  const tags = (l) => l.tags.map((t) => `<span class="tag ${t}">${t}</span>`).join('');
  const rows = lines.map((l, i) => `<div class="ln${i === S.sel ? ' sel' : ''}" data-line="${i}">${chip(l, i)}<span class="pvline">${pvHtml(i, l.pv)}</span>${tags(l)}</div>`).join('');
  // The lines' room (four lines and the threat line, analysis.css) is held at one height for the whole analysis, a
  // finished game's position included, so the step buttons below never move; the threat line (the Threats button, then
  // the threats while shown) sits outside the rows' scroller, so a fifth row never pushes it out of sight.
  return `<div class="eng ana"><div class="eng-h">${src}<b class="vd">${verdict}</b></div>${bar}`
    + `<div class="lns"><div class="rws" role="group" aria-label="Engine lines">${rows}</div><div class="thr">${thrB}${threatP}</div></div></div>`;
}
// After the lines are drawn: a line's moves fade at the row's edge only when they overflow it (analysis.css
// .pvline.of), and in the dock the selected chip is scrolled into the chips' row (a 4th line, yours, sat off screen).
function fadeLong() {
  for (const el of document.querySelectorAll('#moves .eng.ana .pvline')) el.classList.toggle('of', el.scrollWidth > el.clientWidth + 1);
  // (beside the board: the selected row kept in sight in the rows' scroller)
  const rws = document.querySelector('#moves .eng.ana .rws'), cur = rws?.querySelector('.ln.sel');
  if (cur) { const a = rws.getBoundingClientRect(), b = cur.getBoundingClientRect(); if (b.bottom > a.bottom) rws.scrollTop += b.bottom - a.bottom; else if (b.top < a.top) rws.scrollTop -= a.top - b.top; }
  const row = document.querySelector('#moves .eng.ana.docked .chips'), on = row?.querySelector('[aria-pressed="true"]');
  if (!on) return;
  const a = row.getBoundingClientRect(), b = on.getBoundingClientRect();
  if (b.right > a.right) row.scrollLeft += b.right - a.right + 8; else if (b.left < a.left) row.scrollLeft -= a.left - b.left + 8;
}
// The analysis view off: production's engine row (main before the analysis view), one compact line at the top of the
// panel: line 1's chance bar and who's better, the source, then line 1's moves as buttons (click to play it).
function engineRow() {
  const mover = S.posG?.toMove, l1 = S.lines?.[0], e = S.eng || {};
  let lead = '', pv = '';
  if (S.eval?.kind === 'over') lead = S.eval.winner === 0 ? 'Drawn on flats' : `${colorName(S.eval.winner)} won`;
  else if (!l1 || l1.ev.kind === 'pending') lead = e.none ? `<span class="muted">${esc(e.none)}</span>` : e.thinking ? '<span class="muted">Thinking…</span>' : '';
  else {
    const ev = l1.ev, who = (me) => colorName(me ? mover : 3 - mover), pw = whiteChance(ev, mover);
    const fav = ev.kind === 'win' ? `${who(true)} wins in ${ev.n}` : ev.kind === 'loss' ? `${who(false)} wins in ${ev.n}`
      : pw == null ? '' : Math.abs(pw - 0.5) < 0.05 ? 'Even' : `${pw > 0.5 ? 'White' : 'Black'} ${Math.round(Math.max(pw, 1 - pw) * 100)}%`;
    // (the solver's proven win has no chance bar, as before)
    lead = (pw == null || e.src === 'solver' ? '' : `<span class="bar" title="White’s chances"><i style="width:${(pw * 100).toFixed(1)}%"></i></span>`) + (fav ? `<b>${fav}</b>` : '');
    pv = (l1.pv || []).slice(0, 8).map((m, k) => `<button class="pvm" data-pv="0.${k}">${esc(m)}</button>`).join('');
  }
  const src = S.eval?.kind === 'over' ? '' : SRC[e.src]?.('') || '';
  return `<div class="eng row">${lead}<span class="pvline">${pv}</span>${src}</div>`;
}
// Update only the engine's part (Tiltak streams updates; re-rendering the whole panel would flicker).
function renderEngine() {
  const slot = document.querySelector('#moves .eng-slot');
  if (!slot) return renderAll();
  const html = engineMarkup(!!slot.closest('.dock'));
  if (slot._html !== html) { const f = pvFocused(); slot.innerHTML = html; slot._html = html; refocusPV(f); fitDock(); if (ANALYSIS) fadeLong(); }
}
// After clicking a move in a line, the lines are redrawn for the new position: keep keyboard focus on line 1's first
// move (Enter again steps further along), or on Forward while the engine is still thinking; a chip keeps its focus.
const pvFocused = () => { const a = document.activeElement; return !a?.closest?.('#moves') ? null : a.matches('.chip') ? 'chip:' + a.dataset.line : a.matches('[data-thr]') ? 'thr' : a.closest('[data-pv]') ? 'pv' : null; };
let pvFollow = false; // focus is parked on Forward until the engine's new line arrives
const refocusPV = (was) => {
  const onFwd = !!document.activeElement?.matches?.('#moves [data-step="next"]');
  const pv0 = $('#moves [data-pv="0.0"]');
  if (was === 'thr') return $('#moves [data-thr]')?.focus(); // (the Threats button keeps its focus)
  if (was?.startsWith('chip:') && !pvFocused()) { const c = $(`#moves .chip[data-line="${was.slice(5)}"]`) || $('#moves .chip'); if (c) return c.focus(); }
  if (was && !pvFocused()) { if (pv0) pv0.focus(); else { $('#moves [data-step="next"]')?.focus(); pvFollow = true; } }
  else if (pvFollow && onFwd && pv0) { pv0.focus(); pvFollow = false; }
  else if (pvFollow && !onFwd) pvFollow = false;
};

// ---------- rendering ----------
// After the puzzle: the result of the position on the board, if that game is over (then no move can be played there).
// dragon: the last move completed both players' roads (the mover wins: the dragon clause)
const shownOver = () => {
  const line = shownLine(), g = gameAt(line.slice(0, S.view ?? line.length)), r = g.result();
  return r && { ...r, dragon: r.kind === 'road' && g.hasRoad(1) && g.hasRoad(2) };
};
const overNote = (r) => `${!r.winner ? 'A draw' : r.dragon ? `${colorName(r.winner)} completed both roads at once, and the player who moved wins (the dragon clause)` : `${colorName(r.winner)} ${r.kind === 'road' ? 'made a road' : 'won on flats'}`}. `
  + `Step back${finePointer.matches ? ' (←)' : ''} or click a move to explore.`;
// A win outside the puzzle's line: proven by the search, or won on the board against an engine (play on).
const slowWinText = (w) => {
  const m = esc(w.move), po = w.playOn;
  return po?.proven && po.how !== 'proved' ? esc(copy('solved.proven', { m: w.move, E: po.engine }))
    : po?.how === 'win' ? esc(copy('solved.unproven', { m: w.move, E: po.engine }))
    : `${m} forces a win too, so it counts as solved`;
};
const solvedTitle = () => S.outcome === 'viewed' ? 'Solution shown' : S.outcome === 'miss' ? 'Solved on retry' : 'Solved';
// Review dock (Shy picked it from mockups): on phones in portrait, once the puzzle is over, the result with Next
// puzzle, Tiltak's line and the step buttons are pinned to the bottom of the screen. It only exists while pinned;
// everywhere else the move panel keeps its usual order (engine line, moves, steps) and the card keeps the result.
const DOCK_MQ = matchMedia('(max-width: 860px) and (min-height: 561px)');
DOCK_MQ.addEventListener?.('change', () => { if (S) renderAll(); });
// The page reserves the dock's height at its very end (below the footer) and as scroll padding, so nothing
// ends up stuck under it; and the board shrinks if that's what it takes to keep board + tray above the dock.
const fitDock = () => {
  const d = document.querySelector('#moves .dock'), page = $('#view-puzzle'), root = document.documentElement;
  const pinned = !!d && !page.classList.contains('hidden');
  const h = pinned ? d.offsetHeight : 0;
  root.style.setProperty('--dock-h', h + 'px');
  root.classList.toggle('docked', pinned);
  const wrap = $('#board-wrap');
  wrap.style.maxWidth = '';
  if (pinned && S?.p?.size) {
    const top = wrap.getBoundingClientRect().top + scrollY, w = wrap.clientWidth;
    // scale by the board host's own shape (flat bar + board + tray, or PTN Ninja's frame), measured at full width;
    // the floor is low enough that a 320 px phone's tray stays above the dock
    const maxW = Math.max(160, Math.floor(((root.clientHeight - h - top - 8) * w) / wrap.offsetHeight));
    if (maxW < w) wrap.style.maxWidth = maxW + 'px';
  }
};
const dockRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fitDock()) : null;
addEventListener('resize', () => fitDock());
const nextBtn = () => $('#moves .dock [data-act="next"]') || $('#feedback [data-act="next"]');
// "+12" / "−8": a rating change, with a real minus sign.
const signed = (d) => (d >= 0 ? '+' : '−') + Math.abs(Math.round(d));
const deltaSpan = (d) => `<span class="delta ${d >= 0 ? 'up' : 'down'}">${signed(d)}</span>`;

// Redraw the side panel from S: the feedback card, the session card (your rating), the puzzle's info and the move list.
function renderAll(mood) {
  if (!S) S = PLACEHOLDER;
  const loading = !!S.placeholder;
  // The render that first draws Next puzzle starts its lock (justEnded): every way to 'solved' renders, so none is missed.
  const unended = S.endT0 == null;
  if (S.status === 'solved' && S.endT0 == null && !loading) S.endT0 = performance.now();
  // ...and so the solved sound, once a puzzle, a beat after the winning move's click (none for a solution only viewed)
  if (unended && S.endT0 != null && S.outcome !== 'viewed') sound.verdict('solved', 170); // (after a smash's slap too)
  // A held move whose puzzle changed under it (a check settled it, the play-out ended, ...): every change renders.
  if (pend) pendingEvent({ type: 'phase', key: S === pend.s ? phaseKey(S) : null });
  for (const id of ['#feedback', '#moves']) $(id).classList.toggle('is-loading', loading);
  const delta = S.delta != null ? deltaSpan(S.delta) : '';
  const focusNext = renderFeedback(mood, delta);
  renderSession();
  renderBuildBar();
  // Everything about the puzzle itself comes at the end.
  const done = S.status === 'solved';
  const docked = done && DOCK_MQ.matches;
  const vp = $('#view-puzzle');
  vp.classList.toggle('analysis', done); // phones: step buttons only for the review...
  vp.classList.toggle('peek', !done && S.view != null); // ...or to get back after tapping an earlier move
  vp.classList.toggle('docked', docked);
  renderInfo(done);
  renderMoves(docked, delta, focusNext);
  refreshNinja();
}

// The result didn't reach the server: refused ('rate', 'error') or no answer ('lost'). A held one with no answer is
// still in this tab (S.resend), and a reload sends it, so it isn't "not rated" yet. A refusal isn't told to reload: a
// resend right away is usually refused again (the guest limit is per hour), and flushHeld drops it then.
const notCountedText = () => {
  const n = S.notCounted;
  if (!n) return '';
  if (S.resend && n === 'lost') return 'Your result isn’t saved yet: the server didn’t answer. Reload the page to send it again.';
  return n === 'rate' ? 'Not rated: too many results too quickly; try again in a bit.'
    : n === 'lost' ? 'Your result couldn’t be saved: the server didn’t answer.' : 'Not rated: the server didn’t record this result.';
};
// A held result: still checking a move that might win, or the check gave up (then the miss went in unrated).
// (Solved meanwhile: a game played out is over by then, with no engine ('noengine'), so its miss is unrated anyway.)
const uncheckedText = () => S.checkPending ? (S.status === 'solved'
    ? `Still checking whether ${esc(S.checkPending.miss)} forces a win: if it does, the puzzle counts as solved; if not, ${S.checkPending.playOn || S.checkPending.flags.hinted ? 'the miss goes in unrated' : 'the miss counts'}. If you move on before that’s known, ${S.checkPending.playOn && !S.checkPending.playOn.fallback ? 'the miss counts' : 'it goes in unrated'}.`
    : `Still checking whether ${esc(S.checkPending.miss)} forces a win; your result is sent once that’s known.`)
  : S.casualWhy === 'unchecked' ? (S.uncheckedWhy?.why ? playOnUnratedText(S.uncheckedWhy) : `Not rated: ${esc(S.unchecked)} might win, and there wasn’t time to check.`) : '';
// Why a played-out miss isn't rated (playon.js unratedWhy).
const playOnUnratedText = (u) => u.why === 'tiltak' ? 'Not rated: Tiltak defended.'
  : u.why === 'nomove' ? `Not rated: ${u.engine} hadn’t moved yet.`
  : u.why === 'stalled' ? 'Not rated: Syntaks didn’t answer in time.'
  : u.why === 'noengine' ? 'Not rated: no engine could answer.'
  : u.why === 'proven-length' ? esc(copy('end.unrated.provenLength', { m: S.unchecked }))
  : u.why === 'proven-late' ? esc(copy('end.unrated.provenLate', { m: S.unchecked }))
  : u.why === 'proven-unload' ? `Not rated: ${esc(S.unchecked)} is proven to win, and the page closed during the play-out.`
  : `Not rated: Syntaks dropped out ${u.at > 1 ? `after ${u.at} moves` : 'at the start'}, so Tiltak defended.`;
// Why a solved puzzle's result isn't rated ('': it is), the card and the phone's dock alike (on a docked phone only the
// dock's line is seen).
const unratedNote = () => S.notCounted ? notCountedText() : uncheckedText() || (S.casualWhy === 'tiltak' ? 'Not rated: Tiltak defended.'
  : S.casual ? 'You used a hint, so this one didn’t count toward your rating.' : '');
const dockNoteText = () => [S.slowWin && slowWinText(S.slowWin) + '.', unratedNote(), shownOver() && 'Game over here. Step back with ◀ to explore.'].filter(Boolean).join(' ');
// The feedback card (a live region). Returns whether Next puzzle should take keyboard focus once it is drawn.
function renderFeedback(mood, delta) {
  const fb = $('#feedback');
  // (fresh: a new puzzle's first second; the board loading or down: nothing to show them on, and the solution would cost
  // the puzzle on a board that can't be seen)
  const dis = S.placeholder ? ' disabled tabindex="-1"' : fresh(S) || !board.available ? ' disabled' : '';
  const playActions = `<div class="actions"><button data-act="hint"${dis}>Hint</button><button data-act="solution"${dis} title="View the solution">Solution</button></div>`;
  const other = colorName(3 - S.solver);
  const refText = (r) => !r ? '' : r.kind === 'thinking' ? `Checking why ${esc(r.miss)} fails…`
    : r.kind === 'gives-road' ? `After ${esc(r.miss)}, ${other} makes a road with <b>${esc(r.reply)}</b>.`
    : r.kind === 'lost' ? (r.how === 'road' ? `${esc(r.miss)} completes ${other}’s road but not yours, so ${other} wins on the spot.`
      : r.how === 'flat' ? `${esc(r.miss)} ends the game, and ${other} wins on flats.` : `${esc(r.miss)} ends the game in a draw.`)
    : r.kind === 'refuted' ? `After ${esc(r.miss)}, ${other} answers <b>${esc(r.reply)}</b> and ${r.exact ? 'the forced win is gone' : 'the solver finds no forced win'}.`
    : `${esc(r.miss)} doesn’t force the win.`;
  // A move whose still-wins check is running or gave up gets no "why it fails": it may yet be a win.
  const unsure = (m) => m != null && (m === S.checkPending?.miss || m === S.unchecked || !!S.uncheckedMoves?.has(m));
  const hintNote = S.hint?.note && S.hint.node === S.node && S.hint.at === S.moves.length ? `<b>Hint:</b> ${esc(S.hint.note)} ` : '';
  // The result didn't reach the server (refused, or no answer): say so instead of "counts as a miss".
  const NOT_COUNTED = notCountedText(), UNCHECKED = uncheckedText();
  const missNote = () => S.notCounted ? `${NOT_COUNTED} Keep trying or view the solution.`
    : S.checkPending ? `Still checking whether ${esc(S.checkPending.miss)} forces a win; if it does, it isn’t a miss. Keep trying or view the solution.`
    : S.casualWhy === 'unchecked' ? `${UNCHECKED} Keep trying or view the solution.`
    : S.casualWhy === 'hint' ? 'You used a hint, so this one doesn’t count toward your rating. Keep trying or view the solution.'
    // (the server's own answer: a repeat attempt or an out-of-date page is recorded unrated, and it doesn't say which)
    : S.repeat ? 'It isn’t rated: you’ve played this puzzle before, or this page is out of date. Keep trying or view the solution.'
    : 'This puzzle now counts as a miss; keep trying or view the solution.';
  let fbHtml;
  if (notice) {
    $('#feedback').classList.remove('is-loading');
    fbHtml = `<div class="icon bad">!</div><div class="body"><h2>${esc(notice.title)}</h2><p>${esc(notice.body)}</p></div>`;
  } else if (S.checking) {
    fbHtml = `<div class="icon turn p${S.solver}">…</div><div class="body"><h2>Checking ${esc(S.checking)}</h2>
      <p>That isn’t the puzzle’s line; checking whether it still forces a win.</p></div>${playActions}`;
  } else if (S.free) {
    // The free game after a miss (freeplay.js). Hint and Solution stay where they were: they leave it, then act as from
    // the retry position. Nothing it says promises a re-check: the result is in.
    const fg = S.free, E = fg.name, m = esc(fg.miss);
    const counts = S.notCounted ? 'It doesn’t count.' : 'It doesn’t count: the miss is already recorded.';
    const undo = takeBack(fg.line.length) != null && !fg.thinking && !S.busy;
    const more = `<div class="more"><button data-act="free-back">Back to the puzzle</button><button data-act="free-undo"${undo ? '' : ' disabled'} title="Take back your last move">Take back</button></div>`;
    fbHtml = fg.over
      ? `<div class="icon turn p${S.solver}"></div><div class="body"><h2>Game over</h2>
        <p>${esc(freeOverText(fg.over, S.solver, E, fg.line.length % 2 === 1))} ${counts}</p></div>${playActions}${more}`
      : `<div class="icon turn p${S.solver}"></div><div class="body"><h2>Playing on</h2>
        <p>From ${m}, ${E} defends${fg.swapped ? ' (Syntaks stopped answering here)' : ''}. ${counts}<span class="po-line po-status">${fg.thinking ? `${E} is thinking…` : 'Your move.'}</span></p></div>${playActions}${more}`;
  } else if (S.playOn) {
    // Play on under the Tak rule (startPlayOn; judge.js TAK_COUNTDOWN). Its words are playon-copy.js's, by id (the move
    // cap's, Shy's spec of 2026-11-15, went with the cap; Rush keeps them in rush-rules.js while it keeps the cap).
    const po = S.playOn, E = defenderName(po), m = esc(po.miss), k = TAK_COUNTDOWN, c = (id, v) => esc(copy(id, { E, m: po.miss, k, k1: k + 1, ...v }));
    const n = po.thinking ? po.mine : po.mine + 1, left = takLeft(po), last = po.line[2 * (po.mine - 1)]; // (the player's moves: line[0], [2], ...)
    const status = po.waiting ? c(`po.wait.${po.waiting}`)
      : (left == null ? c('po.status.tak', { n }) : c(left === 1 ? 'po.status.countdown1' : 'po.status.countdown', { move: last, left }))
        + (po.thinking ? c('po.status.thinking') : '');
    const rule = `<span class="po-line">${c('po.rule')}</span><span class="po-line po-status" title="${c('po.tip.tak')}">${status}</span>`;
    const acts = `<div class="actions"><button data-act="giveup"${busy('giveup', po.t0) ? ' disabled' : ''}>Give up</button><button data-act="solution" title="Give up and view the solution">Solution</button></div>`;
    if (po.proven) fbHtml = `<div class="icon turn p${S.solver}"></div><div class="body"><h2>${c(po.provedLate ? 'po.title.provedLate' : 'po.title.proven')}</h2>
        <p>${c('po.intro.proven', { orGiveUp: gameRated(po) ? copy('po.intro.orGiveUp') : '' })}${rule}</p></div>${acts}`;
    else fbHtml = `<div class="icon turn p${S.solver}"></div><div class="body"><h2>${c('po.title.unproven')}</h2>
        <p>${c('po.intro.unproven')}${po.engine !== 'syntaks' ? ' Against Tiltak, how the game ends doesn’t count toward your rating (a proof that your move wins still does).' : ''}${po.fallback && po.engine === 'syntaks' ? '<span class="po-line">Syntaks is unreachable; Tiltak, in your browser, defends now, so how this game ends doesn’t count toward your rating (a proof that your move wins still does).</span>' : ''}${rule}</p></div>${acts}`;
  } else if (S.status === 'solved') {
    const title = solvedTitle();
    const slow = S.slowWin ? `${slowWinText(S.slowWin)}${S.slowWin.fastest ? `; the puzzle’s line plays ${esc(S.slowWin.fastest)} instead` : ''}. ` : '';
    const why = unratedNote();
    const note = slow + (why && why + ' ')
      + (shownOver() ? overNote(shownOver()) : S.casualWhy === 'hint' ? '' : `Play any move to explore${finePointer.matches ? ', or step through the line with ← and →' : ''}.`);
    fbHtml = `<div class="icon ${S.outcome === 'clean' ? 'good' : 'bad'}">${S.outcome === 'clean' ? '✓' : '✗'}</div><div class="body">
      <h2>${title}<span class="dslot"></span></h2><p>${note}</p></div>
      <div class="actions"><button class="primary" data-act="next">Next puzzle</button></div>`;
  } else if (S.status === 'retry' && S.refutation?.kind === 'playon') {
    const r = S.refutation, E = r.engine, mv = `${r.n} move${r.n === 1 ? '' : 's'}`;
    const gaveUp = r.how === 'gaveup' || r.how === 'left' || r.how === 'unload', takOut = r.how === 'out' && r.rule === 'tak', refuted = r.how === REFUTED;
    const tc = (id) => esc(copy(id, { E, m: r.miss, mv, k: TAK_COUNTDOWN, k1: TAK_COUNTDOWN + 1 }));
    // (ended by the check's 'no': the ordinary miss card's title, and one line saying why the game stopped)
    const h2 = gaveUp ? 'You gave up' : refuted ? 'That’s not the move' : takOut ? tc('end.h2.out') : r.how === 'out' ? 'Out of moves'
      : r.how === 'road' ? (r.byYou ? `Your move completed ${E}’s road` : `${E} made a road`) : `${E} held`;
    const lead = gaveUp ? `You gave up on ${esc(r.miss)} after ${mv}`
      : refuted ? tc('end.lead.refuted')
      : takOut ? tc(r.proven ? 'end.lead.outProven' : 'end.lead.out')
      : r.proven ? { unfinished: `${esc(r.miss)} wins, but you didn’t finish it in ${mv}: ${E} held`,
        escaped: `${esc(r.miss)} wins, but ${E} got out of it after ${mv}`,
        'own-road': `${esc(r.miss)} wins, but your move ${r.n} completed ${E}’s road` }[provenLossLead(r.how, r.byYou)]
      : `${E} defended ${esc(r.miss)} for ${mv}`;
    // (the server's own answer decides "counts": a repeat attempt or an out-of-date page is recorded unrated: missNote)
    const rated = !S.checkPending && !S.notCounted && !S.casualWhy && S.serverRated !== false;
    const rest = rated ? ', so it counts as a miss. Keep trying or view the solution.'
      : takOut && S.checkPending ? `. ${tc('end.note.checking')} Keep trying or view the solution.` // (the check runs on: endPlayOn)
      : '. ' + (S.casualWhy === 'unchecked' && S.uncheckedWhy?.why ? `${playOnUnratedText(S.uncheckedWhy)} Keep trying or view the solution.` : missNote());
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>${h2}<span class="dslot"></span></h2>
      <p>${hintNote}${lead}${rest}</p></div>${playActions}`;
  } else if (S.status === 'retry') {
    // Play on: once the miss is in, a free game from the position after it (freeplay.js freeOffer), on its own line.
    const fe = freeEngine(), E = fe === 'syntaks' ? 'Syntaks' : 'Tiltak';
    const more = fe ? `<div class="more"><button data-act="free">Play on</button><span>Play on from ${esc(freeFrom(S))} and see how ${E} answers.</span></div>` : '';
    const fnote = S.freeNote?.n === S.misses.length ? `<span class="po-line">${esc(S.freeNote.text)}</span>` : '';
    fbHtml = `<div class="icon bad">✗</div><div class="body"><h2>That’s not the move<span class="dslot"></span></h2>
      <p>${hintNote}${unsure(S.refutation?.miss) ? '' : (refText(S.refutation) || 'Try another move.') + ' '}${missNote()}${fnote}</p></div>${playActions}${more}`;
  } else if (S.status === 'viewing') {
    fbHtml = `<div class="icon bad">…</div><div class="body"><h2>Solution</h2><p>Watch the winning line.</p></div>`;
  } else {
    const good = mood === 'good';
    fbHtml = `<div class="icon ${good ? 'good' : 'turn p' + S.solver}">${good ? '✓' : ''}</div><div class="body">
      <h2>${good ? 'Best move!' : board.state === 'down' ? 'Waiting for the board' : 'Your turn'}</h2>
      <p>${hintNote}${good ? 'Keep going.' : `You play ${colorName(S.solver)}`}</p></div>${playActions}`;
  }
  // Only touch the card when it changes (it's a live region), and keep keyboard focus on the equivalent
  // button when it does (Hint / View solution, then Continue once the puzzle is over).
  let focusNext = false; // focus Next puzzle once the move panel (and the dock's button) is drawn
  if (fb._html !== fbHtml) {
    const active = document.activeElement;
    const ended = !fb._html?.includes('data-act="next"') && fbHtml.includes('data-act="next"');
    if (fb.contains(active)) fbFocus = active.dataset.act || null;
    else if (active && active !== document.body) fbFocus = null;
    // Same buttons as before (e.g. the miss text updating with the refutation): replace only the text, so a press on
    // Hint or Solution that straddles the update still lands as a click.
    // (a card may go on after them: the miss card's Play on row, after Hint | Solution so Tab follows the screen)
    // Only the side that changed is redrawn: the Play on row appearing after the reset leaves the miss text in place,
    // so a screen reader doesn't read the miss out twice (freeplay.js cardSplice).
    const acts = fb.querySelector(':scope > .actions');
    const part = acts && acts.outerHTML === playActions ? cardSplice(fb._html, fbHtml, playActions) : null;
    if (part) {
      const kids = [...fb.childNodes], k = kids.indexOf(acts);
      if (part.before != null) { kids.slice(0, k).forEach((el) => el.remove()); acts.insertAdjacentHTML('beforebegin', part.before); }
      if (part.after != null) { kids.slice(k + 1).forEach((el) => el.remove()); acts.insertAdjacentHTML('afterend', part.after); }
    } else fb.innerHTML = fbHtml;
    fb._html = fbHtml;
    if (fbFocus && (!document.activeElement || document.activeElement === document.body)) {
      const pick = (a) => a && fb.querySelector(`[data-act="${a}"]:not(:disabled)`);
      const same = pick(fbFocus) || pick(freeFocus(fbFocus)); // (Play on and Back to the puzzle hand focus to each other)
      if (same && same.offsetParent) same.focus(); else focusNext = true;
    }
    if (ended && active?.id === 'ptn-in') focusNext = true; // solved by a typed move
  }
  const dslot = fb.querySelector('.dslot');
  if (dslot && dslot._html !== delta) { dslot.innerHTML = delta; dslot._html = delta; }
  $('#ptn-in').disabled = !!(S.placeholder || board.opts.disableBoard || !board.available);

  return focusNext;
}

// Session card: your rating (with the latest change beside it) and one chip per puzzle, Lichess-style.
function renderSession() {
  const mine = myRating(), shown = fmtRating(mine.rating, mine.provisional);
  const last = session.at(-1);
  $('#session').innerHTML = `<div><div class="label">Your rating</div><div class="rating-line"><span class="big">${shown}</span>${S.resultSent && last?.id === S.p.id && last.delta != null ? deltaSpan(last.delta) : ''}</div></div>
    <div class="streak">${session.map((x) => `<a class="${x.win ? 'w' : 'l'}${x.id === S.p.id ? ' cur' : ''}" href="#/puzzle/${esc(x.id)}${x.id === S.p.id && symNow() ? '/' + symNow() : ''}" title="Puzzle #${esc(x.id)}">${x.delta != null ? signed(x.delta) : x.win ? '✓' : '✗'}</a>`).join('')}</div>`;

}

// The puzzle's info panel, shown once it is over.
function renderInfo(done) {
  const info = $('#info'), { p } = S;
  info.classList.toggle('hidden', !done);
  if (done) {
    const themes = (p.themes || []).filter((t) => THEMES[t] && THEMES[t].group !== 'Board');
    const m = p.meta || {};
    const player = (c, name, r) => `<div><span class="dot p${c}"></span>${esc(name)}${r ? ` <span class="sub">(${r})</span>` : ''}</div>`;
    const game = p.sourceRef?.startsWith('http') ? `<a href="${esc(p.sourceRef)}" target="_blank" rel="noopener">PlayTak game</a>` : esc(p.source);
    // A dragon sub-position comes from a line that leaves the game (unplayedPlies): the game is where the line starts,
    // not a game that reached this position, so say so before naming its players.
    const off = unplayedPlies(m);
    const from = off ? `a line from this ${p.sourceRef?.startsWith('http') ? game : `${esc(p.source)} game`}` : game;
    info.innerHTML = `<dl>
        <dt>Puzzle</dt><dd><a href="#/puzzle/${esc(p.id)}${p.sym ? '/' + p.sym : ''}">#${esc(p.id)}</a>, ${p.size}×${p.size}${p.komi ? ` with komi ${p.komi}` : ''}${canShare() ? ' · <button class="link" id="share-link">Share</button>' : ''}${ANALYSIS ? ' · <a data-ninja target="_blank" rel="noopener" title="Open this line in PTN Ninja">PTN Ninja ↗</a>' : ''}</dd>
        <dt>Rating</dt><dd>${Math.round(p.rating)}</dd>
        <dt>Played</dt><dd>${p.attempts ? `${p.attempts} time${p.attempts === 1 ? '' : 's'}` : 'Not rated by anyone yet'}</dd>
        <dt>From</dt><dd>${from}</dd>
      </dl>${off ? `
      <div class="sub">${off === 1 ? 'The last move before the puzzle was' : `The last ${off} moves before the puzzle were`} not played in the game.</div>` : ''}
      ${p.turn === 1 ? `<div class="sub">Turning point: ${p.pre0 != null && p.pre0 < 0.4 ? 'you were behind' : 'the game was even'} until your opponent’s last move.</div>` : ''}
      ${m.white ? `<div class="players">${player(1, m.white, m.ratingWhite)}${player(2, m.black, m.ratingBlack)}</div>` : ''}
      <hr><div>${themes.map((t) => `<a class="tag" href="#/glossary/${t}" title="${esc(THEMES[t].desc)}">${THEMES[t].name}</a>`).join('') || '<span class="sub">No themes</span>'}</div>`;
    const sb = $('#share-link');
    if (sb) sb.onclick = () => sharePuzzle(p);
    loadLz(); // (for the ↗ by the step buttons)
  }

}

// Move list, Lichess-style: a fixed-height scrolling table (number | White | Black). The game so far is
// dim; when its last plies are a line the game never played (unplayedPlies), a divider marks where the game
// leaves off and those plies are dashed-underlined; your misses sit struck-through in the cell of the move you
// were looking for, and your own line is an indented row at its branch point. Click any move to see it.
// On phones, after the puzzle, the result, engine and step buttons dock below it (docked).
function renderMoves(docked, delta, focusNext) {
  const { p } = S;
  const official = officialLine();
  const startPly = S.hist.length ? 0 : Game.fromTPS(p.tps).ply;
  const viewIdx = S.view ?? shownLine().length;
  const onShared = (i) => !S.onBranch || (S.branch && i + 1 <= S.branch.at); // official moves also on your line
  const po = S.playOn || S.free; // a play-on game shows after the puzzle's moves, in italics, instead of its move as a miss (a free game too)
  const missesAt = (k) => S.misses.filter((x) => x.at === k && !(po && x.at === po.at && x.ptn === po.miss)).map((x) => `<span class="miss" title="Not the move">${esc(x.ptn)}</span>`).join('');
  const off = unplayedPlies(p.meta), cut = off ? S.hist.length - off : -1; // cut: index of the first unplayed ply
  const cells = []; // one entry per ply slot: { ply, html }
  official.forEach((m, i) => {
    const k = i - S.hist.length;
    const mvObj = k >= 0 ? S.moves[k] : null;
    const cls = ['mv', k < 0 ? (cut >= 0 && i >= cut ? 'unplayed' : 'past') : mvObj?.po ? 'po' : mvObj?.shown ? 'me shown' : mvObj?.me ? 'me ok' : 'opp', onShared(i) && i + 1 === viewIdx ? 'cur' : ''].join(' ');
    const tip = k < 0 && cut >= 0 && i >= cut ? ' title="Not played in the game"' : '';
    cells.push({ ply: startPly + i, i, html: `${k >= 0 ? missesAt(k) : ''}<span class="${cls}"${tip} data-i="${i + 1}">${esc(m)}</span>` });
  });
  if (po) po.line.forEach((m, j) => cells.push({ ply: startPly + official.length + j, i: official.length + j,
    html: `${j ? '' : missesAt(S.moves.length)}<span class="mv po" title="${S.free ? `Played on against ${S.free.name}` : `Played out against ${defenderName(po)}`}">${esc(m)}</span>` }));
  else if (S.misses.some((x) => x.at === S.moves.length)) cells.push({ ply: startPly + official.length, i: official.length, html: missesAt(S.moves.length) });
  const branchRow = () => {
    const b0 = S.branch.at;
    const moves = S.branch.moves.map((m, j) => {
      const ply = startPly + b0 + j;
      const num = ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}.` : j === 0 ? `${Math.floor(ply / 2) + 1}…` : '';
      return `${num ? `<span class="num">${num}</span>` : ''}<span class="mv ${S.onBranch && b0 + j + 1 === viewIdx ? 'cur' : ''}" data-b="${b0 + j + 1}">${esc(m)}</span>`;
    }).join(' ');
    return `<div class="mrow branch"><span class="branch-label">Your line</span> ${moves} <button class="link back" data-act2="back">Back to the solution</button></div>`;
  };
  const gameEnd = `<div class="mrow game-end">Below: a line not played in the game</div>`;
  let rows = cut === 0 ? gameEnd : ''; // the whole history is the line (clamped): divider before the first move
  for (let c = 0; c < cells.length; ) {
    const first = cells[c];
    if (!first) break;
    const moveNo = Math.floor(first.ply / 2) + 1;
    const white = first.ply % 2 === 0 ? first : null;
    // If the game leaves off after White's move, the row ends there and Black's unplayed reply starts the next one
    // ("12. … b2", as Lichess splits a row for a comment), so the divider falls between them.
    const black = white ? (cells[c + 1] && cells[c + 1].ply === first.ply + 1 && cells[c + 1].i !== cut ? cells[c + 1] : null) : first;
    rows += `<span class="mnum">${moveNo}</span><span class="mcell">${white ? white.html : '<span class="dots">…</span>'}</span><span class="mcell">${black ? black.html : ''}</span>`;
    if (cut > 0 && [white, black].some((x) => x && x.i + 1 === cut)) rows += gameEnd;
    // Your line goes under the row it branches from, including from White's move (replacing Black's reply).
    if (S.branch && [white, black].some((x) => x && S.branch.at === x.i + 1)) rows += branchRow();
    c += white && black ? 2 : 1;
  }
  if (S.branch && S.branch.at === 0) rows = branchRow() + rows;
  const mv = $('#moves');
  const prevScroll = mv.querySelector('.mscroll')?.scrollTop ?? 0;
  const engineHtml = engineMarkup(docked);
  const fa = mv.contains(document.activeElement) ? document.activeElement : null;
  const navFocus = fa?.dataset.step ? `[data-step="${fa.dataset.step}"]` : null;
  const hadNext = document.activeElement?.dataset?.act === 'next'; // the dock's or the card's: keep it across layout flips
  const pvWas = pvFocused();
  const clean = S.outcome === 'clean';
  // A server notice (slow or unreachable) replaces the result, so a Next puzzle that's waiting doesn't look dead.
  const dockHead = notice ? `<span class="icon bad" aria-hidden="true">!</span><b>${esc(notice.title)}</b>`
    : `<span class="icon ${clean ? 'good' : 'bad'}" aria-hidden="true">${clean ? '✓' : '✗'}</span><b>${solvedTitle()}${delta}</b>`;
  const dockNote = notice ? esc(notice.body) : dockNoteText();
  const engSlot = `<div class="eng-slot${ANALYSIS ? '' : ' row'}">${engineHtml}</div>`;
  const scroller = `<div class="mscroll" role="group" aria-label="Moves"><div class="mtable">${rows}</div></div>`;
  const nav = `<div class="nav"><button data-step="first" title="Start" aria-label="Start">⏮</button><button data-step="prev" title="Back (←)" aria-label="Back">◀</button><button data-step="next" title="Forward (→)" aria-label="Forward">▶</button><button data-step="last" title="Current position" aria-label="Current position">⏭</button>${S.status === 'solved' ? '<a class="navlink" data-ninja target="_blank" rel="noopener" title="Open this line in PTN Ninja" aria-label="Open this line in PTN Ninja">↗</a>' : ''}${S.view != null ? '<span class="muted">viewing an earlier position</span>' : ''}</div>`;
  mv.innerHTML = docked ? scroller + `<div class="dock"><div class="dock-res">${dockHead}<button class="primary" data-act="next">Next puzzle</button>${dockNote ? `<p>${dockNote}</p>` : ''}</div>${engSlot}${nav}</div>`
    : engSlot + scroller + nav;
  fitDock();
  if (ANALYSIS) fadeLong();
  if (dockRO) { dockRO.disconnect(); const d = mv.querySelector('.dock'); if (d) dockRO.observe(d); }
  if (navFocus) mv.querySelector(navFocus)?.focus();
  if (focusNext || hadNext) nextBtn()?.focus();
  refocusPV(pvWas);
  // Keep the current move in view by scrolling the table itself (never the page).
  const sc = mv.querySelector('.mscroll');
  sc.scrollTop = prevScroll; // keep where the reader was, then make sure the current move is visible
  const cur = S.view === 0 ? null : sc.querySelector('.mv.cur') || [...sc.querySelectorAll('.mv, .miss')].at(-1);
  if (S.view === 0) sc.scrollTop = 0; // the starting position: show the top of the game
  else if (cur) {
    const top = cur.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const rowH = cur.offsetHeight + 8, h = sc.clientHeight;
    if (top < sc.scrollTop || top + rowH > sc.scrollTop + h) sc.scrollTop = Math.max(0, top - h / 2 + rowH / 2);
  }

}

$('#moves').addEventListener('click', (e) => {
  if (!S || S.placeholder) return;
  if (e.target.closest('[data-act2="back"]')) return backToSolution();
  const pvb = e.target.closest('[data-pv]');
  if (pvb) { const [L, k] = pvb.dataset.pv.split('.').map(Number); return playPV(L, k); }
  // a line's chip (or its row): select it (its moves in the dock); the selected chip again
  // plays its first move
  if (ANALYSIS && e.target.closest('[data-thr]')) return toggleThreats();
  const ln = ANALYSIS && e.target.closest('[data-line]');
  if (ln && S.status === 'solved') {
    const L = +ln.dataset.line;
    if (L === S.sel && ln.matches('.chip')) return playPV(L, 0);
    S.sel = L; S.selUser = true; renderEngine(); return;
  }
  const m = e.target.closest('[data-i]');
  if (m) return viewPly(+m.dataset.i, false);
  const b = e.target.closest('[data-b]');
  if (b) return viewPly(+b.dataset.b, true);
  const nx = e.target.closest('[data-act="next"]'); // the phone dock's Next puzzle
  if (nx) { if (justViewed() || justEnded()) return; const kb = nx.matches(':focus-visible'); return loadNext().then(() => { if (kb) $('#ptn-in')?.focus(); }); }
  const total = shownLine().length, cur = S.view ?? total;
  const n = e.target.closest('[data-step]')?.dataset.step;
  if (n === 'next') return navStep(1, false); // (as the → key: a step forward sounds its move)
  if (n) viewPly({ first: 0, prev: cur - 1, next: cur + 1, last: total }[n]);
});

// ---------- confirm moves (Settings) ----------
// settings.js has the rules. The board shows the held move (it's already played there, and the opponent is to move,
// so the board takes no more input); the bar under the board says which move, its room kept while the setting is on
// so nothing moves when it appears, and the board gets a ring. Registered before the Enter = Continue key handler.
let pend = null; // the held move, with its puzzle state (s)
function moveIn(ptn) {
  if (!holds(confirmOn(prefs), S, S && !S.placeholder && tooSoon(S))) return userMove(ptn);
  pend = { ...pending(ptn, S, performance.now()), s: S };
  board.ui({ disableBoard: true }); // (PTN Ninja: also hands keyboard focus back to the page, for Enter and Esc)
  renderPending();
}
function renderPending() {
  const bar = $('#confirm-bar');
  bar.hidden = !confirmOn(prefs);
  bar.classList.toggle('idle', !pend);
  $('#board-wrap').classList.toggle('pending', !!pend);
  $('#confirm-msg').innerHTML = pend ? `Confirm <b>${esc(pend.ptn)}</b>?` : '';
}
// Confirmed: the move goes to the solving flow now, timed now, exactly as an unconfirmed move would have.
function confirmPending() {
  const p = pend;
  pend = null; renderPending();
  if (!p || S !== p.s) return;
  board.ui({ disableBoard: false });
  userMove(p.ptn);
}
// Cancelled: the board goes back to the position before the move (as after a refused move); nothing else changed.
function cancelPending() {
  const p = pend, s = p?.s;
  pend = null; renderPending();
  if (!p || S !== s) return;
  if (s.free) return showFree(s).then(() => { if (S === s && s.free && !s.free.over && !s.busy && !pend) board.ui({ disableBoard: false }); });
  if (s.playOn && !s.playOn.end) return showPlayOn(s).then(() => { if (S === s && s.playOn && !s.busy && !pend) board.ui({ disableBoard: false }); });
  else if (s.status === 'play' || s.status === 'retry') return restoreBoard();
  else if (s.status === 'solved') { s.loadedKey = null; showLine(shownLine(), s.view ?? shownLine().length).then(() => { if (S === s) openExploration(); }); }
}
// Enter on a move typed while another is held: the held one is cancelled and, once the board is back, the typed one is
// played there, to be held in turn (settings.js pendingAct 'replace'). Only ever held, never sent: if anything changed
// meanwhile (another puzzle, another move, the text edited) or the move wouldn't be held now, the text stays in the box.
function replacePending(text) {
  const s = pend?.s;
  Promise.resolve(cancelPending()).then(() => {
    if (S !== s || pend || $('#ptn-in').value.trim() !== text) return;
    if (!holds(confirmOn(prefs), S, S && !S.placeholder && tooSoon(S))) return; // only ever held
    typedMove();
  });
}
const dropPending = () => { if (pend) { pend = null; renderPending(); } };
function pendingEvent(ev) {
  const a = pendingAct(pend, ev, performance.now());
  if (a === 'confirm') confirmPending(); else if (a === 'cancel') cancelPending(); else if (a === 'replace') replacePending(ev.text);
  return a;
}
document.addEventListener('visibilitychange', () => { if (document.hidden) pendingEvent({ type: 'leave' }); });
$('#confirm-yes').addEventListener('click', () => pendingEvent({ type: 'button', which: 'confirm' }));
$('#confirm-no').addEventListener('click', () => pendingEvent({ type: 'button', which: 'cancel' }));
// A tap anywhere else on the page cancels, and does only that (Hint, a move in the list, a link: press again). (PTN
// Ninja's taps stay inside its frame, and its board is off meanwhile.)
document.addEventListener('click', (e) => {
  if (!pend || e.target.closest?.('#confirm-bar')) return;
  e.stopPropagation(); e.preventDefault();
  pendingEvent({ type: 'elsewhere' });
}, true);
// Enter confirms, Esc cancels, the board's other keys wait (settings.js takesHeldKey says which keys, where).
window.addEventListener('keydown', (e) => {
  if (!pend || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const typed = t?.id === 'ptn-in';
  if (!takesHeldKey({ key: e.key, typed, field: !!t?.closest?.('input, select, textarea, [contenteditable]'),
    bar: !!t?.closest?.('#confirm-bar'), control: !!t?.closest?.('a, button, summary') && !focusedByPointer(t) })) return;
  e.preventDefault(); e.stopImmediatePropagation();
  pendingEvent({ type: 'key', key: e.key, repeat: e.repeat, text: typed ? t.value.trim() : '' }); // (a move typed there: 'replace')
}, { capture: true });

// ---------- controls ----------
// buttons inside the feedback card
$('#feedback').addEventListener('click', async (e) => {
  if (!S || S.placeholder) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if ((act === 'hint' || act === 'solution') && (fresh(S) || !board.available)) return; // a tap meant for the last puzzle's Next; or no board
  if (act === 'hint') return showHint();
  if (act === 'solution') return showSolution();
  if (act === 'free') return startFree();
  if (act === 'free-back') return leaveFree(S, 'back');
  if (act === 'free-undo') return freeTakeBack();
  if (act === 'giveup') { if (busy('giveup', S.playOn?.t0 ?? 0)) return; return endPlayOn(S, 'gaveup'); }
  if (act === 'next') {
    if (justViewed() || justEnded()) return;
    const kb = e.target.matches(':focus-visible'); // keyboard user: put them back in the move input
    await loadNext();
    if (kb) $('#ptn-in')?.focus();
  }
});
const themeDesc = () => { $('#theme-desc').textContent = prefs.theme && THEMES[prefs.theme] ? THEMES[prefs.theme].desc + (THEMES[prefs.theme].fullWeight ? ' These count in full for your rating.' : ' Knowing the theme is a hint, so wins here barely raise your rating.') : 'A mix of everything. You don’t know what’s coming, just like in a real game.'; };
$('#difficulty').value = prefs.difficulty;
// A filter changed with the mouse lets go of focus, or number keys meant for the board would go to it (on Board size,
// 4–8 even pick a size). Changed from the keyboard, it keeps focus.
for (const id of ['#difficulty', '#size', '#theme']) $(id).addEventListener('change', (e) => { if (focusedByPointer(e.target)) e.target.blur(); });
$('#difficulty').onchange = (e) => { prefs.difficulty = e.target.value; store.set('prefs', prefs); loadNext(); };
$('#size').onchange = (e) => { prefs.size = e.target.value; store.set('prefs', prefs); renderFilters().catch(() => {}); loadNext(); };
$('#theme').onchange = (e) => { prefs.theme = e.target.value; store.set('prefs', prefs); themeDesc(); loadNext(); };
// Settings (settings.js), on the Settings page (#/settings) only: the board's theme and look, Confirm moves and Sound
// (the puzzle page links there). Engine arrows is no setting (Sasha, 2026-11-21). setSetting is the one writer: it stores the value, checks it was kept (site storage may be
// blocked), does what the setting does on this page, puts the page's controls in step, and for a change made there
// saves it to the account (prefsync.js). from: 'here' (a control), 'account' (the account's
// settings, arriving with /api/me, a sign-in or a post's answer) or 'tab' (another tab of this site changed it:
// already stored, and that tab sends it).
// (There is no Board setting any more: PTN Ninja is the only board. A board value stored here or on the account is
// carried as it is and never read: prefsync.js OTHER.)
let unsaved = false;
const showNote = () => {
  const note = settingsNote({ unsaved });
  const pn = $('#st-note'); // (under the Settings page's list; not built until the page is first opened)
  if (pn) { pn.textContent = note; pn.classList.toggle('hidden', !note); }
};
// Each select's options, its value for a setting, and the setting for a select's value.
const CTL = {
  confirm: { opts: [['off', 'Off'], ['on', 'On']], show: () => (confirmOn(prefs) ? 'on' : 'off'), read: (v) => v === 'on' },
  sound: { opts: [['off', 'Off'], ['light', 'Light'], ['thunk', 'Thunk'], ['deep', 'Deep']], show: () => soundOf(prefs), read: (v) => soundOf({ sound: v }) },
};
function showSettings() {
  for (const [k, c] of Object.entries(CTL)) { const el = $('#st-' + k); if (el) el.value = c.show(); }
  renderLookField(); showNote(); renderSyncStatus();
}
function setSetting(key, value, from = 'here') {
  const was = prefs[key];
  if (key === 'ninja' && !value) delete prefs.ninja; else prefs[key] = value;
  if (from !== 'tab') {
    store.set('prefs', prefs);
    // Not kept (site storage blocked): put back as it was, and say so.
    if (syncedOf(store.get('prefs', {}))[key] !== syncedOf(prefs)[key]) {
      if (was === undefined) delete prefs[key]; else prefs[key] = was;
      unsaved = true;
      showSettings(); return false;
    }
    unsaved = false;
  }
  // Marked unsent before anything else: the next boot must send this change, not take the account's old value back
  // (settingsArrived).
  if (from === 'here') markUnsent([key]);
  if (key === 'confirm') {
    if (!prefs.confirm) pendingEvent({ type: 'leave' });
    renderPending();
  } else if (key === 'sound') {
    sound.setEnabled(soundOn(prefs)); sound.setVoice(soundOf(prefs));
    if (from === 'here' && soundOn(prefs)) { sound.unlock(); setTimeout(() => sound.play('flatBoard'), 60); } // a preview in the chosen voice (the change is a gesture)
  } else if (key === 'ninja') board.setLook(prefs.ninja || '');
  showSettings();
  if (from === 'here') pushSettings();
  return true;
}

// ---- settings saved to the account (prefsync.js) ----
// Only for a named account (a guest or a signed-out player keeps them on this device, as before). A change here posts
// only the keys changed (POST /api/settings { changes }, laid over what the account holds), so an out-of-date tab or
// device never puts back old values of the others. Until the account confirms a key, this device's value wins for that
// key (setUnsent: { o: the account, as owner()'s hash of the token; k: the keys }), and it is sent again with the next
// change and at the next boot (settingsArrived). Every other key takes the account's value. Settings this page doesn't
// have (prefsync.js OTHER: the beta's) are never applied, posted or dropped here, in storage, the mark or the account.
const named = () => !!(token && me?.name);
let serverSettings = null, syncState = 'saved', postSeq = 0;
const unsent = () => unsentKeys(store.get('setUnsent', null), owner());
// Add keys to this account's unsent mark, or (keep) set this page's keys in it to exactly these.
function markUnsent(keys, keep = false) {
  if (!named()) return;
  const mark = withUnsent(store.get('setUnsent', null), owner(), keep ? keys : [...unsent(), ...keys]);
  if (mark) store.set('setUnsent', mark); else store.del('setUnsent');
}
if (token && unsent().length) syncState = 'saving'; // (sent as soon as /api/me answers; 'unsent' if that fails)
// The current stored prefs (another tab may have changed one since this tab read them), else this tab's.
const prefsNow = () => (STORAGE_OK ? store.get('prefs', prefs) : prefs);
const deviceNow = () => syncedOf(prefsNow());
// first: the account has nothing stored yet, so the post also carries this browser's settings of other pages
// (prefsync.js carried), as they are.
async function pushSettings(keys = [], first = false) {
  if (!named()) return;
  markUnsent(keys);
  const dirty = unsent();
  if (!dirty.length) return;
  const seq = ++postSeq, tok = token, body = changesBody(deviceNow(), dirty);
  if (first) body.changes = { ...carried(prefsNow()), ...body.changes };
  syncState = 'saving'; renderSyncStatus();
  let r = null;
  try { r = await api('/api/settings', body, { quiet: true, timeout: 15000 }); } catch {}
  if (seq !== postSeq || token !== tok) return; // a later change is on its way (it decides), or another account now
  if (r?.settings && typeof r.settings === 'object' && !r.error) {
    markUnsent(afterPost(unsent(), body.changes, deviceNow()), true);
    syncState = 'saved'; takeServer(r.settings); // (another device's newer value for another key arrives here too)
  } else syncState = 'unsent';
  renderSyncStatus();
}
// The account's settings as they stand: every value cleaned as one from this browser's storage is (prefsync.js
// syncedOf); what differs is applied, except this device's unsent keys.
// → decide's answer (post: the keys to send).
function takeServer(settings) {
  serverSettings = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : null;
  const d = decide({ device: syncedOf(prefs), dirty: unsent(), server: serverSettings });
  for (const k of Object.keys(d.apply)) setSetting(k, d.apply[k], 'account');
  return d;
}
// An answer carrying the signed-in account's settings (/api/me, /api/login, /api/register).
function settingsArrived(r) {
  if (!r || typeof r !== 'object' || !('settings' in r) || !named()) return;
  const { post, first } = takeServer(r.settings);
  if (post.length) pushSettings(post, first); else { syncState = 'saved'; renderSyncStatus(); } // (nothing unsent: decide posts every unsent key)
}
// Another tab of this site changed a setting: take it here too, so this tab's next save doesn't put the old value back
// (in this browser's storage or, through its unsent keys, on the account). That tab sends it. The settings this page
// doesn't have are taken as they are, so this tab's next write of the prefs (a filter, say) keeps the other tab's.
window.addEventListener('storage', (e) => {
  if (e.key !== 'tinue.prefs') return; // (not a clear(): that is no setting chosen)
  const stored = store.get('prefs', {});
  for (const k of OTHER) if (stored && Object.hasOwn(stored, k)) prefs[k] = stored[k]; else delete prefs[k];
  const now = syncedOf(stored);
  for (const k of diff(syncedOf(prefs), now)) setSetting(k, now[k], 'tab');
});
function renderSyncStatus() {
  const el = $('#st-status');
  if (el) el.textContent = syncStatus({ blocked: unsaved || !STORAGE_OK, named: named(), state: syncState });
}

// ---- the Settings page (#/settings) ----
// Each setting has one plain line.
function settingsPage() {
  // An index.html cached from before this page (a CDN edge can serve one for minutes after a deploy, with this app.js)
  // has no <main> for it: add it where the HTML has it, before the footer.
  if (!$('#view-settings')) {
    const m = Object.assign(document.createElement('main'), { id: 'view-settings', className: 'page settings-page hidden' }), f = $('footer.credits');
    if (f) f.before(m); else document.body.append(m);
  }
  show('view-settings');
  const el = $('#view-settings');
  if (!el.firstChild) {
    const sel = (k, label, desc, extra = '') => `<div class="set-item"><label for="st-${k}">${label}</label><select id="st-${k}" aria-describedby="st-${k}-d"></select>
      <p class="set-desc" id="st-${k}-d">${desc}</p>${extra}</div>`;
    el.innerHTML = `<h1>Settings</h1><p class="set-status" id="st-status" role="status"></p>
      <div class="panel set-list">
        <p class="set-desc set-note hidden" id="st-note"></p>
        <div class="set-item"><label for="st-ninja-theme">Board theme</label><select id="st-ninja-theme" aria-describedby="st-ninja-theme-d">
          <option value="">tinue felt</option><option value="legacy">tinue classic</option>${NINJA_THEMES.map((id) => `<option value="${id}">${themeName(id)}</option>`).join('')}<option value="custom" hidden>Custom</option></select>
          <p class="set-desc" id="st-ninja-theme-d">The board’s colours. A theme of your own can be pasted below.</p></div>
        <div class="set-item"><label for="st-ninja">Board look</label>
          <form id="st-ninja-form" class="set-look"><input id="st-ninja" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="st-ninja-d st-ninja-msg" placeholder="A theme’s code, or &amp;axisLabels=false&amp;theme=zen">
            <button type="submit" id="st-ninja-use">Use</button><button type="button" id="st-ninja-clear">Clear</button></form>
          <p class="set-desc" id="st-ninja-d"></p><p class="set-desc set-msg" id="st-ninja-msg" aria-live="polite"></p></div>
        ${sel('confirm', 'Confirm moves', 'A move waits on the board until you confirm it: press Confirm or Enter.')}
        ${sel('sound', 'Sound', 'The sound of stones as they are played. Light, Thunk and Deep are different stones.', window.TINUE_BETA ? '<p class="set-desc"><a href="#/sounds" id="sound-lab-link">Sound lab</a></p>' : '')}
      </div><p><a href="#/">Back to puzzles</a></p>`;
    for (const k of Object.keys(CTL)) {
      const s = $('#st-' + k);
      for (const [v, t] of CTL[k].opts) s.append(new Option(t, v));
      s.onchange = (e) => { if (focusedByPointer(e.target)) e.target.blur(); setSetting(k, CTL[k].read(e.target.value)); };
    }
    $('#st-ninja-form').onsubmit = (e) => {
      e.preventDefault();
      const res = parseLook($('#st-ninja').value), msg = $('#st-ninja-msg');
      if (res.error || !res.applied.length) { msg.textContent = lookReport(res); return; } // nothing changes
      if (setSetting('ninja', encodeLook(res.look))) msg.textContent = lookReport(res);
    };
    // (the same stored look as the paste box: the theme changed in it, its other settings kept)
    $('#st-ninja-theme').onchange = (e) => {
      if (focusedByPointer(e.target)) e.target.blur();
      if (setSetting('ninja', withTheme(prefs.ninja || '', e.target.value))) $('#st-ninja-msg').textContent = prefs.ninja ? lookReport(parseLook(prefs.ninja)) : 'The board has tinue felt again.';
    };
    $('#st-ninja-clear').onclick = () => { if (setSetting('ninja', '')) $('#st-ninja-msg').textContent = 'The board has tinue felt again.'; };
    renderLookField(true);
  }
  showSettings();
}
// The look field. fresh: show what is in use (else a message about the last paste stays).
function renderLookField(fresh = false) {
  const inp = $('#st-ninja');
  if (!inp) return;
  const th = $('#st-ninja-theme'), cur = themeOf(prefs.ninja || '');
  th.querySelector('[value="custom"]').hidden = cur !== 'custom'; // (shown only while a pasted theme is in use)
  th.value = cur;
  $('#st-ninja-clear').disabled = !prefs.ninja;
  $('#st-ninja-d').textContent = 'A theme’s code from PTN Ninja’s theme editor, or settings as in a ptn.ninja link: axis labels, counts, layout, 3D.';
  if (document.activeElement !== inp) inp.value = showLook(prefs.ninja || '');
  if (fresh) $('#st-ninja-msg').textContent = prefs.ninja ? lookReport(parseLook(prefs.ninja)) : '';
}
renderPending();
// Stepping in half-moves, as in PTN Ninja: h = 2·plies shown, +1 while the next move's squares are only
// highlighted (Shift+arrow). Plain steps land on whole moves.
// step: a single step (arrow key, one wheel notch): one whole move forward plays its sound, as on Lichess; back,
// jumps (Home/End) and half-steps are silent.
let stepSoundAt = -1e9;
async function navTo(h, step = false) {
  if (!S || S.placeholder) return;
  const total = shownLine().length, s = S, from = navAt();
  h = Math.max(0, Math.min(2 * total, h));
  await viewPly(h >> 1);
  if (h & 1 && (S.view ?? total) === h >> 1) board.peek();
  if (step && S === s && !board.peeking && navAt() === 2 * ((from >> 1) + 1) && performance.now() - stepSoundAt > 60) {
    const snap = board.snaps?.[board.cur];
    if (snap?.ptn) { stepSoundAt = performance.now(); sound.playMove(snap.ptn, snap.smash, snap.land); }
  }
}
const navAt = () => 2 * (S.view ?? shownLine().length) + (board.peeking ? 1 : 0);
const navStep = (dir, half) => { const h = navAt(); navTo(half ? h + dir : h + dir * (h & 1 ? 1 : 2), dir > 0); };
// Captured first, so Enter = Continue wins over the board's Enter.
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !S) return;
  if (S.placeholder || $('#view-puzzle').classList.contains('hidden')) return;
  if (e.key === 'Enter') {
    // Enter = Continue, unless it's meant for whatever has focus (a button, a link, a field).
    // Kept: a key pressed on purpose. Not a held key's repeat, nor in the result's first second (justEnded): the Enter
    // that dropped the last stones of the winning move, held or pressed twice, would skip the result unseen.
    if (S.status === 'solved' && !e.target.closest?.('a, button, input, select, textarea, [contenteditable]')) {
      e.preventDefault();
      if (!e.repeat && !justEnded()) loadNext();
    }
    return;
  }
  const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (e.key === 'Home' || e.key === 'End' || (dir && e.ctrlKey)) { e.preventDefault(); navTo(e.key === 'Home' || dir < 0 ? 0 : Infinity); }
  else if (dir && !e.altKey && !e.metaKey) { e.preventDefault(); navStep(dir, e.shiftKey); }
  // (Escape, number keys and rotation are the board's: PTN Ninja's, ninja.js.)
}, { capture: true });
// Scroll wheel over the board steps through moves (mouse and trackpad only; a phone's swipe still scrolls the page).
let wheelAcc = 0;
$('#board').addEventListener('wheel', (e) => {
  if (!finePointer.matches || !S || S.placeholder || pend || e.ctrlKey) return;
  e.preventDefault();
  const step = devicePixelRatio * 100, d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1);
  if (Math.sign(d) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelAcc += d;
  const times = Math.trunc(wheelAcc / step);
  if (!times) return;
  wheelAcc -= times * step;
  const h = navAt();
  navTo(e.shiftKey ? h + times : 2 * ((h + (times > 0 ? 0 : 1)) >> 1) + 2 * times, times === 1);
}, { passive: false });
// Typed moves (keyboard / screen reader): played on the board exactly as if clicked.
$('#ptn-form').addEventListener('submit', (e) => { e.preventDefault(); typedMove(); });
function typedMove() {
  const inp = $('#ptn-in'), ptn = inp.value.trim();
  if (!ptn) return;
  const ok = board.play(ptn);
  inp.setAttribute('aria-invalid', ok ? 'false' : 'true');
  $('#ptn-err').textContent = typedErr(ptn, ok); // (a red edge alone was easy to miss, and silent to a screen reader)
  if (ok) inp.value = ''; else inp.select();
}
// One message for a refused typed move: board.play() can't tell bad notation from an illegal move.
const typedErr = (ptn, ok) => (ok ? '' : `Can’t play ${ptn} here.`);
// Cleared on typing, and on leaving the box: the board may move on meanwhile, and the message spoke of that position.
const typedOk = (e) => { e.target.removeAttribute('aria-invalid'); $('#ptn-err').textContent = ''; };
$('#ptn-in').addEventListener('input', typedOk);
$('#ptn-in').addEventListener('blur', typedOk);

async function renderFilters() {
  const t = await api('/api/themes' + (prefs.size ? '?size=' + prefs.size : ''));
  if (!t?.sizes || !t.themes) return; // (an error's answer: the menus stay as they are)
  const sel = $('#size');
  sel.innerHTML = '<option value="">Any size</option>' + Object.keys(t.sizes).sort().map((s) => `<option value="${s}">${s}×${s} (${t.sizes[s]})</option>`).join('');
  sel.value = prefs.size || '';
  const groups = {};
  // the chosen theme stays listed even with no puzzles at this size ("Quiet move (0)"), so the select is never blank
  for (const [k, v] of Object.entries(THEMES)) if ((t.themes[k] || k === prefs.theme) && v.group !== 'Board') (groups[v.group] ||= []).push(k);
  $('#theme').innerHTML = `<option value="">Mix (everything)</option>` + Object.entries(groups).map(([g, ks]) =>
    `<optgroup label="${g}">${ks.map((k) => `<option value="${k}">${THEMES[k].name} (${t.themes[k] || 0})</option>`).join('')}</optgroup>`).join('');
  $('#theme').value = prefs.theme || '';
  themeDesc();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-theme]');
  // Practice a theme: route() then loads a puzzle with it (the puzzle in progress stays only if it has the theme).
  if (a) { e.preventDefault(); prefs.theme = a.dataset.theme; store.set('prefs', prefs); go('#/'); }
});

// ---------- pages ----------
const TITLES = { 'view-glossary': 'Glossary', 'view-me': 'History', 'view-leaderboard': 'Leaderboard', 'view-rush': 'Rush', 'view-sounds': 'Sound lab', 'view-settings': 'Settings' };
function setTitle() {
  const page = Object.keys(TITLES).find((v) => $('#' + v) && !$('#' + v).classList.contains('hidden'));
  document.title = page ? `${TITLES[page]} — tinue` : S && !S.placeholder ? `Puzzle #${S.p.id} — tinue` : 'tinue — Tak puzzles';
}
function show(id) {
  if (id !== 'view-puzzle') pendingEvent({ type: 'leave' });
  for (const v of ['view-puzzle', ...Object.keys(TITLES)]) $('#' + v)?.classList.toggle('hidden', v !== id);
  setTitle();
  fitDock(); // the dock (and the room reserved for it) belongs to the puzzle page only
  syncClock(); // another page pauses the puzzle's solve-time clock
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.getAttribute('href') === (location.hash.replace(/^(#\/[a-z]*).*$/, '$1') || '#/').replace('#/puzzle', '#/'));
}

// A theme's Practice link: the count alone (no "1 puzzles"), never split across lines. The gap before it is a space
// (widened in CSS), not a margin, so a link that wraps to a new line starts at its edge instead of indented.
const practiceLink = (k, n) => `<span class="gap"> </span><a href="#/" class="practice" data-theme="${k}">Practice (${n.toLocaleString()})</a>`;
// A page the server didn't give (no answer, or an error's): said in its place.
const pageError = (el, title) => { el.innerHTML = `<h1>${title}</h1><div class="panel"><p class="flush">Can’t reach the puzzle server. Check your connection and reload. If it keeps happening, the server may be down.</p></div>`; };
async function glossaryPage() {
  show('view-glossary');
  const slug = (w) => w.toLowerCase().replace(/[^a-z]+/g, '-');
  const themeRows = Object.entries(THEMES).filter(([k, v]) => v.group !== 'Board').map(([k, v]) =>
    `<dt id="${k}">${v.name}</dt><dd>${esc(v.desc)}<span data-count="${k}"></span></dd>`).join('');
  $('#view-glossary').innerHTML = `<div class="glossary"><h1>Glossary</h1>
    <h2>Tak basics</h2><dl>${GLOSSARY.map(([w, d]) => `<dt id="${slug(w)}">${w}</dt><dd>${esc(d)}</dd>`).join('')}</dl>
    <h2>Puzzle themes</h2><p class="muted">Every puzzle is tagged automatically from its solution. You can drill one theme from the Theme menu on the puzzle page.</p>
    <dl>${themeRows}</dl></div>`;
  const anchor = location.hash.split('/')[2], term = anchor && document.getElementById(anchor);
  term?.scrollIntoView({ block: 'center' });
  const y = scrollY;
  // The words are the page's own; the Practice links join them once the counts (for the Board you practice on) are here,
  // and make the list longer: the term goes back to the middle, unless the player has scrolled since (or left: then it has no place).
  const spots = [...document.querySelectorAll('#view-glossary [data-count]')];
  const t = await api('/api/themes' + (prefs.size ? '?size=' + prefs.size : '')).catch(() => null);
  const still = scrollY === y;
  for (const el of spots) { const n = t?.themes?.[el.dataset.count]; if (n) el.outerHTML = practiceLink(el.dataset.count, n); }
  if (still) term?.scrollIntoView({ block: 'center' });
}

// History's Change and When cells, in the words the rest of the site uses: the puzzle page's signs (a real minus),
// "unrated" (never "casual"), and Rush's short dates ("Today, 2:41 PM": no seconds, which wrapped on phones).
const histChange = (r) => r.refund && !Math.round(r.user_delta) ? '<span class="muted">0</span>' // a refund's change is its net effect, often nothing
  : r.rated ? `<span class="delta ${r.user_delta >= 0 ? 'up' : 'down'}">${signed(r.user_delta)}</span>` : '<span class="muted">unrated</span>';
const histWhen = (t, now = Date.now()) => { try { return whenText(t, now); } catch { return new Date(t).toLocaleString(); } };
async function mePage() {
  show('view-me');
  const el = $('#view-me');
  const claim = 'Claim a username at the top right to be on the leaderboard and to sign in on other devices.';
  if (!me) { el.innerHTML = `<h1>History</h1><div class="panel"><p class="flush">Your puzzles will show up here. ${claim}</p></div>`; return; }
  // (me fresh too: another tab may have played since this one loaded, and the chart ends at me.rating)
  const [got, fresh] = await Promise.all([api('/api/history').catch(() => null), api(withBuild('/api/me')).catch(() => null)]);
  if (fresh?.user) { me = fresh.user; renderUser(); settingsArrived(fresh); }
  const h = got?.history;
  if (!Array.isArray(h)) return pageError(el, 'History');
  const tok = me.name ? token : null; // a guest has no name to sign in as elsewhere: claiming one comes first
  // rating chart
  const rated = h.filter((r) => r.rated).reverse();
  const pts = rated.length ? [rated[0].user_rating, ...rated.map((r) => r.user_rating + r.user_delta)] : [me.rating];
  if (Math.abs(pts.at(-1) - me.rating) > 0.5) pts.push(me.rating); // ends at the rating shown above (a refund moves it)
  const W = 860, H = 160, lo = Math.min(...pts) - 20, hi = Math.max(...pts) + 20;
  const path = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1)) * W},${H - ((v - lo) / (hi - lo)) * H}`).join('');
  el.innerHTML = `<h1>${me.name ? esc(me.name) : 'History'}</h1>${me.name ? '' : `<div class="panel"><p class="flush">You’re playing as a guest: this browser remembers you. ${claim}</p></div>`}<p class="muted">Rating <b class="your-rating">${fmtRating(me.rating, me.provisional)}</b></p>
    <p class="muted">${me.games} rated puzzle${me.games === 1 ? '' : 's'}, ${me.wins} solved first try.${tok ? ' Your login token (paste on another device):' : ''}</p>
    ${tok ? `<div class="token"><input id="token-out" readonly value="${esc(tok)}" aria-label="Login token"><button id="token-copy">Copy</button></div>` : ''}
    <div class="chart"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="#3692e7" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div>
    <table class="t hist"><tr><th>Puzzle</th><th>Result</th><th>Puzzle rating</th><th>Change</th><th>When</th></tr>
    ${h.map((r) => `<tr><td><a href="#/puzzle/${esc(r.puzzle_id)}">#${esc(r.puzzle_id)}</a> <span class="muted">${r.size}×${r.size}, ${r.plies} ${r.plies === 1 ? 'ply' : 'plies'}</span></td>
      <td>${r.win ? '✓' : '✗'}${r.refund ? ' <span class="muted" title="Refunded: counted as solved">refunded</span>' : ''}</td><td>${Math.round(r.puzzle_rating)}</td>
      <td>${histChange(r)}</td><td class="muted">${esc(histWhen(r.ts))}</td></tr>`).join('')}</table>`;
  const out = $('#token-out');
  if (out) {
    out.onfocus = () => out.select();
    $('#token-copy').onclick = async () => {
      out.select();
      try { await navigator.clipboard.writeText(tok); } catch { document.execCommand?.('copy'); }
      $('#token-copy').textContent = 'Copied';
    };
  }
}

async function leaderPage() {
  show('view-leaderboard');
  const leaders = (await api('/api/leaderboard').catch(() => null))?.leaders;
  if (!Array.isArray(leaders)) return pageError($('#view-leaderboard'), 'Leaderboard');
  $('#view-leaderboard').innerHTML = `<h1>Leaderboard</h1><p class="muted">A “?” means the rating is still provisional: it settles after about 15 rated puzzles.</p>` + (leaders.length
    ? `<table class="t"><tr><th>#</th><th>Player</th><th>Rating</th><th>Puzzles</th></tr>${leaders.map((l, i) =>
      `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${fmtRating(l.rating, l.provisional)}</td><td>${l.games}</td></tr>`).join('')}</table>`
    : `<div class="panel"><p class="flush">Nobody is on the leaderboard yet. Claim a username, solve a puzzle and you could be first.</p></div>`);
}

// Hash routes (#/, #/puzzle/ID, #/glossary[/term], #/me, #/leaderboard, #/rush, #/settings) so it works as static files.
let rushPage = null; // rush.js, once #/rush has been visited
let labPage = null; // sound-lab.js, once #/sounds has been visited (beta builds)
function go(hash) {
  if (location.hash !== hash) location.hash = hash; // triggers route() via hashchange
  else route();
}

async function route() {
  ++loadSeq; // whatever this navigation shows, a puzzle load still in flight is now stale
  // a hash wins (in-app links); else the path (<app>/puzzle/<id>, the address shown for a puzzle)
  const pathRoute = location.pathname.slice(APP.length);
  const [, page, arg, symArg] = (location.hash && location.hash !== '#' ? location.hash : '#/' + pathRoute).split('/');
  // A Rush row's one-shot note for this navigation only (rush.js lookFrom): read and cleared on every route.
  let look = null; try { look = JSON.parse(sessionStorage.getItem('tinue.lookFrom')); sessionStorage.removeItem('tinue.lookFrom'); } catch {}
  if (page !== 'rush') rushPage?.leave(); // a run in progress ends unposted (rush.js)
  if (page !== 'sounds') labPage?.leave(); // the lab's previews stop and its own audio context closes
  if (page === 'glossary' || page === 'me' || page === 'leaderboard' || page === 'rush' || page === 'settings') showHashURL('#/' + (location.hash || '#/' + pathRoute).split('/').slice(1).join('/'));
  if (page === 'glossary') return glossaryPage();
  if (page === 'me') return mePage();
  if (page === 'leaderboard') return leaderPage();
  if (page === 'settings') return settingsPage();
  if (page === 'rush') { show('view-rush'); return (rushPage ||= await import('./rush.js?v=1795581795')).enter({ frame: board }); } // loaded on first visit; PTN Ninja's frame, which Rush borrows
  // The sound lab (sound-lab.js): beta builds only; elsewhere #/sounds is no page at all (it falls through to puzzles)
  if (page === 'sounds' && window.TINUE_BETA && $('#view-sounds')) { show('view-sounds'); return (labPage ||= await import('./sound-lab.js?v=1795581795')).enter($('#view-sounds')); }
  show('view-puzzle');
  renderFilters().catch(() => {}); // the puzzle doesn't wait for the theme counts
  // Keeping the puzzle on screen: a Next this navigation superseded may have left it mid-way (needsRestore, busy) after
  // abandoning its check, so put its board back (restoreLeft does nothing otherwise).
  // (the same puzzle under another symmetry is another visit; a malformed one is 0 and the address is put right)
  const sym = symOf(symArg);
  if (page === 'puzzle' && arg) {
    const id = decodeURIComponent(arg);
    // An older Rush row (plain link plus a note) naming the puzzle on screen: its symmetry is worked out here, against the
    // puzzle as the server sent it, so a second click on the row returns to the visit (as a plain link always has; a
    // restart would leave/abandon the attempt) and a row that saw the puzzle turned still turns it.
    // (an explicit /0, a Rush row whose symmetry is known to be none, is a symmetry like any other: never resumed turned)
    const zero = symArg === '0';
    let want = sym, found = false;
    if (!sym && !zero && look?.id === id && S?.p.id === id && S.p0) {
      try { want = symFromRecord(S.p0, look); found = true; } catch {}
    }
    // A plain link (no symmetry, no Rush note) to the puzzle on screen returns to the visit as it stands, turned or
    // not: restarting it would abandon the attempt, and could cost a rated miss.
    if (!sym && !zero && !found && S?.p.id === id) want = symNow();
    if (S?.p.id !== id || symNow() !== want) loadById(id, want, found ? null : look); else { restoreLeft(); showPuzzleURL(S.p.id, want); }
  }
  else if (S && !S.placeholder && S.status !== 'solved' && matchesFilters(S.p)) { restoreLeft(); showPuzzleURL(S.p.id, symNow()); } // back to the puzzle in progress
  else loadNext();
}
window.addEventListener('hashchange', route);

(async () => {
  const cached = store.get('me', null);
  nextQ.resume(); // the puzzle picked after the last result here, if still fresh: the first puzzle needs no request
  if (cached && token) { me = { ...cached, rating: store.get('myRating', PLAYER_START.rating), provisional: store.get('myProv', true), games: 0, wins: 0 }; }
  renderUser();
  themeDesc();
  renderAll(); // placeholder panels at their final size
  board.load(buildPTN({ size: +(prefs.size || 6) })); // the same board component, empty, until the puzzle arrives
  requestAnimationFrame(() => document.documentElement.classList.remove('booting')); // reveal once laid out
  const meP = api(withBuild('/api/me')).then((r) => { me = r.user; renderUser(); settingsArrived(r); if (S) renderAll(); }).catch(() => { if (syncState === 'saving') { syncState = 'unsent'; renderSyncStatus(); } });
  // With a cached account the puzzle request goes out alongside /api/me (the server knows us by the token).
  const flushed = flushHeld(); // before the first puzzle, so the server knows that one was played
  if (flushed) await Promise.race([flushed, new Promise((r) => setTimeout(r, 3000))]);
  if (!token || me) route(); else { await meP; route(); }
})();
