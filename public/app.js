import { loadReport } from "./api.js";
import { computeReport, marketDomain, parseAddress, tradesAboveNotional, tradesWithinDays } from "./metrics.js";

const form = document.querySelector("#search");
const input = document.querySelector("#address");
const submit = document.querySelector("#submit");
const cancel = document.querySelector("#cancel");
const statusBox = document.querySelector("#status");
const report = document.querySelector("#report");
const example = document.querySelector("#example");

let controller = null;
let currentData = null;
let fullStats = null;
let selectedDomains = [];
let minNotional = null;
let maxNotional = null;
let windowDays = null;
const TIME_WINDOWS = [30, 60, 90, 180];
let currentCategories = [];
let currentWinners = [];
let currentVolume = [];

const PAGE_SIZE = 20;

const grouped = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shares = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const priceDigits = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 3, maximumFractionDigits: 4 });
const avgCostDigits = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = { format: (value) => `$${grouped.format(value)}` };
const wholeMoney = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });
const moneyWhole = { format: (value) => `$${wholeMoney.format(Math.round(value))}` };
const price = { format: (value) => `$${priceDigits.format(value)}` };
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const edgeDigits = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
  signDisplay: "exceptZero",
});
const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayClock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const ratioFormat = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatRatio(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return ratioFormat.format(value);
}

function signedMoney(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return money.format(0);
  return `${value > 0 ? "+" : "−"}${money.format(Math.abs(value))}`;
}

function pnlClass(value) {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.005) return "";
  return value > 0 ? "pos" : "neg";
}

function elapsedDays(epochSeconds) {
  if (epochSeconds == null) return null;
  return Math.max(0, Math.floor((Date.now() / 1000 - epochSeconds) / 86400));
}

function formatHoldDays(days) {
  if (days == null || !Number.isFinite(days)) return "—";
  if (days < 0.05) return formatDuration(days * 86400);
  return `${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(days)} 天`;
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分`;
  return `${total} 秒`;
}

function setBusy(busy) {
  submit.disabled = busy;
  input.disabled = busy;
  cancel.hidden = !busy;
}

function showStatus(message, isError = false) {
  statusBox.hidden = !message;
  statusBox.textContent = message || "";
  statusBox.classList.toggle("error", isError);
}

function marketHref(trade) {
  const eventSlug = String(trade.eventSlug || "");
  const slug = String(trade.slug || "");
  if (/^[a-z0-9-]+$/i.test(eventSlug)) return `https://polymarket.com/event/${eventSlug}`;
  if (/^[a-z0-9-]+$/i.test(slug)) return `https://polymarket.com/market/${slug}`;
  return "";
}

function formatAvgCost(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${avgCostDigits.format(value)}`;
}

function renderTradeRow(trade, hideMarket = false) {
  const href = marketHref(trade);
  const title = escapeHtml(trade.title || "未命名市场");
  const market = href
    ? `<a href="${href}" target="_blank" rel="noreferrer">${title}</a>`
    : title;
  const sideClass = trade.side === "SELL" ? "sell" : "buy";
  const sideText = trade.side === "SELL" ? "卖出" : "买入";
  return `
    <tr>
      <td class="time">${clock.format(trade.timestamp * 1000)}</td>
      <td class="side ${sideClass}">${sideText}</td>
      ${hideMarket ? "" : `<td class="market">${market}</td>`}
      <td>${escapeHtml(trade.outcome || "—")}</td>
      <td>${escapeHtml(trade.result || "")}</td>
      <td class="figure">${price.format(trade.price)}</td>
      <td class="figure">${shares.format(trade.size)}</td>
      <td class="figure">${money.format(trade.price * trade.size)}</td>
    </tr>
  `;
}

function tradeTable(rows, hideMarket = false) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>方向</th>
            ${hideMarket ? "" : "<th>市场</th>"}
            <th>买入代币</th>
            <th>市场结果</th>
            <th class="figure">价格</th>
            <th class="figure">份额</th>
            <th class="figure">金额</th>
          </tr>
        </thead>
        <tbody>${rows.map((trade) => renderTradeRow(trade, hideMarket)).join("")}</tbody>
      </table>
    </div>
  `;
}

function renderPager(attribute, page, pages, total, unit) {
  if (pages <= 1) return `<p class="pager-meta">共 ${total.toLocaleString("zh-CN")} ${unit}</p>`;
  return `
    <button type="button" ${attribute}="${page - 1}" ${page === 0 ? "disabled" : ""}>上一页</button>
    <span>第 ${page + 1} / ${pages} 页</span>
    <button type="button" ${attribute}="${page + 1}" ${page >= pages - 1 ? "disabled" : ""}>下一页</button>
    <span class="pager-meta">共 ${total.toLocaleString("zh-CN")} ${unit}</span>
  `;
}

function pageSlice(items, page) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safe = Math.min(Math.max(page, 0), pages - 1);
  return { pages, safe, slice: items.slice(safe * PAGE_SIZE, safe * PAGE_SIZE + PAGE_SIZE) };
}

function marketsOf(category) {
  const groupedMarkets = new Map();
  for (const trade of category.trades) {
    let market = groupedMarkets.get(trade.conditionId);
    if (!market) {
      market = {
        conditionId: trade.conditionId,
        title: trade.title,
        slug: trade.slug,
        eventSlug: trade.eventSlug,
        result: trade.result || "",
        trades: [],
      };
      groupedMarkets.set(trade.conditionId, market);
    }
    if (!market.title && trade.title) market.title = trade.title;
    if (!market.result && trade.result) market.result = trade.result;
    market.trades.push(trade);
  }
  return [...groupedMarkets.values()].sort((a, b) => b.trades.length - a.trades.length || a.title.localeCompare(b.title, "zh-CN"));
}

function renderTimeView(category, page) {
  const { pages, safe, slice } = pageSlice(category.trades, page);
  return `${tradeTable(slice)}<div class="pager">${renderPager("data-time-page", safe, pages, category.trades.length, "笔")}</div>`;
}

function renderMarketList(category, page, openId, tradePage) {
  const markets = marketsOf(category);
  const { pages, safe, slice } = pageSlice(markets, page);
  const rows = slice.map((market) => {
    const href = marketHref(market);
    const title = escapeHtml(market.title || "未命名市场");
    const name = href ? `<a href="${href}" target="_blank" rel="noreferrer">${title}</a>` : title;
    const open = Boolean(openId) && openId === market.conditionId;
    const id = escapeHtml(market.conditionId);
    const summary = `
      <tr>
        <td class="market">${name}</td>
        <td class="figure">${market.trades.length.toLocaleString("zh-CN")}</td>
        <td>${escapeHtml(market.result || "")}</td>
        <td class="action"><button type="button" data-open-market="${id}" aria-expanded="${open ? "true" : "false"}">${open ? "收起" : "查看成交"}</button></td>
      </tr>
    `;
    if (!open) return summary;
    const { pages: tradePages, safe: tradeSafe, slice: trades } = pageSlice(market.trades, tradePage);
    return `
      ${summary}
      <tr class="market-trades">
        <td colspan="4">
          ${tradeTable(trades)}
          <div class="pager">${renderPager("data-trade-page", tradeSafe, tradePages, market.trades.length, "笔")}</div>
        </td>
      </tr>
    `;
  }).join("");
  return `
    <div class="table-wrap">
      <table class="market-list">
        <thead>
          <tr>
            <th>市场</th>
            <th class="figure">成交笔数</th>
            <th>市场结果</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="pager">${renderPager("data-market-page", safe, pages, markets.length, "个市场")}</div>
  `;
}

function paintDetail(details, options = {}) {
  const category = currentCategories.find((item) => item.name === details.dataset.domainPanel);
  const body = details.querySelector(".detail-body");
  if (!category || !body) return;
  const view = details.dataset.mode || "time";
  details.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  if (view === "market") {
    body.innerHTML = renderMarketList(
      category,
      Number(details.dataset.marketIndex || 0),
      details.dataset.openId || "",
      Number(details.dataset.tradeIndex || 0),
    );
  } else {
    body.innerHTML = renderTimeView(category, Number(details.dataset.timeIndex || 0));
  }
  if (options.scroll) details.querySelector(".views")?.scrollIntoView({ block: "start" });
}

function tradesByCondition() {
  const groupedTrades = new Map();
  for (const category of currentCategories) {
    for (const trade of category.trades) {
      let list = groupedTrades.get(trade.conditionId);
      if (!list) {
        list = [];
        groupedTrades.set(trade.conditionId, list);
      }
      list.push(trade);
    }
  }
  return groupedTrades;
}

function renderRankRows(markets, openId, tradePage, kind) {
  const valueLabel = kind === "volume" ? "成交金额" : "盈利";
  const shareLabel = kind === "volume" ? "占全部成交" : "占全部盈利";
  return markets.map((market) => {
    const href = marketHref(market);
    const title = escapeHtml(market.title || "未命名市场");
    const name = href ? `<a href="${href}" target="_blank" rel="noreferrer">${title}</a>` : title;
    const id = escapeHtml(market.conditionId);
    const open = Boolean(openId) && openId === market.conditionId;
    const value = kind === "volume" ? money.format(market.notional) : signedMoney(market.pnl);
    const valueClass = kind === "volume" ? "" : pnlClass(market.pnl);
    const profitCell = kind === "volume"
      ? `<td class="figure ${pnlClass(market.pnl)}" data-label="盈利">${market.pnl == null ? "未结束" : signedMoney(market.pnl)}</td>`
      : "";
    const summary = `
      <tr>
        <td class="market" data-label="市场">${name}</td>
        <td data-label="领域">${escapeHtml(market.domain || "")}</td>
        <td class="figure ${valueClass}" data-label="${valueLabel}">${value}</td>
        <td class="figure" data-label="${shareLabel}">${percent.format(market.share)}</td>
        ${profitCell}
        <td class="figure" data-label="平均买入成本">${formatAvgCost(market.avgBuyCost)}</td>
        <td class="figure" data-label="平均持仓天数">${formatHoldDays(market.avgHoldDays)}</td>
        <td class="action"><button type="button" data-open-rank="${id}" aria-expanded="${open ? "true" : "false"}">${open ? "收起" : "查看成交"}</button></td>
      </tr>
    `;
    if (!open) return summary;
    const { pages, safe, slice } = pageSlice(market.trades, tradePage);
    return `
      ${summary}
      <tr class="market-trades">
        <td colspan="${kind === "volume" ? 8 : 7}">
          ${tradeTable(slice, true)}
          <div class="pager">${renderPager("data-rank-page", safe, pages, market.trades.length, "笔")}</div>
        </td>
      </tr>
    `;
  }).join("");
}

function paintRank(panel) {
  const body = panel?.querySelector("tbody");
  if (!panel || !body) return;
  const markets = panel.dataset.rank === "volume" ? currentVolume : currentWinners;
  body.innerHTML = renderRankRows(markets, panel.dataset.openId || "", Number(panel.dataset.tradeIndex || 0), panel.dataset.rank);
}

function domainLabel(name) {
  return name || "无领域";
}

function tradeWindow(trades) {
  let from = null;
  let to = null;
  for (const trade of trades) {
    const time = Number(trade.timestamp);
    if (!Number.isFinite(time)) continue;
    if (from == null || time < from) from = time;
    if (to == null || time > to) to = time;
  }
  return { from, to, tradeCount: trades.length };
}

function viewFor(domains) {
  const timed = tradesWithinDays(currentData.trades, windowDays);
  const universe = tradesAboveNotional(timed, minNotional, maxNotional);
  const filtered = amountActive() || windowDays > 0;
  const full = filtered ? computeReport(universe, currentData.marketInfo) : fullStats;
  if (!domains.length) {
    if (!filtered) {
      return {
        stats: fullStats,
        full,
        tradeCount: currentData.tradeCount,
        from: currentData.from,
        to: currentData.to,
      };
    }
    return { stats: full, full, ...tradeWindow(universe) };
  }
  const chosen = new Set(domains);
  const trades = universe.filter((trade) => chosen.has(marketDomain(currentData.marketInfo, trade.conditionId)));
  return { stats: computeReport(trades, currentData.marketInfo), full, ...tradeWindow(trades) };
}

function amountActive() {
  return minNotional != null || maxNotional != null;
}

function amountPhrase() {
  if (minNotional != null && maxNotional != null) return `单笔买入 ${money.format(minNotional)}–${money.format(maxNotional)}`;
  if (minNotional != null) return `单笔买入大于 ${money.format(minNotional)}`;
  if (maxNotional != null) return `单笔买入小于 ${money.format(maxNotional)}`;
  return "";
}

function filterHelp(data) {
  const parts = [];
  if (windowDays > 0) {
    parts.push(`当前只统计最近 ${windowDays} 天内的成交。`);
    const cutoff = Date.now() / 1000 - windowDays * 86400;
    if (data.hasMore && data.from != null && data.from > cutoff) {
      parts.push(`已加载的成交最早只到 ${clock.format(data.from * 1000)}，没有覆盖完整的 ${windowDays} 天。`);
    }
  }
  if (minNotional != null && maxNotional != null && minNotional >= maxNotional) {
    parts.push("左边的数需要小于右边，当前没有成交同时满足这两个条件。");
  } else if (amountActive()) {
    parts.push(`只保留${amountPhrase()} 的成交。卖出不计入，等于边界不算。`);
  } else if (!(windowDays > 0)) {
    parts.push("只填左边表示大于该金额，只填右边表示小于该金额，两个都填表示介于两者之间。等于边界不算，卖出不计入。");
  }
  return parts.join("");
}

function readBound(selector) {
  const raw = String(report.querySelector(selector)?.value ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function applyMinNotional() {
  const nextMin = readBound("[data-min-notional]");
  const nextMax = readBound("[data-max-notional]");
  if (nextMin === undefined || nextMax === undefined) return;
  minNotional = nextMin;
  maxNotional = nextMax;
  showView(false);
}

function showView(scroll) {
  if (!currentData || !fullStats) return;
  const savedY = window.scrollY;
  let view = viewFor(selectedDomains);
  const available = new Set(view.full.categories.map((item) => item.name));
  const kept = selectedDomains.filter((name) => available.has(name));
  if (kept.length !== selectedDomains.length) {
    selectedDomains = kept;
    view = viewFor(selectedDomains);
  }
  render(currentData, view.full, view, selectedDomains, scroll);
  if (!scroll) window.scrollTo(0, savedY);
}

function renderPerformance(data, stats, domain) {
  const perf = stats.performance;
  const scoped = domain.length > 0;
  const registeredDays = elapsedDays(data.createdAt);
  const firstAge = perf.firstTradeAt == null ? null : Math.max(0, Date.now() / 1000 - perf.firstTradeAt);
  const trades = tradesByCondition();
  const withTrades = (market) => ({
    ...market,
    trades: trades.get(market.conditionId) || [],
  });
  currentWinners = perf.topWinners.map(withTrades);
  currentVolume = perf.topVolume.map(withTrades);
  const winnerPnl = currentWinners.reduce((sum, market) => sum + market.pnl, 0);
  const winnerShare = perf.grossProfit > 1e-8 ? winnerPnl / perf.grossProfit : 0;
  const volumeNotional = currentVolume.reduce((sum, market) => sum + market.notional, 0);
  const volumeShare = currentVolume.reduce((sum, market) => sum + market.share, 0);
  return `
    <section class="metrics" id="performance">
      <article class="panel">
        <header>
          <h3>账户与活跃</h3>
          <p>${scoped
            ? `注册日期来自整个账户，不随领域变化。活跃按北京时间，只统计所选领域${data.hasMore ? "，并且只在最近 5,000 笔之内" : ""}。`
            : `注册日期来自账户资料。活跃按北京时间，当天至少有一笔买入或卖出。${data.hasMore ? "活跃天数和首次成交只统计最近 5,000 笔。" : ""}`}${windowDays > 0 ? `活跃和首次成交只看最近 ${windowDays} 天。` : ""}${amountActive() ? `活跃和首次成交只看${amountPhrase()} 的成交。` : ""}</p>
        </header>
        <div class="split three">
          <div>
            <span class="label">注册日期</span>
            <strong class="num date">${data.createdAt ? dayClock.format(data.createdAt * 1000) : "—"}</strong>
            <p class="muted">${registeredDays == null ? "没有查到注册日期" : `距今 ${registeredDays.toLocaleString("zh-CN")} 天`}</p>
          </div>
          <div>
            <span class="label">活跃天数</span>
            <strong class="num hero">${perf.activeDays.toLocaleString("zh-CN")}</strong>
            <p class="muted">天</p>
          </div>
          <div>
            <span class="label">首次成交距今</span>
            <strong class="num date">${formatDuration(firstAge)}</strong>
            <p class="muted">${windowDays > 0
              ? `最近 ${windowDays} 天里${scoped ? "，所选领域" : ""}最早的一笔`
              : scoped
                ? (data.hasMore ? "最近 5,000 笔里，所选领域最早的一笔" : "所选领域的第一笔成交")
                : (data.hasMore ? "这 5,000 笔里最早的一笔" : "第一笔成交")}</p>
          </div>
        </div>
      </article>

      <article class="panel wide rank-panel" data-rank="winners" data-open-id="" data-trade-index="0">
        <header>
          <h3>盈利最多的 10 个市场</h3>
          <p>按已结束市场的盈利金额排序。比例的分母是${scoped ? "所选领域的全部盈利" : "全部盈利"}，不是净盈亏。平均买入成本是该市场的买入成交额 ÷ 买入份额，保留两位小数。平均持仓天数按份额加权，未结束的份额不算。成交明细默认收起。</p>
        </header>
        ${currentWinners.length ? `
          <p class="rank-total">这 ${currentWinners.length.toLocaleString("zh-CN")} 个市场盈利合计 <strong class="${pnlClass(winnerPnl)}">${signedMoney(winnerPnl)}</strong>，占全部盈利 <strong>${percent.format(winnerShare)}</strong>。</p>
          <div class="table-wrap">
            <table class="rank-table">
              <thead>
                <tr>
                  <th>市场</th>
                  <th>领域</th>
                  <th class="figure">盈利</th>
                  <th class="figure">占全部盈利</th>
                  <th class="figure">平均买入成本</th>
                  <th class="figure">平均持仓天数</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${renderRankRows(currentWinners, "", 0, "winners")}</tbody>
            </table>
          </div>
        ` : `<p class="empty">这批已结束的市场里没有盈利。</p>`}
      </article>

      <article class="panel wide rank-panel" data-rank="volume" data-open-id="" data-trade-index="0">
        <header>
          <h3>成交金额最大的 10 个市场</h3>
          <p>按买入和卖出的成交额合计排序，未结束的市场也计入。比例的分母是${scoped ? "所选领域全部市场的成交金额" : "全部市场的成交金额"}。盈利只统计已经结束的市场，未结束显示为「未结束」。平均买入成本保留两位小数。平均持仓天数按份额加权，未结束的份额不算。成交明细默认收起。</p>
        </header>
        ${currentVolume.length ? `
          <p class="rank-total">这 ${currentVolume.length.toLocaleString("zh-CN")} 个市场成交金额合计 <strong>${money.format(volumeNotional)}</strong>，占全部成交 <strong>${percent.format(volumeShare)}</strong>。</p>
          <div class="table-wrap">
            <table class="rank-table rank-volume">
              <thead>
                <tr>
                  <th>市场</th>
                  <th>领域</th>
                  <th class="figure">成交金额</th>
                  <th class="figure">占全部成交</th>
                  <th class="figure">盈利</th>
                  <th class="figure">平均买入成本</th>
                  <th class="figure">平均持仓天数</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${renderRankRows(currentVolume, "", 0, "volume")}</tbody>
            </table>
          </div>
        ` : `<p class="empty">这批成交里没有可统计的成交金额。</p>`}
      </article>

      <article class="panel">
        <header><h3>累计盈亏</h3><p>已结束市场的盈亏合计。收益率 = 累计盈亏 ÷ 这些市场的买入成本。</p></header>
        <strong class="num hero ${pnlClass(perf.pnl)}">${signedMoney(perf.pnl)}</strong>
        <p class="ratio">${perf.returnRate == null ? "没有可计算的买入成本" : `收益率 ${percent.format(perf.returnRate)}`}</p>
        <ul class="fine">
          <li>已结束 ${perf.decided.toLocaleString("zh-CN")} 个市场</li>
          <li>未结束 ${perf.open.toLocaleString("zh-CN")} 个，持仓盈亏未计入</li>
          <li>计入的买入成本 ${perf.cost > 0 ? money.format(perf.cost) : "—"}</li>
        </ul>
      </article>

      <article class="panel">
        <header><h3>平均盈利 / 平均亏损</h3><p>盈利市场的平均赚取，和亏损市场的平均亏掉。</p></header>
        <div class="split">
          <div>
            <span class="label buy">平均盈利</span>
            <strong class="num date ${pnlClass(perf.avgWin)}">${perf.avgWin == null ? "—" : signedMoney(perf.avgWin)}</strong>
            <p class="muted">${perf.wins.toLocaleString("zh-CN")} 个盈利市场</p>
          </div>
          <div>
            <span class="label sell">平均亏损</span>
            <strong class="num date ${pnlClass(perf.avgLoss == null ? null : -perf.avgLoss)}">${perf.avgLoss == null ? "—" : signedMoney(-perf.avgLoss)}</strong>
            <p class="muted">${perf.losses.toLocaleString("zh-CN")} 个亏损市场</p>
          </div>
        </div>
      </article>

      <article class="panel">
        <header><h3>盈亏比与期望值</h3><p>盈亏比 = 平均盈利 ÷ 平均亏损。期望值是每个已结束市场的平均盈亏。</p></header>
        <div class="split">
          <div>
            <span class="label">盈亏比</span>
            <strong class="num hero">${formatRatio(perf.payoffRatio)}</strong>
          </div>
          <div>
            <span class="label">期望值</span>
            <strong class="num date ${pnlClass(perf.expectancy)}">${signedMoney(perf.expectancy)}</strong>
          </div>
        </div>
      </article>

      <article class="panel">
        <header><h3>夏普 / 索提诺</h3><p>按北京时间的自然日盈亏计算，没有成交的日子记为 0。无风险利率按 0，并按 365 天年化。</p></header>
        <div class="split">
          <div>
            <span class="label">夏普</span>
            <strong class="num hero">${formatRatio(perf.sharpe)}</strong>
          </div>
          <div>
            <span class="label">索提诺</span>
            <strong class="num hero">${formatRatio(perf.sortino)}</strong>
          </div>
        </div>
        <p class="muted">样本 ${perf.sampleDays.toLocaleString("zh-CN")} 个自然日${perf.sampleDays < 2 ? "，不足两天，无法计算" : ""}。</p>
      </article>

      <article class="panel">
        <header><h3>利润因子</h3><p>全部盈利金额 ÷ 全部亏损金额。</p></header>
        <strong class="num hero">${formatRatio(perf.profitFactor)}</strong>
        <ul class="fine">
          <li>全部盈利 ${money.format(perf.grossProfit)}</li>
          <li>全部亏损 ${money.format(perf.grossLoss)}</li>
          ${perf.breakeven ? `<li>打平 ${perf.breakeven.toLocaleString("zh-CN")} 个市场</li>` : ""}
        </ul>
      </article>
    </section>
  `;
}

function formatWinRate(item) {
  if (!item.decided) return "未结束";
  return `${item.wins.toLocaleString("zh-CN")}/${item.decided.toLocaleString("zh-CN")}（${percent.format(item.winRate)}）`;
}

function formatBucketWin(row) {
  if (!row.markets) return "—";
  return formatWinRate(row);
}

function formatExpectation(value) {
  if (value == null) return "—";
  return edgeDigits.format(value);
}

const EXPECTATION_HINT = "按当前胜率和平均价格，买入一份额预期赚多少钱";

function expectationHead() {
  return `<span class="with-hint">期望<button type="button" class="hint" aria-expanded="false" aria-label="期望说明">?<span class="hint-pop">${EXPECTATION_HINT}</span></button></span>`;
}

function renderPriceBuckets(stats) {
  const rows = stats.priceBuckets || [];
  return `
    <section class="panel" id="price-bands">
      <header>
        <h3>买入价格分布</h3>
        <p>按每笔买入的价格分组，每 0.20 一档。小于 0.20 不含 0.20；之后每档含下限、不含上限，0.80–1.00 含 1.00。金额是价格 × 份额，占比的分母是当前范围内的全部买入金额。均价是该档买入成交额 ÷ 买入份额。胜率按市场算：这一档里有过买入、并且已经结束的市场里，赚钱的占多少。未结束不进分母。同一市场可以出现在多档。期望 = (1 − 均价) × 胜率 − 均价 × (1 − 胜率)，没有已结束市场时显示「—」。每个价格带再按其中最大的一笔买入分成五档，每 20% 一档，只统计这一档里的单笔买入。金额范围按整数显示。均额是该金额区间的买入金额合计 ÷ 笔数，占比的分母是这个价格带的买入笔数。正好等于 20% 分界的归入下一档。</p>
      </header>
      <div class="price-row price-head">
        <span>价格</span>
        <span></span>
        <span>买入金额</span>
        <span>均价</span>
        <span>占比</span>
        <span>笔数</span>
        <span>胜率</span>
        ${expectationHead()}
      </div>
      ${rows.map((row) => `
        <div class="price-band">
          <div class="price-row">
            <span class="price-label">${escapeHtml(row.label)}</span>
            <span class="bar-track"><span style="width:${Math.max(row.share * 100, row.usdc > 1e-8 ? 1.2 : 0)}%"></span></span>
            <span class="price-amount">${money.format(row.usdc)}</span>
            <span class="price-avg">${row.avgPrice == null ? "—" : price.format(row.avgPrice)}</span>
            <span class="price-share">${percent.format(row.share)}</span>
            <span class="price-count">${row.count.toLocaleString("zh-CN")}</span>
            <span class="price-win">${formatBucketWin(row)}</span>
            <span class="price-edge">${formatExpectation(row.expectation)}</span>
          </div>
          ${renderPriceAmountSplit(row.amounts)}
        </div>
      `).join("")}
    </section>
  `;
}

function renderPriceAmountSplit(rows) {
  if (!rows?.some((row) => row.count)) return "";
  return `
    <details class="price-split">
      <summary>金额分档</summary>
      <div class="price-split-body">
        <div class="price-split-row price-split-head">
          <span>金额范围</span>
          <span>均额</span>
          <span>笔数</span>
          <span>占比</span>
          <span>胜率</span>
          ${expectationHead()}
        </div>
        ${rows.map((row) => `
          <div class="price-split-row">
            <span class="price-split-range">${moneyWhole.format(row.from)}–${moneyWhole.format(row.to)}</span>
            <span class="price-split-avg">${row.avgAmount == null ? "—" : money.format(row.avgAmount)}</span>
            <span class="price-split-count">${row.count.toLocaleString("zh-CN")}</span>
            <span class="price-split-share">${percent.format(row.share)}</span>
            <span class="price-split-win">${formatBucketWin(row)}</span>
            <span class="price-split-edge">${formatExpectation(row.expectation)}</span>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function renderAmountTable(rows, countLabel) {
  return `
    <div class="amount-row amount-head">
      <span>区间</span>
      <span></span>
      <span>金额范围</span>
      <span>均额</span>
      <span>${countLabel}</span>
      <span>占比</span>
      <span>胜率</span>
      ${expectationHead()}
    </div>
    ${rows.map((row) => `
      <div class="amount-row">
        <span class="amount-label">${escapeHtml(row.label)}</span>
        <span class="bar-track"><span style="width:${Math.max(row.share * 100, row.count ? 1.2 : 0)}%"></span></span>
        <span class="amount-range">${moneyWhole.format(row.from)}–${moneyWhole.format(row.to)}</span>
        <span class="amount-avg">${row.avgAmount == null ? "—" : money.format(row.avgAmount)}</span>
        <span class="amount-count">${row.count.toLocaleString("zh-CN")}</span>
        <span class="amount-share">${percent.format(row.share)}</span>
        <span class="amount-win">${formatBucketWin(row)}</span>
        <span class="amount-edge">${formatExpectation(row.expectation)}</span>
      </div>
    `).join("")}
  `;
}

function renderAmountBuckets(stats) {
  const buckets = stats.amountBuckets || { markets: [], trades: [] };
  return `
    <section class="panel" id="amount-bands">
      <header>
        <h3>买入金额分布</h3>
        <p>金额是价格 × 份额。下面分市场和单笔两张表，各自按当前范围内的最大买入金额分成五档，每 20% 一档。正好等于分界的归入下一档，最大的仍在 80–100%。占比是该档的市场数或笔数，除以这一张表的合计。均额是该区间买入金额合计 ÷ 市场数或笔数。胜率按市场算，已结束且赚钱才算胜，未结束不进分母。期望 = (1 − 均价) × 胜率 − 均价 × (1 − 胜率)，这里的均价是该区间买入成交额 ÷ 买入份额。按市场时每个市场只在自己的金额档；按交易时，这一档里有过买入的市场都计入，同一市场可以出现在多档。</p>
      </header>
      <div class="amount-block">
        <h4>按市场</h4>
        <p>一个市场的买入金额，是这个市场里全部买入的合计。只统计有买入的市场。</p>
        ${renderAmountTable(buckets.markets, "市场数")}
      </div>
      <div class="amount-block">
        <h4>按交易</h4>
        <p>每一笔买入单独计算。卖出不计入。</p>
        ${renderAmountTable(buckets.trades, "笔数")}
      </div>
    </section>
  `;
}

function renderDomainTabs(categories, domains) {
  const chosen = new Set(domains);
  const tabs = [
    `<button type="button" data-domain-all aria-pressed="${domains.length ? "false" : "true"}">全部</button>`,
    ...categories.map((item, index) => `
      <button type="button" data-domain-index="${index}" aria-pressed="${chosen.has(item.name) ? "true" : "false"}">${escapeHtml(domainLabel(item.name))}</button>
    `),
  ];
  return `<div class="domain-tabs" role="group" aria-label="市场领域">${tabs.join("")}</div>`;
}

function renderDomain(item, index, domains) {
  const pressed = domains.includes(item.name);
  return `
    <section class="domain">
      <button type="button" class="bar-row" data-domain-index="${index}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${escapeHtml(domainLabel(item.name))}">
        <span class="bar-name">${escapeHtml(item.name)}</span>
        <span class="bar-track"><span style="width:${Math.max(item.share * 100, item.count ? 1.2 : 0)}%"></span></span>
        <span class="bar-count">${item.count.toLocaleString("zh-CN")}</span>
        <span class="bar-share">${percent.format(item.share)}</span>
        <span class="bar-win">${formatWinRate(item)}</span>
      </button>
      <details class="fold" data-domain-panel="${escapeHtml(item.name)}" data-mode="time" data-time-index="0" data-market-index="0" data-open-id="" data-trade-index="0">
        <summary>明细 · ${item.trades.length.toLocaleString("zh-CN")} 笔</summary>
        <div class="views">
          <button type="button" data-view="time" class="active">按时间</button>
          <button type="button" data-view="market">按市场</button>
        </div>
        <div class="detail-body"></div>
      </details>
    </section>
  `;
}

function render(data, full, view, domain, scroll) {
  const stats = view.stats;
  const hold = stats.holdToSettlement;
  currentCategories = full.categories;
  const ratio = hold.settled > 0 ? hold.qualified / hold.settled : null;
  const displayName = data.name || data.pseudonym || "未命名地址";
  const windowText = view.from && view.to
    ? `${clock.format(view.from * 1000)} – ${clock.format(view.to * 1000)}（北京时间）`
    : "时间未知";
  const scoped = domain.length > 0;
  const scopeName = scoped ? domain.map(domainLabel).join("、") : "";
  const overall = full.performance;
  const overallRate = overall.decided
    ? `${overall.wins.toLocaleString("zh-CN")}/${overall.decided.toLocaleString("zh-CN")}（${percent.format(overall.wins / overall.decided)}）`
    : "—";
  const amountText = amountPhrase();
  const timeText = windowDays > 0 ? `最近${windowDays}天` : "";
  const kicker = scoped || amountText || timeText
    ? [scopeName, timeText, amountText, `${view.tradeCount.toLocaleString("zh-CN")} 笔`].filter(Boolean).join(" · ")
    : (data.hasMore ? "最近 5,000 笔成交" : `全部 ${data.tradeCount.toLocaleString("zh-CN")} 笔成交`);

  report.hidden = false;
  report.innerHTML = `
    <section class="summary">
      <div>
        <p class="kicker">${escapeHtml(kicker)}</p>
        <h2>${escapeHtml(displayName)}</h2>
        <p class="address"><a href="https://polymarket.com/profile/${data.address}" target="_blank" rel="noreferrer">${data.address}</a></p>
        <div class="cache-line">
          <p>${data.fromCache
            ? `本地缓存 · 查询于 ${clock.format(data.cachedAt)}，这次没有重新请求`
            : data.saved
              ? "已保存在这个浏览器，再次查询这个地址会直接使用"
              : "这次没能写入本地缓存"}</p>
          <button type="button" data-refresh>重新获取</button>
        </div>
      </div>
      <dl>
        <div><dt>成交</dt><dd>${view.tradeCount.toLocaleString("zh-CN")}</dd></div>
        <div><dt>市场</dt><dd>${stats.marketCount.toLocaleString("zh-CN")}</dd></div>
        <div><dt>时间范围</dt><dd>${windowText}</dd></div>
      </dl>
    </section>

    <form class="amount-filter" data-amount-filter>
      <div class="filter-line">
        <label for="min-notional">单笔买入</label>
        <input id="min-notional" data-min-notional type="number" min="0" step="any" inputmode="decimal" value="${minNotional == null ? "" : escapeHtml(String(minNotional))}" placeholder="大于">
        <span aria-hidden="true">–</span>
        <input id="max-notional" data-max-notional type="number" min="0" step="any" inputmode="decimal" value="${maxNotional == null ? "" : escapeHtml(String(maxNotional))}" placeholder="小于" aria-label="小于">
        <span>美元</span>
        <button type="submit">应用</button>
        ${amountActive() ? `<button type="button" data-clear-min>清除</button>` : ""}
      </div>
      <div class="filter-line">
        <span>时间范围</span>
        <div class="filter-picks">
          <button type="button" data-window-days="" aria-pressed="${windowDays == null ? "true" : "false"}">全部</button>
          ${TIME_WINDOWS.map((days) => `<button type="button" data-window-days="${days}" aria-pressed="${windowDays === days ? "true" : "false"}">最近${days}天</button>`).join("")}
        </div>
      </div>
      <p>${filterHelp(data)}</p>
    </form>

    ${renderDomainTabs(full.categories, domain)}

    <section class="panel" id="categories">
      <header>
        <h3>市场领域</h3>
        <p>一个市场只计一次。占比是该领域的市场数占全部市场。胜率是盈利市场 / 已结束市场，括号里是这个比例；卖出或持有到结算后赚钱才算盈利。总胜率 ${overallRate}。上面的标签可以多选，决定这一栏以下的统计范围，这一栏本身始终按全部领域计算。点某一行同样可以加入或移出。明细默认收起，每页 ${PAGE_SIZE} 条。</p>
      </header>
      <p class="scope-line">${scoped
        ? `当前只看${escapeHtml(scopeName)}。页头和下面的统计都只含所选领域，占比的分母也是所选领域自己的合计。注册日期仍是整个账户。`
        : "当前是全部领域。"}${timeText ? `时间筛选下，只含最近 ${windowDays} 天的成交。` : ""}${amountText ? `金额筛选下，只含${amountText} 的成交。` : ""}</p>
      <div class="bar-row bar-head">
        <span></span>
        <span></span>
        <span>市场数</span>
        <span>占比</span>
        <span>胜率</span>
      </div>
      <div class="domains">
        ${full.categories.map((item, index) => renderDomain(item, index, domain)).join("") || `<p class="empty">没有可归类的市场。</p>`}
      </div>
    </section>

    <section class="metrics">
      <article class="panel">
        <header><h3>买入与卖出</h3><p>次数是成交笔数，数量是份额。</p></header>
        <div class="split">
          <div>
            <span class="label buy">买入</span>
            <strong class="num">${stats.buys.count.toLocaleString("zh-CN")}</strong>
            <em>笔</em>
            <p>${shares.format(stats.buys.shares)} 份</p>
            <p class="muted">成交额 ${money.format(stats.buys.usdc)}</p>
          </div>
          <div>
            <span class="label sell">卖出</span>
            <strong class="num">${stats.sells.count.toLocaleString("zh-CN")}</strong>
            <em>笔</em>
            <p>${shares.format(stats.sells.shares)} 份</p>
            <p class="muted">成交额 ${money.format(stats.sells.usdc)}</p>
          </div>
        </div>
      </article>

      <article class="panel">
        <header><h3>平均持有时长</h3><p>同一结果代币按先进先出，按份额加权。</p></header>
        <strong class="num hero">${formatDuration(stats.avgHoldSeconds)}</strong>
        <ul class="fine">
          <li>已计入 ${shares.format(stats.holdShares)} 份</li>
          <li>仍持有、尚未结算 ${shares.format(stats.openShares)} 份</li>
          <li>窗口前已持有、窗口内才卖出 ${shares.format(stats.unmatchedSellShares)} 份，时长无法还原</li>
        </ul>
      </article>

      <article class="panel">
        <header><h3>买入持仓至结算</h3><p>已结算市场中，买入后直到结算都没有卖出。</p></header>
        <p class="fraction"><span class="num">${hold.settled ? hold.qualified.toLocaleString("zh-CN") : "—"}</span><span>/</span><span class="num">${hold.settled ? hold.settled.toLocaleString("zh-CN") : "—"}</span></p>
        <p class="ratio">${ratio == null ? "这批成交里没有已结算市场" : `${percent.format(ratio)} 的已结算市场`}</p>
        <ul class="fine">
          <li>结算前卖出过 ${hold.soldBeforeSettlement.toLocaleString("zh-CN")}</li>
          <li>没有买入 ${hold.noBuy.toLocaleString("zh-CN")}</li>
          <li>结算后才买入 ${hold.boughtAfter.toLocaleString("zh-CN")}</li>
          ${hold.unknown ? `<li>结算状态未知 ${hold.unknown.toLocaleString("zh-CN")}</li>` : ""}
        </ul>
      </article>

      <article class="panel">
        <header><h3>平均买入成本</h3><p>买入成交额 ÷ 买入份额，即加权平均价格。</p></header>
        <strong class="num hero">${stats.avgBuyCost == null ? "—" : price.format(stats.avgBuyCost)}</strong>
        <p class="muted">每份付出的 USDC</p>
      </article>

      <article class="panel">
        <header><h3>平均买入金额</h3><p>买入成交额 ÷ 买入笔数。</p></header>
        <strong class="num hero">${stats.avgBuyAmount == null ? "—" : money.format(stats.avgBuyAmount)}</strong>
        <p class="muted">每一笔买入的平均成交额</p>
      </article>
    </section>

    ${renderPriceBuckets(stats)}

    ${renderAmountBuckets(stats)}

    ${renderPerformance(data, stats, domain)}

    ${data.warnings.length ? `<ul class="warnings">${data.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}

    <details class="notes">
      <summary>统计口径</summary>
      <ol>
        <li>除注册日期外，只使用该地址最近 5,000 笔成交，包含挂单成交。更早的成交不参与其他统计。</li>
        <li>市场按 condition 计算。一场比赛拆成胜、平、负时，会计成三个市场。</li>
        <li>领域只取 Gamma 事件上的标签，并且只分成五类。政治包含政治、国际、地缘政治、选举；加密、天气、体育各自单独一类。其余都归入其他。不使用市场自己的标签。</li>
        <li>市场领域上面的标签，或领域栏里的一行，都可以多选。页头的成交、市场、时间范围，以及下面的买入、持仓、盈亏、价格分布、金额分布和前十名，都只重算所选领域。盈利占比和成交占比的分母换成所选领域自己的合计。再点一次移出该领域，点「全部」回到全部领域。注册日期不随领域变化。领域栏本身始终按全部领域计算。</li>
        <li>买入价格分布只统计买入。价格每 0.20 一档：小于 0.20，然后 0.20–0.40、0.40–0.60，以此类推。正好等于分界价格时归入下一档，1.00 仍算在 0.80–1.00。金额是价格 × 份额，占比的分母是当前范围内全部买入金额。均价是该档买入成交额 ÷ 买入份额。胜率按市场算：这一档里有过买入的市场里，已结束且赚钱的占比。未结束不进分母。同一市场的买入落在多档时，每一档都计入。期望 = (1 − 均价) × 胜率 − 均价 × (1 − 胜率)。每个价格带再按其中最大的一笔买入分成五档，每 20% 一档。金额范围是该档的美元区间，均额是其中买入金额合计 ÷ 笔数，笔数占比的分母是这个价格带的买入笔数。正好等于 20%、40%、60%、80% 时归入下一档，最大的一笔留在 80–100%。胜率仍按市场算，同一市场的不同买入可以落在多个金额区间。金额分档的期望用这一档自己的均价和胜率。</li>
        <li>买入金额分布只统计买入，卖出不计入。市场按该市场全部买入合计，交易按每一笔买入。两张表各自用当前范围内的最大买入金额做 100%，每 20% 一档。正好等于 20%、40%、60%、80% 时归入下一档，最大的一笔留在 80–100%。没有买入的市场不计入市场数。均额是该区间买入金额合计 ÷ 市场数或笔数。胜率口径与价格分布相同。期望口径也相同，均价是该区间买入成交额 ÷ 买入份额。按市场时，市场只在自己的金额档里；按交易时，这一档里有过买入的市场计入该档。</li>
        <li>单笔买入可以填一个范围。只填左边表示大于该金额，只填右边表示小于该金额，两个都填表示大于左边并且小于右边。金额是价格 × 份额。卖出不计入，等于边界不算。清除或两边都留空后恢复全部成交。</li>
        <li>时间范围和金额筛选同一层。可选最近 30、60、90、180 天，从现在往前算，只保留这段时间里的成交。点「全部」取消时间限制。它和金额筛选可以一起用：先按时间留下成交，再按单笔买入范围筛选。已加载的成交如果盖不满所选天数，就只统计已有的部分。注册日期不随时间变化。</li>
        <li>持有时长里，卖出视为离场；结算时还没卖掉的份额，用结算时间离场。未结算的持仓不计入平均。</li>
        <li>持有至结算要求：该市场已结算，窗口内有买入，且从第一笔买入到结算时刻没有出现任何卖出。卖掉一部分也算卖出。</li>
        <li>结算状态来自 Polymarket 市场资料。成交记录本身不包含结算时间。</li>
        <li>查过的地址保存在这个浏览器里。再次查询直接读缓存；要更新成交，点「重新获取」。</li>
        <li>买入代币是这笔成交买卖的结果代币。市场结果是结算后的获胜结果，未结算留空。</li>
        <li>盈亏只统计已经结束的市场：份额已全部卖出，或市场已结算且能确定获胜结果。仍持有的未结算仓位不计入盈亏、胜率、利润因子和夏普。</li>
        <li>卖出按成交价计算；持有到结算时，获胜代币按每份 $1，失败代币按 $0。一个市场的合计盈亏大于 0 记为胜利。</li>
        <li>收益率 = 累计盈亏 ÷ 已结束市场的买入成本。盈亏比 = 平均盈利 ÷ 平均亏损。期望值 = 累计盈亏 ÷ 已结束市场数。利润因子 = 全部盈利 ÷ 全部亏损。</li>
        <li>夏普和索提诺用北京时间的每日盈亏，空白日子记为 0，无风险利率按 0，再按 365 天年化。盈亏记在卖出日或结算日。</li>
        <li>盈利前 10 名的占比，分母是当前查看范围里的全部盈利金额。成交金额前 10 名按买入加卖出的成交额排序，占比的分母是当前查看范围里全部市场的成交金额，未结束的市场也计入。每个市场的平均买入成本是买入成交额 ÷ 买入份额；平均持仓天数与全账户持有时长同一口径，再换算成天。窗口开始前已经持有、窗口内才卖出的份额，成本无法还原，不计入盈亏。</li>
      </ol>
    </details>
  `;
  if (scroll) report.scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

async function analyze(raw, options = {}) {
  const address = parseAddress(raw);
  if (!address) {
    report.hidden = true;
    showStatus("请输入 Polymarket 地址，或带有 0x 地址的主页链接。", true);
    return;
  }
  const keepDomains = options.refresh && currentData?.address === address ? selectedDomains : [];
  const keepMin = options.refresh && currentData?.address === address ? minNotional : null;
  const keepMax = options.refresh && currentData?.address === address ? maxNotional : null;
  const keepWindow = options.refresh && currentData?.address === address ? windowDays : null;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  setBusy(true);
  report.hidden = true;
  showStatus(options.refresh ? "正在重新获取…" : "正在读取…");
  try {
    const loaded = await loadReport(address, (message) => showStatus(message), signal, options);
    if (signal.aborted) return;
    showStatus("正在计算…");
    currentData = loaded;
    fullStats = computeReport(loaded.trades, loaded.marketInfo);
    const available = new Set(fullStats.categories.map((item) => item.name));
    selectedDomains = keepDomains.filter((name) => available.has(name));
    minNotional = keepMin;
    maxNotional = keepMax;
    windowDays = keepWindow;
    showStatus("");
    showView(true);
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") {
      if (controller?.signal === signal) showStatus("已取消。");
      return;
    }
    report.hidden = true;
    showStatus(error?.message || "分析失败，请稍后重试。", true);
  } finally {
    if (controller?.signal === signal) setBusy(false);
  }
}

report.addEventListener("submit", (event) => {
  if (!event.target.closest("[data-amount-filter]")) return;
  event.preventDefault();
  applyMinNotional();
});

report.addEventListener("click", (event) => {
  const hint = event.target.closest("button.hint");
  if (hint) {
    const open = hint.getAttribute("aria-expanded") === "true";
    report.querySelectorAll("button.hint[aria-expanded='true']").forEach((node) => node.setAttribute("aria-expanded", "false"));
    if (!open) hint.setAttribute("aria-expanded", "true");
    return;
  }
  report.querySelectorAll("button.hint[aria-expanded='true']").forEach((node) => node.setAttribute("aria-expanded", "false"));
  if (event.target.closest("[data-clear-min]")) {
    minNotional = null;
    maxNotional = null;
    showView(false);
    return;
  }
  const windowButton = event.target.closest("button[data-window-days]");
  if (windowButton) {
    const next = windowButton.dataset.windowDays ? Number(windowButton.dataset.windowDays) : null;
    if (next !== windowDays) {
      windowDays = next;
      showView(false);
    }
    return;
  }
  if (event.target.closest("[data-domain-all]")) {
    if (selectedDomains.length) {
      selectedDomains = [];
      showView(false);
    }
    return;
  }
  const domainButton = event.target.closest("button[data-domain-index]");
  if (domainButton) {
    const name = currentCategories[Number(domainButton.dataset.domainIndex)]?.name;
    if (name === undefined) return;
    const next = new Set(selectedDomains);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    selectedDomains = currentCategories.filter((item) => next.has(item.name)).map((item) => item.name);
    showView(false);
    return;
  }
  if (event.target.closest("[data-refresh]")) {
    analyze(input.value, { refresh: true });
    return;
  }
  const rankPanel = event.target.closest(".rank-panel");
  if (rankPanel) {
    const openButton = event.target.closest("button[data-open-rank]");
    if (openButton) {
      const id = openButton.getAttribute("data-open-rank");
      const same = rankPanel.dataset.openId === id;
      rankPanel.dataset.openId = same ? "" : id;
      rankPanel.dataset.tradeIndex = "0";
      paintRank(rankPanel);
      if (!same) rankPanel.querySelector(".market-trades")?.scrollIntoView({ block: "nearest" });
      return;
    }
    const pageButton = event.target.closest("button[data-rank-page]");
    if (pageButton && !pageButton.disabled) {
      rankPanel.dataset.tradeIndex = pageButton.dataset.rankPage;
      paintRank(rankPanel);
      rankPanel.querySelector(".market-trades")?.scrollIntoView({ block: "nearest" });
    }
    return;
  }
  const details = event.target.closest("details.fold");
  if (!details) return;
  const viewButton = event.target.closest("button[data-view]");
  if (viewButton) {
    details.dataset.mode = viewButton.dataset.view;
    details.dataset.openId = "";
    details.dataset.tradeIndex = "0";
    paintDetail(details);
    return;
  }
  const timeButton = event.target.closest("button[data-time-page]");
  if (timeButton && !timeButton.disabled) {
    details.dataset.timeIndex = timeButton.dataset.timePage;
    paintDetail(details, { scroll: true });
    return;
  }
  const marketButton = event.target.closest("button[data-market-page]");
  if (marketButton && !marketButton.disabled) {
    details.dataset.marketIndex = marketButton.dataset.marketPage;
    paintDetail(details, { scroll: true });
    return;
  }
  const tradeButton = event.target.closest("button[data-trade-page]");
  if (tradeButton && !tradeButton.disabled) {
    details.dataset.tradeIndex = tradeButton.dataset.tradePage;
    paintDetail(details);
    details.querySelector(".market-trades")?.scrollIntoView({ block: "nearest" });
    return;
  }
  const openButton = event.target.closest("button[data-open-market]");
  if (openButton) {
    const id = openButton.getAttribute("data-open-market");
    const same = details.dataset.openId === id;
    details.dataset.openId = same ? "" : id;
    details.dataset.tradeIndex = "0";
    paintDetail(details);
    if (!same) details.querySelector(".market-trades")?.scrollIntoView({ block: "nearest" });
  }
});

report.addEventListener("toggle", (event) => {
  const details = event.target;
  if (!details.classList?.contains("fold") || !details.open) return;
  paintDetail(details);
}, true);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  analyze(input.value);
});

cancel.addEventListener("click", () => controller?.abort());
example.addEventListener("click", () => {
  input.value = "0x983eedfbd75803602e4a6e6ea9aab6dc6b9c6748";
  analyze(input.value);
});

if (location.protocol === "file:") {
  showStatus("请先运行 node server.js，再打开 http://127.0.0.1:3780 。不要直接双击这个文件。", true);
}

const preset = new URLSearchParams(location.search).get("address");
if (preset) {
  input.value = preset;
  analyze(preset);
}
