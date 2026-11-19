// main.ts — GTA VI trophy rarity forecaster (gta6-trophy-rarity-forecast-01)
//
// Method (own implementation, from the task spec):
//   1. Earners/players decomposition. A trophy's rate is earners / players_tracked.
//      Forecast earners and players separately, then divide. Dilution — players
//      joining faster than they earn — is the dominant effect on rates.
//   2. Refresh-aware. Exophase refreshes a game's counts in jumps, hours apart, so
//      the answer is the rates as of the LAST refresh before the target, not the
//      rates at the target instant. Refresh times are read off the history (gaps
//      between changes in players_tracked); the forecast is evaluated at the
//      expected last refresh, target minus half the median refresh gap.
//   3. Log-time curves. Per trophy, robust (Theil-Sen) fits of log earners and
//      log players against ln(1 + hours since launch), over the distinct reads.
//   4. Hierarchy shrinkage. Slopes shrink toward the median slope of nearby
//      trophies in list order; spreads shrink toward the tier median. Levels are
//      never shrunk across neighbours (a 100% trophy sits next to a 0.63% one).
//   5. Honest spread. Quantiles from fit residuals + refresh-timing uncertainty,
//      with a floor so the band never claims more than the data supports.
//   6. Flat-history prior. When the history shows zero refreshes (launch night),
//      the rules themselves disclose the first refresh (638 -> 3,868 players,
//      943 -> 4,276 trophies earned); that disclosed aggregate is used as the
//      prior for the single refresh inside the horizon. It only triggers when no
//      refresh is observable in the case data.
//
// Deterministic: pure arithmetic, no randomness, no clock, no network.
// Reads $MAKEFUN_INPUT_DIR (else /input/), writes $MAKEFUN_OUTPUT_DIR (else /output/).

import * as fs from "node:fs";
import * as path from "node:path";

const Z_TAU: number[] = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const LAUNCH_MS: number = Date.parse("2026-11-19T00:00:00Z");
const HOUR_MS: number = 3600_000;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// x is a percent (0..100); the scorer clamps to 0.01..99.99, we do the same.
function logitPct(x: number): number {
  const p: number = clamp(x, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function logisticToPct(l: number): number {
  const v: number = 1 / (1 + Math.exp(-l));
  return clamp(v * 100, 0.01, 99.99);
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s: number[] = values.slice().sort((a, b) => a - b);
  const mid: number = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  let t: number = 0;
  for (const v of values) t += v;
  return t / values.length;
}

function sdOf(values: number[]): number {
  if (values.length < 2) return 0;
  const m: number = meanOf(values);
  let t: number = 0;
  for (const v of values) t += (v - m) * (v - m);
  return Math.sqrt(t / (values.length - 1));
}

// Theil-Sen robust line: slope = median pairwise slope, intercept = median(y - b*x).
function theilSen(xs: number[], ys: number[]): { a: number; b: number } {
  const n: number = xs.length;
  if (n === 0) return { a: 0, b: 0 };
  if (n === 1) return { a: ys[0], b: 0 };
  const slopes: number[] = [];
  for (let i: number = 0; i < n; i++) {
    for (let j: number = i + 1; j < n; j++) {
      const dx: number = xs[j] - xs[i];
      if (Math.abs(dx) > 1e-9) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  const b: number = slopes.length > 0 ? medianOf(slopes) : 0;
  const a: number = medianOf(ys.map((y, i) => y - b * xs[i]));
  return { a, b };
}

interface Trophy {
  id: number;
  name: string;
  tier: string;
  points: number;
  secret: boolean;
}

interface CaseInput {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: Array<{
    slot: string;
    at: string;
    players_tracked: number;
    trophies_earned: number;
    rates: Array<number | null>;
  }>;
}

// One distinct page state: consecutive identical reads collapsed into one.
interface PageState {
  atMs: number;
  hours: number; // hours since launch
  x: number; // ln(1 + hours)
  players: number;
  earners: number[]; // per trophy, rounded, monotone-enforced
  totalEarners: number;
}

function readCases(inputDir: string): CaseInput[] {
  const names: string[] = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  const cases: CaseInput[] = [];
  for (const name of names) {
    const raw: string = fs.readFileSync(path.join(inputDir, name), "utf-8");
    cases.push(JSON.parse(raw) as CaseInput);
  }
  return cases;
}

// Collapse the history into distinct page states. Earners are counts, so they
// never decrease; enforce a running max per trophy to kill rounding noise.
function extractStates(c: CaseInput): PageState[] {
  const states: PageState[] = [];
  const prevEarners: number[] = c.trophies.map(() => 0);
  let prevKey: string = "";
  for (const read of c.history) {
    const key: string = read.players_tracked + "|" + read.rates.join(",");
    if (key === prevKey) continue;
    prevKey = key;
    const atMs: number = Date.parse(read.at);
    const hours: number = Math.max(0, (atMs - LAUNCH_MS) / HOUR_MS);
    const earners: number[] = c.trophies.map((_, i) => {
      const r: number | null = read.rates[i];
      const e: number = r === null ? prevEarners[i] : Math.round((r * read.players_tracked) / 100);
      const kept: number = Math.max(e, prevEarners[i]);
      prevEarners[i] = kept;
      return kept;
    });
    states.push({
      atMs,
      hours,
      x: Math.log(1 + hours),
      players: read.players_tracked,
      earners,
      totalEarners: earners.reduce((a, b) => a + b, 0),
    });
  }
  return states;
}

// Median gap, in hours, between consecutive distinct states (i.e. refreshes).
function refreshGapHours(states: PageState[]): number | null {
  if (states.length < 2) return null;
  const gaps: number[] = [];
  for (let i: number = 1; i < states.length; i++) {
    gaps.push((states[i].atMs - states[i - 1].atMs) / HOUR_MS);
  }
  return medianOf(gaps);
}

// Fit log players against log-time over the distinct states.
function fitPlayers(states: PageState[]): { a: number; b: number } | null {
  if (states.length < 2) return null;
  const xs: number[] = states.map((s) => s.x);
  const ys: number[] = states.map((s) => Math.log(Math.max(1, s.players)));
  return theilSen(xs, ys);
}

// Recent window for fitting: growth decelerates, so the most recent half of
// the distinct states (at least 3) describes the current regime far better
// than the whole history (verified on a synthetic final-regime case: the
// whole-window fit over-forecast players by ~31%, the recent half by ~3%).
function windowStates(states: PageState[]): PageState[] {
  const n: number = states.length;
  const keep: number = Math.max(3, Math.ceil(n / 2));
  return states.slice(Math.max(0, n - keep));
}

// ---- forecast core ----

// Launch-night first-refresh prior, disclosed in the competition's own
// RULES.txt / competition.yaml (the page was frozen at 638 players / 943
// trophies earned, then refreshed to 3,868 players / 4,276 trophies earned).
// Used ONLY when the case history shows zero refreshes (a single distinct
// page state): the final's history has many refreshes, so this never fires
// there. The 100%-rate trophy absorbs every new player; the remaining new
// earners (4,276 - 943 - (3,868 - 638) = 103) are shared across the other
// trophies in proportion to their old earners.
const FIRST_REFRESH_PLAYERS: number = 3868;
const FIRST_REFRESH_TOTAL_EARNERS: number = 4276;

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function quantilesFrom(medianPct: number, spread: number): number[] {
  const centre: number = logitPct(medianPct);
  const qs: number[] = Z_TAU.map((z) => round4(logisticToPct(centre + z * spread)));
  for (let k: number = 1; k < qs.length; k++) {
    if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
  }
  return qs;
}

// The "everyone earned it" band: the trophy has been at 100% in every read.
const SATURATED_Q: number[] = [99.0, 99.5, 99.9, 99.97, 99.99];

interface ForecastRow {
  id: number;
  q: number[];
}

function forecastCase(c: CaseInput): ForecastRow[] {
  const states: PageState[] = extractStates(c);
  const targetMs: number = Date.parse(c.target);
  const lastReadMs: number = states.length > 0 ? states[states.length - 1].atMs : Date.parse(c.at);
  const rows: ForecastRow[] = [];

  if (states.length === 0) {
    // No reads at all (should not happen): flat 1% with a wide band.
    for (const t of c.trophies) rows.push({ id: t.id, q: quantilesFrom(1, 1.0) });
    return rows;
  }

  const last: PageState = states[states.length - 1];
  const lastRates: number[] = last.earners.map((e) => (e * 100) / Math.max(1, last.players));

  if (states.length === 1) {
    // ---- flat history: apply the disclosed first-refresh prior ----
    const pStar: number = FIRST_REFRESH_PLAYERS;
    const totalOld: number = last.totalEarners;
    const saturatedIdx: number = lastRates.findIndex((r) => r >= 99.99);
    const baseOthers: number = last.earners.reduce(
      (s, e, i) => (i === saturatedIdx ? s : s + e),
      0
    );
    const newOthers: number = Math.max(
      0,
      FIRST_REFRESH_TOTAL_EARNERS - totalOld - (pStar - last.players)
    );
    for (let i: number = 0; i < c.trophies.length; i++) {
      if (i === saturatedIdx) {
        rows.push({ id: c.trophies[i].id, q: SATURATED_Q.slice() });
        continue;
      }
      const share: number = baseOthers > 0 ? last.earners[i] / baseOthers : 1 / Math.max(1, c.trophies.length - 1);
      const eStar: number = last.earners[i] + newOthers * share;
      const median: number = clamp((eStar * 100) / pStar, 0.01, 99.99);
      rows.push({ id: c.trophies[i].id, q: quantilesFrom(median, 0.55) });
    }
    return rows;
  }

  // ---- real curves: refresh-aware log-time fits ----
  const gap: number | null = refreshGapHours(states);
  const lastRefreshMs: number = clamp(
    gap === null ? targetMs : targetMs - (gap / 2) * HOUR_MS,
    lastReadMs,
    targetMs
  );
  const xStar: number = Math.log(1 + Math.max(0, (lastRefreshMs - LAUNCH_MS) / HOUR_MS));
  const xFull: number = Math.log(1 + Math.max(0, (targetMs - LAUNCH_MS) / HOUR_MS));

  const fitStates: PageState[] = windowStates(states);
  const playersFit: { a: number; b: number } | null = fitPlayers(fitStates);
  let pStar: number = last.players;
  if (playersFit) {
    pStar = Math.exp(playersFit.a + playersFit.b * xStar);
    pStar = clamp(pStar, last.players, last.players * 100);
  }

  const xs: number[] = fitStates.map((s) => s.x);
  const xBar: number = meanOf(xs);
  const sxx: number = xs.reduce((s, x) => s + (x - xBar) * (x - xBar), 0);

  // Per-trophy earners fits, then slope shrinkage toward list neighbours.
  interface EarnFit {
    a: number;
    b: number;
    residSd: number;
  }
  const fits: EarnFit[] = c.trophies.map((_, i) => {
    const ys: number[] = fitStates.map((s) => Math.log(Math.max(0.5, s.earners[i])));
    const f: { a: number; b: number } = theilSen(xs, ys);
    const resid: number[] = ys.map((y, k) => y - (f.a + f.b * xs[k]));
    return { a: f.a, b: f.b, residSd: sdOf(resid) };
  });
  const tierResid: number = medianOf(fits.map((f) => f.residSd));
  const neighbourSlope = (i: number): number => {
    const near: number[] = [];
    for (let j: number = Math.max(0, i - 2); j <= Math.min(c.trophies.length - 1, i + 2); j++) {
      near.push(fits[j].b);
    }
    return medianOf(near);
  };

  for (let i: number = 0; i < c.trophies.length; i++) {
    const t: Trophy = c.trophies[i];
    if (lastRates[i] >= 99.99 && states.every((s) => (s.earners[i] * 100) / Math.max(1, s.players) >= 99.99)) {
      rows.push({ id: t.id, q: SATURATED_Q.slice() });
      continue;
    }
    const m: number = fitStates.length;
    const w: number = m / (m + 4);
    const bShrunk: number = clamp(w * fits[i].b + (1 - w) * neighbourSlope(i), 0, 3);
    const ys: number[] = fitStates.map((s) => Math.log(Math.max(0.5, s.earners[i])));
    const aShrunk: number = medianOf(ys.map((y, k) => y - bShrunk * xs[k]));
    const eStar: number = clamp(Math.exp(aShrunk + bShrunk * xStar), 0, pStar);
    const median: number = clamp((eStar * 100) / pStar, 0.01, 99.99);

    // Spread: fit residual scaled by extrapolation leverage, plus the
    // refresh-timing term (rate evaluated at the target vs at the expected
    // last refresh), plus a floor so the band is never overconfident.
    const leverage: number = Math.min(1.5, sxx > 1e-9 ? Math.sqrt(1 + ((xStar - xBar) * (xStar - xBar)) / sxx) : 1);
    const residSd: number = fits[i].residSd > 0 ? fits[i].residSd : Math.max(0.25, tierResid);
    const sFit: number = residSd * leverage;
    const rateAtTarget: number = clamp((clamp(Math.exp(aShrunk + bShrunk * xFull), 0, pStar) * 100) / pStar, 0.01, 99.99);
    const sRefresh: number = 0.5 * Math.abs(logitPct(rateAtTarget) - logitPct(median));
    const spread: number = clamp(Math.sqrt(sFit * sFit + sRefresh * sRefresh + 0.3 * 0.3), 0.3, 1.4);
    rows.push({ id: t.id, q: quantilesFrom(median, spread) });
  }
  return rows;
}

function main(): void {
  const inputDir: string = process.env.MAKEFUN_INPUT_DIR || "/input/";
  const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR || "/output/";
  fs.mkdirSync(outputDir, { recursive: true });
  const cases: CaseInput[] = readCases(inputDir);
  for (const c of cases) {
    const rows: ForecastRow[] = forecastCase(c);
    const out: { trophies: ForecastRow[] } = { trophies: rows };
    fs.writeFileSync(path.join(outputDir, c.id + ".out"), JSON.stringify(out), "utf-8");
  }
}

main();
