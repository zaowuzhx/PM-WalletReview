import { readReport, writeReport } from "./cache.js";
import { domainForMarket, domainFromTags, parseTime, resolvedOutcome, settlementOf } from "./metrics.js";

const TRADE_LIMIT = 5000;
const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("已取消", "AbortError");
}

async function fetchJson(url, signal) {
  let delay = 600;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (signal?.aborted) throw abortError(signal);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 30000);
    const onAbort = () => timeout.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, { signal: timeout.signal, headers: { accept: "application/json" } });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        lastError = new Error(response.status === 429 ? "接口繁忙" : `接口暂时不可用（${response.status}）`);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay, signal);
        delay *= 2;
        continue;
      }
      if (!response.ok) {
        const error = new Error(`请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (error.status) throw error;
      lastError = error?.name === "AbortError" ? new Error("网络超时，请重试") : error;
      await sleep(delay, signal);
      delay *= 2;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  throw lastError || new Error("Polymarket 接口没有响应");
}

async function mapPool(items, limit, fn) {
  if (items.length === 0) return [];
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function fetchTrades(address, onProgress, signal) {
  const trades = [];
  const seenCursors = new Set();
  let cursor = "";
  let hasMore = false;
  while (trades.length < TRADE_LIMIT) {
    const url = new URL("/v2/trades", DATA_API);
    url.searchParams.set("user", address);
    url.searchParams.set("taker_only", "false");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await fetchJson(url, signal);
    const rows = Array.isArray(page?.data) ? page.data : [];
    trades.push(...rows);
    onProgress?.(`已获取 ${Math.min(trades.length, TRADE_LIMIT).toLocaleString("zh-CN")} 笔成交`);
    const next = page?.pagination?.next_cursor || "";
    hasMore = Boolean(page?.pagination?.has_more && next);
    if (!next || rows.length === 0 || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return { trades: trades.slice(0, TRADE_LIMIT), hasMore: hasMore || trades.length > TRADE_LIMIT };
}

function marketUrl(ids) {
  const url = new URL("/markets", GAMMA_API);
  url.searchParams.set("closed", "any");
  url.searchParams.set("limit", String(ids.length));
  for (const id of ids) url.searchParams.append("condition_ids", id);
  return url;
}

async function fetchMarketChunk(ids, signal) {
  if (ids.length === 0) return [];
  try {
    const rows = await fetchJson(marketUrl(ids), signal);
    if (!Array.isArray(rows)) throw new Error("市场数据格式异常");
    return rows;
  } catch (error) {
    if (ids.length > 1 && (error.status === 400 || error.status === 414 || error.status === 422)) {
      const mid = Math.ceil(ids.length / 2);
      const left = await fetchMarketChunk(ids.slice(0, mid), signal);
      const right = await fetchMarketChunk(ids.slice(mid), signal);
      return [...left, ...right];
    }
    throw error;
  }
}

async function fetchMarkets(ids, onProgress, signal) {
  const groups = chunk(ids, 20);
  let done = 0;
  const pages = await mapPool(groups, 4, async (group) => {
    const rows = await fetchMarketChunk(group, signal);
    done += group.length;
    onProgress?.(`正在核对市场 ${Math.min(done, ids.length).toLocaleString("zh-CN")} / ${ids.length.toLocaleString("zh-CN")}`);
    return rows;
  });
  return pages.flat();
}

async function fetchProfile(address, signal) {
  try {
    const url = new URL("/public-profile", GAMMA_API);
    url.searchParams.set("address", address);
    const profile = await fetchJson(url, signal);
    return { createdAt: parseTime(profile?.createdAt) };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    return { createdAt: null };
  }
}

function profileFrom(trades) {
  const names = new Map();
  const pseudonyms = new Map();
  for (const trade of trades) {
    if (trade.name) names.set(trade.name, (names.get(trade.name) || 0) + 1);
    if (trade.pseudonym) pseudonyms.set(trade.pseudonym, (pseudonyms.get(trade.pseudonym) || 0) + 1);
  }
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return { name: top(names), pseudonym: top(pseudonyms) };
}

export async function loadReport(address, onProgress, signal, options = {}) {
  if (!options.refresh) {
    const cached = await readReport(address);
    if (cached?.trades?.length && Array.isArray(cached.marketInfo)) {
      if (signal?.aborted) throw abortError(signal);
      onProgress?.("使用本地缓存");
      let createdAt = cached.createdAt ?? null;
      if (createdAt == null) {
        onProgress?.("正在读取注册日期…");
        createdAt = (await fetchProfile(address, signal)).createdAt;
        if (createdAt != null) await writeReport(address, { ...cached, createdAt });
      }
      const warnings = [...(cached.warnings || [])];
      const missingResult = cached.marketInfo.some((entry) => entry?.[1]?.settled && entry[1].result === undefined);
      if (missingResult && !warnings.some((item) => item.includes("市场结果"))) {
        warnings.push("缓存里还没有市场结果。点「重新获取」后，已结算市场会显示获胜结果。");
      }
      return {
        ...cached,
        warnings,
        createdAt,
        marketInfo: new Map(cached.marketInfo),
        fromCache: true,
        saved: true,
      };
    }
  }

  onProgress?.(options.refresh ? "正在重新获取最近成交…" : "正在获取最近成交…");
  const { trades, hasMore } = await fetchTrades(address, onProgress, signal);
  if (trades.length === 0) {
    const error = new Error("这个地址在最近可查询的成交里没有记录");
    error.code = "empty";
    throw error;
  }

  const conditionIds = [...new Set(trades.map((trade) => String(trade.condition_id || "").toLowerCase()).filter(Boolean))];
  onProgress?.("正在识别市场与结算状态…");
  const markets = await fetchMarkets(conditionIds, onProgress, signal);
  const byCondition = new Map();
  for (const market of markets) {
    const id = String(market.conditionId || "").toLowerCase();
    if (id) byCondition.set(id, market);
  }

  const slugToConditions = new Map();
  for (const [id, market] of byCondition) {
    const embedded = domainForMarket(market);
    if (embedded && embedded !== "其他") continue;
    const slug = market.events?.[0]?.slug;
    if (!slug) continue;
    if (!slugToConditions.has(slug)) slugToConditions.set(slug, []);
    slugToConditions.get(slug).push(id);
  }

  const slugs = [...slugToConditions.keys()];
  const eventDomains = new Map();
  let eventFailures = 0;
  if (slugs.length > 0) {
    let done = 0;
    await mapPool(slugs, 5, async (slug) => {
      try {
        const url = new URL("/events", GAMMA_API);
        url.searchParams.set("slug", slug);
        url.searchParams.set("limit", "1");
        const rows = await fetchJson(url, signal);
        const event = Array.isArray(rows) ? rows[0] : null;
        eventDomains.set(slug, domainFromTags(event?.tags));
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        eventFailures += 1;
        eventDomains.set(slug, null);
      } finally {
        done += 1;
        onProgress?.(`正在归类领域 ${done.toLocaleString("zh-CN")} / ${slugs.length.toLocaleString("zh-CN")}`);
      }
    });
  }

  const marketInfo = new Map();
  for (const id of conditionIds) {
    const market = byCondition.get(id);
    const slug = market?.events?.[0]?.slug;
    const eventDomain = slug ? eventDomains.get(slug) : null;
    if (market) {
      const settlement = settlementOf(market);
      marketInfo.set(id, {
        ...settlement,
        domain: [eventDomain, domainForMarket(market)].find((name) => name && name !== "其他") || "其他",
        title: market.question || "",
        result: resolvedOutcome(market, settlement.settled),
      });
    } else {
      const trade = trades.find((item) => String(item.condition_id || "").toLowerCase() === id);
      marketInfo.set(id, {
        settled: false,
        settledAt: null,
        domain: "其他",
        title: trade?.title || "",
        result: "",
        missing: true,
      });
    }
  }

  onProgress?.("正在读取注册日期…");
  const account = await fetchProfile(address, signal);
  const timestamps = trades.map((trade) => Number(trade.timestamp)).filter((value) => Number.isFinite(value));
  const profile = profileFrom(trades);
  const warnings = [];
  const missing = [...marketInfo.values()].filter((info) => info.missing).length;
  if (missing > 0) warnings.push(`${missing.toLocaleString("zh-CN")} 个市场没有查到结算资料，未计入「持有至结算」的分母。`);
  if (eventFailures > 0) warnings.push(`${eventFailures.toLocaleString("zh-CN")} 个事件的领域没有读到，这些市场计入「其他」。`);

  const report = {
    address,
    name: profile.name,
    pseudonym: profile.pseudonym,
    createdAt: account.createdAt,
    tradeCount: Math.min(trades.length, TRADE_LIMIT),
    hasMore,
    from: timestamps.length ? Math.min(...timestamps) : null,
    to: timestamps.length ? Math.max(...timestamps) : null,
    warnings,
    trades: trades.map((trade) => ({
      conditionId: String(trade.condition_id || "").toLowerCase(),
      tokenId: String(trade.token_id || ""),
      side: trade.side,
      size: trade.size,
      price: trade.price,
      timestamp: trade.timestamp,
      title: trade.title,
      outcome: trade.outcome,
      slug: trade.slug || "",
      eventSlug: trade.event_slug || "",
    })),
    marketInfo,
  };
  const cachedAt = Date.now();
  const saved = await writeReport(address, {
    ...report,
    marketInfo: [...report.marketInfo.entries()],
    cachedAt,
  });
  if (!saved) report.warnings = [...report.warnings, "这次的结果没能写入本地缓存。"];
  return { ...report, cachedAt, fromCache: false, saved };
}
