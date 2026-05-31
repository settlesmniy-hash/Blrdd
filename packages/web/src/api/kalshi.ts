// Kalshi API integration
// Public API: no auth needed for market data
// Private API: RSA key signing (PKCS1v15 + SHA256)

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  status: string;
  close_time: string;
  category: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  liquidity: number;
  volume_24h: number;
  price_history?: PricePoint[];
}

export interface PricePoint {
  ts: number;
  yes_price: number;
  volume: number;
}

export interface KalshiPosition {
  ticker: string;
  market_title: string;
  position: number; // positive = YES, negative = NO
  market_exposure: number;
  realized_pnl: number;
  unrealized_pnl: number;
  total_cost: number;
  current_price: number;
  resting_orders_count: number;
}

export interface KalshiBalance {
  balance: number;
  payout: number;
  fees: number;
}

export interface AIRecommendation {
  ticker: string;
  action: "BUY" | "SELL" | "WAIT" | "HOLD" | "EXIT";
  side: "YES" | "NO" | null;
  confidence: number;
  reasoning: string;
  target_price?: number;
  opportunity_window?: string;
}

// ─── Category detection by ticker prefix ──────────────────────────────────────

function detectCategory(ticker: string, eventCategory?: string): string {
  const t = ticker.toUpperCase();
  // Ticker-based detection takes priority — event categories are often wrong
  if (
    t.startsWith("KXBTC") || t.startsWith("KXBTCD") ||
    t.startsWith("KXETH") ||
    t.startsWith("KXSOL") || t.startsWith("KXSOLD") ||
    t.startsWith("KXCRYPTO")
  ) return "crypto";
  if (
    t.startsWith("KXMLB") || t.startsWith("KXNBA") || t.startsWith("KXNFL") ||
    t.startsWith("KXNHL") || t.startsWith("KXNPB") || t.startsWith("KXITF") ||
    t.startsWith("KXBOLP") || t.startsWith("KXSOCCER") || t.startsWith("KXPGA") ||
    t.startsWith("KXWTA") || t.startsWith("KXATP")
  ) return "sports";
  if (
    t.startsWith("KXSENATE") || t.startsWith("KXHOUSE") || t.startsWith("KXTRUMP") ||
    t.startsWith("KXBIDEN") || t.startsWith("KXPRES") || t.startsWith("KXGOV")
  ) return "politics";
  if (
    t.startsWith("KXREC") || t.startsWith("KXCABLE") || t.startsWith("KXGDP") ||
    t.startsWith("KXCPI") || t.startsWith("KXFED") || t.startsWith("KXUNEMP")
  ) return "economics";
  if (t.startsWith("KXLLM") || t.startsWith("KXTOP") || t.startsWith("KXAI")) return "science";
  if (eventCategory) {
    const cat = eventCategory.toLowerCase();
    if (cat.includes("crypto") || cat.includes("financials") || cat.includes("economics")) return "economics";
    if (cat.includes("sport")) return "sports";
    if (cat.includes("politics") || cat.includes("election")) return "politics";
    if (cat.includes("science") || cat.includes("technology")) return "science";
    return cat;
  }
  return "general";
}

// ─── Public endpoints (no auth) ───────────────────────────────────────────────

// Sports series — real volume, tight spreads
const SPORTS_SERIES = ["KXMLBGAME", "KXMLBTOTAL", "KXMLBSPREAD", "KXWNBAGAME", "KXNBAGAME", "KXNBAGAME2H"];
// Crypto 15-minute series
const CRYPTO_15M_SERIES = ["KXBTC15M", "KXETH15M", "KXSOL15M"];
// Crypto hourly series
const CRYPTO_HOURLY_SERIES = ["KXBTCD", "KXSOLD", "KXETH"];
// Short-term events (7-day window)
const EVENT_SERIES = ["KXSENATEREC", "KXCABLEAVE", "KXTRUMPTIME"];

async function fetchSeries(seriesTicker: string, limitPerSeries = 20, retries = 2): Promise<any[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const params = new URLSearchParams({
        series_ticker: seriesTicker,
        status: "open",
        limit: String(limitPerSeries),
      });
      const res = await fetch(`${KALSHI_BASE}/markets?${params}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.status === 429) {
        // Rate limited — wait and retry
        console.warn(`[Kalshi] Rate limited on ${seriesTicker}, waiting 2s before retry ${attempt + 1}`);
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        console.warn(`[Kalshi] fetchSeries ${seriesTicker} status ${res.status}`);
        return [];
      }
      const data = await res.json();
      const markets = data.markets || [];
      if (markets.length === 0) console.warn(`[Kalshi] fetchSeries ${seriesTicker} returned 0 markets`);
      return markets;
    } catch (e: any) {
      console.warn(`[Kalshi] fetchSeries ${seriesTicker} attempt ${attempt + 1} error: ${e?.message || e}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return [];
}

/**
 * Fetch markets via the events API for series where markets have series_ticker=null
 * (e.g. NBA Finals, where Kalshi uses event-based structure instead of series-based)
 */
async function fetchSeriesViaEvents(seriesTicker: string, limitEvents = 10): Promise<any[]> {
  try {
    // Step 1: get events for this series
    const eventsRes = await fetch(
      `${KALSHI_BASE}/events?series_ticker=${seriesTicker}&status=open&limit=${limitEvents}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!eventsRes.ok) return [];
    const eventsData = await eventsRes.json();
    const events: any[] = eventsData.events || [];
    if (events.length === 0) return [];

    // Step 2: fetch markets for each event in parallel
    const allMarkets = await Promise.all(
      events.map(async (event: any) => {
        try {
          const res = await fetch(
            `${KALSHI_BASE}/markets?event_ticker=${event.event_ticker}&status=open&limit=20`,
            { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
          );
          if (!res.ok) return [];
          const d = await res.json();
          return d.markets || [];
        } catch { return []; }
      })
    );
    return allMarkets.flat();
  } catch {
    return [];
  }
}

/** Filter markets to only those with real liquidity and closing within maxDays */
function filterLiquid(markets: any[], maxDays = 14, minAsk = 0.05, maxAsk = 0.95): any[] {
  const now = Date.now();
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  return markets.filter(m => {
    const ask = parseFloat(m.yes_ask_dollars || "0");
    const bid = parseFloat(m.yes_bid_dollars || "0");
    if (ask < minAsk || ask > maxAsk) return false;
    if (bid <= 0) return false;
    if (m.ticker?.toUpperCase().startsWith("KXMVE")) return false; // skip parlays
    const closeMs = new Date(m.close_time || 0).getTime();
    if (closeMs <= now) return false; // already expired
    if (closeMs - now > maxMs) return false; // too far out
    return true;
  });
}

/** Deduplicate by ticker */
function dedupe(markets: any[]): any[] {
  const seen = new Set<string>();
  return markets.filter(m => {
    if (!m.ticker || seen.has(m.ticker)) return false;
    seen.add(m.ticker);
    return true;
  });
}

export async function fetchMarkets(
  category?: string,
  limit = 100
): Promise<KalshiMarket[]> {
  try {
    // Fetch in sequential batches to avoid rate limiting
    // Batch 1: Sports (highest value, prioritize)
    const sportsSeries = SPORTS_SERIES.filter(s => s !== "KXNBAGAME");
    const sportsResults: any[][] = [];
    for (const s of sportsSeries) {
      sportsResults.push(await fetchSeries(s, 20));
    }
    const sportsRaw = sportsResults.flat();
    const nbaSeries = await fetchSeriesViaEvents("KXNBAGAME", 10);
    const allSportsRaw = [...sportsRaw, ...nbaSeries];

    // Batch 2: Crypto (parallel is fine — only 3-6 series)
    const [crypto15mRaw, cryptoHourlyRaw] = await Promise.all([
      Promise.all(CRYPTO_15M_SERIES.map(s => fetchSeries(s, 5))).then(r => r.flat()),
      Promise.all(CRYPTO_HOURLY_SERIES.map(s => fetchSeries(s, 10))).then(r => r.flat()),
    ]);

    // Batch 3: Events
    const eventRaw = (await Promise.all(EVENT_SERIES.map(s => fetchSeries(s, 10)))).flat();

    // Log raw counts for debugging
    console.log(`[Kalshi] Raw: sports=${allSportsRaw.length} crypto15m=${crypto15mRaw.length} cryptoH=${cryptoHourlyRaw.length} events=${eventRaw.length}`);

    // Filter each group with appropriate time windows
    const sports = filterLiquid(allSportsRaw, 21);      // games up to 3 weeks out
    const crypto15m = filterLiquid(crypto15mRaw, 1); // 15m markets — must close within 1 day
    const cryptoHourly = filterLiquid(cryptoHourlyRaw, 2); // hourly — within 2 days
    const events = filterLiquid(eventRaw, 7);         // events — within 7 days

    console.log(`[Kalshi] After filter: sports=${sports.length} crypto15m=${crypto15m.length} cryptoH=${cryptoHourly.length} events=${events.length}`);

    // Combine, dedupe, normalize
    const all = dedupe([...crypto15m, ...cryptoHourly, ...sports, ...events]);
    let normalized = all.map(m => normalizeMarket(m));

    // Apply category filter if requested
    if (category && category !== "all") {
      normalized = normalized.filter(m => m.category.toLowerCase() === category.toLowerCase());
    }

    // Sort: within each category, sort by volume desc
    normalized.sort((a, b) => {
      // Category priority order: crypto first, then sports, then events
      const catOrder = (c: string) => c === "crypto" ? 0 : c === "sports" ? 1 : 2;
      const diff = catOrder(a.category) - catOrder(b.category);
      if (diff !== 0) return diff;
      return b.volume - a.volume;
    });

    const result = normalized.slice(0, limit);
    console.log(`[Kalshi] fetchMarkets total=${result.length}`);
    return result;
  } catch (e) {
    console.error("fetchMarkets error:", e);
    return [];
  }
}

/**
 * Fetch markets by explicit category for the structured home feed.
 * Returns { crypto15m, cryptoHourly, basketball, baseball, upcomingBasketball, upcomingBaseball }
 */
export async function fetchStructuredMarkets(): Promise<{
  crypto15m: KalshiMarket[];
  cryptoHourly: KalshiMarket[];
  basketball: KalshiMarket[];
  baseball: KalshiMarket[];
  upcomingBasketball: KalshiMarket[];
  upcomingBaseball: KalshiMarket[];
}> {

  const now = Date.now();
  // "Live" = game closes within 30 hours (same day + tonight games that are in progress/starting soon)
  // "Upcoming" = closes in 30h–21 days
  const LIVE_WINDOW_MS = 30 * 60 * 60 * 1000;
  const MAX_SPORTS_DAYS = 21;

  const [crypto15mRaw, cryptoHourlyRaw, wnbaRaw, nbaRaw, mlbRaw, mlbTotalRaw, mlbSpreadRaw] =
    await Promise.all([
      Promise.all(CRYPTO_15M_SERIES.map(s => fetchSeries(s, 3))).then(r => r.flat()),
      Promise.all(CRYPTO_HOURLY_SERIES.map(s => fetchSeries(s, 5))).then(r => r.flat()),
      fetchSeries("KXWNBAGAME", 20),
      // NBA Finals: Kalshi uses event-based structure (series_ticker=null on markets), must fetch via events API
      fetchSeriesViaEvents("KXNBAGAME", 10),
      fetchSeries("KXMLBGAME", 20),
      fetchSeries("KXMLBTOTAL", 10),
      fetchSeries("KXMLBSPREAD", 10),
    ]);

  const crypto15m = dedupe(filterLiquid(crypto15mRaw, 1))
    .map(m => normalizeMarket(m))
    .sort((a, b) => b.volume - a.volume);

  const cryptoHourly = dedupe(filterLiquid(cryptoHourlyRaw, 2))
    .map(m => normalizeMarket(m))
    .sort((a, b) => b.volume - a.volume);

  // Basketball: WNBA + NBA, dedupe — up to 3 weeks out
  const allBball = dedupe(filterLiquid([...wnbaRaw, ...nbaRaw], MAX_SPORTS_DAYS))
    .map(m => normalizeMarket(m))
    .sort((a, b) => b.volume - a.volume);

  const basketball = allBball.filter(m =>
    new Date(m.close_time).getTime() - now <= LIVE_WINDOW_MS
  );
  const upcomingBasketball = allBball.filter(m =>
    new Date(m.close_time).getTime() - now > LIVE_WINDOW_MS
  );

  // Baseball: game + totals + spreads — up to 3 weeks out
  const allMlb = dedupe(filterLiquid([...mlbRaw, ...mlbTotalRaw, ...mlbSpreadRaw], MAX_SPORTS_DAYS))
    .map(m => normalizeMarket(m))
    .sort((a, b) => b.volume - a.volume);

  const baseball = allMlb.filter(m =>
    new Date(m.close_time).getTime() - now <= LIVE_WINDOW_MS
  );
  const upcomingBaseball = allMlb.filter(m =>
    new Date(m.close_time).getTime() - now > LIVE_WINDOW_MS
  );

  return { crypto15m, cryptoHourly, basketball, baseball, upcomingBasketball, upcomingBaseball };
}

export async function fetchMarket(ticker: string): Promise<KalshiMarket | null> {
  try {
    const res = await fetch(`${KALSHI_BASE}/markets/${ticker}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeMarket(data.market);
  } catch {
    return null;
  }
}

export async function fetchMarketHistory(
  ticker: string,
  period_interval: number = 60
): Promise<PricePoint[]> {
  try {
    const res = await fetch(
      `${KALSHI_BASE}/markets/${ticker}/history?period_interval=${period_interval}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.history || []).map((h: any) => ({
      ts: new Date(h.ts).getTime(),
      // history uses yes_price in cents (integer) per Kalshi docs
      yes_price: typeof h.yes_price === "number" ? h.yes_price : Math.round(parseFloat(h.yes_price || "0") * 100),
      volume: h.volume || 0,
    }));
  } catch {
    return [];
  }
}

// ─── Authenticated endpoints (RSA key signing) ────────────────────────────────
import { sign as rsaSign, createPrivateKey, constants as cryptoConstants } from "crypto";

export function decodePrivateKey(pemOrBase64: string): string {
  const s = pemOrBase64.trim();
  if (s.startsWith("-----")) return s;
  // base64-encoded PEM
  return Buffer.from(s, "base64").toString("utf8");
}

function rsaHeaders(keyId: string, privateKey: string, method: string, path: string): Record<string, string> {
  const timestamp = `${Date.now()}`;
  const pem = decodePrivateKey(privateKey);
  const key = createPrivateKey({ key: pem, format: "pem" });
  const signature = rsaSign("SHA256", Buffer.from(timestamp + method.toUpperCase() + path), {
    key,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
  return {
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

export async function fetchPortfolio(
  keyId: string, privateKey: string
): Promise<{ balance: KalshiBalance; positions: KalshiPosition[] } | null> {
  try {
    const [balRes, posRes] = await Promise.all([
      fetch(`${KALSHI_BASE}/portfolio/balance`, { headers: rsaHeaders(keyId, privateKey, "GET", "/trade-api/v2/portfolio/balance") }),
      fetch(`${KALSHI_BASE}/portfolio/positions`, { headers: rsaHeaders(keyId, privateKey, "GET", "/trade-api/v2/portfolio/positions") }),
    ]);

    if (!balRes.ok || !posRes.ok) {
      const balErr = await balRes.text().catch(() => "");
      const posErr = await posRes.text().catch(() => "");
      console.error(`[Portfolio] bal=${balRes.status} pos=${posRes.status}`);
      if (balErr) console.error("[Portfolio] bal body:", balErr);
      if (posErr) console.error("[Portfolio] pos body:", posErr);
      return null;
    }

    const balData = await balRes.json();
    const posData = await posRes.json();

    const rawBal = balData.balance;
    const balanceDollars = typeof rawBal === "string"
      ? parseFloat(rawBal)
      : rawBal / 100;

    return {
      balance: {
        balance: balanceDollars,
        payout: typeof balData.payout === "string" ? parseFloat(balData.payout) : (balData.payout || 0) / 100,
        fees: 0,
      },
      positions: (posData.market_positions || []).map(normalizePosition),
    };
  } catch {
    return null;
  }
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  yes_price: number;
  no_price: number;
  status: string;
  created_time: string;
  expiration_time?: string;
}

export async function fetchOpenOrders(keyId: string, privateKey: string): Promise<KalshiOrder[]> {
  try {
    const res = await fetch(`${KALSHI_BASE}/portfolio/orders?status=resting`, {
      headers: rsaHeaders(keyId, privateKey, "GET", "/trade-api/v2/portfolio/orders"),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.orders || []).map((o: any): KalshiOrder => ({
      order_id: o.order_id,
      ticker: o.ticker,
      side: o.side,
      action: o.action,
      count: o.count || o.remaining_count || 0,
      yes_price: typeof o.yes_price === "string" ? parseFloat(o.yes_price) : (o.yes_price || 0),
      no_price: typeof o.no_price === "string" ? parseFloat(o.no_price) : (o.no_price || 0),
      status: o.status,
      created_time: o.created_time || new Date().toISOString(),
      expiration_time: o.expiration_time,
    }));
  } catch {
    return [];
  }
}

export async function placeOrder(
  keyId: string,
  privateKey: string,
  ticker: string,
  side: "yes" | "no",
  action: "buy" | "sell",
  count: number,
  price: number
): Promise<{ order_id: string; status: string } | null> {
  try {
    const yesPriceDollars = (side === "yes" ? price : 100 - price) / 100;
    const noPriceDollars = (side === "no" ? price : 100 - price) / 100;

    const body = JSON.stringify({
      ticker,
      action,
      side,
      count,
      type: "limit",
      yes_price: yesPriceDollars.toFixed(2),
      no_price: noPriceDollars.toFixed(2),
      client_order_id: `pt_${Date.now()}`,
    });

    const res = await fetch(`${KALSHI_BASE}/portfolio/orders`, {
      method: "POST",
      headers: { ...rsaHeaders(keyId, privateKey, "POST", "/trade-api/v2/portfolio/orders"), "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) return null;
    const data = await res.json();
    return { order_id: data.order?.order_id, status: data.order?.status };
  } catch {
    return null;
  }
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizeMarket(m: any, eventCategory?: string): KalshiMarket {
  // New API: prices are dollar strings like "0.2500" = 25 cents
  // Multiply by 100 to get the 0-100 cent integer range our UI expects
  const parseDollar = (v: any) => {
    if (v == null) return 0;
    const f = typeof v === "string" ? parseFloat(v) : v;
    return isNaN(f) ? 0 : Math.round(f * 100) / 100; // keep as 0.0-1.0 float (fraction)
  };

  const yes_bid = parseDollar(m.yes_bid_dollars);
  const yes_ask = parseDollar(m.yes_ask_dollars);
  const no_bid = parseDollar(m.no_bid_dollars);
  const no_ask = parseDollar(m.no_ask_dollars);
  const last_price = parseDollar(m.last_price_dollars || m.previous_price_dollars);
  const volume = parseFloat(m.volume_fp || "0");
  const volume_24h = parseFloat(m.volume_24h_fp || "0");
  const open_interest = parseFloat(m.open_interest_fp || "0");
  const liquidity = parseDollar(m.liquidity_dollars);

  const category = detectCategory(m.ticker, eventCategory || m.category);

  return {
    ticker: m.ticker,
    title: m.title || m.yes_sub_title || m.ticker,
    yes_bid,
    yes_ask,
    no_bid,
    no_ask,
    last_price,
    volume,
    open_interest,
    status: m.status || "active",
    close_time: m.close_time || new Date(Date.now() + 3600000).toISOString(),
    category,
    subtitle: m.subtitle,
    yes_sub_title: m.yes_sub_title,
    no_sub_title: m.no_sub_title,
    liquidity,
    volume_24h,
  };
}

function normalizePosition(p: any): KalshiPosition {
  const parseDollar = (v: any) => {
    if (v == null) return 0;
    const f = typeof v === "string" ? parseFloat(v) : v;
    return isNaN(f) ? 0 : f;
  };

  // Position API may still use cents integers — handle both
  const isCents = (v: any) => typeof v === "number" && Math.abs(v) > 10;

  return {
    ticker: p.ticker,
    market_title: p.market_title || p.ticker,
    position: p.position || 0,
    market_exposure: isCents(p.market_exposure) ? p.market_exposure / 100 : parseDollar(p.market_exposure),
    realized_pnl: isCents(p.realized_pnl) ? p.realized_pnl / 100 : parseDollar(p.realized_pnl),
    unrealized_pnl: isCents(p.unrealized_pnl) ? p.unrealized_pnl / 100 : parseDollar(p.unrealized_pnl),
    total_cost: isCents(p.total_cost) ? p.total_cost / 100 : parseDollar(p.total_cost),
    current_price: parseDollar(p.current_price_dollars || p.current_price) || 0.5,
    resting_orders_count: p.resting_orders_count || 0,
  };
}
