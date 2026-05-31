/**
 * PulseTrade — Adaptive Learning & Loss Streak Protection
 *
 * Capital preservation first. The AI gets SMARTER after losses — never more aggressive.
 *
 * Loss Streak Protection:
 *   3 losses  → -25% position size, +5pp confidence floor
 *   5 losses  → -50% position size, +10pp confidence floor
 *   7 losses  → Observation Mode: scan/recommend but NO new entries (24h min)
 *  10 losses  → Review Mode: all trading halted, diagnostic report generated
 *
 * Recovery Mode (new):
 *   After Observation exits (3 wins + 24h): RECOVERY mode
 *   Uses 50% size, +10pp conf, max 3 open positions
 *   After 5 successful trades completed in RECOVERY → back to NORMAL
 *
 * Per-Category Streak Tracking (new):
 *   Each category tracks its own consecutive loss streak independently.
 *   Crypto losses don't affect basketball, etc.
 *   Same 3/5/7/10 thresholds per category.
 *   Global streak still applies — if global hits OBSERVATION all categories blocked.
 *
 * Daily Profit Lock (new):
 *   Tracks daily peak portfolio value.
 *   If portfolio drops >15% from daily peak → block new positions for rest of day.
 *   Resets at midnight UTC. Existing open positions managed normally.
 */

import { db } from "./database/index.js";
import { trades, settings } from "./database/schema.js";
import { eq, desc, and } from "drizzle-orm";
import { ENGINE_VERSION } from "./ai.js";

// ─── Streak thresholds ─────────────────────────────────────────────────────
export const STREAK_CAUTION       = 3;   // reduce size 25%, raise conf
export const STREAK_DEFENSIVE     = 5;   // reduce size 50%, raise conf more
export const STREAK_OBSERVE       = 7;   // Observation Mode: no new trades
export const STREAK_REVIEW        = 10;  // Review Mode: full halt + diagnostic

// ─── Recovery thresholds ──────────────────────────────────────────────────
const RECOVERY_WIN_STREAK         = 3;   // wins needed to exit Observation → Recovery
const OBSERVATION_MIN_HOURS       = 24;  // minimum hours in Observation Mode
const RECOVERY_TRADES_NEEDED      = 5;   // successful trades in Recovery → Normal

// ─── Daily Profit Lock ────────────────────────────────────────────────────
const DAILY_DRAWDOWN_LIMIT        = 0.15; // 15% drop from daily peak triggers lock

// ─── Confidence calibration: bucket boundaries ────────────────────────────
const CONF_BUCKETS = [
  { label: "50–60%", min: 0.50, max: 0.60 },
  { label: "60–70%", min: 0.60, max: 0.70 },
  { label: "70–80%", min: 0.70, max: 0.80 },
  { label: "80–90%", min: 0.80, max: 0.90 },
  { label: "90–100%",min: 0.90, max: 1.01 },
];

// ─── Category detection ────────────────────────────────────────────────────
export function detectCategory(ticker: string): string {
  const t = ticker.toUpperCase();
  if (t.startsWith("KXNBA") || t.startsWith("KXWNBA")) return "basketball";
  if (t.startsWith("KXMLB")) return "baseball";
  if (t.startsWith("KXNFL")) return "football";
  if (t.startsWith("KXNHL")) return "hockey";
  if (t.startsWith("KXBTC") || t.startsWith("KXETH") || t.startsWith("KXSOL") || t.startsWith("KXCRYPTO")) {
    return "crypto";
  }
  if (t.startsWith("KXPRES") || t.startsWith("KXGOV") || t.startsWith("KXPOL")) return "politics";
  if (t.startsWith("KXECON") || t.startsWith("KXFED") || t.startsWith("KXINFL")) return "economics";
  return "other";
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type ProtectionMode =
  | "NORMAL"         // no streak issues
  | "CAUTION"        // 3 losses: reduced size
  | "DEFENSIVE"      // 5 losses: heavily reduced size
  | "OBSERVATION"    // 7 losses: no new entries, just watching
  | "RECOVERY"       // post-observation: restricted resume (50% size, max 3 positions)
  | "REVIEW";        // 10 losses: full halt

export interface AdaptiveState {
  mode: ProtectionMode;
  consecutiveLosses: number;
  consecutiveWins: number;
  positionSizeMultiplier: number;     // 1.0 = normal, 0.75 = caution, 0.5 = defensive/recovery, 0 = halted
  minConfidenceBoost: number;         // extra pp added to min confidence (0.05, 0.10, etc.)
  observationEnteredAt: string | null;
  recoveryTradesCompleted: number;    // trades closed-with-profit while in RECOVERY
  recoveryTradesNeeded: number;       // need this many to graduate to NORMAL
  dailyProfitLockActive: boolean;     // true if daily drawdown limit hit
  dailyPeakValueCents: number;        // running daily high-water mark
  dailyDropPct: number;               // current drop from peak (0–1)
  message: string;
}

export interface CategoryAdaptiveState {
  category: string;
  consecutiveLosses: number;
  mode: ProtectionMode;               // per-category mode (max OBSERVATION — no per-cat RECOVERY)
  positionSizeMultiplier: number;
  minConfidenceBoost: number;
  blocked: boolean;                   // true if this category's mode blocks new trades
}

export interface CategoryWeight {
  category: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  weight: number;                     // 0.5–1.5 allocation multiplier
  avgPnl: number;
}

export interface ConfidenceBucket {
  label: string;
  min: number;
  max: number;
  trades: number;
  wins: number;
  predictedWinRate: number;           // midpoint of bucket
  actualWinRate: number | null;
  calibrationError: number | null;    // actualWinRate - predictedWinRate (negative = overconfident)
  adjustment: number;                 // cents to add/subtract from confidence calc
}

export interface LearningReport {
  generatedAt: string;
  engineVersion: string;
  protection: AdaptiveState;
  categoryWeights: CategoryWeight[];
  confidenceCalibration: ConfidenceBucket[];
  entryPatterns: {
    byEntryReason: Record<string, { trades: number; wins: number; avgPnl: number; winRate: number | null }>;
  };
  exitPatterns: {
    byExitReason: Record<string, { count: number; avgPnl: number; pct: number }>;
  };
  holdingTimeAnalysis: {
    avgHoldingHours: number | null;
    winnerAvgHours: number | null;
    loserAvgHours: number | null;
  };
  recommendations: string[];
}

// ─── Settings helpers ──────────────────────────────────────────────────────

async function loadSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings).catch(() => []);
  const s: Record<string, string> = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return s;
}

async function saveSetting(key: string, value: string): Promise<void> {
  await db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .catch(() => {});
}

// ─── Core: compute global adaptive state from closed trades ───────────────

export async function computeAdaptiveState(): Promise<AdaptiveState> {
  const [closed, s] = await Promise.all([
    db.select()
      .from(trades)
      .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
      .orderBy(desc(trades.enteredAt))
      .limit(20)
      .catch(() => []),
    loadSettings(),
  ]);

  // Count consecutive losses/wins from most recent
  let consecutiveLosses = 0;
  let consecutiveWins = 0;
  let lastWasLoss = true;
  let lastWasWin = true;

  for (const t of closed) {
    const isLoss = (t.pnl || 0) <= 0;
    if (lastWasLoss && isLoss) consecutiveLosses++;
    else lastWasLoss = false;

    const isWin = (t.pnl || 0) > 0;
    if (lastWasWin && isWin) consecutiveWins++;
    else lastWasWin = false;

    if (!lastWasLoss && !lastWasWin) break;
  }

  const observationEnteredAt = s.observation_mode_entered_at || null;
  const recoveryTradesCompleted = parseInt(s.recovery_trades_completed || "0", 10);

  // ── Daily profit lock ─────────────────────────────────────────────────
  const todayUtc = new Date().toISOString().split("T")[0];
  const storedPeakDate = s.daily_peak_date || "";
  const paperBalanceCents = parseInt(s.paper_balance || "100000", 10) * 100;
  // If peak is from a previous day, reset it
  let dailyPeakValueCents = storedPeakDate === todayUtc
    ? parseInt(s.daily_peak_cents || "0", 10)
    : paperBalanceCents;
  // Update peak if current balance is higher
  if (paperBalanceCents > dailyPeakValueCents) {
    dailyPeakValueCents = paperBalanceCents;
  }
  const dailyDropPct = dailyPeakValueCents > 0
    ? Math.max(0, (dailyPeakValueCents - paperBalanceCents) / dailyPeakValueCents)
    : 0;
  const dailyProfitLockActive = dailyDropPct >= DAILY_DRAWDOWN_LIMIT;

  // ── Determine protection mode ─────────────────────────────────────────
  let mode: ProtectionMode = "NORMAL";
  let positionSizeMultiplier = 1.0;
  let minConfidenceBoost = 0;
  let message = "Engine operating normally.";

  if (consecutiveLosses >= STREAK_REVIEW) {
    mode = "REVIEW";
    positionSizeMultiplier = 0;
    minConfidenceBoost = 0.15;
    message = `${consecutiveLosses} consecutive losses — Review Mode active. New trades halted. Generate diagnostic report.`;
  } else if (consecutiveLosses >= STREAK_OBSERVE) {
    const inObsForHours = observationEnteredAt
      ? (Date.now() - new Date(observationEnteredAt).getTime()) / (1000 * 60 * 60)
      : 0;
    const canExitObs = consecutiveWins >= RECOVERY_WIN_STREAK && inObsForHours >= OBSERVATION_MIN_HOURS;

    if (canExitObs) {
      // Check if we're still in recovery (haven't completed enough recovery trades)
      if (recoveryTradesCompleted < RECOVERY_TRADES_NEEDED) {
        mode = "RECOVERY";
        positionSizeMultiplier = 0.5;
        minConfidenceBoost = 0.10;
        message = `Recovery Mode: ${recoveryTradesCompleted}/${RECOVERY_TRADES_NEEDED} successful trades completed. 50% position size, max 3 open positions.`;
      } else {
        // Graduated from recovery → normal
        mode = "NORMAL";
        positionSizeMultiplier = 1.0;
        minConfidenceBoost = 0;
        message = `Recovery complete. ${RECOVERY_TRADES_NEEDED} successful trades confirmed. Engine back to normal operation.`;
      }
    } else {
      mode = "OBSERVATION";
      positionSizeMultiplier = 0;
      minConfidenceBoost = 0.10;
      const hoursIn = observationEnteredAt
        ? Math.round((Date.now() - new Date(observationEnteredAt).getTime()) / (1000 * 60 * 60))
        : 0;
      message = `${consecutiveLosses} consecutive losses — Observation Mode. Scanning markets but no new positions. ${hoursIn}h elapsed (min ${OBSERVATION_MIN_HOURS}h). Need ${RECOVERY_WIN_STREAK} wins to step down.`;
    }
  } else if (consecutiveLosses >= STREAK_DEFENSIVE) {
    mode = "DEFENSIVE";
    positionSizeMultiplier = 0.5;
    minConfidenceBoost = 0.10;
    message = `${consecutiveLosses} consecutive losses — Defensive mode. Position size 50%. Confidence floor raised +10pp.`;
  } else if (consecutiveLosses >= STREAK_CAUTION) {
    mode = "CAUTION";
    positionSizeMultiplier = 0.75;
    minConfidenceBoost = 0.05;
    message = `${consecutiveLosses} consecutive losses — Caution mode. Position size 75%. Confidence floor raised +5pp.`;
  } else {
    if (consecutiveWins >= RECOVERY_WIN_STREAK) {
      message = `${consecutiveWins} consecutive wins. Engine operating at full capacity.`;
    }
  }

  // Daily profit lock message override (appended, doesn't change mode)
  if (dailyProfitLockActive) {
    message += ` | ⛔ Daily Profit Lock active: portfolio down ${(dailyDropPct * 100).toFixed(1)}% from today's peak. No new entries until midnight UTC.`;
  }

  return {
    mode,
    consecutiveLosses,
    consecutiveWins,
    positionSizeMultiplier,
    minConfidenceBoost,
    observationEnteredAt,
    recoveryTradesCompleted,
    recoveryTradesNeeded: RECOVERY_TRADES_NEEDED,
    dailyProfitLockActive,
    dailyPeakValueCents,
    dailyDropPct,
    message,
  };
}

// ─── Per-category streak tracking ─────────────────────────────────────────

export async function computeCategoryStreaks(): Promise<CategoryAdaptiveState[]> {
  // Load all recent closed trades (last 50 per category is plenty)
  const closed = await db
    .select()
    .from(trades)
    .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
    .orderBy(desc(trades.enteredAt))
    .limit(100)
    .catch(() => []);

  // Group by category in order (most recent first)
  const byCat: Record<string, typeof closed> = {};
  for (const t of closed) {
    const cat = detectCategory(t.marketId);
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(t);
  }

  const results: CategoryAdaptiveState[] = [];

  for (const [category, catTrades] of Object.entries(byCat)) {
    // Count consecutive losses from most recent trade in this category
    let consecutiveLosses = 0;
    for (const t of catTrades) {
      if ((t.pnl || 0) <= 0) consecutiveLosses++;
      else break;
    }

    // Determine per-category mode (no RECOVERY at category level — that's global only)
    let mode: ProtectionMode = "NORMAL";
    let positionSizeMultiplier = 1.0;
    let minConfidenceBoost = 0;
    let blocked = false;

    if (consecutiveLosses >= STREAK_REVIEW) {
      // At review level, entire engine is blocked globally anyway
      mode = "REVIEW";
      positionSizeMultiplier = 0;
      minConfidenceBoost = 0.15;
      blocked = true;
    } else if (consecutiveLosses >= STREAK_OBSERVE) {
      mode = "OBSERVATION";
      positionSizeMultiplier = 0;
      minConfidenceBoost = 0.10;
      blocked = true;
    } else if (consecutiveLosses >= STREAK_DEFENSIVE) {
      mode = "DEFENSIVE";
      positionSizeMultiplier = 0.5;
      minConfidenceBoost = 0.10;
    } else if (consecutiveLosses >= STREAK_CAUTION) {
      mode = "CAUTION";
      positionSizeMultiplier = 0.75;
      minConfidenceBoost = 0.05;
    }

    results.push({ category, consecutiveLosses, mode, positionSizeMultiplier, minConfidenceBoost, blocked });
  }

  return results;
}

// ─── Daily profit lock check & update ─────────────────────────────────────

export async function checkAndUpdateDailyProfitLock(): Promise<{
  lockActive: boolean;
  dailyPeakValueCents: number;
  currentValueCents: number;
  dropPct: number;
}> {
  const s = await loadSettings();
  const todayUtc = new Date().toISOString().split("T")[0];
  // paper_balance stored as dollars (e.g. "1000.50" or "100000" meaning cents?)
  // From context: paper_balance=100000 means $1000.00 (stored in cents as integer)
  const currentValueCents = parseInt(s.paper_balance || "100000", 10);
  const storedPeakDate = s.daily_peak_date || "";

  let dailyPeakValueCents: number;
  if (storedPeakDate !== todayUtc) {
    // New day — reset peak to current value
    dailyPeakValueCents = currentValueCents;
    await Promise.all([
      saveSetting("daily_peak_cents", String(currentValueCents)),
      saveSetting("daily_peak_date", todayUtc),
    ]);
  } else {
    dailyPeakValueCents = parseInt(s.daily_peak_cents || "0", 10);
    // Update peak if balance has grown
    if (currentValueCents > dailyPeakValueCents) {
      dailyPeakValueCents = currentValueCents;
      await saveSetting("daily_peak_cents", String(currentValueCents));
    }
  }

  const dropPct = dailyPeakValueCents > 0
    ? Math.max(0, (dailyPeakValueCents - currentValueCents) / dailyPeakValueCents)
    : 0;
  const lockActive = dropPct >= DAILY_DRAWDOWN_LIMIT;

  return { lockActive, dailyPeakValueCents, currentValueCents, dropPct };
}

// ─── Recovery mode: increment completed trades counter ────────────────────
// Call this when a trade that was opened during RECOVERY mode closes with profit

export async function incrementRecoveryTrade(): Promise<number> {
  const s = await loadSettings();
  const current = parseInt(s.recovery_trades_completed || "0", 10);
  const next = current + 1;
  await saveSetting("recovery_trades_completed", String(next));
  return next;
}

export async function resetRecoveryCounter(): Promise<void> {
  await saveSetting("recovery_trades_completed", "0");
}

// ─── Persist observation mode entry/exit time ─────────────────────────────

export async function persistObservationEntry(): Promise<void> {
  await saveSetting("observation_mode_entered_at", new Date().toISOString());
}

export async function clearObservationEntry(): Promise<void> {
  await saveSetting("observation_mode_entered_at", "");
  // Also reset recovery counter when observation is cleared from scratch
  await saveSetting("recovery_trades_completed", "0");
}

// ─── Category performance weights ─────────────────────────────────────────

export async function computeCategoryWeights(): Promise<CategoryWeight[]> {
  const closed = await db
    .select()
    .from(trades)
    .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
    .catch(() => []);

  const byCategory: Record<string, { wins: number; losses: number; pnlSum: number }> = {};
  for (const t of closed) {
    const cat = detectCategory(t.marketId);
    if (!byCategory[cat]) byCategory[cat] = { wins: 0, losses: 0, pnlSum: 0 };
    if ((t.pnl || 0) > 0) byCategory[cat].wins++;
    else byCategory[cat].losses++;
    byCategory[cat].pnlSum += t.pnl || 0;
  }

  const totalTrades = closed.length;
  const globalWinRate = totalTrades > 0
    ? closed.filter(t => (t.pnl || 0) > 0).length / totalTrades
    : 0.5;

  return Object.entries(byCategory).map(([cat, stats]) => {
    const total = stats.wins + stats.losses;
    const winRate = total >= 3 ? stats.wins / total : null;
    const avgPnl = total > 0 ? stats.pnlSum / total : 0;

    let weight = 1.0;
    if (winRate !== null) {
      const delta = (winRate - globalWinRate) * 2;
      weight = Math.max(0.5, Math.min(1.5, 1.0 + delta));
    }

    return { category: cat, trades: total, wins: stats.wins, losses: stats.losses, winRate, weight, avgPnl };
  }).sort((a, b) => b.trades - a.trades);
}

// ─── Confidence calibration ────────────────────────────────────────────────

export async function computeConfidenceCalibration(): Promise<ConfidenceBucket[]> {
  const closed = await db
    .select()
    .from(trades)
    .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
    .catch(() => []);

  const withConf = closed.filter(t => t.entryQuality != null);

  return CONF_BUCKETS.map(bucket => {
    const inBucket = withConf.filter(t => {
      const conf = (t.entryQuality || 0) / 100;
      return conf >= bucket.min && conf < bucket.max;
    });
    const wins = inBucket.filter(t => (t.pnl || 0) > 0).length;
    const actualWinRate = inBucket.length >= 3 ? wins / inBucket.length : null;
    const predictedWinRate = (bucket.min + bucket.max) / 2;
    const calibrationError = actualWinRate !== null ? actualWinRate - predictedWinRate : null;
    const adjustment = calibrationError !== null ? Math.round(calibrationError * 100) : 0;

    return { label: bucket.label, min: bucket.min, max: bucket.max, trades: inBucket.length, wins, predictedWinRate, actualWinRate, calibrationError, adjustment };
  });
}

// ─── Entry pattern learning ────────────────────────────────────────────────

export async function computeEntryPatterns(): Promise<LearningReport["entryPatterns"]> {
  const closed = await db
    .select()
    .from(trades)
    .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
    .catch(() => []);

  const byEntryReason: Record<string, { trades: number; wins: number; pnlSum: number }> = {};
  for (const t of closed) {
    const reason = t.entryReason || "UNKNOWN";
    if (!byEntryReason[reason]) byEntryReason[reason] = { trades: 0, wins: 0, pnlSum: 0 };
    byEntryReason[reason].trades++;
    if ((t.pnl || 0) > 0) byEntryReason[reason].wins++;
    byEntryReason[reason].pnlSum += t.pnl || 0;
  }

  const result: LearningReport["entryPatterns"]["byEntryReason"] = {};
  for (const [reason, stats] of Object.entries(byEntryReason)) {
    result[reason] = {
      trades: stats.trades,
      wins: stats.wins,
      avgPnl: stats.trades > 0 ? stats.pnlSum / stats.trades : 0,
      winRate: stats.trades >= 3 ? stats.wins / stats.trades : null,
    };
  }

  return { byEntryReason: result };
}

// ─── Exit pattern learning ─────────────────────────────────────────────────

export async function computeExitPatterns(): Promise<LearningReport["exitPatterns"]> {
  const closed = await db
    .select()
    .from(trades)
    .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
    .catch(() => []);

  const byExitReason: Record<string, { count: number; pnlSum: number }> = {};
  for (const t of closed) {
    const reason = t.exitReason || "UNKNOWN";
    if (!byExitReason[reason]) byExitReason[reason] = { count: 0, pnlSum: 0 };
    byExitReason[reason].count++;
    byExitReason[reason].pnlSum += t.pnl || 0;
  }

  const total = closed.length || 1;
  const result: LearningReport["exitPatterns"]["byExitReason"] = {};
  for (const [reason, stats] of Object.entries(byExitReason)) {
    result[reason] = {
      count: stats.count,
      avgPnl: stats.count > 0 ? stats.pnlSum / stats.count : 0,
      pct: Math.round((stats.count / total) * 100),
    };
  }

  return { byExitReason: result };
}

// ─── Holding time analysis ─────────────────────────────────────────────────

export async function computeHoldingTimeAnalysis(): Promise<LearningReport["holdingTimeAnalysis"]> {
  const closed = await db
    .select()
    .from(trades)
    .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
    .catch(() => []);

  const withTimes = closed.filter(t => t.enteredAt && t.exitedAt);
  if (withTimes.length === 0) return { avgHoldingHours: null, winnerAvgHours: null, loserAvgHours: null };

  const holdHours = (t: typeof closed[0]) =>
    (new Date(t.exitedAt!).getTime() - new Date(t.enteredAt).getTime()) / (1000 * 60 * 60);

  const all = withTimes.map(holdHours);
  const winners = withTimes.filter(t => (t.pnl || 0) > 0).map(holdHours);
  const losers = withTimes.filter(t => (t.pnl || 0) <= 0).map(holdHours);

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  return {
    avgHoldingHours: avg(all),
    winnerAvgHours: avg(winners),
    loserAvgHours: avg(losers),
  };
}

// ─── Auto-generated recommendations from learning data ────────────────────

function buildRecommendations(
  state: AdaptiveState,
  categories: CategoryWeight[],
  calibration: ConfidenceBucket[],
  entryPatterns: LearningReport["entryPatterns"],
  exitPatterns: LearningReport["exitPatterns"],
  holding: LearningReport["holdingTimeAnalysis"],
): string[] {
  const recs: string[] = [];

  // Protection mode
  if (state.mode === "REVIEW") {
    recs.push("🚨 REVIEW MODE: Trading halted after 10 consecutive losses. Run full diagnostic before resuming.");
  } else if (state.mode === "OBSERVATION") {
    recs.push(`⏸ OBSERVATION MODE: ${state.consecutiveLosses} consecutive losses. Watching markets, no new positions until ${RECOVERY_WIN_STREAK} consecutive wins observed.`);
  } else if (state.mode === "RECOVERY") {
    recs.push(`🔄 RECOVERY MODE: ${state.recoveryTradesCompleted}/${state.recoveryTradesNeeded} recovery trades completed. Operating at 50% size with max 3 open positions.`);
  } else if (state.mode === "DEFENSIVE") {
    recs.push(`⚠ DEFENSIVE MODE: ${state.consecutiveLosses} consecutive losses. Positions capped at 50% size.`);
  } else if (state.mode === "CAUTION") {
    recs.push(`⚠ CAUTION: ${state.consecutiveLosses} consecutive losses. Positions reduced to 75%.`);
  }

  // Daily profit lock
  if (state.dailyProfitLockActive) {
    recs.push(`⛔ DAILY PROFIT LOCK: Portfolio down ${(state.dailyDropPct * 100).toFixed(1)}% from today's peak ($${(state.dailyPeakValueCents / 100).toFixed(2)}). No new entries until midnight UTC.`);
  }

  // Category recommendations
  const weakCats = categories.filter(c => c.winRate !== null && c.winRate < 0.45 && c.trades >= 5);
  const strongCats = categories.filter(c => c.winRate !== null && c.winRate > 0.60 && c.trades >= 5);
  if (weakCats.length > 0) {
    recs.push(`📉 Underperforming categories: ${weakCats.map(c => `${c.category} (${Math.round((c.winRate || 0) * 100)}% win rate)`).join(", ")}. Allocation reduced automatically.`);
  }
  if (strongCats.length > 0) {
    recs.push(`📈 Strong categories: ${strongCats.map(c => `${c.category} (${Math.round((c.winRate || 0) * 100)}% win rate)`).join(", ")}. Allocation boosted.`);
  }

  // Confidence calibration
  const overconfidentBuckets = calibration.filter(
    b => b.calibrationError !== null && b.calibrationError < -0.15 && b.trades >= 5
  );
  if (overconfidentBuckets.length > 0) {
    recs.push(`🎯 AI overconfidence detected in: ${overconfidentBuckets.map(b => b.label).join(", ")}. Actual win rates significantly below predicted.`);
  }

  // Entry patterns
  const badEntries = Object.entries(entryPatterns.byEntryReason)
    .filter(([, v]) => v.winRate !== null && v.winRate < 0.40 && v.trades >= 5);
  if (badEntries.length > 0) {
    recs.push(`❌ Weak entry signals: ${badEntries.map(([r]) => r).join(", ")}. Consider raising threshold for these patterns.`);
  }

  // Exit patterns
  const exitBreakdown = exitPatterns.byExitReason;
  if (exitBreakdown.STOP_LOSS) {
    const slRate = exitBreakdown.STOP_LOSS.pct;
    if (slRate > 40) {
      recs.push(`🛑 Stop-loss exits: ${slRate}% of all exits. Entry criteria may need tightening.`);
    }
  }
  if (exitBreakdown.PROFIT_TARGET) {
    recs.push(`✅ Profit target exits: ${exitBreakdown.PROFIT_TARGET.pct}% of exits (avg P&L: $${exitBreakdown.PROFIT_TARGET.avgPnl.toFixed(3)})`);
  }

  // Holding time
  if (holding.winnerAvgHours != null && holding.loserAvgHours != null) {
    if (holding.loserAvgHours > holding.winnerAvgHours * 1.5) {
      recs.push(`⏱ Losers held ${holding.loserAvgHours.toFixed(1)}h vs winners ${holding.winnerAvgHours.toFixed(1)}h — consider tighter time-based exits on losing positions.`);
    }
  }

  if (recs.length === 0) {
    recs.push("Engine performing within expected parameters. Continue paper trading to build confidence signal.");
  }

  return recs;
}

// ─── Full learning report ──────────────────────────────────────────────────

export async function generateLearningReport(): Promise<LearningReport> {
  const [state, categoryWeights, confidenceCalibration, entryPatterns, exitPatterns, holdingTimeAnalysis] =
    await Promise.all([
      computeAdaptiveState(),
      computeCategoryWeights(),
      computeConfidenceCalibration(),
      computeEntryPatterns(),
      computeExitPatterns(),
      computeHoldingTimeAnalysis(),
    ]);

  const recommendations = buildRecommendations(
    state, categoryWeights, confidenceCalibration, entryPatterns, exitPatterns, holdingTimeAnalysis
  );

  return {
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    protection: state,
    categoryWeights,
    confidenceCalibration,
    entryPatterns,
    exitPatterns,
    holdingTimeAnalysis,
    recommendations,
  };
}

// ─── Apply adaptive state to scan parameters ──────────────────────────────
// Call this in the scan engine to adjust sizing + confidence before trading

export interface ScanAdaptations {
  positionSizeMultiplier: number;         // multiply final position size by this
  minConfidenceBoost: number;             // add this to minConfidencePct
  blockNewTrades: boolean;                // true in OBSERVATION and REVIEW modes
  mode: ProtectionMode;
  categoryWeights: Record<string, number>;
  categoryBlocked: Record<string, boolean>; // per-category block flags
  dailyProfitLockActive: boolean;         // true if daily drawdown limit hit
  maxOpenPositionsOverride: number | null; // null = use default; set to 3 in RECOVERY
  logMessage: string;
}

export async function getScanAdaptations(): Promise<ScanAdaptations> {
  const [state, categories, categoryStreaks, profitLock] = await Promise.all([
    computeAdaptiveState(),
    computeCategoryWeights(),
    computeCategoryStreaks(),
    checkAndUpdateDailyProfitLock(),
  ]);

  // Observation mode entry/exit persistence
  if (state.mode === "OBSERVATION" && !state.observationEnteredAt) {
    await persistObservationEntry();
  } else if (
    state.mode !== "OBSERVATION" &&
    state.mode !== "REVIEW" &&
    state.mode !== "RECOVERY" &&
    state.observationEnteredAt
  ) {
    await clearObservationEntry();
  }

  const categoryWeights: Record<string, number> = {};
  for (const cat of categories) {
    categoryWeights[cat.category] = cat.weight;
  }

  // Per-category blocked map
  // A category is blocked if its own streak hits OBSERVATION/REVIEW,
  // OR if the global mode blocks all trades.
  const globalBlock = state.mode === "OBSERVATION" || state.mode === "REVIEW";
  const categoryBlocked: Record<string, boolean> = {};
  for (const catState of categoryStreaks) {
    categoryBlocked[catState.category] = globalBlock || catState.blocked;
  }

  // Global block: OBSERVATION or REVIEW (RECOVERY is NOT a global block — restricted resume)
  const blockNewTrades = globalBlock;

  // Recovery: cap open positions at 3
  const maxOpenPositionsOverride = state.mode === "RECOVERY" ? 3 : null;

  return {
    positionSizeMultiplier: state.positionSizeMultiplier,
    minConfidenceBoost: state.minConfidenceBoost,
    blockNewTrades,
    mode: state.mode,
    categoryWeights,
    categoryBlocked,
    dailyProfitLockActive: profitLock.lockActive,
    maxOpenPositionsOverride,
    logMessage: state.message,
  };
}
