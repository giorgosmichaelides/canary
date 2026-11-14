"""Peer-to-peer message bus over UDP on localhost.

Every process creates a bus and calls send() and recv(). There is no hub:
every message reaches every process, including the sender.

Two transports with the same methods:
    Bus      multicast group 239.77.7.7 on loopback, TTL 0 (default)
    PortBus  fallback: each process owns one localhost port, send() goes to all

Check it by hand in two terminals:
    python -m desk.bus check
    python -m desk.bus listen
    python -m desk.bus send '{"type": "view", "agent": "fx"}'
Add --transport ports --name <peer> to try the fallback (each listener needs a
different name from PEERS).
"""

from __future__ import annotations

import argparse
import json
import random
import socket
import struct
import sys
from typing import Optional, Union

GROUP, PORT = "239.77.7.7", 47777
LOOPBACK = "127.0.0.1"

# Only used by the fallback. Each process gets its own port: tape is 47700,
# fx is 47701, and so on down the list. Don't reorder it, or processes will
# disagree about who lives where.
BASE_PORT = 47700
PEERS = ["tape", "fx", "havens", "commodity", "contrarian", "relay", "launcher", "probe", "probe2"]


class Bus:
    """Multicast bus: every process joins one group on the loopback interface.

    Attributes:
        sock: The UDP socket.
        drop_rate: Fraction of outgoing packets dropped (0.75 on degrade, 0 on heal).
    """

    def __init__(self) -> None:
        """Create the socket, share the port with other processes and join the group.

        Raises:
            OSError: If the OS refuses to bind or join the group.
        """
        self.drop_rate = 0.0
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)

        # Normally only one process can bind a port. All six of ours need the
        # same one, so we switch that rule off. Mac and Linux need both
        # options; Windows doesn't have SO_REUSEPORT and is fine without it.
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except AttributeError:
            pass

        self.sock.bind(("", PORT))

        # Tell the OS we want packets sent to the group, on loopback only.
        mreq = struct.pack("4s4s", socket.inet_aton(GROUP), socket.inet_aton(LOOPBACK))
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)

        # Send through loopback, with TTL 0 so nothing ever reaches the venue
        # Wi-Fi, and loop packets back so processes on this laptop hear them.
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(LOOPBACK))
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 0)
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)

        self.targets = [(GROUP, PORT)]

    def send(self, msg: dict) -> None:
        """Broadcast a message to every process.

        Args:
            msg: A JSON-serialisable dict with a "type" field.
        """
        if random.random() < self.drop_rate:
            return  # pretend the packet got lost (degrade mode)
        data = json.dumps(msg).encode()
        for target in self.targets:
            try:
                self.sock.sendto(data, target)
            except OSError:
                pass  # a lost packet is fine, a newer one is coming anyway

    def recv(self, timeout: Optional[float] = None) -> Optional[dict]:
        """Wait for the next message.

        Use a finite timeout in loops: on Windows, Ctrl-C can't interrupt a
        recv that waits forever.

        Args:
            timeout: Seconds to wait, or None to wait forever.

        Returns:
            The message, or None if the timeout passed first.
        """
        self.sock.settimeout(timeout)
        while True:
            try:
                data, _ = self.sock.recvfrom(65535)
            except socket.timeout:
                return None
            except ConnectionResetError:
                # Windows-only quirk: if we earlier sent to a port nobody is
                # on (say, a killed analyst), Windows complains here instead.
                # It's harmless, so keep waiting.
                continue
            try:
                return json.loads(data)
            except ValueError:
                continue  # not one of ours, skip it

    def close(self) -> None:
        """Close the socket."""
        self.sock.close()


class PortBus(Bus):
    """Fallback bus: each process binds its own port; send() goes to every port."""

    def __init__(self, name: str) -> None:
        """Bind this process's own port.

        Args:
            name: This process's name; must be in PEERS.

        Raises:
            ValueError: If name is not in PEERS.
            OSError: If the port is taken (another process has the same name).
        """
        if name not in PEERS:
            raise ValueError(f"unknown name {name!r}, expected one of {PEERS}")
        self.drop_rate = 0.0
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.sock.bind((LOOPBACK, BASE_PORT + PEERS.index(name)))
        self.targets = [(LOOPBACK, BASE_PORT + i) for i in range(len(PEERS))]


def make_bus(transport: str, name: str) -> Union[Bus, PortBus]:
    """Build the bus a process should use.

    Args:
        transport: "multicast" or "ports", as chosen by the launcher.
        name: This process's name (used by the fallback).

    Returns:
        A bus with send(), recv() and close().
    """
    return Bus() if transport == "multicast" else PortBus(name)


def multicast_works() -> bool:
    """Check whether multicast actually delivers on this machine.

    On some machines (often Windows) every line runs without an error but no
    message ever arrives, so only a message that comes back counts.

    Returns:
        True if a test message arrived within 0.5 s.
    """
    try:
        rx, tx = Bus(), Bus()
    except OSError:
        return False
    try:
        tx.send({"type": "probe"})
        msg = rx.recv(timeout=0.5)
        return msg is not None and msg.get("type") == "probe"
    finally:
        rx.close()
        tx.close()


def main() -> None:
    """Command-line check: python -m desk.bus check | listen | send '<json>'."""
    parser = argparse.ArgumentParser(prog="python -m desk.bus")
    parser.add_argument("command", choices=["check", "listen", "send"])
    parser.add_argument("message", nargs="?", default='{"type": "log", "agent": "probe", "text": "hello"}')
    parser.add_argument("--transport", choices=["multicast", "ports"], default="multicast")
    parser.add_argument("--name", default="probe")
    args = parser.parse_intermixed_args()

    if args.command == "check":
        ok = multicast_works()
        print(f"{sys.platform}: multicast {'works' if ok else 'not working'}, use --transport {'multicast' if ok else 'ports'}")
        return

    bus = make_bus(args.transport, args.name)
    try:
        if args.command == "send":
            bus.send(json.loads(args.message))
            print("sent")
            return
        print(f"listening on {args.transport}, Ctrl-C to stop")
        while True:
            msg = bus.recv(timeout=0.5)
            if msg is not None:
                print(msg, flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        bus.close()


if __name__ == "__main__":
    main()
