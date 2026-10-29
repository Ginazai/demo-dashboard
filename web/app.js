// Page logic (classic script, no server): precomputed scorer events are replayed in the browser, facts are computed
// here (facts.js) and the summary is written by a model running in this browser (llm.js).
const { margen, alerta, timeline, sparkline } = Chart;
const { renderText, metaLine } = Summary;

const $ = (id) => document.getElementById(id);
const VENT = ["5min", "15min", "1h"];
const MARK = { normal: "● ", atencion: "▲ ", calentando: "◌ ", sin_datos: "– " };
const SUMMARY_GAP_MS = 3000;       // minimum gap between automatic summaries (generation itself takes longer)
const S = {
  lang: "es", segmento: "LT", ventanas: new Set(VENT), events: [], facts: null, rec: window.AIOROS_REC || {},
  index: window.AIOROS_INDEX || [], ds: null, all: [], pos: 0, budget: 0, timer: null, llm: { state: "idle", pct: 0 },
  finished: false, running: false, error: null,
  summary: { state: "idle", text: "", meta: null, key: "", at: 0, sinRespaldo: [] },
};
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};
const T = (k, v) => tr(S.lang, k, v);
const nf = (x, d = 1) => (x === null || x === undefined ? "-" : new Intl.NumberFormat(S.lang, { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(x));
const fmtT = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) : "");
const sel = () => VENT.filter((w) => S.ventanas.has(w));
const h = (tag, props = {}, ...kids) => {
  const n = tag === "svg" ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k === "text" ? (n.textContent = v) : n.setAttribute(k, v);
  n.append(...kids.filter((x) => x != null));
  return n;
};

/* ---------------- windows + recommended-window tooltip ---------------- */
function tipContent(w) {
  const d = S.rec[S.segmento]?.ventanas?.[w];
  const box = h("div", { class: "tip", role: "tooltip", id: "tip-" + w });
  if (!d) return (box.append(h("p", { text: T("tip_sin_datos") })), box);
  box.append(h("p", { text: T("tip_det", { p: nf(d.deteccion), n: nf(d.n_falla, 0) }) }));
  box.append(h("p", { text: d.rango ? T("tip_rango", { r: d.rango.repeticiones, a: nf(d.rango.min), b: nf(d.rango.max) }) : T("tip_sin_rango") }));
  if (!d.muestra_confiable) box.append(h("p", { text: T("tip_poca") }));
  box.append(h("p", { text: T("tip_nota") }));
  return box;
}
function buildWindows() {
  const best = S.rec[S.segmento]?.mejor;
  $("wins").replaceChildren(...VENT.map((w) => {
    const cb = h("input", { type: "checkbox", id: "win-" + w, value: w });
    cb.checked = S.ventanas.has(w);
    cb.onchange = () => {
      if (!cb.checked && S.ventanas.size === 1) { cb.checked = true; return; }   // at least one window stays selected
      cb.checked ? S.ventanas.add(w) : S.ventanas.delete(w);
      renderAll(); tick();
    };
    const label = h("label", { for: "win-" + w }, h("span", { text: T("w" + w) }), w === best ? h("span", { class: "rec", text: T("rec") }) : null);
    const info = h("button", { type: "button", class: "info-btn", "aria-label": T("info_aria") + ": " + T("w" + w), "aria-describedby": "tip-" + w, text: "i" });
    return h("div", { class: "win" }, cb, label, info, tipContent(w));
  }));
}

/* ---------------- renderers ---------------- */
const tag = (estado) => { const t = h("span", { class: "tag-pill" + (estado === "atencion" ? " is-alert" : ""), text: MARK[estado] + T("est_" + estado) }); return t; };

const segEvents = () => S.all.filter((e) => e.segmento === S.segmento);
const canRun = () => !!S.ds && segEvents().length > 0 && !$("seg-" + S.segmento).disabled;

function updateSegments() {
  const segs = S.index.find((d) => d.id === S.ds)?.segmentos ?? [];
  const off = [];
  document.querySelectorAll('input[name="seg"]').forEach((r) => { r.disabled = !segs.includes(r.value); if (r.disabled) off.push(r.value); });
  $("seg-note").textContent = segs.length && off.length ? T("seg_off", { s: off.join(", ") }) : "";
  if (segs.length && !segs.includes(S.segmento)) { S.segmento = segs[0]; $("seg-" + S.segmento).checked = true; }
}

/** Loads data/<id>.js (a <script>, so it works from file://) and makes it the active dataset. */
function loadDataset(id) {
  return new Promise((ok, fail) => {
    const done = () => { S.ds = id; S.all = window.AIOROS_DATA[id].eventos; ok(); };
    if (window.AIOROS_DATA?.[id]) return done();
    const s = h("script", { src: `data/${id}.js` });
    s.onload = done; s.onerror = () => fail(new Error(`data/${id}.js`));
    document.head.append(s);
  });
}
async function initData() {
  const sel_ = $("src-datos");
  sel_.replaceChildren(...(S.index.length ? S.index.map((d) => h("option", { value: d.id, text: `${d.etiqueta} · ${d.segmentos.join("/")} · ${d.n}` })) : [h("option", { value: "", text: T("data_none") })]));
  if (!S.index.length) return;
  try { await loadDataset(S.index[0].id); } catch (e) { S.error = T("err_data", { e: e.message }); }
  updateSegments();
}

function renderStatus() {
  const s = $("run-status"), n = S.events.length;
  s.classList.toggle("is-error", !!S.error);
  s.textContent = S.error ? `${T("st_error")}: ${S.error}`
    : !S.index.length ? T("data_none")
    : !n && !S.running ? T("st_idle")
    : [S.running ? T("st_running") : S.finished ? T("st_finished") : T("st_idle"), T("lecturas", { n: nf(n, 0) }),
       S.facts?.hora_datos ? T("hora_datos", { t: fmtT(S.facts.hora_datos) }) : ""].filter(Boolean).join(" · ");
  $("btn-run").disabled = S.running || !canRun();
  $("btn-stop").disabled = !S.running;
  $("btn-refresh").disabled = !S.facts || S.facts.estado_general === "sin_datos";
}

function renderTiles() {
  const box = $("tiles");
  const sens = S.facts ? Object.entries(S.facts.sensores) : [];
  if (!sens.length) return box.replaceChildren(h("p", { class: "empty", text: T("tiles_empty") }));
  box.replaceChildren(...sens.map(([eid, f]) => {
    const t = h("div", { class: "tile" },
      h("div", { class: "tile-head" }, h("span", { class: "tile-name", text: eid }), tag(f.estado)));
    if (f.estado === "calentando" || f.estado === "sin_datos") { t.append(h("p", { class: "tile-cap", text: f.estado === "sin_datos" ? T("sin_recientes") : T("v_calentando") + (f.ventanas_pendientes ? ": " + f.ventanas_pendientes.map((w) => T("w" + w)).join(", ") : "") })); return t; }
    t.append(h("div", { class: "big", text: nf(f.pct_alerta_1h) + " %" }), h("div", { class: "tile-cap", text: T("pct_alert") }));
    t.append(h("div", { class: "wticks" }, ...Object.entries(f.ventanas).map(([w, v]) =>
      h("span", { class: "wtick" + (v.estado === "anomalia" ? " on" : ""), text: `${v.estado === "anomalia" ? "▲ " : v.descartada_xgb ? "○ " : ""}${T("w" + w)} · ${v.descartada_xgb ? T("v_descartada") : T("v_" + v.estado)}` }))));
    t.append(h("div", { class: "tile-foot" }, h("span", { text: `${T("margen_actual")}: ${nf(f.margen_actual, 4)}` }),
      f.lecturas_seguidas_en_alerta ? h("span", { text: T("seguidas", { n: f.lecturas_seguidas_en_alerta }) }) : null,
      f.pct_descartadas_xgb_1h ? h("span", { text: T("pct_descartadas", { p: nf(f.pct_descartadas_xgb_1h) }) }) : null));
    return t;
  }));
}

const bySensor = () => { const m = {}; for (const e of S.events) (m[e.equipo_id] ??= []).push(e); return m; };

function renderCharts() {
  const box = $("charts"), groups = Object.entries(bySensor());
  if (!groups.length) return box.replaceChildren();
  groups.forEach(([eid, evs]) => {
    let wrap = box.querySelector(`[data-sensor="${eid}"]`);
    box.querySelector(".empty")?.remove();
    if (!wrap) {
      wrap = h("div", { "data-sensor": eid }, h("div", { class: "chart-name", text: eid }),
        h("svg", { class: "chart", role: "img", xmlns: "http://www.w3.org/2000/svg" }), h("div", { class: "readout", "aria-hidden": "true" }));
      box.append(wrap);
    }
    const pts = evs.slice(-288).map((e) => { const a = alerta(e, sel()); return { t: e.timestamp, m: margen(e, sel()), a, d: Facts.ifFlag(e, sel()) && !a }; });
    const ms = pts.filter((p) => p.m !== null).map((p) => p.m);
    const svg = wrap.querySelector("svg"), readout = wrap.querySelector(".readout");
    timeline(svg, pts, {
      umbral: T("chart_umbral"),
      alertaTxt: T("chart_alerta"), normalTxt: T("chart_normal"), descartadaTxt: T("chart_descartada"),
      ariaLabel: T("chart_aria", { s: eid, n: pts.length, min: nf(Math.min(...ms), 4), now: nf(ms[ms.length - 1], 4) }),
      onHover: (p) => (readout.textContent = p ? `${fmtT(p.t)} · ${p.m === null ? T("v_calentando") : nf(p.m, 4)}${p.d ? " · " + T("v_descartada") : ""}` : ""),
    });
  });
}

function renderVars() {
  const box = $("vars"), sens = S.facts ? Object.entries(S.facts.sensores).filter(([, f]) => f.variables && Object.keys(f.variables).length) : [];
  if (!sens.length) return box.replaceChildren(h("p", { class: "empty", text: T("vars_empty") }));
  const groups = bySensor(), out = [];
  for (const [eid, f] of sens) {
    out.push(h("div", { class: "sensor-name", text: eid }));
    for (const [v, d] of Object.entries(f.variables)) {
      const unit = v === "temperatura" ? " °C" : "", svg = h("svg", { "aria-hidden": "true", xmlns: "http://www.w3.org/2000/svg" });
      sparkline(svg, (groups[eid] || []).slice(-60).map((e) => e.valores?.[v] ?? null));
      out.push(h("div", { class: "var" }, h("div", { class: "var-name", text: T(v) }), h("div", { class: "var-val", text: nf(d.actual, 2) + unit }),
        h("div", { class: "var-range", text: T("vars_hora", { min: nf(d.min_1h, 2), max: nf(d.max_1h, 2) }) }), svg));
    }
  }
  box.replaceChildren(...out);
}

function episodes() {
  const out = [], s = sel();
  for (const [eid, evs] of Object.entries(bySensor())) {
    let cur = null, prev = null;
    for (const e of evs) {
      const gap = prev && new Date(e.timestamp) - new Date(prev.timestamp) > 3600e3;
      if (cur && (gap || !alerta(e, s))) { out.push(cur); cur = null; }
      if (alerta(e, s)) {
        cur ??= { eid, start: e.timestamp, n: 0, wins: new Set(), min: Infinity };
        cur.n++; cur.min = Math.min(cur.min, margen(e, s));
        s.filter((w) => e.ventanas[w]?.anomalia).forEach((w) => cur.wins.add(w));
      }
      prev = e;
    }
    if (cur) out.push(cur);
  }
  return out.sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, 8);
}

function renderLog() {
  const box = $("log"), eps = episodes();
  if (!eps.length) return box.replaceChildren(h("p", { class: "empty", text: T("log_empty") }));
  const th = (k) => h("th", { scope: "col", text: T(k) });
  box.replaceChildren(h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "" }), th("log_inicio"), th("log_dur"), th("log_vent"), th("log_margen"))),
    h("tbody", {}, ...eps.map((e) => h("tr", {}, h("td", { text: e.eid }), h("td", { text: fmtT(e.start) }), h("td", { text: T("log_n", { n: e.n }) }),
      h("td", { text: VENT.filter((w) => e.wins.has(w)).map((w) => T("w" + w)).join(", ") }), h("td", { text: nf(e.min, 4) })))))));
}

function renderSummary() {
  const sm = S.summary, box = $("summary-text");
  const estado = S.facts?.estado_general || "sin_datos";
  $("summary-tag").replaceWith(Object.assign(tag(estado), { id: "summary-tag" }));
  box.setAttribute("aria-busy", sm.state === "loading" && !sm.text ? "true" : "false");
  if (sm.text) renderText(box, sm.text);
  else if (sm.state === "loading") box.replaceChildren(h("span", { class: "skeleton" }), h("span", { class: "skeleton" }), h("span", { class: "skeleton" }));
  else box.replaceChildren(h("p", { class: "idle", text: sm.state === "error" ? sm.error : T("summary_idle") }));
  $("summary-meta").textContent = sm.meta && sm.state === "done" ? metaLine(S.lang, sm.meta) : sm.state === "loading" ? T("summary_loading") : "";
  const warn = $("summary-warn");
  warn.hidden = !(sm.state === "done" && sm.sinRespaldo.length);
  warn.textContent = warn.hidden ? "" : T("unverified", { n: sm.sinRespaldo.join(", ") });
  const stale = $("summary-stale");
  stale.hidden = !(sm.state === "done" && S.facts && S.facts.estado_general !== "sin_datos" && summaryKey() !== sm.key);
  stale.textContent = stale.hidden ? "" : T("stale");
}

function renderAll() { renderStatus(); renderTiles(); renderCharts(); renderVars(); renderLog(); renderSummary(); }



/* ---------------- model bar (in-browser LLM) ---------------- */
function renderModel() {
  const m = S.llm, btn = $("btn-model"), prog = $("model-prog"), note = $("model-note");
  btn.hidden = m.state === "ready" || m.state === "loading" || m.state === "nosupport";
  prog.hidden = m.state !== "loading";
  prog.value = m.pct || 0;
  btn.textContent = T(m.state === "error" ? "model_retry" : "model_load");
  note.textContent = m.state === "loading" ? T("model_loading", { p: Math.round((m.pct || 0) * 100) })
    : m.state === "ready" ? T("model_ready", { id: LLM.id() })
    : m.state === "nosupport" ? T("model_nosupport")
    : m.state === "error" ? (m.error === T("model_lost") ? m.error : T("model_err", { e: m.error }))
    : "";
}
async function loadModel() {
  S.llm = { state: "loading", pct: 0 }; renderModel();
  try {
    await LLM.load((p) => { S.llm.pct = p; renderModel(); });
    S.llm = { state: "ready", pct: 1 };
  } catch (e) {
    S.llm = e.message === "webgpu" ? { state: "nosupport" } : { state: "error", error: String(e.message || e) };
  }
  renderModel();
  if (S.llm.state === "ready" && S.facts && S.facts.estado_general !== "sin_datos") startSummary(summaryKey());
}

/* ---------------- summary trigger ---------------- */
function summaryKey() {
  const fire = Object.entries(S.facts.sensores).map(([id, f]) => id + ":" + Object.entries(f.ventanas || {}).filter(([, v]) => v.estado === "anomalia").map(([w]) => w)).join(";");
  return [S.segmento, sel().join(), S.lang, S.facts.estado_general, fire, LLM.ready()].join("|");
}
function startSummary(key) {
  const sm = (S.summary = { state: "loading", text: "", meta: null, key, at: Date.now(), sinRespaldo: [] });
  const live = () => S.summary === sm;                          // a reset or a newer summary makes this one stale
  renderSummary();
  Summary.generate({ facts: S.facts, lang: S.lang, motivoPlantilla: T("motivo_sin_modelo") }, {
    onText: (t) => { if (live()) { sm.text = t; renderSummary(); } },
    onDone: (st) => { if (live()) { Object.assign(sm, { state: "done", meta: st, sinRespaldo: st.sin_respaldo || [] }); renderSummary(); } },
    onError: (m) => { if (live()) { Object.assign(sm, { state: "error", error: m }); renderSummary(); } },
    onModelLost: () => { S.llm = { state: "error", error: T("model_lost") }; renderModel(); },
  });
}
function maybeSummary() {
  if (!S.facts || S.facts.estado_general === "sin_datos" || !$("auto").checked || S.summary.state === "loading") return;
  const key = summaryKey();
  if (key !== S.summary.key && Date.now() - S.summary.at > SUMMARY_GAP_MS) startSummary(key);
}

/* ---------------- replay in the browser ---------------- */
const TICK_MS = 250, PASO_S = 300;     // same pacing rule as scorer.py: min(gap, 5 min) / speed
const newSummary = () => ({ state: "idle", text: "", meta: null, key: "", at: 0, sinRespaldo: [] });

function refresh() {
  S.facts = Facts.facts(S.events.slice(-400), S.segmento, sel());
  $("facts-json").textContent = JSON.stringify(S.facts, null, 2);
  renderAll();
  maybeSummary();
}
function step() {
  const evs = segEvents(), n0 = S.pos;
  S.budget += (TICK_MS / 1000) * Number($("velocidad").value);
  while (S.pos < evs.length) {
    const e = evs[S.pos], prev = S.pos ? evs[S.pos - 1] : null;
    const cost = prev ? Math.min(Math.max((Date.parse(e.timestamp) - Date.parse(prev.timestamp)) / 1000, 0), PASO_S) : 0;
    if (S.budget < cost) break;
    S.budget -= cost; S.events.push(e); S.pos++;
  }
  if (S.pos >= evs.length) { clearInterval(S.timer); S.running = false; S.finished = true; }
  if (S.pos !== n0 || S.finished) refresh();
}
function resetRun() {
  clearInterval(S.timer);
  LLM.interrupt();
  Object.assign(S, { events: [], pos: 0, budget: 0, facts: null, running: false, finished: false, error: null, summary: newSummary() });
  $("facts-json").textContent = "";
  buildWindows(); renderAll();
}
function run() {
  resetRun();
  S.running = true;
  S.timer = setInterval(step, TICK_MS);
  step();
}
function stop() { clearInterval(S.timer); S.running = false; renderAll(); }

/* ---------------- language, theme, init ---------------- */
function applyLang() {
  document.documentElement.lang = S.lang;
  document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = T(n.dataset.i18n)));
  document.querySelectorAll("[data-i18n-aria]").forEach((n) => n.setAttribute("aria-label", T(n.dataset.i18nAria)));
  document.querySelectorAll("[data-lang-set]").forEach((b) => { const on = b.dataset.langSet === S.lang; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  document.title = "AIOROS · " + T("brand_sub").split(" · ")[0];
  updateSegments();
  setTheme(document.documentElement.classList.contains("light"));
  buildWindows(); renderModel();
}
function setTheme(light) {
  document.documentElement.classList.toggle("light", light);
  $("theme-toggle").setAttribute("aria-label", T(light ? "theme_dark" : "theme_light"));
}

document.querySelectorAll("[data-lang-set]").forEach((b) => (b.onclick = () => {
  S.lang = b.dataset.langSet; store.set("aioros-lang", S.lang); applyLang(); renderAll();
  if (S.facts && S.facts.estado_general !== "sin_datos") startSummary(summaryKey());
}));
$("theme-toggle").onclick = () => { const l = !document.documentElement.classList.contains("light"); setTheme(l); store.set("aioros-theme", l ? "light" : "dark"); };
document.querySelectorAll('input[name="seg"]').forEach((r) => (r.onchange = () => { S.segmento = r.value; resetRun(); }));
$("src-datos").onchange = async () => {
  try { await loadDataset($("src-datos").value); } catch (e) { S.error = T("err_data", { e: e.message }); }
  updateSegments(); resetRun();
};
let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 200); });
$("btn-run").onclick = run;
$("btn-stop").onclick = stop;
$("btn-refresh").onclick = () => S.facts && startSummary(summaryKey());
$("btn-model").onclick = loadModel;

(async function init() {
  S.lang = store.get("aioros-lang", "es");
  setTheme(store.get("aioros-theme", "dark") === "light");
  if (!LLM.supported()) S.llm = { state: "nosupport" };
  await initData();
  applyLang();
  renderAll();
})();
