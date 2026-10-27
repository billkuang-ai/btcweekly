#!/usr/bin/env node
// Bitcoin Health Meter — daily fetcher.
// Pulls 9 free, keyless inputs; scores each 0–100; composites into 5 sub-scores.
// Writes src/_data/health.json and appends src/_data/health-history.json.

const fs = require("fs");
const path = require("path");

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

async function fetchStrategyKPIs() {
  // Strategy's own dashboard feed (strategy.com). mNav is enterprise value / BTC NAV.
  const j = await getJSON("https://api.strategy.com/btc/bitcoinKpis");
  const r = j.results;
  const btcHeld = Number(String(r.btcHoldings).replace(/,/g, ""));
  if (!isFinite(btcHeld) || btcHeld <= 0) throw new Error("strategy: bad btcHoldings");
  return {
    btcHeld,
    mNav: isFinite(Number(r.mNav)) ? Number(r.mNav) : null,
    satsPerShare: Number(r.satsPerShare),
  };
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
  // DefiLlama total stablecoin supply (all USD-pegged coins), daily series. 7d delta.
  const j = await getJSON("https://stablecoins.llama.fi/stablecoincharts/all");
  const usd = d => Number(d.totalCirculatingUSD?.peggedUSD);
  const cur = usd(j.at(-1));
  const prev = usd(j.at(-8));
  if (!isFinite(cur) || !isFinite(prev) || !prev) throw new Error("defillama: bad payload");
  return { totalUSD: cur, prevWeekUSD: prev, delta7dPct: ((cur - prev) / prev) * 100 };
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
// Scores interpolate linearly between anchor points [input, score] and clamp at the ends,
// so small input moves produce small score moves.

function interp(x, anchors) {
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return Math.round(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
    }
  }
  return anchors.at(-1)[1];
}

function scoreHashrate(r) {
  // 30d/90d ratio. >1.05 expanding strongly; <0.94 contracting.
  return interp(r.ratio, [[0.94, 15], [0.955, 30], [0.985, 48], [1.01, 68], [1.035, 80], [1.05, 92]]);
}
function scoreDifficulty(r) {
  return interp(r.estimatedChange, [[-4, 18], [-2.5, 32], [0, 55], [2.5, 72], [4, 90]]);
}
function scoreSTRC(strcPrice) {
  // Healthy when held tight to $100 par. Below par = constant corporate BTC bid in play.
  // Far below par = struggling to defend. Above par = over-collateralized, less efficient.
  const dist = Math.abs(strcPrice - 100);
  return interp(dist, [[0.25, 92], [0.5, 78], [1.125, 60], [2.25, 40], [3, 22]]);
}
function scoreMNAV(mnav) {
  return interp(mnav, [[0.85, 12], [0.925, 25], [1.15, 40], [1.55, 60], [2.15, 78], [2.5, 92]]);
}
function scoreMVRV(mvrv) {
  return interp(mvrv, [[1.0, 92], [1.25, 78], [1.75, 62], [2.35, 48], [3.1, 30], [3.5, 15]]);
}
function scoreFunding(annPct) {
  // Mild positive funding is normal; extreme positive = leveraged longs = top risk.
  // Negative funding is healthy for forward returns.
  return interp(annPct, [[0, 82], [4, 72], [13, 55], [26.5, 35], [47.5, 22], [60, 12]]);
}
function scoreStablecoins(delta7dPct) {
  return interp(delta7dPct, [[-1, 18], [-0.65, 35], [0, 52], [0.65, 72], [1, 88]]);
}
function scoreFearGreed(value) {
  // Contrarian: extreme fear is bullish for forward returns.
  return interp(value, [[20, 85], [30, 70], [50, 52], [70, 32], [80, 15]]);
}
function scoreDXY(change30dPct) {
  // BTC inversely correlated with the dollar at extremes.
  return interp(change30dPct, [[-2, 82], [-1.25, 68], [0, 52], [1.25, 38], [2, 22]]);
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
    hashrate, difficulty, btc, mstr, strc, strategy,
    mvrv, funding, stables, fng, dxy,
  ] = await Promise.all([
    safe("hashrate", fetchHashrate),
    safe("difficulty", fetchDifficulty),
    safe("btc spot", fetchBTCSpot),
    safe("MSTR quote", () => fetchQuote("MSTR")),
    safe("STRC quote", () => fetchQuote("STRC")),
    safe("Strategy KPIs", fetchStrategyKPIs),
    safe("MVRV", fetchMVRV),
    safe("funding", fetchFunding),
    safe("stablecoins", fetchStablecoinCap),
    safe("fear & greed", fetchFearGreed),
    safe("DXY", fetchDXY),
  ]);

  // MSTR mNAV: Strategy's published figure (enterprise value / BTC NAV). Fallback derives
  // equity mNAV = MSTR price / BTC per share, from live holdings and sats per share.
  let mnav = null, mnavBasis = null;
  if (strategy.ok && strategy.value.mNav != null) {
    mnav = strategy.value.mNav;
    mnavBasis = "strategy";
  } else if (strategy.ok && mstr.ok && btc.ok && strategy.value.satsPerShare > 0) {
    mnav = mstr.value.price / ((strategy.value.satsPerShare / 1e8) * btc.value.price);
    mnavBasis = "derived";
  }

  const inputs = {
    hashrate:   hashrate.ok   ? { ...hashrate.value, score: scoreHashrate(hashrate.value) } : null,
    difficulty: difficulty.ok ? { ...difficulty.value, score: scoreDifficulty(difficulty.value) } : null,
    strc:       strc.ok       ? { ...strc.value, distanceFromPar: strc.value.price - 100, score: scoreSTRC(strc.value.price) } : null,
    mnav:       mnav != null  ? { value: mnav, basis: mnavBasis, mstrPrice: mstr.ok ? mstr.value.price : null, btcPrice: btc.ok ? btc.value.price : null, btcHeld: strategy.value.btcHeld, score: scoreMNAV(mnav) } : null,
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
