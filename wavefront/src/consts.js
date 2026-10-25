// Every constant and buffer layout of the GPU build, in one place. The kernels, the
// renderer, the page and the tests all read from here.
//
// Physics is Robocode-derived at 60 ticks/s, with two changes for this game: shots are
// free and hits don't heal. (rl/duel.py defaults to Robocode's cost 2 / heal 6; its
// `--physics current` flag matches this file.)
export const AW = 800, AH = 600, HALF = 18;
export const VMAX = 3.5, ACC = 0.5, DEC = 1, TURN0 = 8, TURNV = 0.9;
export const BSPEED = 7, MEA = Math.asin(VMAX / BSPEED);
export const HEAT = 1.4, COOL = 0.05, START_HEAT = 3, DAMAGE = 10, GAIN = 0, COST = 0;
export const NBUL = 8, REPEAT = 4;
export const ROUND_TICKS = 60 * 45;          // then the healthier tank wins; if level, sudden death until the next hit
export const MUZZLE = 22;                    // bullets spawn this far along the aim
export const GUN_TURN = 0.1745;              // your turret: 10°/tick toward the mouse (rad)
export const NAIM = 9, HEADS = [3, 3, 9, 2], NLOGIT = 17, OBS = 36;
export const HEAD_OFF = [0, 3, 6, 15];       // logit offset of each head (throttle, turn, aim, fire)
export const AIM_STEP = (2 * MEA) / (NAIM - 1);

// ---- learning ----
export const HID = 64;
export const ED = 256;                       // dreamed duels
export const TD = 16;                        // decisions per dream rollout
export const NROLL = ED * TD;                // 4096 samples per PPO update
export const MB = 1024, NMB = 4, EPOCHS = 3, PPO_STEPS = NMB * EPOCHS;
export const BCB = 128;                      // opponent-model minibatch
export const NREP = 16384;                   // replay of your (situation, action) pairs
export const NSTATE = 4096;                  // recent real states that dreams start from
export const BC_START = 32, DREAM_START = 64; // replay rows / saved states needed before BC / dreams begin
export const COLLECT_PER_FRAME = 2, PPO_PER_FRAME = 2;
export const PPO = { lr: 3e-4, eps: 1e-5, clip: 0.2, ent: 0.01, vf: 0.5, gamma: 0.99, lam: 0.95, maxNorm: 0.5 };
export const BC = { lr: 1e-3, eps: 1e-8 };
// split-K: weight-gradient sums over the batch are split into KS row chunks, then added in a fixed order
export const KS_PPO = 16, KS_BC = 4;
export const NADV = 64;                      // advantage-statistics chunks
export const NGN = 256;                      // grad-norm partial sums

// Weak reward shaping (live sliders). Crowding: a per-tick cost ramping from 0 at KEEP_DIST to
// KEEP_W when on top of you; 0.02 ≈ one hit's reward per ~0.8 s right on top of you. Vs a
// clumsy-aim test player, time within 120 px fell from ~50% to ~5–10% (0.005 had no effect).
// Wall: a per-tick cost while touching a wall; swept 0 → 12% pinned, 0.005 → 7%, 0.01 → 2%,
// 0.02 → 4%, win rate unaffected.
export const KEEP_DIST = 220, KEEP_W = 0.02, WALL_W = 0.01;

// ---- RNG streams: every random draw is hash(seed, stream, key, index, sub) ----
export const RNG = { realSample: 1, realReset: 2, bcGather: 3, dreamAI: 4, dreamYou: 5, dreamReload: 6,
  dreamReset: 7, ppoPerm: 8, vizAI: 9, vizYou: 10, oppSample: 11 };

// ---- uniform: one field list generates the WGSL struct and the JS packer ----
export const UNIFORM = [
  ['seed', 'u32'], ['decide', 'u32'], ['bc', 'u32'], ['nCollect', 'u32'],
  ['gae', 'u32'], ['nPPO', 'u32'], ['reset', 'u32'], ['fire', 'u32'],
  ['thr', 'f32'], ['turn', 'f32'], ['mx', 'f32'], ['my', 'f32'],
  ['viz', 'u32'], ['nViz', 'u32'], ['keepW', 'f32'], ['keepDist', 'f32'],
  ['wallW', 'f32'], ['opp', 'u32'], ['oppSelf', 'u32'], ['_pad0', 'u32'],
];

// ---- networks in one parameter buffer: actor (tanh), critic (tanh), opponent model (relu) ----
function netLayout(base, inD, h, out) {
  const W1 = base, B1 = W1 + inD * h, W2 = B1 + h, B2 = W2 + h * h, W3 = B2 + h, B3 = W3 + h * out;
  return { W1, B1, W2, B2, W3, B3, end: B3 + out, in: inD, h, out };
}
export const NA = netLayout(0, OBS, HID, NLOGIT);
export const NC = netLayout(NA.end, OBS, HID, 1);
export const NM = netLayout(NC.end, OBS, HID, NLOGIT);
export const NP = NM.end;
// NET buffer: params | Adam m | Adam v | grads | scalars
export const nM = NP, nV = 2 * NP, nG = 3 * NP, nS = 4 * NP;
export const SC = { stepPol: 0, stepBC: 1, gscale: 2, gpart: 64 };   // gpart: NGN grad-norm partials
export const NS_SC = SC.gpart + NGN;
export const NNET = nS + NS_SC;      // the learner's state (what a save holds)
// After it: the other tank's policy when a net drives it (uniform opp = 1). It holds the
// offline self-play champion (assets/champion.json), or, with oppSelf = 1, a copy of the
// learner's own actor refreshed every decision (it plays itself).
export const NCH = netLayout(NNET, OBS, HID, NLOGIT);
export const NNET_BUF = NCH.end;

// ---- activation scratch (rows up to MB) ----
export const AUXW = 12;   // per-row scratch columns, whose meaning depends on the block:
export const AUX_BC = { lab: 0, loss: 4, acc: 5 };                                    // lab 0..3, acc 5..8
export const AUX_PPO = { act: 0, logp: 4, adv: 5, ret: 6, pg: 7, vl: 8, ent: 9, clip: 10 };
export const A = {};
{ let o = 0; const reg = (n, w) => { A[n] = o; o += MB * w; };
  reg('X', OBS); reg('H1', HID); reg('H2', HID); reg('Z', NLOGIT); reg('H1c', HID); reg('H2c', HID); reg('V', 1);
  reg('dZ', NLOGIT); reg('dH2', HID); reg('dH1', HID); reg('dV', 1); reg('dH2c', HID); reg('dH1c', HID);
  reg('AUX', AUXW);
  A.GP = o; o += KS_PPO * NP;   // split-K gradient partials [chunk][param]; also reused for reduction partials
  A.N = o; }

// ---- rollout row: obs, action, logp, value, reward, done, advantage, return ----
export const RL = { obs: 0, act: OBS, logp: OBS + 4, val: OBS + 5, rew: OBS + 6, done: OBS + 7, adv: OBS + 8, ret: OBS + 9 };
export const RLS = OBS + 10;

// ---- world: header + games (game 0 = the real one, 1..ED = training dreams, then viewing dreams) ----
export const NVIZ = 32, HVIZ = 20, VIZ_EVERY = 8; // viewing dreams: futures from now, drawn not trained on
export const VR0 = 2 * ED;                       // their scratch rows (after the training dreams')
export const NENV = 1 + ED + NVIZ;
// per game: tank[2][8] @0, bullets[2][8][5] @16, t @96, held AI action @97..100,
// held action of the other tank @101..104 (dreams: the model's; real game: a net opponent's), viewing-dream done flag @105
export const EST = 128;
export const E = { tank: 0, bul: 16, t: 96, ai: 97, hu: 101, vdone: 105 };
export const T8 = { x: 0, y: 1, h: 2, v: 3, heat: 4, energy: 5, dh: 6, shots: 7 };
export const SST = 97;                   // a saved real state: tanks 16 + bullets 80 + t
export const RST = OBS + 4;              // replay row: your situation + your action
// header slots. Integer counters wrap at 2^24 so they stay exact as f32.
export const WRAP = 16777216;
export const HD = {
  frame: 0, decisions: 1, repCount: 2, repHead: 3, stCount: 4, stHead: 5, dreamT: 6, ppoS: 7, bcSteps: 8,
  dreamDecisions: 9, ppoUpdates: 10, advMean: 11, advStd: 12,
  pg: 16, round: 17, aiWins: 18, pWins: 19, realDealt: 20, realTaken: 21, aiFireAng: 23,
  bcLoss: 24, pgLoss: 28, vLoss: 29, entTrain: 30, clipFrac: 31,
  aimProbs: 32,   // 9 slots
  accHeads: 44,   // 4 slots
  vizStep: 49,
};
export const gEnv = 256;
export const gTrail = gEnv + NENV * EST;        // futures: [NVIZ][HVIZ+1][2 sides][x, y, energy]
export const NWORLD = gTrail + NVIZ * (HVIZ + 1) * 6;

// ---- layout invariants the generated kernels rely on ----
const check = (ok, msg) => { if (!ok) throw new Error('consts: ' + msg); };
check(VR0 + 2 * NVIZ <= MB, 'viewing-dream rows overflow the scratch rows');
check(MB % 8 === 0 && BCB % 8 === 0 && ED % 8 === 0, 'batch sizes must be multiples of the 8-row tile');
check(MB % KS_PPO === 0 && BCB % KS_BC === 0, 'split-K chunks must divide the batch');
check(NROLL % NADV === 0 && OBS % 4 === 0 && HID % 4 === 0, 'reduction / 4-wide tiles must divide evenly');
check(UNIFORM.length % 4 === 0, 'uniform must be a multiple of 16 bytes');
check(HEAD_OFF[3] + HEADS[3] === NLOGIT, 'head offsets');
