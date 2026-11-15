"""The launcher: one command starts the whole desk.

It checks once whether multicast works on this machine, then starts the four
analysts, the relay and the tape as separate processes and tells each which
transport to use. It carries no data or views. The only bus message it acts on
is ``revive``: a killed analyst can't restart itself, so the launcher does it.

Ctrl-C stops everything.

Usage:
    python -m canary.run
    python -m canary.run --replay 2024 --no-browser
    python -m canary.run --interval 0.5 --autoplay    # fast, for testing

The replay waits on its first day until someone presses Start the desk on the
page (or play on the bus). --autoplay starts it straight away.
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from types import FrameType
from typing import Optional

from canary.agent import RING
from canary.bus import Bus, make_bus, multicast_works
from canary.sim import REPLAYS

ROOT = Path(__file__).resolve().parent.parent
REVIVABLE = (*RING, "relay", "tape")
AGENTS_READY_TIMEOUT = 10.0


def command(name: str, transport: str, args: argparse.Namespace) -> list[str]:
    """The command line that starts one process.

    Args:
        name: An analyst name, "relay" or "tape".
        transport: "multicast" or "ports".
        args: The launcher's own options.

    Returns:
        The argument list for subprocess.
    """
    base = [sys.executable, "-m"]
    if name in RING:
        return base + ["canary.agent", "--name", name, "--transport", transport]
    if name == "relay":
        return base + [
            "canary.relay",
            "--port",
            str(args.port),
            "--transport",
            transport,
        ]
    tape = base + ["canary.tape", "--replay", args.replay, "--transport", transport]
    tape += ["--interval", str(args.interval)]
    return tape + ([] if args.autoplay else ["--paused"])


def other_desk_running(bus: Bus, seconds: float = 1.0) -> bool:
    """Listen briefly for analysts that are already running.

    Two desks on one machine would share the bus and talk over each other.

    Args:
        bus: The launcher's bus.
        seconds: How long to listen.

    Returns:
        True if any analyst heartbeat was heard.
    """
    deadline = time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        msg = bus.recv(timeout=remaining)
        if msg is not None and msg.get("type") == "hb" and msg.get("agent") in RING:
            return True
    return False


class Launcher:
    """Starts, revives and stops the desk's processes."""

    def __init__(self, bus: Bus, transport: str, args: argparse.Namespace) -> None:
        """Get ready to launch.

        Args:
            bus: The launcher's own bus, used to hear revive commands.
            transport: "multicast" or "ports", passed to every child.
            args: The launcher's options.
        """
        self.bus = bus
        self.transport = transport
        self.args = args
        self.procs: dict[str, subprocess.Popen[bytes]] = {}

    def log(self, text: str) -> None:
        """Print a line and put it in the desk log.

        Args:
            text: What happened.
        """
        print(f"launcher: {text}", flush=True)
        self.bus.send({"type": "log", "agent": "launcher", "text": text})

    def start(self, name: str) -> None:
        """Start one process, sharing this terminal for its output.

        Args:
            name: An analyst name, "relay" or "tape".
        """
        self.procs[name] = subprocess.Popen(
            command(name, self.transport, self.args), cwd=ROOT
        )

    def wait_for_agents(self) -> None:
        """Wait until every analyst has sent a heartbeat, so none misses day one."""
        heard: set[str] = set()
        deadline = time.monotonic() + AGENTS_READY_TIMEOUT
        while heard != set(RING) and time.monotonic() < deadline:
            msg = self.bus.recv(timeout=0.5)
            if msg is not None and msg.get("type") == "hb":
                heard.add(str(msg.get("agent")))
        missing = set(RING) - heard
        if missing:
            print(
                f"launcher: no heartbeat from {sorted(missing)}, starting anyway",
                flush=True,
            )

    def revive(self, name: str) -> None:
        """Restart a process if it is dead; leave it alone if it is running.

        Args:
            name: The process to revive.
        """
        proc = self.procs.get(name)
        if proc is not None and proc.poll() is None:
            self.log(f"{name} is already running")
            return
        self.start(name)
        self.log(f"revived {name}")

    def run(self) -> None:
        """Start everything, then listen for revive commands until stopped."""
        for name in RING:
            self.start(name)
        self.start("relay")
        self.wait_for_agents()
        self.start("tape")

        url = f"http://localhost:{self.args.port}"
        time.sleep(0.5)
        if self.procs["relay"].poll() is not None:
            print(
                f"launcher: the relay stopped. Is port {self.args.port} in use?",
                flush=True,
            )
            return
        print(
            f"launcher: Canary is running at {url} ({self.transport}). Ctrl-C to stop.",
            flush=True,
        )
        if not self.args.no_browser:
            webbrowser.open(url)

        while True:
            msg = self.bus.recv(timeout=1.0)
            if (
                msg is None
                or msg.get("type") != "control"
                or msg.get("cmd") != "revive"
            ):
                continue
            target = msg.get("target")
            if target in REVIVABLE:
                self.revive(str(target))

    def stop(self) -> None:
        """Stop every process, politely first, then firmly."""
        for proc in self.procs.values():
            if proc.poll() is None:
                proc.terminate()
        deadline = time.monotonic() + 3.0
        for proc in self.procs.values():
            try:
                proc.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                proc.kill()


def stop_on_terminate(signum: int, frame: Optional[FrameType]) -> None:
    """Treat a terminate signal like Ctrl-C, so the children are cleaned up too.

    Args:
        signum: The signal number.
        frame: The current stack frame.

    Raises:
        KeyboardInterrupt: Always.
    """
    raise KeyboardInterrupt


def main() -> None:
    """Start the whole desk from the command line."""
    parser = argparse.ArgumentParser(prog="python -m canary.run")
    parser.add_argument("--replay", choices=sorted(REPLAYS), default="2020")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--transport", choices=["auto", "multicast", "ports"], default="auto"
    )
    parser.add_argument(
        "--interval", type=float, default=2.0, help="seconds per trading day"
    )
    parser.add_argument(
        "--autoplay",
        action="store_true",
        help="start the replay at once instead of waiting for Start the desk",
    )
    # Waiting for Start is now the default; --paused is still accepted so old commands work.
    parser.add_argument("--paused", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--no-browser", action="store_true", help="don't open the page automatically"
    )
    args = parser.parse_args()

    transport = args.transport
    if transport == "auto":
        transport = "multicast" if multicast_works() else "ports"

    try:
        bus = make_bus(transport, "launcher")
    except OSError:
        print("launcher: Canary is already running on this machine. Stop it first.")
        sys.exit(1)
    if other_desk_running(bus):
        print("launcher: Canary is already running on this machine. Stop it first.")
        bus.close()
        sys.exit(1)

    signal.signal(signal.SIGTERM, stop_on_terminate)
    launcher = Launcher(bus, transport, args)
    try:
        launcher.run()
    except KeyboardInterrupt:
        pass
    finally:
        print("launcher: stopping everything", flush=True)
        launcher.stop()
        bus.close()


if __name__ == "__main__":
    main()
