"""The relay: the browser's window onto the bus.

It only listens, displays and forwards human decisions. The agents never read
anything from it, so killing it changes nothing for them.

HTTP on http://localhost:8000:
    GET  /            the page and everything else in web/
    GET  /events      server-sent events: every bus message as JSON, plus one
                      {"type": "card", "card": {...}, "opened_at": ...} per
                      escalation id, however many analysts raise it
    GET  /history     {"events": [...]}: the current replay's ticks, card events
                      and decisions, oldest first, so a page that connects late
                      (or reloads) can redraw the chart from day 0
    POST /control     {"cmd": "kill", "target": "fx"} -> put on the bus
                      {"cmd": "restart", "replay": "2008"} switches crisis
    POST /decision    {"id": "2020:2020-03-02", "verdict": "approve" | "veto",
                       "reason": "...", "by": "Judge name"} -> logged and broadcast

When a card opens the relay pauses the tape, and when the last open card is
decided it presses play again.

Usage:
    python -m canary.relay
    python -m canary.relay --port 8080 --transport ports
"""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import json
import queue
import threading
import time
from dataclasses import dataclass, field
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Optional

from canary.bus import Bus, make_bus
from canary.sim import REPLAYS

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DECISIONS_FILE = ROOT / "data" / "decisions.jsonl"

CONTROL_COMMANDS = ("play", "pause", "restart", "kill", "degrade", "heal", "revive")
VERDICTS = ("approve", "veto")
KEEPALIVE_SECONDS = 15.0
HISTORY_LIMIT = 1000  # the longest replay (2008) is 126 ticks

Message = dict[str, Any]


class DecisionError(Exception):
    """A decision the relay can't accept.

    Attributes:
        status: HTTP status code to answer with.
    """

    def __init__(self, text: str, status: int = 400) -> None:
        """Make the error.

        Args:
            text: What was wrong, shown to the person deciding.
            status: HTTP status code.
        """
        super().__init__(text)
        self.status = status


@dataclass
class Cards:
    """One card per escalation id, however many analysts raise it.

    No network or files here, so it can be tested on its own.

    Attributes:
        open: Card id -> (escalation, monotonic time it opened, wall time it opened).
        seen: Every card id shown since the replay last started.
    """

    open: dict[str, tuple[Message, float, float]] = field(default_factory=dict)
    seen: set[str] = field(default_factory=set)

    def see(self, msg: Message, now: float, wall: float) -> Optional[Message]:
        """Look at a bus message and say whether it opens a new card.

        A tick for day 0 means the replay (re)started, so cards can show again.

        Args:
            msg: Any bus message.
            now: Current monotonic time.
            wall: Current wall-clock time.

        Returns:
            A "card" event for the browser if this message opens a new card,
            otherwise None.
        """
        kind = msg.get("type")
        if kind == "tick" and msg.get("i") == 0:
            self.open.clear()
            self.seen.clear()
        elif kind == "decision":
            self.open.pop(str(msg.get("id")), None)
            self.seen.add(str(msg.get("id")))
        elif kind == "view" and isinstance(msg.get("escalation"), dict):
            card: Message = msg["escalation"]
            card_id = str(card.get("id"))
            if card_id not in self.seen:
                self.seen.add(card_id)
                self.open[card_id] = (card, now, wall)
                return card_event(card, wall)
        return None

    def decide(self, body: Message, now: float, wall: float) -> tuple[Message, bool]:
        """Close a card with a human decision.

        Args:
            body: {"id", "verdict", "reason", "by"} from the browser.
            now: Current monotonic time.
            wall: Current wall-clock time.

        Returns:
            The decision record, and True if no cards are left open.

        Raises:
            DecisionError: If the card isn't open, the verdict is unknown, or
                a veto has no reason.
        """
        card_id = str(body.get("id", ""))
        verdict = body.get("verdict")
        reason = str(body.get("reason") or "").strip()
        if verdict not in VERDICTS:
            raise DecisionError(f"verdict must be one of {VERDICTS}")
        if verdict == "veto" and not reason:
            raise DecisionError("a veto needs a reason")
        if card_id not in self.open:
            raise DecisionError(f"no open card {card_id!r}", status=409)

        card, opened, _ = self.open.pop(card_id)
        record: Message = {
            "id": card_id,
            "verdict": verdict,
            "reason": reason,
            "by": str(body.get("by") or "").strip(),
            "action": card.get("action"),
            "market_date": card.get("date"),
            "decided_at": dt.datetime.fromtimestamp(wall, dt.timezone.utc).isoformat(
                timespec="seconds"
            ),
            "seconds_to_decide": round(now - opened, 1),
        }
        return record, not self.open

    def snapshot(self) -> list[Message]:
        """Card events for every card still open, for a browser that just connected.

        Returns:
            One "card" event per open card, oldest first.
        """
        return [card_event(card, wall) for card, _, wall in self.open.values()]


def card_event(card: Message, opened_at: float) -> Message:
    """Wrap an escalation as the event the browser shows a card for.

    Args:
        card: The escalation from a view message.
        opened_at: Wall-clock time the card first appeared.

    Returns:
        {"type": "card", "card": card, "opened_at": opened_at}.
    """
    return {"type": "card", "card": card, "opened_at": opened_at}


class Relay:
    """Bus listener, browser fan-out and decision log, shared by the HTTP threads."""

    def __init__(self, bus: Bus, decisions_file: Path = DECISIONS_FILE) -> None:
        """Get ready to relay.

        Args:
            bus: A bus from canary.bus.make_bus.
            decisions_file: Where decision records are appended.
        """
        self.bus = bus
        self.decisions_file = decisions_file
        self.cards = Cards()
        self.lock = threading.Lock()
        self.clients: list[queue.Queue[Message]] = []
        self.latest: dict[tuple[str, str], Message] = {}
        self.history: list[Message] = []

    def listen(self) -> None:
        """Forward every bus message to the browsers. Runs forever on its own thread."""
        while True:
            msg = self.bus.recv(timeout=1.0)
            if msg is None:
                continue
            self.see(msg)

    def see(self, msg: Message) -> None:
        """Handle one bus message: dedupe cards, remember it, forward it.

        Args:
            msg: Any bus message.
        """
        with self.lock:
            card = self.cards.see(msg, time.monotonic(), time.time())
            if msg.get("type") in ("view", "hb") and "agent" in msg:
                self.latest[(str(msg["type"]), str(msg["agent"]))] = msg
            self.remember(msg, card)
        self.broadcast(msg)
        if card is not None:
            print(
                f"relay: card {card['card'].get('id')}, pausing the tape",
                flush=True,
            )
            self.bus.send({"type": "control", "cmd": "pause", "target": "tape"})
            self.broadcast(card)

    def remember(self, msg: Message, card: Optional[Message]) -> None:
        """Keep the current replay's ticks, card events and decisions for /history.

        Call with the lock held. A tick for day 0 starts a new history.

        Args:
            msg: The bus message just seen.
            card: The card event it opened, if any.
        """
        kind = msg.get("type")
        if kind == "tick":
            if msg.get("i") == 0:
                self.history.clear()
            self.history.append(msg)
        elif kind == "decision":
            self.history.append(msg)
        if card is not None:
            self.history.append(card)
        del self.history[:-HISTORY_LIMIT]

    def history_snapshot(self) -> list[Message]:
        """The current replay so far, oldest first.

        Returns:
            Ticks, card events and decisions since the replay last started.
        """
        with self.lock:
            return list(self.history)

    def broadcast(self, msg: Message) -> None:
        """Queue a message for every connected browser, dropping any that fell behind.

        Args:
            msg: The message.
        """
        with self.lock:
            for client in list(self.clients):
                try:
                    client.put_nowait(msg)
                except queue.Full:
                    self.clients.remove(client)

    def connect(self) -> tuple[queue.Queue[Message], list[Message]]:
        """Register a new browser.

        Returns:
            Its message queue, and what it needs to catch up: the latest
            heartbeat and view from each analyst, and any open cards.
        """
        client: queue.Queue[Message] = queue.Queue(maxsize=1000)
        with self.lock:
            self.clients.append(client)
            catch_up = list(self.latest.values()) + self.cards.snapshot()
        return client, catch_up

    def disconnect(self, client: queue.Queue[Message]) -> None:
        """Forget a browser that went away.

        Args:
            client: Its queue.
        """
        with self.lock:
            if client in self.clients:
                self.clients.remove(client)

    def control(self, body: Message) -> Message:
        """Put a control command from the browser on the bus.

        Args:
            body: {"cmd": ..., "target": ...}, plus "replay" (e.g. "2008")
                with "restart" to switch crisis.

        Returns:
            The control message sent.

        Raises:
            DecisionError: If the command is unknown.
        """
        cmd = body.get("cmd")
        if cmd not in CONTROL_COMMANDS:
            raise DecisionError(f"cmd must be one of {CONTROL_COMMANDS}")
        msg: Message = {"type": "control", "cmd": cmd, "target": body.get("target")}
        replay = body.get("replay")
        if replay is not None:
            if cmd != "restart" or replay not in REPLAYS:
                raise DecisionError(
                    f"replay only goes with restart, one of {sorted(REPLAYS)}"
                )
            msg["replay"] = replay
        self.bus.send(msg)
        return msg

    def decide(self, body: Message) -> Message:
        """Record a human decision, broadcast it, and restart the tape if nothing is open.

        Args:
            body: {"id", "verdict", "reason", "by"} from the browser.

        Returns:
            The decision record.

        Raises:
            DecisionError: If the decision can't be accepted.
        """
        with self.lock:
            record, none_open = self.cards.decide(body, time.monotonic(), time.time())
        self.decisions_file.parent.mkdir(parents=True, exist_ok=True)
        with self.decisions_file.open("a") as f:
            f.write(json.dumps(record) + "\n")
        print(
            f"relay: {record['verdict']} {record['id']} after {record['seconds_to_decide']}s",
            flush=True,
        )
        self.bus.send({"type": "decision", **record})
        if none_open:
            self.bus.send({"type": "control", "cmd": "play", "target": "tape"})
        return record


class Handler(SimpleHTTPRequestHandler):
    """Serves web/, the event stream, and the two POST endpoints."""

    relay: Relay

    def do_GET(self) -> None:
        """Serve /events as a stream, /history as JSON, anything else as a file from web/."""
        path = self.path.split("?")[0]
        if path == "/events":
            self.stream_events()
        elif path == "/history":
            self.send_json(200, {"events": self.relay.history_snapshot()})
        else:
            super().do_GET()

    def do_POST(self) -> None:
        """Handle /control and /decision."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise DecisionError("body must be a JSON object")
            if self.path == "/control":
                self.send_json(200, self.relay.control(body))
            elif self.path == "/decision":
                self.send_json(200, self.relay.decide(body))
            else:
                self.send_json(404, {"error": "not found"})
        except DecisionError as e:
            self.send_json(e.status, {"error": str(e)})
        except ValueError:
            self.send_json(400, {"error": "body must be JSON"})

    def stream_events(self) -> None:
        """Keep the connection open and write each message as an SSE event."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        client, catch_up = self.relay.connect()
        try:
            self.wfile.write(b"retry: 1000\n\n")
            for msg in catch_up:
                self.write_event(msg)
            while True:
                try:
                    self.write_event(client.get(timeout=KEEPALIVE_SECONDS))
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            self.relay.disconnect(client)

    def write_event(self, msg: Message) -> None:
        """Write one message as an SSE event.

        Args:
            msg: The message.
        """
        self.wfile.write(b"data: " + json.dumps(msg).encode() + b"\n\n")
        self.wfile.flush()

    def send_json(self, status: int, data: Message) -> None:
        """Answer with a JSON body.

        Args:
            status: HTTP status code.
            data: The body.
        """
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def end_headers(self) -> None:
        """Stop the browser caching files, so edits to web/ show on reload."""
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        """Keep the terminal quiet; decisions and cards are printed instead."""


def serve(relay: Relay, port: int) -> ThreadingHTTPServer:
    """Build the HTTP server for a relay.

    Args:
        relay: The relay.
        port: Port on localhost.

    Returns:
        The server, not yet started.
    """
    handler = type("BoundHandler", (Handler,), {"relay": relay})
    server = ThreadingHTTPServer(
        ("127.0.0.1", port), functools.partial(handler, directory=str(WEB_DIR))
    )
    server.daemon_threads = True
    return server


def main() -> None:
    """Start the relay from the command line."""
    parser = argparse.ArgumentParser(prog="python -m canary.relay")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--transport", choices=["multicast", "ports"], default="multicast"
    )
    args = parser.parse_args()

    bus = make_bus(args.transport, "relay")
    relay = Relay(bus)
    threading.Thread(target=relay.listen, daemon=True).start()
    server = serve(relay, args.port)
    print(f"relay: http://localhost:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        bus.close()


if __name__ == "__main__":
    main()
