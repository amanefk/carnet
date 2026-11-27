// Génère un jeu de questions (quiz + flashcards) pour une matière à partir de
// ses PDF, de ses chapitres et des notes, via l'API Gemini.
// Le jeu est mis en cache dans quiz_pools tant que le contenu du cours ne change pas.
// Secret requis : GEMINI_API_KEY (facultatif : GEMINI_MODEL).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

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
const POOL_SIZE = 30;
const MAX_PDF_BYTES = 14 * 1024 * 1024; // marge sous la limite de 20 Mo par requête (base64 +33 %)

const schema = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING" },
          answer: { type: "STRING" },
          choices: { type: "ARRAY", items: { type: "STRING" } },
          correct: { type: "INTEGER" },
          explanation: { type: "STRING" },
          chapter: { type: "STRING" },
        },
        required: ["question", "answer", "choices", "correct", "explanation"],
      },
    },
  },
  required: ["items"],
};

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json(503, { error: "La clé Gemini n'est pas encore configurée dans Supabase." });

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
  const { data: res } = await sb.from("resources").select("title,storage_path,size,mime,kind").eq("subject_id", subject.id).eq("kind", "file");
  const pdfs = (res ?? []).filter((r) => r.storage_path && ((r.mime ?? "").includes("pdf") || /\.pdf$/i.test(r.title)))
    .sort((a, b) => (a.size ?? 0) - (b.size ?? 0));

  const hash = await sha256(JSON.stringify({
    v: 1, difficulty, name: subject.name, description: subject.description,
    units: (units ?? []).map((u) => [u.title, u.kind, u.notes]),
    pdfs: pdfs.map((p) => [p.storage_path, p.size]),
  }));

  const { data: existing } = await sb.from("quiz_pools").select("*").eq("subject_id", subject.id).eq("difficulty", difficulty).maybeSingle();
  if (existing && existing.content_hash === hash && !body.force) return json(200, { pool: existing, cached: true });

  if (!pdfs.length && !(units ?? []).length) {
    return json(400, { error: "Cette matière n'a ni PDF ni chapitres : ajoute du contenu avant de générer des questions." });
  }

  // PDF envoyés tels quels à Gemini (lecture native, schémas compris), dans la limite de taille
  const parts: unknown[] = [];
  const used: string[] = []; const skipped: string[] = [];
  let total = 0;
  for (const p of pdfs) {
    if (total + (p.size ?? 0) > MAX_PDF_BYTES) { skipped.push(p.title); continue; }
    const { data: blob, error } = await sb.storage.from("resources").download(p.storage_path);
    if (error || !blob) { skipped.push(p.title); continue; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    total += bytes.length;
    parts.push({ inline_data: { mime_type: "application/pdf", data: encodeBase64(bytes) } });
    used.push(p.title);
  }

  const chapters = (units ?? []).map((u, i) => `${i + 1}. [${u.kind}] ${u.title}${u.notes ? ` (notes : ${u.notes})` : ""}`).join("\n");
  const prompt = `Tu es un enseignant d'école d'ingénieurs qui prépare un étudiant en réseaux et sécurité à ses examens.
Matière : « ${subject.name} »${subject.ue ? `, UE ${subject.ue}` : ""}.
${subject.description ? `Description : ${subject.description}\n` : ""}Plan du cours :
${chapters || "(aucun chapitre saisi)"}
${used.length ? `\nSupports de cours joints (PDF) : ${used.join(", ")}.` : "\nAucun support PDF : appuie-toi sur le plan du cours et sur les connaissances standard de ces notions."}

Génère exactement ${POOL_SIZE} questions de révision, en français, niveau ${LEVELS[difficulty]}
Règles :
- Appuie-toi en priorité sur le contenu des supports joints ; ne pose pas de question sur une notion absente du cours.
- Couvre l'ensemble des chapitres de façon équilibrée, sans doublons.
- "question" : une question autonome et précise (pas de « selon le document »).
- "answer" : la réponse correcte, courte (une phrase ou une valeur), utilisée comme verso de flashcard.
- "choices" : exactement 4 propositions plausibles et de même longueur, dont la bonne réponse ; les mauvaises doivent être des erreurs typiques d'étudiant.
- "correct" : l'index (0 à 3) de la bonne proposition dans "choices".
- "explanation" : 1 à 3 phrases qui justifient la réponse.
- "chapter" : le titre exact du chapitre concerné tiré du plan, ou une chaîne vide.`;
  parts.push({ text: prompt });

  const models = [Deno.env.get("GEMINI_MODEL"), "gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash"].filter(Boolean) as string[];
  let lastErr = "";
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(120000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) } as Response));
    if (!r.ok) {
      const t = await r.text();
      lastErr = `${model} : ${r.status} ${t.slice(0, 300)}`;
      if (r.status === 429) return json(429, { error: "Quota gratuit Gemini atteint pour le moment : réessaie dans quelques minutes.", detail: lastErr });
      if (r.status === 400 && /API key/i.test(t)) return json(502, { error: "La clé Gemini est refusée : vérifie-la dans Supabase.", detail: lastErr });
      continue; // modèle indisponible : on essaie le suivant
    }
    const out = await r.json();
    const text = out?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    let items: unknown[] = [];
    try { items = JSON.parse(text).items ?? []; } catch { lastErr = `${model} : réponse illisible`; continue; }
    const clean = items.filter((it: any) =>
      it && typeof it.question === "string" && Array.isArray(it.choices) && it.choices.length === 4 &&
      Number.isInteger(it.correct) && it.correct >= 0 && it.correct < 4 && typeof it.answer === "string",
    );
    if (clean.length < 5) { lastErr = `${model} : trop peu de questions valides (${clean.length})`; continue; }
    const row = {
      user_id: user.id, subject_id: subject.id, difficulty, content_hash: hash,
      items: clean, item_count: clean.length, sources: { pdfs: used, skipped }, model, created_at: new Date().toISOString(),
    };
    const { data: pool, error } = await sb.from("quiz_pools").upsert(row, { onConflict: "user_id,subject_id,difficulty" }).select().single();
    if (error) return json(500, { error: error.message });
    return json(200, { pool, cached: false });
  }
  return json(502, { error: "Gemini n'a pas pu générer les questions.", detail: lastErr });
});
