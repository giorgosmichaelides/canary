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
  const riskBox =document.getElementById("mute-risk");
  riskBox.addEventListener("change", () => Music.setRiskMute(riskBox.checked));
  onUnisonInput();
  onRiskInput();
}

init();
