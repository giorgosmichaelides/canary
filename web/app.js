/**
 * Canary: browser entry point. Start audio button and the manual
 * unison slider that drives the sound engine in music.js.
 */

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
  Feed.startMock();
}

/** Display order and names of the analysts in the desk table. */
const ANALYSTS = ["fx", "havens", "commodity", "contrarian"];

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

/**
 * Rewrite the desk table: one row per slice with stance, conviction, author and reason.
 * @param {Object[]} views The `views` array of a view message.
 * @returns {void}
 */
function renderDesk(views) {
  const body = document.querySelector("#desk tbody");
  const rows = ANALYSTS.map((name) => views.find((v) => v.slice === name)).filter(Boolean);
  body.replaceChildren(
    ...rows.map((v) => {
      const tr = document.createElement("tr");
      const cells = [
        [v.slice + (v.by !== v.slice ? ` (covered by ${v.by})` : ""), ""],
        [(v.stance >= 0 ? "+" : "") + v.stance.toFixed(2), "num"],
        [v.conviction.toFixed(2), "num"],
        [v.reason || "", "line"],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        td.className = cls;
        tr.append(td);
      }
      return tr;
    }),
  );
}

/**
 * Handle one bus message from the relay or the recording.
 * @param {Object} msg A bus message with a `type`.
 * @returns {void}
 */
function onMessage(msg) {
  if (msg.type === "view") {
    setSlider("unison", msg.unison);
    setSlider("risk", msg.risk);
    document.getElementById("now").textContent = `${msg.date}${msg.rebound ? "  rebound" : ""}`;
    Music.setViews(msg.views || []);
    renderDesk(msg.views || []);
    if (msg.escalation) Card.show(msg.escalation, msg.views || []);
  } else if (msg.type === "decision") {
    Card.decidedElsewhere(msg.id);
    logDecision(msg);
  } else if (msg.type === "log") {
    console.info(`[${msg.agent}] ${msg.text}`);
  }
}

/**
 * Add a decision to the on-page log.
 * @param {Object} d A `decision` message.
 * @returns {void}
 */
function logDecision(d) {
  const li = document.createElement("li");
  const who = d.decided_by ? ` by ${d.decided_by}` : "";
  li.textContent = `${d.market_date}: ${d.verdict} "${d.action}"${who} in ${d.seconds_to_decide}s${d.reason ? ` (${d.reason})` : ""}`;
  document.getElementById("decisions").prepend(li);
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
  style.addEventListener("change", () => Music.setStyle(style.value));
  const riskBox = document.getElementById("mute-risk");
  riskBox.addEventListener("change", () => Music.setRiskMute(riskBox.checked));
  onUnisonInput();
  onRiskInput();
  Card.init(Feed.sendDecision, (isOpen) => {
    Music.setDuck(isOpen);
    Feed.sendControl(isOpen ? "pause" : "play");
  });
  Feed.connect(onMessage, (mode, detail) => {
    document.getElementById("feed-status").textContent = detail;
  });
}

init();
