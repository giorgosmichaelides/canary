/**
 * Canary: browser entry point. Wires the feed (relay or recording) to the
 * sound engine, the score, the side panel and the approval card. The page
 * never decides anything: it displays views and forwards human decisions.
 */

/** The four analysts, in display order (also the takeover ring order). */
const ANALYSTS = ["fx", "havens", "commodity", "contrarian"];

/** Instrument names per style, for the mute labels. */
const VOICE_LABELS = {
  default: { fx: "fx (walking bass)", havens: "havens (pad)", commodity: "commodity (rock)", contrarian: "contrarian (bell pluck)" },
  classical: { fx: "fx (cello)", havens: "havens (violins)", commodity: "commodity (piano)", contrarian: "contrarian (pizzicato)" },
  metal: { fx: "fx (bass + double kick)", havens: "havens (choir)", commodity: "commodity (rhythm guitar + snare)", contrarian: "contrarian (lead guitar)" },
  phonk: { fx: "fx (808 + kick)", havens: "havens (tape pad)", commodity: "commodity (cowbell + clap)", contrarian: "contrarian (lead + hats)" },
};

/** Seconds without a heartbeat (or a view) before an analyst counts as down (DESIGN.md: 3.0 s). */
const GONE_SECONDS = 3;

/** Newest view per slice (by `ts`). Live agents each send only their own slices. */
const book = {};

/** Per analyst: last heard (performance.now() ms), slices it covers, and local degrade flag. */
const heard = {};
const covering = {};
const degraded = new Set();

/** The last tick seen ({replay, i}), to notice a restart or a new crisis. */
let lastTick = null;

/** Latest risk and unison from the views. */
let latest = { risk: 0, unison: 0 };

/**
 * Update the status line on the page.
 * @param {string} text Message to show.
 * @returns {void}
 */
function setStatus(text) {
  document.getElementById("status").textContent = text;
}

/**
 * Start the audio context (needs a user gesture) and the sequencer.
 * @returns {Promise<void>}
 */
async function startAudio() {
  if (typeof Tone === "undefined") {
    setStatus("Tone.js not found. Put it at web/vendor/tone.js.");
    return;
  }
  await Music.start();
  setStatus("Audio running.");
  document.body.classList.add("started");
  Feed.startMock();
}

/**
 * Set a slider from data, update its readout and push it to the sound engine.
 * @param {string} id Slider id: "unison" or "risk".
 * @param {number} value New value, 0..1.
 * @returns {void}
 */
function setSlider(id, value) {
  document.getElementById(id).value = value;
  (id === "unison" ? onUnisonInput : onRiskInput)();
}

/** Short connection labels for the header badge (the full detail goes in its tooltip and the desk log). */
const FEED_LABELS = {
  connecting: "Connecting…",
  live: "Live · relay",
  "relay-lost": "Relay lost · agents still running",
  mock: "Recorded replay",
};

/** Analyst colours (same as the score and the CSS variables). */
const COLOURS = { fx: "#5b9dff", havens: "#b48cff", commodity: "#ffb347", contrarian: "#4fd1c5" };

/**
 * Format a market date for the header, e.g. "Mon 2 Mar 2020".
 * @param {string} iso "YYYY-MM-DD".
 * @returns {string} Readable date, or the input if it does not parse.
 */
function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso || "";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Merge views into the book, keeping the newest per slice.
 * @param {Object[]} views The `views` array of a view message.
 * @returns {void}
 */
function mergeViews(views) {
  for (const v of views) {
    const old = book[v.slice];
    if (!old || (v.ts || 0) >= (old.ts || 0)) book[v.slice] = v;
  }
}

/**
 * Build one table cell.
 * @param {string} cls Class name.
 * @param {...(Node|string)} children Content.
 * @returns {HTMLTableCellElement} The cell.
 */
function cell(cls, ...children) {
  const td = document.createElement("td");
  td.className = cls;
  td.append(...children);
  return td;
}

/**
 * Rewrite the Latest views table from the book: who, a stance bar, conviction, reason.
 * @returns {void}
 */
function renderDesk() {
  const body = document.querySelector("#desk tbody");
  const rows = ANALYSTS.map((name) => book[name]).filter(Boolean);
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = cell("empty", "Waiting for the first trading day…");
    td.colSpan = 4;
    tr.append(td);
    body.replaceChildren(tr);
    return;
  }
  body.replaceChildren(
    ...rows.map((v) => {
      const tr = document.createElement("tr");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = COLOURS[v.by] || "#888";
      const who = cell("who", dot, v.slice);
      if (v.by !== v.slice) {
        const note = document.createElement("small");
        note.textContent = `covered by ${v.by}`;
        who.append(note);
      }
      const value = document.createElement("span");
      value.className = "num";
      value.textContent = (v.stance >= 0 ? "+" : "") + v.stance.toFixed(2);
      const bar = document.createElement("div");
      bar.className = "sbar";
      const fill = document.createElement("i");
      const half = Math.min(1, Math.abs(v.stance)) * 50;
      fill.style.left = v.stance >= 0 ? "50%" : `${50 - half}%`;
      fill.style.width = `${half}%`;
      fill.style.background = v.stance >= 0 ? "var(--green)" : "var(--red)";
      bar.append(fill);
      tr.append(who, cell("stance", value, bar), cell("conv num", v.conviction.toFixed(2)), cell("line", v.reason || ""));
      return tr;
    }),
  );
}

/**
 * Mark an analyst as heard from now.
 * @param {string} name Analyst name.
 * @returns {void}
 */
function markHeard(name) {
  if (ANALYSTS.includes(name)) heard[name] = performance.now();
}

/**
 * Handle one bus message from the relay or the recording.
 * @param {Object} msg A bus message with a `type`.
 * @returns {void}
 */
function onMessage(msg) {
  // Quant's chart listens to the relay itself; in mock mode it is fed from here.
  if (Feed.mode === "mock" && window.CanaryChart) window.CanaryChart.handle(msg);
  if (msg.type === "tick") {
    // A different crisis, or a restart: clear the score, any open card and the book.
    const replay = String(msg.replay);
    const i = Number(msg.i);
    if (lastTick && (replay !== lastTick.replay || i < lastTick.i)) {
      Score.reset();
      Card.reset();
      for (const key of Object.keys(book)) delete book[key];
    }
    lastTick = { replay, i };
  } else if (msg.type === "view") {
    const views = msg.views || [];
    mergeViews(views);
    markHeard(msg.agent);
    for (const v of views) markHeard(v.by);
    // Agents send risk: null in the first view of each day (the number follows
    // ~250 ms later), so keep the last known value rather than feeding null on.
    if (typeof msg.unison === "number") {
      latest.unison = msg.unison;
      setSlider("unison", msg.unison);
    }
    if (typeof msg.risk === "number") {
      latest.risk = msg.risk;
      setSlider("risk", msg.risk);
    }
    const now = document.getElementById("now");
    now.textContent = formatDate(msg.date);
    if (msg.rebound) {
      const tag = document.createElement("span");
      tag.className = "rebound";
      tag.textContent = "rebound";
      now.append(tag);
    }
    Music.setViews(views);
    Music.setRebound(msg.rebound);
    Score.addView(msg);
    renderDesk();
    if (msg.escalation) Card.show(msg.escalation, Object.values(book));
  } else if (msg.type === "card") {
    // The relay's deduplicated card event (also sent to a browser that just connected).
    Card.show(msg.card, Object.values(book));
  } else if (msg.type === "hb") {
    markHeard(msg.agent);
    covering[msg.agent] = msg.covering || [];
  } else if (msg.type === "decision") {
    Card.decidedElsewhere(msg.id);
    logDecision(msg);
  } else if (msg.type === "reason") {
    const v = book[msg.slice];
    if (v && v.by === msg.by) v.reason = msg.text;
    Score.addReason(msg);
    renderDesk();
  } else if (msg.type === "log") {
    addLog(`[${msg.agent}] ${msg.text}`);
  }
}

/** Decision ids already logged (the relay may echo a decision more than once). */
const loggedDecisions = new Set();

/**
 * Add a decision to the log, the score, and play its chord (once per id).
 * @param {Object} d A `decision` message.
 * @returns {void}
 */
function logDecision(d) {
  if (loggedDecisions.has(d.id)) return;
  loggedDecisions.add(d.id);
  Music.decision(d.verdict);
  Music.hold(2.5); // let the decision chord ring before the music follows the market again
  Score.addDecision(d);
  const li = document.createElement("li");
  li.className = d.verdict === "approve" ? "approve" : "veto";
  const name = d.by || d.decided_by; // the relay records the judge's name as "by"
  const who = name ? ` by ${name}` : "";
  li.textContent = `${d.market_date}: ${d.verdict} "${d.action}"${who} in ${d.seconds_to_decide}s${d.reason ? ` (${d.reason})` : ""}`;
  document.getElementById("decisions").prepend(li);
}

/**
 * Add a line to the desk log (newest first, last 40 kept).
 * @param {string} text Line to add.
 * @returns {void}
 */
function addLog(text) {
  const list = document.getElementById("desk-log");
  const li = document.createElement("li");
  li.textContent = text;
  list.prepend(li);
  while (list.children.length > 40) list.lastChild.remove();
}

/**
 * Build the analyst rows (status chip, trust bar, Kill / Degrade / Revive).
 * @returns {void}
 */
function buildAnalysts() {
  const list = document.getElementById("analysts");
  for (const name of ANALYSTS) {
    const li = document.createElement("li");
    li.dataset.analyst = name;
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name;
    const status = document.createElement("span");
    status.className = "status live";
    status.textContent = "waiting";
    const trust = document.createElement("div");
    trust.className = "trust";
    trust.title = "Trust (view freshness)";
    trust.append(document.createElement("div"));
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    for (const [cmd, text] of [["kill", "Kill"], ["degrade", "Degrade"], ["revive", "Revive"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "small";
      b.textContent = text;
      b.dataset.cmd = cmd;
      b.addEventListener("click", () => control(b.dataset.cmd, name));
      buttons.append(b);
    }
    li.append(label, status, trust, buttons);
    list.append(li);
  }
}

/**
 * Send a control command and note it in the desk log. Degrade toggles to heal.
 * @param {string} cmd kill, degrade, heal or revive.
 * @param {string} target Analyst name.
 * @returns {Promise<void>}
 */
async function control(cmd, target) {
  if (cmd === "degrade" && degraded.has(target)) cmd = "heal";
  if (cmd === "degrade") degraded.add(target);
  if (cmd === "heal" || cmd === "kill" || cmd === "revive") degraded.delete(target);
  const ok = await Feed.sendControl(cmd, target);
  if (Feed.mode !== "mock") addLog(ok ? `you: ${cmd} ${target}` : `could not send ${cmd} ${target} (relay down?)`);
  const btn = document.querySelector(`#analysts li[data-analyst="${target}"] button[data-cmd^="degrade"], #analysts li[data-analyst="${target}"] button[data-cmd="heal"]`);
  if (btn) {
    btn.dataset.cmd = degraded.has(target) ? "heal" : "degrade";
    btn.textContent = degraded.has(target) ? "Heal" : "Degrade";
  }
}

/**
 * Work out an analyst's status from heartbeats, views and coverage.
 * @param {string} name Analyst name.
 * @returns {string} "waiting", "live", "covering", "degraded" or "down".
 */
function statusOf(name) {
  if (heard[name] === undefined) return "waiting";
  if ((performance.now() - heard[name]) / 1000 > GONE_SECONDS) return "down";
  const covers = (covering[name] || []).length || ANALYSTS.some((s) => s !== name && book[s] && book[s].by === name);
  if (covers) return "covering";
  return degraded.has(name) ? "degraded" : "live";
}

/**
 * Refresh the meters, statuses and trust bars (called a few times a second).
 * @returns {void}
 */
function refreshPanel() {
  const meter = (id, frac, text) => {
    const m = document.getElementById(id);
    m.querySelector(".fill").style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    m.querySelector("output").textContent = text;
  };
  meter("m-unison", latest.unison, latest.unison.toFixed(2));
  meter("m-risk", latest.risk, latest.risk.toFixed(2));
  const bpm = Music.getTempo();
  meter("m-tempo", (bpm - 80) / 80, `${Math.round(bpm)} bpm`);
  const trust = Music.getTrust();
  for (const name of ANALYSTS) {
    const li = document.querySelector(`#analysts li[data-analyst="${name}"]`);
    const st = statusOf(name);
    const chip = li.querySelector(".status");
    chip.className = `status ${st}`;
    chip.textContent = st;
    li.querySelector(".trust div").style.width = `${Math.round(trust[name] * 100)}%`;
  }
}

/**
 * Presenter keys: K kills fx, R revives fx (ignored while typing).
 * @param {KeyboardEvent} event The key press.
 * @returns {void}
 */
function onKey(event) {
  const tag = (event.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "k") control("kill", "fx");
  if (key === "r") control("revive", "fx");
}

/**
 * Relabel the mute checkboxes for the chosen style.
 * @param {string} style Style name.
 * @returns {void}
 */
function labelVoices(style) {
  for (const span of document.querySelectorAll("#voices [data-label]")) {
    span.textContent = VOICE_LABELS[style][span.dataset.label];
  }
}

/**
 * Push the slider value to the sound engine and the readout.
 * @returns {void}
 */
function onUnisonInput() {
  const value = parseFloat(document.getElementById("unison").value);
  document.getElementById("unison-readout").textContent = value.toFixed(2);
  Music.setUnison(value);
}

/**
 * Push the risk slider value to the sound engine and the readout.
 * @returns {void}
 */
function onRiskInput() {
  const value = parseFloat(document.getElementById("risk").value);
  document.getElementById("risk-readout").textContent = value.toFixed(2);
  Music.setRisk(value);
}

/**
 * Wire up the page once the DOM is ready.
 * @returns {void}
 */
function init() {
  document.getElementById("start-audio").addEventListener("click", startAudio);
  document.getElementById("unison").addEventListener("input", onUnisonInput);
  document.getElementById("risk").addEventListener("input", onRiskInput);
  for (const box of document.querySelectorAll("#voices input[data-voice]")) {
    box.addEventListener("change", () => Music.setMute(box.dataset.voice, box.checked));
  }
  const style = document.getElementById("style");
  style.addEventListener("change", () => {
    Music.setStyle(style.value);
    labelVoices(style.value);
  });
  labelVoices(style.value);
  const riskBox = document.getElementById("mute-risk");
  riskBox.addEventListener("change", () => Music.setRiskMute(riskBox.checked));
  onUnisonInput();
  onRiskInput();
  buildAnalysts();
  Score.init(document.getElementById("score"), document.getElementById("score-info"));
  Card.init(Feed.sendDecision, (isOpen) => {
    Music.setDuck(isOpen);
    if (isOpen) Music.sting();
    // No pause/play from here: the relay pauses the tape when a card opens and
    // presses play after the decision; the mock holds on the card's day itself.
  });
  document.addEventListener("keydown", onKey);
  setInterval(refreshPanel, 250);
  renderDesk();
  Feed.connect(onMessage, (mode, detail) => {
    const badge = document.getElementById("feed-status");
    badge.textContent = FEED_LABELS[mode] || detail;
    badge.dataset.mode = mode;
    badge.title = detail;
    addLog(detail);
  });
}

init();
