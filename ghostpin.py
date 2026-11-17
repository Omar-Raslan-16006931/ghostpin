"""Ghostpin — iPhone location simulator for Windows (USB)."""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

APP_NAME = "Ghostpin"
VERSION = "2.2.0"


def resource(*parts) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


def data_dir() -> Path:
    root = os.environ.get("APPDATA") or str(Path.home() / ".config")
    p = Path(root) / "Ghostpin"
    p.mkdir(parents=True, exist_ok=True)
    return p


# ---------------------------------------------------------------- pymobiledevice3 CLI passthrough
# "Ghostpin.exe --pmd3 remote tunneld" runs pymobiledevice3's own CLI from inside the exe.
def _attach_console(title: str):
    """The exe is windowed; give CLI modes a visible console window."""
    if sys.platform == "win32" and getattr(sys, "frozen", False):
        import ctypes

        if ctypes.windll.kernel32.AllocConsole():
            ctypes.windll.kernel32.SetConsoleTitleW(title)
            sys.stdout = open("CONOUT$", "w", buffering=1, encoding="utf-8", errors="replace")
            sys.stderr = sys.stdout
            sys.stdin = open("CONIN$", "r")


def _bind_std_handles():
    """Windowed exe started with pipes (classic engine): hook sys.std* up to those pipes."""
    if sys.platform != "win32":
        return
    import ctypes
    import msvcrt

    k32 = ctypes.windll.kernel32
    for name, num, mode in (("stdin", -10, "r"), ("stdout", -11, "w"), ("stderr", -12, "w")):
        if getattr(sys, name) is not None:
            continue
        stream = None
        try:
            h = k32.GetStdHandle(num)
            if h and h != -1:
                fd = msvcrt.open_osfhandle(h, os.O_RDONLY if mode == "r" else 0)
                stream = open(fd, mode, buffering=1, encoding="utf-8", errors="replace")
        except Exception:
            stream = None
        setattr(sys, name, stream or open(os.devnull, mode))
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")


if len(sys.argv) > 1 and sys.argv[1] in ("--pmd3", "--pmd3-console"):
    if sys.argv[1] == "--pmd3-console":
        _attach_console("Ghostpin - iPhone developer tunnel (keep open)")
    else:
        _bind_std_handles()
    sys.argv = ["pymobiledevice3", *sys.argv[2:]]
    from pymobiledevice3.__main__ import main as _pmd3_main

    sys.exit(_pmd3_main())

if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
    # Packaging check: import everything the app needs at runtime.
    import importlib

    mods = ["engine", "webview", "pymobiledevice3.lockdown", "pymobiledevice3.usbmux",
            "pymobiledevice3.services.mobile_image_mounter", "pymobiledevice3.services.simulate_location",
            "pymobiledevice3.services.dvt.instruments.dvt_provider",
            "pymobiledevice3.services.dvt.instruments.location_simulation",
            "pymobiledevice3.remote.userspace_tunnel", "pymobiledevice3.tunneld.api", "packaging.version",
            "classic", "pymobiledevice3.__main__"]
    bad, lines = 0, []
    for m in mods:
        try:
            importlib.import_module(m)
            lines.append(f"ok   {m}")
        except Exception as e:  # noqa
            bad += 1
            lines.append(f"FAIL {m} {type(e).__name__} {e}")
    lines.append(f"web: {os.path.exists(resource('web', 'index.html'))}")
    out = "\n".join(lines)
    (data_dir() / "selftest.txt").write_text(out, encoding="utf-8")
    if sys.stdout:
        print(out)
    sys.exit(1 if bad else 0)

import webview  # noqa: E402

from engine import DeviceEngine, MotionEngine, haversine  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[logging.FileHandler(data_dir() / "ghostpin.log", encoding="utf-8")],
)
log = logging.getLogger("ghostpin")


class UiLogHandler(logging.Handler):
    def __init__(self, api):
        super().__init__(logging.INFO)
        self.api = api

    def emit(self, record):
        if record.name.startswith(("ghostpin", "pymobiledevice3")):
            try:
                self.api.emit("log", {"level": record.levelname.lower(), "text": record.getMessage()[:600]})
            except Exception:
                pass


class Api:
    def __init__(self):
        self._window: webview.Window | None = None
        self._q: list = []
        self._qlock = threading.Lock()
        self._store_path = data_dir() / "data.json"
        self._device = DeviceEngine(self.emit)
        self._motion = MotionEngine(self._device, self.emit)
        threading.Thread(target=self._flush_loop, daemon=True).start()

    # ---------------------------------------------------------------- events -> JS (batched)
    def emit(self, kind: str, payload: dict):
        with self._qlock:
            if kind == "motion":  # keep only the latest motion frame
                self._q = [e for e in self._q if e[0] != "motion"]
            self._q.append((kind, payload))

    def _flush_loop(self):
        while True:
            time.sleep(0.05)
            if not self._window:
                continue
            with self._qlock:
                batch, self._q = self._q, []
            if batch:
                try:
                    self._window.evaluate_js(f"window.GS && GS.onEvents({json.dumps(batch)})")
                except Exception:
                    pass

    # ---------------------------------------------------------------- app
    def app_info(self):
        return {"name": APP_NAME, "version": VERSION, "dataDir": str(data_dir()),
                "frozen": bool(getattr(sys, "frozen", False)), "platform": sys.platform}

    def load_store(self):
        try:
            return json.loads(self._store_path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def save_store(self, data):
        tmp = self._store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self._store_path)
        return True

    # ---------------------------------------------------------------- device
    def list_devices(self):
        try:
            return {"ok": True, "devices": self._device.submit(self._device.list_devices(), 30)}
        except Exception as e:
            from engine import _friendly
            return {"ok": False, "error": _friendly(e), "devices": []}

    def connect(self, udid=None, use_tunneld=False, engine=None):
        self._device.submit(self._device.connect(udid or None, bool(use_tunneld), engine))
        return True

    def disconnect(self):
        self._device.submit(self._device.disconnect())
        return True

    def restore_real_gps(self):
        self._motion.stop()
        ok = self._device.submit(self._device.clear(), 60)
        if ok:
            self.emit("toast", {"kind": "ok", "text": "Real GPS restored on the iPhone"})
        return ok

    def device_state(self):
        d = self._device
        return {"connected": d.connected, "info": d.info, "mode": d.mode, "engine": d.engine}

    def start_admin_tunnel(self):
        """Launch pymobiledevice3 tunneld elevated (needed only for iOS 17.0–17.3)."""
        if sys.platform != "win32":
            return {"ok": False, "error": "Windows only"}
        import ctypes

        if getattr(sys, "frozen", False):
            exe, params = sys.executable, "--pmd3-console remote tunneld"
        else:
            exe, params = sys.executable, f'"{os.path.abspath(__file__)}" --pmd3-console remote tunneld'
        rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, params, None, 1)
        return {"ok": rc > 32, "error": None if rc > 32 else "Admin permission was declined"}

    # ---------------------------------------------------------------- motion
    def teleport(self, lat, lon):
        self._motion.teleport(float(lat), float(lon))
        return True

    def start_route(self, points, speed_kmh=None, loop_mode=None):
        try:
            return {"ok": True, **self._motion.start_route(points, speed_kmh, loop_mode)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def pause(self, value):
        self._motion.pause(bool(value))
        return True

    def stop_motion(self):
        self._motion.stop()
        return True

    def seek(self, fraction):
        self._motion.seek(float(fraction))
        return True

    def joystick(self, dx, dy):
        self._motion.set_joystick(dx, dy)
        return True

    def configure(self, cfg: dict):
        self._motion.configure(**{k: cfg.get(k) for k in ("speed_kmh", "variance", "realistic", "interval",
                                                          "loop_mode")})
        return self._motion.state()

    def motion_state(self):
        return self._motion.state()

    # ---------------------------------------------------------------- GPX
    def import_gpx(self):
        res = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=("GPX files (*.gpx)", "All files (*.*)"))
        if not res:
            return None
        path = res[0]
        try:
            root = ET.parse(path).getroot()
            pts = []
            for el in root.iter():
                tag = el.tag.split("}")[-1]
                if tag in ("trkpt", "rtept", "wpt"):
                    pts.append((float(el.get("lat")), float(el.get("lon"))))
            if len(pts) < 1:
                return {"ok": False, "error": "No points found in this GPX file"}
            return {"ok": True, "name": Path(path).stem, "points": pts}
        except Exception as e:
            return {"ok": False, "error": f"Could not read GPX: {e}"}

    def export_gpx(self, points, name="Ghostpin route", speed_kmh=40):
        res = self._window.create_file_dialog(webview.SAVE_DIALOG, save_filename=f"{name}.gpx",
                                             file_types=("GPX files (*.gpx)",))
        if not res:
            return None
        path = res if isinstance(res, str) else res[0]
        v = max(1.0, float(speed_kmh)) / 3.6
        t = datetime.now(timezone.utc)
        gpx = ET.Element("gpx", version="1.1", creator=f"{APP_NAME} {VERSION}", xmlns="http://www.topografix.com/GPX/1/1")
        trk = ET.SubElement(gpx, "trk")
        ET.SubElement(trk, "name").text = name
        seg = ET.SubElement(trk, "trkseg")
        prev = None
        for lat, lon in points:
            if prev:
                t += timedelta(seconds=haversine(prev, (lat, lon)) / v)
            pt = ET.SubElement(seg, "trkpt", lat=f"{lat:.7f}", lon=f"{lon:.7f}")
            ET.SubElement(pt, "time").text = t.strftime("%Y-%m-%dT%H:%M:%SZ")
            prev = (lat, lon)
        ET.ElementTree(gpx).write(path, encoding="utf-8", xml_declaration=True)
        return {"ok": True, "path": path}

    def open_url(self, url):
        import webbrowser
        webbrowser.open(url)
        return True

    def shutdown(self):
        try:
            self._motion.stop()
            if self._device.connected and self.load_store().get("settings", {}).get("restoreOnExit"):
                self._device.submit(self._device.clear(), 10)
            self._device.submit(self._device.disconnect(silent=True), 5)
        except Exception:
            pass


def main():
    api = Api()
    logging.getLogger().addHandler(UiLogHandler(api))
    log.info("%s %s starting", APP_NAME, VERSION)
    window = webview.create_window(
        APP_NAME, url=resource("web", "index.html"), js_api=api,
        width=1360, height=860, min_size=(1040, 680), background_color="#0B0D12", text_select=False,
    )
    api._window = window
    window.events.closing += api.shutdown
    gui = "edgechromium" if sys.platform == "win32" else None
    webview.start(gui=gui, debug="--debug" in sys.argv, private_mode=False,
                  storage_path=str(data_dir() / "webview"))


if __name__ == "__main__":
    main()
