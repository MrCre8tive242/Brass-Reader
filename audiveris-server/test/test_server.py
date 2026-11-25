"""Plumbing test. Uses real Audiveris if AUDIVERIS_CMD is set/found, else a stub that emits a fake .mxl."""
import base64, io, os, shutil, stat, sys, tempfile, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

real = shutil.which(os.environ.get("AUDIVERIS_CMD", "Audiveris"))
if not real:
    d = tempfile.mkdtemp()
    stub = os.path.join(d, "Audiveris")
    open(stub, "w").write('''#!/usr/bin/env python3
import sys, zipfile
a = sys.argv; out = a[a.index("-output")+1]; img = a[-1]
x = '<?xml version="1.0"?><score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>'
zipfile.ZipFile(out + "/score.mxl", "w").writestr("score.xml", x)
''')
    os.chmod(stub, 0o755)
    os.environ["AUDIVERIS_CMD"] = stub
    print("MODE: STUB (real Audiveris not available) - plumbing only")
else:
    os.environ["AUDIVERIS_CMD"] = real
    print("MODE: real Audiveris")

import server
c = server.app.test_client()
png = "data:image/png;base64," + base64.b64encode(b"\x89PNG fake").decode()
assert c.get("/health").json["ok"]
assert c.post("/omr", json={}).status_code == 400
r = c.post("/omr", json={"images": [png, png]})
print(r.status_code, r.json if r.status_code != 200 else f"measures={r.json['musicxml'].count('<measure')}")
if not real:
    assert r.status_code == 200 and r.json["musicxml"].count("<measure") == 2
server.TOKEN = "s"
assert c.post("/omr", json={"images": [png]}).status_code == 401
assert c.post("/omr", json={"images": [png]}, headers={"X-OMR-Token": "s"}).status_code in (200, 422)
print("OK")
