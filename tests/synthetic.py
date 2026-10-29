"""Synthetic scorer-shaped events for tests (NOT real ORNL data): 2 sensors x 6 h, one alert episode each.

Mimics edge/scorer.py: the 5min window is ready at tick 0, 15min at tick 2, 1h at tick 11;
an event carries "replay" (fault labels) like the real scorer does, so tests can check it is stripped.
Run `python tests/synthetic.py out.csv` to write the matching replay CSV.
"""
import csv
import random
import sys
from datetime import datetime, timedelta

PASO = timedelta(minutes=5)
INICIO = datetime(2026, 1, 1)
TICKS = 72
UMBRAL = {"5min": 0.010, "15min": 0.022, "1h": -0.120}
LISTA = {"5min": 0, "15min": 2, "1h": 11}
SENSORES = {"ORNL_LT": ("LT", -19.0, 0.04, 30, 46), "ORNL_MT": ("MT", 7.0, 0.07, 40, 52)}


def _margen(i: int, base: float, ini: int, fin: int, w: str) -> float:
    retraso = {"5min": 0, "15min": 2, "1h": 6}[w]
    if ini + retraso <= i < fin:            # alert episode: margin dips below 0, short windows first
        return -0.03 - 0.01 * (i - ini - retraso)
    return base


def eventos(seed: int = 42) -> list[dict]:
    rng = random.Random(seed)
    out = []
    for i in range(TICKS):
        t = INICIO + i * PASO
        for eid, (seg, _, base, ini, fin) in SENSORES.items():
            vent = {}
            for w in UMBRAL:
                if i >= LISTA[w]:
                    m = _margen(i, base + rng.uniform(-0.01, 0.01), ini, fin, w)
                    anomalia = m <= 0
                    if eid == "ORNL_LT" and w == "5min" and 20 <= i < 24:    # first model flags it, the XGBoost step discards it
                        m, anomalia = -0.02, False
                    vent[w] = {"score": round(UMBRAL[w] + m, 6), "umbral": UMBRAL[w], "anomalia": anomalia, "imputadas": 0}
            out.append({"timestamp": t.isoformat(), "equipo_id": eid, "segmento": seg,
                        "alerta": any(r["anomalia"] for r in vent.values()), "ventanas": vent,
                        "replay": {"id_corrida": "SINTETICA", "es_falla": "1" if ini <= i < fin else "0"}})
    return out


def filas_csv(seed: int = 7) -> list[dict]:
    rng = random.Random(seed)
    filas = []
    for i in range(TICKS):
        t = INICIO + i * PASO
        for eid, (_, temp, _, ini, fin) in SENSORES.items():
            subida = 0.4 * max(0, min(i, fin) - ini) if i >= ini else 0.0
            filas.append({"timestamp": t.strftime("%Y-%m-%d %H:%M:%S"), "equipo_id": eid, "id_corrida": "SINTETICA",
                          "es_falla": "1" if ini <= i < fin else "0",
                          "temperatura": round(temp + subida + rng.uniform(-0.3, 0.3), 2), "humedad": "",
                          "energia": round(2.0 + rng.uniform(-0.1, 0.1), 2),
                          "presion_succion": round(3.0 + rng.uniform(-0.05, 0.05), 2),
                          "presion_liquido": round(14.0 + rng.uniform(-0.2, 0.2), 2),
                          "sobrecalentamiento": round(8.0 + rng.uniform(-0.3, 0.3), 2),
                          "subenfriamiento": "", "eer": ""})
    return filas


if __name__ == "__main__":
    filas = filas_csv()
    with open(sys.argv[1], "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(filas[0]))
        w.writeheader()
        w.writerows(filas)
    print(f"{len(filas)} filas -> {sys.argv[1]}")
