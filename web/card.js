/**
 * Canary: the recommendation card. Shows one card per escalation id, collects a
 * named human decision (Accept, or Dismiss with a reason; sent to the relay as
 * "approve" / "veto") and hands it to the caller. Never decides anything itself
 * and never auto-accepts.
 *
 * Exposes a single global: `Card`.
 */
const Card = (() => {
  /** Display names for the analysts. */
  const NAMES = { fx: "FX", havens: "Havens", commodity: "Commodity", contrarian: "Contrarian" };

  /** Chip wording per vote. */
  const VOTE_TEXT = { support: "For", neutral: "Unsure", dissent: "Against" };

  /** Ids already decided (here or elsewhere); a repeat of these never reopens the card. */
  const decided = new Set();

  /** The open escalation, or null. */
  let open = null;

  /** performance.now() when the card opened, for the open-for timer. */
  let openedAt = 0;

  /** Interval handle for the open-for timer. */
  let timer = null;

  /** Callbacks set by init(). */
  let onDecide = async () => false;
  let onOpenChange = () => {};

  /**
   * Shorthand for getElementById.
   * @param {string} id Element id.
   * @returns {HTMLElement} The element.
   */
  function el(id) {
    return document.getElementById(id);
  }

  /**
   * Read the remembered name of the person deciding (best effort).
   * @returns {string} The name, or "".
   */
  function loadName() {
    try {
      return localStorage.getItem("canary-decider") || "";
    } catch (err) {
      return "";
    }
  }

  /**
   * Remember the name of the person deciding (best effort).
   * @param {string} name Name to keep.
   * @returns {void}
   */
  function saveName(name) {
    try {
      localStorage.setItem("canary-decider", name);
    } catch (err) {
      /* storage may be blocked; the card still works */
    }
  }

  /**
   * Wire the card's buttons.
   * @param {(decision: Object) => Promise<boolean>} decide Sends a decision; resolves true if delivered.
   * @param {(isOpen: boolean) => void} openChange Called when the card opens or closes.
   * @returns {void}
   */
  function init(decide, openChange) {
    onDecide = decide;
    onOpenChange = openChange;
    el("card-approve").addEventListener("click", () => submit("approve"));
    el("card-veto").addEventListener("click", () => submit("veto"));
    el("card-name").value = loadName();
  }

  /**
   * Build the vote chips with each analyst's one-line reason.
   * @param {Object[]} votes The escalation's votes.
   * @param {Object[]} views Latest views, to find each analyst's reason.
   * @returns {void}
   */
  function renderVotes(votes, views) {
    const list = el("card-votes");
    list.replaceChildren();
    for (const v of votes) {
      const view = views.find((x) => x.slice === v.slice);
      const row = document.createElement("li");
      const chip = document.createElement("span");
      chip.className = `chip ${v.vote}`;
      chip.textContent = VOTE_TEXT[v.vote] || v.vote;
      const who = document.createElement("strong");
      who.textContent = NAMES[v.by] || v.by;
      const line = document.createElement("span");
      line.className = "line";
      line.textContent = view && view.reason ? view.reason : "";
      row.append(chip, who, line);
      list.append(row);
    }
    const count = (kind) => votes.filter((v) => v.vote === kind).length;
    const unsure = count("neutral");
    el("card-tally").textContent =
      `${count("support")} for, ${count("dissent")} against` + (unsure ? `, ${unsure} unsure` : "");
  }

  /**
   * Format a market date for people, e.g. "Mon 2 Mar 2020".
   * @param {string} iso "YYYY-MM-DD".
   * @returns {string} Readable date.
   */
  function niceDate(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  }

  /**
   * The reasons behind the risk score, in plain words.
   * @param {Object} escalation Escalation; `why` holds divergence, unison and drawdown.
   * @returns {string[]} One sentence per reason.
   */
  function whyLines(escalation) {
    const why = escalation.why;
    const days = /for (\d+) days/.exec(escalation.rule || "");
    const lines = [days ? `Risk has been over the limit for ${days[1]} trading days in a row.` : "Risk is over the limit."];
    if (!why) return lines;
    if (why.divergence >= why.unison) {
      lines.push(`The analysts disagree sharply about where things are heading (divergence ${why.divergence.toFixed(2)}).`);
    } else {
      lines.push(`Currencies are moving together against the dollar (unison ${why.unison.toFixed(2)}).`);
    }
    const fall = -why.drawdown * 100;
    if (fall > 0.05) lines.push(`Commodity currencies, usually the first to fall in a panic, are ${fall.toFixed(1)}% below their peak.`);
    return lines;
  }

  /**
   * How the code worked out the risk score, in one line (the card's "Decided by code" proof).
   * @param {Object} escalation Escalation; `why` holds divergence, unison and drawdown.
   * @returns {string} e.g. "Risk 0.64 = 0.8 × max(divergence 0.67, unison 0.31) + 0.2 × (basket down 5.2% ÷ 10%)".
   */
  function workingText(escalation) {
    const why = escalation.why;
    const risk = escalation.risk.toFixed(2);
    if (!why) return `Risk ${risk}`;
    const fall = -why.drawdown;
    const raw = 0.8 * Math.max(why.divergence, why.unison) + 0.2 * (fall / 0.1);
    const capped = raw > 1 ? ", capped at 1" : "";
    return (
      `Risk ${risk} = 0.8 × max(divergence ${why.divergence.toFixed(2)}, unison ${why.unison.toFixed(2)})` +
      ` + 0.2 × (basket down ${(fall * 100).toFixed(1)}% ÷ 10%)${capped}`
    );
  }

  /**
   * Show the card for an escalation, once per id.
   * @param {Object} escalation Escalation from a `view` message.
   * @param {Object[]} views The views in the same message (for the AI one-liners).
   * @returns {void}
   */
  function show(escalation, views) {
    if (!escalation || decided.has(escalation.id)) return;
    if (open) {
      if (open.id === escalation.id) renderVotes(escalation.votes, views);
      return;
    }
    open = escalation;
    openedAt = performance.now();
    el("card-action").textContent = "RECOMMENDATION";
    el("card-explain").textContent = `Risk is high. Recommended: ${escalation.action}`;
    el("card-date").textContent = niceDate(escalation.date);
    el("card-risk").textContent = escalation.risk.toFixed(2);
    el("card-risk-fill").style.width = `${Math.round(Math.min(1, escalation.risk) * 100)}%`;
    el("card-why").replaceChildren(
      ...whyLines(escalation).map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
    el("card-rule").textContent = `Rule: ${escalation.rule}. Proposed action: ${escalation.action}.`;
    el("card-numbers").textContent = workingText(escalation);
    el("card-approve").textContent = "Accept";
    el("card-veto").textContent = "Dismiss";
    renderVotes(escalation.votes, views);
    el("card-reason").value = "";
    el("card-error").textContent = "";
    el("card-open-for").textContent = "waiting 0s";
    el("card").hidden = false;
    clearInterval(timer);
    timer = setInterval(() => {
      el("card-open-for").textContent = `waiting ${Math.round((performance.now() - openedAt) / 1000)}s`;
    }, 500);
    // Focus the panel, not a text field, so the presenter's K / R keys still work while a judge reads.
    document.querySelector("#card .panel").focus();
    onOpenChange(true);
  }

  /**
   * Close the card without a local decision (someone else decided).
   * @param {string} id Escalation id that was decided.
   * @returns {void}
   */
  function decidedElsewhere(id) {
    decided.add(id);
    if (open && open.id === id) close();
  }

  /**
   * Hide the card and clear its state.
   * @returns {void}
   */
  function close() {
    open = null;
    clearInterval(timer);
    el("card").hidden = true;
    onOpenChange(false);
  }

  /**
   * Validate and send the decision.
   * @param {"approve"|"veto"} verdict The button pressed.
   * @returns {Promise<void>}
   */
  async function submit(verdict) {
    if (!open) return;
    const name = el("card-name").value.trim();
    const reason = el("card-reason").value.trim();
    const error = el("card-error");
    if (!name) {
      error.textContent = "Add your name first. Every decision is signed by a person.";
      el("card-name").focus();
      return;
    }
    if (verdict === "veto" && !reason) {
      error.textContent = "Say why you are dismissing it, in a few words.";
      el("card-reason").focus();
      return;
    }
    saveName(name);
    const escalation = open;
    el("card-approve").disabled = el("card-veto").disabled = true;
    const ok = await onDecide({
      id: escalation.id,
      verdict,
      reason,
      action: escalation.action,
      market_date: escalation.date,
      seconds_to_decide: Math.round((performance.now() - openedAt) / 100) / 10,
      by: name, // the relay reads "by" (canary/relay.py)
    });
    el("card-approve").disabled = el("card-veto").disabled = false;
    if (ok !== true) {
      error.textContent = typeof ok === "string" ? ok : "Could not reach the relay. Try again.";
      return;
    }
    decided.add(escalation.id);
    close();
  }

  /**
   * A new replay started: close any open card and forget past decisions,
   * so the same card can be shown again after a restart.
   * @returns {void}
   */
  function reset() {
    if (open) close();
    decided.clear();
  }

  return { init, show, decidedElsewhere, reset, get isOpen() { return open !== null; } };
})();
