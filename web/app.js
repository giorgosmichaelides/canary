/**
 * The Desk: browser entry point. For now, only the Start audio button
 * and a test note (D3) played with the vendored Tone.js.
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
 * Start the audio context (needs a user gesture) and play a D3 note.
 * @returns {Promise<void>}
 */
async function startAudio() {
  if (typeof Tone === "undefined") {
    setStatus("Tone.js not found. Put it at web/vendor/tone.js.");
    return;
  }
  await Tone.start();
  const synth = new Tone.Synth().toDestination();
  synth.triggerAttackRelease("D3", "1n");
  setStatus("Audio running. Played D3.");
}

/**
 * Wire up the page once the DOM is ready.
 * @returns {void}
 */
function init() {
  document.getElementById("start-audio").addEventListener("click", startAudio);
}

init();
