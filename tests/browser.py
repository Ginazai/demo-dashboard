"""Browser check, opened as file:// (no server) with a stand-in model engine. Run: python dashboard/tests/browser.py
Needs Playwright; builds its own demo data in a temp copy of the folder."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

import json, shutil, subprocess, tempfile
SRC = Path(__file__).resolve().parents[1]
TMP = Path(tempfile.mkdtemp()) / "dashboard"                       # work on a copy so web/data of the real folder is never touched
shutil.copytree(SRC, TMP, ignore=shutil.ignore_patterns("__pycache__", "data"))
sys.path.insert(0, str(SRC / "tests")); import synthetic as SY
(TMP / "web" / "data").mkdir()
(TMP / "syn.jsonl").write_text("\n".join(json.dumps(e) for e in SY.eventos()))
subprocess.run([sys.executable, str(SRC / "tests" / "synthetic.py"), str(TMP / "syn.csv")], check=True, capture_output=True)
subprocess.run([sys.executable, str(TMP / "export_data.py"), "--nombre", "demo-sintetico", "--etiqueta", "Demo sintético",
                "--desde-jsonl", str(TMP / "syn.jsonl"), "--replay", str(TMP / "syn.csv")], check=True, capture_output=True)
(TMP / "web" / "models").mkdir(exist_ok=True)
(TMP / "web" / "models" / "local.js").write_text("// optional: window.AIOROS_LOCAL_MODEL = \"<folder>\";\n")
(TMP / "web" / "data" / "recomendadas.js").write_text("window.AIOROS_REC = {};\n")   # normally from make_recommended.py
WEB = TMP / "web"
MOCK = """
window.__llmFactory = async (onProgress) => {
  for (const p of [0.3, 1]) { onProgress(p, "x"); await new Promise(r => setTimeout(r, 30)); }
  const texto = "Estado. Sistema en observación.\\n\\nQué cambió. Margen actual 99.5.\\n\\nQué vigilar. Seguir observando.";
  return { modelId: "mock-gemma", engine: {
    interruptGenerate() {},
    async getMessage() { if (window.__silentLoadFail) throw new Error("Model not loaded before trying to complete getMessage."); return ""; },
    chat: { completions: { async create(req) {
      if (window.__failNext) { window.__failNext = false; throw new Error('Model not loaded before trying to complete ChatCompletionRequest. Please ensure you have called MLCEngine.reload(model)'); }
      window.__lastPrompt = req.messages;
      return (async function* () { for (const w of texto.split(" ")) { yield { choices: [{ delta: { content: w + " " } }] }; await new Promise(r => setTimeout(r, 5)); } })();
    } } } } };
};
"""
with sync_playwright() as p:
    b = p.chromium.launch()
    errs, reqs = [], []
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.on("request", lambda r: reqs.append(r.url))
    pg.add_init_script(MOCK)
    pg.goto((WEB / "index.html").as_uri()); pg.wait_for_timeout(500)
    assert pg.inner_text("#src-datos option:checked").startswith("Demo"), pg.inner_text("#src-datos")
    assert not pg.is_disabled("#btn-run") and pg.is_disabled("#seg-ULT")
    assert pg.inner_text("#model-note").strip() == "", pg.inner_text("#model-note")          # hints live in tooltips, not on screen
    assert not pg.is_visible("#tip-chart") and not pg.is_visible("#tip-model")
    pg.hover("#h-chart + .info-wrap .info-btn"); assert "XGBoost" in pg.inner_text("#tip-chart"); pg.screenshot(path="/tmp/tip.png", clip={"x": 600, "y": 280, "width": 840, "height": 260})
    pg.mouse.move(5, 5)
    pg.select_option("#velocidad", "1200"); pg.click("#btn-run")
    pg.wait_for_function("document.getElementById('run-status').textContent.includes('terminada')", timeout=30000)
    assert "Plantilla" in pg.inner_text("#summary-meta") or "plantilla" in pg.inner_text("#summary-meta"), pg.inner_text("#summary-meta")
    # WebLLM resolves the load without a model (GPU device lost mid-load): the page must say so, not show "ready"
    pg.evaluate("window.__silentLoadFail = true"); pg.click("#btn-model")
    pg.wait_for_function("document.getElementById('model-note').textContent.includes('nothing is loaded')", timeout=10000)
    assert "listo" not in pg.inner_text("#model-note") and "Reintentar" in pg.inner_text("#btn-model")
    pg.evaluate("window.__silentLoadFail = false")
    # load the model, the summary must now come from it
    pg.click("#btn-model"); pg.wait_for_function("document.getElementById('model-note').textContent.includes('listo')")
    pg.wait_for_function("document.getElementById('summary-meta').textContent.includes('mock-gemma')", timeout=15000)
    texto = pg.inner_text("#summary-text")
    assert "Estado." in texto and "Qué vigilar." in texto, texto
    assert "Cifras que no están en los datos: 99.5" in pg.inner_text("#summary-warn"), pg.inner_text("#summary-warn")   # grounding check
    prompt = pg.evaluate("window.__lastPrompt")
    assert len(prompt) == 1 and prompt[0]["role"] == "user" and "Datos:" in prompt[0]["content"]
    assert "es_falla" not in prompt[0]["content"] and "replay" not in prompt[0]["content"].split("Datos:")[1]
    # the engine loses the model (GPU device lost): the page falls back to the template and offers a reload
    pg.evaluate("window.__failNext = true"); pg.click("#btn-refresh")
    pg.wait_for_function("document.getElementById('model-note').textContent.includes('GPU')", timeout=10000)
    assert pg.is_visible("#btn-model") and "Reintentar" in pg.inner_text("#btn-model")
    pg.click("#btn-model"); pg.wait_for_function("document.getElementById('model-note').textContent.includes('listo')")
    # LT has a stretch the first model flags but XGBoost discards: open circles on the chart, not counted as alert
    pg.click("label[for=seg-LT]"); pg.wait_for_timeout(300)
    pg.click("#btn-run"); pg.wait_for_function("document.getElementById('run-status').textContent.includes('terminada')", timeout=30000)
    assert pg.locator("svg.chart circle.discarded").count() == 4, pg.locator("svg.chart circle.discarded").count()
    assert "XGBoost" in pg.inner_text("#charts")
    # switching system type resets, selecting MT replays MT only
    pg.click("label[for=seg-MT]"); pg.wait_for_timeout(300)
    assert "ORNL_LT" not in pg.inner_text("#tiles")
    pg.click("#btn-run"); pg.wait_for_function("document.getElementById('run-status').textContent.includes('terminada')", timeout=30000)
    assert "ORNL_MT" in pg.inner_text("#tiles") and "ORNL_LT" not in pg.inner_text("#tiles")
    pg.click("#lang-en"); pg.wait_for_timeout(1500)
    assert pg.text_content("#h-tiles") == "Sensors"
    pg.screenshot(path="/tmp/static.png", full_page=True)
    ext = [u for u in reqs if not u.startswith(("file://", "data:"))]
    assert not ext, ext                                   # mocked engine: the page itself makes no network request
    assert not errs, errs
    pg.set_viewport_size({"width": 390, "height": 844}); pg.wait_for_timeout(400)
    assert pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "horizontal scroll on mobile"
    b.close()
print("browser: OK")
