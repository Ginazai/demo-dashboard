# AIOROS predictive-maintenance dashboard (demo)

A static web page: no backend, no model server. It replays scorer output that was computed beforehand, shows the Isolation
Forest result per system type and window, and writes a Spanish/English "what the data says" summary with a small Gemma model
that runs **inside the browser** (WebLLM on WebGPU). Copy this `dashboard/` folder into the `aioros-beta-ai` repo root; nothing outside it changes.

## 1. Precompute the data (once per replay, needs the repo's Python env)

```bash
python dashboard/export_data.py --nombre ornl-2019 --etiqueta "ORNL 2019" \
    --modelos data/processed --sensores edge/sensores.yaml --replay data/processed/replay.csv
python dashboard/make_recommended.py          # tooltip data from logs/pipeline.log (+ stability_*.json if present)
```

`export_data.py` runs `edge/scorer.py` at full speed (no waiting), joins the raw readings from the replay CSV, **removes the
fault labels** (`es_falla`, `id_corrida`) and writes `dashboard/web/data/<nombre>.js`. Run it again with another `--nombre` / `--modelos` / `--sensores`
/ `--replay` for each combination you want to pick in the page. Already have scorer output (`scorer.py --salida x.jsonl`)? Use `--desde-jsonl x.jsonl --replay replay.csv`.
The replay CSV comes from `edge/build_replay.py`. The zip ships `web/data/` **empty on purpose**, so unzipping a new version over your folder never overwrites
your exported data or `index.js`. If a data file is there but missing from the selector (index lost or file copied by hand), run `python dashboard/export_data.py --reindex`.
Without any data the page says so; the tests build their own synthetic demo in a temp folder.

## 2. Open the page

Double-click `dashboard/web/index.html` (works from `file://`; no server). Pick the data set, system type (LT/MT), windows and speed, press Run.
Press **Load AI model** to download the model once (about 1-2 GB from Hugging Face, then cached by the browser). Until it is loaded, the summary is fixed-sentence template text, labeled as such.

Needs a recent Chrome or Edge with WebGPU. The page loads WebLLM from jsDelivr (pinned version) and the weights from Hugging Face; nothing you
see in the page is uploaded. If the model does not load from `file://` in your browser, serve the folder statically: `python -m http.server -d dashboard/web`.

## Which model

The page picks the newest Gemma that WebLLM lists and that needs at most about 3.3 GB of VRAM (a 4 GB GTX 1650 is the target), preferring
the 4k-context q4f16 build. The chosen id is shown after loading. Override with `?model=<webllm model id>` or `?webllm=<version>` in the URL.
Check the license of whichever Gemma it picks: Gemma 2 is under Google's Gemma Terms of Use (commercial use allowed with conditions), not Apache 2.0.

## What the chart and the alert mean

The scorer is a cascade (ADR-007): the Isolation Forest scores each window (`score`, higher = more normal); a reading is flagged when
`score <= umbral`, the cut calibrated so about 10 % of held-out normal data falls below it (ADR-006). When the artifact has an XGBoost model,
it then confirms or discards that flag, and `anomalia` is the **final** decision. The chart plots `score - umbral` (below 0 = flagged by the
Isolation Forest). Shaded area and the alert counts use the final decision; an open circle marks a reading the first model flagged and XGBoost
discarded. If an artifact has no XGBoost model, the two are the same and no circles appear.

## Load the model from a folder (no Hugging Face download)

WebLLM can read the model from this site instead of Hugging Face. It must be served over http, because browsers do not let a `file://` page read weights from disk:

```bash
python -m http.server -d dashboard/web      # then open http://localhost:8000/?local=gemma-2-2b-it-q4f16_1-MLC
```

Put the files in `dashboard/web/models/<name>/`, where `<name>` is what you pass in `?local=`:
- weights, tokenizer and `mlc-chat-config.json` in `models/<name>/resolve/main/` (the same layout as the Hugging Face repo): `huggingface-cli download mlc-ai/<repo> --local-dir dashboard/web/models/<name>/resolve/main`
- the compiled library as `models/<name>/model.wasm`.

To make this folder the default (no `?local=` needed), create `dashboard/web/models/local.js` with one line:
`window.AIOROS_LOCAL_MODEL = "<name>";`
The page then loads that model for every summary. The model must be in **MLC format** (what WebLLM reads); GGUF and plain safetensors files do not work in the browser.

To find the repo and the `.wasm` that match a model, run this in the browser console of the page; it prints each Gemma's id, weights URL and library URL (download the `.wasm` from that URL):
`(await import("https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/+esm")).prebuiltAppConfig.model_list.filter(m => /gemma/i.test(m.model_id)).map(m => [m.model_id, m.model, m.model_lib])`

To avoid the CDN too, save the library module under `models/` and pass `?webllm=models/web-llm.js`. This local mode is untested here: the path layout (`resolve/main/`) follows WebLLM's convention for Hugging Face URLs and may need adjusting.

## Honesty rules (kept from the first version)

- Every figure in the summary is computed in `web/facts.js`; the model only words them. Numbers not in the facts are flagged under the summary.
- ~10 % false positives by design; an alert means "worth a look". Fault labels never reach the page. Variables 100 % empty in ORNL (subenfriamiento, EER) are never shown.

## Tests

```bash
python dashboard/tests/parity.py    # web/facts.js + web/prompt.js give the same output as the reference Python (tests/reference/); needs node
python dashboard/tests/browser.py   # opens web/index.html as file:// with Playwright and a stand-in model engine
```

## Not verified

- The real WebLLM + Gemma path (WebGPU download, first-token time, summary quality, VRAM on a 4 GB card): the tests use a stand-in engine, this sandbox has no GPU and no access to the CDN.
- `export_data.py` against the real `scorer.py` and ORNL replay (tested with synthetic scorer output, and the page with one real export: ORNL + Hohenheim, 24,383 events).
- Loading the page from `file://` with the real WebLLM (browser cache storage may behave differently on `file://`; use the static server fallback if so).
