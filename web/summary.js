// Summary panel logic: facts -> prompt -> in-browser model (or the fixed-sentence template when no model is loaded).
// Classic script, global `Summary`.
const Summary = (() => {
  const LABEL = /^(Estado|Qué cambió|Qué vigilar|Status|What changed|What to watch)\.\s*/;
  let gen = 0, chain = Promise.resolve();

  function renderText(box, text) {
    box.replaceChildren();
    for (const para of text.split(/\n\s*\n/).filter((s) => s.trim())) {
      const p = document.createElement("p"), m = para.match(LABEL);
      if (m) { const b = document.createElement("strong"); b.textContent = m[1] + "."; p.append(b, " " + para.slice(m[0].length)); }
      else p.textContent = para;
      box.append(p);
    }
  }

  function metaLine(lang, s) {
    if (s.fuente === "plantilla") return tr(lang, "meta_template", { motivo: s.motivo });
    return tr(lang, "meta_model", { modelo: s.modelo, tok: s.tok_s, seg: s.seg_primer_token, maquina: s.maquina });
  }

  /** cb: {onText(text), onDone(stats), onError(msg)}. A newer call cancels the one in flight. */
  function generate({ facts, lang, motivoPlantilla }, cb) {
    const mine = ++gen;
    LLM.interrupt();
    chain = chain.then(async () => {
      if (mine !== gen) return;
      const plantilla = (motivo) => { cb.onText(Prompt.fallback(facts, lang)); cb.onDone({ fuente: "plantilla", motivo, sin_respaldo: [] }); };
      if (!LLM.ready()) return plantilla(motivoPlantilla);
      const t0 = performance.now();
      let primer = null, n = 0;
      try {
        const { text } = await LLM.generate(Prompt.messages(facts, lang), (t) => {
          if (mine !== gen) return;
          primer ??= performance.now();
          n++;                                         // one streamed chunk is about one token
          cb.onText(t);
        });
        if (mine !== gen) return;
        const seg = (performance.now() - t0) / 1000, dur = (performance.now() - primer) / 1000;
        cb.onDone({ fuente: "modelo", modelo: LLM.id(), tok_s: dur > 0 ? (n / dur).toFixed(1) : "-", seg_primer_token: ((primer - t0) / 1000).toFixed(1),
          maquina: "WebGPU", sin_respaldo: Prompt.ungrounded(text, facts), total_s: seg.toFixed(1) });
      } catch (e) {
        if (mine === gen) { if (e.modelLost) cb.onModelLost?.(); cb.onText(""); plantilla(String(e.message || e)); }
      }
    });
  }

  return { renderText, metaLine, generate };
})();
