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

  /** Tempo in beats per minute (calm tempo from CLAUDE.md section 8). */
  const BPM = 116;

  /** Maximum swing at unison 0 (CLAUDE.md section 8: 0.45 -> 0). */
  const MAX_SWING = 0.45;

  /** Latest unison value, read by the sequencer on every step. */
  let unison = 0;

  /** True once the synths and sequencer have been built. */
  let built = false;

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
      // Jazz walking bass: quarters with eighth pickups.
      rootMidi: 38,
      rhythm: [0, 4, 8, 10, 12, 14],
      melody: [0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 4, 0, 4, 0, 3, 0],
      thresholds: makeThresholds(0),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], own ? "8n" : "16n", time, 0.9);
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
      // Rock root-and-fifth, distorted, driving eighths.
      rootMidi: 50,
      rhythm: [0, 2, 4, 6, 8, 10, 12, 14],
      melody: [0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 3, 0, 2, 0],
      thresholds: makeThresholds(11),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        const fifth = Math.round(degree + 3 * (1 - unison));
        const notes = toFreqs([degreeToMidi(this.rootMidi, degree), degreeToMidi(this.rootMidi, fifth)]);
        this.synth.triggerAttackRelease(notes, own ? "16n" : "8n", time, 0.8);
      },
    },
    contrarian: {
      // Syncopated pluck: off-beats only.
      rootMidi: 74,
      rhythm: [2, 6, 10, 14],
      melody: [0, 0, 2, 0, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 1, 0],
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

    voices.fx.synth = new Tone.MonoSynth({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.2 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, baseFrequency: 150, octaves: 2 },
    }).toDestination();
    voices.fx.synth.volume.value = -4;

    voices.havens.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.8, decay: 0.5, sustain: 0.8, release: 2 },
    }).connect(reverb);
    voices.havens.synth.volume.value = -14;

    const dist = new Tone.Distortion(0.6).toDestination();
    voices.commodity.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.1 },
    }).connect(dist);
    voices.commodity.synth.volume.value = -20;

    voices.contrarian.synth = new Tone.Synth({
      oscillator: { type: "square" },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0, release: 0.1 },
    }).connect(reverb);
    voices.contrarian.synth.volume.value = -16;

    let step = 0;
    Tone.Transport.bpm.value = BPM;
    Tone.Transport.swingSubdivision = "8n";
    Tone.Transport.scheduleRepeat((time) => {
      const u = unison;
      Tone.Transport.swing = MAX_SWING * (1 - u);
      for (const voice of Object.values(voices)) {
        const d = decide(voice, step, u);
        if (d.play) voice.play(time, d.degree, d.own);
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

  return { start, setUnison };
})();
