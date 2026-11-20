const DOMAIN_BY_SLUG = {
  politics: "政治",
  elections: "政治",
  election: "政治",
  geopolitics: "政治",
  world: "政治",
  "us-current-affairs": "政治",
  "us-politics": "政治",
  crypto: "加密",
  weather: "天气",
  sports: "体育",
};

const GENERIC_SLUGS = new Set(["games", "game", "hide", "other", "all"]);
const UNSETTLED_STATUS = new Set(["proposed", "disputed", "reproposed", "pending", "challenged"]);

export function parseAddress(input) {
  const match = String(input || "").match(/0x[a-fA-F0-9]{40}/);
  return match ? match[0].toLowerCase() : null;
}

export function parseTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const raw = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return parseTime(Number(raw));
  let text = raw.replace(" ", "T").replace(/\.(\d{3})\d+/, ".$1");
  if (/[+-]\d{2}$/.test(text)) text += ":00";
  if (text.endsWith("+00:00")) text = `${text.slice(0, -6)}Z`;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function domainFromTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return "";
  for (const tag of tags) {
    const slug = String(tag?.slug || "").trim().toLowerCase();
    if (!slug || GENERIC_SLUGS.has(slug)) continue;
    if (DOMAIN_BY_SLUG[slug]) return DOMAIN_BY_SLUG[slug];
  }
  return "其他";
}

export function domainForMarket(market) {
  return domainFromTags(market?.events?.[0]?.tags) || "";
}

const PRICE_STEP = 0.2;

function priceBucketIndex(price) {
  const milli = Math.round(Number(price) * 1000);
  if (!(milli >= 200)) return 0;
  if (milli <= 1000) return Math.min(4, Math.floor(milli / 200));
  return Math.floor(milli / 200);
}

export function priceBucketLabel(index) {
  if (index <= 0) return "小于 0.20";
  const from = (index * PRICE_STEP).toFixed(2);
  const to = ((index + 1) * PRICE_STEP).toFixed(2);
  return `${from}–${to}`;
}

function winOf(ids, results) {
  const seen = new Set();
  let markets = 0;
  let decided = 0;
  let wins = 0;
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    markets += 1;
    const result = results?.get(id);
    if (!result?.decided) continue;
    decided += 1;
    if (result.win) wins += 1;
  }
  return { markets, decided, wins, winRate: decided > 0 ? wins / decided : null };
}

export function priceExpectation(avgPrice, winRate) {
  if (avgPrice == null || winRate == null) return null;
  return (1 - avgPrice) * winRate - avgPrice * (1 - winRate);
}

export function buyPriceBuckets(trades, results) {
  const buckets = new Map();
  let total = 0;
  for (const trade of trades) {
    if (String(trade.side || "").toUpperCase() !== "BUY") continue;
    const size = finite(trade.size);
    const price = finite(trade.price);
    if (!(size > 0)) continue;
    const usdc = price * size;
    const index = priceBucketIndex(price);
    const bucket = buckets.get(index) || { usdc: 0, count: 0, shares: 0, ids: [], fills: [] };
    bucket.usdc += usdc;
    bucket.count += 1;
    bucket.shares += size;
    const id = String(trade.conditionId || "").toLowerCase();
    bucket.ids.push(id);
    if (usdc > DUST) bucket.fills.push({ amount: usdc, shares: size, id });
    buckets.set(index, bucket);
    total += usdc;
  }
  const highest = buckets.size ? Math.max(...buckets.keys()) : 0;
  const last = Math.max(4, highest);
  const rows = [];
  for (let index = 0; index <= last; index += 1) {
    const bucket = buckets.get(index) || { usdc: 0, count: 0, shares: 0, ids: [], fills: [] };
    const avgPrice = bucket.shares > DUST ? bucket.usdc / bucket.shares : null;
    const outcome = winOf(bucket.ids, results);
    rows.push({
      label: priceBucketLabel(index),
      usdc: bucket.usdc,
      count: bucket.count,
      shares: bucket.shares,
      avgPrice,
      share: total > DUST ? bucket.usdc / total : 0,
      amounts: shareBuckets(bucket.fills, results),
      ...outcome,
      expectation: priceExpectation(avgPrice, outcome.winRate),
    });
  }
  return rows;
}

const AMOUNT_LABELS = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];

function amountShareIndex(amount, max) {
  if (!(max > DUST)) return 0;
  const milli = Math.round((amount / max) * 1000);
  if (milli >= 1000) return 4;
  return Math.min(4, Math.floor(milli / 200));
}

function shareBuckets(entries, results) {
  const max = entries.reduce((best, entry) => Math.max(best, entry.amount), 0);
  const groups = [[], [], [], [], []];
  for (const entry of entries) groups[amountShareIndex(entry.amount, max)].push(entry);
  const total = entries.length;
  return AMOUNT_LABELS.map((label, index) => {
    const group = groups[index];
    const sum = group.reduce((totalAmount, entry) => totalAmount + entry.amount, 0);
    const shares = group.reduce((totalShares, entry) => totalShares + (entry.shares || 0), 0);
    const avgPrice = shares > DUST ? sum / shares : null;
    const outcome = winOf(group.map((entry) => entry.id), results);
    return {
      label,
      from: max * index * 0.2,
      to: index === 4 ? max : max * (index + 1) * 0.2,
      count: group.length,
      avgAmount: group.length ? sum / group.length : null,
      avgPrice,
      share: total > 0 ? group.length / total : 0,
      ...outcome,
      expectation: priceExpectation(avgPrice, outcome.winRate),
    };
  });
}

export function buyAmountBuckets(trades, results) {
  const marketTotals = new Map();
  const tradeAmounts = [];
  for (const trade of trades) {
    if (String(trade.side || "").toUpperCase() !== "BUY") continue;
    const size = finite(trade.size);
    const price = finite(trade.price);
    if (!(size > 0)) continue;
    const usdc = price * size;
    if (!(usdc > DUST)) continue;
    const id = String(trade.conditionId || "").toLowerCase();
    tradeAmounts.push({ amount: usdc, shares: size, id });
    const market = marketTotals.get(id) || { amount: 0, shares: 0 };
    market.amount += usdc;
    market.shares += size;
    marketTotals.set(id, market);
  }
  return {
    markets: shareBuckets([...marketTotals].map(([id, total]) => ({ amount: total.amount, shares: total.shares, id })), results),
    trades: shareBuckets(tradeAmounts, results),
  };
}

export function tradesWithinDays(trades, days, nowSeconds = Date.now() / 1000) {
  if (!(days > 0)) return trades;
  const cutoff = nowSeconds - days * 86400;
  return trades.filter((trade) => {
    const time = Number(trade.timestamp);
    return Number.isFinite(time) && time >= cutoff;
  });
}

export function tradesAboveNotional(trades, minimum, maximum) {
  const hasMin = minimum != null && Number.isFinite(Number(minimum));
  const hasMax = maximum != null && Number.isFinite(Number(maximum));
  if (!hasMin && !hasMax) return trades;
  const low = hasMin ? Number(minimum) : null;
  const high = hasMax ? Number(maximum) : null;
  return trades.filter((trade) => {
    if (String(trade.side || "").toUpperCase() !== "BUY") return false;
    const amount = Number(trade.price) * Number(trade.size);
    if (!Number.isFinite(amount)) return false;
    if (low != null && !(amount > low)) return false;
    if (high != null && !(amount < high)) return false;
    return true;
  });
}

export function marketDomain(marketInfo, conditionId) {
  const id = String(conditionId || "").toLowerCase();
  const info = !marketInfo
    ? null
    : typeof marketInfo.get === "function"
      ? marketInfo.get(id) || null
      : marketInfo[id] || null;
  return info?.domain || "";
}

export function settlementOf(market) {
  if (!market) return { settled: false, settledAt: null };
  const status = String(market.umaResolutionStatus || "").toLowerCase();
  const settledAt = parseTime(market.closedTime) || parseTime(market.umaEndDate) || parseTime(market.endDate);
  if (status === "resolved") return { settled: true, settledAt };
  if (UNSETTLED_STATUS.has(status)) return { settled: false, settledAt: null };
  if (market.closed === true && parseTime(market.closedTime)) {
    return { settled: true, settledAt: parseTime(market.closedTime) };
  }
  return { settled: false, settledAt: null };
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function resolvedOutcome(market, settled) {
  if (!settled || !market) return "";
  const outcomes = parseList(market.outcomes);
  const prices = parseList(market.outcomePrices).map((price) => Number(price));
  if (outcomes.length === 0 || outcomes.length !== prices.length) return "";
  let best = 0;
  for (let index = 1; index < prices.length; index += 1) {
    if (prices[index] > prices[best]) best = index;
  }
  if (!(prices[best] >= 0.99)) return "";
  return String(outcomes[best] || "");
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

const SHANGHAI_OFFSET = 8 * 3600;
const DUST = 1e-8;

function dayKey(timestamp) {
  return Math.floor((timestamp + SHANGHAI_OFFSET) / 86400);
}

function takeCost(lot, take) {
  if (lot.size <= take + DUST) return lot.cost;
  return lot.cost * (take / lot.size);
}

function scoreMarkets(rows, infoOf) {
  const tokens = new Map();
  const activeDays = new Set();
  for (const trade of rows) {
    activeDays.add(dayKey(trade.timestamp));
    const key = trade.tokenId || `${trade.conditionId}:${trade.outcome}`;
    let token = tokens.get(key);
    if (!token) {
      token = {
        conditionId: trade.conditionId,
        outcome: trade.outcome || "",
        lots: [],
        events: [],
        buyCost: 0,
        buyShares: 0,
        notional: 0,
        holdSeconds: 0,
        holdShares: 0,
        unmatched: 0,
        lastTimestamp: trade.timestamp,
        title: trade.title || "",
        slug: trade.slug || "",
        eventSlug: trade.eventSlug || "",
      };
      tokens.set(key, token);
    }
    token.lastTimestamp = trade.timestamp;
    if (!token.title && trade.title) token.title = trade.title;
    if (!token.slug && trade.slug) token.slug = trade.slug;
    if (!token.eventSlug && trade.eventSlug) token.eventSlug = trade.eventSlug;
    if (!token.outcome && trade.outcome) token.outcome = trade.outcome;
    if (trade.side === "BUY") {
      const cost = trade.price * trade.size;
      token.lots.push({ size: trade.size, cost, timestamp: trade.timestamp });
      token.buyCost += cost;
      token.buyShares += trade.size;
      token.notional += cost;
      continue;
    }
    token.notional += trade.price * trade.size;
    let remaining = trade.size;
    let proceeds = 0;
    let cost = 0;
    while (remaining > DUST && token.lots.length > 0) {
      const lot = token.lots[0];
      const take = Math.min(lot.size, remaining);
      const costTake = takeCost(lot, take);
      proceeds += trade.price * take;
      cost += costTake;
      token.holdSeconds += Math.max(0, trade.timestamp - lot.timestamp) * take;
      token.holdShares += take;
      lot.size -= take;
      lot.cost -= costTake;
      remaining -= take;
      if (lot.size <= DUST) token.lots.shift();
    }
    token.unmatched += Math.max(0, remaining);
    if (proceeds > 0 || cost > 0) token.events.push({ day: dayKey(trade.timestamp), pnl: proceeds - cost });
  }

  const markets = new Map();
  for (const token of tokens.values()) {
    let market = markets.get(token.conditionId);
    if (!market) {
      market = {
        conditionId: token.conditionId,
        title: token.title,
        slug: token.slug,
        eventSlug: token.eventSlug,
        buyCost: 0,
        buyShares: 0,
        notional: 0,
        holdSeconds: 0,
        holdShares: 0,
        events: [],
        open: false,
        unmatched: 0,
      };
      markets.set(token.conditionId, market);
    }
    if (!market.title && token.title) market.title = token.title;
    if (!market.slug && token.slug) market.slug = token.slug;
    if (!market.eventSlug && token.eventSlug) market.eventSlug = token.eventSlug;
    market.buyCost += token.buyCost;
    market.buyShares += token.buyShares;
    market.notional += token.notional;
    market.holdSeconds += token.holdSeconds;
    market.holdShares += token.holdShares;
    market.unmatched += token.unmatched;
    market.events.push(...token.events);
    const shares = token.lots.reduce((sum, lot) => sum + lot.size, 0);
    const cost = token.lots.reduce((sum, lot) => sum + lot.cost, 0);
    if (shares <= DUST) continue;
    const info = infoOf(token.conditionId);
    const result = info?.settled ? String(info.result || "") : "";
    if (info?.settled && result && token.outcome) {
      const payout = token.outcome === result ? shares : 0;
      const when = info.settledAt ?? token.lastTimestamp;
      market.events.push({ day: dayKey(when), pnl: payout - cost });
      if (info.settledAt != null) {
        for (const lot of token.lots) {
          if (lot.size <= DUST || lot.timestamp > info.settledAt) continue;
          market.holdSeconds += (info.settledAt - lot.timestamp) * lot.size;
          market.holdShares += lot.size;
        }
      }
    } else {
      market.open = true;
    }
  }

  const byDomain = new Map();
  const decidedMarkets = [];
  let open = 0;
  for (const market of markets.values()) {
    const info = infoOf(market.conditionId);
    market.domain = info?.domain || "";
    market.pnl = market.events.reduce((sum, event) => sum + event.pnl, 0);
    if (market.open || market.buyCost <= DUST) {
      if (market.open) open += 1;
      continue;
    }
    decidedMarkets.push(market);
    let score = byDomain.get(market.domain);
    if (!score) {
      score = { decided: 0, wins: 0 };
      byDomain.set(market.domain, score);
    }
    score.decided += 1;
    if (market.pnl > DUST) score.wins += 1;
  }

  const marketResults = new Map();
  for (const market of markets.values()) {
    const decided = !market.open && market.buyCost > DUST;
    marketResults.set(market.conditionId, { decided, win: decided && market.pnl > DUST });
  }

  const wins = decidedMarkets.filter((market) => market.pnl > DUST);
  const losses = decidedMarkets.filter((market) => market.pnl < -DUST);
  const breakeven = decidedMarkets.length - wins.length - losses.length;
  const grossProfit = wins.reduce((sum, market) => sum + market.pnl, 0);
  const grossLoss = losses.reduce((sum, market) => sum - market.pnl, 0);
  const pnl = decidedMarkets.reduce((sum, market) => sum + market.pnl, 0);
  const cost = decidedMarkets.reduce((sum, market) => sum + market.buyCost, 0);
  const dayPnl = new Map();
  for (const market of decidedMarkets) {
    for (const event of market.events) dayPnl.set(event.day, (dayPnl.get(event.day) || 0) + event.pnl);
  }
  let sharpe = null;
  let sortino = null;
  let sampleDays = 0;
  if (dayPnl.size > 0) {
    const keys = [...dayPnl.keys()];
    const first = Math.min(...keys);
    const last = Math.max(...keys);
    const series = [];
    for (let day = first; day <= last; day += 1) series.push(dayPnl.get(day) || 0);
    sampleDays = series.length;
    if (series.length >= 2) {
      const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
      const variance = series.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (series.length - 1);
      const deviation = Math.sqrt(variance);
      const annual = Math.sqrt(365);
      if (deviation > DUST) sharpe = (mean / deviation) * annual;
      const downside = Math.sqrt(series.reduce((sum, value) => sum + Math.min(value, 0) ** 2, 0) / series.length);
      if (downside > DUST) sortino = (mean / downside) * annual;
    }
  }

  const topWinners = wins
    .sort((a, b) => b.pnl - a.pnl || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, 10)
    .map((market) => ({
      conditionId: market.conditionId,
      title: market.title,
      slug: market.slug,
      eventSlug: market.eventSlug,
      domain: market.domain,
      pnl: market.pnl,
      share: grossProfit > DUST ? market.pnl / grossProfit : 0,
      avgBuyCost: market.buyShares > DUST ? market.buyCost / market.buyShares : null,
      avgHoldDays: market.holdShares > DUST ? market.holdSeconds / market.holdShares / 86400 : null,
    }));

  const traded = [...markets.values()].filter((market) => market.notional > DUST);
  const totalNotional = traded.reduce((sum, market) => sum + market.notional, 0);
  const topVolume = traded
    .sort((a, b) => b.notional - a.notional || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, 10)
    .map((market) => ({
      conditionId: market.conditionId,
      title: market.title,
      slug: market.slug,
      eventSlug: market.eventSlug,
      domain: market.domain,
      notional: market.notional,
      share: totalNotional > DUST ? market.notional / totalNotional : 0,
      pnl: !market.open && market.buyCost > DUST ? market.pnl : null,
      avgBuyCost: market.buyShares > DUST ? market.buyCost / market.buyShares : null,
      avgHoldDays: market.holdShares > DUST ? market.holdSeconds / market.holdShares / 86400 : null,
    }));

  return {
    byDomain,
    activeDays: activeDays.size,
    firstTradeAt: rows.length ? rows[0].timestamp : null,
    decided: decidedMarkets.length,
    open,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    pnl,
    cost,
    returnRate: cost > DUST ? pnl / cost : null,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    payoffRatio: wins.length && losses.length ? (grossProfit / wins.length) / (grossLoss / losses.length) : null,
    expectancy: decidedMarkets.length ? pnl / decidedMarkets.length : null,
    profitFactor: grossLoss > DUST ? grossProfit / grossLoss : null,
    grossProfit,
    grossLoss,
    sharpe,
    sortino,
    sampleDays,
    topWinners,
    topVolume,
    marketResults,
  };
}

export function computeReport(trades, marketInfo) {
  const rows = trades.map((trade) => ({
    conditionId: String(trade.conditionId || "").toLowerCase(),
    tokenId: String(trade.tokenId || ""),
    side: String(trade.side || "").toUpperCase(),
    size: finite(trade.size),
    price: finite(trade.price),
    timestamp: finite(trade.timestamp),
    title: trade.title || "",
    outcome: trade.outcome || "",
    slug: trade.slug || "",
    eventSlug: trade.eventSlug || "",
  })).filter((trade) => trade.conditionId && trade.size > 0 && (trade.side === "BUY" || trade.side === "SELL"));

  const sideRank = { BUY: 0, SELL: 1 };
  rows.sort((a, b) => a.timestamp - b.timestamp || sideRank[a.side] - sideRank[b.side]);

  const infoOf = (conditionId) => {
    if (!marketInfo) return null;
    if (typeof marketInfo.get === "function") return marketInfo.get(conditionId) || null;
    return marketInfo[conditionId] || null;
  };

  const buys = { count: 0, shares: 0, usdc: 0 };
  const sells = { count: 0, shares: 0, usdc: 0 };
  const conditions = new Map();
  const inventories = new Map();
  let holdSecondsWeighted = 0;
  let holdShares = 0;

  for (const trade of rows) {
    const bucket = trade.side === "BUY" ? buys : sells;
    bucket.count += 1;
    bucket.shares += trade.size;
    bucket.usdc += trade.price * trade.size;

    let market = conditions.get(trade.conditionId);
    if (!market) {
      market = { buys: [], sells: [], title: trade.title };
      conditions.set(trade.conditionId, market);
    }
    if (!market.title && trade.title) market.title = trade.title;
    (trade.side === "BUY" ? market.buys : market.sells).push(trade.timestamp);

    const tokenKey = trade.tokenId || `${trade.conditionId}:${trade.outcome}`;
    let inventory = inventories.get(tokenKey);
    if (!inventory) {
      inventory = { conditionId: trade.conditionId, lots: [], unmatched: 0 };
      inventories.set(tokenKey, inventory);
    }
    if (trade.side === "BUY") {
      inventory.lots.push({ timestamp: trade.timestamp, size: trade.size });
      continue;
    }
    let remaining = trade.size;
    while (remaining > 1e-8 && inventory.lots.length > 0) {
      const lot = inventory.lots[0];
      const take = Math.min(lot.size, remaining);
      holdSecondsWeighted += Math.max(0, trade.timestamp - lot.timestamp) * take;
      holdShares += take;
      lot.size -= take;
      remaining -= take;
      if (lot.size <= 1e-8) inventory.lots.shift();
    }
    inventory.unmatched += Math.max(0, remaining);
  }

  let openShares = 0;
  let unmatchedSellShares = 0;
  let boughtAfterShares = 0;

  for (const inventory of inventories.values()) {
    unmatchedSellShares += inventory.unmatched;
    const info = infoOf(inventory.conditionId);
    for (const lot of inventory.lots) {
      if (lot.size <= 1e-8) continue;
      if (info?.settled && info.settledAt != null) {
        if (lot.timestamp <= info.settledAt) {
          holdSecondsWeighted += (info.settledAt - lot.timestamp) * lot.size;
          holdShares += lot.size;
        } else {
          boughtAfterShares += lot.size;
        }
      } else if (info && !info.settled) {
        openShares += lot.size;
      }
    }
  }

  let settled = 0;
  let qualified = 0;
  let soldBeforeSettlement = 0;
  let noBuy = 0;
  let boughtAfter = 0;
  let unknown = 0;
  const domainCounts = new Map();
  const domainByCondition = new Map();

  for (const [conditionId, market] of conditions) {
    const info = infoOf(conditionId);
    const domain = marketDomain(marketInfo, conditionId);
    domainByCondition.set(conditionId, domain);
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    if (!info) {
      unknown += 1;
      continue;
    }
    if (!info.settled) continue;
    settled += 1;
    if (market.buys.length === 0) {
      noBuy += 1;
      continue;
    }
    const firstBuy = Math.min(...market.buys);
    if (info.settledAt != null && firstBuy > info.settledAt) {
      boughtAfter += 1;
      continue;
    }
    const sold = market.sells.some((timestamp) => timestamp >= firstBuy && (info.settledAt == null || timestamp <= info.settledAt));
    if (sold) soldBeforeSettlement += 1;
    else qualified += 1;
  }

  for (const trade of rows) {
    const info = infoOf(trade.conditionId);
    trade.result = info?.settled ? String(info.result || "") : "";
  }

  const tradesByDomain = new Map();
  for (const trade of rows) {
    const domain = domainByCondition.get(trade.conditionId) || "";
    let list = tradesByDomain.get(domain);
    if (!list) {
      list = [];
      tradesByDomain.set(domain, list);
    }
    list.push(trade);
  }
  for (const list of tradesByDomain.values()) {
    list.sort((a, b) => b.timestamp - a.timestamp || sideRank[b.side] - sideRank[a.side]);
  }

  const performance = scoreMarkets(rows, infoOf);
  const priceBuckets = buyPriceBuckets(rows, performance.marketResults);
  const amountBuckets = buyAmountBuckets(rows, performance.marketResults);
  delete performance.marketResults;
  const marketCount = conditions.size;
  const categories = [...domainCounts.entries()]
    .map(([name, count]) => {
      const score = performance.byDomain.get(name) || { decided: 0, wins: 0 };
      return {
        name,
        count,
        share: marketCount === 0 ? 0 : count / marketCount,
        trades: tradesByDomain.get(name) || [],
        decided: score.decided,
        wins: score.wins,
        winRate: score.decided > 0 ? score.wins / score.decided : null,
      };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  delete performance.byDomain;

  return {
    marketCount,
    categories,
    buys,
    sells,
    avgBuyCost: buys.shares > 0 ? buys.usdc / buys.shares : null,
    avgBuyAmount: buys.count > 0 ? buys.usdc / buys.count : null,
    priceBuckets,
    amountBuckets,
    avgHoldSeconds: holdShares > 0 ? holdSecondsWeighted / holdShares : null,
    holdShares,
    openShares,
    unmatchedSellShares,
    boughtAfterShares,
    holdToSettlement: {
      qualified,
      settled,
      soldBeforeSettlement,
      noBuy,
      boughtAfter,
      unknown,
    },
    performance,
  };
}
