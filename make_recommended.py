"""Builds web/data/recomendadas.js (tooltip data) from the last training run: logs/pipeline.log and stability_*.json.

Run after the pipeline:  python dashboard/make_recommended.py [--repo .]
Fails loudly if the log has no calibrated detection lines, so the UI never shows invented numbers.
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

LINEA = re.compile(r"\[(LT|MT)_(5min|15min|1h)\] deteccion_calibrada=([\d.]+)%.*?n_falla=(\d+) confiable=(True|False)")
HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, default=HERE.parent)
    ap.add_argument("--salida", type=Path, default=HERE / "web" / "data" / "recomendadas.js")
    args = ap.parse_args()
    log = args.repo / "logs" / "pipeline.log"
    if not log.exists():
        sys.exit(f"ERROR: {log} not found; run the pipeline (src/evaluate_model.py) first")
    ultimo = {}                                            # last line per (segment, window) = latest run
    for linea in log.read_text(encoding="utf-8", errors="replace").splitlines():
        m = LINEA.search(linea)
        if m:
            ultimo[(m[1], m[2])] = (float(m[3]), int(m[4]), m[5] == "True")
    if not ultimo:
        sys.exit(f"ERROR: no 'deteccion_calibrada' lines in {log}")
    out = {}
    for (seg, w), (det, n, confiable) in sorted(ultimo.items()):
        est = args.repo / "data" / "processed" / f"stability_{seg}_{w}.json"
        rango = None
        if est.exists():
            s = json.loads(est.read_text(encoding="utf-8"))
            if "deteccion_min" in s:
                rango = {"min": round(100 * s["deteccion_min"], 1), "max": round(100 * s["deteccion_max"], 1),
                         "media": round(100 * s["deteccion_mean"], 1), "repeticiones": s["n_repeticiones"]}
        out.setdefault(seg, {"ventanas": {}})["ventanas"][w] = {
            "deteccion": det, "n_falla": n, "muestra_confiable": confiable, "rango": rango}
    for seg, d in out.items():
        d["mejor"] = max(d["ventanas"], key=lambda w: d["ventanas"][w]["deteccion"])
    out["_fuente"] = {"log": str(log), "generado": date.today().isoformat()}
    args.salida.parent.mkdir(parents=True, exist_ok=True)
    args.salida.write_text("window.AIOROS_REC = " + json.dumps(out, indent=2, ensure_ascii=False) + ";\n", encoding="utf-8")
    print(f"{sum(len(v['ventanas']) for k, v in out.items() if k[0] != '_')} windows -> {args.salida}")


if __name__ == "__main__":
    main()
