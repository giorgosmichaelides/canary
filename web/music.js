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

  /** Tempo in beats per minute at risk 0. Tempo rises with risk, like a Geiger counter. */
  const BPM = 80;

  /** Maximum swing at unison 0 (a light shuffle), easing to 0 as unison rises. */
  const MAX_SWING = 0.12;

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
  const MAX_BPM = 160;

  /** Seconds each tempo change glides over (on top of the risk smoothing). */
  const TEMPO_GLIDE = 0.5;

  /**
   * Geiger tick layer: random clicks (a Poisson process, like radiation counts)
   * whose rate and level rise with risk. Runs on its own clock, not the beat.
   * Rate slides exponentially from GEIGER_MIN_RATE to GEIGER_MAX_RATE ticks/s,
   * level from GEIGER_MIN_DB to GEIGER_MAX_DB.
   */
  const GEIGER_MIN_RATE = 1;
  const GEIGER_MAX_RATE = 14;
  const GEIGER_MIN_DB = -34;
  const GEIGER_MAX_DB = -16;
  /** Shortest gap between two ticks (s), so bursts stay audible as separate clicks. */
  const GEIGER_MIN_GAP = 0.012;
  /** How far ahead (s) ticks are scheduled, and how often (ms) the scheduler runs. */
  const GEIGER_LOOKAHEAD = 0.15;
  const GEIGER_INTERVAL_MS = 40;

  /** Geiger tick synth and its output gain (ducks with the card), built in build(). */
  let geigerSynth = null;
  let geigerGain = null;
  /** Audio-clock time of the next scheduled tick. */
  let geigerNext = 0;

  /** Unison at or above which the voices have "arrived": swing 0 and a big shared D on every downbeat. */
  const ARRIVAL = 0.95;

  /** MIDI notes of the arrival stack: D in four octaves (D2 to D5; nothing below laptop-speaker range). */
  const ARRIVAL_MIDIS = [38, 50, 62, 74];

  /** Master level in dB, normal and ducked (while an approval card is open). */
  const MASTER_DB = -6;
  const DUCK_DB = -20;

  /** Volume slider position (0..1) that gives exactly MASTER_DB; above it adds up to ~2.5 dB. */
  const VOLUME_NORMAL = 0.75;

  /** Volume slider position, kept so it applies even before audio starts. */
  let volume = VOLUME_NORMAL;

  /** True while the music is ducked under the approval card. */
  let ducked = false;

  /** Thick shared synth that adds the arrival hit, built in build(). */
  let arrivalSynth = null;

  /** Dread layers driven by risk, built in build(): tritone drone and brown-noise rumble. */
  let tritoneGain = null;
  let rumbleGain = null;

  /** Cue sounds for an analyst going down or coming back, and where each analyst sits in the stereo field. */
  let cueSynth = null;
  let cuePanner = null;
  const PAN = { fx: 0, havens: 0, commodity: 0.5, contrarian: -0.5 };

  /** Drone gain node and click synth, built in build(). */
  let droneGain = null;
  let clickSynth = null;

  /** True once the synths and sequencer have been built. */
  let built = false;

  /**
   * Map risk to tempo, rising linearly from BPM at 0 to MAX_BPM at 1.
   * @param {number} r Risk, 0..1.
   * @returns {number} Beats per minute.
   */
  function riskToBpm(r) {
    return BPM + (MAX_BPM - BPM) * r;
  }

  /**
   * Geiger tick rate for a risk level (exponential, so each step of risk
   * multiplies the rate: 1/s calm, ~3.7/s at 0.5, 14/s at 1 by default).
   * @param {number} r Risk, 0..1.
   * @returns {number} Ticks per second.
   */
  function geigerRate(r) {
    return GEIGER_MIN_RATE * (GEIGER_MAX_RATE / GEIGER_MIN_RATE) ** r;
  }

  /**
   * Schedule Geiger ticks for the next GEIGER_LOOKAHEAD seconds. Gaps are
   * exponentially distributed (random, like radiation counts) at the current
   * rate; level and rate follow smoothed risk. Silent while muted or stopped.
   * @returns {void}
   */
  function geigerSchedule() {
    if (!built || !geigerSynth) return;
    const now = Tone.now();
    if (riskMuted || Tone.Transport.state !== "started") {
      geigerNext = now;
      return;
    }
    // After a stall (hidden tab, paused audio) don't fire a backlog of ticks.
    if (geigerNext < now) geigerNext = now + 0.01;
    const rate = geigerRate(risk);
    const db = GEIGER_MIN_DB + (GEIGER_MAX_DB - GEIGER_MIN_DB) * risk;
    while (geigerNext < now + GEIGER_LOOKAHEAD) {
      // Each click a little louder or softer than the last, like real counts.
      const velocity = Tone.dbToGain(db + (Math.random() - 0.5) * 6);
      geigerSynth.triggerAttackRelease(0.004, geigerNext, Math.min(1, velocity));
      geigerNext += Math.max(GEIGER_MIN_GAP, -Math.log(1 - Math.random()) / rate);
    }
  }
  setInterval(geigerSchedule, GEIGER_INTERVAL_MS);

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
    droneGain.gain.rampTo(riskMuted ? 0 : 0.14 * stress ** 2, 0.1);
    Tone.Transport.bpm.rampTo(riskToBpm(risk), TEMPO_GLIDE);

    // Ominous layers. Each is silent in calm markets and grows as risk climbs.
    // Tritone (G#2 against the D drone): enters around risk 0.3, swells to full.
    const dread = Math.max(0, (risk - 0.3) / 0.7);
    tritoneGain.gain.rampTo(riskMuted ? 0 : 0.08 * Math.max(dread, stress) ** 2, 0.1);
    // Sub rumble (filtered brown noise): rises from risk 0.2.
    rumbleGain.gain.rampTo(riskMuted ? 0 : 0.12 * Math.max(0, (risk - 0.2) / 0.8) ** 2, 0.1);
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
    for (const [name, voice] of Object.entries(voices)) {
      if (!voice.dry) continue;
      const t = instrumentTrust(name);
      voice.dry.gain.rampTo(0.2 + 0.8 * t, 0.1);
      voice.send.gain.rampTo(0.9 * (1 - t), 0.1);
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
   * The four voices: gliding 808 with kick, a wobbly tape pad, the pitched cowbell
   * riff with a half-time clap, and a gritty lead over trap hats. Drums belong
   * to an analyst (kick: fx, clap: commodity, hats: contrarian), so they follow
   * its convergence and mute, and drop out when it is covered. Each voice has:
   * - rootMidi: its own register
   * - rhythm: sixteenth steps (0-15) where it plays at unison 0
   * - melody: scale degree per step at unison 0
   * - thresholds: per-step unison level at which the step snaps to the floor
   * - synth: built in buildVoices()
   * - play(time, degree, onOwnRhythm, step): trigger one event
   * @type {Object<string, Object>}
   */
  const voices = {
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
   * Create the four voices' synths.
   * @returns {void}
   */
  function buildVoices() {
    const room = new Tone.Reverb({ decay: 2, wet: 0.2 }).connect(musicBus);

    // fx 808: sine with glide, saturated, low-passed; kick on every hit.
    wire(voices.fx, new Tone.MonoSynth({
      portamento: 0.06,
      oscillator: { type: "sine" },
      envelope: { attack: 0.005, decay: 1.2, sustain: 0.4, release: 0.3 },
      filter: { type: "lowpass", Q: 0.5 },
      filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 1, baseFrequency: 900, octaves: 0 },
    // Level is set after the distortion: the synth volume only changes how hard it drives it.
    }), new Tone.Distortion(0.4).connect(new Tone.Filter(900, "lowpass").connect(new Tone.Gain(Tone.dbToGain(-7)).connect(musicBus))));
    voices.fx.synth.volume.value = -6;
    voices.fx.drums = {
      kick: drum(voices.fx, new Tone.MembraneSynth({
        pitchDecay: 0.05, octaves: 4, envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.05 },
      })),
    };
    voices.fx.drums.kick.volume.value = -10;

    // havens tape pad: detuned saws through a band-pass with a slow, deep wobble.
    const wobble = new Tone.Vibrato({ frequency: 0.6, depth: 0.25 }).connect(room);
    wire(voices.havens, new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 2, spread: 20 },
      envelope: { attack: 0.6, decay: 0.4, sustain: 0.7, release: 2 },
    }), new Tone.Filter({ type: "lowpass", frequency: 1100, Q: 0.7 }).connect(wobble));
    voices.havens.synth.volume.value = -8;

    // commodity cowbell: short square through a band-pass, right; clap.
    wire(voices.commodity, new Tone.Synth({
      oscillator: { type: "square" },
      envelope: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.1 },
    }), new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 0.9 }).connect(new Tone.Panner(0.5).connect(room)));
    voices.commodity.synth.volume.value = 4;
    voices.commodity.drums = {
      clap: drum(voices.commodity, new Tone.NoiseSynth({
        noise: { type: "pink" }, envelope: { attack: 0.002, decay: 0.22, sustain: 0 },
      })),
    };
    voices.commodity.drums.clap.volume.value = -4;

    // contrarian lead: band-passed driven saw, left; hi-hats.
    wire(voices.contrarian, new Tone.Synth({
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.2 },
    }), new Tone.Filter({ type: "bandpass", frequency: 2400, Q: 1.2 }).connect(new Tone.Distortion(0.5).connect(new Tone.Panner(-0.5).connect(room))));
    voices.contrarian.synth.volume.value = -7;
    const hatOut = new Tone.Filter(7000, "highpass");
    hatOut.connect(voices.contrarian.dry);
    const hat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.04, sustain: 0 } }).connect(hatOut);
    hat.volume.value = -14;
    voices.contrarian.drums = { hat };
  }

  /**
   * Create the four synths and the shared effects.
   * @returns {void}
   */
  function build() {
    // Master safety: headroom plus a limiter so stacked voices cannot clip the output.
    applyVolume();
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

    buildVoices();

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
    clickSynth.volume.value = -20;

    // Geiger ticks: tiny white-noise bursts through a band-pass, straight to the
    // output (not through the calm low-pass, which would swallow them) but ducked
    // with the card via geigerGain.
    geigerGain = new Tone.Gain(ducked ? Tone.dbToGain(DUCK_DB - MASTER_DB) : 1).toDestination();
    geigerSynth = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.0005, decay: 0.004, sustain: 0, release: 0.003 },
    }).connect(new Tone.Filter({ frequency: 3500, type: "bandpass", Q: 1.2 }).connect(geigerGain));
    geigerNext = Tone.now();

    // Cues go straight to the output, so the calm low-pass and the card's duck never hide them.
    cuePanner = new Tone.Panner(0).toDestination();
    cueSynth = new Tone.Synth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.15 },
    }).connect(cuePanner);
    cueSynth.volume.value = -10;
    applyRisk();

    // Re-apply any mutes set from the page before the synths existed.
    for (const voice of Object.values(voices)) applyMute(voice);

    let step = 0;
    Tone.Transport.bpm.value = riskToBpm(risk);
    Tone.Transport.swingSubdivision = "8n";
    unison = smoothUnison;
    Tone.Transport.scheduleRepeat((time) => {
      if (step === 0) {
        // Bar line: the only place patterns may change (convergence, swing, arrival).
        unison = smoothUnison;
        Tone.Transport.swing = unison >= ARRIVAL ? 0 : MAX_SWING * (1 - unison);
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
      for (const sl of SLICES) {
        const pattern = voices[sl];
        const instrument = voices[barBy[sl]] || pattern;
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
   * Drives drone gain, click level, Geiger tick rate and tempo (80 bpm at 0 up to 160 at 1).
   * @param {number} value Risk, clamped to 0..1.
   * @returns {void}
   */
  function setRisk(value) {
    if (!Number.isFinite(value)) return;
    target.risk = Math.min(1, Math.max(0, value));
  }

  /**
   * A falling sweep from where the analyst sits in the mix: it has gone silent.
   * @param {string} name Analyst name.
   * @returns {void}
   */
  function analystDown(name) {
    if (!built) return;
    const t = Tone.now() + 0.05;
    cuePanner.pan.setValueAtTime(PAN[name] ?? 0, t);
    cueSynth.triggerAttack(880, t, 0.9);
    cueSynth.frequency.exponentialRampToValueAtTime(90, t + 0.7);
    cueSynth.triggerRelease(t + 0.7);
  }

  /**
   * A short rising blip: the analyst is back (its part returns at the next bar line).
   * @param {string} name Analyst name.
   * @returns {void}
   */
  function analystBack(name) {
    if (!built) return;
    const t = Tone.now() + 0.05;
    cuePanner.pan.setValueAtTime(PAN[name] ?? 0, t);
    cueSynth.triggerAttack(330, t, 0.7);
    cueSynth.frequency.exponentialRampToValueAtTime(990, t + 0.18);
    cueSynth.triggerRelease(t + 0.22);
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
    if (!built) return;
    const level = on ? Tone.dbToGain(DUCK_DB - MASTER_DB) : 1;
    musicBus.gain.rampTo(level, on ? 0.5 : UNDUCK_SECONDS);
    geigerGain.gain.rampTo(level, on ? 0.5 : UNDUCK_SECONDS);
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

  /**
   * Push the volume setting to the master output (everything, including stings
   * and the Geiger ticks, goes through it). Zero mutes.
   * @returns {void}
   */
  function applyVolume() {
    if (typeof Tone === "undefined") return;
    Tone.Destination.mute = volume <= 0;
    Tone.Destination.volume.value = volume <= 0 ? MASTER_DB : MASTER_DB + 20 * Math.log10(volume / VOLUME_NORMAL);
  }

  /**
   * Set the master volume. Safe to call before start().
   * @param {number} value Slider position, 0 (mute) to 1; 0.75 is the original level.
   * @returns {void}
   */
  function setVolume(value) {
    if (!Number.isFinite(value)) return;
    volume = Math.min(1, Math.max(0, value));
    if (built) applyVolume();
  }

  return {
    start, setUnison, setRisk, setViews, setRebound, getSmoothed, getTrust, getTempo,
    sting, decision, hold, setMute, setRiskMute, setDuck, setVolume, analystDown, analystBack,
  };
})();
