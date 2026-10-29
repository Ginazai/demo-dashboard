"""Facts/prompt parity: the browser code (web/facts.js, web/prompt.js) must give the same output as the reference Python
(tests/reference/) on the synthetic stream. Run: python dashboard/tests/parity.py   (needs node)"""
import json
import subprocess
import sys
from pathlib import Path

T = Path(__file__).resolve().parent
sys.path.insert(0, str(T / "reference")); sys.path.insert(0, str(T))
import facts as F
import prompt as P
import synthetic as S

TODAS = ("5min", "15min", "1h")
filas = {(f["equipo_id"], f["timestamp"].replace(" ", "T")): f for f in S.filas_csv()}
ev = []
for e in S.eventos():
    e = {k: v for k, v in e.items() if k != "replay"}
    f = filas[(e["equipo_id"], e["timestamp"])]
    e["valores"] = {k: (float(f[k]) if f[k] != "" else None) for k in F.VARIABLES}
    ev.append(e)

# extra sensor whose readings are years/days away from the rest (mixed periods in one data file)
viejo = [dict(e, equipo_id="ORNL_MT_VIEJO", timestamp=e["timestamp"].replace("2026-01-01", "2025-12-20")) for e in ev if e["equipo_id"] == "ORNL_MT"]
ev = ev + viejo
casos = []
for seg in ("LT", "MT"):
    for sel in (TODAS, ("1h",), ("5min",), ("5min", "1h")):
        for n in (0, 1, 3, 12, 25, 33, 40, 55, 144):
            evs = sorted((e for e in ev if e["segmento"] == seg), key=lambda e: e["timestamp"])
            evs = evs[:n] if n < 144 else evs
            esperado = F.facts(evs, seg, sel)
            casos.append({"events": evs, "seg": seg, "sel": list(sel), "facts": esperado,
                          "es": P.fallback(esperado, "es"), "en": P.fallback(esperado, "en"),
                          "inv": P.ungrounded("llegó a 99,9 y 12 lecturas", esperado)})
(T / "_parity.json").write_text(json.dumps(casos))
js = f"""
const fs = require("fs"), vm = require("vm");
const ctx = {{}}; vm.createContext(ctx);
for (const f of ["facts.js", "prompt.js"]) vm.runInContext(fs.readFileSync("{T.parent / 'web'}/" + f, "utf8").replace(/^const (Facts|Prompt)/m, "this.$1"), ctx);
const assert = require("assert");
const casos = JSON.parse(fs.readFileSync("{T / '_parity.json'}", "utf8"));
for (const [i, c] of casos.entries()) {{
  const got = ctx.Facts.facts(c.events, c.seg, c.sel);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(got)), c.facts, "facts case " + i);
  for (const l of ["es", "en"]) assert.strictEqual(ctx.Prompt.fallback(got, l), c[l], l + " fallback case " + i);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.Prompt.ungrounded("llegó a 99,9 y 12 lecturas", got))), c.inv, "ungrounded case " + i);
}}
console.log("parity: OK (" + casos.length + " cases)");
"""
r = subprocess.run(["node", "-e", js], capture_output=True, text=True)
(T / "_parity.json").unlink()
print(r.stdout + r.stderr, end="")
sys.exit(r.returncode)
