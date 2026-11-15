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
  const LABEL_W = 104;
  const COL_W = 18;
  const STAFF_H = 58;
  const RISK_H = 52;
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
    // Agents send risk: null in the first view of each day (risk comes ~250 ms later).
    if (typeof msg.risk === "number") d.risk = msg.risk;
    if (typeof msg.unison === "number") d.unison = msg.unison;
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

  /** Palette for the canvas (matches the page's CSS variables). */
  const INK = { text: "#efeae0", muted: "#aaa498", faint: "#7d786d", band: "rgba(255,255,255,0.025)", grid: "#2e2b27",
                red: "#ef6f5e", green: "#6cc58f", amber: "#ffb347", canary: "rgba(245,197,66,0.10)", calm: "#45413a" };

  /**
   * Draw a dashed vertical marker with a small label at the top.
   * @param {number} x X position.
   * @param {number} y0 Top.
   * @param {number} y1 Bottom.
   * @param {string} colour Stroke and label colour.
   * @param {string} label Text for the flag.
   * @param {number} labelY Y of the flag.
   * @param {"left"|"right"|"center"} [align] Which side of the line the flag sits on.
   * @returns {void}
   */
  function marker(x, y0, y1, colour, label, labelY, align = "center") {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "600 10px system-ui, sans-serif";
    const w = ctx.measureText(label).width + 10;
    const want = align === "right" ? x - w - 2 : align === "left" ? x + 2 : x - w / 2;
    const left = Math.max(2, Math.min(want, canvas.clientWidth - w - 2));
    ctx.fillStyle = "#191815";
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left, labelY - 8, w, 16, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.textAlign = "center";
    ctx.fillText(label, left + w / 2, labelY + 0.5);
    ctx.restore();
  }

  /**
   * Redraw the whole score; the newest date sits at the right edge.
   * @returns {void}
   */
  function render() {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const top = 26; // room for marker flags
    const height = top + SLICES.length * STAFF_H + RISK_H + 26;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    const dates = [...days.keys()].sort();
    const fit = Math.max(1, Math.floor((width - LABEL_W - PAD) / COL_W));
    const shown = dates.slice(-fit);
    const xOf = (i) => LABEL_W + i * COL_W + COL_W / 2;
    const staffTop = (row) => top + row * STAFF_H;
    const riskTop = top + SLICES.length * STAFF_H + 6;
    const riskBase = riskTop + RISK_H - 10;
    const bottom = riskBase;
    hits = [];

    // Staff bands, labels and centre lines (stance 0).
    SLICES.forEach((slice, row) => {
      const y = staffTop(row);
      if (row % 2 === 0) {
        ctx.fillStyle = INK.band;
        ctx.fillRect(LABEL_W - 8, y, width - LABEL_W + 8 - PAD, STAFF_H);
      }
      const mid = y + STAFF_H / 2;
      ctx.fillStyle = COLOURS[slice];
      ctx.beginPath();
      ctx.arc(12, mid, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK.text;
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.fillText(slice, 22, mid);
      ctx.strokeStyle = INK.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LABEL_W - 8, mid);
      ctx.lineTo(width - PAD, mid);
      ctx.stroke();
    });

    // Risk staff label and the 0.50 line.
    ctx.fillStyle = INK.text;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText("risk", 22, riskTop + (RISK_H - 10) / 2);
    const halfY = riskBase - 0.5 * (RISK_H - 10);
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = "rgba(236,238,243,0.45)";
    ctx.beginPath();
    ctx.moveTo(LABEL_W - 8, halfY);
    ctx.lineTo(width - PAD, halfY);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = INK.muted;
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("0.50", LABEL_W - 34, halfY);

    if (!shown.length) {
      ctx.fillStyle = INK.faint;
      ctx.font = "13px system-ui, sans-serif";
      ctx.fillText("Waiting for the first trading day…", LABEL_W, top + STAFF_H * 1.5);
      return;
    }

    // Today's column.
    const lastX = xOf(shown.length - 1);
    ctx.fillStyle = INK.canary;
    ctx.fillRect(lastX - COL_W / 2, top, COL_W, bottom - top);

    shown.forEach((date, i) => {
      const d = days.get(date);
      const x = xOf(i);
      // Month boundaries: a gridline and a label along the bottom.
      if (i === 0 || date.slice(0, 7) !== shown[i - 1].slice(0, 7)) {
        if (i > 0) {
          ctx.strokeStyle = INK.grid;
          ctx.beginPath();
          ctx.moveTo(x - COL_W / 2, top);
          ctx.lineTo(x - COL_W / 2, bottom);
          ctx.stroke();
        }
        const label = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
        ctx.fillStyle = INK.muted;
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText(label, x - COL_W / 2 + 2, bottom + 14);
      }
      if (d.rebound) {
        ctx.fillStyle = "rgba(76,209,138,0.09)";
        ctx.fillRect(x - COL_W / 2, top, COL_W, bottom - top);
      }
      // Risk bar.
      if (typeof d.risk === "number") {
        const h = Math.max(1.5, d.risk * (RISK_H - 10));
        ctx.fillStyle = d.risk >= 0.5 ? INK.red : INK.calm;
        ctx.beginPath();
        ctx.roundRect(x - COL_W / 2 + 3, riskBase - h, COL_W - 6, h, 2);
        ctx.fill();
      }
      // Notes.
      SLICES.forEach((slice, row) => {
        const v = d.views[slice];
        if (!v) return;
        const mid = staffTop(row) + STAFF_H / 2;
        const y = mid - v.stance * (STAFF_H / 2 - NOTE_R - 3);
        ctx.globalAlpha = 0.25 + 0.75 * Math.max(0, Math.min(1, v.conviction));
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
    });

    // Markers last, so they sit on top.
    shown.forEach((date, i) => {
      const d = days.get(date);
      const x = xOf(i);
      const both = d.escalation && d.decision;
      if (d.escalation) marker(x - 3, top, bottom, INK.red, "card", 11, both ? "right" : "center");
      if (d.decision) {
        const approved = d.decision.verdict === "approve";
        marker(x + 3, top, bottom, approved ? INK.green : INK.amber, approved ? "approved" : "vetoed", 11, both ? "left" : "center");
      }
    });
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

  /**
   * Forget every day (a new replay started).
   * @returns {void}
   */
  function reset() {
    days.clear();
    hits = [];
    requestRender();
  }

  return { init, addView, addDecision, addReason, reset, render: requestRender };
})();
