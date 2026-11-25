"""Audiveris OMR HTTP wrapper.

POST /omr  {images: [dataURL...]} -> {musicxml: str, warnings?: [str]}
GET  /health
Env: OMR_TOKEN (optional shared secret, header X-OMR-Token), AUDIVERIS_CMD,
     OMR_TIMEOUT (seconds per image, default 240), MAX_BYTES (default 10MB).
"""
import base64
import hmac
import io
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from flask import Flask, jsonify, request

MAX_BYTES = int(os.environ.get("MAX_BYTES", 10 * 1024 * 1024))
TIMEOUT = int(os.environ.get("OMR_TIMEOUT", "240"))
MAX_PAGES = 6
AUDIVERIS_CMD = os.environ.get("AUDIVERIS_CMD", "Audiveris")
TOKEN = os.environ.get("OMR_TOKEN", "")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES

DATA_URL = re.compile(r"^data:image/(png|jpeg|jpg|webp|tiff|bmp);base64,(.*)$", re.S)


def err(msg, code):
    return jsonify({"error": msg}), code


def run_audiveris(img: Path, out: Path) -> list:
    cmd = [AUDIVERIS_CMD, "-batch", "-export", "-output", str(out), str(img)]
    try:
        subprocess.run(cmd, capture_output=True, timeout=TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Audiveris timed out")
    except FileNotFoundError:
        raise RuntimeError("Audiveris executable not found")
    return sorted(out.rglob("*.mxl")) + sorted(out.rglob("*.musicxml"))


def read_score(path: Path) -> str:
    if path.suffix == ".mxl":
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.endswith(".xml") and not n.startswith("META-INF")]
            if not names:
                raise RuntimeError("empty .mxl")
            return z.read(names[0]).decode("utf-8")
    return path.read_text("utf-8")


def merge(xmls: list) -> str:
    """Append measures of later scores onto the first score's parts (by index)."""
    if len(xmls) == 1:
        return xmls[0]
    # strip DOCTYPE so ElementTree can parse; re-add header on output
    def parse(x):
        return ET.fromstring(re.sub(r"<!DOCTYPE[^>]*>", "", x).encode("utf-8"))
    base = parse(xmls[0])
    bparts = base.findall("part")
    last = [len(p.findall("measure")) for p in bparts]
    for x in xmls[1:]:
        for i, p in enumerate(parse(x).findall("part")):
            if i >= len(bparts):
                break
            for m in p.findall("measure"):
                last[i] += 1
                m.set("number", str(last[i]))
                bparts[i].append(m)
    body = ET.tostring(base, encoding="unicode")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + body


@app.get("/health")
def health():
    ok = shutil.which(AUDIVERIS_CMD) is not None or Path(AUDIVERIS_CMD).exists()
    return jsonify({"ok": True, "audiveris": ok})


@app.post("/omr")
def omr():
    if TOKEN and not hmac.compare_digest(request.headers.get("X-OMR-Token", ""), TOKEN):
        return err("unauthorized", 401)
    body = request.get_json(silent=True)
    imgs = body.get("images") if isinstance(body, dict) else None
    if not isinstance(imgs, list) or not imgs:
        return err("images[] required", 400)
    if len(imgs) > MAX_PAGES:
        return err(f"max {MAX_PAGES} pages", 400)
    work = Path(tempfile.mkdtemp(prefix="omr-"))
    try:
        xmls, warnings = [], []
        for i, d in enumerate(imgs):
            m = DATA_URL.match(d) if isinstance(d, str) else None
            if not m:
                return err(f"image {i} is not a base64 image data URL", 400)
            try:
                raw = base64.b64decode(m.group(2), validate=False)
            except Exception:
                return err(f"image {i} bad base64", 400)
            if len(raw) > MAX_BYTES:
                return err("image too large", 413)
            ext = "jpg" if m.group(1) in ("jpeg", "jpg") else m.group(1)
            page = work / f"page{i + 1}"
            out = page / "out"
            out.mkdir(parents=True)
            f = page / f"page{i + 1}.{ext}"
            f.write_bytes(raw)
            try:
                results = run_audiveris(f, out)
            except RuntimeError as e:
                return err(str(e), 504 if "timed out" in str(e) else 500)
            if not results:
                warnings.append(f"page {i + 1}: no music recognized")
                continue
            if len(results) > 1:
                warnings.append(f"page {i + 1}: {len(results)} movements, merged")
            xmls.extend(read_score(r) for r in results)
        if not xmls:
            return err("Audiveris recognized no music", 422)
        try:
            xml = merge(xmls)
        except ET.ParseError:
            xml = xmls[0]
            warnings.append("merge failed; returned first page only")
        res = {"musicxml": xml}
        if warnings:
            res["warnings"] = warnings
        return jsonify(res)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
