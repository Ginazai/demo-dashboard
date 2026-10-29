// Prompt for the in-browser LLM, the no-model fallback text and the grounding check (ES and EN). Classic script; global `Prompt`.
const Prompt = (() => {
  const SYSTEM = {
  "es": "Eres el asistente de un panel de mantenimiento predictivo de refrigeración. Recibes un JSON con cifras ya calculadas. Escribe en español un resumen para un cliente no técnico.\nReglas:\n- Usa solo las cifras del JSON y cópialas tal cual. No recalcules ni inventes datos.\n- No nombres ningún componente ni causa de falla. Una alerta significa 'conviene revisar', no falla confirmada.\n- margen <= 0: la ventana marca anomalía; margen > 0: está por encima del umbral (normal).\n- 'calentando': aún no hay historial suficiente para esa ventana.\n- descartada_xgb / pct_descartadas_xgb_1h: el primer modelo marcó la lectura y una segunda verificación (XGBoost) la descartó; no cuenta como alerta.\n- No inventes unidades; solo la temperatura va en °C.\n- Si estado_general es sin_datos o calentando, dilo y no concluyas nada más.\n- Si hay alerta, menciona en una frase la nota_modelo.\nFormato: máximo 120 palabras, tres párrafos cortos que empiezan exactamente con 'Estado.', 'Qué cambió.' y 'Qué vigilar.'. Sin viñetas, sin listas, sin emojis.",
  "en": "You are the assistant of a refrigeration predictive-maintenance dashboard. You receive a JSON with figures that were already computed. Write a summary in English for a non-technical customer.\nRules:\n- Use only the figures in the JSON and copy them exactly. Do not recalculate or invent data.\n- Do not name any component or failure cause. An alert means 'worth a look', not a confirmed fault.\n- margen <= 0: the window flags an anomaly; margen > 0: it is above the threshold (normal).\n- 'calentando' means warming up: not enough history yet for that window.\n- descartada_xgb / pct_descartadas_xgb_1h: the first model flagged the reading and a second check (XGBoost) discarded it; it does not count as an alert.\n- Do not invent units; only temperature is in °C.\n- If estado_general is sin_datos or calentando, say so and conclude nothing else.\n- If there is an alert, mention nota_modelo in one sentence.\nFormat: at most 120 words, three short paragraphs starting exactly with 'Status.', 'What changed.' and 'What to watch.'. No bullets, no lists, no emojis."
};
  const T = {
  "es": {
    "head": [
      "Estado.",
      "Qué cambió.",
      "Qué vigilar."
    ],
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
    "nota": "Nota: {n}."
  },
  "en": {
    "head": [
      "Status.",
      "What changed.",
      "What to watch."
    ],
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
    "nota": "Note: {n}."
  }
};
  const NOTA = { es: "alrededor de 10% de las lecturas normales pueden marcar alerta por diseño; una alerta significa conviene revisar, no falla confirmada", en: "about 10% of normal readings can raise an alert by design; an alert means worth a look, not a confirmed fault" };

  // Gemma has no system role: the rules go first in the user turn.
  const messages = (facts, lang) => [{ role: "user", content: SYSTEM[lang] + "\n\nDatos:\n" + JSON.stringify(facts) }];

  const NUM = /-?\d+(?:[.,]\d+)?/g;
  const norm = (s) => String(parseFloat(s.replace(",", ".")));

  /** Numbers that appear in the text but not in the facts block. */
  function ungrounded(text, facts) {
    const allowed = new Set((JSON.stringify(facts).match(NUM) || []).map(norm));
    return [...new Set((text.match(NUM) || []).filter((n) => !allowed.has(norm(n))))].sort();
  }

  const f1 = (x) => Number(x).toFixed(1);
  const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

  function fallback(facts, lang) {
    const t = T[lang], seg = facts.segmento, g = facts.estado_general, v = facts.ventanas_seleccionadas.join(", ");
    const nota = fill(t.nota, { n: NOTA[lang] });
    const cambios = Object.entries(facts.sensores).map(([id, s]) => ["normal", "atencion"].includes(s.estado)
      ? fill(t.sensor, { s: id, p: f1(s.pct_alerta_1h), m: s.margen_actual, r: s.lecturas_seguidas_en_alerta })
      : fill(t.sensor_calentando, { s: id }));
    const vigilar = fill(t["ver_" + g], { seg, nota: g === "atencion" ? nota : "" }).trim();
    const h = t.head;
    return `${h[0]} ${fill(t[g], { seg, v })}\n\n${h[1]} ${cambios.join(" ") || "-"}\n\n${h[2]} ${vigilar}`;
  }

  return { SYSTEM, messages, ungrounded, fallback };
})();
