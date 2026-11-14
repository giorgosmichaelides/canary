"""An analyst: forms its view each day, shares it, and covers for silent neighbours.

Four copies run, one per analyst (fx, havens, commodity, contrarian). Each one,
entirely on its own:

* sends a heartbeat every 0.5 s, whether or not the tape is playing;
* on every tick, forms a view of its own slice (and any slice it is covering)
  with Quant's pure functions and broadcasts it straight away;
* 250 ms later, once the peers' views for the day have arrived, works out the
  risk score from its own book, applies the escalation rule and broadcasts
  again with the new risk and any card;
* treats a neighbour that has been silent for 3 s as gone and covers its
  slice, then hands it back as soon as the neighbour's heartbeat returns.

Nothing here waits on a peer or on Claude, and every number comes from
signals.py and views.py, so with everyone alive the live numbers match
``python -m canary.sim``.

Usage:
    python -m canary.agent --name fx
    python -m canary.agent --name havens --transport ports
"""

from __future__ import annotations

import argparse
import os
import time
from typing import Any, Optional, cast

from canary.bus import Bus, make_bus
from canary.explain import load_reasons, reason
from canary.signals import (
    CORRELATION_WINDOW,
    RISK_BASKET,
    basket,
    divergence,
    drawdown,
    mean_correlation,
    returns,
    risk_score,
    unison,
)
from canary.sim import CURRENCIES, MIN_HISTORY, REPLAYS, Replay, run
from canary.tape import load_tape
from canary.views import (
    Escalation,
    EscalationState,
    View,
    check_escalation,
    contrarian_view,
    escalation,
    rebound,
    slice_view,
)

RING = ("fx", "havens", "commodity", "contrarian")

HEARTBEAT_EVERY = 0.5
GONE_AFTER = 3.0
STARTUP_GRACE = 4.0
RISK_DELAY = 0.25
TRUST_FULL_FOR = 1.0
TRUST_HALF_LIFE = 0.8
DEGRADE_DROP = 0.75
RESEND_CARD_EVERY = 1.0

Prices = dict[str, list[float]]
Entry = dict[str, Any]


def trust(age: float) -> float:
    """How much to trust a view, given how old the newest view of its slice is.

    Args:
        age: Seconds since that view was made.

    Returns:
        1.0 for the first second, then halving every 0.8 s.
    """
    if age <= TRUST_FULL_FOR:
        return 1.0
    return float(0.5 ** ((age - TRUST_FULL_FOR) / TRUST_HALF_LIFE))


def coverer(slice_name: str, alive: set[str]) -> Optional[str]:
    """Who plays a slice: its owner if alive, else the next live analyst in the ring.

    The ring is fx -> havens -> commodity -> contrarian -> fx. Every agent
    runs this on its own heartbeat table and they all get the same answer,
    so nobody has to vote.

    Args:
        slice_name: The slice, e.g. "fx".
        alive: Analysts currently considered alive.

    Returns:
        The analyst that should play it, or None if nobody is alive.
    """
    start = RING.index(slice_name)
    for step in range(len(RING)):
        candidate = RING[(start + step) % len(RING)]
        if candidate in alive:
            return candidate
    return None


def slices_to_cover(me: str, alive: set[str]) -> list[str]:
    """The other analysts' slices this analyst should play right now.

    Args:
        me: This analyst.
        alive: Analysts currently considered alive.

    Returns:
        Slice names in ring order, empty when everyone is alive.
    """
    return [s for s in RING if s != me and coverer(s, alive) == me]


def alive_analysts(
    me: str, last_heard: dict[str, float], now: float, started: float
) -> tuple[set[str], bool]:
    """Work out who is alive from this analyst's own heartbeat table.

    Two safety rules: nobody is declared gone during the first 4 s (so we
    don't all cover each other at launch), and if we can't hear anyone at all
    we assume our own link is down and take over nothing.

    Args:
        me: This analyst.
        last_heard: Analyst -> monotonic time we last heard from it.
        now: Current monotonic time.
        started: Monotonic time this analyst started.

    Returns:
        The analysts to treat as alive, and True if this analyst is isolated.
    """
    if now - started < STARTUP_GRACE:
        return set(RING), False
    heard = {
        a
        for a, t in last_heard.items()
        if a in RING and a != me and now - t < GONE_AFTER
    }
    if not heard:
        return set(RING), True
    return heard | {me}, False


def history(
    dates: list[str], prices: Prices, replay: Replay, date: str
) -> Optional[Prices]:
    """The prices an analyst may look at on a given day, exactly as canary.sim sees them.

    Args:
        dates: Every date in the price file, oldest first.
        prices: Currency -> prices on those dates.
        replay: The replay being played.
        date: Today's market date.

    Returns:
        Currency -> prices from the replay's history start up to and
        including today, or None if there isn't enough history yet.
    """
    keep = [i for i, d in enumerate(dates) if replay.history_start <= d <= date]
    if len(keep) < MIN_HISTORY or dates[keep[-1]] != date:
        return None
    return {c: [prices[c][i] for i in keep] for c in CURRENCIES}


def form_view(me: str, slice_name: str, prices: Prices) -> View:
    """This analyst's view of a slice, using its own temperament.

    Args:
        me: The analyst forming the view.
        slice_name: Its own slice or one it is covering.
        prices: Output of history().

    Returns:
        The view from views.py.
    """
    if me == "contrarian":
        return contrarian_view(slice_name, prices)
    return slice_view(slice_name, me, prices)


def correlation_unison(prices: Prices) -> float:
    """How merged the music should be today.

    Args:
        prices: Output of history().

    Returns:
        Unison, 0..1, from the 10-day mean correlation of all 7 currencies.
    """
    recent = {c: returns(prices[c][-(CORRELATION_WINDOW + 1) :]) for c in CURRENCIES}
    return unison(mean_correlation(recent))


def day_risk(book: dict[str, Entry], prices: Prices, now: float) -> float:
    """Today's risk score from this analyst's own book.

    Havens and commodity stances are weighted by how fresh their newest views
    are, so a silent slice counts for less.

    Args:
        book: Slice -> newest view entry (with "ts").
        prices: Output of history().
        now: Current wall-clock time, to age the views.

    Returns:
        Risk, 0..1.
    """

    def stance_and_trust(slice_name: str) -> tuple[float, float]:
        entry = book.get(slice_name)
        if entry is None:
            return 0.0, 0.0
        return float(entry["stance"]), trust(now - float(entry["ts"]))

    havens_stance, havens_trust = stance_and_trust("havens")
    commodity_stance, commodity_trust = stance_and_trust("commodity")
    div = divergence(havens_stance, havens_trust, commodity_stance, commodity_trust)
    fall = drawdown(basket({c: prices[c] for c in RISK_BASKET}))
    return risk_score(div, correlation_unison(prices), fall)


def warm_states(
    replay: Replay, dates: list[str], prices: Prices
) -> dict[str, EscalationState]:
    """The escalation rule's memory on the morning of each day, with everyone alive.

    Used when an agent starts, restarts or is revived mid-replay, so it
    remembers earlier cards (e.g. the 31 Jan false alarm) the same way
    canary.sim does.

    Args:
        replay: The replay.
        dates: Every date in the price file.
        prices: Currency -> prices on those dates.

    Returns:
        Date -> escalation state before that day's risk is applied.
    """
    states: dict[str, EscalationState] = {}
    state = EscalationState()
    for day in run(replay, dates, prices):
        states[day.date] = state
        state, _ = check_escalation(state, day.risk)
    return states


class Analyst:
    """One analyst process: its book, heartbeat table, coverage and escalations."""

    def __init__(self, name: str, bus: Bus) -> None:
        """Load prices and cached reason lines and get ready.

        Args:
            name: One of RING.
            bus: A bus from canary.bus.make_bus.
        """
        self.name = name
        self.bus = bus
        self.dates, self.prices, _ = load_tape(REPLAYS["2020"])
        self.reasons = load_reasons()
        self.started = time.monotonic()

        self.last_heard: dict[str, float] = {}
        self.book: dict[str, Entry] = {}
        self.covering: list[str] = []
        self.isolated = False

        self.warm: dict[str, dict[str, EscalationState]] = {}
        self.state = EscalationState()
        self.last_day: Optional[tuple[str, int]] = None
        self.open: dict[str, Escalation] = {}
        self.decided: set[str] = set()

        self.today: Optional[dict[str, Any]] = None
        self.risk = 0.0
        self.risk_due: Optional[float] = None
        self.last_view: Optional[dict[str, Any]] = None
        self.next_heartbeat = 0.0
        self.next_resend = 0.0

    def log(self, text: str) -> None:
        """Print a line and put it in the desk log.

        Args:
            text: What happened.
        """
        print(f"{self.name}: {text}", flush=True)
        self.bus.send({"type": "log", "agent": self.name, "text": text})

    def run(self) -> None:
        """Main loop: listen, heartbeat, finish each day. Runs until killed."""
        self.log("up")
        while True:
            now = time.monotonic()
            deadlines = [self.next_heartbeat]
            if self.risk_due is not None:
                deadlines.append(self.risk_due)
            if self.open and self.last_view is not None:
                deadlines.append(self.next_resend)
            msg = self.bus.recv(timeout=max(0.0, min(deadlines) - now))
            if msg is not None:
                self.handle(msg)

            now = time.monotonic()
            if now >= self.next_heartbeat:
                self.update_cover(now)
                self.heartbeat()
                self.next_heartbeat = now + HEARTBEAT_EVERY
            if self.risk_due is not None and now >= self.risk_due:
                self.finish_day()
            if self.open and self.last_view is not None and now >= self.next_resend:
                self.resend_card()

    def handle(self, msg: dict[str, Any]) -> None:
        """Route one message from the bus.

        Args:
            msg: Any message.
        """
        kind = msg.get("type")
        sender = msg.get("agent")
        if kind == "tick":
            self.on_tick(msg)
        elif kind == "control":
            self.on_control(msg)
        elif kind == "decision":
            card_id = str(msg.get("id"))
            self.decided.add(card_id)
            if self.open.pop(card_id, None) is not None:
                self.log(f"decision on {card_id}: {msg.get('verdict')}")
        elif sender in RING and sender != self.name and kind in ("hb", "view"):
            self.last_heard[str(sender)] = time.monotonic()
            if kind == "view":
                self.on_peer_view(msg)

    def on_peer_view(self, msg: dict[str, Any]) -> None:
        """Keep the newest view of each slice, and pick up cards we missed.

        Args:
            msg: A view message from another analyst.
        """
        for entry in msg.get("views", []):
            current = self.book.get(entry["slice"])
            if current is None or entry["ts"] > current["ts"]:
                self.book[entry["slice"]] = entry
        card = msg.get("escalation")
        if card and card["id"] not in self.decided and card["id"] not in self.open:
            self.open[card["id"]] = cast(Escalation, card)

    def on_tick(self, msg: dict[str, Any]) -> None:
        """A new day: form views now, finish the risk score 250 ms later.

        Args:
            msg: The tick from the tape.
        """
        if self.risk_due is not None:
            self.finish_day()
        replay = REPLAYS.get(str(msg.get("replay")))
        date = str(msg.get("date"))
        i = int(msg.get("i", 0))
        prices = history(self.dates, self.prices, replay, date) if replay else None
        if replay is None or prices is None:
            self.log(f"no price history for {date}, skipping")
            return

        if self.last_day != (replay.name, i - 1):
            if self.last_day is not None and (
                self.last_day[0] != replay.name or i <= self.last_day[1]
            ):
                self.open.clear()
                self.decided.clear()
            self.state = self.warm_state(replay, date)
        self.last_day = (replay.name, i)

        self.update_cover(time.monotonic())
        self.today = {
            "replay": replay,
            "date": date,
            "prices": prices,
            "unison": correlation_unison(prices),
            "rebound": rebound(prices),
            "views": [],
        }
        for slice_name in [self.name, *self.covering]:
            self.add_view(slice_name)
        self.send_view()
        self.risk_due = time.monotonic() + RISK_DELAY

    def add_view(self, slice_name: str) -> None:
        """Form today's view of one slice and put it in the book.

        Args:
            slice_name: Own slice or one being covered.
        """
        assert self.today is not None
        view = form_view(self.name, slice_name, self.today["prices"])
        entry: Entry = {
            **view,
            "ts": time.time(),
            "reason": reason(view, self.today["date"], self.reasons),
        }
        self.today["views"].append(entry)
        self.book[slice_name] = entry

    def finish_day(self) -> None:
        """Work out today's risk, apply the escalation rule, broadcast again."""
        self.risk_due = None
        if self.today is None:
            return
        replay: Replay = self.today["replay"]
        date: str = self.today["date"]
        self.risk = day_risk(self.book, self.today["prices"], time.time())
        self.state, fires = check_escalation(self.state, self.risk)
        if fires:
            views = [cast(View, self.book[s]) for s in RING if s in self.book]
            try:
                card = escalation(replay.name, date, self.risk, views)
            except ValueError:
                card = None
            if card is not None and card["id"] not in self.decided:
                self.open[card["id"]] = card
                self.log(f"escalation {card['id']}: {card['action']}")
        print(
            f"{self.name}: {date} risk {self.risk:.2f} unison {self.today['unison']:.2f}"
            + (f" covering {','.join(self.covering)}" if self.covering else ""),
            flush=True,
        )
        self.send_view()

    def send_view(self) -> None:
        """Broadcast today's views with the latest risk and the oldest open card."""
        if self.today is None:
            return
        msg: dict[str, Any] = {
            "type": "view",
            "agent": self.name,
            "ts": time.time(),
            "date": self.today["date"],
            "covering": list(self.covering),
            "risk": self.risk,
            "unison": self.today["unison"],
            "rebound": self.today["rebound"],
            "views": self.today["views"],
        }
        if self.open:
            msg["escalation"] = next(iter(self.open.values()))
        self.bus.send(msg)
        self.last_view = msg
        self.next_resend = time.monotonic() + RESEND_CARD_EVERY

    def resend_card(self) -> None:
        """Repeat the last view while a card is open.

        The tape is paused while a card waits for a decision, so without this
        a browser that reloads would never see the card again.
        """
        assert self.last_view is not None
        msg = dict(self.last_view)
        msg["escalation"] = next(iter(self.open.values()))
        self.bus.send(msg)
        self.next_resend = time.monotonic() + RESEND_CARD_EVERY

    def update_cover(self, now: float) -> None:
        """Recompute who is alive and which slices to cover, and log any change.

        A slice taken over mid-day gets a view straight away, so the takeover
        is heard without waiting for the next tick.

        Args:
            now: Current monotonic time.
        """
        alive, isolated = alive_analysts(self.name, self.last_heard, now, self.started)
        if isolated != self.isolated:
            self.isolated = isolated
            self.log(
                "can't hear anyone, assuming my own link is down"
                if isolated
                else "can hear peers again"
            )
        wanted = slices_to_cover(self.name, alive)
        if wanted == self.covering:
            return
        added = [s for s in wanted if s not in self.covering]
        dropped = [s for s in self.covering if s not in wanted]
        self.covering = wanted
        for s in dropped:
            self.log(f"{s} is back, handing its slice back")
        for s in added:
            self.log(f"{s} went quiet, covering its slice")
        if self.today is not None:
            self.today["views"] = [
                v for v in self.today["views"] if v["slice"] not in dropped
            ]
        if added and self.today is not None:
            for s in added:
                self.add_view(s)
            self.send_view()

    def heartbeat(self) -> None:
        """Tell everyone we are alive and what we are covering."""
        self.bus.send(
            {
                "type": "hb",
                "agent": self.name,
                "ts": time.time(),
                "covering": list(self.covering),
                "isolated": self.isolated,
            }
        )

    def on_control(self, msg: dict[str, Any]) -> None:
        """Obey kill, degrade and heal when they are aimed at this analyst.

        Args:
            msg: A control message.
        """
        if msg.get("target") != self.name:
            return
        cmd = msg.get("cmd")
        if cmd == "kill":
            print(f"{self.name}: killed", flush=True)
            os._exit(1)
        elif cmd == "degrade":
            self.log("degraded: dropping 75% of my packets")
            self.bus.drop_rate = DEGRADE_DROP
        elif cmd == "heal":
            self.bus.drop_rate = 0.0
            self.log("healed")

    def warm_state(self, replay: Replay, date: str) -> EscalationState:
        """The escalation memory for the morning of ``date``.

        Args:
            replay: The replay being played.
            date: Today's market date.

        Returns:
            The state canary.sim would have on that morning.
        """
        if replay.name not in self.warm:
            self.warm[replay.name] = warm_states(replay, self.dates, self.prices)
        return self.warm[replay.name].get(date, EscalationState())


def main() -> None:
    """Start one analyst from the command line."""
    parser = argparse.ArgumentParser(prog="python -m canary.agent")
    parser.add_argument("--name", choices=RING, required=True)
    parser.add_argument(
        "--transport", choices=["multicast", "ports"], default="multicast"
    )
    args = parser.parse_args()

    bus = make_bus(args.transport, args.name)
    try:
        Analyst(args.name, bus).run()
    except KeyboardInterrupt:
        pass
    finally:
        bus.close()


if __name__ == "__main__":
    main()
