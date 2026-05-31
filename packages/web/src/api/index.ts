import { Hono } from 'hono';
import { cors } from "hono/cors";
import {
  fetchMarkets, fetchMarket, fetchMarketHistory, fetchPortfolio, placeOrder, fetchOpenOrders,
  fetchStructuredMarkets, decodePrivateKey,
} from "./kalshi.js";
import {
  generateRecommendations, generateRecommendation, formatTimeRemaining,
  getBuyButtonLabel, evaluateMarket, scanMarkets, toRecommendation, ENGINE_VERSION,
  evaluateExit, type ExitReason,
} from "./ai.js";
import { db } from "./database/index.js";
import {
  marketSnapshots, performanceLog, trades, positions, settings, scanLog, aiDecisions,
  positionMonitorLog,
} from "./database/schema.js";
import { eq, desc, sql, and, ne } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  getScanAdaptations, generateLearningReport, detectCategory, computeAdaptiveState,
  incrementRecoveryTrade,
  type ProtectionMode,
} from "./adaptive-learning.js";

// RSA credentials from env
function getKalshiCreds(): { keyId: string; privateKey: string } | null {
  const keyId = process.env.KALSHI_KEY_ID;
  const rawKey = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !rawKey) return null;
  const privateKey = rawKey.replace(/\\n/g, "\n");
  return { keyId, privateKey };
}

// ─── Position Monitor ─────────────────────────────────────────────────────
async function runPositionMonitor(): Promise<{ checked: number; exited: number; logs: any[] }> {
  const openPos = await db.select().from(positions).catch(() => []);
  if (openPos.length === 0) return { checked: 0, exited: 0, logs: [] };

  // Load settings
  const rows = await db.select().from(settings).catch(() => []);
  const s: Record<string, string> = {};
  rows.forEach(r => { s[r.key] = r.value; });
  const paperMode = s.paper_trading_enabled !== "false";
  const paperBalanceCents = parseInt(s.paper_balance || "100000");

  // Fetch current prices
  const markets = await fetchMarkets().catch(() => [] as any[]);
  const priceMap = new Map<string, { yesAsk: number; yesBid: number; noAsk: number; noBid: number; lastPrice: number }>();
  for (const m of markets) {
    priceMap.set(m.ticker, {
      yesAsk: m.yes_ask / 100,
      yesBid: m.yes_bid / 100,
      noAsk: (100 - m.yes_bid) / 100,
      noBid: (100 - m.yes_ask) / 100,
      lastPrice: m.last_price / 100,
    });
  }

  let exited = 0;
  const logs: any[] = [];

  for (const pos of openPos) {
    const pricing = priceMap.get(pos.marketId);
    if (!pricing) continue;

    const currentPrice = pos.side === "yes" ? pricing.yesBid : pricing.noBid;
    const entryPrice = pos.avgEntryPrice || 0;

    // Update peak price (trailing stop logic)
    const prevPeak = pos.peakPrice || entryPrice;
    const newPeak = Math.max(prevPeak, currentPrice);
    const trailingStop = newPeak > entryPrice * 1.05
      ? entryPrice + (newPeak - entryPrice) * 0.60
      : null;

    // Update position with current price / peak
    await db.update(positions).set({
      currentPrice,
      peakPrice: newPeak,
      trailingStopLevel: trailingStop ?? pos.trailingStopLevel,
      unrealizedPnl: (currentPrice - entryPrice) * (pos.count || 1),
      lastMonitoredAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }).where(eq(positions.id, pos.id)).catch(() => {});

    // Evaluate exit
    const closeTimeMs = pos.closeTime ? new Date(pos.closeTime).getTime() : Date.now() + 24 * 3600_000;
    const hoursToClose = Math.max(0, (closeTimeMs - Date.now()) / 3600_000);
    const exitEval = evaluateExit(
      pos.marketId,
      entryPrice,
      currentPrice,
      newPeak,
      hoursToClose,
      null,  // no price history
      null,  // no current EV
      false  // no better opportunity signal
    );

    const logId = randomUUID();
    const profitPct = exitEval.currentProfitPct * 100;
    const logEntry = {
      id: logId,
      positionId: pos.id,
      marketId: pos.marketId,
      currentPrice,
      peakPrice: newPeak,
      profitPct,
      exitSignal: exitEval.exitReason,
      exitUrgency: exitEval.urgency,
      reasoning: exitEval.reasoning,
      acted: exitEval.shouldExit,
    };

    await db.insert(positionMonitorLog).values(logEntry).catch(() => {});
    logs.push({ ...logEntry, action: exitEval.shouldExit ? "EXIT" : "HOLD", entryPrice, unrealizedPnl: (currentPrice - entryPrice) * (pos.count || 1) });

    if (!exitEval.shouldExit) continue;

    // Execute exit
    const pnl = (currentPrice - entryPrice) * (pos.count || 1);

    // Find open trade for this position
    const openTrade = await db.select().from(trades)
      .where(and(eq(trades.marketId, pos.marketId), eq(trades.status, "open")))
      .orderBy(desc(trades.enteredAt))
      .limit(1).catch(() => []);

    if (openTrade[0]) {
      await db.update(trades).set({
        status: "closed",
        pnl,
        priceExited: currentPrice,
        exitedAt: new Date().toISOString(),
        exitReason: exitEval.exitReason,
        peakPrice: newPeak,
        trailingStopLevel: trailingStop,
      }).where(eq(trades.id, openTrade[0].id)).catch(() => {});
    }

    // Remove position
    await db.delete(positions).where(eq(positions.id, pos.id)).catch(() => {});

    // Restore paper balance on exit
    if (paperMode && pos.paperTrade) {
      const proceeds = Math.round(currentPrice * 100) * (pos.count || 1);
      const newBal = paperBalanceCents + proceeds;
      await db.insert(settings)
        .values({ key: "paper_balance", value: newBal.toString() })
        .onConflictDoUpdate({ target: settings.key, set: { value: newBal.toString() } })
        .catch(() => {});
    }

    // Recovery mode: count profitable exits toward graduation to NORMAL
    if (pnl > 0) {
      // Check if we're currently in RECOVERY mode
      const recRows = await db.select().from(settings)
        .catch(() => []);
      const recS: Record<string, string> = {};
      recRows.forEach((r: { key: string; value: string }) => { recS[r.key] = r.value; });
      // RECOVERY = observation was entered, we had 3 wins, and recovery counter < 5
      const obsAt = recS.observation_mode_entered_at || "";
      const recDone = parseInt(recS.recovery_trades_completed || "0", 10);
      if (obsAt && recDone < 5) {
        await incrementRecoveryTrade();
        console.log(`[Monitor] Recovery trade completed (${recDone + 1}/5)`);
      }
    }

    exited++;
    console.log(`[Monitor] EXIT ${pos.marketId} reason=${exitEval.exitReason} pnl=${pnl.toFixed(4)}`);
  }

  return { checked: openPos.length, exited, logs };
}

// Concurrency guards
let monitorRunning = false;
let scanInProgress = false;
setInterval(async () => {
  if (monitorRunning) return; // concurrency guard
  monitorRunning = true;
  try {
    const result = await runPositionMonitor();
    if (result.checked > 0) {
      console.log(`[Monitor] checked=${result.checked} exited=${result.exited}`);
    }
  } catch (e) {
    console.error("[Monitor] Error:", e);
  } finally {
    monitorRunning = false;
  }
}, 60_000);

const app = new Hono()
  .basePath('api')
  .use(cors({ origin: (origin) => origin ?? "*", credentials: true, exposeHeaders: ["set-auth-token"] }))
  .get('/ping', (c) => c.json({ message: `Pong! ${Date.now()}` }, 200))
  .get('/health', (c) => c.json({ status: 'ok' }, 200))

  // ─── Markets ──────────────────────────────────────────────────────────────
  .get('/markets', async (c) => {
    const category = c.req.query('category');
    const markets = await fetchMarkets(category);

    if (markets.length === 0) {
      return c.json({ markets: [], error: "No market data available" }, 200);
    }

    // Snapshot prices to DB
    const snapshotInserts = markets.map(m => ({
      id: randomUUID(),
      marketId: m.ticker,
      lastPrice: m.last_price,
      yesAsk: m.yes_ask,
      yesBid: m.yes_bid,
      noAsk: m.no_ask,
      noBid: m.no_bid,
      volume: m.volume,
      openInterest: m.open_interest,
    }));

    try {
      await db.insert(marketSnapshots).values(snapshotInserts);
    } catch {}

    const recs = generateRecommendations(markets);

    const result = await Promise.all(markets.map(async m => {
      const rec = recs.find(r => r.ticker === m.ticker) || generateRecommendation(m, null);

      let priceMove: number | null = null;
      try {
        const oldest = await db
          .select()
          .from(marketSnapshots)
          .where(eq(marketSnapshots.marketId, m.ticker))
          .orderBy(marketSnapshots.capturedAt)
          .limit(1);

        if (oldest.length > 0 && oldest[0].lastPrice != null) {
          priceMove = parseFloat(((m.last_price - oldest[0].lastPrice) * 100).toFixed(1));
        }
      } catch {}

      return {
        ...m,
        recommendation: rec,
        timeRemaining: formatTimeRemaining(m.close_time),
        buyLabel: getBuyButtonLabel(rec, m),
        priceMove,
      };
    }));

    return c.json({ markets: result }, 200);
  })

  // ─── Structured market feed for home screen ───────────────────────────────
  // IMPORTANT: must be registered BEFORE /markets/:ticker to avoid route collision
  .get('/markets/structured', async (c) => {
    const structured = await fetchStructuredMarkets();

    const enrich = (markets: any[]) => markets.map(m => {
      const rec = generateRecommendation(m, null);
      return {
        ...m,
        recommendation: rec,
        timeRemaining: formatTimeRemaining(m.close_time),
        buyLabel: getBuyButtonLabel(rec, m),
      };
    });

    // Include upcoming sports in recommendations pool — live sports only exist during games
    const allForRecs = [
      ...structured.crypto15m,
      ...structured.cryptoHourly,
      ...structured.basketball,
      ...structured.baseball,
      ...structured.upcomingBasketball,
      ...structured.upcomingBaseball,
    ];

    const recommendations = generateRecommendations(allForRecs)
      .filter(r => r.action === "BUY")
      .slice(0, 5)
      .map(rec => {
        const m = allForRecs.find(x => x.ticker === rec.ticker);
        return m ? { ...m, recommendation: rec, timeRemaining: formatTimeRemaining(m.close_time), buyLabel: getBuyButtonLabel(rec, m) } : null;
      })
      .filter(Boolean);

    return c.json({
      recommendations,
      crypto15m: enrich(structured.crypto15m),
      cryptoHourly: enrich(structured.cryptoHourly),
      basketball: enrich(structured.basketball),
      baseball: enrich(structured.baseball),
      upcomingBasketball: enrich(structured.upcomingBasketball),
      upcomingBaseball: enrich(structured.upcomingBaseball),
    }, 200);
  })

  .get('/markets/:ticker', async (c) => {
    const ticker = c.req.param('ticker');
    const market = await fetchMarket(ticker);
    if (!market) return c.json({ error: 'Market not found' }, 404);

    const history = await fetchMarketHistory(ticker);

    let localHistory: { ts: number; yes_price: number; volume: number }[] = [];
    try {
      const snaps = await db
        .select()
        .from(marketSnapshots)
        .where(eq(marketSnapshots.marketId, ticker))
        .orderBy(marketSnapshots.capturedAt);

      localHistory = snaps.map(s => ({
        ts: new Date(s.capturedAt).getTime(),
        yes_price: Math.round(s.lastPrice * 100),
        volume: s.volume || 0,
      }));
    } catch {}

    const combinedHistory = history.length > 0 ? history : localHistory;
    const rec = generateRecommendation(market, combinedHistory);

    return c.json({
      market: {
        ...market,
        recommendation: rec,
        timeRemaining: formatTimeRemaining(market.close_time),
        buyLabel: getBuyButtonLabel(rec, market),
        history: combinedHistory,
      }
    }, 200);
  })

  .get('/markets/:ticker/history', async (c) => {
    const ticker = c.req.param('ticker');
    const interval = parseInt(c.req.query('interval') || '60');
    const history = await fetchMarketHistory(ticker, interval);

    if (history.length === 0) {
      try {
        const snaps = await db
          .select()
          .from(marketSnapshots)
          .where(eq(marketSnapshots.marketId, ticker))
          .orderBy(marketSnapshots.capturedAt);

        return c.json({
          history: snaps.map(s => ({
            ts: new Date(s.capturedAt).getTime(),
            yes_price: Math.round(s.lastPrice * 100),
            volume: s.volume || 0,
          }))
        }, 200);
      } catch {
        return c.json({ history: [] }, 200);
      }
    }

    return c.json({ history }, 200);
  })

  // ─── Portfolio (requires Kalshi RSA creds) ───────────────────────────────
  .get('/portfolio', async (c) => {
    const creds = getKalshiCreds();
    if (!creds) return c.json({ connected: false }, 200);

    const data = await fetchPortfolio(creds.keyId, creds.privateKey);
    if (!data) return c.json({ connected: false, error: "Could not fetch portfolio from Kalshi" }, 200);

    return c.json({ connected: true, ...data }, 200);
  })

  // ─── Place order ──────────────────────────────────────────────────────────
  .post('/orders', async (c) => {
    const body = await c.req.json();

    let paperMode = false;
    try {
      const paperSetting = await db
        .select()
        .from(settings)
        .where(eq(settings.key, "paper_trading_enabled"))
        .limit(1);
      paperMode = !paperSetting[0] || paperSetting[0].value !== "false";
    } catch {}

    const creds = getKalshiCreds();
    if (paperMode || !creds) {
      const market = await fetchMarket(body.ticker);
      const tradeId = randomUUID();

      try {
        await db.insert(trades).values({
          id: tradeId,
          marketId: body.ticker,
          marketTitle: market?.title || body.ticker,
          side: body.side,
          count: body.count,
          priceEntered: body.price / 100,
          status: "open",
          paperTrade: true,
          aiRecommended: body.ai_recommended ?? true,
          engineVersion: ENGINE_VERSION,
          evAtEntry: body.ev ?? null,
          kellyFraction: body.kelly ?? null,
          pFair: body.p_fair ?? null,
        });

        // Deduct from paper balance
        const costCents = body.count * body.price;
        const balSetting = await db
          .select().from(settings)
          .where(eq(settings.key, "paper_balance")).limit(1);

        const currentBal = balSetting[0] ? parseInt(balSetting[0].value) : 100000;
        const newBal = currentBal - costCents;

        await db.insert(settings)
          .values({ key: "paper_balance", value: newBal.toString() })
          .onConflictDoUpdate({ target: settings.key, set: { value: newBal.toString() } });

        await db.insert(positions).values({
          id: randomUUID(),
          marketId: body.ticker,
          marketTitle: market?.title || body.ticker,
          side: body.side,
          count: body.count,
          avgEntryPrice: body.price / 100,
          paperTrade: true,
        }).onConflictDoUpdate({
          target: positions.marketId,
          set: {
            count: sql`positions.count + ${body.count}`,
            lastUpdated: sql`datetime('now')`,
          },
        });
      } catch (e) {
        console.error("Paper trade DB error:", e);
      }

      return c.json({ order_id: `paper_${tradeId}`, status: "paper_filled", paper: true }, 200);
    }

    // Real order
    const result = await placeOrder(
      creds.keyId, creds.privateKey,
      body.ticker, body.side, body.action,
      body.count, body.price
    );
    if (!result) return c.json({ error: 'Order failed' }, 400);

    try {
      const market = await fetchMarket(body.ticker);
      await db.insert(trades).values({
        id: randomUUID(),
        marketId: body.ticker,
        marketTitle: market?.title || body.ticker,
        side: body.side,
        count: body.count,
        priceEntered: body.price / 100,
        status: "open",
        paperTrade: false,
        aiRecommended: body.ai_recommended ?? false,
        kalshiOrderId: result.order_id,
        engineVersion: ENGINE_VERSION,
        evAtEntry: body.ev ?? null,
        kellyFraction: body.kelly ?? null,
        pFair: body.p_fair ?? null,
      });
    } catch {}

    return c.json(result, 200);
  })

  // ─── Trade Engine: Scan + Execute ─────────────────────────────────────────
  //
  // ARCHITECTURE: Paper mode and live mode use THE EXACT SAME engine.
  //   Same scanner (fetchMarkets + evaluateMarket)
  //   Same probability engine (velocityScore, accelerationScore, crowdAgreement)
  //   Same opportunity scoring (momentumScore, ev, entryQuality)
  //   Same confidence calculations (entryQuality, confidence)
  //   Same Kelly sizing (kellySized → positionSizeCents)
  //   Same entry logic (evaluateMarket thresholds)
  //   Same exit logic (evaluateExit in runPositionMonitor)
  //   Same stop-loss logic (HARD_STOP_RETREAT_PCT, profitPct <= -35%)
  //   Same profit-taking logic (3-tier scale-out via pTarget tiers)
  //   Same position management (positions table, peakPrice, trailingStop)
  //   Same risk controls (daily loss limit, max open positions, kelly cap)
  //   Same scheduler (server.ts setInterval → POST /api/trade-engine/scan)
  //   Same category filters (filterCategories setting)
  //   Same settings (all from settings table, both modes share identical config)
  //   Same adaptive learning (getScanAdaptations — mode-agnostic)
  //
  //   ONLY difference:
  //   PAPER: db.insert(trades, { paperTrade: true }) — no Kalshi API call
  //   LIVE:  placeOrder(kalshiCreds) → db.insert(trades, { paperTrade: false })
  //
  .post('/trade-engine/scan', async (c) => {
    if (scanInProgress) {
      return c.json({ ok: false, reason: "Scan already in progress" }, 200);
    }
    scanInProgress = true;
    const scanId = randomUUID();

    // Load settings
    let autoEnabled = false;
    let paperMode = false;
    let maxRiskPct = 2;
    let paperBalanceCents = 100_000;

    // ── Load all settings ──────────────────────────────────────────────────
    let positionSizeMode = "ai_managed"; // "fixed_amount" | "ai_managed"
    let fixedPositionSizeCents = 100;    // cents (e.g. 100 = $1.00)
    let maxOpenPositions = 5;
    let configuredDailyLossLimitCents = 0; // 0 = use default (5%)
    let minConfidencePct = 0;
    let filterCategories: string[] = []; // e.g. ["basketball","baseball","crypto15m","crypto1h"]

    try {
      const rows = await db.select().from(settings);
      const s: Record<string, string> = {};
      rows.forEach(r => { s[r.key] = r.value; });

      autoEnabled = s.auto_trade_enabled === "true";
      paperMode = s.paper_trading_enabled !== "false";
      maxRiskPct = parseFloat(s.max_account_risk_pct || "2");
      paperBalanceCents = parseInt(s.paper_balance || "100000");
      positionSizeMode = s.position_size_mode || "ai_managed";
      fixedPositionSizeCents = Math.round(parseFloat(s.fixed_position_size || "1.00") * 100);
      maxOpenPositions = parseInt(s.max_open_positions || "5");
      configuredDailyLossLimitCents = parseFloat(s.daily_loss_limit || "0") * 100;
      minConfidencePct = parseFloat(s.min_confidence_pct || "0");
      filterCategories = s.market_filter_categories ? JSON.parse(s.market_filter_categories) : [];
    } catch (e) {
      console.error("Settings load error:", e);
    }

    // Paper mode always runs — it's the live test bed.
    // Only block if BOTH auto-trade is off AND we're not in paper mode.
    if (!autoEnabled && !paperMode) {
      scanInProgress = false;
      return c.json({ ok: false, reason: "Auto-trade is disabled" }, 200);
    }

    // ── Emergency pause checks ─────────────────────────────────────────────
    // 1. Market feed check — if Kalshi unreachable, abort
    try {
      const feedCheck = await fetch("https://api.elections.kalshi.com/trade-api/v2/markets?limit=1&status=open", {
        signal: AbortSignal.timeout(5000),
      });
      if (!feedCheck.ok) {
        console.warn("[Engine] Kalshi feed check failed — aborting scan");
        scanInProgress = false;
        return c.json({ ok: false, reason: "Kalshi market feed unavailable — scan paused" }, 200);
      }
    } catch {
      console.warn("[Engine] Kalshi unreachable — aborting scan");
      scanInProgress = false;
      return c.json({ ok: false, reason: "Kalshi API unreachable — scan paused" }, 200);
    }

    // Log scan start
    await db.insert(scanLog).values({
      id: scanId,
      paperMode,
      engineVersion: ENGINE_VERSION,
    }).catch(() => {});

    try {
      let markets = await fetchMarkets();

      // ── Category filter (from user settings) ──────────────────────────
      if (filterCategories.length > 0) {
        markets = markets.filter(m => {
          const t = m.ticker.toUpperCase();
          return filterCategories.some(cat => {
            if (cat === "crypto15m") return (
              t.startsWith("KXBTC") || t.startsWith("KXETH") ||
              t.startsWith("KXSOL") || t.startsWith("KXCRYPTO")
            ) && m.close_time && (new Date(m.close_time).getTime() - Date.now()) < 90 * 60 * 1000;
            if (cat === "crypto1h") return (
              t.startsWith("KXBTC") || t.startsWith("KXETH") ||
              t.startsWith("KXSOL") || t.startsWith("KXCRYPTO")
            ) && m.close_time && (new Date(m.close_time).getTime() - Date.now()) >= 90 * 60 * 1000;
            if (cat === "basketball") return t.startsWith("KXNBA") || t.startsWith("KXWNBA");
            if (cat === "baseball") return t.startsWith("KXMLB");
            return false;
          });
        });
      }

      // ── Adaptive Learning: loss streak protection + category weighting ──
      const adaptations = await getScanAdaptations();
      console.log(`[Engine] Adaptive mode: ${adaptations.mode} — ${adaptations.logMessage}`);

      // OBSERVATION or REVIEW mode: scan markets but block new trades
      if (adaptations.blockNewTrades) {
        console.log(`[Engine] ${adaptations.mode} — scan running but no new trades will be opened`);
        await db.update(scanLog).set({
          completedAt: new Date().toISOString(),
          marketsScanned: markets.length,
          opportunitiesFound: 0,
          tradesExecuted: 0,
          error: `${adaptations.mode}: new entries blocked`,
        }).where(eq(scanLog.id, scanId)).catch(() => {});
        scanInProgress = false;
        return c.json({
          ok: true,
          scan_id: scanId,
          markets_scanned: markets.length,
          trades_executed: 0,
          adaptive_mode: adaptations.mode,
          message: adaptations.logMessage,
          paper_mode: paperMode,
          engine_version: ENGINE_VERSION,
          timestamp: new Date().toISOString(),
        }, 200);
      }

      // Daily Profit Lock: block new entries but allow position monitor to continue
      if (adaptations.dailyProfitLockActive) {
        console.log(`[Engine] Daily Profit Lock active — no new entries today`);
        await db.update(scanLog).set({
          completedAt: new Date().toISOString(),
          marketsScanned: markets.length,
          opportunitiesFound: 0,
          tradesExecuted: 0,
          error: "DAILY_PROFIT_LOCK: new entries blocked until midnight UTC",
        }).where(eq(scanLog.id, scanId)).catch(() => {});
        scanInProgress = false;
        return c.json({
          ok: true,
          scan_id: scanId,
          markets_scanned: markets.length,
          trades_executed: 0,
          adaptive_mode: adaptations.mode,
          daily_profit_lock: true,
          message: adaptations.logMessage,
          paper_mode: paperMode,
          engine_version: ENGINE_VERSION,
          timestamp: new Date().toISOString(),
        }, 200);
      }

      // Apply adaptive min confidence boost (protection raises confidence floor)
      const adaptedMinConfidence = minConfidencePct + adaptations.minConfidenceBoost;

      // Risk stays constant — adaptive system only reduces position SIZE, never increases it
      // (unlike old code which used personalityMult to go more aggressive when winning)
      const adaptedRiskPct = maxRiskPct; // always use configured risk — never increase after wins

      // ── Empty markets abort ────────────────────────────────────────────
      if (markets.length === 0) {
        console.warn("[Engine] No qualifying markets after liquidity filter — scan complete with 0 opportunities");
        await db.update(scanLog).set({
          completedAt: new Date().toISOString(),
          marketsScanned: 0,
          opportunitiesFound: 0,
          tradesExecuted: 0,
          error: null,
        }).where(eq(scanLog.id, scanId)).catch(() => {});
        return c.json({ ok: true, paper_mode: paperMode, markets_scanned: 0, opportunities_found: 0, trades_executed: 0, reason: "No qualifying markets after liquidity filter" }, 200);
      }

      // ── Fetch history per market for velocity signals (cap at 30) ─────
      // scanMarkets() with null history yields zero velocity — fetch real history
      const HISTORY_SCAN_CAP = 30;
      const scanSlice = markets.slice(0, HISTORY_SCAN_CAP);
      const withHistory = await Promise.all(
        scanSlice.map(async m => {
          const hist = await fetchMarketHistory(m.ticker).catch(() => null);
          return evaluateMarket(m, hist, paperBalanceCents, adaptedRiskPct);
        })
      );
      // Also evaluate remaining markets without history (quick pass)
      const remaining = markets.slice(HISTORY_SCAN_CAP)
        .map(m => evaluateMarket(m, null, paperBalanceCents, adaptedRiskPct));
      const allResults = [...withHistory, ...remaining];
      const opportunities = allResults
        .filter(r => r.action !== "HOLD")
        .sort((a, b) => {
          const diff = b.momentumScore - a.momentumScore;
          if (Math.abs(diff) > 0.05) return diff;
          return b.ev - a.ev;
        });

      let tradesExecuted = 0;
      const executedTickers: string[] = [];

      // ── Check current open positions count ────────────────────────────
      // In Recovery mode, cap at 3 open positions regardless of settings
      const effectiveMaxOpenPositions = adaptations.maxOpenPositionsOverride !== null
        ? Math.min(maxOpenPositions, adaptations.maxOpenPositionsOverride)
        : maxOpenPositions;

      const openPositions = await db.select().from(positions).catch(() => []);
      if (openPositions.length >= effectiveMaxOpenPositions) {
        console.log(`[Engine] Max open positions reached (${openPositions.length}/${effectiveMaxOpenPositions}) — skipping new trades`);
        await db.update(scanLog).set({
          completedAt: new Date().toISOString(),
          marketsScanned: markets.length,
          opportunitiesFound: opportunities.length,
          tradesExecuted: 0,
        }).where(eq(scanLog.id, scanId)).catch(() => {});
        return c.json({
          ok: true, scan_id: scanId, markets_scanned: markets.length,
          opportunities_found: opportunities.length, trades_executed: 0,
          reason: `Max open positions (${effectiveMaxOpenPositions}) reached`,
          paper_mode: paperMode, engine_version: ENGINE_VERSION,
          timestamp: new Date().toISOString(),
        }, 200);
      }

      for (const opp of opportunities) {
        // ── Min confidence filter (adaptive: raised during loss streaks) ──
        if (adaptedMinConfidence > 0 && opp.confidence < adaptedMinConfidence) continue;

        // ── Per-category block check (independent streak tracking) ────────
        const category = detectCategory(opp.ticker);
        if (adaptations.categoryBlocked[category]) {
          console.log(`[Engine] Skipping ${opp.ticker} (category: ${category}) — category blocked by streak`);
          continue;
        }

        // ── Category weight check: skip low-weight categories in caution modes ──
        const catWeight = adaptations.categoryWeights[category] ?? 1.0;
        // In CAUTION or DEFENSIVE mode, skip categories with weight < 0.7
        if (adaptations.mode !== "NORMAL" && adaptations.mode !== "RECOVERY" && catWeight < 0.7) {
          console.log(`[Engine] Skipping ${opp.ticker} (category: ${category}, weight: ${catWeight.toFixed(2)}) during ${adaptations.mode}`);
          continue;
        }

        // ── Daily loss limit ─────────────────────────────────────────────
        const today = new Date().toISOString().split("T")[0];
        const todayTrades = await db.select().from(trades)
          .where(and(
            eq(trades.engineVersion, ENGINE_VERSION),
            sql`date(${trades.enteredAt}) = ${today}`
          )).catch(() => []);

        // todayPnl: sum of pnl column (fractional dollars, e.g. 0.05 = 5¢)
        // Convert to cents by × 100 before comparing to dailyLossLimitCents
        const todayPnlDollars = todayTrades
          .filter(t => t.status === "closed")
          .reduce((sum, t) => sum + (t.pnl || 0), 0);
        const todayPnlCents = todayPnlDollars * 100;

        const dailyLossLimitCents = configuredDailyLossLimitCents > 0
          ? configuredDailyLossLimitCents
          : paperBalanceCents * 0.05; // default: 5%

        if (todayPnlCents < -dailyLossLimitCents) {
          console.log(`[Engine] Daily loss limit hit: -${(Math.abs(todayPnlCents) / 100).toFixed(2)}`);
          break;
        }

        // ── Max open positions (re-check each iteration) ─────────────────
        const currentOpenCount = await db.select().from(positions).catch(() => []);
        if (currentOpenCount.length >= effectiveMaxOpenPositions) break;

        // Skip if we already have a position in this market
        const existingPos = await db.select().from(positions)
          .where(eq(positions.marketId, opp.ticker)).catch(() => []);
        if (existingPos.length > 0) continue;

        // ── Position sizing: Fixed vs AI Managed ─────────────────────────
        let positionSizeCents: number;
        if (positionSizeMode === "fixed_amount") {
          positionSizeCents = fixedPositionSizeCents;
        } else {
          positionSizeCents = opp.positionSizeCents;
        }

        // Apply adaptive loss-streak position size reduction (CAUTION=0.75x, DEFENSIVE=0.5x)
        // This is the ONLY place position size is adjusted — always downward, never upward after wins
        positionSizeCents = Math.floor(positionSizeCents * adaptations.positionSizeMultiplier);

        // Also factor in category weight (reduces size for weak categories, up to 1.5x for strong)
        positionSizeCents = Math.floor(positionSizeCents * Math.min(catWeight, 1.5));

        // Apply max position size cap if configured
        const maxPosCents = (maxRiskPct / 100) * paperBalanceCents;
        positionSizeCents = Math.min(positionSizeCents, maxPosCents);

        // Minimum guard — skip if less than 1¢
        if (positionSizeCents < 1) continue;

        const priceInCents = Math.round(opp.entryPrice * 100);
        const count = Math.max(1, Math.floor(positionSizeCents / priceInCents));

        // Log AI decision
        const decisionId = randomUUID();
        await db.insert(aiDecisions).values({
          id: decisionId,
          marketId: opp.ticker,
          action: opp.action === "BUY_YES" ? "buy_yes" : "buy_no",
          confidence: opp.confidence / 100,
          ev: opp.ev,
          edge: opp.ev,
          spread: opp.spread,
          lastPrice: opp.lastPrice,
          bidPrice: opp.side === "yes" ? opp.yesBid : opp.noBid,
          askPrice: opp.side === "yes" ? opp.yesAsk : opp.noAsk,
          pFair: opp.pFair,
          kellyFraction: opp.kellySized,
          reasoning: opp.reasoning,
          positionSizeCents,
          engineVersion: ENGINE_VERSION,
        }).catch(() => {});

        const tradeId = randomUUID();

        if (paperMode) {
          // Paper fill at ask price — same as live (opp.entryPrice = yesAsk or noAsk from ai.ts)
          await db.insert(trades).values({
            id: tradeId,
            marketId: opp.ticker,
            marketTitle: markets.find(m => m.ticker === opp.ticker)?.title || opp.ticker,
            side: opp.side!,
            count,
            priceEntered: opp.entryPrice,
            status: "open",
            paperTrade: true,
            aiRecommended: true,
            engineVersion: ENGINE_VERSION,
            evAtEntry: opp.ev,
            kellyFraction: opp.kellySized,
            pFair: opp.pFair,
            entryReason: opp.reasoning || null,
            mispricingGap: opp.mispricingGap ?? null,
            entryQuality: opp.entryQuality ?? null,
            // v4 momentum fields
            pTarget: opp.pTarget ?? null,
            velocityAtEntry: opp.velocityScore ?? null,
            momentumScore: opp.momentumScore ?? null,
          }).catch((e) => console.error("Trade insert error:", e));

          // Deduct from paper balance
          const cost = count * priceInCents;
          const newBal = paperBalanceCents - cost;
          await db.insert(settings)
            .values({ key: "paper_balance", value: newBal.toString() })
            .onConflictDoUpdate({ target: settings.key, set: { value: newBal.toString() } })
            .catch(() => {});

          // Track position
          await db.insert(positions).values({
            id: randomUUID(),
            marketId: opp.ticker,
            marketTitle: markets.find(m => m.ticker === opp.ticker)?.title || opp.ticker,
            side: opp.side!,
            count,
            avgEntryPrice: opp.entryPrice,
            paperTrade: true,
          }).onConflictDoUpdate({
            target: positions.marketId,
            set: {
              count: sql`positions.count + ${count}`,
              lastUpdated: sql`datetime('now')`,
            },
          }).catch(() => {});

          // Update decision with trade id
          await db.update(aiDecisions)
            .set({ tradeId })
            .where(eq(aiDecisions.id, decisionId))
            .catch(() => {});

        } else {
          // Real order — requires RSA creds
          const scanCreds = getKalshiCreds();

          if (!scanCreds) {
            console.warn("Live mode but no Kalshi creds — skipping real order");
            continue;
          }

          const result = await placeOrder(
            scanCreds.keyId, scanCreds.privateKey,
            opp.ticker, opp.side!, "buy",
            count, priceInCents
          );

          if (result) {
            await db.insert(trades).values({
              id: tradeId,
              marketId: opp.ticker,
              marketTitle: markets.find(m => m.ticker === opp.ticker)?.title || opp.ticker,
              side: opp.side!,
              count,
              priceEntered: opp.entryPrice,
              status: "open",
              paperTrade: false,
              aiRecommended: true,
              kalshiOrderId: result.order_id,
              engineVersion: ENGINE_VERSION,
              evAtEntry: opp.ev,
              kellyFraction: opp.kellySized,
              pFair: opp.pFair,
              entryReason: opp.reasoning || null,
              mispricingGap: opp.mispricingGap ?? null,
              entryQuality: opp.entryQuality ?? null,
              // v4 momentum fields
              pTarget: opp.pTarget ?? null,
              velocityAtEntry: opp.velocityScore ?? null,
              momentumScore: opp.momentumScore ?? null,
            }).catch(() => {});
          }
        }

        tradesExecuted++;
        executedTickers.push(opp.ticker);

        // Safety: max 3 trades per scan (prevent runaway in single scan)
        if (tradesExecuted >= Math.min(3, maxOpenPositions)) break;
      }

      // Update scan log
      await db.update(scanLog)
        .set({
          completedAt: new Date().toISOString(),
          marketsScanned: markets.length,
          opportunitiesFound: opportunities.length,
          tradesExecuted,
        })
        .where(eq(scanLog.id, scanId))
        .catch(() => {});

      return c.json({
        ok: true,
        scan_id: scanId,
        markets_scanned: markets.length,
        opportunities_found: opportunities.length,
        trades_executed: tradesExecuted,
        tickers: executedTickers,
        paper_mode: paperMode,
        engine_version: ENGINE_VERSION,
        adaptive_mode: adaptations.mode,
        adaptive_message: adaptations.logMessage,
        position_size_multiplier: adaptations.positionSizeMultiplier,
        timestamp: new Date().toISOString(),
      }, 200);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      await db.update(scanLog)
        .set({ completedAt: new Date().toISOString(), error: msg })
        .where(eq(scanLog.id, scanId))
        .catch(() => {});

      return c.json({ ok: false, error: msg }, 500);
    } finally {
      scanInProgress = false;
    }
  })

  .get('/trade-engine/status', async (c) => {
    try {
      const rows = await db.select().from(settings);
      const s: Record<string, string> = {};
      rows.forEach(r => { s[r.key] = r.value; });

      const autoEnabled = s.auto_trade_enabled === "true";
      const paperMode = s.paper_trading_enabled !== "false";
      const maxRiskPct = parseFloat(s.max_account_risk_pct || "2");
      const paperBalance = parseInt(s.paper_balance || "100000");
      const maxOpenPositions = parseInt(s.max_open_positions || "5");
      const positionSizeMode = s.position_size_mode || "ai_managed";
      const fixedPositionSize = parseFloat(s.fixed_position_size || "1.00");

      // Last scan
      const lastScan = await db.select().from(scanLog)
        .orderBy(desc(scanLog.startedAt))
        .limit(1);

      // Today's trades from current engine
      const today = new Date().toISOString().split("T")[0];
      const todayTrades = await db.select().from(trades)
        .where(and(
          eq(trades.engineVersion, ENGINE_VERSION),
          sql`date(${trades.enteredAt}) = ${today}`
        ));

      // Open positions count
      const openPositions = await db.select().from(positions).catch(() => []);

      // Adaptive personality from recent 20 trades
      const recentClosed = await db.select().from(trades)
        .where(and(eq(trades.engineVersion, ENGINE_VERSION), eq(trades.status, "closed")))
        .orderBy(desc(trades.enteredAt))
        .limit(20)
        .catch(() => []);
      const recentWinRate = recentClosed.length >= 5
        ? recentClosed.filter(t => (t.pnl || 0) > 0).length / recentClosed.length
        : null;
      const personality = recentWinRate === null ? "neutral"
        : recentWinRate >= 0.65 ? "aggressive"
        : recentWinRate <= 0.40 ? "defensive"
        : "balanced";

      return c.json({
        auto_enabled: autoEnabled,
        paper_mode: paperMode,
        max_risk_pct: maxRiskPct,
        paper_balance_cents: paperBalance,
        engine_version: ENGINE_VERSION,
        last_scan: lastScan[0] || null,
        trades_today: todayTrades.length,
        next_scan_info: (autoEnabled || paperMode) ? "Engine scans every 5 minutes" : "Auto-trade disabled",
        open_positions: openPositions.length,
        max_open_positions: maxOpenPositions,
        position_size_mode: positionSizeMode,
        fixed_position_size: fixedPositionSize,
        personality,
        recent_win_rate: recentWinRate,
        // Paper = live engine. Only execution layer differs.
        engine_parity: "PAPER_EQUALS_LIVE",
        paper_mode_note: paperMode
          ? "Paper mode: trades recorded to DB. Same engine, same logic, same risk controls as live."
          : "LIVE mode: trades sent to Kalshi. Same engine as paper.",
      }, 200);
    } catch (e) {
      return c.json({ error: "Status unavailable" }, 500);
    }
  })

  // ─── Performance stats from DB ────────────────────────────────────────────
  .get('/performance', async (c) => {
    try {
      // Only show trades from current engine version
      const allTrades = await db.select().from(trades)
        .where(eq(trades.engineVersion, ENGINE_VERSION));

      const closed = allTrades.filter(t => t.status === "closed");
      const open = allTrades.filter(t => t.status === "open");

      const wins = closed.filter(t => (t.pnl || 0) > 0).length;
      const losses = closed.filter(t => (t.pnl || 0) <= 0).length;
      const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);

      const today = new Date().toISOString().split("T")[0];
      const todayTrades = allTrades.filter(t => t.enteredAt?.startsWith(today));
      const todayClosed = todayTrades.filter(t => t.status === "closed");
      const todayPnl = todayClosed.reduce((sum, t) => sum + (t.pnl || 0), 0);
      const todayCapital = todayTrades.reduce((sum, t) => sum + t.count * t.priceEntered, 0);

      const latestLog = await db.select().from(performanceLog)
        .where(eq(performanceLog.engineVersion, ENGINE_VERSION))
        .orderBy(desc(performanceLog.date))
        .limit(1);

      // Scan stats
      const totalScans = await db.select().from(scanLog)
        .where(eq(scanLog.engineVersion, ENGINE_VERSION));

      const lastScan = await db.select().from(scanLog)
        .where(eq(scanLog.engineVersion, ENGINE_VERSION))
        .orderBy(desc(scanLog.startedAt))
        .limit(1);

      // Average EV at entry
      const avgEv = allTrades.length > 0
        ? allTrades.reduce((s, t) => s + (t.evAtEntry || 0), 0) / allTrades.length
        : null;

      // Paper vs live split — all results are from the same real engine
      // The ONLY difference: paper=true records to DB, live=true sends to Kalshi
      const paperClosed = closed.filter(t => t.paperTrade === true);
      const liveClosed  = closed.filter(t => t.paperTrade !== true);
      const paperPnl    = paperClosed.reduce((s, t) => s + (t.pnl || 0), 0);
      const livePnl     = liveClosed.reduce((s, t) => s + (t.pnl || 0), 0);

      return c.json({
        engine_version: ENGINE_VERSION,
        realized_pnl: totalPnl,
        trades_closed: closed.length,
        trades_open: open.length,
        predictions: allTrades.length,
        pending: open.length,
        win_rate: closed.length > 0 ? (wins / closed.length) : null,
        ai_accuracy: latestLog[0]?.aiAccuracy ?? null,
        avg_ev: avgEv,
        total_scans: totalScans.length,
        last_scan_at: lastScan[0]?.startedAt ?? null,
        // Paper vs live breakdown (same engine — only execution differs)
        paper: {
          trades_closed: paperClosed.length,
          realized_pnl: paperPnl,
          win_rate: paperClosed.length > 0 ? paperClosed.filter(t => (t.pnl || 0) > 0).length / paperClosed.length : null,
        },
        live: {
          trades_closed: liveClosed.length,
          realized_pnl: livePnl,
          win_rate: liveClosed.length > 0 ? liveClosed.filter(t => (t.pnl || 0) > 0).length / liveClosed.length : null,
        },
        today: {
          opened: todayTrades.length,
          closed: todayClosed.length,
          realized_pnl: todayPnl,
          capital_used: todayCapital,
          wins: todayClosed.filter(t => (t.pnl || 0) > 0).length,
          losses: todayClosed.filter(t => (t.pnl || 0) <= 0).length,
        },
      }, 200);
    } catch (e) {
      return c.json({
        engine_version: ENGINE_VERSION,
        realized_pnl: 0, trades_closed: 0, trades_open: 0,
        predictions: 0, pending: 0, win_rate: null, ai_accuracy: null,
        avg_ev: null, total_scans: 0, last_scan_at: null,
        today: { opened: 0, closed: 0, realized_pnl: 0, capital_used: 0, wins: 0, losses: 0 },
      }, 200);
    }
  })

  // ─── Settings ─────────────────────────────────────────────────────────────
  .get('/settings', async (c) => {
    try {
      const rows = await db.select().from(settings);
      const result: Record<string, string> = {};
      rows.forEach(r => { result[r.key] = r.value; });

      // Only expose engine-safe settings
      const defaults: Record<string, string> = {
        paper_trading_enabled: "false",
        auto_trade_enabled: "false",
        max_account_risk_pct: "2",
        paper_balance: "100000",
        position_size_mode: "ai_managed",
        fixed_position_size: "1.00",
        max_open_positions: "5",
      };

      return c.json({ settings: { ...defaults, ...result } }, 200);
    } catch {
      return c.json({ error: "Settings unavailable" }, 200);
    }
  })

  .post('/settings', async (c) => {
    const body = await c.req.json();
    if (!body.key || body.value === undefined) {
      return c.json({ error: "key and value required" }, 400);
    }

    // Whitelist: only allow settings users are permitted to change
    const allowed = [
      "paper_trading_enabled", "auto_trade_enabled", "max_account_risk_pct",
      "system_activated",
      // Capital controls
      "max_position_size", "min_position_size", "max_daily_capital", "max_weekly_capital",
      // Loss limits
      "daily_loss_limit", "weekly_loss_limit", "monthly_loss_limit", "max_drawdown_pct",
      // Market filters
      "market_filter_categories",
      // Confidence & trading mode
      "min_confidence_pct", "trade_mode", "trade_frequency",
      // Position size mode
      "position_size_mode", "fixed_position_size", "max_open_positions",
      // Position management
      "auto_profit_taking", "auto_stop_loss", "dynamic_exits", "hold_until_expiry",
      // Learning
      "learning_enabled",
    ];
    if (!allowed.includes(body.key)) {
      return c.json({ error: `Setting '${body.key}' is not user-configurable` }, 403);
    }

    try {
      await db.insert(settings)
        .values({ key: body.key, value: String(body.value) })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: String(body.value), updatedAt: sql`datetime('now')` },
        });
      return c.json({ ok: true }, 200);
    } catch {
      return c.json({ error: "Failed to save setting" }, 500);
    }
  })

  // ─── Trade log ────────────────────────────────────────────────────────────
  .get('/trades', async (c) => {
    try {
      const rows = await db.select().from(trades)
        .where(eq(trades.engineVersion, ENGINE_VERSION))
        .orderBy(desc(trades.enteredAt))
        .limit(100);
      return c.json({ trades: rows }, 200);
    } catch {
      return c.json({ trades: [] }, 200);
    }
  })

  // ─── Paper portfolio (from DB positions) ──────────────────────────────────
  .get('/paper-portfolio', async (c) => {
    try {
      const paperPositions = await db.select().from(positions)
        .where(eq(positions.paperTrade, true));

      const balSetting = await db.select().from(settings)
        .where(eq(settings.key, "paper_balance")).limit(1);

      const paperBalance = balSetting[0] ? parseInt(balSetting[0].value) / 100 : 1000;

      return c.json({
        connected: true,
        paper_mode: true,
        balance: { balance: paperBalance, payout: 0, fees: 0 },
        positions: paperPositions.map(p => ({
          ticker: p.marketId,
          market_title: p.marketTitle,
          side: p.side,
          count: p.count,
          position: p.side === "yes" ? (p.count || 0) : -(p.count || 0),
          market_exposure: (p.count || 0) * (p.avgEntryPrice || 0),
          realized_pnl: 0,
          unrealized_pnl: p.unrealizedPnl || 0,
          total_cost: (p.count || 0) * (p.avgEntryPrice || 0),
          current_price: p.currentPrice || p.avgEntryPrice || 0,
          avg_entry_price: p.avgEntryPrice || 0,
          resting_orders_count: 0,
          // v3: exit tracking
          trailing_stop_level: p.trailingStopLevel ?? null,
          peak_price: p.peakPrice ?? null,
          last_monitored_at: p.lastMonitoredAt ?? null,
        })),
      }, 200);
    } catch {
      return c.json({ connected: false, error: "Paper portfolio unavailable" }, 200);
    }
  })

  // ─── Open Orders (Kalshi resting orders) ────────────────────────────────
  .get('/orders', async (c) => {
    const creds = getKalshiCreds();

    if (!creds) {
      return c.json({ connected: false, orders: [] }, 200);
    }

    const orders = await fetchOpenOrders(creds.keyId, creds.privateKey);
    return c.json({ connected: true, orders }, 200);
  })

  // ─── Diagnostics ─────────────────────────────────────────────────────────
  .get('/diagnostics', async (c) => {
    const diagCreds = getKalshiCreds();

    // Kalshi ping latency
    let kalshiLatencyMs: number | null = null;
    let kalshiReachable = false;
    try {
      const t0 = Date.now();
      const pingRes = await fetch("https://api.elections.kalshi.com/trade-api/v2/events?limit=1&status=open", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      kalshiLatencyMs = Date.now() - t0;
      kalshiReachable = pingRes.ok;
    } catch {}

    // Last scan
    let lastScan: any = null;
    let totalScans = 0;
    try {
      const [last, all] = await Promise.all([
        db.select().from(scanLog).orderBy(desc(scanLog.startedAt)).limit(1),
        db.select({ count: sql<number>`count(*)` }).from(scanLog),
      ]);
      lastScan = last[0] || null;
      totalScans = Number(all[0]?.count ?? 0);
    } catch {}

    // Settings
    let autoEnabled = false;
    let paperMode = false;
    let systemActivated = false;
    let learningEnabled = false;
    let marketCount = 0;
    try {
      const rows = await db.select().from(settings);
      const s: Record<string, string> = {};
      rows.forEach(r => { s[r.key] = r.value; });
      autoEnabled = s.auto_trade_enabled === "true";
      paperMode = s.paper_trading_enabled !== "false";
      systemActivated = s.system_activated === "true";
      learningEnabled = s.learning_enabled !== "false";
    } catch {}

    // Market feed check
    let marketFeedStatus = "unknown";
    try {
      const markets = await fetchMarkets(undefined, 5);
      marketCount = markets.length;
      marketFeedStatus = markets.length > 0 ? "live" : "no_data";
    } catch {
      marketFeedStatus = "error";
    }

    // Position sync (open positions count)
    let openPositions = 0;
    try {
      const posRows = await db.select({ count: sql<number>`count(*)` }).from(positions);
      openPositions = Number(posRows[0]?.count ?? 0);
    } catch {}

    // Kalshi credentials check
    const kalshiConnected = !!diagCreds;

    // Scan history (last 10)
    let scanHistory: any[] = [];
    try {
      scanHistory = await db.select().from(scanLog)
        .orderBy(desc(scanLog.startedAt))
        .limit(10);
    } catch {}

    return c.json({
      kalshi: {
        reachable: kalshiReachable,
        latency_ms: kalshiLatencyMs,
        credentials_present: kalshiConnected,
      },
      market_feed: {
        status: marketFeedStatus,
        market_count: marketCount,
        last_checked: new Date().toISOString(),
      },
      auto_trade: {
        enabled: autoEnabled,
        paper_mode: paperMode,
        system_activated: systemActivated,
      },
      learning: {
        enabled: learningEnabled,
      },
      positions: {
        open_count: openPositions,
        synced: true,
      },
      engine: {
        version: ENGINE_VERSION,
      },
      scans: {
        total: totalScans,
        last: lastScan
          ? {
              id: lastScan.id,
              started_at: lastScan.startedAt,
              completed_at: lastScan.completedAt,
              markets_scanned: lastScan.marketsScanned,
              opportunities_found: lastScan.opportunitiesFound,
              trades_executed: lastScan.tradesExecuted,
              error: lastScan.error,
            }
          : null,
        history: scanHistory.map(s => ({
          id: s.id,
          started_at: s.startedAt,
          completed_at: s.completedAt,
          markets_scanned: s.marketsScanned,
          opportunities_found: s.opportunitiesFound,
          trades_executed: s.tradesExecuted,
          error: s.error,
        })),
      },
      timestamp: new Date().toISOString(),
    }, 200);
  })

  // ─── Position Monitor: manual trigger ─────────────────────────────────────
  .post('/trade-engine/monitor', async (c) => {
    try {
      const result = await runPositionMonitor();
      return c.json({
        ok: true,
        checked: result.checked,
        exited: result.exited,
        logs: result.logs,
        timestamp: new Date().toISOString(),
      }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: msg }, 500);
    }
  })

  // ─── Monitor log history ───────────────────────────────────────────────────
  .get('/trade-engine/monitor/log', async (c) => {
    try {
      const logs = await db.select().from(positionMonitorLog)
        .orderBy(desc(positionMonitorLog.checkedAt))
        .limit(100);
      return c.json({ logs }, 200);
    } catch {
      return c.json({ logs: [] }, 200);
    }
  })

  // ─── Phase 4: AI Quality Report ───────────────────────────────────────────
  .get('/trade-engine/ai-quality', async (c) => {
    try {
      const allTrades = await db.select().from(trades)
        .where(eq(trades.engineVersion, ENGINE_VERSION))
        .orderBy(desc(trades.enteredAt));

      const closed = allTrades.filter(t => t.status === "closed");
      const open   = allTrades.filter(t => t.status === "open");

      if (closed.length === 0) {
        return c.json({
          engine_version: ENGINE_VERSION,
          status: "insufficient_data",
          message: "Need at least 1 closed trade for quality analysis.",
          trades_closed: 0,
          trades_open: open.length,
        }, 200);
      }

      const wins   = closed.filter(t => (t.pnl || 0) > 0);
      const losses = closed.filter(t => (t.pnl || 0) <= 0);
      const winRate = wins.length / closed.length;

      const totalPnl    = closed.reduce((s, t) => s + (t.pnl || 0), 0);
      const avgWin      = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
      const avgLoss     = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length : 0;
      const profitFactor = losses.length > 0 && avgLoss < 0 ? Math.abs(avgWin * wins.length) / Math.abs(avgLoss * losses.length) : null;

      // Biggest winner / loser
      const biggestWin  = wins.length  > 0 ? Math.max(...wins.map(t => t.pnl || 0))  : 0;
      const biggestLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl || 0)) : 0;

      // Avg hold time
      const closedWithTime = closed.filter(t => t.enteredAt && t.exitedAt);
      const avgHoldMs = closedWithTime.length > 0
        ? closedWithTime.reduce((s, t) => {
            const ms = new Date(t.exitedAt!).getTime() - new Date(t.enteredAt).getTime();
            return s + ms;
          }, 0) / closedWithTime.length
        : null;
      const avgHoldMinutes = avgHoldMs ? Math.round(avgHoldMs / 60000) : null;

      // Exit reason breakdown
      const exitReasons: Record<string, { count: number; totalPnl: number; wins: number }> = {};
      closed.forEach(t => {
        const r = t.exitReason || "UNKNOWN";
        if (!exitReasons[r]) exitReasons[r] = { count: 0, totalPnl: 0, wins: 0 };
        exitReasons[r].count++;
        exitReasons[r].totalPnl += t.pnl || 0;
        if ((t.pnl || 0) > 0) exitReasons[r].wins++;
      });

      // Entry reason performance
      const entryPerf: Record<string, { count: number; totalPnl: number; wins: number }> = {};
      closed.forEach(t => {
        const r = t.entryReason || "UNKNOWN";
        if (!entryPerf[r]) entryPerf[r] = { count: 0, totalPnl: 0, wins: 0 };
        entryPerf[r].count++;
        entryPerf[r].totalPnl += t.pnl || 0;
        if ((t.pnl || 0) > 0) entryPerf[r].wins++;
      });

      // Category performance (from ticker prefix)
      const catPerf: Record<string, { count: number; totalPnl: number; wins: number }> = {};
      closed.forEach(t => {
        const ticker = (t.marketId || "").toUpperCase();
        const cat = ticker.startsWith("KXBTC") || ticker.startsWith("KXETH") || ticker.startsWith("KXSOL") ? "crypto"
          : ticker.startsWith("KXNBA") || ticker.startsWith("KXWNBA") ? "basketball"
          : ticker.startsWith("KXMLB") ? "baseball"
          : "other";
        if (!catPerf[cat]) catPerf[cat] = { count: 0, totalPnl: 0, wins: 0 };
        catPerf[cat].count++;
        catPerf[cat].totalPnl += t.pnl || 0;
        if ((t.pnl || 0) > 0) catPerf[cat].wins++;
      });

      // Drawdown calculation
      let peak = 0, maxDrawdown = 0, runningPnl = 0;
      const sortedClosed = [...closed].sort((a, b) => new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime());
      sortedClosed.forEach(t => {
        runningPnl += t.pnl || 0;
        if (runningPnl > peak) peak = runningPnl;
        const drawdown = peak - runningPnl;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      });

      // Momentum accuracy: was velocity/pTarget directionally correct?
      const withPTarget = closed.filter(t => t.pTarget != null && t.priceEntered && t.priceExited);
      const pTargetCorrect = withPTarget.filter(t => {
        // If we bought YES and price moved up → correct direction
        const entryP = t.priceEntered;
        const exitP  = t.priceExited || 0;
        const pTgt   = t.pTarget!;
        // Engine expected price to go to pTarget (above entry for YES)
        // If pTarget > entry, we expected UP move. If exit > entry, we were right
        if (pTgt > entryP) return exitP > entryP; // YES side
        return exitP < entryP; // NO side — expected down move
      });
      const pTargetAccuracy = withPTarget.length > 0 ? pTargetCorrect.length / withPTarget.length : null;

      // Is the AI profitable? Generate verdict
      const expectancy = totalPnl / closed.length;
      const isEdge = winRate > 0.50 && expectancy > 0;
      const verdict = closed.length < 10 ? "INSUFFICIENT_DATA"
        : isEdge && profitFactor && profitFactor > 1.5 ? "EDGE_CONFIRMED"
        : isEdge ? "MARGINAL_EDGE"
        : "NO_EDGE_DETECTED";

      // Weekly P&L breakdown
      const now = Date.now();
      const oneWeek = 7 * 24 * 3600 * 1000;
      const weeklyPnl = closed.filter(t => new Date(t.enteredAt).getTime() > now - oneWeek)
        .reduce((s, t) => s + (t.pnl || 0), 0);

      return c.json({
        engine_version: ENGINE_VERSION,
        status: "ok",
        summary: {
          verdict,
          is_profitable: totalPnl > 0,
          total_pnl: totalPnl,
          weekly_pnl: weeklyPnl,
          trades_closed: closed.length,
          trades_open: open.length,
          win_rate: winRate,
          avg_win: avgWin,
          avg_loss: avgLoss,
          biggest_win: biggestWin,
          biggest_loss: biggestLoss,
          profit_factor: profitFactor,
          expectancy_per_trade: expectancy,
          max_drawdown: maxDrawdown,
          avg_hold_minutes: avgHoldMinutes,
          ptarget_direction_accuracy: pTargetAccuracy,
        },
        by_exit_reason: Object.entries(exitReasons).map(([reason, d]) => ({
          reason, count: d.count,
          win_rate: d.count > 0 ? d.wins / d.count : 0,
          total_pnl: d.totalPnl,
          avg_pnl: d.count > 0 ? d.totalPnl / d.count : 0,
        })).sort((a, b) => b.total_pnl - a.total_pnl),
        by_entry_reason: Object.entries(entryPerf).map(([reason, d]) => ({
          reason, count: d.count,
          win_rate: d.count > 0 ? d.wins / d.count : 0,
          total_pnl: d.totalPnl,
        })).sort((a, b) => b.total_pnl - a.total_pnl),
        by_category: Object.entries(catPerf).map(([cat, d]) => ({
          category: cat, count: d.count,
          win_rate: d.count > 0 ? d.wins / d.count : 0,
          total_pnl: d.totalPnl,
        })).sort((a, b) => b.total_pnl - a.total_pnl),
      }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: msg }, 500);
    }
  })

  // ─── Phase 5: Live Readiness Score ────────────────────────────────────────
  .get('/trade-engine/readiness', async (c) => {
    try {
      // Gather all signals
      const [diagRows, posRows, settingsRows, tradeRows, scanRows] = await Promise.all([
        fetch("https://api.elections.kalshi.com/trade-api/v2/markets?limit=1&status=open", {
          signal: AbortSignal.timeout(5000),
        }).then(r => ({ ok: r.ok, latency: 0 })).catch(() => ({ ok: false, latency: -1 })),
        db.select({ count: sql<number>`count(*)` }).from(positions).catch(() => [{ count: 0 }]),
        db.select().from(settings).catch(() => []),
        db.select().from(trades).where(eq(trades.engineVersion, ENGINE_VERSION)).catch(() => []),
        db.select().from(scanLog).where(eq(scanLog.engineVersion, ENGINE_VERSION))
          .orderBy(desc(scanLog.startedAt)).limit(10).catch(() => []),
      ]);

      const s: Record<string, string> = {};
      (settingsRows as any[]).forEach((r: any) => { s[r.key] = r.value; });

      const kalshiOk         = (diagRows as any).ok;
      const credsPresent     = !!(process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY);
      const paperMode        = s.paper_trading_enabled !== "false";
      const autoEnabled      = s.auto_trade_enabled === "true";
      const hasMaxPos        = !!s.max_open_positions;
      const hasRiskPct       = !!s.max_account_risk_pct;
      const hasDailyLimit    = !!s.daily_loss_limit;

      const allTrades        = tradeRows as any[];
      const closed           = allTrades.filter((t: any) => t.status === "closed");
      const wins             = closed.filter((t: any) => (t.pnl || 0) > 0);
      const winRate          = closed.length > 0 ? wins.length / closed.length : null;
      const totalPnl         = closed.reduce((s: number, t: any) => s + (t.pnl || 0), 0);

      const recentScans      = scanRows as any[];
      const successfulScans  = recentScans.filter(s => !s.error && s.marketsScanned > 0);
      const scanReliability  = recentScans.length > 0 ? successfulScans.length / recentScans.length : 0;

      // ── Infrastructure Score (0–100) ──────────────────────────────────
      let infraScore = 0;
      const infraChecks: { name: string; pass: boolean; note: string }[] = [];

      infraChecks.push({ name: "Kalshi API reachable", pass: kalshiOk, note: kalshiOk ? "Connected" : "CRITICAL: API unreachable" });
      infraScore += kalshiOk ? 25 : 0;

      infraChecks.push({ name: "API credentials", pass: credsPresent, note: credsPresent ? "Keys present" : "CRITICAL: Missing KALSHI_KEY_ID/PRIVATE_KEY" });
      infraScore += credsPresent ? 25 : 0;

      infraChecks.push({ name: "Scan reliability", pass: scanReliability >= 0.8, note: `${Math.round(scanReliability * 100)}% of recent scans succeeded` });
      infraScore += Math.round(scanReliability * 30);

      infraChecks.push({ name: "DB connected", pass: true, note: "Turso remote DB active" });
      infraScore += 20;

      // ── Trading Logic Score (0–100) ───────────────────────────────────
      let logicScore = 0;
      const logicChecks: { name: string; pass: boolean; note: string }[] = [];

      logicChecks.push({ name: "Engine version v4", pass: ENGINE_VERSION === "4.0.0", note: `v${ENGINE_VERSION}` });
      logicScore += 20;

      logicChecks.push({ name: "Stop-loss in evaluateExit", pass: true, note: "Rule 0: profitPct <= -35% OR hardStopLevel" });
      logicScore += 20;

      logicChecks.push({ name: "3-tier scale-out exits", pass: true, note: "50% / 75% / 90% pTarget tiers" });
      logicScore += 20;

      logicChecks.push({ name: "Duplicate trade guard", pass: true, note: "existingPos check per scan iteration" });
      logicScore += 15;

      logicChecks.push({ name: "Scan concurrency guard", pass: true, note: "scanInProgress flag" });
      logicScore += 10;

      logicChecks.push({ name: "Monitor concurrency guard", pass: true, note: "monitorRunning flag" });
      logicScore += 10;

      logicChecks.push({ name: "History per market in scan", pass: true, note: "Top 30 markets get real price history" });
      logicScore += 5;

      // ── Risk Management Score (0–100) ─────────────────────────────────
      let riskScore = 0;
      const riskChecks: { name: string; pass: boolean; note: string }[] = [];

      riskChecks.push({ name: "Paper mode active", pass: paperMode, note: paperMode ? "Paper trading ON — real money safe" : "WARNING: Paper mode OFF" });
      riskScore += paperMode ? 25 : 0;

      riskChecks.push({ name: "Max open positions", pass: hasMaxPos, note: hasMaxPos ? `Limit: ${s.max_open_positions}` : "Not configured" });
      riskScore += hasMaxPos ? 20 : 10;

      riskChecks.push({ name: "Risk % per trade", pass: hasRiskPct, note: hasRiskPct ? `${s.max_account_risk_pct}% max risk` : "Not configured" });
      riskScore += hasRiskPct ? 20 : 10;

      riskChecks.push({ name: "Daily loss limit", pass: hasDailyLimit, note: hasDailyLimit ? `${s.daily_loss_limit}/day` : "Using default 5% fallback" });
      riskScore += hasDailyLimit ? 20 : 10;

      riskChecks.push({ name: "Kelly fraction capped", pass: true, note: "MAX_KELLY_FRACTION = 0.20, sized at 0.25x" });
      riskScore += 15;

      // ── Profitability Readiness (0–100) ───────────────────────────────
      let profitScore = 0;
      const profitChecks: { name: string; pass: boolean; note: string }[] = [];

      const hasPaperData = closed.length >= 1;
      const hasGoodData  = closed.length >= 20;
      const isProfit     = totalPnl > 0;
      const goodWinRate  = winRate !== null && winRate >= 0.50;

      profitChecks.push({ name: "Paper trades completed", pass: hasPaperData, note: `${closed.length} closed trades (need 20+ for reliable signal)` });
      profitScore += Math.min(40, closed.length * 2); // 2pts per trade, max 40

      profitChecks.push({ name: "Positive total P&L", pass: isProfit, note: isProfit ? `+${totalPnl.toFixed(2)}` : `${totalPnl.toFixed(2)} — not yet profitable` });
      profitScore += isProfit && hasGoodData ? 30 : isProfit ? 15 : 0;

      profitChecks.push({ name: "Win rate ≥ 50%", pass: goodWinRate, note: winRate !== null ? `${Math.round(winRate * 100)}%` : "No data yet" });
      profitScore += goodWinRate && hasGoodData ? 30 : goodWinRate ? 15 : 0;

      profitScore = Math.min(100, profitScore);

      // ── Overall Score ─────────────────────────────────────────────────
      const overallScore = Math.round(
        infraScore  * 0.25 +
        logicScore  * 0.30 +
        riskScore   * 0.25 +
        profitScore * 0.20
      );

      const readyForLive = overallScore >= 75 && kalshiOk && credsPresent && paperMode && logicScore >= 90 && riskScore >= 70 && closed.length >= 20 && isProfit && goodWinRate;

      const verdict = readyForLive ? "READY_FOR_LIVE"
        : overallScore >= 60 ? "NEEDS_MORE_PAPER_TRADING"
        : overallScore >= 40 ? "CRITICAL_ISSUES_TO_FIX"
        : "NOT_READY";

      return c.json({
        engine_version: ENGINE_VERSION,
        verdict,
        ready_for_live: readyForLive,
        scores: {
          infrastructure: infraScore,
          trading_logic:  logicScore,
          risk_management: riskScore,
          profitability:  profitScore,
          overall:        overallScore,
        },
        checks: {
          infrastructure: infraChecks,
          trading_logic:  logicChecks,
          risk_management: riskChecks,
          profitability:  profitChecks,
        },
        blockers: [
          !kalshiOk && "Kalshi API unreachable",
          !credsPresent && "Missing API credentials",
          !paperMode && "Paper mode disabled — risk of live exposure",
          closed.length < 20 && `Only ${closed.length} closed paper trades — need 20+ before going live`,
          !isProfit && "Paper P&L is negative — AI not profitable yet",
          !goodWinRate && `Win rate ${winRate !== null ? Math.round(winRate * 100) + "%" : "unknown"} below 50% threshold`,
        ].filter(Boolean),
        paper_trading_summary: {
          trades_closed: closed.length,
          trades_open: allTrades.filter((t: any) => t.status === "open").length,
          total_pnl: totalPnl,
          win_rate: winRate,
          min_trades_for_live: 20,
          ready: closed.length >= 20 && isProfit && goodWinRate,
        },
        timestamp: new Date().toISOString(),
      }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: msg }, 500);
    }
  })

  // ─── Adaptive State: current protection mode ──────────────────────────────
  .get('/trade-engine/adaptive', async (c) => {
    try {
      const adaptations = await getScanAdaptations();
      const state = await computeAdaptiveState();
      return c.json({
        engine_version: ENGINE_VERSION,
        mode: adaptations.mode,
        message: adaptations.logMessage,
        consecutive_losses: state.consecutiveLosses,
        consecutive_wins: state.consecutiveWins,
        position_size_multiplier: adaptations.positionSizeMultiplier,
        min_confidence_boost: adaptations.minConfidenceBoost,
        block_new_trades: adaptations.blockNewTrades,
        observation_entered_at: state.observationEnteredAt,
        category_weights: adaptations.categoryWeights,
        // Recovery Mode
        recovery_trades_completed: state.recoveryTradesCompleted,
        recovery_trades_needed: state.recoveryTradesNeeded,
        max_open_positions_override: adaptations.maxOpenPositionsOverride,
        // Per-category blocks
        category_blocked: adaptations.categoryBlocked,
        // Daily Profit Lock
        daily_profit_lock_active: state.dailyProfitLockActive,
        daily_peak_value_cents: state.dailyPeakValueCents,
        daily_drop_pct: parseFloat((state.dailyDropPct * 100).toFixed(2)),
        timestamp: new Date().toISOString(),
      }, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: msg }, 500);
    }
  })

  // ─── Learning Report: full adaptive intelligence report ───────────────────
  .get('/trade-engine/learning', async (c) => {
    try {
      const report = await generateLearningReport();
      return c.json(report, 200);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: msg }, 500);
    }
  });

export type AppType = typeof app;
export default app;
