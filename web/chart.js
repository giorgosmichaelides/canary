/**
 * Canary chart: the commodity basket's price on top, unison underneath, same dates.
 *
 * The point it makes: the price looks fairly calm while correlation is already
 * climbing. It listens to /events by itself (tick -> prices, view -> unison,
 * risk and rebound, card -> the card marker, decision -> approved/vetoed), so it
 * needs nothing from app.js. Owned by Quant.
 *
 * Mount point: <div id="canary-chart"></div>. For offline testing,
 * window.CanaryChart.handle(message) feeds a message by hand.
 */
(function () {
  "use strict";

  /** Trading days in each replay window (from canary.sim.REPLAYS). */
  const REPLAY_DAYS = { "2020": 48, "2024": 44, "2008": 126, "2022": 84 };
  /** The risk basket: commodity currencies, the first to fall in a panic. */
  const RISK_BASKET = ["AUD", "CAD", "NOK"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** Colours by role (dark page). Series pair validated on #0b0d12 with the dataviz validator. */
  const C = {
    surface: "#0b0d12",
    ink: "#f0efec",
    ink2: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    price: "#3987e5",
    unison: "#d95926",
    rebound: "rgba(137, 135, 129, 0.16)",
  };

  /** The price axis always shows at least this range (index, first day = 100). */
  const PRICE_MIN = 85;
  const PRICE_MAX = 105;
  const PAD = { left: 48, right: 72, top: 30, gap: 46, bottom: 28 };
  const PANEL_H = 150;

  /** Everything the chart knows. Reset when a new replay starts. */
  let state = freshState(null);

  /**
   * An empty chart state.
   * @param {string|null} replay Replay name, e.g. "2020".
   * @returns {object} State.
   */
  function freshState(replay) {
    return { replay, synthetic: false, base: null, days: [], byDate: {}, card: null, hover: null };
  }

  // ---------------------------------------------------------------- DOM

  const root = document.getElementById("canary-chart");
  if (!root) return;

  const style = document.createElement("style");
  style.textContent = `
    .cc { width: min(760px, 94vw); color: ${C.ink2}; font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; }
    .cc h2 { font-size: 15px; font-weight: 600; color: ${C.ink}; margin: 0 0 2px; }
    .cc .sub { color: ${C.muted}; margin: 0 0 8px; }
    .cc .wrap { position: relative; border: 1px solid rgba(255,255,255,0.10); border-radius: 8px; }
    .cc canvas { display: block; width: 100%; border-radius: 8px; outline: none; }
    .cc canvas:focus-visible { box-shadow: 0 0 0 2px ${C.price}; }
    .cc .tip { position: absolute; pointer-events: none; background: #16181f; border: 1px solid rgba(255,255,255,0.12);
               border-radius: 6px; padding: 6px 8px; min-width: 150px; display: none; font-variant-numeric: tabular-nums; }
    .cc .tip .d { color: ${C.muted}; margin-bottom: 4px; }
    .cc .tip .r { display: flex; align-items: center; gap: 6px; }
    .cc .tip .k { width: 12px; height: 2px; border-radius: 1px; }
    .cc .tip b { color: ${C.ink}; font-weight: 600; }
    .cc details { margin-top: 6px; color: ${C.muted}; }
    .cc table { border-collapse: collapse; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .cc th, .cc td { padding: 2px 10px 2px 0; text-align: right; }
    .cc th:first-child, .cc td:first-child, .cc td:last-child { text-align: left; }
  `;
  document.head.appendChild(style);

  root.className = "cc";
  const title = el("h2", "Price vs correlation");
  const sub = el("p", "Waiting for the replay to start…");
  sub.className = "sub";
  const wrap = el("div");
  wrap.className = "wrap";
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Commodity currency price index and unison over the replay. Data table below.");
  const tip = el("div");
  tip.className = "tip";
  wrap.append(canvas, tip);
  const details = el("details");
  details.append(el("summary", "Data table"));
  const table = el("table");
  details.append(table);
  root.append(title, sub, wrap, details);

  /**
   * Make an element with optional text (never HTML).
   * @param {string} tag Tag name.
   * @param {string} [text] Text content.
   * @returns {HTMLElement} The element.
   */
  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------- data

  /**
   * Apply one bus message to the chart state.
   * @param {object} msg A message from /events.
   * @returns {void}
   */
  function handle(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "tick") onTick(msg);
    else if (msg.type === "view") onView(msg);
    else if (msg.type === "card" && msg.card) onCard(msg.card);
    else if (msg.type === "decision") onDecision(msg);
    else return;
    scheduleDraw();
  }

  /**
   * A new trading day: record the risk basket's price index.
   * @param {object} msg Tick message {replay, i, date, prices, synthetic}.
   * @returns {void}
   */
  function onTick(msg) {
    const replay = String(msg.replay);
    const i = Number(msg.i);
    const last = state.days.length - 1;
    if (replay !== state.replay || (last >= 0 && i < last)) state = freshState(replay);
    state.synthetic = Boolean(msg.synthetic);
    const prices = msg.prices || {};
    if (!state.base) state.base = { date: msg.date, prices };
    const values = RISK_BASKET.map((c) => (100 * prices[c]) / state.base.prices[c]);
    const index = values.reduce((a, b) => a + b, 0) / values.length;
    const day = state.days[i] || { unison: null, risk: null, rebound: false };
    Object.assign(day, { i, date: msg.date, index });
    state.days[i] = day;
    state.byDate[msg.date] = day;
  }

  /**
   * An analyst's view: take unison, risk (once computed) and rebound for its date.
   * @param {object} msg View message.
   * @returns {void}
   */
  function onView(msg) {
    const day = state.byDate[msg.date];
    if (!day) return;
    if (typeof msg.unison === "number") day.unison = msg.unison;
    if (typeof msg.risk === "number") day.risk = msg.risk;
    if (typeof msg.rebound === "boolean") day.rebound = msg.rebound;
  }

  /**
   * The relay's one-per-id card event.
   * @param {object} card Escalation {id, date, action}.
   * @returns {void}
   */
  function onCard(card) {
    if (!state.card || state.card.id !== card.id) {
      state.card = { id: card.id, date: card.date, action: card.action, verdict: null, by: null };
    }
  }

  /**
   * A human decision on the card.
   * @param {object} msg Decision {id, verdict, by}.
   * @returns {void}
   */
  function onDecision(msg) {
    if (state.card && state.card.id === msg.id) {
      state.card.verdict = msg.verdict;
      state.card.by = msg.by || null;
    }
  }

  // ---------------------------------------------------------------- drawing

  let drawQueued = false;

  /** Redraw on the next animation frame (coalesces bursts of messages). @returns {void} */
  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
      updateText();
    });
  }

  /**
   * Format a "YYYY-MM-DD" date as "2 Mar".
   * @param {string} date ISO date.
   * @returns {string} Short date.
   */
  function shortDate(date) {
    const [, m, d] = date.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  }

  /**
   * Chart geometry for the current size and data.
   * @returns {object} Sizes, scales and panel rectangles.
   */
  function layout() {
    const width = Math.max(320, wrap.clientWidth);
    const height = PAD.top + PANEL_H + PAD.gap + PANEL_H + PAD.bottom;
    const n = Math.max(REPLAY_DAYS[state.replay] || 48, state.days.length);
    const plotW = width - PAD.left - PAD.right;
    const x = (i) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
    const top = { y0: PAD.top, y1: PAD.top + PANEL_H };
    const bot = { y0: top.y1 + PAD.gap, y1: top.y1 + PAD.gap + PANEL_H };
    // Fixed scale (at least 85-105) so a 2% wobble looks like a 2% wobble and
    // the axis doesn't rescale while the replay plays; widens only for big falls.
    const seen = state.days.filter(Boolean).map((d) => d.index);
    let lo = Math.min(PRICE_MIN, ...seen);
    let hi = Math.max(PRICE_MAX, ...seen);
    const step = niceStep((hi - lo) / 4 || 1);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    if (hi === lo) hi = lo + step;
    const yPrice = (v) => top.y1 - ((v - lo) / (hi - lo)) * PANEL_H;
    const yUni = (v) => bot.y1 - v * PANEL_H;
    return { width, height, n, plotW, x, top, bot, lo, hi, step, yPrice, yUni };
  }

  /**
   * A round tick step (1, 2 or 5 times a power of ten).
   * @param {number} raw Rough step.
   * @returns {number} Nice step.
   */
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  /** Paint the whole chart. @returns {void} */
  function draw() {
    const L = layout();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(L.width * dpr);
    canvas.height = Math.round(L.height * dpr);
    canvas.style.height = `${L.height}px`;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.surface;
    g.fillRect(0, 0, L.width, L.height);
    g.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textBaseline = "middle";

    const days = state.days.filter(Boolean);

    // Rebound days: a quiet wash across both panels.
    g.fillStyle = C.rebound;
    const half = L.n > 1 ? L.plotW / (L.n - 1) / 2 : 4;
    for (const d of days) {
      if (d.rebound) g.fillRect(L.x(d.i) - half, L.top.y0, half * 2, L.bot.y1 - L.top.y0);
    }

    // Panel titles.
    g.fillStyle = C.ink2;
    g.textAlign = "left";
    g.fillText("Commodity currencies (AUD, CAD, NOK), price index", PAD.left, L.top.y0 - 14);
    g.fillText("Unison: 0 = four separate parts, 1 = one note", PAD.left, L.bot.y0 - 14);

    // Gridlines and y labels.
    g.lineWidth = 1;
    g.textAlign = "right";
    for (let v = L.lo; v <= L.hi + 1e-9; v += L.step) hline(g, L, L.yPrice(v), v.toFixed(L.step < 1 ? 1 : 0));
    for (const v of [0, 0.5, 1]) hline(g, L, L.yUni(v), v.toFixed(1));

    // Month labels under the bottom panel, at the first trading day of each month.
    g.fillStyle = C.muted;
    g.textAlign = "center";
    let lastMonth = null;
    for (const d of days) {
      const month = d.date.slice(0, 7);
      if (month !== lastMonth) {
        const label = lastMonth === null ? shortDate(d.date) : MONTHS[Number(d.date.slice(5, 7)) - 1];
        g.fillText(label, L.x(d.i), L.bot.y1 + 14);
        lastMonth = month;
      }
    }

    // The card: a hairline through both panels, labelled in text ink.
    if (state.card && state.byDate[state.card.date]) {
      const cx = L.x(state.byDate[state.card.date].i);
      g.strokeStyle = C.ink2;
      g.beginPath();
      g.moveTo(cx, L.top.y0 - 4);
      g.lineTo(cx, L.bot.y1);
      g.stroke();
      const verdict = state.card.verdict ? ` · ${state.card.verdict === "approve" ? "approved" : "vetoed"}` : " · awaiting decision";
      const name = `Card ${shortDate(state.card.date)}`;
      // Longest label that fits beside the line (right first, then left); never clipped.
      const options = [`${name}: ${state.card.action}${verdict}`, `${name}${verdict}`, name];
      const roomRight = L.width - 4 - (cx + 6);
      const roomLeft = cx - 6 - 4;
      let text = options[options.length - 1];
      let align = "left";
      for (const option of options) {
        const w = g.measureText(option).width;
        if (w <= roomRight) { text = option; align = "left"; break; }
        if (w <= roomLeft) { text = option; align = "right"; break; }
      }
      g.fillStyle = C.ink;
      g.textAlign = align;
      g.fillText(text, cx + (align === "left" ? 6 : -6), L.top.y0 + 10);
    }

    // The two series.
    line(g, days, (d) => d.index, L.yPrice, L, C.price);
    line(g, days.filter((d) => d.unison !== null), (d) => d.unison, L.yUni, L, C.unison);

    // End labels at today's values.
    const today = days[days.length - 1];
    if (today) {
      endLabel(g, L.x(today.i), L.yPrice(today.index), today.index.toFixed(1), C.price);
      if (today.unison !== null) endLabel(g, L.x(today.i), L.yUni(today.unison), today.unison.toFixed(2), C.unison);
    }

    // Hover crosshair.
    if (state.hover !== null && state.days[state.hover]) {
      const hx = L.x(state.hover);
      g.strokeStyle = C.muted;
      g.beginPath();
      g.moveTo(hx, L.top.y0);
      g.lineTo(hx, L.bot.y1);
      g.stroke();
    }
  }

  /**
   * One horizontal gridline with its value on the left.
   * @param {CanvasRenderingContext2D} g Context.
   * @param {object} L Layout.
   * @param {number} y Pixel y.
   * @param {string} label Tick label.
   * @returns {void}
   */
  function hline(g, L, y, label) {
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(PAD.left, y + 0.5);
    g.lineTo(L.width - PAD.right, y + 0.5);
    g.stroke();
    g.fillStyle = C.muted;
    g.fillText(label, PAD.left - 8, y);
  }

  /**
   * A 2px series line.
   * @param {CanvasRenderingContext2D} g Context.
   * @param {object[]} days Days to plot, in order.
   * @param {(d: object) => number} value Value of a day.
   * @param {(v: number) => number} y Value to pixel y.
   * @param {object} L Layout.
   * @param {string} color Series colour.
   * @returns {void}
   */
  function line(g, days, value, y, L, color) {
    if (days.length === 0) return;
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.beginPath();
    days.forEach((d, k) => (k === 0 ? g.moveTo(L.x(d.i), y(value(d))) : g.lineTo(L.x(d.i), y(value(d)))));
    g.stroke();
    g.lineWidth = 1;
  }

  /**
   * The latest point: an 8px dot with a 2px surface ring, value beside it in text ink.
   * @param {CanvasRenderingContext2D} g Context.
   * @param {number} x Pixel x.
   * @param {number} y Pixel y.
   * @param {string} text Value label.
   * @param {string} color Series colour.
   * @returns {void}
   */
  function endLabel(g, x, y, text, color) {
    g.fillStyle = C.surface;
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.ink;
    g.textAlign = "left";
    g.fillText(text, x + 10, y);
  }

  /** Subtitle and data table. @returns {void} */
  function updateText() {
    const days = state.days.filter(Boolean);
    if (days.length === 0) return;
    const last = days[days.length - 1];
    const fake = state.synthetic ? "SYNTHETIC DATA · " : "";
    sub.textContent = `${fake}Replay ${state.replay}: price index = 100 on ${shortDate(state.base.date)}; now ${shortDate(last.date)}. Shaded: rebound days.`;
    if (!details.open) return;
    table.replaceChildren();
    const head = el("tr");
    for (const h of ["Date", "Price index", "Unison", "Risk", "Event"]) head.append(el("th", h));
    table.append(head);
    for (const d of days) {
      const row = el("tr");
      row.append(
        el("td", d.date),
        el("td", d.index.toFixed(1)),
        el("td", d.unison === null ? "–" : d.unison.toFixed(2)),
        el("td", d.risk === null ? "–" : d.risk.toFixed(2)),
        el("td", eventText(d)),
      );
      table.append(row);
    }
  }

  /**
   * Events on a day, in words.
   * @param {object} d Day.
   * @returns {string} e.g. "Card: Cut commodity by 30%" or "Rebound".
   */
  function eventText(d) {
    const parts = [];
    if (state.card && state.card.date === d.date) parts.push(`Card: ${state.card.action}`);
    if (d.rebound) parts.push("Rebound");
    return parts.join(" · ");
  }

  // ---------------------------------------------------------------- hover

  /**
   * Show the crosshair and tooltip for one day.
   * @param {number|null} i Day index, or null to hide.
   * @returns {void}
   */
  function setHover(i) {
    state.hover = i;
    draw();
    const d = i === null ? null : state.days[i];
    if (!d) {
      tip.style.display = "none";
      return;
    }
    const L = layout();
    tip.replaceChildren();
    tip.append(el("div", d.date));
    tip.firstChild.className = "d";
    tip.append(row(d.index.toFixed(1), "price index", C.price));
    if (d.unison !== null) tip.append(row(d.unison.toFixed(2), "unison", C.unison));
    if (d.risk !== null) tip.append(row(d.risk.toFixed(2), "risk", null));
    const ev = eventText(d);
    if (ev) tip.append(el("div", ev));
    tip.style.display = "block";
    const x = L.x(i);
    const left = x + 12 + tip.offsetWidth > L.width ? x - 12 - tip.offsetWidth : x + 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${L.top.y0}px`;
  }

  /**
   * One tooltip row: value first (strong), then the series name, with a line key.
   * @param {string} value Formatted value.
   * @param {string} name Series name.
   * @param {string|null} color Series colour, or null for no key.
   * @returns {HTMLElement} The row.
   */
  function row(value, name, color) {
    const r = el("div");
    r.className = "r";
    const key = el("span");
    key.className = "k";
    key.style.background = color || "transparent";
    r.append(key, el("b", value), el("span", name));
    return r;
  }

  canvas.addEventListener("pointermove", (e) => {
    const L = layout();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = null;
    for (const d of state.days) {
      if (d && (best === null || Math.abs(L.x(d.i) - px) < Math.abs(L.x(best) - px))) best = d.i;
    }
    if (best !== state.hover) setHover(best);
  });
  canvas.addEventListener("pointerleave", () => setHover(null));
  canvas.addEventListener("blur", () => setHover(null));
  canvas.addEventListener("keydown", (e) => {
    const seen = state.days.filter(Boolean).map((d) => d.i);
    if (seen.length === 0) return;
    const pos = state.hover === null ? seen.length - 1 : seen.indexOf(state.hover);
    if (e.key === "ArrowLeft") setHover(seen[Math.max(0, pos - 1)]);
    else if (e.key === "ArrowRight") setHover(seen[Math.min(seen.length - 1, pos + 1)]);
    else return;
    e.preventDefault();
  });
  details.addEventListener("toggle", updateText);
  window.addEventListener("resize", scheduleDraw);

  // ---------------------------------------------------------------- wiring

  window.CanaryChart = { handle };
  scheduleDraw();
  if (typeof EventSource !== "undefined" && location.protocol.startsWith("http")) {
    const source = new EventSource("/events");
    source.onmessage = (e) => {
      try {
        handle(JSON.parse(e.data));
      } catch (err) {
        console.warn("chart: bad event", err);
      }
    };
  }
})();
