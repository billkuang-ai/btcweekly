#!/usr/bin/env node
// Bitcoin Health Meter
//
// Question it answers: is Bitcoin's foundation (network security, real demand, holder base,
// liquidity, leverage) getting stronger or weaker? It is deliberately NOT a price signal:
// inputs count actions in Bitcoin's own units where possible, and nothing is scored contrarian.
//
// Seven free, keyless inputs → five sub-scores → composite.
// Each input is scored as a percentile against its own trailing history (50 = a typical day),
// except funding, which uses fixed anchors (best near neutral, worse at either extreme).
// The composite is a 7-day EMA of the weighted inputs, percentile-ranked against its own
// history, so labels spread evenly and one noisy day doesn't flip the label.
//
//   node scripts/fetch-health-meter.js             daily run: today's snapshot + append history
//   node scripts/fetch-health-meter.js --backfill  rebuild history from source data, then daily run
//
// Writes src/_data/health.json and src/_data/health-history.json.

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "src", "_data");
const SNAPSHOT_PATH = path.join(OUT_DIR, "health.json");
const HISTORY_PATH = path.join(OUT_DIR, "health-history.json");
const CORP_ENTITIES_PATH = path.join(__dirname, "health-corp-entities.json");

const WINDOW = 730;        // trailing days an input/composite is ranked against
const MIN_WINDOW = 365;    // fewer prior values than this → fall back to anchors / raw
const CORP_MIN_WINDOW = 180;
const STALE_DAYS = 3;      // carry a failed input's last value forward this long
const HISTORY_CAP = 1100;
const BACKFILL_START = "2021-06-01";
const SMOOTH = 2 / (7 + 1); // 7-day EMA on the raw composite before ranking

const UA = { "User-Agent": "btcweekly-health-meter/2.0" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── http with timeout + retry ────────────────────────────────────────────────

async function request(url, kind = "json", tries = 3, backoff = 1500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`${r.status}`);
      return kind === "json" ? await r.json() : await r.text();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep((e.message === "429" ? backoff * 10 : backoff) * 2 ** i);
    }
  }
  throw new Error(`${url.split("?")[0]} → ${lastErr.message}`);
}

// ── dates ────────────────────────────────────────────────────────────────────

const day = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => day(Date.parse(d + "T00:00:00Z") + n * 86400000);
const today = () => day(Date.now());
function daysBetween(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── source series (each returns Map<YYYY-MM-DD, number>) ─────────────────────

async function fetchCoinMetrics(start) {
  const metrics = ["HashRate", "SplyExNtv", "FeeTotNtv", "IssTotNtv", "PriceUSD"];
  let url = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics" +
    `?assets=btc&metrics=${metrics.join(",")}&frequency=1d&start_time=${start}&page_size=10000`;
  const out = Object.fromEntries(metrics.map(m => [m, new Map()]));
  while (url) {
    const j = await request(url);
    for (const row of j.data) {
      const d = row.time.slice(0, 10);
      for (const m of metrics) if (row[m] != null) out[m].set(d, Number(row[m]));
    }
    url = j.next_page_url || null;
  }
  if (!out.HashRate.size) throw new Error("coinmetrics: empty");
  return out;
}

async function fetchMempoolHashrate() {
  const j = await request("https://mempool.space/api/v1/mining/hashrate/3y");
  return new Map(j.hashrates.map(h => [day(h.timestamp * 1000), Number(h.avgHashrate)]));
}

async function fetchStablecoins() {
  const j = await request("https://stablecoins.llama.fi/stablecoincharts/all");
  const m = new Map();
  for (const r of j) {
    const v = Number(r.totalCirculatingUSD?.peggedUSD);
    if (isFinite(v) && v > 0) m.set(day(Number(r.date) * 1000), v);
  }
  if (m.size < 60) throw new Error("defillama: short series");
  return m;
}

// Deribit BTC-PERPETUAL funding, hourly samples of the 8h rate → daily mean, annualized %.
// Deribit has no built-in interest component, so neutral is ~0.
async function fetchDeribitFunding(start) {
  const sums = new Map();
  let t = Date.parse(start + "T00:00:00Z");
  const end = Date.now();
  while (t < end) {
    const t2 = Math.min(t + 30 * 86400000, end);
    const j = await request("https://www.deribit.com/api/v2/public/get_funding_rate_history" +
      `?instrument_name=BTC-PERPETUAL&start_timestamp=${t}&end_timestamp=${t2}`);
    for (const r of j.result) {
      const d = day(r.timestamp);
      const s = sums.get(d) || [0, 0];
      s[0] += Number(r.interest_8h); s[1]++;
      sums.set(d, s);
    }
    t = t2;
    if (t < end) await sleep(250);
  }
  const m = new Map();
  for (const [d, [s, n]] of sums) if (n >= 12) m.set(d, (s / n) * 3 * 365 * 100);
  if (!m.size) throw new Error("deribit: empty");
  return m;
}

// Fallback: OKX funding minus its fixed 0.01%/8h interest component, so it sits on Deribit's scale.
async function fetchOkxFunding() {
  const j = await request("https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100");
  const sums = new Map();
  for (const r of j.data) {
    const d = day(Number(r.fundingTime));
    const s = sums.get(d) || [0, 0];
    s[0] += Number(r.realizedRate ?? r.fundingRate) - 0.0001; s[1]++;
    sums.set(d, s);
  }
  return new Map([...sums].map(([d, [s, n]]) => [d, (s / n) * 3 * 365 * 100]));
}

// Daily closes (UTC day) from Coinbase BTC-USD and OKX BTC-USDT. Today's open candle is dropped.
async function fetchCoinbaseCloses(start) {
  const m = new Map();
  let t = Date.parse(start + "T00:00:00Z");
  const end = Date.now();
  while (t < end) {
    const t2 = Math.min(t + 299 * 86400000, end);
    const j = await request("https://api.exchange.coinbase.com/products/BTC-USD/candles" +
      `?granularity=86400&start=${new Date(t).toISOString()}&end=${new Date(t2).toISOString()}`);
    for (const c of j) m.set(day(c[0] * 1000), Number(c[4]));
    t = t2 + 86400000;
    if (t < end) await sleep(400);
  }
  m.delete(today());
  return m;
}

async function fetchOkxCloses(start) {
  const m = new Map();
  const stop = Date.parse(start + "T00:00:00Z");
  let after = "";
  for (let guard = 0; guard < 40; guard++) {
    const j = await request("https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=1Dutc&limit=100" +
      (after ? `&after=${after}` : ""));
    if (!j.data?.length) break;
    for (const c of j.data) m.set(day(Number(c[0])), Number(c[4]));
    const oldest = Number(j.data.at(-1)[0]);
    if (oldest <= stop) break;
    after = String(oldest);
    await sleep(250);
  }
  m.delete(today());
  return m;
}

// Corporate treasuries: sum of the tracked entities' BTC holdings (CoinGecko, free tier).
async function fetchCorporateLevelNow(entities) {
  const j = await request("https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin");
  const tracked = new Set(entities.map(e => e.symbol));
  const hits = j.companies.filter(c => tracked.has(c.symbol));
  if (hits.length < entities.length * 0.8) throw new Error(`coingecko: only ${hits.length}/${entities.length} tracked companies found`);
  return hits.reduce((a, c) => a + Number(c.total_holdings), 0);
}

// Optional context shown on the page but NOT scored.
async function fetchContext() {
  const ctx = {};
  try {
    const j = await request("https://api.strategy.com/btc/bitcoinKpis");
    const r = j.results;
    ctx.strategyBtc = Number(String(r.btcHoldings).replace(/,/g, ""));
    ctx.mNav = isFinite(Number(r.mNav)) ? Number(r.mNav) : null;
  } catch (e) { console.warn(`[warn] context: Strategy KPIs failed: ${e.message}`); }
  try {
    const j = await request("https://query1.finance.yahoo.com/v8/finance/chart/STRC?interval=1d&range=5d", "json", 2);
    const p = j.chart.result?.[0]?.meta?.regularMarketPrice;
    if (isFinite(p)) ctx.strcPrice = p;
  } catch (e) { console.warn(`[warn] context: STRC quote failed: ${e.message}`); }
  return ctx;
}

// ── signals ──────────────────────────────────────────────────────────────────
// Each is computed for a given day d from source series; returns null if data is too thin.

function mean(series, d, n, minFrac = 0.8) {
  let s = 0, k = 0;
  for (let i = 0; i < n; i++) {
    const v = series.get(addDays(d, -i));
    if (v != null && isFinite(v)) { s += v; k++; }
  }
  return k >= n * minFrac ? s / k : null;
}
function pctChange(series, d, n) {
  const a = series.get(d), b = series.get(addDays(d, -n));
  return a != null && b ? (a / b - 1) * 100 : null;
}

const SIGNALS = {
  // Hashrate 30d mean ÷ 90d mean. >1 = mining power being added.
  hashTrend: s => d => {
    const m30 = mean(s.hash, d, 30), m90 = mean(s.hash, d, 90);
    return m30 && m90 ? m30 / m90 : null;
  },
  // Fees as % of total miner revenue, 30d mean. Block-space demand; security budget beyond subsidy.
  feeShare: s => d => mean(s.feeShareDaily, d, 30),
  // BTC held on exchanges, % change over 30d. Lower (outflows) = healthier.
  exchFlow: s => d => pctChange(s.exchSupply, d, 30),
  // USD stablecoin supply, % change over 30d.
  stable30: s => d => pctChange(s.stables, d, 30),
  // Perp funding, 7d mean, annualized %.
  funding7: s => d => mean(s.funding, d, 7, 0.7),
  // Coinbase BTC-USD vs OKX BTC-USDT close, %, 7d mean. US spot demand.
  premium7: s => d => mean(s.premium, d, 7, 0.7),
  // Tracked corporate treasuries: BTC added over 30d.
  corp30: s => d => {
    const a = s.corp.get(d), b = s.corp.get(addDays(d, -30));
    return a != null && b != null ? a - b : null;
  },
};

// ── scoring ──────────────────────────────────────────────────────────────────

function interp(x, anchors) {
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return anchors.at(-1)[1];
}

function percentile(v, prior) {
  let below = 0, equal = 0;
  for (const x of prior) { if (x < v) below++; else if (x === v) equal++; }
  return (100 * (below + 0.5 * equal)) / prior.length;
}

const INPUTS = {
  hashTrend: { sub: "network",   weight: 70,  dir: +1 },
  feeShare:  { sub: "network",   weight: 30,  dir: +1 },
  corp30:    { sub: "demand",    weight: 60,  dir: +1, minWindow: CORP_MIN_WINDOW,
               // Until a year of history exists: BTC added per 30 days.
               anchors: [[-5000, 10], [0, 30], [5000, 50], [20000, 70], [50000, 90]] },
  premium7:  { sub: "demand",    weight: 40,  dir: +1 },
  exchFlow:  { sub: "holders",   weight: 100, dir: -1 },
  stable30:  { sub: "liquidity", weight: 100, dir: +1 },
  // Fixed bell: neutral-to-mildly-positive funding is healthiest; crowded longs and
  // forced short-side unwinds both score low. Annualized %, Deribit scale (neutral ≈ 0).
  funding7:  { sub: "leverage",  weight: 100, fixed: true,
               anchors: [[-30, 5], [-15, 25], [-5, 60], [0, 85], [3, 100], [8, 100], [15, 75], [25, 45], [40, 20], [60, 5]] },
};

const SUBS = { network: 25, demand: 30, holders: 20, liquidity: 15, leverage: 10 };

function scoreInput(key, raw, priorRaws) {
  const cfg = INPUTS[key];
  if (raw == null) return null;
  if (cfg.fixed) return interp(raw, cfg.anchors);
  const prior = priorRaws.filter(x => x != null).slice(-WINDOW);
  if (prior.length >= (cfg.minWindow ?? MIN_WINDOW)) {
    const p = percentile(raw, prior);
    return cfg.dir > 0 ? p : 100 - p;
  }
  return cfg.anchors ? interp(raw, cfg.anchors) : null;
}

function weighted(parts) {
  const live = parts.filter(p => p.score != null);
  if (!live.length) return null;
  const w = live.reduce((a, b) => a + b.weight, 0);
  return live.reduce((a, b) => a + b.score * b.weight, 0) / w;
}

function rollUp(scores) {
  const subScores = {};
  for (const sub of Object.keys(SUBS)) {
    subScores[sub] = weighted(Object.entries(INPUTS)
      .filter(([, c]) => c.sub === sub)
      .map(([k, c]) => ({ score: scores[k], weight: c.weight })));
  }
  const raw = weighted(Object.entries(SUBS).map(([k, w]) => ({ score: subScores[k], weight: w })));
  return { subScores, raw };
}

function compositeFrom(raw, priorRawComposites) {
  if (raw == null) return null;
  const prior = priorRawComposites.filter(x => x != null).slice(-WINDOW);
  return prior.length >= MIN_WINDOW ? percentile(raw, prior) : raw;
}

function labelFor(score) {
  if (score == null) return "Unknown";
  if (score >= 80) return "Robust";
  if (score >= 60) return "Healthy";
  if (score >= 40) return "Mixed";
  if (score >= 20) return "Strained";
  return "Fragile";
}

const r1 = n => (n == null ? null : Math.round(n * 10) / 10);
const r4 = n => (n == null ? null : Math.round(n * 1e4) / 1e4);

// ── series assembly ──────────────────────────────────────────────────────────

async function safe(label, fn) {
  try { return await fn(); }
  catch (e) { console.warn(`[warn] ${label} failed: ${e.message}`); return null; }
}

async function loadSeries(start, { corpHistory } = {}) {
  const [cm, mempool, stables, deribit, cb, okx] = await Promise.all([
    safe("CoinMetrics", () => fetchCoinMetrics(start)),
    safe("mempool hashrate", fetchMempoolHashrate),
    safe("DefiLlama stablecoins", fetchStablecoins),
    safe("Deribit funding", () => fetchDeribitFunding(addDays(start, 0))),
    safe("Coinbase candles", () => fetchCoinbaseCloses(start)),
    safe("OKX candles", () => fetchOkxCloses(start)),
  ]);
  const s = { sources: {} };

  s.hash = cm?.HashRate?.size ? cm.HashRate : mempool;
  s.sources.hashTrend = cm?.HashRate?.size ? "CoinMetrics" : mempool ? "mempool.space" : null;

  s.feeShareDaily = new Map();
  if (cm) for (const [d, fee] of cm.FeeTotNtv) {
    const iss = cm.IssTotNtv.get(d);
    if (iss != null && fee + iss > 0) s.feeShareDaily.set(d, (100 * fee) / (fee + iss));
  }
  s.sources.feeShare = cm ? "CoinMetrics" : null;

  s.exchSupply = cm?.SplyExNtv || new Map();
  s.sources.exchFlow = cm ? "CoinMetrics" : null;

  s.stables = stables || new Map();
  s.sources.stable30 = stables ? "DefiLlama" : null;

  let funding = deribit, fundingSrc = "Deribit";
  if (!funding) { funding = await safe("OKX funding", fetchOkxFunding); fundingSrc = "OKX (adjusted)"; }
  s.funding = funding || new Map();
  s.sources.funding7 = funding ? fundingSrc : null;

  s.premium = new Map();
  if (cb && okx) for (const [d, c] of cb) {
    const o = okx.get(d);
    if (o) s.premium.set(d, (c / o - 1) * 100);
  }
  s.sources.premium7 = cb && okx ? "Coinbase · OKX" : null;

  s.corp = corpHistory || new Map();
  s.sources.corp30 = "CoinGecko";

  s.price = cm?.PriceUSD || new Map();
  return s;
}

// ── corporate entity list + history (backfill only) ──────────────────────────

async function buildCorporateHistory() {
  // Top 25 companies by holdings → CoinGecko entity ids (matched on ticker) → 365d holding charts.
  const list = await request("https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin");
  const top = [...list.companies].sort((a, b) => b.total_holdings - a.total_holdings).slice(0, 25);
  const bySymbol = new Map();
  for (let page = 1; page <= 20; page++) {
    const ents = await request(`https://api.coingecko.com/api/v3/entities/list?entity_type=company&per_page=250&page=${page}`);
    for (const e of ents) if (e.symbol) bySymbol.set(e.symbol, e.id);
    if (ents.length < 250) break;
    await sleep(2500);
  }
  const entities = [], charts = [];
  for (const c of top) {
    const id = bySymbol.get(c.symbol);
    if (!id) { console.warn(`[warn] corp: no entity id for ${c.name} (${c.symbol})`); continue; }
    await sleep(6000); // free tier allows only a handful of calls per minute
    try {
      const j = await request(`https://api.coingecko.com/api/v3/public_treasury/${id}/bitcoin/holding_chart?days=365`, "json", 4);
      entities.push({ symbol: c.symbol, id, name: c.name });
      // An empty chart means no change inside the window: hold today's balance flat.
      charts.push(j.holdings?.length
        ? j.holdings.map(([t, v]) => [day(t), Number(v)])
        : [[addDays(today(), -365), Number(c.total_holdings)]]);
    } catch (e) { console.warn(`[warn] corp: chart failed for ${c.name}: ${e.message}`); }
  }
  fs.writeFileSync(CORP_ENTITIES_PATH, JSON.stringify(entities, null, 2) + "\n");

  // Step-fill each entity daily across the 365d window; before its first point, assume its first value.
  const start = addDays(today(), -365), end = addDays(today(), -1);
  const level = new Map();
  for (const d of daysBetween(start, end)) {
    let total = 0;
    for (const ch of charts) {
      let v = ch[0][1];
      for (const [cd, cv] of ch) { if (cd <= d) v = cv; else break; }
      total += v;
    }
    level.set(d, total);
  }
  console.log(`Corporate: ${entities.length} entities tracked, ${level.size} days`);
  return level;
}

// ── backfill ─────────────────────────────────────────────────────────────────

async function backfill() {
  const corp = await safe("corporate history", buildCorporateHistory);
  const s = await loadSeries(BACKFILL_START, { corpHistory: corp || new Map() });
  const sig = Object.fromEntries(Object.entries(SIGNALS).map(([k, f]) => [k, f(s)]));

  const days = daysBetween(BACKFILL_START, addDays(today(), -1));
  const rawsSoFar = Object.fromEntries(Object.keys(INPUTS).map(k => [k, []]));
  const rawComposites = [];
  const history = [];

  for (const d of days) {
    const raws = {}, scores = {};
    for (const k of Object.keys(INPUTS)) {
      raws[k] = sig[k](d);
      scores[k] = scoreInput(k, raws[k], rawsSoFar[k]);
    }
    const { subScores, raw } = rollUp(scores);
    // Only start the record once the core inputs have a ranking window.
    const ready = scores.hashTrend != null && scores.exchFlow != null && scores.stable30 != null;
    if (ready) {
      const prevSmooth = history.at(-1)?.smoothed;
      const smoothed = raw == null ? prevSmooth : prevSmooth == null ? raw : SMOOTH * raw + (1 - SMOOTH) * prevSmooth;
      const composite = compositeFrom(smoothed, rawComposites);
      const ranked = rawComposites.filter(x => x != null).length >= MIN_WINDOW;
      history.push({
        date: d,
        composite: ranked ? r1(composite) : null,
        label: ranked ? labelFor(composite) : null,
        rawComposite: r1(raw),
        smoothed: smoothed == null ? null : Math.round(smoothed * 1000) / 1000,
        subScores: Object.fromEntries(Object.entries(subScores).map(([k, v]) => [k, r1(v)])),
        inputs: Object.fromEntries(Object.keys(INPUTS).map(k => [k, { raw: r4(raws[k]), score: r1(scores[k]) }])),
        corpLevel: s.corp.get(d) ?? null,
        btc: s.price.get(d) ?? null,
        backfilled: true,
      });
      rawComposites.push(smoothed);
    }
    for (const k of Object.keys(INPUTS)) rawsSoFar[k].push(raws[k]);
  }

  const kept = history.slice(-HISTORY_CAP);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(kept, null, 1) + "\n");
  console.log(`Backfill: ${kept.length} days (${kept[0].date} → ${kept.at(-1).date})`);
}

// ── daily run ────────────────────────────────────────────────────────────────

async function daily() {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch {}
  history = history.filter(h => h.inputs && h.smoothed !== undefined); // drop pre-v2 rows
  const date = today();
  history = history.filter(h => h.date !== date);

  let entities = [];
  try { entities = JSON.parse(fs.readFileSync(CORP_ENTITIES_PATH, "utf8")); } catch {}
  const corpNow = entities.length ? await safe("CoinGecko treasuries", () => fetchCorporateLevelNow(entities)) : null;

  const corpHistory = new Map(history.filter(h => h.corpLevel != null).map(h => [h.date, h.corpLevel]));
  if (corpNow != null) corpHistory.set(date, corpNow);

  const [s, context] = await Promise.all([
    loadSeries(addDays(date, -130), { corpHistory }),
    fetchContext(),
  ]);
  const sig = Object.fromEntries(Object.entries(SIGNALS).map(([k, f]) => [k, f(s)]));

  // Latest date each input can be computed for (sources lag differently).
  const latest = k => {
    for (let i = 0; i <= 4; i++) {
      const d = addDays(date, -i);
      const v = sig[k](d);
      if (v != null) return { d, v };
    }
    return null;
  };

  const last = history.at(-1);
  const inputs = {}, raws = {}, scores = {};
  for (const k of Object.keys(INPUTS)) {
    let hit = latest(k), stale = false, asOf = hit?.d ?? null;
    if (!hit && last?.inputs?.[k]?.raw != null) {
      const age = (Date.parse(date) - Date.parse(last.inputs[k].asOf || last.date)) / 86400000;
      if (age <= STALE_DAYS) {
        hit = { v: last.inputs[k].raw };
        stale = true;
        asOf = last.inputs[k].asOf || last.date;
        console.warn(`[warn] ${k}: using last value from ${asOf}`);
      }
    }
    raws[k] = hit ? hit.v : null;
    scores[k] = scoreInput(k, raws[k], history.map(h => h.inputs?.[k]?.raw));
    inputs[k] = { raw: r4(raws[k]), score: r1(scores[k]), asOf, stale, source: stale ? "carried forward" : s.sources[k] };
    if (raws[k] == null) console.warn(`[warn] ${k}: no data — excluded today`);
  }

  const { subScores, raw } = rollUp(scores);
  const prevSmooth = last?.smoothed;
  const smoothed = raw == null ? prevSmooth : prevSmooth == null ? raw : SMOOTH * raw + (1 - SMOOTH) * prevSmooth;
  const composite = compositeFrom(smoothed, history.map(h => h.smoothed));

  // Display extras.
  const latestOf = m => { const d = [...m.keys()].sort().at(-1); return d ? m.get(d) : null; };
  inputs.hashTrend.ma30EH = r1(mean(s.hash, inputs.hashTrend.asOf || date, 30) / (s.sources.hashTrend === "CoinMetrics" ? 1e6 : 1e18));
  inputs.stable30.totalUSD = latestOf(s.stables);
  inputs.exchFlow.exchangeBTC = latestOf(s.exchSupply);
  inputs.corp30.trackedBTC = corpNow;
  inputs.corp30.trackedCompanies = entities.length;

  const btc = latestOf(s.price);
  const snapshot = {
    version: 2,
    generatedAt: new Date().toISOString(),
    date,
    composite: r1(composite),
    label: labelFor(composite),
    rawComposite: r1(raw),
    subScores: Object.fromEntries(Object.entries(subScores).map(([k, v]) => [k, r1(v)])),
    inputs,
    context,
    btcPrice: btc,
    priceCheck: priceCorrelation([...history, { date, composite, btc }]),
  };

  history.push({
    date,
    composite: snapshot.composite,
    label: snapshot.label,
    rawComposite: snapshot.rawComposite,
    smoothed: smoothed == null ? null : Math.round(smoothed * 1000) / 1000,
    subScores: snapshot.subScores,
    inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, { raw: v.raw, score: v.score, asOf: v.asOf, ...(v.stale ? { stale: true } : {}) }])),
    corpLevel: corpNow,
    btc,
  });
  history.sort((a, b) => a.date.localeCompare(b.date));
  history = history.slice(-HISTORY_CAP);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 1) + "\n");

  console.log(`Composite: ${snapshot.composite} (${snapshot.label}) · raw ${snapshot.rawComposite}`);
  console.log("Sub-scores:", snapshot.subScores);
  const pc = snapshot.priceCheck;
  if (pc) console.log(`Price check (last ${pc.days}d): weekly-change corr ${pc.weekly} · level corr ${pc.level}` +
    (Math.abs(pc.weekly) > 0.6 ? "  ⚠ meter is tracking price closely — review inputs" : ""));
}

// Correlation of the composite with BTC price over the last year: weekly change vs weekly log
// return, and level vs level. A guardrail against the meter becoming a price chart.
function priceCorrelation(rows) {
  const r = rows.filter(x => x.composite != null && x.btc).slice(-365);
  if (r.length < 60) return null;
  const corr = (a, b) => {
    const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb);
  };
  const dc = [], dr = [];
  for (let i = 7; i < r.length; i++) { dc.push(r[i].composite - r[i - 7].composite); dr.push(Math.log(r[i].btc / r[i - 7].btc)); }
  return {
    days: r.length,
    weekly: Math.round(corr(dc, dr) * 100) / 100,
    level: Math.round(corr(r.map(x => x.composite), r.map(x => x.btc)) * 100) / 100,
  };
}

(async () => {
  if (process.argv.includes("--backfill")) await backfill();
  await daily();
})().catch(e => { console.error(e); process.exit(1); });
