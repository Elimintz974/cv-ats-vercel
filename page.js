"use client";

import { useState, useRef, useMemo } from "react";

/* ------------------------------------------------------------------ */
/*  Appel du serveur                                                   */
/* ------------------------------------------------------------------ */

async function analyze(mode, cv, job) {
  let res;
  try {
    res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, cv, job }),
    });
  } catch (e) {
    throw new Error("Le réseau n'a pas répondu. Vérifie ta connexion et relance.");
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error("Réponse illisible du serveur. Relance.");
  }
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

function extractJson(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/* ------------------------------------------------------------------ */
/*  Lecture de fichiers (100 % navigateur — rien n'est envoyé)         */
/* ------------------------------------------------------------------ */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("script"));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("timeout")), 20000);
  });
}

async function pdfToText(file) {
  if (!window.pdfjsLib) {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
    if (!window.pdfjsLib) throw new Error("script");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let out = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    out += content.items.map((i) => i.str).join(" ") + "\n\n";
  }
  return out;
}

async function readAnyFile(file) {
  const name = (file.name || "").toLowerCase();
  if (file.size > 12 * 1024 * 1024)
    throw new Error("Fichier trop lourd (plus de 12 Mo). Exporte une version allégée.");

  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".rtf")) {
    return await file.text();
  }
  if (name.endsWith(".docx")) {
    const mammoth = (await import("mammoth/mammoth.browser")).default;
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value || "";
  }
  if (name.endsWith(".doc")) {
    throw new Error(
      "Le format .doc n'est pas lisible ici. Réenregistre en .docx ou en PDF, ou colle le texte."
    );
  }
  if (name.endsWith(".pdf")) {
    try {
      const text = await pdfToText(file);
      if (!text.replace(/\s/g, ""))
        throw new Error(
          "Ce PDF ne contient pas de texte sélectionnable — c'est une image. Un ATS ne le lira pas non plus : c'est déjà un problème à corriger. Colle le texte à la main."
        );
      return text;
    } catch (e) {
      if (e && e.message && e.message !== "script" && e.message !== "timeout") throw e;
      throw new Error(
        "La lecture des PDF n'a pas pu se charger. Ouvre ton PDF, sélectionne tout (Ctrl+A), copie, et colle ici."
      );
    }
  }
  throw new Error("Format non pris en charge. Utilise .pdf, .docx, .txt — ou colle le texte.");
}

/* ------------------------------------------------------------------ */
/*  Surlignage                                                         */
/* ------------------------------------------------------------------ */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text, words) {
  const list = (words || [])
    .map((w) => String(w || "").trim())
    .filter((w) => w.length > 1)
    .sort((a, b) => b.length - a.length);
  if (!list.length) return [{ t: text, hit: false }];

  let re;
  try {
    re = new RegExp("(" + list.map(escapeRe).join("|") + ")", "gi");
  } catch (e) {
    return [{ t: text, hit: false }];
  }

  const parts = [];
  let last = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 5000) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), hit: false });
    parts.push({ t: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push({ t: text.slice(last), hit: false });
  return parts;
}

/* ------------------------------------------------------------------ */

export default function Page() {
  const [cv, setCv] = useState("");
  const [job, setJob] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [scan, setScan] = useState(null);
  const [optimized, setOptimized] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [jobFetched, setJobFetched] = useState(false);
  const [makingDocx, setMakingDocx] = useState(false);
  const fileRef = useRef(null);

  const words = cv.trim() ? cv.trim().split(/\s+/).length : 0;
  const marked = useMemo(() => (scan ? highlight(cv, scan.motsClesPresents) : null), [scan, cv]);

  async function onPickFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const text = await readAnyFile(file);
      const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (!clean) throw new Error("Le fichier est vide ou illisible.");
      setCv(clean);
      setScan(null);
      setOptimized("");
    } catch (err) {
      setError(err.message || "Lecture impossible.");
    }
  }

  async function runScan() {
    if (!cv.trim()) return setError("Colle ton CV, ou importe-le, avant de lancer le scan.");
    setError("");
    setBusy("scan");
    setScan(null);
    try {
      const data = await analyze("scan", cv.trim(), job.trim());
      const { text } = data;
      if (data.jobFetched && data.jobText) {
        setJob(data.jobText);
        setJobFetched(true);
      }
      let parsed;
      try {
        parsed = extractJson(text);
      } catch (e) {
        throw new Error("La réponse est arrivée dans un format inattendu. Relance le scan.");
      }
      setScan({
        score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
        verdict: parsed.verdict || "",
        structure: Array.isArray(parsed.structure) ? parsed.structure : [],
        motsClesPresents: Array.isArray(parsed.motsClesPresents) ? parsed.motsClesPresents : [],
        motsClesManquants: Array.isArray(parsed.motsClesManquants) ? parsed.motsClesManquants : [],
        formatRisques: Array.isArray(parsed.formatRisques) ? parsed.formatRisques : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      });
    } catch (err) {
      setError(err.message || "Le scan a échoué.");
    } finally {
      setBusy(null);
    }
  }

  async function runOptimize() {
    if (!cv.trim()) return setError("Colle ton CV, ou importe-le, avant de l'optimiser.");
    if (!job.trim())
      return setError(
        "L'optimisation a besoin de l'annonce visée. Pour un diagnostic seul, lance le scan."
      );
    setError("");
    setBusy("opt");
    setOptimized("");
    setTruncated(false);
    try {
      const data = await analyze("optimize", cv.trim(), job.trim());
      const { text, truncated: cut } = data;
      if (data.jobFetched && data.jobText) {
        setJob(data.jobText);
        setJobFetched(true);
      }
      const clean = text.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
      if (!clean) throw new Error("Aucun contenu n'est revenu. Relance l'optimisation.");
      setOptimized(clean);
      setTruncated(!!cut);
    } catch (err) {
      setError(err.message || "L'optimisation a échoué.");
    } finally {
      setBusy(null);
    }
  }

  async function copyOut() {
    try {
      await navigator.clipboard.writeText(optimized);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      setError("La copie automatique est bloquée. Sélectionne le texte et copie-le à la main.");
    }
  }

  async function downloadDocx() {
    setMakingDocx(true);
    try {
      const { buildDocx } = await import("./lib/docx");
      await buildDocx(optimized, "cv-ats.docx");
    } catch (e) {
      setError(
        "La génération du document Word a échoué. Utilise le téléchargement en .txt en attendant."
      );
    } finally {
      setMakingDocx(false);
    }
  }

  function downloadOut() {
    const blob = new Blob([optimized], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cv-ats.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="wrap">
      <header>
        <div className="mono">Lecture machine · rien n&apos;est conservé</div>
        <h1>CV-ATS</h1>
        <p className="lede">
          Colle ton CV et l&apos;annonce visée. <strong>Scanner</strong> te dit comment un logiciel
          de tri lit ton CV aujourd&apos;hui. <strong>Optimiser</strong> le réécrit pour qu&apos;il
          soit lu correctement — sans rien inventer.
        </p>
      </header>

      <div className="rule" />

      <div className="grid">
        <section>
          <div className="card">
            <div className="field">
              <div className="head">
                <h2>Ton CV</h2>
                <span className="mono">{words} mots</span>
              </div>
              <textarea
                rows={14}
                value={cv}
                onChange={(e) => setCv(e.target.value)}
                placeholder="Colle ici le texte de ton CV…"
                aria-label="Texte de ton CV"
              />
              <div className="actions" style={{ marginTop: 9 }}>
                <button className="btn btn-ghost" onClick={() => fileRef.current.click()}>
                  Importer un fichier
                </button>
                {cv && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setCv("");
                      setScan(null);
                      setOptimized("");
                    }}
                  >
                    Vider
                  </button>
                )}
                <span className="mono">pdf · docx · txt</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".pdf,.docx,.txt,.md,.rtf"
                  onChange={onPickFile}
                  style={{ display: "none" }}
                />
              </div>
            </div>

            <div className="field" style={{ marginBottom: 14 }}>
              <div className="head">
                <h2>L&apos;annonce</h2>
                <span className="mono">texte ou lien</span>
              </div>
              <textarea
                rows={9}
                value={job}
                onChange={(e) => {
                  setJob(e.target.value);
                  setJobFetched(false);
                }}
                placeholder="Colle le texte de l'offre — ou simplement son lien (https://…)"
                aria-label="Texte de l'annonce"
              />
              {jobFetched && (
                <p className="note" style={{ marginTop: 6, marginBottom: 0 }}>
                  Texte récupéré depuis le lien. Relis-le : si l&apos;annonce est incomplète,
                  remplace-le par un copier-coller.
                </p>
              )}
            </div>

            <div className="actions">
              <button className="btn btn-primary" onClick={runScan} disabled={busy !== null}>
                {busy === "scan" ? "Scan en cours…" : "Scanner mon CV"}
              </button>
              <button className="btn" onClick={runOptimize} disabled={busy !== null}>
                {busy === "opt" ? "Réécriture en cours…" : "Optimiser"}
              </button>
            </div>

            {busy && (
              <div className="scanbar">
                <i />
              </div>
            )}
            {error && (
              <div className="error" style={{ marginTop: 14 }}>
                {error}
              </div>
            )}
          </div>
        </section>

        <section>
          {!scan && !optimized && !busy && (
            <div className="card">
              <h2>Rien à afficher pour l&apos;instant</h2>
              <p className="note" style={{ margin: 0 }}>
                Le résultat s&apos;affiche ici. Le scan surligne, directement dans ton CV, les termes
                de l&apos;annonce que tu possèdes déjà — et liste ceux qui manquent.
              </p>
            </div>
          )}

          {scan && (
            <div className="card">
              <div className="mono">Diagnostic</div>
              <div className="score" style={{ marginTop: 8 }}>
                <div className="score-n">{scan.score}</div>
                <div style={{ paddingBottom: 6 }}>
                  <span className="mono">/ 100 compatibilité</span>
                </div>
              </div>
              <div className="gauge">
                <i style={{ width: scan.score + "%" }} />
              </div>
              {scan.verdict && (
                <p style={{ marginTop: 12, marginBottom: 0, fontWeight: 500 }}>{scan.verdict}</p>
              )}

              {scan.structure.length > 0 && (
                <div className="block">
                  <div className="mono" style={{ marginBottom: 8 }}>
                    Structure lue
                  </div>
                  <ul className="list">
                    {scan.structure.map((s, i) => (
                      <li key={i}>
                        <span className={"dot " + (s.statut || "ok")} />
                        <span>
                          <strong style={{ fontWeight: 600 }}>{s.element}</strong>
                          {s.note ? " — " : ""}
                          <span className="note">{s.note}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {scan.motsClesPresents.length > 0 && (
                <div className="block">
                  <div className="mono" style={{ marginBottom: 8 }}>
                    Déjà dans ton CV ({scan.motsClesPresents.length})
                  </div>
                  <div className="chips">
                    {scan.motsClesPresents.map((w, i) => (
                      <span className="chip chip-hit" key={i}>
                        {w}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {scan.motsClesManquants.length > 0 && (
                <div className="block">
                  <div className="mono" style={{ marginBottom: 8 }}>
                    Absent du CV ({scan.motsClesManquants.length})
                  </div>
                  <ul className="list">
                    {scan.motsClesManquants.map((k, i) => (
                      <li key={i}>
                        <span className="chip chip-miss">{k.mot}</span>
                        <span className="note">
                          {k.type === "formulation"
                            ? "Reformulation — tu l'as, dit autrement. "
                            : "Compétence non présente. "}
                          {k.note}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {scan.formatRisques.length > 0 && (
                <div className="block">
                  <div className="mono" style={{ marginBottom: 8 }}>
                    Risques de lecture
                  </div>
                  <ul className="list">
                    {scan.formatRisques.map((r, i) => (
                      <li key={i}>
                        <span className="dot attention" />
                        <span>{r}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {scan.actions.length > 0 && (
                <div className="block">
                  <div className="mono" style={{ marginBottom: 8 }}>
                    À corriger
                  </div>
                  <ul className="list">
                    {scan.actions.map((a, i) => (
                      <li key={i}>
                        <span className="num">{String(i + 1).padStart(2, "0")}</span>
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {marked && scan.motsClesPresents.length > 0 && (
                <div className="block">
                  <div className="mono" style={{ marginBottom: 8 }}>
                    Ton CV, mots-clés surlignés
                  </div>
                  <div className="sheet">
                    {marked.map((p, i) =>
                      p.hit ? (
                        <mark className="mark" key={i}>
                          {p.t}
                        </mark>
                      ) : (
                        <span key={i}>{p.t}</span>
                      )
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {optimized && (
            <div className="card" style={{ marginTop: scan ? 22 : 0 }}>
              <div className="head">
                <h2>CV réécrit</h2>
                <span className="mono">texte brut</span>
              </div>
              {truncated && (
                <div className="error" style={{ marginBottom: 12 }}>
                  La réécriture s&apos;est arrêtée avant la fin. Relance l&apos;optimisation, ou
                  traite ton CV en deux moitiés.
                </div>
              )}
              <div className="sheet">{optimized}</div>
              <div className="actions" style={{ marginTop: 12 }}>
                <button className="btn btn-ghost" onClick={copyOut}>
                  {copied ? "Copié" : "Copier"}
                </button>
                <button className="btn btn-ghost" onClick={downloadDocx} disabled={makingDocx}>
                  {makingDocx ? "Génération…" : "Télécharger en .docx"}
                </button>
                <button className="btn btn-ghost" onClick={downloadOut}>
                  .txt brut
                </button>
              </div>
              <p className="note" style={{ marginBottom: 0, marginTop: 12 }}>
                Relis-le ligne à ligne avant de l&apos;envoyer. Toute mention [À COMPLÉTER] est une
                information que l&apos;outil a refusé d&apos;inventer à ta place. Le .docx est mis en
                page pour le recruteur tout en restant lisible par la machine ; le .txt sert aux
                formulaires qui demandent un copier-coller.
              </p>
            </div>
          )}
        </section>
      </div>

      <div className="rule" />

      <section className="faq">
        <h2>Ce qu&apos;un ATS fait réellement</h2>
        <p>
          Un ATS (Applicant Tracking System) reçoit, trie et classe les candidatures. Il lit le texte
          de ton CV, le compare à l&apos;annonce, et te positionne dans une file. Il te rejette
          rarement tout seul : il y a un recruteur derrière. Mais un CV mal formaté ou pauvre en
          mots-clés peut être classé si bas qu&apos;il n&apos;est jamais ouvert.
        </p>
        <p style={{ marginTop: 14 }}>
          Ce qu&apos;il lui faut : <strong>du vrai texte sélectionnable</strong> (jamais un scan),{" "}
          <strong>des titres de sections standards</strong>, <strong>aucun tableau</strong> ni
          colonne ni zone de texte, <strong>les termes exacts de l&apos;annonce</strong> quand tu as
          vraiment la compétence, et <strong>tes coordonnées en clair</strong>.
        </p>
        <p style={{ marginTop: 14 }}>
          L&apos;outil ne cherche pas à tromper le logiciel. Il fait en sorte que ton vrai profil
          soit lu correctement.
        </p>
      </section>
    </main>
  );
}
