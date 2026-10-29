"""Prompt for the local LLM, the no-LLM fallback text, and the grounding check (ES and EN)."""

import json
import re

SYSTEM = {
    "es": (
        "Eres el asistente de un panel de mantenimiento predictivo de refrigeración. "
        "Recibes un JSON con cifras ya calculadas. Escribe en español un resumen para un cliente no técnico.\n"
        "Reglas:\n"
        "- Usa solo las cifras del JSON y cópialas tal cual. No recalcules ni inventes datos.\n"
        "- No nombres ningún componente ni causa de falla. Una alerta significa 'conviene revisar', no falla confirmada.\n"
        "- margen <= 0: la ventana marca anomalía; margen > 0: está por encima del umbral (normal).\n"
        "- 'calentando': aún no hay historial suficiente para esa ventana.\n"
        "- descartada_xgb / pct_descartadas_xgb_1h: el primer modelo marcó la lectura y una segunda verificación (XGBoost) la descartó; no cuenta como alerta.\n"
        "- No inventes unidades; solo la temperatura va en °C.\n"
        "- Si estado_general es sin_datos o calentando, dilo y no concluyas nada más.\n"
        "- Si hay alerta, menciona en una frase la nota_modelo.\n"
        "Formato: máximo 120 palabras, tres párrafos cortos que empiezan exactamente con "
        "'Estado.', 'Qué cambió.' y 'Qué vigilar.'. Sin viñetas, sin listas, sin emojis."
    ),
    "en": (
        "You are the assistant of a refrigeration predictive-maintenance dashboard. "
        "You receive a JSON with figures that were already computed. Write a summary in English for a non-technical customer.\n"
        "Rules:\n"
        "- Use only the figures in the JSON and copy them exactly. Do not recalculate or invent data.\n"
        "- Do not name any component or failure cause. An alert means 'worth a look', not a confirmed fault.\n"
        "- margen <= 0: the window flags an anomaly; margen > 0: it is above the threshold (normal).\n"
        "- 'calentando' means warming up: not enough history yet for that window.\n"
        "- descartada_xgb / pct_descartadas_xgb_1h: the first model flagged the reading and a second check (XGBoost) discarded it; it does not count as an alert.\n"
        "- Do not invent units; only temperature is in °C.\n"
        "- If estado_general is sin_datos or calentando, say so and conclude nothing else.\n"
        "- If there is an alert, mention nota_modelo in one sentence.\n"
        "Format: at most 120 words, three short paragraphs starting exactly with "
        "'Status.', 'What changed.' and 'What to watch.'. No bullets, no lists, no emojis."
    ),
}

NUM = re.compile(r"-?\d+(?:[.,]\d+)?")


def messages(facts: dict, lang: str) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM[lang]},
        {"role": "user", "content": "Datos:\n" + json.dumps(facts, ensure_ascii=False)},
    ]


def _num(s: str) -> str:
    x = float(s.replace(",", "."))
    return f"{x:g}"


def ungrounded(text: str, facts: dict) -> list[str]:
    """Numbers that appear in the text but not in the facts block."""
    allowed = {_num(n) for n in NUM.findall(json.dumps(facts, ensure_ascii=False))}
    return sorted({n for n in NUM.findall(text) if _num(n) not in allowed})


# ---- fallback (no model): fixed sentences filled from the same facts ----

T = {
    "es": {
        "head": ("Estado.", "Qué cambió.", "Qué vigilar."),
        "sin_datos": "Todavía no hay lecturas para el sistema {seg}. Pulsa Ejecutar para iniciar la reproducción.",
        "calentando": "Sistema {seg}: las ventanas seleccionadas ({v}) aún no tienen historial suficiente. Hay que esperar a que se complete.",
        "normal": "Sistema {seg}, ventanas {v}: sin alerta en la última lectura.",
        "atencion": "Sistema {seg}, ventanas {v}: hay una alerta en la última lectura. Conviene revisar.",
        "sensor": "{s}: {p}% de las lecturas de la última hora marcaron alerta; margen actual {m}; {r} lecturas seguidas en alerta.",
        "sensor_calentando": "{s}: calentando, sin historial suficiente.",
        "ver_normal": "Sin acciones por ahora; seguir observando.",
        "ver_atencion": "Revisar el sistema {seg} y seguir la evolución del margen. {nota}",
        "ver_calentando": "Esperar a que las ventanas tengan historial.",
        "ver_sin_datos": "Iniciar la reproducción.",
        "nota": "Nota: {n}.",
    },
    "en": {
        "head": ("Status.", "What changed.", "What to watch."),
        "sin_datos": "There are no readings yet for system {seg}. Press Run to start the replay.",
        "calentando": "System {seg}: the selected windows ({v}) do not have enough history yet. Wait for them to fill.",
        "normal": "System {seg}, windows {v}: no alert on the latest reading.",
        "atencion": "System {seg}, windows {v}: there is an alert on the latest reading. Worth a look.",
        "sensor": "{s}: {p}% of the readings in the last hour flagged an alert; current margin {m}; {r} readings in a row in alert.",
        "sensor_calentando": "{s}: warming up, not enough history.",
        "ver_normal": "No action for now; keep observing.",
        "ver_atencion": "Check system {seg} and follow how the margin evolves. {nota}",
        "ver_calentando": "Wait for the windows to fill.",
        "ver_sin_datos": "Start the replay.",
        "nota": "Note: {n}.",
    },
}
NOTA_EN = "about 10% of normal readings can raise an alert by design; an alert means worth a look, not a confirmed fault"
NOTA_ES = "alrededor de 10% de las lecturas normales pueden marcar alerta por diseño; una alerta significa conviene revisar, no falla confirmada"


def fallback(facts: dict, lang: str) -> str:
    t = T[lang]
    seg, g = facts["segmento"], facts["estado_general"]
    v = ", ".join(facts["ventanas_seleccionadas"])
    nota = t["nota"].format(n=NOTA_ES if lang == "es" else NOTA_EN)
    estado = t[g].format(seg=seg, v=v)
    cambios = []
    for eid, s in facts["sensores"].items():
        if s["estado"] in ("normal", "atencion"):
            cambios.append(t["sensor"].format(s=eid, p=s["pct_alerta_1h"], m=s["margen_actual"], r=s["lecturas_seguidas_en_alerta"]))
        else:
            cambios.append(t["sensor_calentando"].format(s=eid))
    vigilar = t["ver_" + g].format(seg=seg, nota=nota if g == "atencion" else "").strip()
    h = t["head"]
    return f"{h[0]} {estado}\n\n{h[1]} {' '.join(cambios) or '-'}\n\n{h[2]} {vigilar}"
