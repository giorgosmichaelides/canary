/**
 * Canary: the score. A scrolling canvas keyed on market dates (never bars):
 * one staff per analyst, one note per opinion per day. Height = stance,
 * opacity = conviction, colour = author, ring = covered by a neighbour.
 * A risk staff shows a bar per day with 0.50 marked. Dashed lines mark the
 * escalation (red) and the decision (green approve, orange veto). Click a note
 * for its date, author, numbers and reason.
 *
 * Exposes a single global: `Score`.
 */
const Score = (() => {
  /** Staff order (top to bottom). */
  const SLICES = ["fx", "havens", "commodity", "contrarian"];

  /** Colour per author. */
  const COLOURS = { fx: "#5b9dff", havens: "#b48cff", commodity: "#ffb347", contrarian: "#4fd1c5" };

  /** Layout in CSS pixels. */
  const LABEL_W = 92;
  const COL_W = 16;
  const STAFF_H = 54;
  const RISK_H = 46;
  const PAD = 10;
  const NOTE_R = 4.5;

  /** date -> {views: {slice: view}, risk, unison, rebound, escalation, decision} */
  const days = new Map();

  /** Hit targets from the last render, for clicks: {x, y, date, view}. */
  let hits = [];

  /** Canvas, its 2D context and the info element; set in init(). */
  let canvas = null;
  let ctx = null;
  let info = null;

  /** True when a render is already queued for the next animation frame. */
  let queued = false;

  /**
   * Attach to the page.
   * @param {HTMLCanvasElement} canvasEl The score canvas.
   * @param {HTMLElement} infoEl Where clicked-note details go.
   * @returns {void}
   */
  function init(canvasEl, infoEl) {
    canvas = canvasEl;
    ctx = canvas.getContext("2d");
    info = infoEl;
    canvas.addEventListener("click", onClick);
    new ResizeObserver(requestRender).observe(canvas);
    requestRender();
  }

  /**
   * Get (or create) the record for a date.
   * @param {string} date Market date "YYYY-MM-DD".
   * @returns {Object} The day record.
   */
  function day(date) {
    if (!days.has(date)) days.set(date, { views: {}, risk: null, unison: null, rebound: false, escalation: null, decision: null });
    return days.get(date);
  }

  /**
   * Add a `view` message. Views are merged per slice, newest `ts` wins.
   * @param {Object} msg A view message.
   * @returns {void}
   */
  function addView(msg) {
    if (!msg.date) return;
    const d = day(msg.date);
    for (const v of msg.views || []) {
      const old = d.views[v.slice];
      if (!old || (v.ts || 0) >= (old.ts || 0)) d.views[v.slice] = v;
    }
    d.risk = msg.risk;
    d.unison = msg.unison;
    d.rebound = Boolean(msg.rebound);
    if (msg.escalation) d.escalation = msg.escalation;
    requestRender();
  }

  /**
   * Add a `decision` message (drawn on its market date).
   * @param {Object} msg A decision message.
   * @returns {void}
   */
  function addDecision(msg) {
    if (!msg.market_date) return;
    day(msg.market_date).decision = msg;
    requestRender();
  }

  /**
   * Update a reason line that arrived late (`reason` message).
   * @param {Object} msg A reason message: by, slice, date, text.
   * @returns {void}
   */
  function addReason(msg) {
    const v = days.get(msg.date)?.views[msg.slice];
    if (v && v.by === msg.by) v.reason = msg.text;
  }

  /**
   * Queue a render on the next animation frame (coalesces bursts of messages).
   * @returns {void}
   */
  function requestRender() {
    if (queued || !canvas) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  }

  /**
   * Draw a dashed vertical line.
   * @param {number} x X position.
   * @param {number} y0 Top.
   * @param {number} y1 Bottom.
   * @param {string} colour Stroke colour.
   * @returns {void}
   */
  function dashed(x, y0, y1, colour) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Redraw the whole score; the newest date sits at the right edge.
   * @returns {void}
   */
  function render() {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = PAD * 2 + SLICES.length * STAFF_H + RISK_H + 18;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";

    const dates = [...days.keys()].sort();
    const fit = Math.max(1, Math.floor((width - LABEL_W - PAD) / COL_W));
    const shown = dates.slice(-fit);
    const xOf = (i) => LABEL_W + i * COL_W + COL_W / 2;
    const bottom = PAD + SLICES.length * STAFF_H + RISK_H;
    hits = [];

    // Staff labels and centre lines (stance 0).
    SLICES.forEach((slice, row) => {
      const mid = PAD + row * STAFF_H + STAFF_H / 2;
      ctx.fillStyle = COLOURS[slice];
      ctx.fillText(slice, 8, mid);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(LABEL_W - 6, mid);
      ctx.lineTo(width - PAD, mid);
      ctx.stroke();
    });
    const riskTop = PAD + SLICES.length * STAFF_H + 6;
    const riskBase = riskTop + RISK_H - 10;
    ctx.fillStyle = "#e8e8ee";
    ctx.fillText("risk", 8, riskTop + (RISK_H - 10) / 2);
    const halfY = riskBase - 0.5 * (RISK_H - 10);
    ctx.strokeStyle = "rgba(255,123,114,0.5)";
    ctx.beginPath();
    ctx.moveTo(LABEL_W - 6, halfY);
    ctx.lineTo(width - PAD, halfY);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,123,114,0.8)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("0.50", LABEL_W - 36, halfY);
    ctx.font = "12px system-ui, sans-serif";

    shown.forEach((date, i) => {
      const d = days.get(date);
      const x = xOf(i);
      // Month ticks along the bottom.
      if (i === 0 || date.slice(0, 7) !== shown[i - 1].slice(0, 7)) {
        ctx.fillStyle = "rgba(232,232,238,0.55)";
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillText(date.slice(0, 7), x - 4, bottom + 10);
        ctx.font = "12px system-ui, sans-serif";
      }
      if (d.rebound) {
        ctx.fillStyle = "rgba(95,211,141,0.08)";
        ctx.fillRect(x - COL_W / 2, PAD, COL_W, bottom - PAD);
      }
      // Risk bar.
      if (typeof d.risk === "number") {
        const h = d.risk * (RISK_H - 10);
        ctx.fillStyle = d.risk >= 0.5 ? "#ff7b72" : "rgba(232,232,238,0.45)";
        ctx.fillRect(x - COL_W / 2 + 3, riskBase - h, COL_W - 6, h);
      }
      // Notes.
      SLICES.forEach((slice, row) => {
        const v = d.views[slice];
        if (!v) return;
        const mid = PAD + row * STAFF_H + STAFF_H / 2;
        const y = mid - v.stance * (STAFF_H / 2 - NOTE_R - 2);
        ctx.globalAlpha = 0.2 + 0.8 * Math.max(0, Math.min(1, v.conviction));
        ctx.fillStyle = COLOURS[v.by] || "#ccc";
        ctx.beginPath();
        ctx.arc(x, y, NOTE_R, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (v.by !== slice) {
          ctx.strokeStyle = COLOURS[v.by] || "#ccc";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, NOTE_R + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        hits.push({ x, y, date, view: v });
      });
      if (d.escalation) dashed(x - 3, PAD, bottom, "#ff7b72");
      if (d.decision) dashed(x + 3, PAD, bottom, d.decision.verdict === "approve" ? "#5fd38d" : "#ffb347");
    });

    if (!shown.length) {
      ctx.fillStyle = "rgba(232,232,238,0.5)";
      ctx.fillText("Waiting for the first trading day...", LABEL_W, PAD + STAFF_H);
    }
  }

  /**
   * Show the details of the note nearest a click.
   * @param {MouseEvent} event The click.
   * @returns {void}
   */
  function onClick(event) {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let best = null;
    let bestDist = 10;
    for (const h of hits) {
      const dist = Math.hypot(h.x - px, h.y - py);
      if (dist < bestDist) {
        best = h;
        bestDist = dist;
      }
    }
    if (!best) return;
    const v = best.view;
    const sign = v.stance >= 0 ? "+" : "";
    const who = v.by === v.slice ? v.by : `${v.by}, covering ${v.slice}`;
    info.textContent =
      `${best.date} · ${v.slice} (by ${who}) · stance ${sign}${v.stance.toFixed(2)} · ` +
      `conviction ${v.conviction.toFixed(2)} · stress ${(v.stress ?? 0).toFixed(2)}` +
      (v.reason ? ` · "${v.reason}"` : "");
  }

  return { init, addView, addDecision, addReason, render: requestRender };
})();
