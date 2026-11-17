"""
Ghostpin engines.

DeviceEngine  - keeps ONE persistent connection to the iPhone's developer location
                service (DVT on iOS 17+, com.apple.dt.simulatelocation below 17) and
                pushes coordinates to it. Runs on its own asyncio loop thread.
MotionEngine  - moves a virtual position along a route / joystick direction at a
                chosen speed and feeds every step to the DeviceEngine.
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import threading
import time
from typing import Callable, Optional

log = logging.getLogger("ghostpin")

EARTH_R = 6371008.8


# ----------------------------------------------------------------------------- geo helpers
def haversine(a, b) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def bearing(a, b) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(p, brg_deg, dist_m):
    lat1, lon1 = map(math.radians, p)
    brg = math.radians(brg_deg)
    d = dist_m / EARTH_R
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    lon2 = lon1 + math.atan2(math.sin(brg) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return (math.degrees(lat2), (math.degrees(lon2) + 540) % 360 - 180)


def lerp_point(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def angle_diff(a, b) -> float:
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


# ----------------------------------------------------------------------------- device engine
class DeviceEngine:
    """Owns the asyncio loop + the persistent location-simulation channel."""

    def __init__(self, emit: Callable[[str, dict], None]):
        self.emit = emit
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, name="device-loop", daemon=True)
        self.thread.start()
        self.connected = False
        self.info: dict = {}
        self.mode = ""
        self._lockdown = None
        self._tunnel = None
        self._rsd = None
        self._dvt = None
        self._sim = None
        self._pending: Optional[tuple] = None
        self._sender: Optional[asyncio.Task] = None
        self._wake: Optional[asyncio.Event] = None
        self.last_sent: Optional[tuple] = None
        self.engine = "classic"  # classic (pymobiledevice3 CLI, like v1) | builtin
        from classic import ClassicCli
        self.classic = ClassicCli(self._status, emit)

    @property
    def uses_track(self) -> bool:
        return self.engine == "classic" and self.connected

    # -- loop plumbing
    def _run(self):
        asyncio.set_event_loop(self.loop)
        self._wake = asyncio.Event()
        self.loop.run_forever()

    def submit(self, coro, timeout=None):
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout) if timeout else fut

    def _status(self, state: str, message: str = ""):
        self.emit("device", {"state": state, "message": message, "info": self.info, "mode": self.mode,
                             "connected": self.connected})

    # -- discovery
    async def list_devices(self) -> list[dict]:
        from pymobiledevice3 import usbmux
        from pymobiledevice3.lockdown import create_using_usbmux

        out = []
        for d in await usbmux.list_devices():
            entry = {"udid": d.serial, "connection": d.connection_type, "name": "", "version": "", "model": ""}
            try:
                ld = await create_using_usbmux(serial=d.serial, autopair=False)
                si = ld.short_info
                entry.update(name=si.get("DeviceName") or "", version=si.get("ProductVersion") or "",
                             model=si.get("ProductType") or "")
                await ld.close()
            except Exception as e:  # locked / not trusted yet
                entry["error"] = _friendly(e)
            out.append(entry)
        return out

    # -- connect / disconnect
    async def connect(self, udid: Optional[str] = None, use_tunneld: bool = False, engine: Optional[str] = None):
        if engine in ("classic", "builtin"):
            self.engine = engine
        await self.disconnect(silent=True)
        log.info("Connecting with %s engine", self.engine)
        if self.engine == "classic":
            try:
                self.info = await asyncio.to_thread(self.classic.connect, udid)
                self.mode = "Classic (pymobiledevice3 CLI, " + self.classic.cmd_desc + ")"
                self.connected = True
                self._status("connected", f"Connected to {self.info['name']} • iOS {self.info['version']}")
                log.info("Classic engine ready for %s (iOS %s)", self.info["name"], self.info["version"])
                if self._pending:
                    self.push(*self._pending)
            except Exception as e:
                log.exception("classic connect failed")
                self.classic.shutdown()
                self.connected = False
                self._status("error", _friendly(e))
            return
        await self._connect_builtin(udid, use_tunneld)

    async def _connect_builtin(self, udid, use_tunneld):
        from packaging.version import Version
        from pymobiledevice3.lockdown import create_using_usbmux

        self._status("connecting", "Pairing with iPhone… unlock it and tap Trust if asked")
        try:
            self._lockdown = ld = await create_using_usbmux(serial=udid, autopair=True)
            si = ld.short_info
            self.info = {"name": si.get("DeviceName"), "version": si.get("ProductVersion"),
                         "model": si.get("ProductType"), "udid": si.get("UniqueDeviceID") or ld.identifier,
                         "build": si.get("BuildVersion")}
            ver = Version(self.info["version"] or "0")
            udid = self.info["udid"]

            # Developer Mode (iOS 16+)
            if ver >= Version("16.0"):
                try:
                    if not await ld.get_developer_mode_status():
                        raise RuntimeError("Developer Mode is OFF. On the iPhone: Settings > Privacy & Security > "
                                           "Developer Mode > On, then restart the phone.")
                except RuntimeError:
                    raise
                except Exception as e:
                    log.warning("Could not read developer mode status: %s", e)

            if ver >= Version("17.0"):
                self._status("connecting", "Opening secure developer tunnel (iOS 17+)…")
                self._rsd = await asyncio.wait_for(self._open_rsd(udid, use_tunneld), 60)
                log.info("Tunnel open (%s)", self.mode)
                # iOS 17+: the developer disk image must be mounted THROUGH the tunnel
                self._status("connecting", "Mounting developer disk image (first time downloads it)…")
                await asyncio.wait_for(self._mount(self._rsd), 300)
                from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
                from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

                self._dvt = DvtProvider(self._rsd)
                await asyncio.wait_for(self._dvt.__aenter__(), 30)
                self._sim = LocationSimulation(self._dvt)
                await asyncio.wait_for(self._sim.__aenter__(), 30)
                log.info("Location simulation channel open")
            else:
                self._status("connecting", "Mounting developer disk image…")
                await asyncio.wait_for(self._mount(ld), 300)
                from pymobiledevice3.services.simulate_location import DtSimulateLocation

                self.mode = "Lockdown (iOS < 17)"
                self._sim = DtSimulateLocation(ld)

            self.connected = True
            self._ensure_sender()
            self._status("connected", f"Connected to {self.info['name']} • iOS {self.info['version']}")
        except Exception as e:
            log.exception("connect failed")
            await self.disconnect(silent=True)
            self._status("error", _friendly(e))

    async def _mount(self, ld):
        from pymobiledevice3.exceptions import AlreadyMountedError
        from pymobiledevice3.services.mobile_image_mounter import auto_mount

        try:
            await auto_mount(ld)
            log.info("Developer disk image mounted")
        except AlreadyMountedError:
            log.info("Developer disk image already mounted")
        except Exception as e:
            # Not fatal: on many setups it's already mounted or Xcode did it.
            log.warning("auto_mount: %s", e)

    async def _open_rsd(self, udid, use_tunneld):
        errors = []
        if not use_tunneld:
            try:
                from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

                self._tunnel = UserspaceRsdTunnel(serial=udid)
                rsd = await self._tunnel.aopen()
                self.mode = "Userspace tunnel (no admin)"
                return rsd
            except Exception as e:
                errors.append(f"userspace: {_friendly(e)}")
                self._tunnel = None
        try:
            from pymobiledevice3.tunneld.api import get_tunneld_device_by_udid

            rsd = await get_tunneld_device_by_udid(udid)
            if rsd is None:
                raise RuntimeError("tunneld is running but has no tunnel for this iPhone yet")
            self.mode = "tunneld (admin tunnel)"
            return rsd
        except Exception as e:
            errors.append(f"tunneld: {_friendly(e)}")
        raise RuntimeError("Could not open the iOS 17+ developer tunnel. " + " | ".join(errors) +
                           " — Try Settings > 'Start admin tunnel', then Connect again.")

    async def disconnect(self, silent=False):
        self.connected = False
        await asyncio.to_thread(self.classic.shutdown)
        if self._sender:
            self._sender.cancel()
            self._sender = None
        for closer in (
            lambda: self._sim.__aexit__(None, None, None) if self._dvt and self._sim else None,
            lambda: self._dvt.__aexit__(None, None, None) if self._dvt else None,
            lambda: self._rsd.close() if self._rsd and not self._tunnel else None,
            lambda: self._tunnel.aclose() if self._tunnel else None,
            lambda: self._lockdown.close() if self._lockdown else None,
        ):
            try:
                c = closer()
                if asyncio.iscoroutine(c):
                    await asyncio.wait_for(c, 5)
            except Exception:
                pass
        self._sim = self._dvt = self._rsd = self._tunnel = self._lockdown = None
        self.mode = ""
        if not silent:
            self.info = {}
            self._status("disconnected", "Disconnected")

    # -- sending
    def push(self, lat: float, lon: float):
        """Thread-safe, latest-wins. Never blocks the caller."""
        self._pending = (lat, lon)
        if self.engine == "classic":
            if self.connected:
                self.classic.push(lat, lon)
            return
        if self._wake is not None:
            self.loop.call_soon_threadsafe(self._wake.set)

    def _ensure_sender(self):
        if not self._sender or self._sender.done():
            self._sender = self.loop.create_task(self._send_loop())

    async def _send_loop(self):
        while True:
            await self._wake.wait()
            self._wake.clear()
            p = self._pending
            if not p or not self.connected or not self._sim:
                continue
            try:
                await asyncio.wait_for(self._sim.set(round(p[0], 7), round(p[1], 7)), 10)
                if self.last_sent is None:
                    log.info("First location sent to iPhone: %.6f, %.6f", *p)
                self.last_sent = p
                self.emit("sent", {"lat": p[0], "lon": p[1], "t": time.time()})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.exception("send failed")
                self.connected = False
                self._status("error", "Lost connection to iPhone: " + _friendly(e))
                return

    async def clear(self):
        if self.engine == "classic":
            ok = await asyncio.to_thread(self.classic.clear)
            if not ok:
                self._status("error", "Could not restore real GPS — see Activity log")
            return ok
        try:
            if self._sim:
                await asyncio.wait_for(self._sim.clear(), 10)
                self.last_sent = None
                return True
            # Not connected: open a quick session just to clear.
            await self.connect()
            if self._sim:
                await self._sim.clear()
                return True
        except Exception as e:
            self._status("error", "Could not restore real GPS: " + _friendly(e))
        return False


def _friendly(e: Exception) -> str:
    name = type(e).__name__
    msg = str(e).strip()
    hints = {
        "NoDeviceConnectedError": "No iPhone found over USB. Plug it in with a data cable, unlock it and tap Trust. "
                                  "On Windows you also need Apple Devices / iTunes installed.",
        "ConnectionFailedToUsbmuxdError": "Apple Mobile Device Service isn't running. Install 'Apple Devices' "
                                          "(Microsoft Store) or iTunes, then reconnect the phone.",
        "PasswordRequiredError": "Unlock your iPhone and tap Trust, then try again.",
        "UserDeniedPairingError": "The iPhone refused to trust this PC. Unplug, replug and tap Trust.",
        "PairingDialogResponsePendingError": "Tap Trust on the iPhone, then click Connect again.",
        "DeveloperModeIsNotEnabledError": "Turn on Developer Mode: Settings > Privacy & Security > Developer Mode.",
        "TunneldConnectionError": "Admin tunnel (tunneld) is not running.",
    }
    if name in hints:
        return hints[name]
    return f"{name}: {msg}" if msg else name


# ----------------------------------------------------------------------------- motion engine
PROFILES = {
    "walk": {"speed": 5, "corner": 4},
    "run": {"speed": 10, "corner": 8},
    "bike": {"speed": 18, "corner": 12},
    "car": {"speed": 50, "corner": 22},
    "highway": {"speed": 110, "corner": 45},
}


class MotionEngine:
    """Moves the virtual position. One tick per `interval` seconds."""

    def __init__(self, device, emit: Callable[[str, dict], None], autostart: bool = True):
        self.device = device
        self.emit = emit
        self.lock = threading.RLock()
        self.pos: Optional[tuple] = None
        self.heading = 0.0
        self.mode = "idle"  # idle | route | joystick
        self.paused = False
        self.speed_kmh = 50.0
        self.variance = 0.08  # +/- fraction
        self.realistic = True  # slow for corners, gentle acceleration
        self.interval = 1.0
        self.loop_mode = "off"  # off | loop | pingpong
        self.cur_speed = 0.0  # m/s actual
        self.route: list[tuple] = []
        self.cum: list[float] = []
        self.dist = 0.0
        self.direction = 1
        self.joy = (0.0, 0.0)
        self.odometer = 0.0
        self._jitter = 1.0
        self._stop = threading.Event()
        self.track: Optional[list] = None  # classic engine: precomputed 1 s states
        self.track_t0 = 0.0
        self.track_i0 = 0
        if autostart:
            threading.Thread(target=self._run, name="motion", daemon=True).start()

    # -- classic engine: precompute the drive and replay it on the phone as a GPX
    def _simulate(self, max_steps=7200) -> list:
        sim = MotionEngine(_NullDevice(), lambda *_: None, autostart=False)
        sim.route, sim.cum = self.route, self.cum
        sim.dist, sim.direction, sim.cur_speed = self.dist, self.direction, self.cur_speed
        sim.speed_kmh, sim.variance, sim.realistic, sim.loop_mode = self.speed_kmh, self.variance, self.realistic, self.loop_mode
        sim.mode, sim.pos, sim.heading, sim.interval = "route", self.pos, self.heading, 1.0
        out = [(sim.pos, sim.heading, sim.cur_speed, sim.dist, sim.direction)]
        for _ in range(max_steps):
            sim._tick(1.0)
            out.append((sim.pos, sim.heading, sim.cur_speed, sim.dist, sim.direction))
            if sim.mode != "route":
                break
        return out

    def _start_track(self):
        self.track = self._simulate()
        self.track_t0, self.track_i0 = time.monotonic(), 0
        self.device.classic.play_track([s[0] for s in self.track])

    def _halt_track(self):
        if self.track is not None:
            self.track = None
            self.device.classic.stop_track(hold_at=self.pos)

    # -- commands
    def teleport(self, lat, lon):
        with self.lock:
            if self.track is not None:
                self.track = None
                self.device.classic.stop_track()
            self.mode = "idle"
            self.pos = (lat, lon)
            self.cur_speed = 0.0
        self.device.push(lat, lon)
        self._emit_state(force=True)

    def start_route(self, points, speed_kmh=None, loop_mode=None):
        pts = [tuple(p) for p in points if p and len(p) == 2]
        # drop duplicate consecutive points
        clean = []
        for p in pts:
            if not clean or haversine(clean[-1], p) > 0.3:
                clean.append(p)
        if len(clean) < 2:
            raise ValueError("Route needs at least two distinct points")
        cum = [0.0]
        for a, b in zip(clean, clean[1:]):
            cum.append(cum[-1] + haversine(a, b))
        with self.lock:
            self.route, self.cum = clean, cum
            self.dist, self.direction = 0.0, 1
            self.mode, self.paused = "route", False
            self.cur_speed = 0.0
            if speed_kmh:
                self.speed_kmh = float(speed_kmh)
            if loop_mode:
                self.loop_mode = loop_mode
            self.pos = clean[0]
            self.heading = bearing(clean[0], clean[1])
            self.track = None
            if self.device.uses_track:
                self._start_track()
        if not self.device.uses_track:
            self.device.push(*clean[0])
        self._emit_state(force=True)
        return {"length": cum[-1]}

    def seek(self, fraction: float):
        with self.lock:
            if self.mode == "route" and self.cum:
                self.dist = max(0.0, min(1.0, fraction)) * self.cum[-1]
                self.pos, self.heading = self._point_at(self.dist)
                if self.track is not None and not self.paused:
                    self.cur_speed = 0.0
                    self._start_track()
                    self._emit_state()
                    return
        if self.pos:
            self.device.push(*self.pos)
        self._emit_state(force=True)

    def set_joystick(self, dx, dy):
        with self.lock:
            self.joy = (float(dx), float(dy))
            if (dx or dy) and self.pos:
                self._halt_track()
                self.mode, self.paused = "joystick", False

    def pause(self, value: bool):
        with self.lock:
            self.paused = bool(value)
            if self.paused:
                self.cur_speed = 0.0
                self._halt_track()
            elif self.mode == "route" and self.device.uses_track:
                self._start_track()
        self._emit_state(force=True)

    def stop(self):
        with self.lock:
            self._halt_track()
            self.mode, self.paused, self.cur_speed = "idle", False, 0.0
            self.joy = (0.0, 0.0)
        self._emit_state(force=True)

    def configure(self, **kw):
        with self.lock:
            for k in ("speed_kmh", "variance", "realistic", "interval", "loop_mode"):
                if k in kw and kw[k] is not None:
                    setattr(self, k, type(getattr(self, k))(kw[k]))
            self.interval = max(0.2, min(5.0, self.interval))
            # classic engine: speed/behaviour changed mid-drive -> recompute the rest of the route
            if self.track is not None and self.mode == "route" and not self.paused and \
                    any(k in kw and kw[k] is not None for k in ("speed_kmh", "variance", "realistic", "loop_mode")):
                self._start_track()

    # -- internals
    def _point_at(self, d):
        r, c = self.route, self.cum
        d = max(0.0, min(c[-1], d))
        lo, hi = 0, len(c) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if c[mid] <= d:
                lo = mid
            else:
                hi = mid
        seg = c[hi] - c[lo]
        t = 0 if seg <= 0 else (d - c[lo]) / seg
        p = lerp_point(r[lo], r[hi], t)
        a, b = (r[lo], r[hi]) if self.direction > 0 else (r[hi], r[lo])
        return p, bearing(a, b)

    def _corner_limit(self) -> float:
        """Max speed (m/s) allowed because of an upcoming sharp turn."""
        if not self.realistic or len(self.route) < 3:
            return 1e9
        look = max(25.0, self.cur_speed * 4)
        here = self.dist
        # find next vertex index in travel direction
        idx = next((i for i, c in enumerate(self.cum) if c > here), len(self.cum) - 1) if self.direction > 0 else \
            max((i for i, c in enumerate(self.cum) if c < here), default=0)
        limit = 1e9
        rng = range(idx, len(self.route) - 1) if self.direction > 0 else range(idx, 0, -1)
        for i in rng:
            if abs(self.cum[i] - here) > look:
                break
            if 0 < i < len(self.route) - 1:
                turn = angle_diff(bearing(self.route[i - 1], self.route[i]), bearing(self.route[i], self.route[i + 1]))
                if turn > 35:
                    prof = min(PROFILES.values(), key=lambda p: abs(p["speed"] - self.speed_kmh))
                    corner = prof["corner"] / 3.6 * (1.4 if turn < 70 else 1.0)
                    dist_to = abs(self.cum[i] - here)
                    # allow braking: v^2 = v_c^2 + 2*a*d  (a ~ 2.5 m/s^2)
                    limit = min(limit, math.sqrt(corner ** 2 + 2 * 2.5 * dist_to))
        return limit

    def _run(self):
        last = time.monotonic()
        while not self._stop.is_set():
            time.sleep(0.05)
            now = time.monotonic()
            if now - last < self.interval:
                continue
            dt, last = now - last, now
            try:
                self._tick(dt)
            except Exception:
                log.exception("motion tick")

    def _tick(self, dt):
        with self.lock:
            if self.mode == "idle" or self.paused or self.pos is None:
                return
            if self.track is not None and self.mode == "route":
                i = self.track_i0 + int(time.monotonic() - self.track_t0)
                if i >= len(self.track) - 1:
                    i = len(self.track) - 1
                pos, hdg, spd, dist, direction = self.track[i]
                self.pos, self.heading, self.cur_speed, self.dist, self.direction = pos, hdg, spd, dist, direction
                total = self.cum[-1]
                done = i >= len(self.track) - 1
                if done:
                    if self.loop_mode in ("loop", "pingpong"):
                        if self.loop_mode == "loop" and self.dist >= total:
                            self.dist = 0.0
                            self.pos, self.heading = self._point_at(0.0)
                        self._start_track()
                    else:
                        self.mode, self.cur_speed, self.track = "idle", 0.0, None
                        self.emit("arrived", {"lat": pos[0], "lon": pos[1]})
                self._emit_state()
                return
            # speed with smooth random variance
            self._jitter += random.uniform(-0.35, 0.35) * self.variance
            self._jitter = max(1 - self.variance, min(1 + self.variance, self._jitter))
            target = self.speed_kmh / 3.6 * (self._jitter if self.variance > 0 else 1)

            if self.mode == "joystick":
                dx, dy = self.joy
                mag = min(1.0, math.hypot(dx, dy))
                if mag < 0.05:
                    self.cur_speed = 0.0
                    return
                self.heading = (math.degrees(math.atan2(dx, dy)) + 360) % 360
                target *= mag
                self.cur_speed = self._accel(self.cur_speed, target, dt)
                step = self.cur_speed * dt
                self.pos = destination(self.pos, self.heading, step)
                self.odometer += step
            elif self.mode == "route":
                target = min(target, self._corner_limit())
                self.cur_speed = self._accel(self.cur_speed, target, dt)
                step = self.cur_speed * dt
                self.dist += step * self.direction
                self.odometer += step
                total = self.cum[-1]
                finished = False
                if self.dist >= total or self.dist <= 0:
                    if self.loop_mode == "loop":
                        self.dist = self.dist - total if self.dist >= total else 0.0
                        self.direction = 1
                    elif self.loop_mode == "pingpong":
                        self.direction *= -1
                        self.dist = max(0.0, min(total, self.dist))
                    else:
                        self.dist = max(0.0, min(total, self.dist))
                        finished = True
                self.pos, self.heading = self._point_at(self.dist)
                if finished:
                    self.mode = "idle"
                    self.cur_speed = 0.0
                    self.emit("arrived", {"lat": self.pos[0], "lon": self.pos[1]})
            pos = self.pos
        self.device.push(*pos)
        self._emit_state()

    def _accel(self, v, target, dt):
        if not self.realistic:
            return target
        a = 2.8 if target > v else 4.0
        return min(target, v + a * dt) if target > v else max(target, v - a * dt)

    def state(self) -> dict:
        with self.lock:
            s = {"mode": self.mode, "paused": self.paused, "heading": self.heading,
                 "speed": self.cur_speed * 3.6, "targetSpeed": self.speed_kmh, "odometer": self.odometer,
                 "loop": self.loop_mode, "interval": self.interval}
            if self.pos:
                s["lat"], s["lon"] = self.pos
            if self.mode == "route" or (self.route and self.cum):
                total = self.cum[-1] if self.cum else 0
                remaining = (total - self.dist) if self.direction > 0 else self.dist
                s.update(total=total, done=self.dist, progress=(self.dist / total) if total else 0,
                         remaining=remaining,
                         eta=remaining / max(0.5, self.speed_kmh / 3.6))
            return s

    def _emit_state(self, force=False):
        self.emit("motion", self.state())


class _NullDevice:
    uses_track = False

    def push(self, *a):
        pass
