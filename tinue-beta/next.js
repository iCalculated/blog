// Next puzzle without waiting on the network. While a puzzle is played, the server picks what comes after it both
// ways, at the rating a solve or a miss will leave (pair, from /api/next?for=); the result chooses one (prefetched).
// Without a usable pair (a hint, a failed upload) the next one is fetched as soon as the result is in. The chosen
// puzzle is also kept in storage (tinue.next) until it has been played, so the next visit starts on it without asking
// the server. Keys: the filters it was picked under; a change of player (sign in or out) drops both.
// Settled players (no "?") instead keep a queue (tinue.queue) of puzzles picked BATCH at a time at their rating (as
// Lichess's app does): one request per batch instead of a pair per puzzle, refilled when REFILL_AT are left, and
// re-picked once their rating drifts more than DRIFT from the batch's (the puzzle already chosen is still played
// meanwhile).
//
// No DOM here: everything it needs comes in through createNext's arguments, so scripts/test-next.mjs can drive it
// with fakes.

export const NEXT_TTL = 12 * 3600e3; // a stored puzzle older than this is asked for again (ratings and imports move on)
export const BATCH = 10, REFILL_AT = 2, DRIFT = 50;

// get(path): the server's JSON for a quiet GET (rejects on failure). store: get/set/del. now(): the clock.
// filterKey(), playerKey(): what the stored puzzles were picked for. query(): /api/next's query for the filters.
// settled(): a signed-in player whose rating has settled. rating(): their rating (null if unknown).
// currentId(): the puzzle on the board, if any.
export function createNext({ get, store, now = Date.now, filterKey, playerKey, query, settled, rating, currentId = () => null }) {
  let pair = null, prefetched = null; // pair: { id, key, req -> { win, loss } }; prefetched: { key, req -> { puzzle } }
  let queue = store.get('queue', null), filling = null; // queue: { key, who, rating, at, puzzles: [upcoming, not shown yet] }
  const queueOk = () => !!queue && queue.key === filterKey() && queue.who === playerKey() && now() - queue.at < NEXT_TTL;
  const drifted = () => rating() == null || Math.abs(rating() - queue.rating) > DRIFT;
  // A queue picked for other filters, another player or too long ago is dropped, in storage too (a reload or switching
  // the filters back must not bring it back: it can hold puzzles played since).
  function dropStale() { if (queue && !queueOk()) { queue = null; store.del('queue'); } }
  // Nothing queued twice, nor the puzzle on the board or the one stored to come next. A batch can pick those: one
  // asked for alongside the pair, or after a drift (when the old queue isn't excluded), or before Next's own request.
  function prune() {
    if (!queue) return;
    const skip = new Set([currentId(), store.get('next', null)?.puzzle?.id].filter(Boolean));
    const puzzles = queue.puzzles.filter((p) => !skip.has(p.id) && skip.add(p.id));
    if (puzzles.length !== queue.puzzles.length) { queue.puzzles = puzzles; store.set('queue', queue); }
  }

  // Fetch a batch: appended to what's queued, or in its place once the rating has drifted (or the queue is stale).
  // Only for a settled player: a request still finishing for someone who has since signed out mustn't start one.
  function fillQueue(taken) {
    if (!settled()) return Promise.resolve();
    if (filling) return filling;
    const key = filterKey(), who = playerKey();
    const keep = queueOk() && !drifted() ? queue.puzzles : [];
    const exclude = [...keep.map((p) => p.id), currentId(), taken, store.get('next', null)?.puzzle?.id].filter(Boolean);
    const req = filling = get(`/api/next?${query()}&n=${BATCH}${exclude.length ? '&exclude=' + exclude.join(',') : ''}`)
      .then((r) => {
        if (!r?.puzzles || key !== filterKey() || who !== playerKey()) return;
        queue = { key, who, rating: r.rating, at: now(), puzzles: [...(queueOk() && !drifted() ? queue.puzzles : []), ...r.puzzles] };
        store.set('queue', queue);
        prune();
      })
      .catch(() => {}).finally(() => { if (filling === req) filling = null; });
    return req;
  }

  // The next puzzle from the queue (waiting for a batch only when it's empty), topping it up or re-picking it as needed.
  async function fromQueue() {
    dropStale();
    if (!queue?.puzzles.length) { queue = null; store.del('queue'); await fillQueue(); }
    if (!queueOk() || !queue.puzzles.length) return null;
    const puzzle = queue.puzzles.shift();
    store.set('queue', queue);
    if (drifted() || queue.puzzles.length <= REFILL_AT) fillQueue(puzzle.id);
    return { puzzle };
  }

  // A puzzle has started: get what comes after it ready.
  function prefetchPair(p) {
    dropStale(); prune();
    if (settled()) {
      // Queues overlap: the next batch is asked for while puzzles are still queued (REFILL_AT), so there's always one
      // ready. Only when nothing is queued for after this puzzle does it also get the pair, so a slow or failed batch
      // never means waiting.
      const have = queueOk() && queue.puzzles.length > 0;
      if (!have || drifted() || queue.puzzles.length <= REFILL_AT) fillQueue();
      if (have) return;
    }
    pair = { id: p.id, key: filterKey(), req: get('/api/next?' + query() + '&for=' + encodeURIComponent(p.id)).catch(() => null) };
  }

  // The result of puzzle id is in. usePair: it counted as the pair assumed (no hint, the upload answered).
  function prefetchNext(win, id, usePair) {
    store.del('next'); // the stored one was this puzzle: it's played now
    dropStale();
    const key = filterKey();
    const fromPair = usePair && pair?.id === id && pair?.key === key && pair.req.then((r) => r && { puzzle: win ? r.win : r.loss });
    let req;
    if (settled() && queueOk() && queue.puzzles.length) req = fromQueue();
    else if (fromPair) req = settled() ? fromPair.then((r) => { fillQueue(r?.puzzle?.id); return r; }) : fromPair; // queue empty (just settled, batch slow or failed)
    else req = settled() ? fromQueue() : get('/api/next?' + query()).catch(() => null);
    pair = null;
    prefetched = { key, req };
    req.then((r) => { if (r?.puzzle && prefetched?.req === req) { store.set('next', { key, who: playerKey(), at: now(), puzzle: r.puzzle }); prune(); } });
  }

  // Another player now (sign in or out): nothing picked for the last one stays.
  const forgetNext = () => { pair = null; prefetched = null; queue = null; store.del('next'); store.del('queue'); };

  // The prefetched next puzzle for the current filters, if any (a promise of { puzzle } or null); taking it clears it.
  // (A stored one stays until this puzzle's result: leaving halfway comes back to it.)
  function take() {
    const pre = prefetched?.key === filterKey() ? prefetched.req : null;
    prefetched = null;
    return pre;
  }

  // At boot: the puzzle picked after the last result here, if still fresh, so the first puzzle needs no request.
  function resume() {
    const nx = store.get('next', null);
    if (nx?.puzzle && nx.who === playerKey() && nx.key === filterKey() && now() - nx.at < NEXT_TTL) prefetched = { key: nx.key, req: Promise.resolve({ puzzle: nx.puzzle }) };
  }

  return { prefetchPair, prefetchNext, forgetNext, take, resume, get queue() { return queue; } };
}
