// In-browser LLM through WebLLM (WebGPU). The weights download once from Hugging Face and stay in the browser cache;
// nothing is sent anywhere and no server runs. Classic script, global `LLM`.
const LLM = (() => {
  const params = new URLSearchParams(location.search);
  // ?webllm=<version> or ?webllm=<full module URL, e.g. a copy of the library under models/>
  const w = params.get("webllm") || "0.2.79";
  const WEBLLM = /^(https?:|\.|\/)/.test(w) ? new URL(w, location.href).href : "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@" + w + "/+esm";
  const LOCAL = params.get("local") || window.AIOROS_LOCAL_MODEL;   // URL param, or models/local.js (the default for this folder)          // ?local=<folder under web/models/>: weights and model.wasm served from this site, nothing downloaded from Hugging Face
  const MAX_VRAM_MB = 3300;                 // leaves room for the browser on a 4 GB card
  let engine = null, modelId = null;

  /** Smallest Gemma in WebLLM's own list that fits: newest family first, then 4k-context q4f16 builds. */
  function pickModel(list) {
    if (params.get("model")) return params.get("model");
    const rank = (m) => {
      const v = Number((m.model_id.match(/gemma-?(\d+)/i) || [])[1] || 0);
      return [v, /-1k/i.test(m.model_id) ? 0 : 1, /q4f16/i.test(m.model_id) ? 1 : 0, -(m.vram_required_MB || 1e9)];
    };
    const ok = list.filter((m) => /gemma/i.test(m.model_id) && (m.vram_required_MB || 0) <= MAX_VRAM_MB && !/embed/i.test(m.model_id));
    ok.sort((a, b) => { const A = rank(a), B = rank(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return B[i] - A[i]; return 0; });
    return ok[0]?.model_id ?? null;
  }

  const supported = () => !!window.__llmFactory || !!navigator.gpu;     // __llmFactory: test hook, injects a stand-in engine

  // WebLLM's reload() swallows its own abort: if the GPU device is lost mid-load (usually out of memory) CreateMLCEngine still resolves,
  // with no model loaded, and the first summary then fails with "Model not loaded". getMessage() throws that same error at once, so check here.
  async function verify() {
    try { await engine.getMessage(); } catch (e) {
      engine = null; modelId = null;
      throw new Error("WebLLM reported the model loaded, but nothing is loaded: the GPU most likely ran out of memory (device lost) during the load. Close other tabs or apps that use the GPU, or try a smaller model with ?model=<id>. [" + String(e.message || e).slice(0, 60) + "...]");
    }
  }

  async function load(onProgress) {
    if (engine) return modelId;
    if (window.__llmFactory) { ({ engine, modelId } = await window.__llmFactory(onProgress)); await verify(); return modelId; }
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter());
    if (!adapter) throw new Error("webgpu");
    const wl = await import(WEBLLM);
    if (LOCAL) {
      if (location.protocol === "file:") throw new Error("local models must be served over http (python -m http.server -d dashboard/web), not opened as file://");
      const base = new URL(`models/${LOCAL}/`, location.href).href;
      // Check the files first: WebLLM's own failure ("Failed to execute 'add' on 'Cache'") does not say which file is missing.
      const exists = async (u) => { try { return (await fetch(u, { method: "HEAD" })).ok; } catch { return false; } };
      const faltan = [];
      for (const f of ["resolve/main/mlc-chat-config.json", "model.wasm"]) if (!(await exists(base + f))) faltan.push(base + f);
      if (!(await exists(base + "resolve/main/tensor-cache.json")) && !(await exists(base + "resolve/main/ndarray-cache.json"))) faltan.push(base + "resolve/main/tensor-cache.json");
      if (faltan.length) throw new Error("files not found (HTTP error) at: " + faltan.join(" , "));
      const appConfig = { model_list: [{ model: base + "resolve/main/", model_id: LOCAL, model_lib: base + "model.wasm", vram_required_MB: 0,
        required_features: /q4f16|q0f16/i.test(LOCAL) ? ["shader-f16"] : [] }] };
      engine = await wl.CreateMLCEngine(LOCAL, { appConfig, initProgressCallback: (r) => onProgress(r.progress, r.text) });
      modelId = LOCAL;
      await verify();
      return modelId;
    }
    const id = pickModel(wl.prebuiltAppConfig.model_list);
    if (!id) throw new Error("no Gemma model fits in this WebLLM version (try ?model=<id> or ?webllm=<version>)");
    try {
      engine = await wl.CreateMLCEngine(id, { initProgressCallback: (r) => onProgress(r.progress, r.text) });
    } catch (e) {
      if (/Cache.*(add|Request failed)|Failed to fetch/i.test(String(e.message))) throw new Error(e.message + " (a model file could not be downloaded from Hugging Face; open DevTools > Network and look for the red request)");
      throw e;
    }
    modelId = id;
    await verify();
    return id;
  }

  /** Streams a reply. onToken(textSoFar). Resolves with {text}. */
  async function generate(messages, onToken) {
    try {
      const stream = await engine.chat.completions.create({ messages, stream: true, temperature: 0.2, max_tokens: 400 });
      let text = "";
      for await (const c of stream) {
        text += c.choices[0]?.delta?.content ?? "";
        onToken(text);
      }
      return { text };
    } catch (e) {
      // WebLLM unloads the model when the GPU device is lost (out of memory, driver reset): forget it so the page can offer a reload.
      if (/model not loaded|device.*lost/i.test(String(e.message || e))) { engine = null; const err = new Error(String(e.message || e)); err.modelLost = true; throw err; }
      throw e;
    }
  }

  return { supported, load, generate, ready: () => !!engine, id: () => modelId, interrupt: () => engine?.interruptGenerate?.() };
})();
