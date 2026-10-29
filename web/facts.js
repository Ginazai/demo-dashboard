// Facts block: scorer events -> small object of figures. Pure and deterministic; the AI summary only words these numbers.
// Event: {timestamp, equipo_id, segmento, ventanas: {"5min": {score, umbral, anomalia}, ...}, valores: {temperatura, ...}}
// Windows appear only once there is enough history. Fault labels are removed by export_data.py and never reach the page.
// Classic script (works from file://): everything lives under the global `Facts`.
const Facts = (() => {
  const VENTANAS = ["5min", "15min", "1h"];
  // subenfriamiento / eer are 100% empty in the ORNL data (ADR-014), so they are never reported.
  const VARIABLES = ["temperatura", "humedad", "energia", "presion_succion", "presion_liquido", "sobrecalentamiento"];
  const NOTA_MODELO = "alrededor de 10% de las lecturas normales pueden marcar alerta por diseño; una alerta significa conviene revisar, no falla confirmada";
  const EPS_TENDENCIA = 0.005;
  const PRIORIDAD = { atencion: 3, normal: 2, calentando: 1, sin_datos: 0 };
  const HORA = 3600e3;

  const ts = (e) => new Date(e.timestamp).getTime();
  const listas = (e, sel) => sel.filter((w) => e.ventanas[w]);
  const margenDe = (r) => r.score - (r.umbral ?? 0);
  const round = (x, d) => Number(x.toFixed(d));   // exact-value rounding, same as Python round()
  /** The Isolation Forest alone flagged it (score <= calibrated threshold), before the XGBoost confirmation step. */
  const ifFlag = (e, sel) => listas(e, sel).some((w) => e.ventanas[w].umbral !== null && e.ventanas[w].score <= e.ventanas[w].umbral);
  const alerta = (e, sel) => listas(e, sel).some((w) => e.ventanas[w].anomalia);
  const margenMin = (e, sel) => { const ms = listas(e, sel).map((w) => margenDe(e.ventanas[w])); return ms.length ? Math.min(...ms) : null; };
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

  function tendencia(m) {
    if (m.length < 6) return "insuficiente";
    const t = Math.floor(m.length / 3), d = avg(m.slice(-t)) - avg(m.slice(0, t));
    return d < -EPS_TENDENCIA ? "acercandose_al_umbral" : d > EPS_TENDENCIA ? "alejandose_del_umbral" : "estable";
  }

  function sensorFacts(events, sel, now) {
    if (!events.length) return { estado: "sin_datos" };
    const ultimo = events[events.length - 1];
    now = now ?? ts(ultimo);
    const hora = events.filter((e) => now - ts(e) >= 0 && now - ts(e) < HORA);
    if (!hora.length) return { estado: "sin_datos" };            // this sensor has nothing in the last hour of data (e.g. another period)
    const listos = hora.filter((e) => listas(e, sel).length);
    const pendientes = sel.filter((w) => !ultimo.ventanas[w]);
    if (!listas(ultimo, sel).length) return { estado: "calentando", ventanas_pendientes: pendientes };

    const flags = listos.map((e) => alerta(e, sel));
    let racha = 0;
    for (let i = flags.length - 1; i >= 0 && flags[i]; i--) racha++;
    const margenes = listos.map((e) => margenMin(e, sel));
    const ventanas = {};
    for (const w of sel) {
      if (!ultimo.ventanas[w]) { ventanas[w] = { estado: "calentando" }; continue; }
      const r = ultimo.ventanas[w], propias = hora.filter((e) => e.ventanas[w]).map((e) => e.ventanas[w].anomalia);
      ventanas[w] = { estado: r.anomalia ? "anomalia" : "normal", margen: round(margenDe(r), 4), pct_alerta_1h: round(100 * propias.filter(Boolean).length / propias.length, 1), descartada_xgb: r.umbral !== null && r.score <= r.umbral && !r.anomalia };
    }
    const variables = {};
    for (const v of VARIABLES) {
      const vals = hora.map((e) => e.valores?.[v]).filter((x) => x !== null && x !== undefined);
      if (vals.length) variables[v] = { actual: round(vals[vals.length - 1], 2), media_1h: round(avg(vals), 2), min_1h: round(Math.min(...vals), 2), max_1h: round(Math.max(...vals), 2) };
    }
    const out = {
      estado: flags[flags.length - 1] ? "atencion" : "normal",
      lecturas_1h: listos.length,
      pct_alerta_1h: round(100 * flags.filter(Boolean).length / flags.length, 1),
      pct_descartadas_xgb_1h: round(100 * listos.filter((e, i) => ifFlag(e, sel) && !flags[i]).length / flags.length, 1),
      lecturas_seguidas_en_alerta: racha,
      margen_actual: round(margenes[margenes.length - 1], 4),
      tendencia_margen: tendencia(margenes),
      ventanas, variables,
    };
    if (pendientes.length) out.ventanas_pendientes = pendientes;
    return out;
  }

  function facts(events, segmento, sel) {
    sel = VENTANAS.filter((w) => sel.includes(w));
    const por = {};
    for (const e of events) if (e.segmento === segmento) (por[e.equipo_id] ??= []).push(e);
    const ids = Object.keys(por).sort();
    const now = ids.length ? Math.max(...ids.map((i) => ts(por[i][por[i].length - 1]))) : null;
    const sensores = {};
    for (const id of ids) sensores[id] = sensorFacts(por[id], sel, now);
    const general = Object.values(sensores).map((s) => s.estado).sort((a, b) => PRIORIDAD[b] - PRIORIDAD[a])[0] ?? "sin_datos";
    const ult = ids.map((i) => por[i][por[i].length - 1]).sort((a, b) => ts(b) - ts(a))[0];
    return { segmento, ventanas_seleccionadas: sel, hora_datos: ult ? ult.timestamp : null, estado_general: general, sensores, nota_modelo: NOTA_MODELO };
  }

  return { VENTANAS, VARIABLES, alerta, ifFlag, margenMin, sensorFacts, facts };
})();
