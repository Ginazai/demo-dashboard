const Chart = (() => {
// Hand-written SVG charts. Colors come from CSS variables (--fg, --fg-2) so both themes work.
const NS = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** Lowest (score - threshold) among the selected windows that are ready; null while warming up. */
function margen(e, sel) {
  const ms = sel.filter((w) => e.ventanas[w]).map((w) => e.ventanas[w].score - (e.ventanas[w].umbral ?? 0));
  return ms.length ? Math.min(...ms) : null;
}

/** Alert rule of the page: any selected window flags an anomaly. */
const alerta = (e, sel) => sel.some((w) => e.ventanas[w] && e.ventanas[w].anomalia);

const HORA = 3600e3;
const fmtT = (iso) => iso.replace("T", " ").slice(5, 16);

/** Margin timeline with a threshold line at 0. pts = [{t, m, a, d}]: m margin (may be null), a final alert, d flagged by the first model but discarded by XGBoost. */
function timeline(svg, pts, { umbral, alertaTxt, normalTxt, descartadaTxt, ariaLabel, onHover }) {
  svg.replaceChildren();
  const W = Math.round(svg.getBoundingClientRect().width) || 800, H = W < 500 ? 200 : 220, L = 46, R = 12, T = 12, B = 28;   // drawn at real pixel width so labels stay readable on phones
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("aria-label", ariaLabel);
  const ok = pts.filter((p) => p.m !== null);
  if (!ok.length) return;
  const lo = Math.min(-0.05, ...ok.map((p) => p.m)), hi = Math.max(0.05, ...ok.map((p) => p.m));
  const x = (i) => L + (i / Math.max(1, pts.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const y0 = y(0);

  // alert region: between the zero line and the curve wherever the margin is <= 0
  let region = "", d = "", prev = null;
  pts.forEach((p, i) => {
    if (p.m === null) { prev = null; return; }
    const gap = prev !== null && new Date(p.t) - new Date(pts[prev].t) > HORA;   // jump between recorded runs
    d += (prev === null || gap ? "M" : "L") + x(i).toFixed(1) + " " + y(p.m).toFixed(1);
    if (p.a) region += `M${x(i).toFixed(1)} ${y0.toFixed(1)}V${y(p.m).toFixed(1)}h${Math.max(1, (W - L - R) / pts.length).toFixed(1)}V${y0.toFixed(1)}z`;
    prev = i;
  });
  svg.append(el("path", { d: region, fill: "var(--fg)", opacity: "0.2" }));
  svg.append(el("line", { x1: L, x2: W - R, y1: y0, y2: y0, stroke: "var(--fg-2)", "stroke-dasharray": "4 4" }));
  const lbl = (txt, xx, yy, anchor = "end") => {
    const t = el("text", { x: xx, y: yy, fill: "var(--fg-2)", "font-size": "11", "text-anchor": anchor, "font-family": "var(--font-mono)" });
    t.textContent = txt;
    svg.append(t);
  };
  lbl(umbral, L + 4, y0 - 5, "start");
  lbl("▼ " + alertaTxt, W - R - 4, y0 + 14);                // below the line: flagged by the first model                // below the line = alert
  lbl("▲ " + normalTxt, W - R - 4, y0 - 5);
  lbl(hi.toFixed(2), L - 6, T + 8);
  lbl(lo.toFixed(2), L - 6, H - B);
  lbl(fmtT(pts[0].t), L, H - 8, "start");
  lbl(fmtT(pts[pts.length - 1].t), W - R, H - 8);
  if (pts.some((p) => p.d)) lbl("○ " + descartadaTxt, W - R - 4, H - B - 6);
  svg.append(el("path", { d, fill: "none", stroke: "var(--fg)", "stroke-width": "1.5", "vector-effect": "non-scaling-stroke" }));
  pts.forEach((p, i) => { if (p.d && p.m !== null) svg.append(el("circle", { cx: x(i), cy: y(p.m), r: 3.5, fill: "var(--bg-raise)", stroke: "var(--fg)", "stroke-width": "1.5", class: "discarded" })); });
  const cursor = el("line", { y1: T, y2: H - B, stroke: "var(--fg-2)", visibility: "hidden" });
  svg.append(cursor);
  svg.onpointermove = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((px - L) / (W - L - R)) * (pts.length - 1))));
    cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i)); cursor.setAttribute("visibility", "visible");
    onHover(pts[i]);
  };
  svg.onpointerleave = () => { cursor.setAttribute("visibility", "hidden"); onHover(null); };
}

/** Small sparkline for one variable. values = numbers (nulls skipped). */
function sparkline(svg, values) {
  svg.replaceChildren();
  const v = values.filter((n) => n !== null);
  if (v.length < 2) return;
  const lo = Math.min(...v), hi = Math.max(...v), W = 120, H = 28;
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * W},${H - 3 - ((n - lo) / (hi - lo || 1)) * (H - 6)}`);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.append(el("polyline", { points: pts.join(" "), fill: "none", stroke: "var(--fg)", "stroke-width": "1.2", "vector-effect": "non-scaling-stroke" }));
}
return { margen, alerta, timeline, sparkline };
})();
