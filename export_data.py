"""Turns one scorer run into a static data file the page can load (no server needed).

  python dashboard/export_data.py --nombre ornl-2019 \
      --modelos data/processed --sensores edge/sensores.yaml --replay data/processed/replay.csv

Runs edge/scorer.py with --velocidad 0 (no waiting), joins the raw readings from the replay CSV, DROPS the fault labels
(replay.es_falla / id_corrida) and the scorer's own alert flag, and writes dashboard/web/data/<nombre>.js plus the index.
Data files you copied into web/data by hand (or an index.js that got overwritten): python dashboard/export_data.py --reindex
Already have scorer output (scorer.py --salida x.jsonl)? Pass --desde-jsonl x.jsonl --replay replay.csv instead.
"""
import argparse
import csv
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
VARIABLES = ("temperatura", "humedad", "energia", "presion_succion", "presion_liquido", "sobrecalentamiento")
DATA = HERE / "web" / "data"


def valores(replay: Path) -> dict:
    out = {}
    with open(replay, newline="", encoding="utf-8") as f:
        for fila in csv.DictReader(f):
            k = (fila["equipo_id"], datetime.fromisoformat(fila["timestamp"]).isoformat())
            out[k] = {v: (float(fila[v]) if fila.get(v) not in (None, "") else None) for v in VARIABLES}
    return out


def eventos(args) -> list[dict]:
    if args.desde_jsonl:
        lineas = args.desde_jsonl.read_text(encoding="utf-8").splitlines()
    else:
        cmd = [sys.executable, str(args.repo / "edge" / "scorer.py"), "--modelos", str(args.modelos), "--sensores", str(args.sensores),
               "--replay", str(args.replay), "--velocidad", "0"]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=args.repo)
        if r.returncode:
            sys.exit(f"ERROR: scorer failed ({r.returncode}):\n{r.stderr[-2000:]}")
        lineas = r.stdout.splitlines()
    out = []
    for l in lineas:
        try:
            out.append(json.loads(l))
        except ValueError:
            continue
    if not out:
        sys.exit("ERROR: the scorer produced no events (check that the sensors file maps sensors present in the replay)")
    return out


def rebuild_index() -> None:
    items = []
    for f in sorted(DATA.glob("*.js")):
        if f.name in ("index.js", "recomendadas.js"):
            continue
        m = re.search(r"\.meta = (\{.*?\});\n", f.read_text(encoding="utf-8")[:4000])
        if m:
            items.append(json.loads(m[1]))
    (DATA / "index.js").write_text("window.AIOROS_INDEX = " + json.dumps(items, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, default=HERE.parent)
    ap.add_argument("--nombre", help="file id, e.g. ornl-2019 (letters, digits, dash)")
    ap.add_argument("--reindex", action="store_true", help="only rebuild web/data/index.js from the data files already there")
    ap.add_argument("--etiqueta", help="name shown in the page (default: nombre)")
    ap.add_argument("--modelos", type=Path, default=Path("data/processed"))
    ap.add_argument("--sensores", type=Path, default=Path("edge/sensores.yaml"))
    ap.add_argument("--replay", type=Path, default=Path("data/processed/replay.csv"))
    ap.add_argument("--desde-jsonl", type=Path)
    args = ap.parse_args()
    if args.reindex:
        rebuild_index()
        print(f"index rebuilt: {DATA / 'index.js'}")
        return
    if not args.nombre:
        sys.exit("ERROR: --nombre is required (or use --reindex)")
    if not re.fullmatch(r"[A-Za-z0-9-]+", args.nombre):
        sys.exit("ERROR: --nombre may only contain letters, digits and '-'")
    for k in ("modelos", "sensores", "replay"):
        p = getattr(args, k)
        setattr(args, k, p if p.is_absolute() else args.repo / p)
    vals = valores(args.replay)
    evs = []
    for e in eventos(args):
        e.pop("replay", None)                    # fault labels never reach the page
        e.pop("alerta", None)                    # the page recomputes the alert from the windows the user picks
        e["valores"] = vals.get((e["equipo_id"], datetime.fromisoformat(e["timestamp"]).isoformat()), {})
        evs.append(e)
    evs.sort(key=lambda e: e["timestamp"])
    meta = {"id": args.nombre, "etiqueta": args.etiqueta or args.nombre, "segmentos": sorted({e["segmento"] for e in evs}),
            "sensores": sorted({e["equipo_id"] for e in evs}), "n": len(evs), "desde": evs[0]["timestamp"], "hasta": evs[-1]["timestamp"]}
    DATA.mkdir(parents=True, exist_ok=True)
    cuerpo = json.dumps(evs, ensure_ascii=False, separators=(",", ":"))
    (DATA / f"{args.nombre}.js").write_text(
        f'(window.AIOROS_DATA = window.AIOROS_DATA || {{}})["{args.nombre}"] = {{}};\n'
        f'window.AIOROS_DATA["{args.nombre}"].meta = {json.dumps(meta, ensure_ascii=False)};\n'
        f'window.AIOROS_DATA["{args.nombre}"].eventos = {cuerpo};\n', encoding="utf-8")
    rebuild_index()
    print(f"{len(evs)} events ({', '.join(meta['segmentos'])}) -> {DATA / (args.nombre + '.js')}")


if __name__ == "__main__":
    main()
