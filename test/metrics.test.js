import test from "node:test";
import assert from "node:assert/strict";
import {
  buyAmountBuckets,
  buyPriceBuckets,
  computeReport,
  domainForMarket,
  tradesAboveNotional,
  tradesWithinDays,
  domainFromTags,
  marketDomain,
  parseAddress,
  parseTime,
  resolvedOutcome,
  settlementOf,
} from "../public/metrics.js";

test("parse address from a profile url", () => {
  assert.equal(parseAddress("https://polymarket.com/profile/0xAbCDEF0123456789abcdef0123456789ABCDEF01"), "0xabcdef0123456789abcdef0123456789abcdef01");
  assert.equal(parseAddress("not an address"), null);
});

test("parse polymarket closed time", () => {
  assert.equal(parseTime("2026-11-08 16:29:18.083135+00"), Math.floor(Date.parse("2026-11-08T16:29:18.083Z") / 1000));
  assert.equal(parseTime(1794149910), 1794149910);
});

test("domain comes only from a gamma category tag", () => {
  assert.equal(domainFromTags([
    { slug: "sports" },
    { slug: "games" },
    { slug: "soccer" },
    { slug: "EPL" },
  ]), "体育");
  assert.equal(domainFromTags([{ slug: "world" }]), "政治");
  assert.equal(domainFromTags([{ slug: "geopolitics" }]), "政治");
  assert.equal(domainFromTags([{ slug: "elections" }]), "政治");
  assert.equal(domainFromTags([{ slug: "crypto" }]), "加密");
  assert.equal(domainFromTags([{ slug: "weather" }]), "天气");
  assert.equal(domainFromTags([{ slug: "soccer" }, { slug: "premier-league" }]), "其他");
  assert.equal(domainFromTags([{ slug: "finance" }]), "其他");
  assert.equal(domainFromTags([{ slug: "taylor-swift", label: "Taylor Swift" }]), "其他");
  assert.equal(domainFromTags([]), "");
  assert.equal(domainForMarket({ sportsMarketType: "moneyline", category: "US-current-affairs" }), "");
  assert.equal(domainForMarket({ tags: [{ slug: "geopolitics" }] }), "");
  assert.equal(domainForMarket({ events: [{ tags: [{ slug: "world" }] }] }), "政治");
  assert.equal(domainForMarket({ events: [{ tags: [{ slug: "finance" }] }] }), "其他");
  assert.equal(domainForMarket({
    tags: [{ slug: "crypto" }],
    events: [{ tags: [{ slug: "games" }, { slug: "sports" }] }],
  }), "体育");
  assert.equal(domainForMarket({ events: [{ tags: [{ slug: "games" }, { slug: "sports" }] }] }), "体育");
});

test("amount filter keeps only buys larger than the threshold", () => {
  const trades = [
    { conditionId: "A", side: "BUY", price: 0.5, size: 10 },
    { conditionId: "A", side: "SELL", price: 0.9, size: 10 },
    { conditionId: "A", side: "BUY", price: 0.2, size: 10 },
    { conditionId: "b", side: "BUY", price: 1, size: 4 },
    { conditionId: "b", side: "SELL", price: 1, size: 5 },
  ];
  const kept = tradesAboveNotional(trades, 4);
  assert.deepEqual(kept.map((trade) => [trade.conditionId, trade.side]), [["A", "BUY"]]);
  assert.equal(tradesAboveNotional(trades, 5).length, 0);
  assert.equal(tradesAboveNotional(trades, 0), trades);
});

test("a time window drops fills outside it and keeps the recent fill in the same market", () => {
  const now = 1_000_000;
  const day = 86400;
  const trades = [
    { conditionId: "A", timestamp: now - 10 * day },
    { conditionId: "A", timestamp: now - 40 * day },
    { conditionId: "B", timestamp: now - 40 * day },
    { conditionId: "C", timestamp: now },
    { conditionId: "D" },
  ];
  assert.deepEqual(tradesWithinDays(trades, 30, now).map((trade) => trade.conditionId), ["A", "C"]);
  assert.equal(tradesWithinDays(trades, 0, now), trades);
  assert.equal(tradesWithinDays([{ conditionId: "E", timestamp: now - 30 * day }], 30, now).length, 1);
  assert.equal(tradesWithinDays([{ conditionId: "F", timestamp: now - 30 * day - 1 }], 30, now).length, 0);
});

test("buy amount is grouped by price in steps of 0.2", () => {
  const trades = [
    { side: "BUY", price: 0.19, size: 10 },
    { side: "BUY", price: 0.2, size: 10 },
    { side: "BUY", price: 0.4, size: 5 },
    { side: "BUY", price: 1, size: 4 },
    { side: "BUY", price: 1.2, size: 1 },
    { side: "SELL", price: 0.5, size: 100 },
  ];
  const rows = buyPriceBuckets(trades);
  const byLabel = new Map(rows.map((row) => [row.label, row]));
  assert.equal(byLabel.get("小于 0.20").count, 1);
  assert.ok(Math.abs(byLabel.get("小于 0.20").usdc - 1.9) < 1e-9);
  assert.equal(byLabel.get("0.20–0.40").count, 1);
  assert.ok(Math.abs(byLabel.get("0.20–0.40").usdc - 2) < 1e-9);
  assert.equal(byLabel.get("0.40–0.60").count, 1);
  assert.equal(byLabel.get("0.60–0.80").count, 0);
  assert.equal(byLabel.get("0.80–1.00").count, 1);
  assert.ok(Math.abs(byLabel.get("0.80–1.00").usdc - 4) < 1e-9);
  assert.equal(byLabel.get("1.00–1.20").count, 0);
  assert.equal(byLabel.get("1.20–1.40").count, 1);
  const total = 1.9 + 2 + 2 + 4 + 1.2;
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.usdc, 0) - total) < 1e-9);
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
});

test("price band average is weighted by shares", () => {
  const rows = buyPriceBuckets([
    { side: "BUY", price: 0.1, size: 10 },
    { side: "BUY", price: 0.15, size: 30 },
    { side: "SELL", price: 0.1, size: 100 },
  ]);
  const low = rows.find((row) => row.label === "小于 0.20");
  const empty = rows.find((row) => row.label === "0.20–0.40");
  assert.ok(Math.abs(low.avgPrice - 0.1375) < 1e-9);
  assert.equal(empty.avgPrice, null);
});

test("buy amount bands are 20 percent of the largest buy", () => {
  const trades = [
    { conditionId: "A", side: "BUY", price: 0.5, size: 40 },
    { conditionId: "A", side: "BUY", price: 0.5, size: 160 },
    { conditionId: "B", side: "BUY", price: 1, size: 20 },
    { conditionId: "C", side: "BUY", price: 1, size: 100 },
    { conditionId: "E", side: "BUY", price: 1, size: 10 },
    { conditionId: "D", side: "SELL", price: 1, size: 500 },
  ];
  const buckets = buyAmountBuckets(trades);
  const markets = new Map(buckets.markets.map((row) => [row.label, row]));
  const fills = new Map(buckets.trades.map((row) => [row.label, row]));
  assert.equal(markets.get("0–20%").count, 1);
  assert.equal(markets.get("20–40%").count, 1);
  assert.equal(markets.get("80–100%").count, 2);
  assert.ok(Math.abs(markets.get("80–100%").to - 100) < 1e-9);
  assert.equal(fills.get("0–20%").count, 1);
  assert.equal(fills.get("20–40%").count, 2);
  assert.equal(fills.get("80–100%").count, 2);
  assert.equal(buckets.markets.reduce((sum, row) => sum + row.count, 0), 4);
  assert.equal(buckets.trades.reduce((sum, row) => sum + row.count, 0), 5);
  assert.ok(Math.abs(buckets.trades.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs(markets.get("0–20%").avgAmount - 10) < 1e-9);
  assert.ok(Math.abs(markets.get("80–100%").avgAmount - 100) < 1e-9);
  assert.equal(markets.get("40–60%").avgAmount, null);
  assert.ok(Math.abs(fills.get("20–40%").avgAmount - 20) < 1e-9);
  assert.ok(Math.abs(fills.get("80–100%").avgAmount - 90) < 1e-9);
});

test("bucket win rate counts each decided market once", () => {
  const trades = [
    { conditionId: "A", side: "BUY", price: 0.1, size: 10 },
    { conditionId: "A", side: "BUY", price: 0.9, size: 10 },
    { conditionId: "B", side: "BUY", price: 0.9, size: 100 },
    { conditionId: "C", side: "BUY", price: 0.9, size: 100 },
  ];
  const results = new Map([
    ["a", { decided: true, win: true }],
    ["b", { decided: true, win: false }],
    ["c", { decided: false, win: false }],
  ]);
  const prices = buyPriceBuckets(trades, results);
  const low = prices.find((row) => row.label === "小于 0.20");
  const high = prices.find((row) => row.label === "0.80–1.00");
  assert.equal(low.markets, 1);
  assert.equal(low.wins, 1);
  assert.equal(low.decided, 1);
  assert.equal(high.markets, 3);
  assert.equal(high.decided, 2);
  assert.equal(high.wins, 1);
  const amounts = buyAmountBuckets(trades, results);
  const marketLow = amounts.markets.find((row) => row.label === "0–20%");
  const marketHigh = amounts.markets.find((row) => row.label === "80–100%");
  assert.equal(marketLow.wins, 1);
  assert.equal(marketLow.decided, 1);
  assert.equal(marketHigh.markets, 2);
  assert.equal(marketHigh.decided, 1);
  assert.equal(marketHigh.wins, 0);
  const tradeHigh = amounts.trades.find((row) => row.label === "80–100%");
  assert.equal(tradeHigh.count, 2);
  assert.equal(tradeHigh.markets, 2);
  assert.equal(tradeHigh.decided, 1);
  assert.equal(tradeHigh.wins, 0);
});

test("legacy closed markets count as settled, proposed markets do not", () => {
  assert.equal(settlementOf({ umaResolutionStatus: "resolved", closedTime: "2026-11-08 16:29:18+00" }).settled, true);
  assert.equal(settlementOf({ umaResolutionStatus: "proposed", closed: true, closedTime: "2026-11-08 16:29:18+00" }).settled, false);
  assert.equal(settlementOf({ closed: true, closedTime: "2020-11-02 16:31:01+00" }).settled, true);
  assert.equal(settlementOf({ closed: false }).settled, false);
});

test("metrics over a known book of trades", () => {
  const info = new Map([
    ["a", { domain: "体育", settled: true, settledAt: 1000 }],
    ["b", { domain: "政治", settled: true, settledAt: 500 }],
    ["c", { domain: "加密", settled: false, settledAt: null }],
    ["d", { domain: "体育", settled: true, settledAt: 500 }],
    ["e", { domain: "金融", settled: true, settledAt: 500 }],
    ["f", { domain: "科技", settled: true, settledAt: 100 }],
  ]);
  const trades = [
    { conditionId: "a", tokenId: "a-yes", side: "BUY", size: 10, price: 0.4, timestamp: 100 },
    { conditionId: "a", tokenId: "a-yes", side: "BUY", size: 10, price: 0.6, timestamp: 200 },
    { conditionId: "a", tokenId: "a-yes", side: "SELL", size: 10, price: 0.8, timestamp: 300 },
    { conditionId: "b", tokenId: "b-yes", side: "BUY", size: 5, price: 0.2, timestamp: 100 },
    { conditionId: "d", tokenId: "d-yes", side: "SELL", size: 2, price: 0.5, timestamp: 50 },
    { conditionId: "d", tokenId: "d-yes", side: "BUY", size: 4, price: 0.3, timestamp: 100 },
    { conditionId: "c", tokenId: "c-yes", side: "BUY", size: 7, price: 0.9, timestamp: 100 },
    { conditionId: "e", tokenId: "e-yes", side: "BUY", size: 3, price: 0.5, timestamp: 100 },
    { conditionId: "e", tokenId: "e-yes", side: "SELL", size: 3, price: 1, timestamp: 600 },
    { conditionId: "f", tokenId: "f-yes", side: "BUY", size: 8, price: 0.25, timestamp: 200 },
    { conditionId: "b", tokenId: "b-no", side: "SELL", size: 1, price: 0.4, timestamp: 150 },
  ];

  const report = computeReport(trades, info);

  assert.equal(report.buys.count, 7);
  assert.equal(report.sells.count, 4);
  assert.equal(report.buys.shares, 47);
  assert.equal(report.sells.shares, 16);
  assert.ok(Math.abs(report.buys.usdc - 22) < 1e-9);
  assert.ok(Math.abs(report.avgBuyCost - 22 / 47) < 1e-9);
  assert.ok(Math.abs(report.avgBuyAmount - 22 / 7) < 1e-9);

  // A sell matches the first lot: 10 * 200s. The other 10 shares are held to 1000: 10 * 800s.
  // B's No sell is another token, so the 5 Yes shares are held to 500: 5 * 400s.
  // D's early sell has no lot. The later 4 shares are held to 500: 4 * 400s.
  // E is sold after settlement: 3 * 500s. F is bought after settlement and stays out.
  const weighted = 10 * 200 + 10 * 800 + 5 * 400 + 4 * 400 + 3 * 500;
  const weight = 32;
  assert.ok(Math.abs(report.avgHoldSeconds - weighted / weight) < 1e-9);
  assert.ok(Math.abs(report.holdShares - weight) < 1e-9);
  assert.ok(Math.abs(report.openShares - 7) < 1e-9);
  assert.ok(Math.abs(report.unmatchedSellShares - 3) < 1e-9);
  assert.ok(Math.abs(report.boughtAfterShares - 8) < 1e-9);

  assert.equal(report.holdToSettlement.settled, 5);
  assert.equal(report.holdToSettlement.qualified, 2);
  assert.equal(report.holdToSettlement.soldBeforeSettlement, 2);
  assert.equal(report.holdToSettlement.boughtAfter, 1);
  assert.equal(report.holdToSettlement.noBuy, 0);
  const sports = report.categories.find((item) => item.name === "体育");
  assert.equal(sports.count, 2);
  assert.equal(sports.trades.length, 5);
  assert.equal(sports.trades[0].timestamp, 300);
  assert.equal(sports.trades[0].side, "SELL");
  assert.equal(report.categories.find((item) => item.name === "政治").trades.length, 2);
  assert.equal(report.categories.reduce((sum, item) => sum + item.count, 0), 6);
});

test("a partial sell before settlement is not hold-to-settlement", () => {
  const info = new Map([["a", { domain: "体育", settled: true, settledAt: 1000 }]]);
  const report = computeReport([
    { conditionId: "a", tokenId: "a", side: "BUY", size: 10, price: 0.4, timestamp: 100 },
    { conditionId: "a", tokenId: "a", side: "SELL", size: 1, price: 0.5, timestamp: 200 },
  ], info);
  assert.equal(report.holdToSettlement.qualified, 0);
  assert.equal(report.holdToSettlement.soldBeforeSettlement, 1);
});

test("resolved outcome is the winning token, and unsettled markets stay blank", () => {
  const market = { outcomes: "[\"Yes\", \"No\"]", outcomePrices: "[\"1\", \"0\"]" };
  assert.equal(resolvedOutcome(market, true), "Yes");
  assert.equal(resolvedOutcome(market, false), "");
  assert.equal(resolvedOutcome({ outcomes: "[\"Yes\", \"No\"]", outcomePrices: "[\"0\", \"0\"]" }, true), "");
});

test("trade rows carry the market result only after settlement", () => {
  const info = new Map([
    ["a", { domain: "体育", settled: true, settledAt: 1000, result: "Yes" }],
    ["c", { domain: "加密", settled: false, settledAt: null, result: "Yes" }],
  ]);
  const report = computeReport([
    { conditionId: "a", tokenId: "a", side: "BUY", size: 1, price: 0.4, timestamp: 100, outcome: "Yes" },
    { conditionId: "c", tokenId: "c", side: "BUY", size: 1, price: 0.4, timestamp: 100, outcome: "No" },
  ], info);
  assert.equal(report.categories.find((item) => item.name === "体育").trades[0].result, "Yes");
  assert.equal(report.categories.find((item) => item.name === "加密").trades[0].result, "");
});

test("closed markets score profit, win rate, and daily risk ratios", () => {
  const day = 1_728_000_000;
  const info = new Map([
    ["win", { domain: "体育", settled: true, settledAt: day + 10, result: "Yes" }],
    ["loss", { domain: "政治", settled: true, settledAt: day + 86400 + 10, result: "No" }],
    ["flip", { domain: "体育", settled: false, settledAt: null, result: "" }],
    ["open", { domain: "加密", settled: false, settledAt: null, result: "" }],
  ]);
  const report = computeReport([
    { conditionId: "win", tokenId: "win-yes", outcome: "Yes", side: "BUY", size: 10, price: 0.4, timestamp: day, title: "Win market" },
    { conditionId: "win", tokenId: "win-yes", outcome: "Yes", side: "SELL", size: 4, price: 0.8, timestamp: day + 1, title: "Win market" },
    { conditionId: "loss", tokenId: "loss-yes", outcome: "Yes", side: "BUY", size: 10, price: 0.3, timestamp: day + 86400, title: "Loss market" },
    { conditionId: "flip", tokenId: "flip-yes", outcome: "Yes", side: "BUY", size: 10, price: 0.4, timestamp: day + 2, title: "Flip" },
    { conditionId: "flip", tokenId: "flip-yes", outcome: "Yes", side: "SELL", size: 10, price: 0.7, timestamp: day + 3, title: "Flip" },
    { conditionId: "open", tokenId: "open-yes", outcome: "Yes", side: "BUY", size: 5, price: 0.5, timestamp: day + 4, title: "Open" },
  ], info);
  const perf = report.performance;

  assert.ok(Math.abs(perf.pnl - 5.2) < 1e-9);
  assert.equal(perf.decided, 3);
  assert.equal(perf.wins, 2);
  assert.equal(perf.losses, 1);
  assert.equal(perf.open, 1);
  assert.equal(perf.activeDays, 2);
  assert.equal(perf.firstTradeAt, day);
  assert.ok(Math.abs(perf.grossProfit - 8.2) < 1e-9);
  assert.ok(Math.abs(perf.grossLoss - 3) < 1e-9);
  assert.ok(Math.abs(perf.avgWin - 4.1) < 1e-9);
  assert.ok(Math.abs(perf.avgLoss - 3) < 1e-9);
  assert.ok(Math.abs(perf.payoffRatio - 4.1 / 3) < 1e-9);
  assert.ok(Math.abs(perf.expectancy - 5.2 / 3) < 1e-9);
  assert.ok(Math.abs(perf.profitFactor - 8.2 / 3) < 1e-9);
  assert.ok(Math.abs(perf.returnRate - 5.2 / 11) < 1e-9);
  assert.equal(perf.topWinners.length, 2);
  assert.equal(perf.topWinners[0].title, "Win market");
  assert.ok(Math.abs(perf.topWinners[0].pnl - 5.2) < 1e-9);
  assert.ok(Math.abs(perf.topWinners[0].share - 5.2 / 8.2) < 1e-9);
  assert.ok(Math.abs(perf.topWinners[0].avgBuyCost - 0.4) < 1e-9);
  assert.ok(Math.abs(perf.topWinners[0].avgHoldDays - 6.4 / 86400) < 1e-12);
  assert.ok(Math.abs(perf.topWinners[1].avgBuyCost - 0.4) < 1e-9);
  assert.ok(Math.abs(perf.topWinners[1].avgHoldDays - 1 / 86400) < 1e-12);
  assert.equal(perf.topVolume.length, 4);
  assert.equal(perf.topVolume[0].title, "Flip");
  assert.ok(Math.abs(perf.topVolume[0].notional - 11) < 1e-9);
  assert.ok(Math.abs(perf.topVolume[0].share - 11 / 23.7) < 1e-9);
  assert.ok(Math.abs(perf.topVolume[0].avgBuyCost - 0.4) < 1e-9);
  assert.ok(Math.abs(perf.topVolume[0].pnl - 3) < 1e-9);
  assert.ok(Math.abs(perf.topVolume[1].notional - 7.2) < 1e-9);
  assert.ok(Math.abs(perf.topVolume[1].pnl - 5.2) < 1e-9);
  assert.ok(Math.abs(perf.topVolume[2].pnl - -3) < 1e-9);
  assert.equal(perf.topVolume[3].title, "Open");
  assert.ok(Math.abs(perf.topVolume[3].notional - 2.5) < 1e-9);
  assert.equal(perf.topVolume[3].pnl, null);
  assert.equal(report.categories.find((item) => item.name === "体育").wins, 2);
  assert.equal(report.categories.find((item) => item.name === "体育").decided, 2);
  assert.equal(report.categories.find((item) => item.name === "政治").wins, 0);
  assert.equal(report.categories.find((item) => item.name === "政治").decided, 1);
  assert.equal(report.categories.find((item) => item.name === "加密").decided, 0);

  const mean = 2.6;
  const deviation = Math.sqrt(62.72);
  const downside = Math.sqrt(9 / 2);
  assert.equal(perf.sampleDays, 2);
  assert.ok(Math.abs(perf.sharpe - (mean / deviation) * Math.sqrt(365)) < 1e-9);
  assert.ok(Math.abs(perf.sortino - (mean / downside) * Math.sqrt(365)) < 1e-9);
});

test("a winner's buy cost is size-weighted and holding days follow the closed shares", () => {
  const info = new Map([
    ["m", { domain: "体育", settled: true, settledAt: 86400 * 3, result: "Yes" }],
  ]);
  const report = computeReport([
    { conditionId: "m", tokenId: "yes", outcome: "Yes", side: "BUY", size: 10, price: 0.2, timestamp: 0, title: "M" },
    { conditionId: "m", tokenId: "yes", outcome: "Yes", side: "BUY", size: 10, price: 0.4, timestamp: 86400, title: "M" },
    { conditionId: "m", tokenId: "yes", outcome: "Yes", side: "SELL", size: 10, price: 0.9, timestamp: 86400 * 2, title: "M" },
  ], info);
  const winner = report.performance.topWinners[0];
  assert.ok(Math.abs(winner.avgBuyCost - 0.3) < 1e-9);
  assert.ok(Math.abs(winner.avgHoldDays - 2) < 1e-9);
});

test("a sell without a prior buy is not counted as profit", () => {
  const report = computeReport([
    { conditionId: "a", tokenId: "a", outcome: "Yes", side: "SELL", size: 5, price: 0.9, timestamp: 100 },
  ], new Map([["a", { domain: "体育", settled: true, settledAt: 200, result: "Yes" }]]));
  assert.equal(report.performance.decided, 0);
  assert.equal(report.performance.pnl, 0);
  assert.equal(report.performance.topWinners.length, 0);
  assert.equal(report.performance.topVolume.length, 1);
  assert.ok(Math.abs(report.performance.topVolume[0].notional - 4.5) < 1e-9);
  assert.equal(report.performance.topVolume[0].avgBuyCost, null);
  assert.equal(report.performance.topVolume[0].pnl, null);
});

test("an open position is excluded even when the sold part is profitable", () => {
  const report = computeReport([
    { conditionId: "a", tokenId: "a", outcome: "Yes", side: "BUY", size: 10, price: 0.4, timestamp: 100 },
    { conditionId: "a", tokenId: "a", outcome: "Yes", side: "SELL", size: 4, price: 0.9, timestamp: 200 },
  ], new Map([["a", { domain: "体育", settled: false, settledAt: null, result: "" }]]));
  assert.equal(report.performance.decided, 0);
  assert.equal(report.performance.open, 1);
  assert.equal(report.performance.pnl, 0);
  assert.equal(report.performance.sharpe, null);
});

test("one domain recomputes its own profit and volume denominators", () => {
  const day = 1_728_000_000;
  const info = new Map([
    ["win", { domain: "体育", settled: true, settledAt: day + 10, result: "Yes" }],
    ["loss", { domain: "政治", settled: true, settledAt: day + 86400 + 10, result: "No" }],
    ["flip", { domain: "体育", settled: false, settledAt: null, result: "" }],
    ["open", { domain: "加密", settled: false, settledAt: null, result: "" }],
  ]);
  const trades = [
    { conditionId: "win", tokenId: "win-yes", outcome: "Yes", side: "BUY", size: 10, price: 0.4, timestamp: day, title: "Win market" },
    { conditionId: "win", tokenId: "win-yes", outcome: "Yes", side: "SELL", size: 4, price: 0.8, timestamp: day + 1, title: "Win market" },
    { conditionId: "loss", tokenId: "loss-yes", outcome: "Yes", side: "BUY", size: 10, price: 0.3, timestamp: day + 86400, title: "Loss market" },
    { conditionId: "flip", tokenId: "flip-yes", outcome: "Yes", side: "BUY", size: 10, price: 0.4, timestamp: day + 2, title: "Flip" },
    { conditionId: "flip", tokenId: "flip-yes", outcome: "Yes", side: "SELL", size: 10, price: 0.7, timestamp: day + 3, title: "Flip" },
    { conditionId: "open", tokenId: "open-yes", outcome: "Yes", side: "BUY", size: 5, price: 0.5, timestamp: day + 4, title: "Open" },
  ];
  const sports = computeReport(trades.filter((trade) => marketDomain(info, trade.conditionId) === "体育"), info);
  const perf = sports.performance;

  assert.equal(sports.marketCount, 2);
  assert.equal(sports.buys.count, 2);
  assert.equal(perf.decided, 2);
  assert.equal(perf.losses, 0);
  assert.equal(perf.profitFactor, null);
  assert.ok(Math.abs(perf.pnl - 8.2) < 1e-9);
  assert.ok(Math.abs(perf.grossProfit - 8.2) < 1e-9);
  assert.equal(perf.topWinners.length, 2);
  assert.ok(perf.topWinners.every((market) => market.domain === "体育"));
  assert.ok(Math.abs(perf.topWinners[0].share - 5.2 / 8.2) < 1e-9);
  assert.equal(perf.topVolume.length, 2);
  assert.ok(Math.abs(perf.topVolume.reduce((sum, market) => sum + market.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs(perf.topVolume[0].notional - 11) < 1e-9);
  assert.equal(marketDomain(info, "missing"), "");
});

test("sell after the first buy is ignored when it happens only after settlement", () => {
  const info = new Map([["e", { domain: "金融", settled: true, settledAt: 500 }]]);
  const report = computeReport([
    { conditionId: "e", tokenId: "e", side: "BUY", size: 2, price: 0.4, timestamp: 100 },
    { conditionId: "e", tokenId: "e", side: "SELL", size: 2, price: 1, timestamp: 700 },
  ], info);
  assert.equal(report.holdToSettlement.qualified, 1);
  assert.equal(report.avgHoldSeconds, 600);
});
