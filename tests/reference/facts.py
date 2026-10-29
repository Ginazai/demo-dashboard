"""Facts block: scorer events -> small dict of figures. Pure and deterministic.

Every number the AI summary may quote is computed here; the LLM only words them.
Event shape (scorer output plus "valores" joined by the server from the replay CSV):
  {"timestamp", "equipo_id", "segmento",
   "ventanas": {"5min": {"score", "umbral", "anomalia"}, ...},   # only windows with enough history
   "valores": {"temperatura": float | None, ...}}
Fault labels ("replay"/"es_falla") must never reach this module; the server strips them.
"""

from datetime import datetime, timedelta


def _sum(xs):
    """Plain left-to-right float sum, like the JS port (Python 3.12 sum() is compensated and differs in the last digit)."""
    t = 0.0
    for x in xs:
        t += x
    return t

VENTANAS = ("5min", "15min", "1h")
# subenfriamiento / eer are 100% empty in the ORNL data (ADR-014), so they are never reported.
VARIABLES = ("temperatura", "humedad", "energia", "presion_succion", "presion_liquido", "sobrecalentamiento")
NOTA_MODELO = "alrededor de 10% de las lecturas normales pueden marcar alerta por diseño; una alerta significa conviene revisar, no falla confirmada"
EPS_TENDENCIA = 0.005  # ponytail: fixed margin delta; derive from threshold scale if scores differ a lot per segment
PRIORIDAD = {"atencion": 3, "normal": 2, "calentando": 1, "sin_datos": 0}


def _ts(e: dict) -> datetime:
    return datetime.fromisoformat(e["timestamp"])


def _listas(e: dict, sel) -> list[str]:
    return [w for w in sel if w in e["ventanas"]]


def _margen(r: dict) -> float:
    return r["score"] - (r["umbral"] if r["umbral"] is not None else 0.0)


def if_flag(e: dict, sel) -> bool:
    """The Isolation Forest alone flagged it (score <= calibrated threshold), before the XGBoost confirmation step."""
    return any(e["ventanas"][w]["umbral"] is not None and e["ventanas"][w]["score"] <= e["ventanas"][w]["umbral"] for w in _listas(e, sel))


def alerta(e: dict, sel) -> bool:
    """Alert rule of the page: any selected window flags an anomaly."""
    return any(e["ventanas"][w]["anomalia"] for w in _listas(e, sel))


def margen_min(e: dict, sel) -> float | None:
    ms = [_margen(e["ventanas"][w]) for w in _listas(e, sel)]
    return min(ms) if ms else None


def _tendencia(margenes: list[float]) -> str:
    if len(margenes) < 6:
        return "insuficiente"
    t = len(margenes) // 3
    delta = _sum(margenes[-t:]) / t - _sum(margenes[:t]) / t
    if delta < -EPS_TENDENCIA:
        return "acercandose_al_umbral"
    if delta > EPS_TENDENCIA:
        return "alejandose_del_umbral"
    return "estable"


def sensor_facts(events: list[dict], sel, now: datetime | None = None) -> dict:
    if not events:
        return {"estado": "sin_datos"}
    ultimo = events[-1]
    now = now or _ts(ultimo)
    hora = [e for e in events if timedelta(0) <= now - _ts(e) < timedelta(hours=1)]
    if not hora:
        return {"estado": "sin_datos"}            # this sensor has nothing in the last hour of data (e.g. another period)
    listos = [e for e in hora if _listas(e, sel)]
    pendientes = [w for w in sel if w not in ultimo["ventanas"]]
    if not _listas(ultimo, sel):
        return {"estado": "calentando", "ventanas_pendientes": pendientes}

    flags = [alerta(e, sel) for e in listos]
    racha = 0
    for f in reversed(flags):
        if not f:
            break
        racha += 1
    margenes = [margen_min(e, sel) for e in listos]
    ventanas = {}
    for w in sel:
        if w not in ultimo["ventanas"]:
            ventanas[w] = {"estado": "calentando"}
            continue
        r = ultimo["ventanas"][w]
        propias = [e["ventanas"][w]["anomalia"] for e in hora if w in e["ventanas"]]
        ventanas[w] = {
            "estado": "anomalia" if r["anomalia"] else "normal",
            "margen": round(_margen(r), 4),
            "pct_alerta_1h": round(100 * sum(propias) / len(propias), 1),
            "descartada_xgb": r["umbral"] is not None and r["score"] <= r["umbral"] and not r["anomalia"],
        }
    variables = {}
    for v in VARIABLES:
        vals = [e["valores"][v] for e in hora if e.get("valores") and e["valores"].get(v) is not None]
        if vals:
            variables[v] = {
                "actual": round(vals[-1], 2),
                "media_1h": round(_sum(vals) / len(vals), 2),
                "min_1h": round(min(vals), 2),
                "max_1h": round(max(vals), 2),
            }
    out = {
        "estado": "atencion" if flags[-1] else "normal",
        "lecturas_1h": len(listos),
        "pct_alerta_1h": round(100 * sum(flags) / len(flags), 1),
        "pct_descartadas_xgb_1h": round(100 * sum(if_flag(e, sel) and not f for e, f in zip(listos, flags)) / len(flags), 1),
        "lecturas_seguidas_en_alerta": racha,
        "margen_actual": round(margenes[-1], 4),
        "tendencia_margen": _tendencia(margenes),
        "ventanas": ventanas,
        "variables": variables,
    }
    if pendientes:
        out["ventanas_pendientes"] = pendientes
    return out


def facts(events: list[dict], segmento: str, sel) -> dict:
    sel = [w for w in VENTANAS if w in set(sel)]
    por_sensor: dict[str, list[dict]] = {}
    for e in events:
        if e["segmento"] == segmento:
            por_sensor.setdefault(e["equipo_id"], []).append(e)
    now = max((_ts(evs[-1]) for evs in por_sensor.values()), default=None)
    sensores = {eid: sensor_facts(evs, sel, now) for eid, evs in sorted(por_sensor.items())}
    general = max((s["estado"] for s in sensores.values()), key=PRIORIDAD.get, default="sin_datos")
    return {
        "segmento": segmento,
        "ventanas_seleccionadas": sel,
        "hora_datos": now.isoformat() if now else None,
        "estado_general": general,
        "sensores": sensores,
        "nota_modelo": NOTA_MODELO,
    }
