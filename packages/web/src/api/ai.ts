/**
 * PulseTrade AI Engine v4
 *
 * Philosophy: trade PROBABILITY MOMENTUM — enter when price is moving toward a target
 * and the crowd's conviction (volume) is building. Exit on 3-tier scale-out as the
 * move is captured.
 *
 * Core model:
 *   velocityScore    = rate of probability change (last 3 ticks vs prior 3 baseline)
 *   accelerationScore = 2nd derivative — is velocity *increasing*?
 *   crowdAgreement   = volume increasing in direction of movement (conviction building)
 *   pTarget          = where crowd will push price given current momentum
 *
 * Entry condition:
 *   price < pTarget × 0.70 AND velocity > threshold AND acceleration positive
 *   Exception: spread ≤ 1.5¢ → enter on any positive velocity
 *
 * Exit model (scale-out tiers):
 *   Tier 1: 50% of (pTarget - entryPrice) captured → exit 1/3, trail stop to entry+1¢
 *   Tier 2: 75% of move captured → exit 1/3
 *   Tier 3: 90%+ of move captured → exit remainder
 *   Hard stop: price retreats 40% of move from entry
 *   Momentum fade: 3 ticks of declining velocity while profitable → exit
 */

import type { KalshiMarket, PricePoint } from "./kalshi.js";

export const ENGINE_VERSION = "4.0.0";

// ─── Entry thresholds ──────────────────────────────────────────────────────
const MIN_VELOCITY_SCORE    = 0.008;  // minimum rate of price change to be actionable
const MIN_PRICE_DISCOUNT    = 0.70;   // must be < 70% of pTarget to enter
const MIN_EV                = -0.005; // floor EV (small negative allowed on tight spreads)
const MIN_SPREAD_RATIO      = 0.35;   // max spread/price ratio — above = illiquid
const MAX_KELLY_FRACTION    = 0.20;
const MIN_TIME_HOURS        = 0.25;   // skip markets closing in < 15 min
const MAX_TIME_DAYS         = 730;    // skip markets closing > 2 years
const TIGHT_SPREAD_CENTS    = 0.015;  // 1.5¢ — enter even without strong velocity

// ─── Exit thresholds ──────────────────────────────────────────────────────
export const EXIT_TIER_1_PCT        = 0.50;   // 50% of pTarget move captured
export const EXIT_TIER_2_PCT        = 0.75;   // 75% of move captured
export const EXIT_TIER_3_PCT        = 0.90;   // 90%+ of move → full exit
export const HARD_STOP_RETREAT_PCT  = 0.40;   // price retreats 40% from entry toward target
export const MOMENTUM_FADE_TICKS    = 3;      // consecutive velocity-declining ticks = exit
export const TIME_DECAY_FORCE_EXIT  = 0.5;    // < 30min: exit regardless
export const TIME_DECAY_PROFIT_EXIT = 1.5;    // < 90min + profitable: take it

// ─── Interfaces ──────────────────────────────────────────────────────────

export type ExitReason =
  | "PROFIT_TARGET"
  | "TRAILING_STOP"
  | "MOMENTUM_REVERSAL"
  | "TIME_DECAY"
  | "BETTER_OPPORTUNITY"
  | "STOP_LOSS"
  | "MARKET_RESOLUTION"
  | "HOLD";

export type EntryReason =
  | "VELOCITY_MOMENTUM"         // strong velocity + acceleration — ride the move
  | "VELOCITY_WITH_CONVICTION"  // velocity + volume building in direction
  | "ACCELERATION_ENTRY"        // acceleration turning positive after flat — early entry
  | "TIGHT_SPREAD_ENTRY"        // spread very tight, enter on any positive signal
  | "CROWD_UNDERPRICING_YES"    // legacy compat
  | "CROWD_UNDERPRICING_NO"     // legacy compat
  | "CONSENSUS_DRIFT"           // legacy compat
  | "VOLUME_CONVICTION_FADE"    // legacy compat
  | "ENTRY_TIMING_DIPPED";      // legacy compat

export interface EVResult {
  ticker: string;
  action: "BUY_YES" | "BUY_NO" | "HOLD";
  side: "yes" | "no" | null;
  ev: number;
  // v4 fields
  pTarget: number;              // where crowd will push price given current momentum
  velocityScore: number;        // rate of probability change
  accelerationScore: number;    // 2nd derivative of velocity
  momentumScore: number;        // composite momentum signal 0–1
  crowdAgreement: number;       // volume-in-direction confirmation 0–1
  // legacy compat fields
  pFair: number;                // = pTarget for backward compat
  midpoint: number;
  mispricingGap: number;        // = pTarget - midpoint for compat
  entryPrice: number;
  kellyFraction: number;
  kellySized: number;
  positionSizeCents: number;
  spread: number;
  spreadRatio: number;
  confidence: number;
  reasoning: string;
  entryReason: EntryReason | null;
  entryQuality: number;         // 0–100: how favorable is current entry
  opportunity_window?: string;
  // raw microstructure
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;
  volumeMomentum: number;
  consensusDrift: number;       // legacy compat — = velocityScore
  convictionScore: number;      // legacy compat — = crowdAgreement
}

export interface ExitSignal {
  ticker: string;
  shouldExit: boolean;
  exitReason: ExitReason;
  urgency: "immediate" | "soon" | "monitor";
  reasoning: string;
  currentProfitPct: number;
  peakProfitPct: number;
  trailingStopLevel: number | null;
  suggestedExitPrice: number | null;
}

// ─── Movement Signal Engine ───────────────────────────────────────────────
/**
 * Compute probability momentum signals from price history.
 *
 * velocityScore    = (avg of last 3 tick changes) - (avg of prior 3 tick changes)
 *                    → positive = crowd accelerating in YES direction
 * accelerationScore = is velocity *increasing* vs prior period?
 * crowdAgreement   = are volume spikes correlated with price direction?
 * pTarget          = entry_price + velocity × time_scalar
 */
function computeMovementSignal(
  market: KalshiMarket,
  history: PricePoint[] | null
): {
  pTarget: number;
  velocityScore: number;
  accelerationScore: number;
  momentumScore: number;
  crowdAgreement: number;
  volumeMomentum: number;
  midpoint: number;
} {
  const midpoint = (market.yes_bid + market.yes_ask) / 2;

  if (!history || history.length < 6) {
    // No history → use tiny tick-level signals from bid/ask alone
    // Asymmetric spread can hint at direction
    const askBias = market.yes_ask > 0 ? (market.yes_ask - market.yes_bid) / market.yes_ask : 0;
    return {
      pTarget: midpoint,
      velocityScore: 0,
      accelerationScore: 0,
      momentumScore: 0,
      crowdAgreement: 0.5,
      volumeMomentum: 0,
      midpoint,
    };
  }

  const n = history.length;
  const prices = history.map(p => p.yes_price / 100);
  const volumes = history.map(p => p.volume);

  // ── Velocity: rate of change ──────────────────────────────────────────
  // Recent 3 ticks vs prior 3 ticks
  const recent3 = prices.slice(-3);
  const prior3  = prices.slice(-6, -3);

  const recentMoves = recent3.slice(1).map((p, i) => p - recent3[i]);
  const priorMoves  = prior3.slice(1).map((p, i) => p - prior3[i]);

  const recentAvgMove = recentMoves.length > 0
    ? recentMoves.reduce((s, v) => s + v, 0) / recentMoves.length
    : 0;
  const priorAvgMove  = priorMoves.length > 0
    ? priorMoves.reduce((s, v) => s + v, 0) / priorMoves.length
    : 0;

  const velocityScore = recentAvgMove; // signed: positive = crowd moving YES up

  // ── Acceleration: is velocity increasing? ────────────────────────────
  // acceleration > 0 means crowd is *speeding up* their belief revision
  const accelerationScore = recentAvgMove - priorAvgMove;

  // ── Volume momentum: recent vs older volume ──────────────────────────
  const recentVol = volumes.slice(-3).reduce((s, v) => s + v, 0);
  const olderVol  = volumes.slice(-6, -3).reduce((s, v) => s + v, 0);
  const volumeMomentum = olderVol > 0 ? (recentVol - olderVol) / olderVol : 0;

  // ── Crowd agreement: volume correlated with price direction? ─────────
  // For each recent tick: if price moved in same direction as velocity, and volume was high
  // → crowd is trading in conviction, not noise
  let agreementScore = 0;
  for (let i = 1; i < recent3.length; i++) {
    const priceDelta = recent3[i] - recent3[i - 1];
    const volNorm = volumes[n - 3 + i] / (recentVol / 3 + 1e-6);
    if (Math.sign(priceDelta) === Math.sign(velocityScore) && volNorm > 0.8) {
      agreementScore += 0.5;
    }
  }
  const crowdAgreement = Math.min(1, agreementScore);

  // ── pTarget: where crowd will push price ─────────────────────────────
  // Model: extrapolate current velocity × time scalar
  // Time scalar: longer-dated markets need smaller projection (more uncertainty)
  const hoursToClose = (new Date(market.close_time).getTime() - Date.now()) / 3_600_000;
  // Scale from 1.0 (< 1h) down to 0.2 (> 24h) — short-dated markets move faster
  const timeScalar = Math.max(0.2, Math.min(1.0, 1.5 / Math.max(1, hoursToClose)));

  // Project: pTarget = current midpoint + velocity * scalar * conviction multiplier
  const convictionMult = 1 + crowdAgreement * 0.5; // high conviction = bigger projection
  const rawProjection  = velocityScore * timeScalar * convictionMult * 8; // 8 = tick lookforward
  const pTarget = Math.max(0.01, Math.min(0.99, midpoint + rawProjection));

  // ── Momentum score: composite 0–1 ────────────────────────────────────
  const velNorm  = Math.min(1, Math.abs(velocityScore) / 0.05);   // 5¢/tick = full score
  const accNorm  = Math.min(1, Math.max(0, accelerationScore / 0.01 + 0.5)); // centered at 0
  const volNorm2 = Math.min(1, Math.max(0, volumeMomentum * 0.5 + 0.5));
  const momentumScore = (velNorm * 0.5 + accNorm * 0.3 + volNorm2 * 0.2);

  return {
    pTarget,
    velocityScore,
    accelerationScore,
    momentumScore,
    crowdAgreement,
    volumeMomentum,
    midpoint,
  };
}

// ─── Entry Quality Score ─────────────────────────────────────────────────
/**
 * Score 0–100: how favorable is the current entry relative to the move.
 * Higher = price is well below pTarget with momentum building.
 */
function computeEntryQuality(
  entryPrice: number,
  pTarget: number,
  velocityScore: number,
  accelerationScore: number,
  crowdAgreement: number
): { score: number; note: string } {
  const moveSize = pTarget - entryPrice;

  if (Math.abs(moveSize) < 0.005) {
    return { score: 30, note: "pTarget near current price — minimal projected move" };
  }

  // Discount ratio: how much of the move is still available?
  const discountRatio = moveSize > 0 ? (pTarget - entryPrice) / pTarget : 0;

  let score = 0;
  let notes: string[] = [];

  // Discount quality: entering far below target is best
  if (discountRatio > 0.30) { score += 40; notes.push("Deep discount to target"); }
  else if (discountRatio > 0.15) { score += 25; notes.push("Good discount to target"); }
  else if (discountRatio > 0.05) { score += 10; notes.push("Moderate discount"); }

  // Velocity quality
  if (Math.abs(velocityScore) > 0.02)  { score += 25; notes.push("Strong velocity"); }
  else if (Math.abs(velocityScore) > 0.008) { score += 15; notes.push("Moderate velocity"); }

  // Acceleration bonus
  if (accelerationScore > 0.005) { score += 20; notes.push("Accelerating"); }
  else if (accelerationScore > 0)  { score += 10; notes.push("Stable velocity"); }

  // Crowd agreement bonus
  if (crowdAgreement > 0.7) { score += 15; notes.push("High crowd conviction"); }
  else if (crowdAgreement > 0.4) { score += 8; notes.push("Moderate conviction"); }

  return { score: Math.min(100, score), note: notes.join(", ") || "Entry evaluated" };
}

// ─── Kelly Sizing ────────────────────────────────────────────────────────
function kelly(pFair: number, entryPrice: number): number {
  if (entryPrice <= 0 || entryPrice >= 1) return 0;
  const odds = (1 - entryPrice) / entryPrice;
  const k = (pFair * odds - (1 - pFair)) / odds;
  return Math.max(0, k);
}

// ─── Liquidity / Time Gate ────────────────────────────────────────────────
function isLiquid(market: KalshiMarket): { ok: boolean; reason: string } {
  const hoursToClose = (new Date(market.close_time).getTime() - Date.now()) / 3_600_000;

  if (hoursToClose < MIN_TIME_HOURS) {
    return { ok: false, reason: `Closes in ${(hoursToClose * 60).toFixed(0)}m — too soon` };
  }
  if (hoursToClose > MAX_TIME_DAYS * 24) {
    return { ok: false, reason: `Closes in ${(hoursToClose / 24).toFixed(0)} days — too far out` };
  }
  if (market.yes_ask <= 0 || market.yes_bid <= 0) {
    return { ok: false, reason: "No valid bid/ask" };
  }
  return { ok: true, reason: "" };
}

// ─── Entry Reason Classification ─────────────────────────────────────────
function classifyEntryReason(
  velocityScore: number,
  accelerationScore: number,
  crowdAgreement: number,
  spread: number
): EntryReason {
  if (spread <= TIGHT_SPREAD_CENTS) return "TIGHT_SPREAD_ENTRY";
  if (crowdAgreement > 0.6 && Math.abs(velocityScore) > MIN_VELOCITY_SCORE) return "VELOCITY_WITH_CONVICTION";
  if (accelerationScore > 0.005) return "ACCELERATION_ENTRY";
  if (Math.abs(velocityScore) >= MIN_VELOCITY_SCORE * 2) return "VELOCITY_MOMENTUM";
  return "VELOCITY_MOMENTUM";
}

// ─── Main Entry Evaluator ─────────────────────────────────────────────────
export function evaluateMarket(
  market: KalshiMarket,
  history: PricePoint[] | null,
  accountBalanceCents: number,
  maxRiskPct: number
): EVResult {
  const {
    pTarget, velocityScore, accelerationScore, momentumScore,
    crowdAgreement, volumeMomentum, midpoint,
  } = computeMovementSignal(market, history);

  const yesAsk = market.yes_ask;
  const yesBid = market.yes_bid;
  const noAsk  = market.no_ask;
  const noBid  = market.no_bid;
  const spread = yesAsk - yesBid;
  const spreadRatio = yesAsk > 0 ? spread / yesAsk : 1;

  // EV: expected value given pTarget as our fair probability
  const evYes = pTarget * (1 - yesAsk) - (1 - pTarget) * yesAsk;
  const evNo  = (1 - pTarget) * (1 - noAsk) - pTarget * noAsk;

  const liquidity = isLiquid(market);

  let action: EVResult["action"] = "HOLD";
  let side: EVResult["side"] = null;
  let ev = 0;
  let entryPrice = 0;

  if (liquidity.ok && spreadRatio < MIN_SPREAD_RATIO) {
    const bestEv  = Math.max(evYes, evNo);
    const spreadTight = spread <= TIGHT_SPREAD_CENTS;

    // v4 entry conditions:
    // Primary: velocity building (price moving toward pTarget) AND price is discounted
    //   - velocityScore > threshold (momentum exists)
    //   - accelerationScore >= 0 (momentum not reversing)
    //   - entryPrice < pTarget * MIN_PRICE_DISCOUNT (haven't missed the move)
    // Exception: very tight spread → enter on any positive velocity
    const velOk    = Math.abs(velocityScore) >= MIN_VELOCITY_SCORE;
    const accOk    = accelerationScore >= -0.002; // allow tiny negative, not hard reversing

    if (bestEv >= MIN_EV) {
      if (velocityScore > 0) {
        // YES side: crowd pushing price up
        const discountOk = yesAsk < pTarget * MIN_PRICE_DISCOUNT;
        if ((velOk && accOk && discountOk) || spreadTight) {
          action = "BUY_YES"; side = "yes"; ev = evYes; entryPrice = yesAsk;
        }
      } else if (velocityScore < 0) {
        // NO side: crowd pushing YES price down (NO going up)
        const noEntryPrice = noAsk;
        const pTargetNo = 1 - pTarget; // pTarget for NO side
        const discountOk = noEntryPrice < pTargetNo * MIN_PRICE_DISCOUNT;
        if ((velOk && accOk && discountOk) || spreadTight) {
          action = "BUY_NO"; side = "no"; ev = evNo; entryPrice = noAsk;
        }
      } else if (spreadTight) {
        // Zero velocity (no history yet) but tight spread — enter whichever side has better EV
        // This fires for new markets or in-game markets before price history accumulates
        if (evYes >= evNo && evYes >= MIN_EV) {
          action = "BUY_YES"; side = "yes"; ev = evYes; entryPrice = yesAsk;
        } else if (evNo >= MIN_EV) {
          action = "BUY_NO"; side = "no"; ev = evNo; entryPrice = noAsk;
        }
      }
    }
  }

  // Kelly sizing using pTarget as our probability estimate
  const pForKelly = action === "BUY_YES" ? pTarget : action === "BUY_NO" ? 1 - pTarget : 0.5;
  const rawKelly = action !== "HOLD" ? kelly(pForKelly, entryPrice) : 0;
  const cappedKelly = Math.min(rawKelly, MAX_KELLY_FRACTION);
  const kellySized  = cappedKelly * 0.25;

  // Position size
  const riskBudgetCents  = accountBalanceCents * (maxRiskPct / 100);
  const positionSizeCents = action !== "HOLD"
    ? Math.round(riskBudgetCents * kellySized)
    : 0;

  // Entry quality
  const { score: entryQuality } = action !== "HOLD"
    ? computeEntryQuality(entryPrice, side === "yes" ? pTarget : 1 - pTarget, velocityScore, accelerationScore, crowdAgreement)
    : { score: 0 };

  // Entry reason
  const entryReason: EntryReason | null = action !== "HOLD"
    ? classifyEntryReason(velocityScore, accelerationScore, crowdAgreement, spread)
    : null;

  // Confidence: momentum-based scoring
  const velScore     = action !== "HOLD" ? Math.round(Math.min(1, Math.abs(velocityScore) / 0.02) * 30) : 0;
  const accScore     = action !== "HOLD" ? (accelerationScore > 0 ? 15 : 0) : 0;
  const agreeScore   = action !== "HOLD" ? Math.round(crowdAgreement * 20) : 0;
  const spreadScore  = action !== "HOLD" ? Math.max(0, Math.round(20 - spread * 400)) : 0;
  const qualBonus    = Math.round(entryQuality * 0.15);
  const confidence   = action !== "HOLD"
    ? Math.min(95, Math.max(40, velScore + accScore + agreeScore + spreadScore + qualBonus))
    : Math.round(20 + Math.max(evYes, evNo, 0) * 100);

  // Reasoning
  const mispricingGap = pTarget - midpoint; // compat
  let reasoning = "";
  if (action !== "HOLD") {
    const sideLabel  = side === "yes" ? "YES" : "NO";
    const entryPct   = Math.round(entryPrice * 100);
    const targetPct  = Math.round((side === "yes" ? pTarget : 1 - pTarget) * 100);
    const velPct     = (velocityScore * 100).toFixed(2);
    const accPct     = (accelerationScore * 100).toFixed(2);
    const movePct    = Math.round(Math.abs((side === "yes" ? pTarget - entryPrice : (1 - pTarget) - entryPrice) * 100));
    const kPct       = (kellySized * 100).toFixed(1);
    const spreadC    = (spread * 100).toFixed(1);

    reasoning = `${sideLabel} @ ${entryPct}¢. Momentum target: ${targetPct}¢ (+${movePct}¢ projected move). Velocity: ${velPct}¢/tick, acceleration: ${accPct >= "0.00" ? "+" : ""}${accPct}. Conviction: ${Math.round(crowdAgreement * 100)}%. Kelly: ${kPct}%. Spread: ${spreadC}¢.`;

    if (crowdAgreement > 0.6) {
      reasoning += " Volume confirms direction.";
    }
    if (accelerationScore > 0.005) {
      reasoning += " Momentum accelerating.";
    }
  } else {
    const reason = !liquidity.ok
      ? liquidity.reason
      : spreadRatio >= MIN_SPREAD_RATIO
        ? `Spread ${(spread * 100).toFixed(1)}¢ too wide (${(spreadRatio * 100).toFixed(0)}% of price)`
        : Math.abs(velocityScore) < MIN_VELOCITY_SCORE
          ? `Velocity ${(Math.abs(velocityScore) * 100).toFixed(2)}¢/tick below threshold — no momentum`
          : "Entry discount insufficient vs projected target";
    reasoning = `HOLD — ${reason}`;
  }

  return {
    ticker: market.ticker,
    action,
    side,
    ev,
    pTarget,
    velocityScore,
    accelerationScore,
    momentumScore,
    crowdAgreement,
    // legacy compat
    pFair: pTarget,
    midpoint,
    mispricingGap,
    entryPrice,
    kellyFraction: rawKelly,
    kellySized,
    positionSizeCents,
    spread,
    spreadRatio,
    confidence,
    reasoning,
    entryReason,
    entryQuality,
    opportunity_window: action !== "HOLD" ? formatTimeRemaining(market.close_time) : undefined,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    lastPrice: market.last_price,
    volumeMomentum,
    consensusDrift: velocityScore,      // legacy compat
    convictionScore: crowdAgreement,    // legacy compat
  };
}

// ─── Exit Signal Evaluator (v4: pTarget-based scale-out) ──────────────────
/**
 * Evaluate an open position and decide whether to exit.
 *
 * @param entryPrice   - price paid (0–1 scale)
 * @param currentPrice - current market price for our side (0–1 scale)
 * @param peakPrice    - highest price seen since entry (0–1 scale)
 * @param hoursToClose - hours until market closes
 * @param priceHistory - recent price snapshots (newest last)
 * @param currentEV    - current EV if re-evaluated now (optional)
 * @param hasBetterOpportunity - engine found a higher-signal trade
 * @param pTarget      - momentum target set at entry (0–1 scale)
 */
export function evaluateExit(
  ticker: string,
  entryPrice: number,
  currentPrice: number,
  peakPrice: number,
  hoursToClose: number,
  priceHistory: number[] | null,
  currentEV: number | null,
  hasBetterOpportunity: boolean = false,
  pTarget: number | null = null
): ExitSignal {
  const profitPct     = entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0;
  const peakProfitPct = entryPrice > 0 ? (peakPrice - entryPrice) / entryPrice : 0;

  // Resolve pTarget: fall back to a flat +20% projection if not provided (handles v3 legacy trades)
  const target = pTarget ?? (entryPrice * 1.20);
  const totalMove = target - entryPrice; // projected move size at entry

  // Scale-out tiers (based on % of projected move captured)
  const moveCaptured = totalMove > 0.001 ? (currentPrice - entryPrice) / totalMove : 0;

  // Hard stop: price retreated 40% of projected move below entry
  // e.g. entry 20¢, target 35¢ (move = 15¢), stop = 20¢ - (15¢ × 0.40) = 14¢
  const hardStopLevel = totalMove > 0.001
    ? entryPrice - totalMove * HARD_STOP_RETREAT_PCT
    : entryPrice * 0.65;  // fallback: 35% below entry

  // Trailing stop: once Tier 1 hit, trail at entry + 1¢ minimum
  let trailingStopLevel: number | null = null;
  if (moveCaptured >= EXIT_TIER_1_PCT || peakProfitPct >= 0.05) {
    const stopGain = (peakPrice - entryPrice) * 0.60;
    trailingStopLevel = Math.max(entryPrice + 0.01, entryPrice + stopGain);
  }

  // ── Rule 0: Hard stop-loss ─────────────────────────────────────────────
  if (profitPct <= -0.35 || currentPrice <= hardStopLevel) {
    return {
      ticker, shouldExit: true, exitReason: "STOP_LOSS",
      urgency: "immediate",
      reasoning: `Hard stop hit. Entry: ${Math.round(entryPrice * 100)}¢, current: ${Math.round(currentPrice * 100)}¢ (${(profitPct * 100).toFixed(1)}%). Stop level: ${Math.round(hardStopLevel * 100)}¢.`,
      currentProfitPct: profitPct,
      peakProfitPct,
      trailingStopLevel,
      suggestedExitPrice: currentPrice,
    };
  }

  // ── Rule 1: Force exit < 30min ─────────────────────────────────────────
  if (hoursToClose <= TIME_DECAY_FORCE_EXIT) {
    return {
      ticker, shouldExit: true, exitReason: "TIME_DECAY",
      urgency: "immediate",
      reasoning: `${(hoursToClose * 60).toFixed(0)}min to close — forced exit to avoid settlement risk.`,
      currentProfitPct: profitPct,
      peakProfitPct,
      trailingStopLevel,
      suggestedExitPrice: currentPrice,
    };
  }

  // ── Rule 2: Exit < 90min if profitable ────────────────────────────────
  if (hoursToClose <= TIME_DECAY_PROFIT_EXIT && profitPct > 0.03) {
    return {
      ticker, shouldExit: true, exitReason: "TIME_DECAY",
      urgency: "soon",
      reasoning: `${(hoursToClose * 60).toFixed(0)}min to close, position up ${(profitPct * 100).toFixed(1)}% — lock profit before time decay.`,
      currentProfitPct: profitPct,
      peakProfitPct,
      trailingStopLevel,
      suggestedExitPrice: currentPrice,
    };
  }

  // ── Rule 3: Tier 3 exit — 90%+ of move captured ───────────────────────
  if (moveCaptured >= EXIT_TIER_3_PCT) {
    return {
      ticker, shouldExit: true, exitReason: "PROFIT_TARGET",
      urgency: "immediate",
      reasoning: `${Math.round(moveCaptured * 100)}% of projected move captured (target: ${Math.round(target * 100)}¢). Tier 3 — full exit.`,
      currentProfitPct: profitPct,
      peakProfitPct,
      trailingStopLevel,
      suggestedExitPrice: currentPrice,
    };
  }

  // ── Rule 4: Trailing stop tripped ────────────────────────────────────
  if (trailingStopLevel !== null && currentPrice < trailingStopLevel && profitPct > 0) {
    const pullbackPct = ((peakPrice - currentPrice) / peakPrice * 100).toFixed(1);
    return {
      ticker, shouldExit: true, exitReason: "TRAILING_STOP",
      urgency: "immediate",
      reasoning: `Trailing stop triggered. Peak: ${Math.round(peakPrice * 100)}¢, current: ${Math.round(currentPrice * 100)}¢ (–${pullbackPct}% from peak). Stop: ${Math.round(trailingStopLevel * 100)}¢.`,
      currentProfitPct: profitPct,
      peakProfitPct,
      trailingStopLevel,
      suggestedExitPrice: currentPrice,
    };
  }

  // ── Rule 5: Momentum fade — 3 ticks declining velocity while profitable ─
  if (priceHistory && priceHistory.length >= MOMENTUM_FADE_TICKS + 1 && profitPct > 0.02) {
    const last = priceHistory.slice(-MOMENTUM_FADE_TICKS);
    const fading = last.every((p, i) => i === 0 || p <= last[i - 1]);
    if (fading) {
      return {
        ticker, shouldExit: true, exitReason: "MOMENTUM_REVERSAL",
        urgency: "soon",
        reasoning: `${MOMENTUM_FADE_TICKS} consecutive ticks of declining momentum while up ${(profitPct * 100).toFixed(1)}%. Momentum fading — protect gains.`,
        currentProfitPct: profitPct,
        peakProfitPct,
        trailingStopLevel,
        suggestedExitPrice: currentPrice,
      };
    }
  }

  // ── Rule 6: Tier 2 exit — 75% of move captured ───────────────────────
  if (moveCaptured >= EXIT_TIER_2_PCT) {
    const momentumFading = priceHistory && priceHistory.length >= 3
      ? priceHistory[priceHistory.length - 1] <= priceHistory[priceHistory.length - 3]
      : false;
    if (momentumFading || hasBetterOpportunity) {
      return {
        ticker, shouldExit: true, exitReason: hasBetterOpportunity ? "BETTER_OPPORTUNITY" : "PROFIT_TARGET",
        urgency: "soon",
        reasoning: `${Math.round(moveCaptured * 100)}% of move captured at Tier 2. ${hasBetterOpportunity ? "Better opportunity — redeploy." : "Momentum fading — lock profit."}`,
        currentProfitPct: profitPct,
        peakProfitPct,
        trailingStopLevel,
        suggestedExitPrice: currentPrice,
      };
    }
  }

  // ── Rule 7: Tier 1 exit — 50% of move + time risk ────────────────────
  if (moveCaptured >= EXIT_TIER_1_PCT && hoursToClose <= 3) {
    return {
      ticker, shouldExit: true, exitReason: "PROFIT_TARGET",
      urgency: "soon",
      reasoning: `${Math.round(moveCaptured * 100)}% of move captured with ${hoursToClose.toFixed(1)}h left — take profit.`,
      currentProfitPct: profitPct,
      peakProfitPct,
      trailingStopLevel,
      suggestedExitPrice: currentPrice,
    };
  }

  // ── Rule 8: Better opportunity ────────────────────────────────────────
  if (hasBetterOpportunity && profitPct > 0.05) {
    return {
      ticker, shouldExit: true, exitReason: "BETTER_OPPORTUNITY",
      urgency: "soon",
      reasoning: `Better momentum signal found. Position up ${(profitPct * 100).toFixed(1)}% — exit and redeploy.`,
      currentProfitPct: profitPct,
      peakProfitPct,
      trailingStopLevel,
      suggestedExitPrice: currentPrice,
    };
  }

  // ── Hold ──────────────────────────────────────────────────────────────
  const movePct    = Math.round(moveCaptured * 100);
  const targetPct  = Math.round(target * 100);
  const holdReason = profitPct > 0
    ? `Up ${(profitPct * 100).toFixed(1)}% (${movePct}% of move to ${targetPct}¢ captured). ${trailingStopLevel ? `Trailing stop: ${Math.round(trailingStopLevel * 100)}¢.` : "Holding for target."}`
    : `Flat/down ${(profitPct * 100).toFixed(1)}%. Target: ${targetPct}¢. Waiting for momentum to build.`;

  return {
    ticker, shouldExit: false, exitReason: "HOLD",
    urgency: "monitor",
    reasoning: holdReason,
    currentProfitPct: profitPct,
    peakProfitPct,
    trailingStopLevel,
    suggestedExitPrice: null,
  };
}

// ─── Batch scanner (no-history version for quick scans) ──────────────────
export function scanMarkets(
  markets: KalshiMarket[],
  accountBalanceCents: number = 100_000,
  maxRiskPct: number = 2
): EVResult[] {
  return markets
    .map(m => evaluateMarket(m, null, accountBalanceCents, maxRiskPct))
    .filter(r => r.action !== "HOLD")
    .sort((a, b) => {
      // Sort by momentum score desc, then EV
      const diff = b.momentumScore - a.momentumScore;
      if (Math.abs(diff) > 0.05) return diff;
      return b.ev - a.ev;
    });
}

// ─── Legacy adapters ─────────────────────────────────────────────────────
export interface AIRecommendation {
  ticker: string;
  action: "BUY" | "WAIT";
  side: "YES" | "NO" | null;
  confidence: number;
  reasoning: string;
  opportunity_window?: string;
  ev?: number;
  pFair?: number;
  midpoint?: number;
  mispricingGap?: number;
  entryPrice?: number;
  positionSizeCents?: number;
  entryReason?: EntryReason | null;
  entryQuality?: number;
  // v4 extras passed through
  pTarget?: number;
  velocityScore?: number;
  momentumScore?: number;
}

export function toRecommendation(r: EVResult): AIRecommendation {
  return {
    ticker: r.ticker,
    action: r.action !== "HOLD" ? "BUY" : "WAIT",
    side: r.action === "BUY_YES" ? "YES" : r.action === "BUY_NO" ? "NO" : null,
    confidence: r.confidence,
    reasoning: r.reasoning,
    opportunity_window: r.opportunity_window,
    ev: r.ev,
    pFair: r.pFair,
    midpoint: r.midpoint,
    mispricingGap: r.mispricingGap,
    entryPrice: r.entryPrice,
    positionSizeCents: r.positionSizeCents,
    entryReason: r.entryReason,
    entryQuality: r.entryQuality,
    pTarget: r.pTarget,
    velocityScore: r.velocityScore,
    momentumScore: r.momentumScore,
  };
}

export function generateRecommendation(
  market: KalshiMarket,
  history: PricePoint[] | null
): AIRecommendation {
  return toRecommendation(evaluateMarket(market, history, 100_000, 2));
}

export function generateRecommendations(markets: KalshiMarket[]): AIRecommendation[] {
  return markets
    .map(m => generateRecommendation(m, null))
    .sort((a, b) => {
      if (a.action === "BUY" && b.action !== "BUY") return -1;
      if (b.action === "BUY" && a.action !== "BUY") return 1;
      return (b.momentumScore ?? 0) - (a.momentumScore ?? 0);
    });
}

export function formatTimeRemaining(closeTime: string): string {
  const diff = new Date(closeTime).getTime() - Date.now();
  if (diff <= 0) return "Closed";
  const totalSecs = Math.floor(diff / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const totalMins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (totalMins < 60) return `${totalMins}m ${secs.toString().padStart(2, "0")}s`;
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  const s = totalSecs % 60;
  if (m === 0 && s === 0) return `${h}h`;
  if (m === 0) return `${h}h ${s.toString().padStart(2, "0")}s`;
  return `${h}h ${m}m ${s.toString().padStart(2, "0")}s`;
}

export function getMarketLabel(market: KalshiMarket, side: "yes" | "no"): string {
  if (side === "yes") return market.yes_sub_title || "YES";
  return market.no_sub_title || "NO";
}

export function getBuyButtonLabel(rec: AIRecommendation, market: KalshiMarket): string {
  if (rec.action !== "BUY" || !rec.side) return "WAIT";
  const label = rec.side === "YES"
    ? (market.yes_sub_title || "YES")
    : (market.no_sub_title || "NO");
  return `BUY ${label.toUpperCase()}`;
}
