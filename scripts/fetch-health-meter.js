#!/usr/bin/env node
// Bitcoin Health Meter — daily fetcher.
// Pulls 9 free, keyless inputs; scores each 0–100; composites into 5 sub-scores.
// Writes src/_data/health.json and appends src/_data/health-history.json.
//
// To update Strategy's BTC holdings (used for MSTR mNAV), edit STRATEGY_BTC_HOLDINGS
// below after each weekly purchase announcement at https://www.strategy.com/purchases.

const fs = require("fs");
const path = require("path");

const STRATEGY_BTC_HOLDINGS = 605000; // updated 2026-05-13 — refresh weekly from strategy.com/purchases
const STRATEGY_SHARES_OUT = 285_000_000; // approx diluted; update quarterly from 10-Q

const OUT_DIR = path.join(__dirname, "..", "src", "_data");
const SNAPSHOT_PATH = path.join(OUT_DIR, "health.json");
const HISTORY_PATH = path.join(OUT_DIR, "health-history.json");

const UA = { "User-Agent": "btcweekly-health-meter/1.0" };

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { headers: UA, ...opts });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

// ── fetchers ──────────────────────────────────────────────────────────────────

async function fetchHashrate() {
  // mempool.space returns daily hashrate samples. Compute 30d vs 90d simple averages.
  const j = await getJSON("https://mempool.space/api/v1/mining/hashrate/3y");
  const samples = j.hashrates.slice(-90).map(h => Number(h.avgHashrate));
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const ma30 = avg(samples.slice(-30));
  const ma90 = avg(samples);
  const current = Number(j.currentHashrate);
  return {
    currentEH: current / 1e18,
    ma30EH: ma30 / 1e18,
    ma90EH: ma90 / 1e18,
    ratio: ma30 / ma90,
  };
}

async function fetchDifficulty() {
  const j = await getJSON("https://mempool.space/api/v1/difficulty-adjustment");
  return {
    estimatedChange: j.difficultyChange,
    previousChange: j.previousRetarget,
    progressPercent: j.progressPercent,
  };
}

async function fetchYahooQuote(symbol) {
  const j = await getJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`
  );
  const meta = j.chart.result?.[0]?.meta;
  if (!meta || !isFinite(meta.regularMarketPrice)) throw new Error("yahoo: bad payload");
  return {
    price: meta.regularMarketPrice,
    high52: meta.fiftyTwoWeekHigh,
    low52: meta.fiftyTwoWeekLow,
    source: "yahoo",
  };
}

async function fetchStooqQuote(symbol) {
  // CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
  const csv = await getText(`https://stooq.com/q/l/?s=${symbol.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`);
  const lines = csv.trim().split("\n");
  if (lines.length < 2) throw new Error("stooq: empty response");
  const cols = lines[1].split(",");
  const close = Number(cols[6]);
  if (!isFinite(close)) throw new Error("stooq: unparseable close");
  return { price: close, source: "stooq" };
}

async function fetchQuote(symbol) {
  try {
    return await fetchYahooQuote(symbol);
  } catch (e) {
    console.warn(`[warn] Yahoo ${symbol} failed (${e.message}) — falling back to Stooq`);
    return await fetchStooqQuote(symbol);
  }
}

async function fetchBTCSpot() {
  const j = await getJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true"
  );
  return { price: j.bitcoin.usd, change24h: j.bitcoin.usd_24h_change };
}

async function fetchMVRV() {
  const j = await getJSON(
    "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&page_size=1"
  );
  return Number(j.data[0].CapMVRVCur);
}

async function fetchFunding() {
  // OKX 8h funding rate, annualized.
  const j = await getJSON(
    "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"
  );
  const rate8h = Number(j.data[0].fundingRate);
  return { rate8h, annualizedPct: rate8h * 3 * 365 * 100 };
}

async function fetchStablecoinCap() {
  // DefiLlama. Sum USDT + USDC + DAI circulating; compute 7d delta vs prevWeek.
  const j = await getJSON("https://stablecoins.llama.fi/stablecoins");
  const wanted = new Set(["USDT", "USDC", "DAI"]);
  let cur = 0, prev = 0;
  for (const a of j.peggedAssets) {
    if (!wanted.has(a.symbol)) continue;
    cur += a.circulating?.peggedUSD || 0;
    prev += a.circulatingPrevWeek?.peggedUSD || 0;
  }
  return { totalUSD: cur, prevWeekUSD: prev, delta7dPct: prev ? ((cur - prev) / prev) * 100 : 0 };
}

async function fetchFearGreed() {
  const j = await getJSON("https://api.alternative.me/fng/?limit=1");
  return { value: Number(j.data[0].value), label: j.data[0].value_classification };
}

async function fetchDXY() {
  // FRED CSV, no key required.
  const csv = await getText(
    "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS"
  );
  const rows = csv.trim().split("\n").slice(1)
    .map(l => l.split(","))
    .filter(r => r[1] && r[1] !== "." && !Number.isNaN(Number(r[1])));
  const latest = Number(rows.at(-1)[1]);
  // ~30 trading days back
  const prior = Number(rows.at(-22)[1]);
  return { latest, prior, change30dPct: ((latest - prior) / prior) * 100 };
}

// ── scoring ───────────────────────────────────────────────────────────────────
// Each fn maps its input to a 0–100 health score (higher = healthier for BTC).

function scoreHashrate(r) {
  // 30d/90d ratio. >1.05 expanding strongly; <0.95 contracting.
  const x = r.ratio;
  if (x >= 1.05) return 92;
  if (x >= 1.02) return 80;
  if (x >= 1.00) return 68;
  if (x >= 0.97) return 48;
  if (x >= 0.94) return 30;
  return 15;
}
function scoreDifficulty(r) {
  const x = r.estimatedChange;
  if (x >= 4) return 90;
  if (x >= 1) return 72;
  if (x >= -1) return 55;
  if (x >= -4) return 32;
  return 18;
}
function scoreSTRC(strcPrice) {
  // Healthy when held tight to $100 par. Below par = constant corporate BTC bid in play.
  // Far below par = struggling to defend. Above par = over-collateralized, less efficient.
  const dist = strcPrice - 100;
  if (dist >= -0.25 && dist <= 0.25) return 92;
  if (dist >= -0.75 && dist <= 0.75) return 78;
  if (dist >= -1.5 && dist <= 1.5) return 60;
  if (dist >= -3 && dist <= 3) return 40;
  return 22;
}
function scoreMNAV(mnav) {
  if (mnav >= 2.5) return 92;
  if (mnav >= 1.8) return 78;
  if (mnav >= 1.3) return 60;
  if (mnav >= 1.0) return 40;
  if (mnav >= 0.85) return 25;
  return 12;
}
function scoreMVRV(mvrv) {
  if (mvrv < 1.0) return 92;
  if (mvrv < 1.5) return 78;
  if (mvrv < 2.0) return 62;
  if (mvrv < 2.7) return 48;
  if (mvrv < 3.5) return 30;
  return 15;
}
function scoreFunding(annPct) {
  // Mild positive funding is normal; extreme positive = leveraged longs = top risk.
  // Negative funding is healthy for forward returns.
  if (annPct < 0) return 82;
  if (annPct < 8) return 72;
  if (annPct < 18) return 55;
  if (annPct < 35) return 35;
  if (annPct < 60) return 22;
  return 12;
}
function scoreStablecoins(delta7dPct) {
  if (delta7dPct >= 1.0) return 88;
  if (delta7dPct >= 0.3) return 72;
  if (delta7dPct >= -0.3) return 52;
  if (delta7dPct >= -1.0) return 35;
  return 18;
}
function scoreFearGreed(value) {
  // Contrarian: extreme fear is bullish for forward returns.
  if (value <= 20) return 85;
  if (value <= 40) return 70;
  if (value <= 60) return 52;
  if (value <= 80) return 32;
  return 15;
}
function scoreDXY(change30dPct) {
  // BTC inversely correlated with DXY at extremes.
  if (change30dPct <= -2) return 82;
  if (change30dPct <= -0.5) return 68;
  if (change30dPct <= 0.5) return 52;
  if (change30dPct <= 2) return 38;
  return 22;
}

// ── orchestrate ──────────────────────────────────────────────────────────────

async function safe(label, fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { console.warn(`[warn] ${label} failed: ${e.message}`); return { ok: false, error: e.message }; }
}

function weighted(parts) {
  // parts = [{score, weight}]. Drops entries with null score, re-normalizes.
  const live = parts.filter(p => p.score != null);
  if (!live.length) return null;
  const totalW = live.reduce((a, b) => a + b.weight, 0);
  return live.reduce((a, b) => a + b.score * b.weight, 0) / totalW;
}

async function main() {
  const [
    hashrate, difficulty, btc, mstr, strc,
    mvrv, funding, stables, fng, dxy,
  ] = await Promise.all([
    safe("hashrate", fetchHashrate),
    safe("difficulty", fetchDifficulty),
    safe("btc spot", fetchBTCSpot),
    safe("MSTR quote", () => fetchQuote("MSTR")),
    safe("STRC quote", () => fetchQuote("STRC")),
    safe("MVRV", fetchMVRV),
    safe("funding", fetchFunding),
    safe("stablecoins", fetchStablecoinCap),
    safe("fear & greed", fetchFearGreed),
    safe("DXY", fetchDXY),
  ]);

  // Derived: MSTR mNAV = market cap / (BTC held × spot)
  let mnav = null;
  if (mstr.ok && btc.ok) {
    const mcap = mstr.value.price * STRATEGY_SHARES_OUT;
    const navBTC = STRATEGY_BTC_HOLDINGS * btc.value.price;
    mnav = mcap / navBTC;
  }

  const inputs = {
    hashrate:   hashrate.ok   ? { ...hashrate.value, score: scoreHashrate(hashrate.value) } : null,
    difficulty: difficulty.ok ? { ...difficulty.value, score: scoreDifficulty(difficulty.value) } : null,
    strc:       strc.ok       ? { ...strc.value, distanceFromPar: strc.value.price - 100, score: scoreSTRC(strc.value.price) } : null,
    mnav:       mnav != null  ? { value: mnav, mstrPrice: mstr.value.price, btcPrice: btc.value.price, btcHeld: STRATEGY_BTC_HOLDINGS, score: scoreMNAV(mnav) } : null,
    mvrv:       mvrv.ok       ? { value: mvrv.value, score: scoreMVRV(mvrv.value) } : null,
    funding:    funding.ok    ? { ...funding.value, score: scoreFunding(funding.value.annualizedPct) } : null,
    stablecoins:stables.ok    ? { ...stables.value, score: scoreStablecoins(stables.value.delta7dPct) } : null,
    fearGreed:  fng.ok        ? { ...fng.value, score: scoreFearGreed(fng.value.value) } : null,
    dxy:        dxy.ok        ? { ...dxy.value, score: scoreDXY(dxy.value.change30dPct) } : null,
  };

  const subScores = {
    networkHealth: weighted([
      { score: inputs.hashrate?.score,   weight: 60 },
      { score: inputs.difficulty?.score, weight: 40 },
    ]),
    demandStack: weighted([
      { score: inputs.strc?.score, weight: 40 },
      { score: inputs.mnav?.score, weight: 60 },
    ]),
    holderConviction: weighted([
      { score: inputs.mvrv?.score, weight: 100 },
    ]),
    marketStructure: weighted([
      { score: inputs.funding?.score,     weight: 50 },
      { score: inputs.stablecoins?.score, weight: 50 },
    ]),
    macroSentiment: weighted([
      { score: inputs.fearGreed?.score, weight: 60 },
      { score: inputs.dxy?.score,       weight: 40 },
    ]),
  };

  const composite = weighted([
    { score: subScores.networkHealth,    weight: 20 },
    { score: subScores.demandStack,      weight: 30 },
    { score: subScores.holderConviction, weight: 20 },
    { score: subScores.marketStructure,  weight: 20 },
    { score: subScores.macroSentiment,   weight: 10 },
  ]);

  const round = n => n == null ? null : Math.round(n * 10) / 10;

  const snapshot = {
    generatedAt: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    composite: round(composite),
    label: labelFor(composite),
    subScores: Object.fromEntries(Object.entries(subScores).map(([k, v]) => [k, round(v)])),
    inputs,
    btcSpot: btc.ok ? btc.value : null,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");

  // Append to history (dedupe by date — last write of the day wins).
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch {}
  history = history.filter(h => h.date !== snapshot.date);
  history.push({
    date: snapshot.date,
    composite: snapshot.composite,
    subScores: snapshot.subScores,
  });
  history.sort((a, b) => a.date.localeCompare(b.date));
  history = history.slice(-365); // cap at 1y
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");

  console.log(`Composite: ${snapshot.composite} (${snapshot.label})`);
  console.log(`Sub-scores:`, snapshot.subScores);
}

function labelFor(score) {
  if (score == null) return "Unknown";
  if (score >= 80) return "Robust";
  if (score >= 65) return "Healthy";
  if (score >= 50) return "Mixed";
  if (score >= 35) return "Strained";
  return "Fragile";
}

main().catch(e => { console.error(e); process.exit(1); });
