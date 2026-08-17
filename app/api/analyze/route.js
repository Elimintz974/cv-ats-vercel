export const runtime = "nodejs";
export const maxDuration = 60; // plafond du plan Hobby de Vercel

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 8000;
const MAX_CV = 30000; // caractères
const MAX_JOB = 15000;
const TIME_BUDGET_MS = 48000; // marge sous les 60 s

/* ------------------------------------------------------------------ */
/*  Prompts — ils vivent ici, côté serveur.                            */
/*  Le client ne peut donc pas les remplacer et se servir de ta clé    */
/*  pour autre chose.                                                  */
/* ------------------------------------------------------------------ */

const SYS_SCAN = `Tu es un analyste de compatibilité ATS. Tu examines un CV réel et, si elle est fournie, une annonce d'emploi.

Règles absolues :
- Tu n'inventes rien. Tu ne supposes aucune compétence absente du CV.
- Un mot-clé n'est "présent" que s'il figure littéralement ou quasi-littéralement dans le CV. Tu recopies alors la forme exacte telle qu'elle apparaît dans le CV.
- Un mot-clé "manquant" est un terme de l'annonce absent du CV. Tu précises s'il s'agit d'un vrai manque de compétence ou d'un simple problème de formulation.
- Sans annonce, tu évalues uniquement la structure, la lisibilité machine et la densité de mots-clés du métier visible dans le CV.

Tu réponds UNIQUEMENT par un objet JSON, sans texte avant ni après, sans balises de code :
{
 "score": <entier 0-100>,
 "verdict": "<une phrase, 20 mots max>",
 "structure": [{"element":"<nom>","statut":"ok|attention|absent","note":"<12 mots max>"}],
 "motsClesPresents": ["<forme exacte trouvée dans le CV>"],
 "motsClesManquants": [{"mot":"<terme de l'annonce>","type":"formulation|competence","note":"<12 mots max>"}],
 "formatRisques": ["<risque de lecture machine, 15 mots max>"],
 "actions": ["<action concrète et vérifiable, 20 mots max>"]
}
Maximum : 8 éléments de structure, 20 mots-clés présents, 12 manquants, 5 risques, 5 actions.`;

const SYS_OPT = `Tu réécris un CV réel en version optimisée pour les ATS (Applicant Tracking Systems).

Règles absolues :
- Tu n'inventes AUCUNE expérience, formation, date, diplôme, chiffre ou compétence. Tout ce que tu écris doit exister dans le CV source.
- Tu peux reformuler, réordonner, regrouper, et utiliser les termes exacts de l'annonce lorsque la compétence correspondante existe déjà dans le CV.
- Si une information manque, tu écris [À COMPLÉTER : ...] plutôt que d'inventer.
- Structure : texte brut uniquement. Titres de sections en MAJUSCULES sur leur propre ligne. Aucun tableau, aucune colonne, aucune icône, aucun caractère décoratif, aucun Markdown.
- Sections dans cet ordre quand l'information existe : coordonnées, TITRE DU POSTE VISÉ, PROFIL, COMPÉTENCES, EXPÉRIENCE PROFESSIONNELLE, FORMATION, LANGUES, CENTRES D'INTÉRÊT.
- Expériences : "Poste — Entreprise — Ville — MM/AAAA à MM/AAAA", puis des puces commençant par un verbe d'action.
- Puces avec un tiret simple "-". Rien d'autre.

Tu réponds UNIQUEMENT par le CV réécrit. Aucune introduction, aucun commentaire, aucune conclusion.`;

/* ------------------------------------------------------------------ */
/*  Limitation de débit — best effort.                                 */
/*  La mémoire n'est pas partagée entre instances serverless : ça      */
/*  freine un usage abusif, ça ne le bloque pas. Pour du sérieux,      */
/*  branche Upstash Redis (voir README).                               */
/* ------------------------------------------------------------------ */

const hits = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 12;

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_PER_WINDOW) return true;
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return false;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function callClaude(system, messages, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error?.message || "";
    } catch (e) {
      /* corps illisible */
    }
    const e = new Error(detail || `Erreur ${res.status}`);
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, stop: data.stop_reason };
}

export async function POST(req) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(
      { error: "La clé API n'est pas configurée sur le serveur." },
      500
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "inconnue";
  if (rateLimited(ip)) {
    return json(
      { error: "Limite atteinte pour cette heure. Réessaie plus tard." },
      429
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Requête illisible." }, 400);
  }

  const mode = body?.mode;
  const cv = String(body?.cv || "").trim();
  const job = String(body?.job || "").trim();

  if (mode !== "scan" && mode !== "optimize")
    return json({ error: "Mode inconnu." }, 400);
  if (!cv) return json({ error: "Le CV est vide." }, 400);
  if (cv.length > MAX_CV)
    return json({ error: "Le CV dépasse la taille acceptée." }, 413);
  if (job.length > MAX_JOB)
    return json({ error: "L'annonce dépasse la taille acceptée." }, 413);
  if (mode === "optimize" && !job)
    return json({ error: "L'optimisation a besoin de l'annonce visée." }, 400);

  const system = mode === "scan" ? SYS_SCAN : SYS_OPT;
  const userContent =
    mode === "scan"
      ? `--- CV ---\n${cv}\n\n--- ANNONCE ---\n${job || "(aucune annonce fournie)"}`
      : `--- CV SOURCE ---\n${cv}\n\n--- ANNONCE VISÉE ---\n${job}`;

  const started = Date.now();
  const messages = [{ role: "user", content: userContent }];
  let full = "";
  let truncated = false;

  try {
    for (let round = 0; round < 3; round++) {
      const { text, stop } = await callClaude(system, messages, apiKey);
      full += text;
      if (stop !== "max_tokens") break;

      // La réponse est coupée en plein milieu : on reprend au même point.
      if (Date.now() - started > TIME_BUDGET_MS) {
        truncated = true;
        break;
      }
      const trimmed = text.replace(/\s+$/, "");
      if (!trimmed) {
        truncated = true;
        break;
      }
      messages.push({ role: "assistant", content: trimmed });
      messages.push({
        role: "user",
        content:
          "Reprends exactement là où tu t'es arrêté, au caractère près. Aucune introduction, aucune répétition, aucun commentaire.",
      });
      if (round === 2) truncated = true;
    }
  } catch (err) {
    const status = err.status || 502;
    if (status === 429)
      return json(
        { error: "Le service est saturé. Attends une minute et relance." },
        429
      );
    if (status === 401 || status === 403)
      return json({ error: "La clé API est refusée. Vérifie sa configuration." }, 500);
    return json(
      { error: "Le service n'a pas répondu correctement. Relance dans un instant." },
      502
    );
  }

  if (!full.trim())
    return json({ error: "Aucun contenu n'est revenu. Relance." }, 502);

  return json({ text: full, truncated });
}
