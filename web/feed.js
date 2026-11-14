/**
 * Canary: message feed. Delivers bus messages (`view`, `decision`, `log`, ...)
 * to the page, from the relay over SSE or, when no relay is running, from a
 * recorded replay (web/mock/replay2020.js).
 *
 * Relay endpoints assumed here (to agree with Systems):
 *   GET  /events    SSE; each `data:` line is one bus message as JSON.
 *   POST /decision  {id, verdict, reason, action, market_date, seconds_to_decide}
 *   POST /control   {cmd, target}
 *
 * Exposes a single global: `Feed`.
 */
const Feed = (() => {
  /** Seconds of market time per replayed day (same as the tape's tick). */
  const TICK_MS = 2000;

  /** How long to wait for the relay before falling back to the recording. */
  const CONNECT_TIMEOUT_MS = 3000;

  /** @type {(msg: Object) => void} */
  let handler = () => {};

  /** @type {(mode: string, detail: string) => void} */
  let statusHandler = () => {};

  /** "connecting", "live", "relay-lost" or "mock". */
  let mode = "connecting";

  /** Mock replay state. */
  const mock = {
    index: 0, timer: null, hbTimer: null, paused: false, decided: new Set(), started: false, wanted: false,
    down: new Map(), // analyst -> Date.now() when killed
    degraded: new Set(),
  };

  /** Takeover ring and timing (DESIGN.md section 5), emulated by the mock. */
  const RING = ["fx", "havens", "commodity", "contrarian"];
  const GONE_MS = 3000;

  /**
   * Report a mode change to the page.
   * @param {string} next New mode.
   * @param {string} detail Human-readable detail.
   * @returns {void}
   */
  function setMode(next, detail) {
    mode = next;
    statusHandler(next, detail);
  }

  /**
   * Connect to the relay; fall back to the recording if it never answers.
   * Once live, a lost relay is reported but never swapped for the mock, so the
   * "kill the relay" demo shows the truth.
   * @param {(msg: Object) => void} onMessage Called with each bus message.
   * @param {(mode: string, detail: string) => void} onStatus Called on mode changes.
   * @returns {void}
   */
  function connect(onMessage, onStatus) {
    handler = onMessage;
    statusHandler = onStatus;
    const forceMock = location.protocol === "file:" || new URLSearchParams(location.search).has("mock");
    if (forceMock || typeof EventSource === "undefined") {
      useMock("no relay (opened as a file or ?mock)");
      return;
    }
    setMode("connecting", "connecting to relay...");
    let everConnected = false;
    const source = new EventSource("/events");
    const fallback = setTimeout(() => {
      if (!everConnected) {
        source.close();
        useMock("relay not answering");
      }
    }, CONNECT_TIMEOUT_MS);
    source.onopen = () => {
      everConnected = true;
      clearTimeout(fallback);
      setMode("live", "live from relay");
    };
    source.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.warn("Bad message from relay", event.data);
        return;
      }
      handler(msg);
    };
    source.onerror = () => {
      if (everConnected && source.readyState !== EventSource.CLOSED) {
        setMode("relay-lost", "relay lost, reconnecting (agents keep running)");
      }
    };
  }

  /**
   * Switch to the recorded replay. It starts when startMock() is called
   * (after the user starts audio), so music and replay begin together.
   * @param {string} why Reason shown on the page.
   * @returns {void}
   */
  function useMock(why) {
    if (!Array.isArray(window.MOCK_REPLAY)) {
      setMode("mock", `${why}; no recording found (run python web/mock/record.py)`);
      return;
    }
    setMode("mock", `${why}; playing recorded 2020 replay`);
    if (mock.wanted) startMock();
  }

  /**
   * Start or resume the recorded replay (no-op when live).
   * @returns {void}
   */
  function startMock() {
    mock.wanted = true;
    if (mode !== "mock" || mock.started || !Array.isArray(window.MOCK_REPLAY)) return;
    mock.started = true;
    mockStep();
    mock.timer = setInterval(mockStep, TICK_MS);
    mock.hbTimer = setInterval(mockHeartbeats, 500);
  }

  /**
   * The next live analyst after `slice` in the ring, or null if none.
   * @param {string} slice Slice whose owner is down.
   * @returns {string|null} The coverer.
   */
  function mockCoverer(slice) {
    const i = RING.indexOf(slice);
    for (let k = 1; k < RING.length; k += 1) {
      const c = RING[(i + k) % RING.length];
      if (!mock.down.has(c)) return c;
    }
    return null;
  }

  /**
   * True once a killed analyst has been silent long enough to be covered.
   * @param {string} name Analyst name.
   * @returns {boolean} True if gone.
   */
  function mockGone(name) {
    return mock.down.has(name) && Date.now() - mock.down.get(name) >= GONE_MS;
  }

  /**
   * Slices an analyst is covering right now.
   * @param {string} name Analyst name.
   * @returns {string[]} Covered slices.
   */
  function mockCovering(name) {
    return RING.filter((s) => mockGone(s) && mockCoverer(s) === name);
  }

  /**
   * Heartbeats from every analyst the mock has not killed (75% dropped when degraded).
   * @returns {void}
   */
  function mockHeartbeats() {
    const ts = Date.now() / 1000;
    for (const name of RING) {
      if (mock.down.has(name)) continue;
      if (mock.degraded.has(name) && Math.random() < 0.75) continue;
      handler({ type: "hb", agent: name, ts, covering: mockCovering(name) });
    }
  }

  /**
   * Rewrite a recorded day's views for killed or degraded analysts. A killed
   * analyst's slice disappears for GONE_MS, then is published by the next live
   * analyst in the ring. (Simplification: the coverer keeps the recorded
   * numbers; the real coverer would use its own temperament.)
   * @param {Object[]} views Recorded views.
   * @param {number} ts Timestamp to stamp.
   * @returns {Object[]} Views as the bus would carry them.
   */
  function mockViews(views, ts) {
    const out = [];
    for (const v of views) {
      if (mock.down.has(v.slice)) {
        const c = mockGone(v.slice) ? mockCoverer(v.slice) : null;
        if (c) out.push({ ...v, by: c, ts, reason: `Covering ${v.slice}. ${v.reason}` });
      } else if (!(mock.degraded.has(v.slice) && Math.random() < 0.75)) {
        out.push({ ...v, ts });
      }
    }
    return out;
  }

  /**
   * Emit the next recorded day, stamped with the current time. While an
   * escalation is open the replay holds on that day and repeats it, like the
   * live agents do until a decision arrives.
   * @returns {void}
   */
  function mockStep() {
    const days = window.MOCK_REPLAY;
    if (mock.index >= days.length) {
      clearInterval(mock.timer);
      handler({ type: "log", agent: "mock", text: "Replay finished." });
      return;
    }
    const day = days[mock.index];
    const ts = Date.now() / 1000;
    const msg = { ...day, ts, views: mockViews(day.views, ts) };
    msg.covering = RING.filter((s) => mockGone(s));
    if (msg.escalation && mock.decided.has(msg.escalation.id)) delete msg.escalation;
    handler(msg);
    if (!(msg.escalation || mock.paused)) mock.index += 1;
  }

  /**
   * POST JSON to the relay.
   * @param {string} path Endpoint path.
   * @param {Object} body Request body.
   * @returns {Promise<boolean>} True if the relay accepted it.
   */
  async function post(path, body) {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch (err) {
      console.warn(`POST ${path} failed`, err);
      return false;
    }
  }

  /**
   * Send a human decision. Live: the relay logs and broadcasts it. Mock: the
   * decision is echoed back locally as a `decision` message.
   * @param {{id: string, verdict: string, reason: string, action: string, market_date: string, seconds_to_decide: number}} decision
   * @returns {Promise<boolean>} True if delivered.
   */
  async function sendDecision(decision) {
    if (mode === "mock") {
      mock.decided.add(decision.id);
      console.info("decision (mock, not logged to disk)", decision);
      handler({ type: "decision", ...decision, decided_at: Date.now() / 1000 });
      return true;
    }
    return post("/decision", decision);
  }

  /**
   * Send a control command (play, pause, restart, kill, degrade, heal, revive).
   * The mock emulates all of them (kill/revive/degrade/heal per DESIGN.md timing).
   * @param {string} cmd Command name.
   * @param {string} [target] Analyst name, for kill/degrade/heal/revive.
   * @returns {Promise<boolean>} True if delivered.
   */
  async function sendControl(cmd, target = "") {
    if (mode === "mock") {
      if (cmd === "pause") mock.paused = true;
      if (cmd === "play") mock.paused = false;
      if (cmd === "restart") mock.index = 0;
      if (cmd === "kill" && target && !mock.down.has(target)) {
        mock.down.set(target, Date.now());
        mock.degraded.delete(target);
      }
      if (cmd === "revive") mock.down.delete(target);
      if (cmd === "degrade" && target) mock.degraded.add(target);
      if (cmd === "heal") mock.degraded.delete(target);
      if (!["pause", "play"].includes(cmd)) {
        handler({ type: "log", agent: "mock", text: `${cmd}${target ? " " + target : ""} (simulated in the mock)` });
      }
      return true;
    }
    return post("/control", { cmd, target });
  }

  return { connect, startMock, sendDecision, sendControl, get mode() { return mode; } };
})();
