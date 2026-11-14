/**
 * Canary: sound engine. Four Tone.js voices driven by one 16th-note
 * sequencer and one number, `unison` (0..1).
 *
 * At unison 0 each voice plays its own rhythm and melody. As unison rises,
 * melody degrees shrink toward the root, off-beat steps drop out one by one
 * (per-step thresholds), and at unison 1 every voice plays D on the beat.
 *
 * Per slice: stance bends the contour (up when bullish), conviction sets
 * velocity, `by` picks the instrument (a covered slice is played by the
 * coverer's instrument), and trust (view freshness) moves the instrument from
 * dry to reverb. Events: escalation sting, approve/veto chords, rebound climb.
 *
 * Exposes a single global: `Music`.
 */

/**
 * Smoothing of everything the sound reads (unison, risk, each analyst's stance
 * and conviction). Time to settle (about 95% of the way) after a jump in the
 * replay's values. Tune these two numbers by ear.
 */
const RISE_SECONDS = 2; // value going up
const FALL_SECONDS = 5; // value going down

const Music = (() => {
  // A larger scheduling cushion: notes are queued further ahead, so a busy
  // main thread (page, DevTools, feed updates) is less likely to cause crackle.
  if (typeof Tone !== "undefined") {
    Tone.getContext().lookAhead = 0.25;
  }

  /** Pitch classes of the shared D minor pentatonic scale (D F G A C), in semitones from D. */
  const SCALE = [0, 3, 5, 7, 10];

  /** Tempo in beats per minute at risk 0 (CLAUDE.md says 116; 96 is being trialled). */
  const BPM = 96;

  /** Maximum swing at unison 0 (CLAUDE.md section 8: 0.45 -> 0). */
  const MAX_SWING = 0.45;

  /** Raw values last sent in by the page. The sound never reads these directly. */
  const target = { unison: 0, risk: 0 };

  /** Per-analyst raw stance and conviction, and their smoothed copies (by slice name). */
  const targetViews = {};
  const smoothViews = {};

  /** Smoothed unison, eased toward target.unison every frame (continuous). */
  let smoothUnison = 0;

  /**
   * Unison as the pattern sees it: latched from smoothUnison at each bar line,
   * so melody convergence, rhythm locking, swing and the arrival hit only
   * change on the downbeat, never mid-bar.
   */
  let unison = 0;

  /** Smoothed risk (continuous): drives tempo, drone, click level, dread layers. */
  let risk = 0;

  /** Style waiting for the next bar line, or null. */
  let pendingStyle = null;

  /** The four slices, which are also the four instrument names. */
  const SLICES = ["fx", "havens", "commodity", "contrarian"];

  /** How many scale degrees a stance of +/-1 bends the melody (before unison pulls it to D). */
  const STANCE_SPAN = 2;

  /** Latest author (`by`) per slice, and when its newest view arrived (performance.now() ms). */
  const sliceBy = {};
  const lastSeen = {};
  let lastAnySeen = 0;

  /** Trust per slice, 0..1, recomputed every frame from view freshness. */
  const trust = {};

  /** Latched at each bar line: who plays each slice, its stance, and the rebound flag. */
  const barBy = {};
  const barStance = {};
  let barRebound = false;

  /** Raw rebound flag from the latest view. */
  let rebound = false;

  /** True for the first bar of a rebound, so the climb fades in. */
  let reboundFresh = false;

  /** performance.now() until which the music holds still (after a decision). */
  let holdUntil = 0;

  /** Seconds for the music to come back up after the card closes (going down is 0.5 s). */
  const UNDUCK_SECONDS = 3;

  /** Music bus (everything except event sounds; this is what ducks) and the trust reverb. */
  let musicBus = null;
  let trustReverb = null;

  /** Event synths: escalation sting, approve/veto chord, rebound climb. */
  let stingSynth = null;
  let chordSynth = null;
  let reboundSynth = null;

  /** True when the risk voice (drone and click) is muted from the page. */
  let riskMuted = false;

  /** Tempo at risk 1 (bpm). */
  const MIN_BPM = 70;

  /** Unison at or above which the voices have "arrived": swing 0 and a big shared D on every downbeat. */
  const ARRIVAL = 0.95;

  /** MIDI notes of the arrival stack: D in four octaves (D2 to D5; nothing below laptop-speaker range). */
  const ARRIVAL_MIDIS = [38, 50, 62, 74];

  /** Master level in dB, normal and ducked (while an approval card is open). */
  const MASTER_DB = -6;
  const DUCK_DB = -20;

  /** True while the music is ducked under the approval card. */
  let ducked = false;

  /** Thick shared synth that adds the arrival hit, built in build(). */
  let arrivalSynth = null;

  /** Dread layers driven by risk, built in build(): tritone drone, brown-noise rumble, shared reverb. */
  let tritoneGain = null;
  let rumbleGain = null;
  let hallReverb = null;

  /** Drone gain node and click synth, built in build(). */
  let droneGain = null;
  let clickSynth = null;

  /** True once the Classical preset's synths exist. */
  let classicalBuilt = false;

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

  /** Calm mix: how much quieter (dB) and how muffled (low-pass Hz) the music is at low risk. */
  const CALM_DB = -7;
  const CALM_CUTOFF = 1400;
  const OPEN_CUTOFF = 18000;

  /** Risk where the music starts to wake up, and where it is fully loud and bright. */
  const STRESS_FROM = 0.25;
  const STRESS_FULL = 0.75;

  /** Low-pass and gain after the music bus that make calm markets sit back. Built in build(). */
  let calmFilter = null;
  let calmGain = null;

  /**
   * How stressed the market sounds, 0 (calm) to 1 (full alarm), from risk.
   * Flat below STRESS_FROM so calm days stay relaxed, then an S-curve up to STRESS_FULL.
   * @param {number} r Risk, 0..1.
   * @returns {number} Stress, 0..1.
   */
  function stressLevel(r) {
    const x = Math.min(1, Math.max(0, (r - STRESS_FROM) / (STRESS_FULL - STRESS_FROM)));
    return x * x * (3 - 2 * x);
  }

  /**
   * Push the current risk to the drone gain and tempo (smoothed to avoid zipper noise).
   * @returns {void}
   */
  function applyRisk() {
    const stress = stressLevel(risk);

    // Calm markets: softer and slightly muffled. Stress opens the sound up and brings it forward.
    if (calmFilter) {
      calmFilter.frequency.rampTo(CALM_CUTOFF * (OPEN_CUTOFF / CALM_CUTOFF) ** stress, 0.1);
      calmGain.gain.rampTo(Tone.dbToGain(CALM_DB * (1 - stress)), 0.1);
    }

    // Drone: silent when calm, loud in a crash.
    droneGain.gain.rampTo(riskMuted ? 0 : 0.6 * stress ** 2, 0.1);
    Tone.Transport.bpm.rampTo(riskToBpm(risk), 0.1);

    // Ominous layers. Each is silent in calm markets and grows as risk climbs.
    // Tritone (G#2 against the D drone): enters around risk 0.3, swells to full.
    const dread = Math.max(0, (risk - 0.3) / 0.7);
    tritoneGain.gain.rampTo(riskMuted ? 0 : 0.25 * Math.max(dread, stress) ** 2, 0.1);
    // Sub rumble (filtered brown noise): rises from risk 0.2.
    rumbleGain.gain.rampTo(riskMuted ? 0 : 0.3 * Math.max(0, (risk - 0.2) / 0.8) ** 2, 0.1);
    // The room gets bigger and the music recedes into it.
    if (hallReverb) hallReverb.wet.rampTo(0.25 + 0.45 * risk, 0.1);
  }

  /**
   * Ease one value toward its target: exponential approach, faster going up
   * than down. RISE_SECONDS / FALL_SECONDS are the time to get ~95% there.
   * @param {number} current Current smoothed value.
   * @param {number} goal Target value.
   * @param {number} dt Seconds since the last frame.
   * @returns {number} The new smoothed value.
   */
  function ease(current, goal, dt) {
    const seconds = goal > current ? RISE_SECONDS : FALL_SECONDS;
    if (seconds <= 0) return goal;
    const next = goal + (current - goal) * Math.exp((-3 * dt) / seconds);
    return Math.abs(next - goal) < 0.0005 ? goal : next;
  }

  /**
   * Trust of one slice from how far its newest view lags the freshest view of
   * any slice (DESIGN.md: 1.0 for the first second, then halves every 0.8 s).
   * Measured relative to the freshest view, so a paused replay (no views at
   * all) does not fade everyone.
   * @param {string} slice Slice name.
   * @returns {number} Trust, 0..1.
   */
  function freshness(slice) {
    if (lastSeen[slice] === undefined) return 1;
    const lag = (lastAnySeen - lastSeen[slice]) / 1000;
    return lag <= 1 ? 1 : 0.5 ** ((lag - 1) / 0.8);
  }

  /**
   * Trust of an instrument: the lowest trust of the slices it is playing now
   * (1 if it plays none).
   * @param {string} name Instrument (analyst) name.
   * @returns {number} Trust, 0..1.
   */
  function instrumentTrust(name) {
    let t = 1;
    for (const s of SLICES) if ((sliceBy[s] || s) === name) t = Math.min(t, trust[s] ?? 1);
    return t;
  }

  /**
   * Push trust to every built instrument: dry gain down, reverb send up.
   * @returns {void}
   */
  function applyTrust() {
    for (const set of Object.values(styles)) {
      for (const [name, voice] of Object.entries(set)) {
        if (!voice.dry) continue;
        const t = instrumentTrust(name);
        voice.dry.gain.rampTo(0.2 + 0.8 * t, 0.1);
        voice.send.gain.rampTo(0.9 * (1 - t), 0.1);
      }
    }
  }

  /** Frame period in ms, and how many frames between pushes of smoothed risk to the audio params. */
  const FRAME_MS = 16;
  const APPLY_EVERY = 4;
  let frameCount = 0;
  let lastFrame = performance.now();
  let lastAppliedRisk = -1;

  /**
   * One smoothing frame. Before audio starts it just snaps to the targets,
   * so the first notes start from the right place.
   * @returns {void}
   */
  function frame() {
    const now = performance.now();
    const dt = Math.min((now - lastFrame) / 1000, 1);
    lastFrame = now;
    if (!built) {
      smoothUnison = target.unison;
      risk = target.risk;
      for (const name of Object.keys(targetViews)) smoothViews[name] = { ...targetViews[name] };
      return;
    }
    // While held (just after a decision) the music stays where it was, so the
    // decision chord rings out before the market moves the sound again.
    if (now >= holdUntil) {
      smoothUnison = ease(smoothUnison, target.unison, dt);
      risk = ease(risk, target.risk, dt);
      for (const [name, goal] of Object.entries(targetViews)) {
        const cur = smoothViews[name] || goal;
        smoothViews[name] = {
          stance: ease(cur.stance, goal.stance, dt),
          conviction: ease(cur.conviction, goal.conviction, dt),
        };
      }
    }
    for (const sl of SLICES) trust[sl] = ease(trust[sl] ?? 1, freshness(sl), dt);
    frameCount += 1;
    if (frameCount % APPLY_EVERY === 0) {
      if (Math.abs(risk - lastAppliedRisk) > 0.0005) {
        lastAppliedRisk = risk;
        applyRisk();
      }
      applyTrust();
    }
  }
  setInterval(frame, FRAME_MS);

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
   * Classical preset: same four analysts, same scale and same unison maths, but
   * slow, simple minimalist lines on string/brass/pizzicato timbres (no samples).
   * Each entry has the same shape as `voices`.
   * @type {Object<string, Object>}
   */
  const classicalVoices = {
    fx: {
      // Cello: one long low D per half bar, answered by A. Slow bowed attack.
      rootMidi: 38,
      rhythm: [0, 8],
      melody: [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0],
      thresholds: makeThresholds(0),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], own ? "2n" : "4n", time, 0.8);
      },
    },
    havens: {
      // Soft string section: one sustained chord per bar.
      rootMidi: 62,
      rhythm: [0],
      melody: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      thresholds: makeThresholds(5),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        const chord = toFreqs([0, 2, 4].map((d) => degreeToMidi(this.rootMidi, Math.round(degree + d * (1 - unison)))));
        this.synth.triggerAttackRelease(chord, own ? "1m" : "4n", time, 0.45);
      },
    },
    commodity: {
      // Piano: a steady eighth-note pulse rocking D, F, G, F (minimalist),
      // with a low octave under the first beat of each bar.
      rootMidi: 50,
      rhythm: [0, 2, 4, 6, 8, 10, 12, 14],
      melody: [0, 0, 1, 0, 2, 0, 1, 0, 0, 0, 1, 0, 2, 0, 1, 0],
      thresholds: makeThresholds(11),
      /** @param {number} time @param {number} degree @param {boolean} own @param {number} step @returns {void} */
      play(time, degree, own, step) {
        const midis = [degreeToMidi(this.rootMidi, degree)];
        if (step === 0) midis.push(degreeToMidi(this.rootMidi, degree - 5));
        this.synth.triggerAttackRelease(toFreqs(midis), own ? "4n" : "2n", time, step === 0 ? 0.8 : step % 4 === 0 ? 0.6 : 0.4);
      },
    },
    contrarian: {
      // Pizzicato: four plucks on the last sixteenth of each beat (odd steps),
      // so it never lands with the piano's eighths or the cello's long notes.
      rootMidi: 74,
      rhythm: [3, 7, 11, 15],
      melody: [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 1],
      thresholds: makeThresholds(3),
      /** @param {number} time @param {number} degree @returns {void} */
      play(time, degree) {
        this.synth.triggerAttack(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], time);
      },
    },
  };


  /**
   * Metal preset: palm-muted gallop bass with double kick, a dark choir, a
   * distorted 3-3-2 rhythm-guitar riff with a half-time snare, and a screaming
   * lead. Drums belong to an analyst (kick: fx, snare: commodity), so they
   * follow its convergence and mute, and drop out when it is covered.
   * @type {Object<string, Object>}
   */
  const metalVoices = {
    fx: {
      // Bass + double kick: gallop (eighth, two sixteenths), lifting at the bar end.
      rootMidi: 38,
      rhythm: [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15],
      melody: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 2],
      thresholds: makeThresholds(0),
      /** @param {number} time @param {number} degree @param {boolean} own @param {number} step @returns {void} */
      play(time, degree, own, step) {
        const accent = step % 4 === 0 ? 0.95 : 0.7;
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], "16n", time, accent);
        if (this.drums) this.drums.kick.triggerAttackRelease("D2", "16n", time, accent);
      },
    },
    havens: {
      // Dark choir: one sustained chord per bar.
      rootMidi: 62,
      rhythm: [0],
      melody: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      thresholds: makeThresholds(5),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        const chord = toFreqs([0, 2, 4].map((d) => degreeToMidi(this.rootMidi, Math.round(degree + d * (1 - unison)))));
        this.synth.triggerAttackRelease(chord, own ? "1m" : "4n", time, 0.5);
      },
    },
    commodity: {
      // Rhythm guitar: root-fifth-octave power chords on a 3-3-2 riff; snare on beat 3.
      rootMidi: 50,
      rhythm: [0, 3, 6, 8, 10, 11, 14],
      melody: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 2, 0],
      thresholds: makeThresholds(11),
      /** @param {number} time @param {number} degree @param {boolean} own @param {number} step @returns {void} */
      play(time, degree, own, step) {
        const fifth = Math.round(degree + 3 * (1 - unison));
        const notes = toFreqs([degree, fifth, degree + 5].map((d) => degreeToMidi(this.rootMidi, d)));
        this.synth.triggerAttackRelease(notes, own ? "16n" : "8n", time, step % 8 === 0 ? 0.95 : 0.75);
        if (this.drums && step === 8) this.drums.snare.triggerAttackRelease("16n", time, 0.9);
      },
    },
    contrarian: {
      // Lead guitar: sparse off-beat squeals that slide between notes.
      rootMidi: 74,
      rhythm: [6, 10, 14],
      melody: [0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 5, 0],
      thresholds: makeThresholds(3),
      /** @param {number} time @param {number} degree @returns {void} */
      play(time, degree) {
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], "8n", time, 0.8);
      },
    },
  };

  /**
   * Phonk preset: gliding 808 with kick, a wobbly tape pad, the pitched cowbell
   * riff with a half-time clap, and a gritty lead over trap hats. Drums belong
   * to an analyst (kick: fx, clap: commodity, hats: contrarian).
   * @type {Object<string, Object>}
   */
  const phonkVoices = {
    fx: {
      // 808 + kick: three hits per bar, sliding up to A before the bar ends.
      rootMidi: 38,
      rhythm: [0, 7, 10],
      melody: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0],
      thresholds: makeThresholds(0),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], own ? "4n." : "8n", time, 0.9);
        if (this.drums) this.drums.kick.triggerAttackRelease("D2", "8n", time, 0.9);
      },
    },
    havens: {
      // Tape pad: one wobbly chord per bar.
      rootMidi: 62,
      rhythm: [0],
      melody: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      thresholds: makeThresholds(5),
      /** @param {number} time @param {number} degree @param {boolean} own @returns {void} */
      play(time, degree, own) {
        const chord = toFreqs([0, 2, 4].map((d) => degreeToMidi(this.rootMidi, Math.round(degree + d * (1 - unison)))));
        this.synth.triggerAttackRelease(chord, own ? "1m" : "4n", time, 0.45);
      },
    },
    commodity: {
      // Pitched cowbell riff (one octave up, D4, so it rings like the 808 cowbell); clap on beat 3.
      rootMidi: 62,
      rhythm: [0, 3, 6, 8, 10, 12, 14],
      melody: [2, 0, 0, 2, 0, 0, 1, 0, 0, 0, 3, 0, 2, 0, 4, 0],
      thresholds: makeThresholds(11),
      /** @param {number} time @param {number} degree @param {boolean} own @param {number} step @returns {void} */
      play(time, degree, own, step) {
        this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], "16n", time, step % 4 === 0 ? 0.9 : 0.7);
        if (this.drums && step === 8) this.drums.clap.triggerAttackRelease("16n", time, 0.9);
      },
    },
    contrarian: {
      // Trap hats on the off-beats with a roll at the bar end; a lead stab on two of them.
      rootMidi: 74,
      rhythm: [2, 6, 10, 13, 14, 15],
      melody: [0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 3, 0],
      thresholds: makeThresholds(3),
      /** @param {number} time @param {number} degree @param {boolean} own @param {number} step @returns {void} */
      play(time, degree, own, step) {
        if (this.drums) this.drums.hat.triggerAttackRelease("32n", time, step >= 13 ? 0.5 : 0.8);
        if (!own || step === 6 || step === 14) {
          this.synth.triggerAttackRelease(toFreqs([degreeToMidi(this.rootMidi, degree)])[0], "8n", time, 0.75);
        }
      },
    },
  };

  /** Style presets: name -> voice set. */
  const styles = { default: voices, classical: classicalVoices, metal: metalVoices, phonk: phonkVoices };

  /** Maximum swing per style (classical and metal are played straight; phonk has a light shuffle). */
  const swingByStyle = { default: MAX_SWING, classical: 0, metal: 0, phonk: 0.12 };

  /** Name of the active style. */
  let styleName = "default";

  /**
   * Decide whether a voice plays on this step and with which degree.
   * Uses its own rhythm while unison < the step's threshold, else four on the floor.
   * @param {Object} voice One entry of `voices`.
   * @param {number} step Sixteenth step 0-15.
   * @param {number} u Current unison, 0..1.
   * @param {number} stance The slice's stance, -1..1 (bends the contour; unison still pulls it to D).
   * @returns {{play: boolean, degree: number, own: boolean}} What to do on this step.
   */
  function decide(voice, step, u, stance) {
    const own = u < voice.thresholds[step];
    const hits = own ? voice.rhythm.includes(step) : step % 4 === 0;
    const degree = Math.round((voice.melody[step] + STANCE_SPAN * stance) * (1 - u));
    return { play: hits, degree, own };
  }

  /**
   * Connect a voice's synth through its own dry gain (to `dest`) and a reverb
   * send (to the trust reverb), so trust can push it into the distance.
   * @param {Object} voice One entry of a voice set.
   * @param {Object} synth The Tone instrument.
   * @param {Object} dest Where the dry signal goes (an effect chain or the music bus).
   * @returns {void}
   */
  function wire(voice, synth, dest) {
    voice.synth = synth;
    voice.dry = new Tone.Gain(1).connect(dest);
    voice.send = new Tone.Gain(0).connect(trustReverb);
    synth.connect(voice.dry);
    synth.connect(voice.send);
  }

  /**
   * Wrap an instrument so any part can be played on it: chords collapse to
   * their first note on a monophonic synth, and velocity is scaled by conviction.
   * @param {Object} synth The Tone instrument that will sound.
   * @param {number} gain Velocity multiplier (from conviction).
   * @returns {{triggerAttackRelease: Function, triggerAttack: Function}} A synth-like object.
   */
  function player(synth, gain) {
    const poly = synth instanceof Tone.PolySynth;
    const fit = (notes) => (Array.isArray(notes) && !poly ? notes[0] : notes);
    return {
      triggerAttackRelease(notes, dur, time, vel = 1) {
        synth.triggerAttackRelease(fit(notes), dur, time, vel * gain);
      },
      triggerAttack(notes, time, vel = 1) {
        synth.triggerAttack(fit(notes), time, vel * gain);
      },
    };
  }

  /**
   * Build the Classical preset's synths. Done lazily (first time the style is
   * chosen) so the Default preset does not pay for synths it never plays.
   * @returns {void}
   */
  function buildClassical() {
    if (classicalBuilt) return;
    classicalBuilt = true;
    // Classical preset synths (all synthesised, no samples).
    const hall = new Tone.Reverb({ decay: 5, wet: 0.45 }).connect(musicBus);
    hallReverb = hall;

    // fx cello: bowed saw, slow attack, vibrato, warm low-pass, panned left.
    const cellovib = new Tone.Vibrato({ frequency: 5, depth: 0.12 }).connect(new Tone.Panner(-0.4).connect(hall));
    wire(classicalVoices.fx, new Tone.MonoSynth({
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.35, decay: 0.3, sustain: 0.8, release: 0.9 },
      filter: { type: "lowpass", Q: 0.5 },
      filterEnvelope: { attack: 0.4, decay: 0.3, sustain: 0.6, baseFrequency: 110, octaves: 1.8 },
    }), cellovib);
    classicalVoices.fx.synth.volume.value = -2;

    // havens strings: detuned saws, very slow attack, dark filter, big reverb.
    const stringFilter = new Tone.Filter(3000, "lowpass").connect(hall);
    const stringVibrato = new Tone.Vibrato({ frequency: 5.5, depth: 0.1 }).connect(stringFilter);
    wire(classicalVoices.havens, new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 2, spread: 18 },
      envelope: { attack: 1.4, decay: 0.5, sustain: 0.85, release: 2.5 },
    }), stringVibrato);
    classicalVoices.havens.synth.volume.value = -16;

    // commodity piano: FM with a hammer-bright attack that mellows as it decays,
    // instant attack, no sustain (notes ring and die away), light room reverb, right.
    const pianoOut = new Tone.Panner(0.3).connect(musicBus);
    pianoOut.connect(hall);
    wire(classicalVoices.commodity, new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 2.01,
      modulationIndex: 2.5,
      oscillator: { type: "sine" },
      envelope: { attack: 0.003, decay: 2.2, sustain: 0, release: 1.2 },
      modulation: { type: "triangle" },
      modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0.05, release: 0.5 },
    }), pianoOut);
    classicalVoices.commodity.synth.volume.value = -8;

    // contrarian pizzicato violin: bright, short Karplus-Strong pluck.
    wire(classicalVoices.contrarian, new Tone.PluckSynth({
      attackNoise: 2,
      dampening: 5000,
      resonance: 0.85,
    }), new Tone.Panner(-0.3).connect(hall));
    classicalVoices.contrarian.synth.volume.value = 2;

    for (const voice of Object.values(classicalVoices)) applyMute(voice);
    if (built) applyRisk();
  }


  /**
   * Route a drum through its analyst's dry gain, so trust and mute apply to it.
   * @param {Object} voice One entry of a voice set (already wired).
   * @param {Object} synth The drum synth.
   * @returns {Object} The drum synth.
   */
  function drum(voice, synth) {
    synth.connect(voice.dry);
    return synth;
  }

  /**
   * Build the Metal preset's synths (lazily, the first time it is chosen).
   * @returns {void}
   */
  function buildMetal() {
    const room = new Tone.Reverb({ decay: 2.5, wet: 0.2 }).connect(musicBus);

    // fx bass: short saw, heavy drive, dark cab, slightly left; double kick.
    const bassDrive = new Tone.Distortion(0.8).connect(new Tone.Filter(1500, "lowpass").connect(new Tone.Panner(-0.3).connect(musicBus)));
    wire(metalVoices.fx, new Tone.MonoSynth({
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.002, decay: 0.12, sustain: 0.2, release: 0.05 },
      filter: { type: "lowpass", Q: 1 },
      filterEnvelope: { attack: 0.002, decay: 0.1, sustain: 0.3, baseFrequency: 300, octaves: 2 },
    }), bassDrive);
    metalVoices.fx.synth.volume.value = -16;
    metalVoices.fx.drums = {
      kick: drum(metalVoices.fx, new Tone.MembraneSynth({
        pitchDecay: 0.03, octaves: 5, envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.05 },
      })),
    };
    metalVoices.fx.drums.kick.volume.value = -6;

    // havens choir: wide detuned saws, slow attack, dark filter, reverb.
    wire(metalVoices.havens, new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 2, spread: 30 },
      envelope: { attack: 0.8, decay: 0.5, sustain: 0.8, release: 2.5 },
    }), new Tone.Filter(1400, "lowpass").connect(room));
    metalVoices.havens.synth.volume.value = -20;

    // commodity rhythm guitar: saw power chords into heavy distortion and a cab filter, right; snare.
    const cab = new Tone.Filter(100, "highpass").connect(new Tone.Filter(3500, "lowpass").connect(new Tone.Panner(0.35).connect(musicBus)));
    wire(metalVoices.commodity, new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.003, decay: 0.15, sustain: 0.5, release: 0.05 },
    }), new Tone.Distortion(0.95).connect(cab));
    metalVoices.commodity.synth.volume.value = -28;
    metalVoices.commodity.drums = {
      snare: drum(metalVoices.commodity, new Tone.NoiseSynth({
        noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.18, sustain: 0 },
      })),
    };
    metalVoices.commodity.drums.snare.volume.value = -12;

    // contrarian lead: gliding square, driven, with a short echo.
    const leadEcho = new Tone.FeedbackDelay({ delayTime: "8n", feedback: 0.25, wet: 0.2 }).connect(room);
    wire(metalVoices.contrarian, new Tone.MonoSynth({
      portamento: 0.04,
      oscillator: { type: "square" },
      envelope: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.3 },
      filter: { type: "lowpass", Q: 2 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.7, baseFrequency: 1200, octaves: 2 },
    }), new Tone.Distortion(0.85).connect(new Tone.Filter(4000, "lowpass").connect(leadEcho)));
    metalVoices.contrarian.synth.volume.value = -22;
  }

  /**
   * Build the Phonk preset's synths (lazily, the first time it is chosen).
   * @returns {void}
   */
  function buildPhonk() {
    const room = new Tone.Reverb({ decay: 2, wet: 0.2 }).connect(musicBus);

    // fx 808: sine with glide, saturated, low-passed; kick on every hit.
    wire(phonkVoices.fx, new Tone.MonoSynth({
      portamento: 0.06,
      oscillator: { type: "sine" },
      envelope: { attack: 0.005, decay: 1.2, sustain: 0.4, release: 0.3 },
      filter: { type: "lowpass", Q: 0.5 },
      filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 1, baseFrequency: 900, octaves: 0 },
    }), new Tone.Distortion(0.4).connect(new Tone.Filter(900, "lowpass").connect(musicBus)));
    phonkVoices.fx.synth.volume.value = -4;
    phonkVoices.fx.drums = {
      kick: drum(phonkVoices.fx, new Tone.MembraneSynth({
        pitchDecay: 0.05, octaves: 4, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.05 },
      })),
    };
    phonkVoices.fx.drums.kick.volume.value = -8;

    // havens tape pad: detuned saws through a band-pass with a slow, deep wobble.
    const wobble = new Tone.Vibrato({ frequency: 0.6, depth: 0.25 }).connect(room);
    wire(phonkVoices.havens, new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 2, spread: 20 },
      envelope: { attack: 0.6, decay: 0.4, sustain: 0.7, release: 2 },
    }), new Tone.Filter({ type: "bandpass", frequency: 900, Q: 1.2 }).connect(wobble));
    phonkVoices.havens.synth.volume.value = -14;

    // commodity cowbell: short square through a band-pass, right; clap.
    wire(phonkVoices.commodity, new Tone.Synth({
      oscillator: { type: "square" },
      envelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.1 },
    }), new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 1.5 }).connect(new Tone.Panner(0.3).connect(room)));
    phonkVoices.commodity.synth.volume.value = -6;
    phonkVoices.commodity.drums = {
      clap: drum(phonkVoices.commodity, new Tone.NoiseSynth({
        noise: { type: "pink" }, envelope: { attack: 0.002, decay: 0.22, sustain: 0 },
      })),
    };
    phonkVoices.commodity.drums.clap.volume.value = -12;

    // contrarian lead: band-passed driven saw, left; hi-hats.
    wire(phonkVoices.contrarian, new Tone.Synth({
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.2 },
    }), new Tone.Filter({ type: "bandpass", frequency: 1200, Q: 2 }).connect(new Tone.Distortion(0.5).connect(new Tone.Panner(-0.3).connect(room))));
    phonkVoices.contrarian.synth.volume.value = -14;
    const hatOut = new Tone.Filter(7000, "highpass");
    hatOut.connect(phonkVoices.contrarian.dry);
    const hat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.04, sustain: 0 } }).connect(hatOut);
    hat.volume.value = -20;
    phonkVoices.contrarian.drums = { hat };
  }

  /** Lazy builders per style ("default" is built in build()). */
  const builders = { classical: buildClassical, metal: buildMetal, phonk: buildPhonk };
  const builtStyles = new Set(["default"]);

  /**
   * Build a style's synths the first time it is needed.
   * @param {string} name Style name.
   * @returns {void}
   */
  function buildStyle(name) {
    if (builtStyles.has(name) || !builders[name]) return;
    builtStyles.add(name);
    builders[name]();
    for (const voice of Object.values(styles[name])) applyMute(voice);
    if (built) applyRisk();
  }

  /**
   * Create the four synths and the shared effects.
   * @returns {void}
   */
  function build() {
    // Master safety: headroom plus a limiter so stacked voices cannot clip the output.
    Tone.Destination.volume.value = MASTER_DB;
    Tone.Destination.chain(new Tone.Limiter(-3));

    // Music bus (ducks under the card) and the reverb that untrusted voices drift into.
    // Calm shaper sits after the bus: quiet and muffled at low risk, open at high risk.
    calmGain = new Tone.Gain(Tone.dbToGain(CALM_DB)).toDestination();
    calmFilter = new Tone.Filter(CALM_CUTOFF, "lowpass").connect(calmGain);
    musicBus = new Tone.Gain(ducked ? Tone.dbToGain(DUCK_DB - MASTER_DB) : 1).connect(calmFilter);
    trustReverb = new Tone.Reverb({ decay: 6, wet: 1 }).connect(musicBus);

    // Event sounds go straight to the output, so they cut through the duck.
    stingSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.005, decay: 1.2, sustain: 0.25, release: 1.5 },
    }).connect(new Tone.Filter(3200, "lowpass").toDestination());
    stingSynth.volume.value = -14;
    chordSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope: { attack: 0.04, decay: 0.6, sustain: 0.6, release: 2.5 },
    }).toDestination();
    chordSynth.volume.value = -8;
    reboundSynth = new Tone.Synth({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.003, decay: 0.12, sustain: 0, release: 0.1 },
    }).connect(musicBus);
    reboundSynth.volume.value = -10;

    const reverb = new Tone.Reverb({ decay: 3, wet: 0.25 }).connect(musicBus);

    // fx: warm upright-style bass (triangle through a closing low-pass), panned left.
    wire(voices.fx, new Tone.MonoSynth({
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.01, decay: 0.25, sustain: 0.6, release: 0.25 },
      filter: { type: "lowpass", Q: 1 },
      filterEnvelope: { attack: 0.005, decay: 0.25, sustain: 0.35, baseFrequency: 250, octaves: 2.5 },
    }), new Tone.Panner(-0.6).connect(musicBus));
    voices.fx.synth.volume.value = 2;

    // havens: wide, slow detuned pad with chorus and a long reverb, centred.
    const padReverb = new Tone.Reverb({ decay: 6, wet: 0.5 }).connect(musicBus);
    const chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 3.5, depth: 0.7, wet: 0.6 }).start().connect(padReverb);
    wire(voices.havens, new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsine", count: 3, spread: 25 },
      envelope: { attack: 1.2, decay: 0.5, sustain: 0.8, release: 3 },
    }), chorus);
    voices.havens.synth.volume.value = -9;

    // commodity: gritty distorted saw power chords, dark filter, panned right.
    const crunchPan = new Tone.Panner(0.35).connect(musicBus);
    const crunchFilter = new Tone.Filter(2400, "lowpass").connect(crunchPan);
    const dist = new Tone.Distortion(0.6).connect(crunchFilter);
    wire(voices.commodity, new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.08 },
    }), dist);
    voices.commodity.synth.volume.value = -28;

    // contrarian: bright FM bell-pluck, panned left-ish into a ping-pong echo.
    const echo = new Tone.PingPongDelay({ delayTime: "8n.", feedback: 0.3, wet: 0.25 }).connect(reverb);
    wire(voices.contrarian, new Tone.FMSynth({
      harmonicity: 3.01,
      modulationIndex: 12,
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.25, sustain: 0, release: 0.2 },
      modulation: { type: "square" },
      modulationEnvelope: { attack: 0.002, decay: 0.15, sustain: 0, release: 0.1 },
    }), new Tone.Panner(-0.5).connect(echo));
    voices.contrarian.synth.volume.value = -10;

    buildStyle(styleName);

    // Arrival hit: a thick stack of D in five octaves, played on the downbeat
    // when unison reaches ARRIVAL. Sits on top of the four voices' own D.
    arrivalSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 2, spread: 20 },
      envelope: { attack: 0.01, decay: 0.4, sustain: 0.7, release: 1.5 },
    }).connect(new Tone.Filter(2800, "lowpass").connect(musicBus));
    arrivalSynth.volume.value = -16;

    // Risk voice: low D drone (D2 + D3, nothing below laptop-speaker range) and a click.
    droneGain = new Tone.Gain(0).connect(musicBus);
    for (const midi of [38, 50]) {
      new Tone.Oscillator(Tone.Frequency(midi, "midi").toFrequency(), "sine").connect(droneGain).start();
    }
    // Tritone drone: G#2 and G#3 (a tritone above D), slowly pulsing, for unease.
    tritoneGain = new Tone.Gain(0).connect(musicBus);
    const pulse = new Tone.Tremolo({ frequency: 0.35, depth: 0.7 }).connect(tritoneGain).start();
    for (const midi of [44, 56]) {
      new Tone.Oscillator(Tone.Frequency(midi, "midi").toFrequency(), "triangle").connect(pulse).start();
    }
    // Sub rumble: brown noise through a low-pass.
    rumbleGain = new Tone.Gain(0).connect(musicBus);
    new Tone.Noise("brown").connect(new Tone.Filter(50, "highpass").connect(new Tone.Filter(160, "lowpass").connect(rumbleGain))).start();
    clickSynth = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    }).connect(musicBus);
    clickSynth.volume.value = -6;
    applyRisk();

    // Re-apply any mutes set from the page before the synths existed.
    for (const set of Object.values(styles)) {
      for (const voice of Object.values(set)) applyMute(voice);
    }

    let step = 0;
    Tone.Transport.bpm.value = riskToBpm(risk);
    Tone.Transport.swingSubdivision = "8n";
    unison = smoothUnison;
    Tone.Transport.scheduleRepeat((time) => {
      if (step === 0) {
        // Bar line: the only place patterns may change (style, convergence, swing, arrival).
        if (pendingStyle) {
          releaseStyle(styleName);
          styleName = pendingStyle;
          pendingStyle = null;
        }
        unison = smoothUnison;
        Tone.Transport.swing = unison >= ARRIVAL ? 0 : swingByStyle[styleName] * (1 - unison);
        // Who plays each slice and its contour only change here, so a takeover
        // or a returning analyst comes in on the bar line.
        for (const sl of SLICES) {
          barBy[sl] = sliceBy[sl] || sl;
          barStance[sl] = smoothViews[sl] ? smoothViews[sl].stance : 0;
        }
        const next = performance.now() < holdUntil ? barRebound : rebound;
        reboundFresh = next && !barRebound;
        barRebound = next;
      }
      const u = unison;
      const arrived = u >= ARRIVAL;
      if (arrived && step === 0) {
        arrivalSynth.triggerAttackRelease(toFreqs(ARRIVAL_MIDIS), "2n", time, 1);
      }
      if (step % 4 === 0 && !riskMuted) {
        clickSynth.triggerAttackRelease("A5", "32n", time, 0.03 + 0.97 * stressLevel(risk) ** 2);
      }
      if (barRebound) {
        // Rebound: a 16th-note pentatonic climb over two octaves (D4 to D6), ignoring unison.
        const midi = degreeToMidi(62, Math.round((step * 10) / 15));
        const fade = reboundFresh ? (step + 1) / 16 : 1; // first bar fades in
        reboundSynth.triggerAttackRelease(Tone.Frequency(midi, "midi").toFrequency(), "16n", time, fade * (0.5 + 0.4 * (step / 15)));
      }
      const set = styles[styleName];
      for (const sl of SLICES) {
        const pattern = set[sl];
        const instrument = set[barBy[sl]] || pattern;
        if (!instrument.synth) continue;
        const d = decide(pattern, step, u, barStance[sl]);
        if (!d.play) continue;
        const conviction = smoothViews[sl] ? smoothViews[sl].conviction : 1;
        const synth = player(instrument.synth, 0.35 + 0.65 * conviction);
        // An analyst's drums only play on its own instrument: a covered part loses them.
        const drums = instrument === pattern ? pattern.drums : null;
        pattern.play.call({ ...pattern, synth, drums }, time, d.degree, d.own, step);
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
    if (!Number.isFinite(value)) return;
    target.unison = Math.min(1, Math.max(0, value));
  }

  /**
   * Set the risk level. Safe to call at any time, before or after start().
   * Drives drone gain, click level and tempo (116 bpm at 0 down to 70 at 1).
   * @param {number} value Risk, clamped to 0..1.
   * @returns {void}
   */
  function setRisk(value) {
    if (!Number.isFinite(value)) return;
    target.risk = Math.min(1, Math.max(0, value));
  }

  /**
   * Give the engine each analyst's latest stance and conviction (raw values;
   * a smoothed copy is kept and nothing reads the raw ones for sound).
   * @param {{slice: string, stance: number, conviction: number}[]} views The `views` of a view message.
   * @returns {void}
   */
  function setViews(views) {
    const now = performance.now();
    for (const v of views) {
      targetViews[v.slice] = { stance: v.stance, conviction: v.conviction };
      if (!smoothViews[v.slice]) smoothViews[v.slice] = { stance: v.stance, conviction: v.conviction };
      sliceBy[v.slice] = v.by || v.slice;
      lastSeen[v.slice] = now;
    }
    if (views.length) lastAnySeen = now;
  }

  /**
   * Set the rebound flag from the latest view; the climb starts or stops at the next bar line.
   * @param {boolean} on True on a rebound day.
   * @returns {void}
   */
  function setRebound(on) {
    rebound = Boolean(on);
  }

  /**
   * Escalation sting: cluster C, D flat, F sharp, G over low D. Plays at once (not
   * on the bar) and is not ducked.
   * @returns {void}
   */
  function sting() {
    if (!built) return;
    stingSynth.triggerAttackRelease(toFreqs([38, 60, 61, 66, 67]), "2n", Tone.now() + 0.05, 0.9);
  }

  /**
   * Decision sound: D major chord on approve, tritone on veto. Not ducked.
   * @param {"approve"|"veto"} verdict The decision.
   * @returns {void}
   */
  function decision(verdict) {
    if (!built) return;
    const notes = verdict === "approve" ? [50, 54, 57, 62] : [50, 56, 62, 68];
    chordSynth.triggerAttackRelease(toFreqs(notes), "1n", Tone.now() + 0.05, 0.8);
  }

  /**
   * Current trust per slice (smoothed), for the page's trust bars.
   * @returns {Object<string, number>} Slice -> trust, 0..1.
   */
  function getTrust() {
    return Object.fromEntries(SLICES.map((sl) => [sl, trust[sl] ?? 1]));
  }

  /**
   * Current tempo in bpm (follows smoothed risk).
   * @returns {number} Beats per minute.
   */
  function getTempo() {
    return built ? Tone.Transport.bpm.value : riskToBpm(target.risk);
  }

  /**
   * Snapshot of the smoothed values (for the page or for debugging).
   * @returns {{unison: number, risk: number, views: Object}} Smoothed values.
   */
  function getSmoothed() {
    return { unison: smoothUnison, risk, views: JSON.parse(JSON.stringify(smoothViews)) };
  }

  /**
   * Mute or unmute one voice, for auditioning voices one at a time.
   * Safe to call before start(); the state is applied when the synths exist.
   * @param {string} name Voice name: fx, havens, commodity or contrarian.
   * @param {boolean} muted True to silence the voice.
   * @returns {void}
   */
  function setMute(name, muted) {
    for (const set of Object.values(styles)) {
      const voice = set[name];
      if (!voice) continue;
      voice.muted = muted;
      applyMute(voice);
    }
  }

  /**
   * Switch the style preset (default, classical, metal, phonk) at the next bar line.
   * Notes still sounding in the old preset are released.
   * Safe to call before start().
   * @param {string} name Preset name: "default", "classical", "metal" or "phonk".
   * @returns {void}
   */
  function setStyle(name) {
    if (!styles[name]) return;
    if (!built) {
      styleName = name;
      return;
    }
    buildStyle(name);
    // Switch at the next bar line, so a pattern never changes mid-bar.
    pendingStyle = name === styleName ? null : name;
  }

  /**
   * Release anything still sounding in a style (called when switching away).
   * @param {string} name Style name.
   * @returns {void}
   */
  function releaseStyle(name) {
    for (const voice of Object.values(styles[name])) {
      if (voice.synth.releaseAll) voice.synth.releaseAll();
      else if (voice.synth.triggerRelease && !(voice.synth instanceof Tone.PluckSynth)) voice.synth.triggerRelease();
    }
  }

  /**
   * Apply a voice's mute flag by moving its synth volume to silence or back to its base level.
   * (`synth.volume` is a Tone Param, which has no `mute` property of its own.)
   * @param {Object} voice One entry of `voices`.
   * @returns {void}
   */
  function applyMute(voice) {
    for (const synth of [voice.synth, ...Object.values(voice.drums || {})]) {
      if (!synth) continue;
      if (synth.baseVolume === undefined) synth.baseVolume = synth.volume.value;
      synth.volume.value = voice.muted ? -Infinity : synth.baseVolume;
    }
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

  /**
   * Duck the whole mix (or bring it back). Used while an approval card waits.
   * Safe to call before start().
   * @param {boolean} on True to duck, false to restore.
   * @returns {void}
   */
  function setDuck(on) {
    ducked = on;
    if (built) musicBus.gain.rampTo(on ? Tone.dbToGain(DUCK_DB - MASTER_DB) : 1, on ? 0.5 : UNDUCK_SECONDS);
  }

  /**
   * Hold the music still for a moment (smoothed values, contour and rebound
   * freeze; takeover and trust still apply). Used after a decision.
   * @param {number} seconds How long to hold.
   * @returns {void}
   */
  function hold(seconds) {
    holdUntil = Math.max(holdUntil, performance.now() + seconds * 1000);
  }

  return {
    start, setUnison, setRisk, setViews, setRebound, getSmoothed, getTrust, getTempo,
    sting, decision, hold, setMute, setRiskMute, setStyle, setDuck,
  };
})();
