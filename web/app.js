/**
 * Canary: browser entry point. Wires the feed (relay or recording) to the
 * sound engine, the score, the side panel and the approval card. The page
 * never decides anything: it displays views and forwards human decisions.
 */

/** The four analysts, in display order (also the takeover ring order). */
const ANALYSTS = ["fx", "havens", "commodity", "contrarian"];

/** One-line description of what each analyst watches (slices from canary/views.py). */
const ANALYST_ABOUT = {
  fx: "Watches the euro and the pound (EUR, GBP), the big everyday currencies.",
  havens: "Watches the yen and the Swiss franc (JPY, CHF), where money hides in a panic.",
  commodity: "Watches the Australian and Canadian dollars and the Norwegian krone (AUD, CAD, NOK). They follow oil and metals and usually fall first.",
  contrarian: "Watches all seven and bets against whichever group has moved furthest.",
};

/** Instrument names, for the mute labels. */
const VOICE_LABELS = { fx: "fx (808 + kick)", havens: "havens (tape pad)", commodity: "commodity (cowbell + clap)", contrarian: "contrarian (lead + hats)" };

/** Seconds without a heartbeat (or a view) before an analyst counts as down (DESIGN.md: 3.0 s). */
const GONE_SECONDS = 3;

/** Newest view per slice (by `ts`). Live agents each send only their own slices. */
const book = {};

/** Per analyst: last heard (performance.now() ms), slices it covers, and local degrade flag. */
const heard = {};
const covering = {};
const isolated = {};
const degraded = new Set();

/** The last tick seen ({replay, i}), to notice a restart or a new crisis. */
let lastTick = null;

/** Latest risk and unison from the views. */
let latest = { risk: 0, unison: 0 };

/** The `end` message once the replay has finished (null while it runs), and whether a card is open. */
let ended = null;
let cardOpen = false;

/**
 * Duck the music while a card waits or after the replay has ended.
 * @returns {void}
 */
function updateDuck() {
  Music.setDuck(cardOpen || ended !== null);
}

/**
 * Show or hide the "replay ended" banner and set the play button to match.
 * @returns {void}
 */
function showEnded() {
  const banner = document.getElementById("ended");
  banner.hidden = ended === null;
  if (ended) {
    const days = ended.days ? `${ended.days} trading days` : "every trading day";
    const last = ended.last_date ? `, last day ${formatDate(ended.last_date)}` : "";
    document.getElementById("ended-text").textContent = `Replay ${ended.replay || ""} finished: ${days}${last}.`;
  }
  document.body.classList.toggle("replay-ended", ended !== null);
  showPaused();
  updateDuck();
}

/**
 * Start the current crisis again from its first day.
 * @returns {Promise<void>}
 */
async function replayAgain() {
  const ok = await Feed.sendControl("restart", "tape");
  if (!ok) addLog("could not reach the relay to restart");
}

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
    // Any new day means the replay is running again.
    if (ended !== null || (i === 0 && paused)) {
      ended = null;
      paused = false;
      showEnded();
    }
  } else if (msg.type === "end") {
    if (lastTick && msg.replay !== undefined && String(msg.replay) !== lastTick.replay) return;
    ended = msg;
    showEnded();
    addLog(`Replay ${msg.replay || ""} finished. Press Replay again or pick another crisis.`);
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
    isolated[msg.agent] = Boolean(msg.isolated);
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
 * Who covers an analyst's slice when it goes down: the next analyst in the
 * takeover ring (fx -> havens -> commodity -> contrarian -> fx) that is still up.
 * @param {string} name Analyst that goes down.
 * @returns {string} The coverer's name.
 */
function coverer(name) {
  const i = ANALYSTS.indexOf(name);
  for (let k = 1; k < ANALYSTS.length; k += 1) {
    const c = ANALYSTS[(i + k) % ANALYSTS.length];
    if (statusOf(c) !== "down") return c;
  }
  return ANALYSTS[(i + 1) % ANALYSTS.length];
}

/** What each command does, for the desk log. */
const CONTROL_EXPLAIN = {
  kill: (n) => `${n} stopped. In about 3 s ${coverer(n)} notices the silence and covers ${n}'s slice; listen for it moving to ${coverer(n)}'s instrument.`,
  degrade: (n) => `${n} is now losing 75% of its messages. Its freshness line fades and its part drifts into reverb.`,
  heal: (n) => `${n} healed: all its messages get through again.`,
  revive: (n) => `${n} restarting. It takes its slice back at the next bar line.`,
};

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
    const role = document.createElement("span");
    role.className = "role";
    role.dataset.role = name;
    label.append(role);
    const status = document.createElement("span");
    status.className = "status live";
    status.textContent = "waiting";
    const trust = document.createElement("div");
    trust.className = "trust";
    trust.title = "Trust (view freshness)";
    trust.append(document.createElement("div"));
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const tips = {
      kill: `Stop the ${name} process. After 3 s ${coverer(name)} takes over its slice and plays it on its own instrument.`,
      degrade: `Drop 75% of ${name}'s messages. Its freshness line fades and its part drifts into reverb.`,
      revive: `Restart ${name}. It takes its slice back at the next bar line.`,
    };
    for (const [cmd, text] of [["kill", "Kill"], ["degrade", "Degrade"], ["revive", "Revive"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "small";
      b.title = tips[cmd];
      b.textContent = text;
      b.dataset.cmd = cmd;
      b.addEventListener("click", () => control(b.dataset.cmd, name));
      buttons.append(b);
    }
    const about = document.createElement("span");
    about.className = "about";
    about.textContent = ANALYST_ABOUT[name];
    li.append(label, status, about, trust, buttons);
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
  const explain = CONTROL_EXPLAIN[cmd] ? CONTROL_EXPLAIN[cmd](target) : "";
  const ok = await Feed.sendControl(cmd, target);
  addLog(ok ? `you: ${cmd} ${target}. ${explain}` : `could not send ${cmd} ${target} (relay down?)`);
  const btn = document.querySelector(`#analysts li[data-analyst="${target}"] button[data-cmd^="degrade"], #analysts li[data-analyst="${target}"] button[data-cmd="heal"]`);
  if (btn) {
    btn.dataset.cmd = degraded.has(target) ? "heal" : "degrade";
    btn.textContent = degraded.has(target) ? "Heal" : "Degrade";
  }
}

/**
 * Work out an analyst's status from heartbeats, views and coverage.
 * @param {string} name Analyst name.
 * @returns {string} "waiting", "live", "isolated", "covering", "degraded" or "down".
 */
function statusOf(name) {
  if (heard[name] === undefined) return "waiting";
  if ((performance.now() - heard[name]) / 1000 > GONE_SECONDS) return "down";
  if (isolated[name]) return "isolated";
  const covers = (covering[name] || []).length || ANALYSTS.some((s) => s !== name && book[s] && book[s].by === name);
  if (covers) return "covering";
  return degraded.has(name) ? "degraded" : "live";
}

/**
 * Refresh the meters, statuses and trust bars (called a few times a second).
 * @returns {void}
 */
function refreshPanel() {
  const withUnit = (output, value, unit) => {
    const small = document.createElement("small");
    small.textContent = unit;
    output.replaceChildren(value, small);
  };
  const meter = (id, frac, text, unit) => {
    const m = document.getElementById(id);
    m.querySelector(".fill").style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    const output = m.querySelector("output");
    if (unit) withUnit(output, text, unit);
    else output.textContent = text;
  };
  meter("m-unison", latest.unison, latest.unison.toFixed(2));
  meter("m-risk", latest.risk, latest.risk.toFixed(2));
  document.getElementById("m-risk").classList.toggle("hot", latest.risk >= 0.5);
  const bpm = Music.getTempo();
  meter("m-tempo", (bpm - 80) / 80, String(Math.round(bpm)), "bpm");
  const trust = Music.getTrust();
  let up = 0;
  let known = 0;
  for (const name of ANALYSTS) {
    const li = document.querySelector(`#analysts li[data-analyst="${name}"]`);
    const st = statusOf(name);
    if (st !== "waiting") known += 1;
    if (st !== "waiting" && st !== "down") up += 1;
    const chip = li.querySelector(".status");
    chip.className = `status ${st}`;
    const cov = covering[name] || [];
    chip.textContent = st === "covering" && cov.length ? `covering ${cov.join(", ")}` : st;
    li.querySelector(".trust div").style.width = `${Math.round(trust[name] * 100)}%`;
  }
  const alive = document.querySelector("#m-alive output");
  if (known) withUnit(alive, String(up), `of ${ANALYSTS.length}`);
  else alive.textContent = "–";
  alive.classList.toggle("short", known > 0 && up < ANALYSTS.length);
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
 * Label the mute checkboxes and the analysts' instrument lines.
 * @returns {void}
 */
function labelVoices() {
  for (const span of document.querySelectorAll("#voices [data-label]")) {
    span.textContent = VOICE_LABELS[span.dataset.label];
  }
  for (const span of document.querySelectorAll("#analysts [data-role]")) {
    const label = VOICE_LABELS[span.dataset.role];
    span.textContent = (label.match(/\((.*)\)/) || [, label])[1];
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

/** Replay speeds the faster/slower buttons step through (multiples of normal). */
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

/** Index into SPEEDS, and whether the replay is paused from the header button. */
let speedIndex = 2;
let paused = false;

/**
 * Show the pause button's state (Pause when playing, Play when paused).
 * @returns {void}
 */
function showPaused() {
  const btn = document.getElementById("playpause");
  const label = ended !== null ? "Replay again" : paused ? "Play" : "Pause";
  btn.textContent = label;
  btn.setAttribute("aria-label", label);
}

/**
 * Pause or resume the replay (the tape, or the mock when there is no relay).
 * After the end it starts the replay again.
 * @returns {Promise<void>}
 */
async function togglePause() {
  if (ended !== null) {
    await replayAgain();
    return;
  }
  paused = !paused;
  showPaused();
  const ok = await Feed.sendControl(paused ? "pause" : "play", "tape");
  if (!ok) addLog("could not reach the relay to pause or play");
}

/**
 * Step the replay speed up or down and tell the tape.
 * @param {number} step +1 for faster, -1 for slower.
 * @returns {Promise<void>}
 */
async function changeSpeed(step) {
  const next = Math.min(SPEEDS.length - 1, Math.max(0, speedIndex + step));
  if (next === speedIndex) return;
  speedIndex = next;
  document.getElementById("speed-readout").textContent = `${SPEEDS[speedIndex]}×`;
  const ok = await Feed.sendControl("speed", "tape", { speed: SPEEDS[speedIndex] });
  if (!ok) addLog("could not reach the relay to change speed");
}

/**
 * Push the volume slider to the sound engine.
 * @returns {void}
 */
function onVolumeInput() {
  Music.setVolume(parseFloat(document.getElementById("volume").value));
}

/**
 * Wire up the page once the DOM is ready.
 * @returns {void}
 */
function init() {
  document.getElementById("start-audio").addEventListener("click", startAudio);
  document.getElementById("playpause").addEventListener("click", togglePause);
  document.getElementById("slower").addEventListener("click", () => changeSpeed(-1));
  document.getElementById("faster").addEventListener("click", () => changeSpeed(1));
  document.getElementById("volume").addEventListener("input", onVolumeInput);
  onVolumeInput();
  document.getElementById("unison").addEventListener("input", onUnisonInput);
  document.getElementById("risk").addEventListener("input", onRiskInput);
  for (const box of document.querySelectorAll("#voices input[data-voice]")) {
    box.addEventListener("change", () => Music.setMute(box.dataset.voice, box.checked));
  }
  const riskBox = document.getElementById("mute-risk");
  riskBox.addEventListener("change", () => Music.setRiskMute(riskBox.checked));
  onUnisonInput();
  onRiskInput();
  buildAnalysts();
  labelVoices();
  Score.init(document.getElementById("score"), document.getElementById("score-info"));
  document.getElementById("ended-again").addEventListener("click", replayAgain);
  document.getElementById("ended-pick").addEventListener("click", () => {
    document.getElementById("canary-chart").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  Card.init(Feed.sendDecision, (isOpen) => {
    cardOpen = isOpen;
    updateDuck();
    if (isOpen) Music.sting();
    // The relay pauses the tape when a card opens and presses play after the
    // decision; the mock holds on the card's day itself. Keep the button honest.
    paused = isOpen;
    showPaused();
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
