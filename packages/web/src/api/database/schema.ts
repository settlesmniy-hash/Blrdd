import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Current engine version — bump this when logic changes to isolate old data
export const ENGINE_VERSION = "4.0.0";

// ─── Trades ────────────────────────────────────────────────────────────────
export const trades = sqliteTable("trades", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull(),
  marketTitle: text("market_title").notNull(),
  side: text("side").notNull(),               // "yes" | "no"
  count: integer("count").notNull(),
  priceEntered: real("price_entered").notNull(), // 0.0–1.0
  priceExited: real("price_exited"),
  status: text("status").notNull().default("open"), // "open" | "closed" | "expired"
  paperTrade: integer("paper_trade", { mode: "boolean" }).notNull().default(true),
  aiRecommended: integer("ai_recommended", { mode: "boolean" }).notNull().default(true),
  enteredAt: text("entered_at").notNull().default(sql`(datetime('now'))`),
  exitedAt: text("exited_at"),
  pnl: real("pnl"),
  kalshiOrderId: text("kalshi_order_id"),
  notes: text("notes"),
  engineVersion: text("engine_version").notNull().default(ENGINE_VERSION),
  // EV fields captured at entry
  evAtEntry: real("ev_at_entry"),             // expected value at trade entry
  kellyFraction: real("kelly_fraction"),      // kelly sizing fraction used
  pFair: real("p_fair"),                      // fair probability estimate
  // v3: entry / exit metadata
  entryReason: text("entry_reason"),          // why the engine entered
  exitReason: text("exit_reason"),            // why the engine exited
  peakPrice: real("peak_price"),              // highest price seen while position open
  trailingStopLevel: real("trailing_stop_level"), // trailing stop price
  mispricingGap: real("mispricing_gap"),      // pFair - midpoint at entry
  entryQuality: integer("entry_quality"),     // 0–100 timing score at entry
  // v4: momentum engine fields
  pTarget: real("p_target"),                  // momentum target at entry
  velocityAtEntry: real("velocity_at_entry"), // velocity score at entry
  momentumScore: real("momentum_score"),      // composite momentum 0–1
});

// ─── AI Decisions ───────────────────────────────────────────────────────────
export const aiDecisions = sqliteTable("ai_decisions", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull(),
  action: text("action").notNull(),           // "buy_yes" | "buy_no" | "hold" | "skip" | "exit"
  confidence: real("confidence").notNull(),   // 0.0–1.0
  ev: real("ev").notNull(),                   // expected value
  edge: real("edge").notNull(),
  spread: real("spread").notNull(),
  lastPrice: real("last_price").notNull(),
  bidPrice: real("bid_price"),
  askPrice: real("ask_price"),
  pFair: real("p_fair"),
  kellyFraction: real("kelly_fraction"),
  positionSizeCents: integer("position_size_cents"),
  priceMoveDelta: real("price_move_delta"),
  reasoning: text("reasoning"),
  tradeId: text("trade_id"),
  outcome: text("outcome"),                   // "correct" | "incorrect" | "pending"
  engineVersion: text("engine_version").notNull().default(ENGINE_VERSION),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Scan Log ────────────────────────────────────────────────────────────────
// Every trade engine scan run
export const scanLog = sqliteTable("scan_log", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
  marketsScanned: integer("markets_scanned").notNull().default(0),
  opportunitiesFound: integer("opportunities_found").notNull().default(0),
  tradesExecuted: integer("trades_executed").notNull().default(0),
  paperMode: integer("paper_mode", { mode: "boolean" }).notNull().default(true),
  error: text("error"),
  engineVersion: text("engine_version").notNull().default(ENGINE_VERSION),
});

// ─── Performance Log ─────────────────────────────────────────────────────────
export const performanceLog = sqliteTable("performance_log", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  totalTrades: integer("total_trades").notNull().default(0),
  winningTrades: integer("winning_trades").notNull().default(0),
  losingTrades: integer("losing_trades").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  paperBalance: real("paper_balance").notNull().default(1000),
  realBalance: real("real_balance"),
  winRate: real("win_rate"),
  avgEdge: real("avg_edge"),
  aiAccuracy: real("ai_accuracy"),
  engineVersion: text("engine_version").notNull().default(ENGINE_VERSION),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Market Snapshots ────────────────────────────────────────────────────────
export const marketSnapshots = sqliteTable("market_snapshots", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull(),
  lastPrice: real("last_price").notNull(),
  yesAsk: real("yes_ask"),
  yesBid: real("yes_bid"),
  noAsk: real("no_ask"),
  noBid: real("no_bid"),
  volume: integer("volume"),
  openInterest: integer("open_interest"),
  capturedAt: text("captured_at").notNull().default(sql`(datetime('now'))`),
});

// ─── Open Positions Cache ────────────────────────────────────────────────────
export const positions = sqliteTable("positions", {
  id: text("id").primaryKey(),
  marketId: text("market_id").notNull().unique(),
  marketTitle: text("market_title").notNull(),
  side: text("side").notNull(),
  count: integer("count").notNull(),
  avgEntryPrice: real("avg_entry_price").notNull(),
  currentPrice: real("current_price"),
  unrealizedPnl: real("unrealized_pnl"),
  paperTrade: integer("paper_trade", { mode: "boolean" }).notNull().default(true),
  openedAt: text("opened_at").notNull().default(sql`(datetime('now'))`),
  lastUpdated: text("last_updated").notNull().default(sql`(datetime('now'))`),
  // v3: exit tracking fields
  peakPrice: real("peak_price"),
  trailingStopLevel: real("trailing_stop_level"),
  consecutiveDrops: integer("consecutive_drops").notNull().default(0),
  lastMonitoredAt: text("last_monitored_at"),
  closeTime: text("close_time"),
});

// ─── Position Monitor Log ─────────────────────────────────────────────────────
export const positionMonitorLog = sqliteTable("position_monitor_log", {
  id: text("id").primaryKey(),
  positionId: text("position_id").notNull(),
  marketId: text("market_id").notNull(),
  checkedAt: text("checked_at").notNull().default(sql`(datetime('now'))`),
  currentPrice: real("current_price").notNull(),
  peakPrice: real("peak_price").notNull(),
  profitPct: real("profit_pct").notNull(),
  exitSignal: text("exit_signal").notNull(),
  exitUrgency: text("exit_urgency"),
  reasoning: text("reasoning"),
  acted: integer("acted", { mode: "boolean" }).notNull().default(false),
});

// ─── Settings ────────────────────────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

// Setting keys used:
// "paper_trading_enabled"  -> "true" | "false"
// "auto_trade_enabled"     -> "true" | "false"
// "max_account_risk_pct"   -> "2" (percent of paper balance to risk per trade)
// "paper_balance"          -> cents string e.g. "100000"
// "kalshi_api_key"         -> key id
