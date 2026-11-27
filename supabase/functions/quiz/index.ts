// Génère un jeu de questions (quiz + flashcards) pour une matière à partir du
// texte de ses PDF, de ses chapitres et des notes, via l'API Mistral.
// Le jeu est mis en cache dans quiz_pools tant que le contenu du cours ne change pas.
// Secret requis : MISTRAL_API_KEY (facultatif : MISTRAL_MODEL).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const LEVELS: Record<string, string> = {
  facile: "FACILE : définitions, vocabulaire, notions de base, rappel direct du cours.",
  moyen: "MOYEN : compréhension et application (expliquer un mécanisme, comparer deux notions, appliquer à un cas simple, petit calcul).",
  difficile: "DIFFICILE : analyse et raisonnement (cas concrets, dépannage, calculs en plusieurs étapes, pièges classiques, liens entre chapitres).",
};
const PER_BATCH = 12;                // 2 lots en parallèle = 24 questions
const DEADLINE_MS = 135_000;         // la plateforme coupe la fonction vers 150 s
const MAX_TEXT_CHARS = 90_000;       // ~25 000 tokens de cours envoyés au modèle

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const tidy = (t: string) => t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

Deno.serve(async (req) => {
  const t0 = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = Deno.env.get("MISTRAL_API_KEY");
  if (!key) return json(503, { error: "La clé Mistral n'est pas encore configurée dans Supabase." });

  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!user) return json(401, { error: "Session expirée : reconnecte-toi." });

  let body: { subject_id?: string; difficulty?: string; force?: boolean };
  try { body = await req.json(); } catch { return json(400, { error: "Requête invalide." }); }
  const difficulty = body.difficulty ?? "moyen";
  if (!LEVELS[difficulty] || !body.subject_id) return json(400, { error: "Matière ou difficulté invalide." });

  // Tout passe par la session de l'utilisatrice : RLS et double authentification s'appliquent.
  const { data: subject } = await sb.from("subjects").select("id,name,ue,description").eq("id", body.subject_id).maybeSingle();
  if (!subject) return json(404, { error: "Matière introuvable." });
  const { data: units } = await sb.from("units").select("title,kind,notes,position").eq("subject_id", subject.id).order("position");
  // Le texte des PDF est extrait dans le navigateur (limite CPU des fonctions) et stocké en base
  const { data: res } = await sb.from("resources").select("title,storage_path,size,mime,kind,text_content,text_chars")
    .eq("subject_id", subject.id).eq("kind", "file");
  const pdfs = (res ?? []).filter((r) => (r.mime ?? "").includes("pdf") || /\.pdf$/i.test(r.title))
    .sort((a, b) => a.title.localeCompare(b.title));

  const hash = await sha256(JSON.stringify({
    v: 3, difficulty, name: subject.name, description: subject.description,
    units: (units ?? []).map((u) => [u.title, u.kind, u.notes]),
    pdfs: pdfs.map((p) => [p.storage_path, p.size, p.text_chars]),
  }));
  const { data: existing } = await sb.from("quiz_pools").select("*").eq("subject_id", subject.id).eq("difficulty", difficulty).maybeSingle();
  if (existing && existing.content_hash === hash && !body.force) return json(200, { pool: existing, cached: true });
  if (!pdfs.length && !(units ?? []).length) {
    return json(400, { error: "Cette matière n'a ni PDF ni chapitres : ajoute du contenu avant de générer des questions." });
  }

  const texts: string[] = []; const used: string[] = []; const skipped: string[] = [];
  for (const p of pdfs) {
    const clean = tidy(p.text_content ?? "");
    if (clean.length < 200) { skipped.push(p.text_chars == null ? `${p.title} (pas encore lu)` : `${p.title} (pas de texte : PDF scanné ?)`); continue; }
    texts.push(`### ${p.title}\n${clean}`); used.push(p.title);
  }
  // Répartition équitable du volume entre les documents
  let course = "";
  if (texts.length) {
    const share = Math.floor(MAX_TEXT_CHARS / texts.length);
    course = texts.map((t) => (t.length > share ? t.slice(0, share) + "\n[…]" : t)).join("\n\n");
  }
  console.log(`quiz: ${subject.name} / ${difficulty} : ${used.length} PDF lus, ${course.length} caractères, ${(units ?? []).length} chapitres, ${Date.now() - t0} ms`);

  const chapterList = (units ?? []).map((u, i) => `${i + 1}. [${u.kind}] ${u.title}${u.notes ? ` (notes : ${u.notes})` : ""}`);
  const half = Math.ceil(chapterList.length / 2);
  const focus = chapterList.length > 3
    ? [chapterList.slice(0, half), chapterList.slice(half)]
    : [chapterList, chapterList];

  const system = "Tu es un enseignant d'école d'ingénieurs (réseaux et sécurité) qui rédige des questions de révision rigoureuses en français. Tu réponds uniquement avec un objet JSON valide.";
  const userPrompt = (part: number) => `Matière : « ${subject.name} »${subject.ue ? `, UE ${subject.ue}` : ""}.
${subject.description ? `Description : ${subject.description}\n` : ""}Plan complet du cours :
${chapterList.join("\n") || "(aucun chapitre saisi)"}

${course ? `Contenu des supports de cours :\n"""\n${course}\n"""` : "Aucun support : appuie-toi sur le plan du cours et sur les connaissances standard de ces notions."}

Rédige exactement ${PER_BATCH} questions de niveau ${LEVELS[difficulty]}
${focus[part].length ? `Concentre-toi sur ces chapitres :\n${focus[part].join("\n")}` : ""}
${part === 1 && chapterList.length <= 3 ? "Choisis des notions différentes des questions les plus évidentes (angle complémentaire)." : ""}
Règles :
- Appuie-toi en priorité sur le contenu des supports ; aucune notion absente du cours.
- Questions autonomes et précises (jamais « selon le document »), sans doublons.
- "answer" : réponse correcte courte (une phrase ou une valeur), verso de flashcard.
- "choices" : exactement 4 propositions plausibles de longueur proche, dont la bonne ; les mauvaises sont des erreurs typiques d'étudiant.
- "correct" : index (0 à 3) de la bonne proposition dans "choices".
- "explanation" : 1 à 2 phrases qui justifient la réponse.
- "chapter" : titre exact du chapitre concerné tiré du plan, ou "".
Format : {"items":[{"question":"…","answer":"…","choices":["…","…","…","…"],"correct":0,"explanation":"…","chapter":"…"}]}`;

  const models = [...new Set([Deno.env.get("MISTRAL_MODEL"), "mistral-medium-latest", "mistral-small-latest"].filter(Boolean) as string[])];

  async function batch(part: number): Promise<{ items: any[]; model: string; err?: string }> {
    let err = "";
    for (const model of models) {
      const left = DEADLINE_MS - (Date.now() - t0);
      if (left < 15_000) return { items: [], model, err: err || "temps écoulé" };
      const t1 = Date.now();
      const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model, temperature: 0.6, max_tokens: 6000,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: userPrompt(part) }],
        }),
        signal: AbortSignal.timeout(left - 5_000),
      }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) } as Response));
      console.log(`quiz: lot ${part + 1} ${model} -> ${r.status} en ${Date.now() - t1} ms`);
      if (!r.ok) {
        const t = await r.text();
        err = `${model} : ${r.status} ${t.slice(0, 300)}`;
        console.log(`quiz: erreur ${err}`);
        if (r.status === 401) return { items: [], model, err: "CLE " + err };
        if (r.status === 0) return { items: [], model, err };
        continue; // modèle indisponible ou quota : modèle suivant
      }
      const out = await r.json();
      try {
        const items = JSON.parse(out?.choices?.[0]?.message?.content ?? "{}").items ?? [];
        return { items, model };
      } catch { err = `${model} : réponse illisible`; }
    }
    return { items: [], model: models[models.length - 1], err };
  }

  // 2 lots en parallèle, décalés d'une seconde (limite gratuite : 1 requête par seconde)
  const [a, b] = await Promise.all([batch(0), new Promise((ok) => setTimeout(ok, 1200)).then(() => batch(1))]);
  const seen = new Set<string>();
  const clean = [...a.items, ...b.items].filter((it: any) => {
    const ok = it && typeof it.question === "string" && Array.isArray(it.choices) && it.choices.length === 4 &&
      Number.isInteger(it.correct) && it.correct >= 0 && it.correct < 4 && typeof it.answer === "string";
    const k = ok ? it.question.trim().toLowerCase() : "";
    if (!ok || seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (clean.length < 5) {
    const err = a.err || b.err || "trop peu de questions valides";
    if (err.startsWith("CLE ")) return json(502, { error: "La clé Mistral est refusée : vérifie-la dans Supabase.", detail: err });
    if (/ 429 /.test(err)) return json(429, { error: "Quota gratuit Mistral atteint pour le moment : réessaie dans une minute.", detail: err });
    if (/temps|: 0 /.test(err)) return json(504, { error: "Mistral a mis trop de temps à répondre. Réessaie dans un instant.", detail: err });
    return json(502, { error: "Mistral n'a pas pu générer les questions.", detail: err });
  }
  const row = {
    user_id: user.id, subject_id: subject.id, difficulty, content_hash: hash,
    items: clean, item_count: clean.length, sources: { pdfs: used, skipped }, model: a.model, created_at: new Date().toISOString(),
  };
  const { data: pool, error } = await sb.from("quiz_pools").upsert(row, { onConflict: "user_id,subject_id,difficulty" }).select().single();
  if (error) return json(500, { error: error.message });
  console.log(`quiz: ${clean.length} questions en ${Date.now() - t0} ms`);
  return json(200, { pool, cached: false });
});
