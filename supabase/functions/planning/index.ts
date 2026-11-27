// Relais du planning ADE : lit le lien iCal enregistré par l'utilisateur
// (table settings, protégée par RLS) et renvoie le calendrier avec les
// en-têtes CORS que le serveur de l'école ne fournit pas.
// Déployée sur Supabase sous le nom « planning » (verify_jwt activé).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return json(401, { error: "Session expirée : reconnecte-toi." });

  const { data: row, error } = await sb.from("settings").select("ics_url").eq("user_id", user.id).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!row?.ics_url) return json(404, { error: "Aucun lien de planning enregistré." });

  let url: URL;
  try { url = new URL(row.ics_url); } catch { return json(400, { error: "Le lien de planning est invalide." }); }
  if (url.protocol !== "https:") return json(400, { error: "Le lien de planning doit commencer par https://" });

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Carnet-ESIEE/1.0" } });
    if (!r.ok) return json(502, { error: `Le serveur du planning a répondu ${r.status}.` });
    const text = await r.text();
    if (!text.includes("BEGIN:VCALENDAR")) {
      return json(502, { error: "Le lien ne renvoie pas un calendrier : il demande peut-être une connexion." });
    }
    return new Response(text, {
      headers: { ...cors, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300" },
    });
  } catch (e) {
    return json(504, { error: "Le serveur du planning ne répond pas.", detail: String(e) });
  }
});
