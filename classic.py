"""
Classic engine — drives the pymobiledevice3 command line exactly like Ghostpin v1
(`developer dvt simulate-location set -- LAT LON`), which is the path proven to work.

* Prefers the user's own installed Python + pymobiledevice3 (what v1 used); falls back to the
  copy bundled inside Ghostpin.exe.
* Teleport / joystick: one long-running `set` process; replaced when the position changes
  (throttled, because every CLI start opens a new developer tunnel).
* Driving: the whole route is written to a timed GPX file and replayed with
  `simulate-location play`, so movement on the phone is smooth (1 point per second).
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

log = logging.getLogger("ghostpin.classic")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _find_cli() -> tuple[list[str], str]:
    """Return (command prefix, description)."""
    if sys.platform == "win32":
        try:
            r = subprocess.run(["py", "-3", "-c", "import sys, pymobiledevice3; print(sys.executable)"],
                               capture_output=True, text=True, timeout=40, creationflags=NO_WINDOW)
            exe = r.stdout.strip().splitlines()[-1] if r.returncode == 0 and r.stdout.strip() else ""
            if exe and os.path.exists(exe):
                return [exe, "-m", "pymobiledevice3"], f"your Python ({exe})"
        except Exception as e:
            log.info("No system Python with pymobiledevice3: %s", e)
    if getattr(sys, "frozen", False):
        return [sys.executable, "--pmd3"], "bundled pymobiledevice3"
    return [sys.executable, "-m", "pymobiledevice3"], f"Python {sys.executable}"


class ClassicCli:
    MIN_GAP = 3.0  # seconds between `set` restarts

    def __init__(self, status: Callable[[str, str], None], emit: Callable[[str, dict], None]):
        self.status = status
        self.emit = emit
        self.cmd: Optional[list[str]] = None
        self.cmd_desc = ""
        self.proc: Optional[subprocess.Popen] = None
        self.proc_kind = ""
        self.lock = threading.RLock()
        self.active = False
        self.playing = False
        self._pending: Optional[tuple] = None
        self._last_set: Optional[tuple] = None
        self._last_start = 0.0
        self._gpx_path = os.path.join(tempfile.gettempdir(), "ghostpin_route.gpx")
        threading.Thread(target=self._pump, name="classic-pump", daemon=True).start()

    # ---------------------------------------------------------------- helpers
    def _ensure_cmd(self):
        if not self.cmd:
            self.cmd, self.cmd_desc = _find_cli()
            log.info("Classic engine uses %s", self.cmd_desc)

    def run(self, args: list[str], timeout=120) -> tuple[int, str]:
        self._ensure_cmd()
        log.info("> pymobiledevice3 %s", " ".join(args))
        try:
            r = subprocess.run(self.cmd + args, capture_output=True, text=True, errors="replace",
                               timeout=timeout, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
            out = (r.stdout + "\n" + r.stderr).strip()
            for line in out.splitlines()[-25:]:
                log.info("  %s", line[:400])
            return r.returncode, out
        except subprocess.TimeoutExpired:
            return -1, f"timed out after {timeout}s"
        except Exception as e:
            return -1, f"{type(e).__name__}: {e}"

    def _kill(self):
        with self.lock:
            p, self.proc = self.proc, None
            self.proc_kind = ""
        if p and p.poll() is None:
            try:
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True,
                                   creationflags=NO_WINDOW, timeout=15)
                else:
                    p.terminate()
                p.wait(8)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    def _spawn(self, args: list[str], kind: str):
        self._ensure_cmd()
        self._kill()
        log.info("> pymobiledevice3 %s   (kept running)", " ".join(args))
        p = subprocess.Popen(self.cmd + args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, errors="replace", creationflags=NO_WINDOW)
        with self.lock:
            self.proc, self.proc_kind = p, kind
            self._last_start = time.monotonic()
        threading.Thread(target=self._watch, args=(p, kind), daemon=True).start()

    def _watch(self, p: subprocess.Popen, kind: str):
        tail = []
        for line in p.stdout:
            line = line.rstrip()
            if line:
                tail = (tail + [line])[-6:]
                log.info("  [%s] %s", kind, line[:400])
        code = p.wait()
        with self.lock:
            current = self.proc is p
            if current:
                self.proc = None
        if current and self.active:
            if code != 0:
                msg = " | ".join(tail[-3:]) or f"exit code {code}"
                log.error("%s process stopped: %s", kind, msg)
                self.status("error", f"iPhone location process stopped: {msg}")
            elif kind == "play":
                self.playing = False

    # ---------------------------------------------------------------- API used by DeviceEngine
    def connect(self, udid: Optional[str]) -> dict:
        self._ensure_cmd()
        self.status("connecting", f"Checking iPhone over USB (using {self.cmd_desc})…")
        code, out = self.run(["usbmux", "list"], 60)
        if code != 0:
            raise RuntimeError("pymobiledevice3 could not list devices: " + out[-300:])
        try:
            devs = json.loads(out[out.index("["): out.rindex("]") + 1])
        except Exception:
            devs = []
        if not devs:
            raise RuntimeError("No iPhone found. Plug it in with a data cable, unlock it and tap Trust "
                               "(Apple Devices / iTunes must be installed).")
        d = next((x for x in devs if udid and udid in (x.get("Identifier"), x.get("UniqueDeviceID"))), devs[0])
        info = {"name": d.get("DeviceName") or "iPhone", "version": d.get("ProductVersion") or "",
                "model": d.get("ProductType") or "", "udid": d.get("Identifier") or d.get("UniqueDeviceID")}
        self.status("connecting", "Making sure the developer disk image is mounted (first time can take a minute)…")
        code, out = self.run(["mounter", "auto-mount"], 300)
        low = out.lower()
        if code != 0 and "already mounted" not in low:
            log.warning("auto-mount returned %s; continuing (it is often already mounted)", code)
        self.active = True
        return info

    def push(self, lat, lon):
        if not self.playing:
            self._pending = (lat, lon)

    def _pump(self):
        while True:
            time.sleep(0.25)
            p = self._pending
            if not (self.active and p and not self.playing):
                continue
            if self._last_set and abs(p[0] - self._last_set[0]) < 1e-7 and abs(p[1] - self._last_set[1]) < 1e-7 \
                    and self.proc and self.proc.poll() is None:
                continue
            if time.monotonic() - self._last_start < self.MIN_GAP:
                continue
            self._pending = None
            self._last_set = p
            self._spawn(["developer", "dvt", "simulate-location", "set", "--", f"{p[0]:.7f}", f"{p[1]:.7f}"], "set")
            self.emit("sent", {"lat": p[0], "lon": p[1], "t": time.time()})

    def play_track(self, track: list[tuple], step_s: float = 1.0):
        """track: list of (lat, lon) one per `step_s` seconds."""
        if not self.active or len(track) < 2:
            return
        t = datetime.now(timezone.utc)
        lines = ['<?xml version="1.0" encoding="UTF-8"?>',
                 '<gpx version="1.1" creator="Ghostpin" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>']
        for i, (la, lo) in enumerate(track):
            ts = (t + timedelta(seconds=i * step_s)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
            lines.append(f'<trkpt lat="{la:.7f}" lon="{lo:.7f}"><time>{ts}</time></trkpt>')
        lines.append("</trkseg></trk></gpx>")
        with open(self._gpx_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        self.playing = True
        self._pending = None
        self._spawn(["developer", "dvt", "simulate-location", "play", self._gpx_path], "play")

    def stop_track(self, hold_at: Optional[tuple] = None):
        if self.playing:
            self.playing = False
            self._kill()
            self._last_start = 0.0
        if hold_at:
            self._last_set = None
            self._pending = hold_at

    def clear(self) -> bool:
        self.playing = False
        self._pending = None
        self._kill()
        code, out = self.run(["developer", "dvt", "simulate-location", "clear"], 120)
        self._last_set = None
        return code == 0

    def shutdown(self):
        self.active = False
        self.playing = False
        self._pending = None
        self._kill()
