import { readFile, writeFile } from "node:fs/promises";

const API_KEY = process.env.FMP_API_KEY;
const OUTPUT = new URL("../data/market.json", import.meta.url);
const SYMBOLS = [
  "APH", "FN", "CLS", "SNDK", "POWL", "FIX", "EME",
  "NVDA", "AVGO", "VST", "CEG", "NVT", "ETN", "TER", "SYM", "MU",
  "ASML", "VRT", "MOD", "CCJ", "MP", "KTOS", "AVAV", "TEM", "ISRG",
  "WMS", "XYL", "UEC", "TMDX", "NXE", "BSX"
];

if (!API_KEY) {
  throw new Error("FMP_API_KEY is missing. Add it as a GitHub Actions repository secret.");
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

async function fmp(endpoint, symbol) {
  const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", API_KEY);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "structural-scarcity-report/1.0" }
  });
  if (!response.ok) throw new Error(`${endpoint} ${symbol}: HTTP ${response.status}`);
  const body = await response.json();
  if (body?.["Error Message"]) throw new Error(`${endpoint} ${symbol}: ${body["Error Message"]}`);
  return Array.isArray(body) ? body[0] : body;
}

function normalizeConsensus(raw, counts) {
  const supplied = String(
    raw?.consensus ?? raw?.ratingRecommendation ?? raw?.recommendation ?? ""
  ).trim();
  if (supplied) {
    const value = supplied.toLowerCase().replaceAll("_", " ");
    if (value.includes("strong") && value.includes("buy")) return "Strong Buy";
    if (value.includes("buy")) return "Buy";
    if (value.includes("sell")) return value.includes("strong") ? "Strong Sell" : "Sell";
    if (value.includes("hold") || value.includes("neutral")) return "Hold";
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!total) return "Not rated";
  const buyRatio = (counts.strongBuy + counts.buy) / total;
  const sellRatio = (counts.strongSell + counts.sell) / total;
  if (buyRatio >= 0.8) return "Strong Buy";
  if (buyRatio >= 0.55) return "Buy";
  if (sellRatio >= 0.55) return "Sell";
  return "Hold";
}

function evidenceScore(counts, upside) {
  const coverage = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const buyRatio = coverage ? (counts.strongBuy + counts.buy) / coverage : 0;
  const ratingPoints =
    buyRatio >= 0.8 ? 5 : buyRatio >= 0.65 ? 4 : buyRatio >= 0.5 ? 3 : buyRatio >= 0.35 ? 2 : coverage ? 1 : 0;
  const upsidePoints = upside >= 30 ? 3 : upside >= 15 ? 2 : upside >= 0 ? 1 : 0;
  const coveragePoints = coverage >= 10 ? 2 : coverage >= 4 ? 1 : 0;
  return Math.min(10, ratingPoints + upsidePoints + coveragePoints);
}

async function fetchStock(symbol) {
  const [quote, target, grades] = await Promise.all([
    fmp("quote", symbol),
    fmp("price-target-consensus", symbol),
    fmp("grades-consensus", symbol)
  ]);

  const price = finite(quote?.price);
  const consensusTarget = finite(
    target?.targetConsensus ?? target?.consensus ?? target?.priceTargetAverage ?? target?.targetMedian
  );
  if (!(price > 0) || !(consensusTarget > 0)) {
    throw new Error(`${symbol}: missing positive price or consensus target`);
  }

  const counts = {
    strongBuy: finite(grades?.strongBuy) ?? finite(grades?.strongBuyCount) ?? 0,
    buy: finite(grades?.buy) ?? finite(grades?.buyCount) ?? 0,
    hold: finite(grades?.hold) ?? finite(grades?.holdCount) ?? 0,
    sell: finite(grades?.sell) ?? finite(grades?.sellCount) ?? 0,
    strongSell: finite(grades?.strongSell) ?? finite(grades?.strongSellCount) ?? 0
  };
  const coverage = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const upside = ((consensusTarget / price) - 1) * 100;
  if (upside < -95 || upside > 500) throw new Error(`${symbol}: implausible upside ${upside}`);

  return {
    symbol,
    name: quote?.name ?? null,
    price: Number(price.toFixed(2)),
    target: Number(consensusTarget.toFixed(2)),
    targetHigh: finite(target?.targetHigh),
    targetLow: finite(target?.targetLow),
    targetMedian: finite(target?.targetMedian),
    upside: Number(upside.toFixed(1)),
    consensus: normalizeConsensus(grades, counts),
    ratingCounts: counts,
    coverage,
    evidenceScore: evidenceScore(counts, upside),
    priceTimestamp: quote?.timestamp
      ? new Date(Number(quote.timestamp) * 1000).toISOString()
      : null
  };
}

const previous = JSON.parse(await readFile(OUTPUT, "utf8"));
const stocks = {};
const errors = [];

for (const symbol of SYMBOLS) {
  try {
    stocks[symbol] = await fetchStock(symbol);
  } catch (error) {
    errors.push(String(error?.message ?? error));
    if (previous.stocks?.[symbol]) {
      stocks[symbol] = { ...previous.stocks[symbol], stale: true };
    }
  }
  await sleep(120);
}

const freshCount = Object.values(stocks).filter(stock => !stock.stale).length;
if (freshCount < Math.ceil(SYMBOLS.length * 0.8)) {
  throw new Error(
    `Feed validation failed: only ${freshCount}/${SYMBOLS.length} symbols refreshed.\n${errors.join("\n")}`
  );
}

const document = {
  schemaVersion: 1,
  status: errors.length ? "partial" : "ok",
  source: {
    name: "Financial Modeling Prep",
    quoteDocs: "https://site.financialmodelingprep.com/developer/docs/stable/quote",
    targetDocs: "https://site.financialmodelingprep.com/developer/docs/stable/price-target-consensus",
    ratingsDocs: "https://site.financialmodelingprep.com/developer/docs/stable/grades-summary"
  },
  lastUpdated: new Date().toISOString(),
  symbolCount: Object.keys(stocks).length,
  freshCount,
  errors,
  stocks
};

await writeFile(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Updated ${freshCount}/${SYMBOLS.length} symbols.`);
