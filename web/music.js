/**
 * Canary: sound engine. Four Tone.js voices driven by one 16th-note
 * sequencer and one number, `unison` (0..1).
 *
 * At unison 0 each voice plays its own rhythm and melody. As unison rises,
 * melody degrees shrink toward the root, off-beat steps drop out one by one
 * (per-step thresholds), and at unison 1 every voice plays D on the beat.
 *
 * Exposes a single global: `Music`.
 */
const Music = (() => {
  /** Pitch classes of the shared D minor pentatonic scale (D F G A C), in semitones from D. */
  const SCALE = [0, 3, 5, 7, 10];

  /** Tempo in beats per minute at risk 0 (CLAUDE.md says 116; 96 is being trialled). */
  const BPM = 96;

  /** Maximum swing at unison 0 (CLAUDE.md section 8: 0.45 -> 0). */
  const MAX_SWING = 0.45;

  /** Latest unison value, read by the sequencer on every step. */
  let unison = 0;

  /** Latest risk value, read by the sequencer and the risk voice. */
  let risk = 0;

  /** True when the risk voice (drone and click) is muted from the page. */
  let riskMuted = false;

  /** Tempo at risk 1 (bpm). */
  const MIN_BPM = 70;

  /** Drone gain node and click synth, built in build(). */
  let droneGain = null;
  let clickSynth = null;

  /** True once the synths and sequencer have been built. */
  let built = false;

  /**
   * Map risk to tempo, sliding linearly from BPM at 0 to MIN_BPM at 1.
   * @param {number} r Risk, 0..1.
   * @returns {number} Beats per minute.
   */
  function riskToBpm(r) {
    return BPM + (MIN_BPM - BPM) * r;
  }

  /**
   * Push the current risk to the drone gain and tempo (smoothed to avoid zipper noise).
   * @returns {void}
   */
  function applyRisk() {
    // Drone: silent at risk 0, rising to about -5 dB at risk 1 (cubed, so it swells at the top).
    droneGain.gain.rampTo(riskMuted ? 0 : 0.55 * risk ** 3, 0.1);
    Tone.Transport.bpm.rampTo(riskToBpm(risk), 0.1);
  }

  /**
   * Convert a scale degree into a MIDI note, wrapping up an octave every 5 degrees.
   * @param {number} rootMidi MIDI note of D in this voice's register.
   * @param {number} degree Scale degree, 0 = D. May exceed 4 to climb octaves.
   * @returns {number} MIDI note number.
   */
  function degreeToMidi(rootMidi, degree) {
    const octave = Math.floor(degree / SCALE.length);
    const index = ((degree % SCALE.length) + SCALE.length) % SCALE.length;
    return rootMidi + 12 * octave + SCALE[index];
  }

  /**
   * Build per-step thresholds so voices lock to the beat gradually, not all at once.
   * A step plays its own rhythm while unison < threshold. All values stay below 1,
   * so at unison 1 every voice is on the floor.
   * @param {number} offset Voice-specific shift so voices lock at different times.
   * @returns {number[]} 16 thresholds, one per sixteenth step.
   */
  function makeThresholds(offset) {
    return Array.from({ length: 16 }, (_, step) => 0.2 + 0.7 * (((step * 7 + offset) % 16) / 16));
  }

  /**
   * Convert MIDI note numbers to frequencies in Hz.
   * @param {number[]} midis MIDI note numbers.
   * @returns {number[]} Frequencies in Hz, duplicates removed.
   */
  function toFreqs(midis) {
    return [...new Set(midis)].map((m) => Tone.Frequency(m, "midi").toFrequency());
  }

  /**
   * The four voices. Each has:
   * - rootMidi: its own register (D2 / D3 / D4 / D5)
   * - rhythm: sixteenth steps (0-15) where it plays at unison 0
   * - melody: scale degree per step at unison 0
   * - thresholds: per-step unison level at which the step snaps to the floor
   * - synth: built in build()
   * - play(time, degree, onOwnRhythm): trigger one event
   * @type {Object<string, Object>}
   */
  const voices = {
    fx: {
      // Jazz walking bass: swung quarters (long) with eighth-note pickups (short)
      // that lead into the next beat, climbing the scale and falling back to the root.
      rootMidi: 38,
      rhythm: [0, 4, 8, 10, 12, 14],
      melody: [0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 4, 0, 3, 0, 2, 0],
      thresholds: makeThresholds(0),
      /** @param {number} time @param {number} degree @param {boolean} own @param {number} step @returns {void} */
      play(time, degree, own, step) {
        const quarter = step % 4 === 0;
        const dur = quarter ? "8n." : "16n";
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], dur, time, quarter ? 0.9 : 0.6);
      },
    },
    havens: {
      // Ambient pad: one long chord per bar.
      rootMidi: 62,
      rhythm: [0],
      melody: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      thresholds: makeThresholds(5),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        const chord = toFreqs([0, 2, 4].map((d) => degreeToMidi(this.rootMidi, Math.round(degree + d * (1 - unison)))));
        this.synth.triggerAttackRelease(chord, own ? "1m" : "8n", time, 0.5);
      },
    },
    commodity: {
      // Rock root-and-fifth power chords: palm-muted driving eighths with
      // accents on the beat (strongest on 1 and 3), a riff that lifts at the bar end.
      rootMidi: 50,
      rhythm: [0, 2, 4, 6, 8, 10, 12, 14],
      melody: [0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0, 2, 0],
      thresholds: makeThresholds(11),
      /** @param {number} time @param {number} degree @param {boolean} own @param {number} step @returns {void} */
      play(time, degree, own, step) {
        const fifth = Math.round(degree + 3 * (1 - unison));
        const notes = toFreqs([degreeToMidi(this.rootMidi, degree), degreeToMidi(this.rootMidi, fifth)]);
        const accent = step % 8 === 0 ? 0.95 : step % 4 === 0 ? 0.75 : 0.5;
        const dur = own ? (step % 4 === 0 ? "8n" : "32n") : "8n";
        this.synth.triggerAttackRelease(notes, dur, time, accent);
      },
    },
    contrarian: {
      // Syncopated bell-like pluck: off-beat eighths plus a skipping sixteenth,
      // never on the beat, with a short answering phrase.
      rootMidi: 74,
      rhythm: [2, 6, 7, 10, 14, 15],
      melody: [0, 0, 2, 0, 0, 0, 4, 3, 0, 0, 2, 0, 0, 0, 1, 0],
      thresholds: makeThresholds(3),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], "8n", time, own ? 0.7 : 0.9);
      },
    },
  };

  /**
   * Decide whether a voice plays on this step and with which degree.
   * Uses its own rhythm while unison < the step's threshold, else four on the floor.
   * @param {Object} voice One entry of `voices`.
   * @param {number} step Sixteenth step 0-15.
   * @param {number} u Current unison, 0..1.
   * @returns {{play: boolean, degree: number, own: boolean}} What to do on this step.
   */
  function decide(voice, step, u) {
    const own = u < voice.thresholds[step];
    const hits = own ? voice.rhythm.includes(step) : step % 4 === 0;
    const degree = Math.round(voice.melody[step] * (1 - u));
    return { play: hits, degree, own };
  }

  /**
   * Create the four synths and the shared effects.
   * @returns {void}
   */
  function build() {
    const reverb = new Tone.Reverb({ decay: 3, wet: 0.25 }).toDestination();

    // fx: warm upright-style bass (triangle through a closing low-pass), panned left.
    voices.fx.synth = new Tone.MonoSynth({
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.01, decay: 0.25, sustain: 0.6, release: 0.25 },
      filter: { type: "lowpass", Q: 1 },
      filterEnvelope: { attack: 0.005, decay: 0.25, sustain: 0.35, baseFrequency: 250, octaves: 2.5 },
    }).connect(new Tone.Panner(-0.6).toDestination());
    voices.fx.synth.volume.value = 2;

    // havens: wide, slow detuned pad with chorus and a long reverb, centred.
    const padReverb = new Tone.Reverb({ decay: 6, wet: 0.5 }).toDestination();
    const chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 3.5, depth: 0.7, wet: 0.6 }).start().connect(padReverb);
    voices.havens.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsine", count: 3, spread: 25 },
      envelope: { attack: 1.2, decay: 0.5, sustain: 0.8, release: 3 },
    }).connect(chorus);
    voices.havens.synth.volume.value = -9;

    // commodity: gritty distorted saw power chords, dark filter, panned right.
    const crunchPan = new Tone.Panner(0.35).toDestination();
    const crunchFilter = new Tone.Filter(2400, "lowpass").connect(crunchPan);
    const dist = new Tone.Distortion(0.6).connect(crunchFilter);
    voices.commodity.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.08 },
    }).connect(dist);
    voices.commodity.synth.volume.value = -28;

    // contrarian: bright FM bell-pluck, panned left-ish into a ping-pong echo.
    const echo = new Tone.PingPongDelay({ delayTime: "8n.", feedback: 0.3, wet: 0.25 }).connect(reverb);
    voices.contrarian.synth = new Tone.FMSynth({
      harmonicity: 3.01,
      modulationIndex: 12,
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 },
      modulation: { type: "square" },
      modulationEnvelope: { attack: 0.002, decay: 0.15, sustain: 0, release: 0.1 },
    }).connect(new Tone.Panner(-0.5).connect(echo));
    voices.contrarian.synth.volume.value = -10;

    // Risk voice: low D drone (D1 + D2 for audibility on laptop speakers) and a click.
    droneGain = new Tone.Gain(0).toDestination();
    for (const midi of [26, 38]) {
      new Tone.Oscillator(Tone.Frequency(midi, "midi").toFrequency(), "sine").connect(droneGain).start();
    }
    clickSynth = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    }).toDestination();
    clickSynth.volume.value = -6;
    applyRisk();

    // Re-apply any mutes set from the page before the synths existed.
    for (const voice of Object.values(voices)) applyMute(voice);

    let step = 0;
    Tone.Transport.bpm.value = riskToBpm(risk);
    Tone.Transport.swingSubdivision = "8n";
    Tone.Transport.scheduleRepeat((time) => {
      const u = unison;
      Tone.Transport.swing = MAX_SWING * (1 - u);
      if (step % 4 === 0 && !riskMuted) {
        clickSynth.triggerAttackRelease("A5", "32n", time, 0.03 + 0.97 * risk ** 3);
      }
      for (const voice of Object.values(voices)) {
        const d = decide(voice, step, u);
        if (d.play) voice.play(time, d.degree, d.own, step);
      }
      step = (step + 1) % 16;
    }, "16n");

    built = true;
  }

  /**
   * Start audio (must be called from a user gesture) and the sequencer.
   * @returns {Promise<void>}
   */
  async function start() {
    await Tone.start();
    if (!built) build();
    if (Tone.Transport.state !== "started") Tone.Transport.start("+0.1");
  }

  /**
   * Set the unison level. Safe to call at any time, before or after start().
   * @param {number} value Unison, clamped to 0..1.
   * @returns {void}
   */
  function setUnison(value) {
    unison = Math.min(1, Math.max(0, value));
  }

  /**
   * Set the risk level. Safe to call at any time, before or after start().
   * Drives drone gain, click level and tempo (116 bpm at 0 down to 70 at 1).
   * @param {number} value Risk, clamped to 0..1.
   * @returns {void}
   */
  function setRisk(value) {
    risk = Math.min(1, Math.max(0, value));
    if (built) applyRisk();
  }

  /**
   * Mute or unmute one voice, for auditioning voices one at a time.
   * Safe to call before start(); the state is applied when the synths exist.
   * @param {string} name Voice name: fx, havens, commodity or contrarian.
   * @param {boolean} muted True to silence the voice.
   * @returns {void}
   */
  function setMute(name, muted) {
    const voice = voices[name];
    if (!voice) return;
    voice.muted = muted;
    applyMute(voice);
  }

  /**
   * Apply a voice's mute flag by moving its synth volume to silence or back to its base level.
   * (`synth.volume` is a Tone Param, which has no `mute` property of its own.)
   * @param {Object} voice One entry of `voices`.
   * @returns {void}
   */
  function applyMute(voice) {
    if (!voice.synth) return;
    if (voice.baseVolume === undefined) voice.baseVolume = voice.synth.volume.value;
    voice.synth.volume.value = voice.muted ? -Infinity : voice.baseVolume;
  }

  /**
   * Mute or unmute the risk voice (drone and click).
   * @param {boolean} muted True to silence drone and click.
   * @returns {void}
   */
  function setRiskMute(muted) {
    riskMuted = muted;
    if (built) applyRisk();
  }

  return { start, setUnison, setRisk, setMute, setRiskMute };
})();
