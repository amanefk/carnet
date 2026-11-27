// Bibliothèque Supabase hébergée avec le site (version figée), plus de dépendance à un CDN tiers
const { createClient } = window.supabase;
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAULT_AUTOLOCK_MIN, CLIPBOARD_CLEAR_SEC } from "./config.js";
import * as V from "./vault.js";

/* =========================================================
   Base
   ========================================================= */
const configured = !SUPABASE_URL.includes("VOTRE-PROJET") && !SUPABASE_ANON_KEY.startsWith("VOTRE");
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const $app = document.getElementById("app");
const $modal = document.getElementById("modal");

const state = {
  user: null, loaded: false, needMfa: false,
  semesters: [], subjects: [], units: [], resources: [], exams: [], links: [], settings: [],
};
const vault = { checked: false, row: null, key: null, data: null, revealed: new Set(), timer: null };

const STATUS = {
  todo:   { label: "À voir",   w: 0,    c: "var(--s-todo)" },
  doing:  { label: "En cours", w: 0.4,  c: "var(--s-doing)" },
  review: { label: "À revoir", w: 0.7,  c: "var(--s-review)" },
  done:   { label: "Maîtrisé", w: 1,    c: "var(--s-done)" },
};
const CYCLE = { todo: "doing", doing: "done", done: "review", review: "todo" };
const UNIT_KINDS = ["Chapitre", "Séance", "Cours", "TD", "TP", "Projet"];
const EXAM_KINDS = ["Partiel", "Examen final", "Contrôle continu", "TP noté", "Oral", "Projet", "Rattrapage"];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const byPos = (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.name ?? a.title).localeCompare(String(b.name ?? b.title));
const fmtDate = (d, opts) => new Intl.DateTimeFormat("fr-FR", opts).format(new Date(d));
const fmtDay = (d) => fmtDate(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtDT = (d) => fmtDate(d, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtSize = (n) => (n == null ? "" : n < 1024 ** 2 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1024 ** 2).toFixed(1)} Mo`);
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
function daysUntil(iso) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(iso); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), err ? 5000 : 2600);
}
function fail(e) { console.error(e); toast(e?.message || String(e), true); }

/* =========================================================
   Données
   ========================================================= */
async function q(p) { const { data, error } = await p; if (error) throw error; return data; }
const insert = (t, row) => q(sb.from(t).insert(row).select().single());
const update = (t, id, row) => q(sb.from(t).update(row).eq("id", id).select().single());
const remove = (t, id) => q(sb.from(t).delete().eq("id", id));

function put(list, row) {
  const i = state[list].findIndex((r) => r.id === row.id);
  if (i >= 0) state[list][i] = row; else state[list].push(row);
}
function drop(list, id) { state[list] = state[list].filter((r) => r.id !== id); }

async function loadAll() {
  const tables = ["semesters", "subjects", "units", "resources", "exams", "links", "settings"];
  // le texte extrait des PDF reste en base : on ne charge que sa longueur
  const cols = { resources: "id,user_id,subject_id,unit_id,title,kind,storage_path,url,mime,size,created_at,text_chars" };
  const res = await Promise.all(tables.map((t) => q(sb.from(t).select(cols[t] || "*"))));
  tables.forEach((t, i) => (state[t] = res[i]));
  // métadonnées des jeux de questions (sans les questions) et historique des parties
  [state.quizPools, state.quizAttempts] = await Promise.all([
    q(sb.from("quiz_pools").select("id,subject_id,difficulty,content_hash,item_count,sources,model,created_at")),
    q(sb.from("quiz_attempts").select("*").order("created_at", { ascending: false })),
  ]);
  state.loaded = true;
}

const semesterOf = (id) => state.semesters.find((s) => s.id === id);
const subjectOf = (id) => state.subjects.find((s) => s.id === id);
const subjectsIn = (semId) => state.subjects.filter((s) => s.semester_id === semId).sort(byPos);
const unitsOf = (subId) => state.units.filter((u) => u.subject_id === subId).sort(byPos);

function progress(units) {
  if (!units.length) return null;
  return Math.round((units.reduce((a, u) => a + STATUS[u.status].w, 0) / units.length) * 100);
}
function currentSemester() {
  const now = new Date();
  const sems = [...state.semesters].sort(byPos);
  return sems.find((s) => s.start_date && s.end_date && new Date(s.start_date) <= now && now <= new Date(s.end_date + "T23:59"))
    || sems.find((s) => !s.end_date || new Date(s.end_date + "T23:59") >= now) // sans dates : le premier semestre non terminé
    || sems[sems.length - 1];
}

/* =========================================================
   Fragments
   ========================================================= */
function strip(units, big = false) {
  if (!units.length) return `<div class="strip empty${big ? " big" : ""}" aria-label="Aucune séance"></div>`;
  return `<div class="strip${big ? " big" : ""}" role="img" aria-label="${units.filter((u) => u.status === "done").length} sur ${units.length} maîtrisés">${units
    .map((u, i) => big
      ? `<button class="cell ${u.status}" data-action="cycle" data-id="${u.id}" title="${i + 1}. ${esc(u.title)} : ${STATUS[u.status].label}" aria-label="${esc(u.title)}, ${STATUS[u.status].label}. Changer l'état"></button>`
      : `<span class="cell ${u.status}"></span>`)
    .join("")}</div>`;
}
const legend = () => `<div class="legend">${Object.values(STATUS).map((s) => `<span style="--c:${s.c}">${s.label}</span>`).join("")}</div>`;

function ledger(subjects) {
  if (!subjects.length) return `<div class="empty-state"><p>Aucune matière dans ce semestre.</p></div>`;
  return `<div class="ledger">${subjects.map((s) => {
    const us = unitsOf(s.id); const p = progress(us);
    return `<a class="ledger-row" href="#/m/${s.id}">
      <span class="name">${s.code ? `<small>${esc(s.code)}</small>` : ""}${esc(s.name)}</span>
      ${strip(us)}
      <span class="pct">${p == null ? "–" : p + " %"}</span></a>`;
  }).join("")}</div>`;
}

function examRow(e) {
  const d = daysUntil(e.starts_at); const sub = subjectOf(e.subject_id);
  const cd = d < 0 ? `<span class="countdown">✓<small>passé</small></span>`
    : d === 0 ? `<span class="countdown">Auj.<small>aujourd'hui</small></span>`
    : `<span class="countdown">J-${d}<small>${d === 1 ? "demain" : "jours"}</small></span>`;
  return `<div class="exam${d < 0 ? " past" : d <= 7 ? " soon" : ""}">
    ${cd}
    <div><div><strong>${esc(e.title)}</strong>${e.kind ? ` <span class="muted">${esc(e.kind)}</span>` : ""}</div>
      <div class="small muted">${fmtDT(e.starts_at)}${e.location ? `, ${esc(e.location)}` : ""}${sub ? `, <a href="#/m/${sub.id}">${esc(sub.name)}</a>` : ""}${e.coef ? `, coef ${e.coef}` : ""}</div></div>
    <div class="actions">${e.grade != null ? `<span class="grade">${e.grade}/20</span>` : ""}<button class="ghost" data-action="edit-exam" data-id="${e.id}">Modifier</button></div>
  </div>`;
}
const sortedExams = (list) => [...list].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

/* =========================================================
   Formulaires (modale)
   ========================================================= */
function fieldHTML(f) {
  const v = f.value ?? "";
  const req = f.required ? " required" : "";
  if (f.type === "select") {
    return `<label><span>${f.label}</span><select name="${f.name}"${req}>${f.options.map(([ov, ol]) => `<option value="${esc(ov)}"${String(ov) === String(v) ? " selected" : ""}>${esc(ol)}</option>`).join("")}</select></label>`;
  }
  if (f.type === "textarea") return `<label><span>${f.label}</span><textarea name="${f.name}"${req} placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea></label>`;
  if (f.type === "password") {
    return `<div class="lbl"><span>${f.label}</span><div class="pw-row"><input type="password" name="${f.name}" value="${esc(v)}" autocomplete="${f.autocomplete || "new-password"}"${req}>
      <button type="button" data-pw-toggle>Afficher</button>${f.generator ? `<button type="button" data-pw-gen>Générer</button>` : ""}</div>
      ${f.meter ? `<div class="meter"><i></i></div>` : ""}</div>`;
  }
  return `<label><span>${f.label}</span><input type="${f.type || "text"}" name="${f.name}" value="${esc(v)}"${req}${f.step ? ` step="${f.step}"` : ""}${f.min != null ? ` min="${f.min}"` : ""}${f.max != null ? ` max="${f.max}"` : ""} placeholder="${esc(f.placeholder || "")}"></label>`;
}
function fieldsHTML(fields) {
  let out = ""; let i = 0;
  while (i < fields.length) {
    if (fields[i].half && fields[i + 1]?.half) { out += `<div class="grid2">${fieldHTML(fields[i])}${fieldHTML(fields[i + 1])}</div>`; i += 2; }
    else { out += fieldHTML(fields[i]); i += 1; }
  }
  return out;
}
function meterUpdate(input) {
  const m = input.closest(".lbl")?.querySelector(".meter i"); if (!m) return;
  const s = V.strength(input.value);
  const c = ["var(--danger)", "var(--danger)", "var(--s-doing)", "var(--s-done)", "var(--s-done)"][s];
  m.style.setProperty("--w", `${s * 25}%`); m.style.setProperty("--c", c);
}

function openForm({ title, intro = "", fields, submitLabel = "Enregistrer", onSubmit, del }) {
  $modal.innerHTML = `<form novalidate>
    <h2>${esc(title)}</h2>${intro ? `<p class="small muted">${intro}</p>` : ""}
    ${fieldsHTML(fields)}
    <footer>${del ? `<button type="button" class="danger" data-del style="margin-right:auto">${esc(del.label || "Supprimer")}</button>` : ""}
      <button type="button" data-cancel>Annuler</button><button type="submit" class="primary">${esc(submitLabel)}</button></footer></form>`;
  const form = $modal.querySelector("form");
  form.querySelectorAll("[data-pw-toggle]").forEach((b) => (b.onclick = () => {
    const i = b.parentElement.querySelector("input"); const show = i.type === "password";
    i.type = show ? "text" : "password"; b.textContent = show ? "Masquer" : "Afficher";
  }));
  form.querySelectorAll("[data-pw-gen]").forEach((b) => (b.onclick = () => {
    const i = b.parentElement.querySelector("input"); i.value = V.generatePassword(20); i.type = "text";
    b.parentElement.querySelector("[data-pw-toggle]").textContent = "Masquer"; meterUpdate(i);
  }));
  form.querySelectorAll(".lbl input").forEach((i) => { i.addEventListener("input", () => meterUpdate(i)); meterUpdate(i); });
  form.querySelector("[data-cancel]").onclick = () => $modal.close();
  if (del) form.querySelector("[data-del]").onclick = async () => {
    if (!confirm(del.confirm || "Supprimer définitivement ?")) return;
    try { await del.run(); $modal.close(); render(); } catch (e) { fail(e); }
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    for (const f of fields) {
      const el = form.elements[f.name];
      if (f.required && !String(el.value).trim()) { el.focus(); toast(`Le champ « ${f.label} » est obligatoire.`, true); return; }
    }
    const raw = Object.fromEntries(new FormData(form));
    const data = {};
    for (const f of fields) {
      let v = raw[f.name]; v = typeof v === "string" ? v.trim() : v;
      if (v === "" || v == null) v = null;
      else if (f.type === "number") v = Number(String(v).replace(",", "."));
      else if (f.type === "datetime-local") v = new Date(v).toISOString();
      data[f.name] = v;
    }
    const btn = form.querySelector("[type=submit]"); btn.disabled = true;
    try { await onSubmit(data); $modal.close(); render(); }
    catch (e) { fail(e); }
    finally { btn.disabled = false; }
  };
  $modal.showModal();
  form.querySelector("input, select, textarea")?.focus();
}

/* ---------- formulaires métier ---------- */
function semesterForm(sem) {
  openForm({
    title: sem ? "Modifier le semestre" : "Nouveau semestre",
    fields: [
      { name: "name", label: "Nom", value: sem?.name, required: true, placeholder: "S5" },
      { name: "start_date", label: "Début", type: "date", value: sem?.start_date, half: true },
      { name: "end_date", label: "Fin", type: "date", value: sem?.end_date, half: true },
      { name: "position", label: "Ordre d'affichage", type: "number", value: sem?.position ?? state.semesters.length },
    ],
    submitLabel: sem ? "Enregistrer" : "Créer le semestre",
    onSubmit: async (d) => put("semesters", sem ? await update("semesters", sem.id, d) : await insert("semesters", d)),
    del: sem && {
      label: "Supprimer le semestre",
      confirm: `Supprimer « ${sem.name} » avec toutes ses matières, séances et ressources ?`,
      run: async () => { await remove("semesters", sem.id); await loadAll(); location.hash = "#/"; },
    },
  });
}

function subjectForm(sub, semesterId) {
  const semOpts = [...state.semesters].sort(byPos).map((s) => [s.id, s.name]);
  if (!semOpts.length) { toast("Crée d'abord un semestre.", true); return; }
  openForm({
    title: sub ? "Modifier la matière" : "Nouvelle matière",
    fields: [
      { name: "name", label: "Intitulé", value: sub?.name, required: true },
      { name: "code", label: "Code", value: sub?.code, half: true },
      { name: "semester_id", label: "Semestre", type: "select", options: semOpts, value: sub?.semester_id ?? semesterId ?? currentSemester()?.id, half: true },
      { name: "ue", label: "Unité d'enseignement", value: sub?.ue },
      { name: "ects", label: "ECTS", type: "number", step: "0.5", value: sub?.ects, half: true },
      { name: "coef", label: "Coefficient", type: "number", step: "0.5", value: sub?.coef, half: true },
      { name: "teacher", label: "Enseignant·e", value: sub?.teacher },
      { name: "description", label: "Description / objectifs", type: "textarea", value: sub?.description },
    ],
    submitLabel: sub ? "Enregistrer" : "Créer la matière",
    onSubmit: async (d) => {
      if (!sub) d.position = subjectsIn(d.semester_id).length;
      const row = sub ? await update("subjects", sub.id, d) : await insert("subjects", d);
      put("subjects", row);
      if (!sub) location.hash = `#/m/${row.id}`;
    },
    del: sub && {
      label: "Supprimer la matière",
      confirm: `Supprimer « ${sub.name} », ses séances et ses ressources ?`,
      run: async () => {
        const paths = state.resources.filter((r) => r.subject_id === sub.id && r.storage_path).map((r) => r.storage_path);
        if (paths.length) await sb.storage.from("resources").remove(paths);
        await remove("subjects", sub.id); await loadAll(); location.hash = `#/s/${sub.semester_id}`;
      },
    },
  });
}

function unitForm(unit, subjectId) {
  openForm({
    title: unit ? "Modifier" : "Ajouter une séance ou un chapitre",
    fields: [
      { name: "title", label: "Titre", value: unit?.title, required: true },
      { name: "kind", label: "Type", type: "select", options: UNIT_KINDS.map((k) => [k, k]), value: unit?.kind ?? "Chapitre", half: true },
      { name: "date", label: "Date", type: "date", value: unit?.date, half: true },
      { name: "status", label: "État", type: "select", options: Object.entries(STATUS).map(([k, s]) => [k, s.label]), value: unit?.status ?? "todo" },
      { name: "notes", label: "Notes", type: "textarea", value: unit?.notes, placeholder: "Points à retravailler, questions pour le prof…" },
    ],
    submitLabel: unit ? "Enregistrer" : "Ajouter",
    onSubmit: async (d) => {
      if (!unit) { d.subject_id = subjectId; d.position = unitsOf(subjectId).length; }
      put("units", unit ? await update("units", unit.id, d) : await insert("units", d));
    },
    del: unit && { confirm: `Supprimer « ${unit.title} » ?`, run: async () => { await remove("units", unit.id); drop("units", unit.id); } },
  });
}

function examForm(exam, subjectId) {
  const subOpts = [["", "Aucune"], ...[...state.semesters].sort(byPos).flatMap((sem) => subjectsIn(sem.id).map((s) => [s.id, `${sem.name} / ${s.name}`]))];
  openForm({
    title: exam ? "Modifier l'examen" : "Nouvel examen",
    fields: [
      { name: "title", label: "Intitulé", value: exam?.title, required: true, placeholder: "Partiel de routage" },
      { name: "subject_id", label: "Matière", type: "select", options: subOpts, value: exam?.subject_id ?? subjectId ?? "" },
      { name: "kind", label: "Type", type: "select", options: EXAM_KINDS.map((k) => [k, k]), value: exam?.kind ?? "Partiel", half: true },
      { name: "starts_at", label: "Date et heure", type: "datetime-local", value: toLocalInput(exam?.starts_at), required: true, half: true },
      { name: "location", label: "Salle", value: exam?.location, half: true },
      { name: "coef", label: "Coefficient", type: "number", step: "0.5", value: exam?.coef, half: true },
      { name: "grade", label: "Note obtenue (/20)", type: "number", step: "0.25", min: 0, max: 20, value: exam?.grade },
      { name: "notes", label: "Notes", type: "textarea", value: exam?.notes, placeholder: "Documents autorisés, chapitres au programme…" },
    ],
    submitLabel: exam ? "Enregistrer" : "Ajouter l'examen",
    onSubmit: async (d) => put("exams", exam ? await update("exams", exam.id, d) : await insert("exams", d)),
    del: exam && { confirm: `Supprimer « ${exam.title} » ?`, run: async () => { await remove("exams", exam.id); drop("exams", exam.id); } },
  });
}

function linkForm(link) {
  const cats = [...new Set(state.links.map((l) => l.category).filter(Boolean))];
  openForm({
    title: link ? "Modifier l'accès" : "Nouvel accès",
    intro: cats.length ? `Catégories existantes : ${cats.map(esc).join(", ")}` : "",
    fields: [
      { name: "title", label: "Nom", value: link?.title, required: true, placeholder: "ENT ESIEE" },
      { name: "url", label: "Adresse", type: "url", value: link?.url, required: true, placeholder: "https://" },
      { name: "category", label: "Catégorie", value: link?.category, placeholder: "École, Alternance, Outils…" },
      { name: "notes", label: "Notes", type: "textarea", value: link?.notes },
    ],
    submitLabel: link ? "Enregistrer" : "Ajouter l'accès",
    onSubmit: async (d) => {
      if (!/^https?:\/\//i.test(d.url)) d.url = "https://" + d.url;
      if (!link) d.position = state.links.length;
      put("links", link ? await update("links", link.id, d) : await insert("links", d));
    },
    del: link && { confirm: `Supprimer « ${link.title} » ?`, run: async () => { await remove("links", link.id); drop("links", link.id); } },
  });
}

function resourceForm(res, subjectId) {
  const unitOpts = [["", "Général (toute la matière)"], ...unitsOf(res?.subject_id ?? subjectId).map((u, i) => [u.id, `${i + 1}. ${u.title}`])];
  const isLink = !res || res.kind === "link";
  openForm({
    title: res ? "Modifier la ressource" : "Ajouter un lien",
    intro: res ? "" : "Google Docs, Sheets, Slides, vidéo, page Moodle…",
    fields: [
      { name: "title", label: "Titre", value: res?.title, required: true },
      ...(isLink ? [{ name: "url", label: "Adresse", type: "url", value: res?.url, required: true, placeholder: "https://" }] : []),
      { name: "unit_id", label: "Rattacher à", type: "select", options: unitOpts, value: res?.unit_id ?? "" },
    ],
    submitLabel: res ? "Enregistrer" : "Ajouter le lien",
    onSubmit: async (d) => {
      if (d.url && !/^https?:\/\//i.test(d.url)) d.url = "https://" + d.url;
      if (!res) { d.subject_id = subjectId; d.kind = "link"; }
      put("resources", res ? await update("resources", res.id, d) : await insert("resources", d));
    },
    del: res && { confirm: `Supprimer « ${res.title} » ?`, run: () => deleteResource(res) },
  });
}

async function deleteResource(res) {
  if (res.storage_path) await sb.storage.from("resources").remove([res.storage_path]);
  await remove("resources", res.id); drop("resources", res.id);
}

async function uploadFiles(files, subjectId) {
  const list = [...files]; if (!list.length) return;
  let ok = 0;
  for (const file of list) {
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name} dépasse 50 Mo, la limite par fichier du plan gratuit.`, true); continue; }
    toast(`Envoi de ${file.name}…`);
    const safe = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.\-]+/g, "_");
    const path = `${state.user.id}/${subjectId}/${Date.now()}_${safe}`;
    const { error } = await sb.storage.from("resources").upload(path, file, { contentType: file.type || undefined });
    if (error) { fail(error); continue; }
    const row = await insert("resources", { subject_id: subjectId, title: file.name, kind: "file", storage_path: path, mime: file.type || null, size: file.size });
    delete row.text_content; put("resources", row);
    if (isPdf(row)) await indexPdf(row, file).catch((e) => console.warn("extraction", e));
    ok++;
  }
  if (ok) toast(ok === 1 ? "Fichier ajouté." : `${ok} fichiers ajoutés.`);
  render();
}

/* =========================================================
   Vues
   ========================================================= */
/* =========================================================
   Planning (flux iCal de l'école, relayé par la fonction Supabase « planning »)
   ========================================================= */
const planning = { events: [], loadedAt: 0, loading: false, error: null, week: 0, month: 0, view: "week" };
const PLANNING_TTL = 5 * 60000;

function icsDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v || "");
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", se = "0", z] = m;
  return z ? new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +se)) : new Date(+y, mo - 1, +d, +h, +mi, +se);
}
const icsText = (v) => (v || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = []; let cur = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") cur = {};
    else if (l === "END:VEVENT") { if (cur) out.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(":"); if (i > 0) cur[l.slice(0, i).split(";")[0].toUpperCase()] = l.slice(i + 1); }
  }
  return out.map((e) => ({
    uid: e.UID,
    start: icsDate(e.DTSTART), end: icsDate(e.DTEND),
    title: icsText(e.SUMMARY), location: icsText(e.LOCATION),
    details: icsText(e.DESCRIPTION).split("\n").map((x) => x.trim()).filter((x) => x && !/^\(Export/i.test(x)),
  })).filter((e) => e.start).sort((a, b) => a.start - b.start);
}

const norm = (t) => ` ${String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
// Rattache un cours à une matière : intitulé complet présent dans le titre ou la description
// (le plus long gagne, pour distinguer « ingénieur I » de « ingénieur II »), sinon préfixe du titre.
function matchSubject(ev) {
  const hay = norm(ev.title + " " + ev.details.join(" "));
  const t = norm(ev.title);
  const byLen = (a, b) => b.name.length - a.name.length;
  const full = state.subjects.filter((s) => hay.includes(norm(s.name))).sort(byLen);
  if (full.length) return full[0];
  if (t.trim().length < 6) return null;
  const pref = state.subjects.filter((s) => norm(s.name).startsWith(t.slice(0, -1)));
  const cur = currentSemester();
  return pref.find((s) => s.semester_id === cur?.id) || pref[0] || null;
}

async function loadPlanning(force = false) {
  if (planning.loading) return;
  if (!force && planning.loadedAt && Date.now() - planning.loadedAt < PLANNING_TTL) return;
  planning.loading = true;
  try {
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/planning`, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!r.ok) {
      let msg = `Erreur ${r.status}`;
      try { msg = (await r.json()).error || msg; } catch { /* réponse non JSON */ }
      throw new Error(msg);
    }
    planning.events = parseICS(await r.text()).map((e, i) => ({ ...e, i, subject: matchSubject(e) }));
    planning.error = null;
  } catch (e) {
    planning.error = e.message || String(e);
  } finally {
    planning.loading = false;
    planning.loadedAt = Date.now();
    render();
  }
}
const hasPlanningUrl = () => Boolean(state.settings?.[0]?.ics_url);


/* ---------- couleurs, enseignants, bulle de détails ---------- */
const PALETTE = ["#AF7EFF", "#FF66A3", "#7CD3FF", "#6EE7B7", "#FFB37C", "#FFE066",
  "#C8B6FF", "#FF8A8A", "#5ED3C9", "#FFB6E6", "#A3E635", "#F0ABFC"];
// Même matière = même couleur : rang stable de la matière dans le programme,
// sinon empreinte de l'intitulé pour les cours non rattachés.
function courseColor(e) {
  if (e.subject) {
    const list = [...state.subjects].sort((x, y) =>
      (semesterOf(x.semester_id)?.position ?? 0) - (semesterOf(y.semester_id)?.position ?? 0) || (x.position ?? 0) - (y.position ?? 0));
    const i = list.findIndex((x) => x.id === e.subject.id);
    if (i >= 0) return PALETTE[i % PALETTE.length];
  }
  let h = 0; for (const ch of norm(e.title)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const TEACHER_RE = /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’ -]+\s[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+(?:[ -][A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’-]+)*$/;
const teachersOf = (e) => e.details.filter((l) => TEACHER_RE.test(l));
const fmtTime = (d) => fmtDate(d, { hour: "2-digit", minute: "2-digit" });
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
const sameDay = (a, b) => a.toDateString() === b.toDateString();

function closePop() { document.querySelector(".pop")?.remove(); }
function showPop(anchor, e) {
  closePop();
  const t = teachersOf(e);
  const others = e.details.filter((l) => !t.includes(l));
  const pop = document.createElement("div");
  pop.className = "pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", e.title);
  pop.style.setProperty("--c", courseColor(e));
  pop.innerHTML = `<button class="ghost pop-x" data-pop-close aria-label="Fermer">✕</button>
    <h3>${esc(e.title)}</h3>
    <p><strong>${fmtDate(e.start, { weekday: "long", day: "numeric", month: "long" })}</strong>, ${fmtTime(e.start)}–${fmtTime(e.end)}</p>
    ${e.location ? `<p>Salle : <strong>${esc(e.location)}</strong></p>` : ""}
    ${t.length ? `<p>Enseignant${t.length > 1 ? "s" : ""} : ${t.map(esc).join(", ")}</p>` : ""}
    ${others.length ? `<p class="small muted">${others.map(esc).join("<br>")}</p>` : ""}
    ${e.subject ? `<a class="btn" href="#/m/${e.subject.id}">Ouvrir la matière</a>` : ""}`;
  document.body.appendChild(pop);
  if (innerWidth < 720) { pop.classList.add("sheet"); return; }
  const r = anchor.getBoundingClientRect(); const pw = pop.offsetWidth; const ph = pop.offsetHeight;
  let left = r.right + 10;
  if (left + pw > innerWidth - 10) left = r.left - pw - 10;
  if (left < 10) left = Math.min(Math.max(10, r.left), innerWidth - pw - 10);
  const top = Math.min(Math.max(10, r.top), innerHeight - ph - 10);
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
}
document.addEventListener("click", (ev) => {
  const pop = document.querySelector(".pop"); if (!pop) return;
  if (ev.target.closest("[data-pop-close]") || ev.target.closest(".pop a")) { closePop(); return; }
  if (!ev.target.closest(".pop") && !ev.target.closest("[data-action=course]")) closePop();
});
addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePop(); });
addEventListener("scroll", closePop, { passive: true, capture: true });

/* ---------- blocs de cours ---------- */
// Carte compacte : intitulé, enseignant, salle (l'heure n'apparaît que hors grille horaire)
function courseCard(e, { time = false, day = false } = {}) {
  const now = new Date(); const live = e.start <= now && now < e.end; const past = e.end <= now;
  const t = teachersOf(e);
  return `<button class="course${live ? " live" : ""}${past ? " past" : ""}" data-action="course" data-i="${e.i}" style="--c:${courseColor(e)}">
    ${time ? `<span class="when">${day ? `${fmtDate(e.start, { weekday: "short", day: "numeric", month: "short" })}, ` : ""}${fmtTime(e.start)}–${fmtTime(e.end)}${live ? " · en cours" : ""}</span>` : ""}
    <span class="what">${esc(e.title)}</span>
    ${t.length ? `<span class="who">${esc(t.join(", "))}</span>` : ""}
    ${e.location ? `<span class="where">${esc(e.location)}</span>` : ""}
  </button>`;
}

function weekStart(offset) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
  return d;
}

// Grille horaire (écrans larges) : position et hauteur proportionnelles à l'heure
function weekGrid(days, evs) {
  const PPM = 1.15; // pixels par minute
  let from = 8 * 60, to = 18 * 60;
  for (const e of evs) { from = Math.min(from, minutesOf(e.start)); to = Math.max(to, minutesOf(e.end) || 24 * 60); }
  from = Math.floor(from / 60) * 60; to = Math.ceil(to / 60) * 60;
  const hours = []; for (let m = from; m < to; m += 60) hours.push(m);
  const today = new Date(); const nowM = minutesOf(today);

  const col = (d) => {
    const list = evs.filter((e) => sameDay(e.start, d)).sort((a, b) => a.start - b.start);
    // répartition en couloirs des cours qui se chevauchent
    const placed = []; let cluster = []; let clusterEnd = 0;
    const flush = () => { const n = Math.max(...cluster.map((c) => c.lane)) + 1; cluster.forEach((c) => (c.n = n)); cluster = []; };
    for (const e of list) {
      if (cluster.length && e.start >= clusterEnd) flush();
      const used = cluster.filter((c) => c.e.end > e.start).map((c) => c.lane);
      let lane = 0; while (used.includes(lane)) lane++;
      const item = { e, lane }; cluster.push(item); placed.push(item);
      clusterEnd = Math.max(clusterEnd, +e.end);
    }
    if (cluster.length) flush();
    return `<div class="wg-col${sameDay(d, today) ? " today" : ""}" style="height:${(to - from) * PPM}px">
      ${hours.map((m) => `<span class="wg-line" style="top:${(m - from) * PPM}px"></span>`).join("")}
      ${sameDay(d, today) && nowM >= from && nowM <= to ? `<span class="wg-now" style="top:${(nowM - from) * PPM}px"></span>` : ""}
      ${placed.map(({ e, lane, n }) => {
        const top = (minutesOf(e.start) - from) * PPM; const h = Math.max(22, (e.end - e.start) / 60000 * PPM - 3);
        return `<div class="wg-ev${h < 56 ? " short" : ""}" style="top:${top}px;height:${h}px;left:calc(${(lane / n) * 100}% + 2px);width:calc(${100 / n}% - 4px)">${courseCard(e)}</div>`;
      }).join("")}
    </div>`;
  };
  return `<div class="wg" style="--days:${days.length}">
    <div class="wg-head"><span></span>${days.map((d) => `<span class="${sameDay(d, today) ? "today" : ""}">${fmtDate(d, { weekday: "short", day: "numeric" })}</span>`).join("")}</div>
    <div class="wg-body">
      <div class="wg-hours" style="height:${(to - from) * PPM}px">${hours.map((m) => `<span style="top:${(m - from) * PPM}px">${String(m / 60).padStart(2, "0")}h</span>`).join("")}</div>
      ${days.map(col).join("")}
    </div></div>`;
}

// Liste par jour (mobile)
function weekList(days, evs) {
  const today = new Date();
  return `<div class="wl">${days.map((d) => {
    const list = evs.filter((e) => sameDay(e.start, d));
    return `<div class="wl-day${sameDay(d, today) ? " today" : ""}"><h3>${fmtDate(d, { weekday: "long", day: "numeric", month: "short" })}</h3>
      ${list.length ? list.map((e) => courseCard(e, { time: true })).join("") : `<p class="small muted">Pas de cours</p>`}</div>`;
  }).join("")}</div>`;
}

function monthGrid(offset) {
  const first = new Date(); first.setHours(0, 0, 0, 0); first.setDate(1); first.setMonth(first.getMonth() + offset);
  const gridStart = new Date(first); gridStart.setDate(1 - ((first.getDay() + 6) % 7));
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const cells = []; const d = new Date(gridStart);
  while (d <= lastDay || cells.length % 7) { cells.push(new Date(d)); d.setDate(d.getDate() + 1); }
  const today = new Date();
  const MAX = 4;
  return `<div class="mg">
    ${["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."].map((n) => `<span class="mg-dow">${n}</span>`).join("")}
    ${cells.map((c) => {
      const list = planning.events.filter((e) => sameDay(e.start, c));
      const out = c.getMonth() !== first.getMonth();
      return `<div class="mg-cell${out ? " out" : ""}${sameDay(c, today) ? " today" : ""}${c.getDay() % 6 === 0 ? " we" : ""}">
        <button class="mg-num" data-action="goto-week" data-date="${c.toISOString()}" aria-label="Voir la semaine du ${fmtDay(c)}">${c.getDate()}</button>
        ${list.slice(0, MAX).map((e) => `<button class="chip" data-action="course" data-i="${e.i}" style="--c:${courseColor(e)}" title="${esc(e.title)}"><b>${fmtTime(e.start)}</b> ${esc(e.title)}</button>`).join("")}
        ${list.length > MAX ? `<button class="chip more" data-action="goto-week" data-date="${c.toISOString()}">+${list.length - MAX}</button>` : ""}
      </div>`;
    }).join("")}
  </div>`;
}

function viewPlanning() {
  if (!hasPlanningUrl()) {
    return `<div class="page-head"><div><h1>Planning</h1></div></div>
      <div class="empty-state"><p>Ajoute le lien iCal de ton emploi du temps (ADE : Exporter l'agenda, puis Générer URL) pour l'afficher ici.</p>
      <a class="btn" href="#/reglages">Ajouter le lien</a></div>`;
  }
  if (!planning.loading && Date.now() - planning.loadedAt > PLANNING_TTL) loadPlanning();
  const month = planning.view === "month";
  const last = planning.events[planning.events.length - 1];
  let label, count, body, rangeStart;

  if (month) {
    const first = new Date(); first.setDate(1); first.setMonth(first.getMonth() + planning.month);
    rangeStart = first;
    label = fmtDate(first, { month: "long", year: "numeric" });
    count = planning.events.filter((e) => e.start.getMonth() === first.getMonth() && e.start.getFullYear() === first.getFullYear()).length;
    body = monthGrid(planning.month);
  } else {
    const start = weekStart(planning.week); rangeStart = start;
    const end = new Date(start); end.setDate(end.getDate() + 7);
    const evs = planning.events.filter((e) => e.start >= start && e.start < end);
    const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; })
      .filter((d, i) => i < 5 || evs.some((e) => sameDay(e.start, d)));
    const sat = new Date(end); sat.setDate(sat.getDate() - 2);
    label = `Semaine du ${fmtDate(start, { day: "numeric", month: "short" })} au ${fmtDate(sat, { day: "numeric", month: "short" })}`;
    count = evs.length;
    body = weekGrid(days, evs) + weekList(days, evs);
  }
  if (planning.loading && !planning.events.length) body = `<p class="muted">Récupération du planning…</p>`;
  else if (planning.error && !planning.events.length) body = `<div class="empty-state"><p>Impossible de récupérer le planning : ${esc(planning.error)}</p><button data-action="planning-refresh">Réessayer</button></div>`;
  const beyond = last && rangeStart > last.start
    ? `<p class="muted" style="margin-top:1rem">L'école n'a pas encore publié le planning au-delà du ${fmtDay(last.start)}.</p>` : "";

  return `<div class="page-head"><div><h1>Planning</h1>
      <p class="meta"><span>${label}</span><span>${count} cours</span>${planning.loadedAt ? `<span>actualisé à ${fmtTime(new Date(planning.loadedAt))}</span>` : ""}</p></div></div>
    <div class="toolbar">
      <span class="seg" role="group" aria-label="Affichage">
        <button data-action="planning-view" data-v="week" class="${month ? "" : "on"}" aria-pressed="${!month}">Semaine</button>
        <button data-action="planning-view" data-v="month" class="${month ? "on" : ""}" aria-pressed="${month}">Mois</button>
      </span>
      <span class="actions">
        <button data-action="shift" data-d="-1" aria-label="${month ? "Mois précédent" : "Semaine précédente"}">‹</button>
        <button data-action="shift" data-d="0">Aujourd'hui</button>
        <button data-action="shift" data-d="1" aria-label="${month ? "Mois suivant" : "Semaine suivante"}">›</button>
        <button class="ghost" data-action="planning-refresh" ${planning.loading ? "disabled" : ""}>${planning.loading ? "Actualisation…" : "Actualiser"}</button>
      </span>
    </div>
    ${body}${beyond}`;
}

function nextCoursesSection() {
  if (!hasPlanningUrl()) return "";
  if (!planning.loading && Date.now() - planning.loadedAt > PLANNING_TTL) loadPlanning();
  const now = new Date();
  const next = planning.events.filter((e) => e.end > now).slice(0, 3);
  if (!next.length) return "";
  return `<section><div class="sec-head"><h2>Prochains cours</h2><a href="#/planning" class="small">Voir le planning</a></div>
    <div class="course-row">${next.map((e) => courseCard(e, { time: true, day: true })).join("")}</div></section>`;
}

/* =========================================================
   Révision : quiz et flashcards générés par Mistral (fonction Supabase « quiz »)
   ========================================================= */
const DIFFS = { facile: "Facile", moyen: "Moyen", difficile: "Difficile" };
const GAME_SIZE = 10;
let reviseDiff = "moyen";
let study = null; // partie en cours

const poolOf = (subjectId, diff) => (state.quizPools || []).find((p) => p.subject_id === subjectId && p.difficulty === diff);
function attemptsOf(subjectId, diff) {
  const pool = poolOf(subjectId, diff);
  if (!pool) return [];
  // seules les parties jouées sur la version actuelle du jeu comptent
  return (state.quizAttempts || []).filter((a) => a.subject_id === subjectId && a.difficulty === diff && a.content_hash === pool.content_hash);
}

function reviseSection(sub) {
  const pool = poolOf(sub.id, reviseDiff);
  const att = attemptsOf(sub.id, reviseDiff);
  const pct = (a) => Math.round((a.score / a.total) * 100);
  const best = att.length ? att.reduce((m, a) => (pct(a) > pct(m) ? a : m)) : null;
  const pdfs = state.resources.filter((r) => r.subject_id === sub.id && r.kind === "file" && /\.pdf$/i.test(r.title)).length;
  return `<section>
    <div class="sec-head"><h2>Réviser</h2>
      <span class="seg" role="group" aria-label="Difficulté">${Object.entries(DIFFS).map(([k, l]) =>
        `<button data-action="revise-diff" data-d="${k}" class="${reviseDiff === k ? "on" : ""}" aria-pressed="${reviseDiff === k}">${l}</button>`).join("")}</span></div>
    <div class="revise">
      <div class="actions">
        <button class="primary" data-action="study" data-id="${sub.id}" data-mode="quiz">Lancer un quiz</button>
        <button class="primary" data-action="study" data-id="${sub.id}" data-mode="flashcards">Lancer les flashcards</button>
        ${pool ? `<button class="ghost" data-action="study-regen" data-id="${sub.id}">Régénérer les questions</button>` : ""}
      </div>
      <p class="small muted">${pool
        ? `Jeu de ${pool.item_count} questions généré le ${fmtDate(pool.created_at, { day: "numeric", month: "short" })} à partir de ${pool.sources?.pdfs?.length || 0} PDF et du plan du cours. Chaque partie en tire ${GAME_SIZE} au hasard.
           ${pool.sources?.skipped?.length ? ` Non lus : ${pool.sources.skipped.map(esc).join(", ")}.` : ""}`
        : `Aucun jeu en niveau ${DIFFS[reviseDiff].toLowerCase()} pour l'instant : le premier lancement génère ${pdfs ? `les questions à partir de tes ${pdfs} PDF et du plan du cours` : "les questions à partir du plan du cours (ajoute tes PDF dans Ressources pour des questions plus précises)"}. Compte jusqu'à une minute.`}</p>
      ${att.length ? `<div class="scores">
        <span><b>${att.length}</b> partie${att.length > 1 ? "s" : ""}</span>
        <span>meilleur <b>${best.score}/${best.total}</b></span>
        <span>dernier <b>${att[0].score}/${att[0].total}</b> (${att[0].mode === "quiz" ? "quiz" : "flashcards"}, ${fmtDate(att[0].created_at, { day: "numeric", month: "short" })})</span>
      </div>` : ""}
    </div>
  </section>`;
}

const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

/* ---------- extraction du texte des PDF (dans le navigateur, une seule fois par fichier) ---------- */
const isPdf = (r) => r.kind === "file" && ((r.mime || "").includes("pdf") || /\.pdf$/i.test(r.title));
let pdfjsPromise = null;
async function pdfText(data) {
  pdfjsPromise ||= import("./vendor/pdfjs-unpdf-2.2.3.mjs"); // chargé à la demande (1,7 Mo)
  const { getDocument } = await pdfjsPromise;
  const task = getDocument({ data, isEvalSupported: false, useSystemFonts: true, disableFontFace: true });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ").trim());
    page.cleanup();
  }
  await task.destroy?.();
  return pages.join("\n\n").slice(0, 400000);
}
async function indexPdf(res, file) {
  const bytes = new Uint8Array(await (file || (await sb.storage.from("resources").download(res.storage_path)).data).arrayBuffer());
  const text = await pdfText(bytes);
  await q(sb.from("resources").update({ text_content: text, text_chars: text.length }).eq("id", res.id));
  res.text_chars = text.length;
}

async function startStudy(subjectId, mode, force = false) {
  const t0 = Date.now();
  study = { subjectId, mode, difficulty: reviseDiff, loading: true, t0 };
  const tick = setInterval(() => {
    const el = document.querySelector("[data-elapsed]");
    if (!study?.loading) return clearInterval(tick);
    if (el) el.textContent = `${Math.round((Date.now() - t0) / 1000)} s`;
  }, 1000);
  if (location.hash !== `#/reviser/${subjectId}`) location.hash = `#/reviser/${subjectId}`; else render();
  try {
    const todo = state.resources.filter((r) => r.subject_id === subjectId && isPdf(r) && r.text_chars == null);
    for (const [i, r] of todo.entries()) {
      study.step = `Lecture des PDF (${i + 1}/${todo.length}) : ${r.title}`; render();
      try { await indexPdf(r); } catch (e) { console.warn("extraction", r.title, e); r.text_chars = 0; }
    }
    study.step = "Génération des questions par Mistral…"; render();
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/quiz`, {
      signal: AbortSignal.timeout(170000),
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ subject_id: subjectId, difficulty: study.difficulty, force }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error ? `${out.error}${out.detail ? ` (détail : ${out.detail.slice(0, 160)})` : ""}` : `Erreur ${r.status} du serveur.`);
    const { items, ...meta } = out.pool;
    state.quizPools = [...(state.quizPools || []).filter((p) => p.id !== meta.id && !(p.subject_id === subjectId && p.difficulty === meta.difficulty)), meta];
    const picked = shuffle(items).slice(0, GAME_SIZE).map((it) => {
      const order = shuffle([0, 1, 2, 3]);
      return { ...it, choices: order.map((k) => it.choices[k]), correct: order.indexOf(it.correct) };
    });
    Object.assign(study, { loading: false, hash: meta.content_hash, items: picked, idx: 0, score: 0, picked: null, flipped: false, misses: [], fresh: !out.cached });
  } catch (e) {
    const msg = e.name === "TimeoutError" ? "La génération n'a pas abouti à temps. Réessaie dans un instant." : (e.message || String(e));
    Object.assign(study, { loading: false, error: msg });
  }
  render();
}

async function finishStudy() {
  study.done = true;
  render();
  try {
    const row = await q(sb.from("quiz_attempts").insert({
      subject_id: study.subjectId, difficulty: study.difficulty, mode: study.mode,
      content_hash: study.hash, score: study.score, total: study.items.length,
    }).select().single());
    state.quizAttempts = [row, ...(state.quizAttempts || [])];
  } catch (e) { fail(e); }
}

function viewStudy() {
  const sub = subjectOf(route().b);
  if (!sub) return notFound();
  if (!study || study.subjectId !== sub.id) { setTimeout(() => (location.hash = `#/m/${sub.id}`)); return ""; }
  const head = `<div class="page-head"><div>
      <p class="small muted"><a href="#/m/${sub.id}">${esc(sub.name)}</a></p>
      <h1>${study.mode === "quiz" ? "Quiz" : "Flashcards"}</h1>
      <p class="meta"><span>${DIFFS[study.difficulty]}</span>${study.items ? `<span>${Math.min(study.idx + 1, study.items.length)} / ${study.items.length}</span><span>score ${study.score}</span>` : ""}</p></div>
      <div class="actions"><a class="btn" href="#/m/${sub.id}">Quitter</a></div></div>`;
  if (study.loading) return head + `<div class="empty-state"><p>${esc(study.step || "Préparation des questions…")} <b data-elapsed>${Math.round((Date.now() - study.t0) / 1000)} s</b></p>
    <p class="small muted">Si le jeu doit être généré, Mistral lit le texte de tes PDF : compte 30 secondes à 1 minute 30. Ne quitte pas la page.</p></div>`;
  if (study.error) return head + `<div class="empty-state"><p>${esc(study.error)}</p><button data-action="study" data-id="${sub.id}" data-mode="${study.mode}">Réessayer</button></div>`;

  if (study.done) {
    const pctv = Math.round((study.score / study.items.length) * 100);
    const prev = attemptsOf(sub.id, study.difficulty).slice(1);
    const best = prev.length ? Math.max(...prev.map((a) => Math.round((a.score / a.total) * 100))) : null;
    return head + `<div class="study-card result">
      <p class="big">${study.score} / ${study.items.length}</p>
      <p>${pctv} % de bonnes réponses${best != null ? (pctv > best ? ", nouveau record" : `, record actuel ${best} %`) : ""}.</p>
      <div class="actions"><button class="primary" data-action="study" data-id="${sub.id}" data-mode="${study.mode}">Rejouer (nouveau tirage)</button>
        <button data-action="study" data-id="${sub.id}" data-mode="${study.mode === "quiz" ? "flashcards" : "quiz"}">Passer en ${study.mode === "quiz" ? "flashcards" : "quiz"}</button></div>
    </div>
    ${study.misses.length ? `<section><div class="sec-head"><h2>À retravailler</h2></div><div class="rows">${study.misses.map((it) =>
      `<div class="rowi"><div><div class="t">${esc(it.question)}</div><div class="sub"><b>${esc(it.answer)}</b>. ${esc(it.explanation || "")}</div></div></div>`).join("")}</div></section>` : ""}`;
  }

  const it = study.items[study.idx];
  const last = study.idx === study.items.length - 1;
  const chapter = it.chapter ? `<p class="small muted">${esc(it.chapter)}</p>` : "";
  if (study.mode === "quiz") {
    const answered = study.picked != null;
    return head + `<div class="study-card">
      ${chapter}<h2 class="q">${esc(it.question)}</h2>
      <div class="choices">${it.choices.map((c, k) => {
        const cls = !answered ? "" : k === it.correct ? " good" : k === study.picked ? " bad" : " dim";
        return `<button class="choice${cls}" data-action="answer" data-k="${k}" ${answered ? "disabled" : ""}><b>${"ABCD"[k]}</b> ${esc(c)}</button>`;
      }).join("")}</div>
      ${answered ? `<p class="explain">${study.picked === it.correct ? "Bonne réponse." : `Réponse attendue : <b>${esc(it.choices[it.correct])}</b>.`} ${esc(it.explanation || "")}</p>
        <div class="actions"><button class="primary" data-action="next-q">${last ? "Voir mon score" : "Question suivante"}</button></div>` : ""}
    </div>`;
  }
  return head + `<div class="study-card flash${study.flipped ? " flipped" : ""}">
    ${chapter}<h2 class="q">${esc(it.question)}</h2>
    ${study.flipped
      ? `<div class="answer"><p class="a">${esc(it.answer)}</p>${it.explanation ? `<p class="small muted">${esc(it.explanation)}</p>` : ""}</div>
         <div class="actions"><button class="primary" data-action="flash" data-ok="1">Je savais</button><button data-action="flash" data-ok="0">À revoir</button></div>`
      : `<div class="actions"><button class="primary" data-action="flip">Voir la réponse</button></div><p class="small muted">Raccourcis : espace pour retourner, 1 = je savais, 2 = à revoir.</p>`}
  </div>`;
}

function viewDashboard() {
  const upcoming = sortedExams(state.exams).filter((e) => daysUntil(e.starts_at) >= 0);
  const next = upcoming[0];
  const toReview = state.units.filter((u) => u.status === "review");
  const sems = [...state.semesters].sort(byPos);
  const cur = currentSemester();
  const ordered = cur ? [cur, ...sems.filter((s) => s.id !== cur.id).reverse()] : [];

  if (!sems.length) {
    return `<div class="page-head"><div><h1>Ton carnet est vide</h1>
      <p class="meta">Importe ton syllabus pour générer semestres, matières et chapitres d'un coup, ou crée-les à la main.</p></div></div>
      <div class="actions"><a class="btn" href="#/reglages">Importer un syllabus</a><button class="primary" data-action="new-semester">Créer un semestre</button></div>`;
  }

  const head = next
    ? (() => { const d = daysUntil(next.starts_at); const sub = subjectOf(next.subject_id);
        return `<h1>${d === 0 ? "Examen aujourd'hui" : d === 1 ? "Examen demain" : `Prochain examen dans ${d} jours`}</h1>
        <p class="meta"><span>${esc(next.title)}${sub ? `, ${esc(sub.name)}` : ""}</span><span>${fmtDT(next.starts_at)}</span></p>`; })()
    : `<h1>Aucun examen à venir</h1><p class="meta"><span>Ajoute tes dates dès qu'elles tombent.</span></p>`;

  return `<div class="page-head"><div>${head}</div>
      <div class="actions"><button data-action="new-exam">Ajouter un examen</button></div></div>

    ${nextCoursesSection()}

    ${upcoming.length ? `<section><div class="sec-head"><h2>À venir</h2><a href="#/examens" class="small">Tous les examens</a></div>
      <div class="exam-list">${upcoming.slice(0, 5).map(examRow).join("")}</div></section>` : ""}

    ${ordered.map((sem) => `<section>
      <div class="sec-head"><h2><a href="#/s/${sem.id}" style="color:inherit;text-decoration:none">${esc(sem.name)}</a>${sem.id === cur?.id ? ` <span class="small muted">en cours</span>` : ""}</h2>
        ${sem.id === cur?.id ? legend() : ""}</div>
      ${ledger(subjectsIn(sem.id))}</section>`).join("")}

    ${toReview.length ? `<section><div class="sec-head"><h2>À revoir</h2><span class="small muted">${toReview.length} point${toReview.length > 1 ? "s" : ""}</span></div>
      <div class="rows">${toReview.map((u) => { const s = subjectOf(u.subject_id);
        return `<div class="rowi"><div><div class="t">${esc(u.title)}</div><div class="sub">${esc(s?.name)}</div></div>
        <a class="btn" href="#/m/${u.subject_id}">Ouvrir</a></div>`; }).join("")}</div></section>` : ""}`;
}

function viewSemester(id) {
  const sem = semesterOf(id);
  if (!sem) return notFound();
  const subs = subjectsIn(id);
  const allUnits = subs.flatMap((s) => unitsOf(s.id));
  const p = progress(allUnits);
  const exams = sortedExams(state.exams.filter((e) => subs.some((s) => s.id === e.subject_id)));
  const ects = subs.reduce((a, s) => a + (Number(s.ects) || 0), 0);
  return `<div class="page-head"><div><h1>${esc(sem.name)}</h1>
      <p class="meta">${sem.start_date ? `<span>${fmtDay(sem.start_date)} au ${sem.end_date ? fmtDay(sem.end_date) : "?"}</span>` : ""}
      <span>${subs.length} matière${subs.length > 1 ? "s" : ""}</span>${ects ? `<span>${ects} ECTS</span>` : ""}${p != null ? `<span>${p} % de progression</span>` : ""}</p></div>
      <div class="actions"><button data-action="edit-semester" data-id="${id}">Modifier</button><button class="primary" data-action="new-subject" data-sem="${id}">Ajouter une matière</button></div></div>
    <section><div class="sec-head"><h2>Matières</h2>${legend()}</div>${ledger(subs)}</section>
    ${exams.length ? `<section><div class="sec-head"><h2>Examens</h2></div><div class="exam-list">${exams.map(examRow).join("")}</div></section>` : ""}`;
}

function viewSubject(id) {
  const sub = subjectOf(id);
  if (!sub) return notFound();
  const sem = semesterOf(sub.semester_id);
  const units = unitsOf(id);
  const p = progress(units);
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, units.filter((u) => u.status === k).length]));
  const res = state.resources.filter((r) => r.subject_id === id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const exams = sortedExams(state.exams.filter((e) => e.subject_id === id));

  const resRow = (r) => {
    const ext = r.kind === "link" ? "Lien" : (r.title.split(".").pop() || "").slice(0, 4).toUpperCase();
    return `<div class="res"><span class="ext">${esc(ext)}</span>
      <div><a class="t" href="${r.kind === "link" ? esc(r.url) : "#"}" ${r.kind === "link" ? `target="_blank" rel="noopener noreferrer"` : `data-action="open-res" data-id="${r.id}"`}>${esc(r.title)}</a>
      <div class="sub">${r.kind === "file" ? fmtSize(r.size) + ", " : ""}ajouté le ${fmtDate(r.created_at, { day: "numeric", month: "short" })}</div></div>
      <button class="ghost" data-action="edit-res" data-id="${r.id}">Modifier</button></div>`;
  };
  const groups = [{ title: "Général", items: res.filter((r) => !r.unit_id || !units.some((u) => u.id === r.unit_id)) },
    ...units.map((u, i) => ({ title: `${i + 1}. ${u.title}`, items: res.filter((r) => r.unit_id === u.id) }))].filter((g) => g.items.length);

  return `<div class="page-head"><div>
      <p class="small muted"><a href="#/s/${sem?.id}">${esc(sem?.name)}</a>${sub.code ? `, ${esc(sub.code)}` : ""}</p>
      <h1>${esc(sub.name)}</h1>
      <p class="meta">${sub.ue ? `<span>${esc(sub.ue)}</span>` : ""}${sub.ects ? `<span>${sub.ects} ECTS</span>` : ""}${sub.coef ? `<span>coef ${sub.coef}</span>` : ""}${sub.teacher ? `<span>${esc(sub.teacher)}</span>` : ""}</p></div>
      <div class="actions"><button data-action="edit-subject" data-id="${id}">Modifier</button></div></div>
    ${sub.description ? `<p class="muted" style="max-width:70ch;margin:-0.8rem 0 1.8rem;white-space:pre-wrap">${esc(sub.description)}</p>` : ""}

    <section>
      <div class="sec-head"><h2>Progression${p != null ? ` : ${p} %` : ""}</h2>${legend()}</div>
      ${strip(units, true)}
      <p class="small muted" style="margin-top:0.5rem">${units.length
        ? `${counts.done} maîtrisé${counts.done > 1 ? "s" : ""}, ${counts.review} à revoir, ${counts.doing} en cours, ${counts.todo} à voir. Clique sur une case pour changer son état.`
        : "Ajoute les séances ou chapitres de cette matière pour suivre ta progression."}</p>
    </section>

    ${reviseSection(sub)}

    <section>
      <div class="sec-head"><h2>Séances et chapitres</h2><button class="primary" data-action="new-unit" data-id="${id}">Ajouter</button></div>
      ${units.length ? `<div class="units">${units.map((u, i) => `<div class="unit">
        <div class="unit-main"><span class="idx">${i + 1}</span>
          <div class="title"><small>${esc(u.kind)}</small>${esc(u.title)}${u.date ? ` <span class="small muted">${fmtDate(u.date, { day: "numeric", month: "short" })}</span>` : ""}</div>
          <div class="ctrl">
            <span class="status-pick" role="group" aria-label="État">${Object.entries(STATUS).map(([k, s]) =>
              `<button data-action="set-status" data-id="${u.id}" data-s="${k}" class="${u.status === k ? "on" : ""}" aria-pressed="${u.status === k}">${s.label}</button>`).join("")}</span>
            <span class="dots" role="group" aria-label="Confiance">${[1, 2, 3, 4, 5].map((n) =>
              `<button data-action="set-conf" data-id="${u.id}" data-n="${n}" class="${(u.confidence || 0) >= n ? "on" : ""}" aria-label="Confiance ${n} sur 5" title="Confiance ${n}/5"></button>`).join("")}</span>
            <button class="ghost" data-action="move-unit" data-id="${u.id}" data-dir="-1" aria-label="Monter" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="ghost" data-action="move-unit" data-id="${u.id}" data-dir="1" aria-label="Descendre" ${i === units.length - 1 ? "disabled" : ""}>↓</button>
            <button class="ghost" data-action="edit-unit" data-id="${u.id}">Modifier</button>
          </div></div>
        ${u.notes ? `<div class="unit-notes">${esc(u.notes)}</div>` : ""}
      </div>`).join("")}</div>` : `<div class="empty-state"><p>Aucune séance pour l'instant.</p></div>`}
    </section>

    <section>
      <div class="sec-head"><h2>Ressources</h2><button data-action="new-link-res" data-id="${id}">Ajouter un lien</button></div>
      <label class="drop" data-drop="${id}">
        <input type="file" multiple hidden data-upload="${id}">
        Dépose tes fichiers ici ou <u>parcours</u>. PDF, slides, tableurs, archives : 50 Mo max par fichier.
      </label>
      ${groups.length ? groups.map((g) => `<div class="group"><h3 class="small muted" style="margin:0.8rem 0 0.3rem">${esc(g.title)}</h3><div class="res-list">${g.items.map(resRow).join("")}</div></div>`).join("") : ""}
    </section>

    <section>
      <div class="sec-head"><h2>Examens</h2><button data-action="new-exam" data-id="${id}">Ajouter un examen</button></div>
      ${exams.length ? `<div class="exam-list">${exams.map(examRow).join("")}</div>` : `<p class="muted">Aucun examen enregistré pour cette matière.</p>`}
    </section>`;
}

function viewExams() {
  const all = sortedExams(state.exams);
  const up = all.filter((e) => daysUntil(e.starts_at) >= 0);
  const past = all.filter((e) => daysUntil(e.starts_at) < 0).reverse();
  const graded = past.filter((e) => e.grade != null);
  const wsum = graded.reduce((a, e) => a + (Number(e.coef) || 1), 0);
  const avg = wsum ? graded.reduce((a, e) => a + e.grade * (Number(e.coef) || 1), 0) / wsum : null;
  return `<div class="page-head"><div><h1>Examens</h1>
      <p class="meta"><span>${up.length} à venir</span><span>${past.length} passé${past.length > 1 ? "s" : ""}</span>${avg != null ? `<span>moyenne pondérée ${avg.toFixed(2)}/20</span>` : ""}</p></div>
      <div class="actions">${all.length ? `<button data-action="ics">Exporter vers mon agenda (.ics)</button>` : ""}<button class="primary" data-action="new-exam">Ajouter un examen</button></div></div>
    <section><div class="sec-head"><h2>À venir</h2></div>${up.length ? `<div class="exam-list">${up.map(examRow).join("")}</div>` : `<p class="muted">Rien de prévu.</p>`}</section>
    ${past.length ? `<section><div class="sec-head"><h2>Passés</h2></div><div class="exam-list">${past.map(examRow).join("")}</div></section>` : ""}`;
}

function viewLinks() {
  const groups = {};
  [...state.links].sort(byPos).forEach((l) => (groups[l.category || "Divers"] ??= []).push(l));
  return `<div class="page-head"><div><h1>Accès</h1><p class="meta"><span>Tes liens importants. Les identifiants vont dans le <a href="#/coffre">coffre</a>.</span></p></div>
      <div class="actions"><button class="primary" data-action="new-link">Ajouter un accès</button></div></div>
    ${Object.keys(groups).length ? Object.entries(groups).map(([cat, ls]) => `<div class="group"><h3>${esc(cat)}</h3><div class="rows">${ls.map((l) => `
      <div class="rowi"><div><a class="t" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a>
        <div class="sub">${esc(l.url)}${l.notes ? `<br>${esc(l.notes)}` : ""}</div></div>
        <button class="ghost" data-action="edit-link" data-id="${l.id}">Modifier</button></div>`).join("")}</div></div>`).join("")
      : `<div class="empty-state"><p>Ajoute l'ENT, la plateforme de cours, la messagerie école, le portail alternance…</p><button class="primary" data-action="new-link">Ajouter un accès</button></div>`}`;
}

/* ---------- Coffre ---------- */
async function vaultCheck() {
  if (vault.checked) return;
  vault.row = await q(sb.from("vault").select("*").maybeSingle());
  vault.checked = true;
}
function vaultLock(msg) {
  vault.key = null; vault.data = null; vault.revealed.clear();
  clearTimeout(vault.timer);
  if (location.hash.startsWith("#/coffre")) render();
  if (msg) toast(msg);
}
function vaultTouch() {
  if (!vault.key) return;
  clearTimeout(vault.timer);
  vault.timer = setTimeout(() => vaultLock("Coffre verrouillé après inactivité."), VAULT_AUTOLOCK_MIN * 60000);
}
["pointerdown", "keydown", "scroll"].forEach((ev) => addEventListener(ev, vaultTouch, { passive: true }));

async function vaultSave() {
  const { iv, ciphertext } = await V.encryptJSON(vault.key, vault.data);
  vault.row = await q(sb.from("vault").upsert({
    user_id: state.user.id, salt: vault.row.salt, iterations: vault.row.iterations, iv, ciphertext, updated_at: new Date().toISOString(),
  }).select().single());
}

function viewVault() {
  if (!vault.checked) {
    vaultCheck().then(render).catch(fail);
    return `<p class="muted">Chargement du coffre…</p>`;
  }
  const glyph = `<div class="glyph" aria-hidden="true"><b></b><b></b><b style="opacity:.35"></b></div>`;
  if (!vault.row) {
    return `<form class="lock-panel" data-form="vault-create">${glyph}<h1>Créer ton coffre</h1>
      <p class="muted">Tes identifiants seront chiffrés dans ton navigateur avec un mot de passe maître. Le serveur ne reçoit que du chiffré. Si tu oublies ce mot de passe, personne ne pourra récupérer le contenu, pas même toi.</p>
      <div class="lbl"><span>Mot de passe maître</span><div class="pw-row"><input type="password" name="pw" autocomplete="new-password" required minlength="12"><button type="button" data-pw-toggle>Afficher</button></div><div class="meter"><i></i></div></div>
      <label><span>Confirmation</span><input type="password" name="pw2" autocomplete="new-password" required></label>
      <p class="small muted">12 caractères minimum. Une phrase de passe de 4 ou 5 mots est plus solide et plus facile à retenir.</p>
      <button class="primary" type="submit">Créer le coffre</button></form>`;
  }
  if (!vault.key) {
    return `<form class="lock-panel" data-form="vault-unlock">${glyph}<h1>Coffre verrouillé</h1>
      <div class="lbl"><span>Mot de passe maître</span><div class="pw-row"><input type="password" name="pw" autocomplete="current-password" required autofocus><button type="button" data-pw-toggle>Afficher</button></div></div>
      <button class="primary" type="submit">Déverrouiller</button>
      <p class="small muted">Verrouillage automatique après ${VAULT_AUTOLOCK_MIN} minutes d'inactivité.</p></form>`;
  }
  const entries = vault.data.entries || [];
  const groups = {};
  [...entries].sort((a, b) => a.title.localeCompare(b.title)).forEach((e) => (groups[e.category || "Divers"] ??= []).push(e));
  return `<div class="page-head"><div><h1>Coffre</h1><p class="meta"><span>${entries.length} identifiant${entries.length > 1 ? "s" : ""}</span><span>chiffré AES-256</span></p></div>
      <div class="actions"><button data-action="vault-lock">Verrouiller</button><button class="primary" data-action="vault-new">Ajouter un identifiant</button></div></div>
    ${entries.length ? `<input type="search" placeholder="Rechercher" data-vault-search style="max-width:320px;margin-bottom:1.2rem" aria-label="Rechercher dans le coffre">` : ""}
    ${entries.length ? Object.entries(groups).map(([cat, es]) => `<div class="group" data-vgroup><h3>${esc(cat)}</h3><div class="rows">${es.map((e) => {
      const shown = vault.revealed.has(e.id);
      return `<div class="rowi" data-search="${esc((e.title + " " + (e.username || "") + " " + (e.url || "") + " " + cat).toLowerCase())}">
        <div><div class="t">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title)}</div>
          <div class="sub">${e.username ? esc(e.username) : "<em>sans identifiant</em>"}${e.password ? `, <span class="secret">${shown ? esc(e.password) : "••••••••••"}</span>` : ""}</div>
          ${e.notes && shown ? `<div class="sub" style="white-space:pre-wrap">${esc(e.notes)}</div>` : ""}</div>
        <div class="actions">
          ${e.username ? `<button class="ghost" data-action="vault-copy" data-id="${e.id}" data-f="username">Copier l'identifiant</button>` : ""}
          ${e.password ? `<button class="ghost" data-action="vault-copy" data-id="${e.id}" data-f="password">Copier le mot de passe</button>
          <button class="ghost" data-action="vault-reveal" data-id="${e.id}">${shown ? "Masquer" : "Afficher"}</button>` : ""}
          <button class="ghost" data-action="vault-edit" data-id="${e.id}">Modifier</button></div></div>`;
    }).join("")}</div></div>`).join("")
    : `<div class="empty-state"><p>Le coffre est vide.</p><button class="primary" data-action="vault-new">Ajouter un identifiant</button></div>`}`;
}

function vaultEntryForm(entry) {
  const cats = [...new Set((vault.data.entries || []).map((e) => e.category).filter(Boolean))];
  openForm({
    title: entry ? "Modifier l'identifiant" : "Nouvel identifiant",
    intro: cats.length ? `Catégories existantes : ${cats.map(esc).join(", ")}` : "",
    fields: [
      { name: "title", label: "Nom", value: entry?.title, required: true, placeholder: "Messagerie ESIEE" },
      { name: "category", label: "Catégorie", value: entry?.category, placeholder: "École, Alternance…" },
      { name: "username", label: "Identifiant", value: entry?.username },
      { name: "password", label: "Mot de passe", type: "password", value: entry?.password, generator: true, meter: true },
      { name: "url", label: "Adresse", type: "url", value: entry?.url, placeholder: "https://" },
      { name: "notes", label: "Notes (chiffrées aussi)", type: "textarea", value: entry?.notes },
    ],
    submitLabel: entry ? "Enregistrer" : "Ajouter au coffre",
    onSubmit: async (d) => {
      if (d.url && !/^https?:\/\//i.test(d.url)) d.url = "https://" + d.url;
      const list = vault.data.entries || (vault.data.entries = []);
      if (entry) Object.assign(entry, d, { updatedAt: new Date().toISOString() });
      else list.push({ id: crypto.randomUUID(), ...d, updatedAt: new Date().toISOString() });
      await vaultSave();
      toast("Coffre enregistré.");
    },
    del: entry && {
      confirm: `Supprimer « ${entry.title} » du coffre ?`,
      run: async () => { vault.data.entries = vault.data.entries.filter((e) => e.id !== entry.id); await vaultSave(); },
    },
  });
}

/* ---------- Réglages ---------- */
function viewSettings() {
  const sems = [...state.semesters].sort(byPos);
  return `<div class="page-head"><div><h1>Réglages</h1><p class="meta"><span>Connectée en tant que ${esc(state.user.email)}</span></p></div>
      <div class="actions"><button data-action="logout">Se déconnecter</button></div></div>

    <section><div class="sec-head"><h2>Semestres</h2><button class="primary" data-action="new-semester">Ajouter un semestre</button></div>
      ${sems.length ? `<div class="rows">${sems.map((s) => `<div class="rowi"><div><div class="t">${esc(s.name)}</div>
        <div class="sub">${subjectsIn(s.id).length} matière(s)${s.start_date ? `, du ${fmtDay(s.start_date)}` : ""}${s.end_date ? ` au ${fmtDay(s.end_date)}` : ""}</div></div>
        <div class="actions"><button class="ghost" data-action="new-subject" data-sem="${s.id}">Ajouter une matière</button><button class="ghost" data-action="edit-semester" data-id="${s.id}">Modifier</button></div></div>`).join("")}</div>`
      : `<p class="muted">Aucun semestre.</p>`}</section>

    <section><div class="sec-head"><h2>Importer un syllabus</h2></div>
      <p class="muted" style="max-width:70ch;margin-bottom:0.8rem">Colle un JSON au format du fichier <a href="data/exemple-import.json" target="_blank">exemple-import.json</a>. Un semestre qui existe déjà (même nom) reçoit les nouvelles matières sans être dupliqué.</p>
      <textarea data-import-text rows="8" placeholder='{"semesters":[{"name":"S5","subjects":[…]}]}' style="font-family:ui-monospace,monospace;font-size:0.82rem"></textarea>
      <div class="actions" style="margin-top:0.6rem"><button class="primary" data-action="import">Importer</button>
        <label class="btn" style="display:inline-flex;color:var(--ink)">Charger un fichier .json<input type="file" accept=".json,application/json" hidden data-import-file></label></div></section>

    <section><div class="sec-head"><h2>Sauvegarde</h2></div>
      <p class="muted" style="max-width:70ch;margin-bottom:0.8rem">Exporte toute ta structure, ta progression, tes examens et tes accès en JSON. Le fichier se réimporte ici. Les fichiers uploadés et le coffre n'y sont pas inclus.</p>
      <button data-action="export">Télécharger la sauvegarde</button></section>

    <section><div class="sec-head"><h2>Planning</h2></div>
      <p class="muted" style="max-width:70ch;margin-bottom:0.8rem">Lien iCal de ton emploi du temps (ADE : Exporter l'agenda, puis Générer URL). Il est gardé dans ta base, jamais dans le code public du site.</p>
      <div class="pw-row" style="max-width:720px"><input type="url" data-ics-url placeholder="https://…/anonymous_cal.jsp?…" value="${esc(state.settings?.[0]?.ics_url || "")}" aria-label="Lien iCal du planning">
      <button class="primary" data-action="save-ics">Enregistrer le lien</button></div></section>

    <section><div class="sec-head"><h2>Double authentification</h2></div>
      ${state.mfaFactor
        ? `<p style="max-width:70ch;margin-bottom:0.8rem"><strong>Activée.</strong> <span class="muted">Chaque connexion demande ton mot de passe puis un code à 6 chiffres. Sans ce code, la base refuse toute lecture, coffre compris.</span></p>
           <button class="danger" data-action="mfa-disable">Désactiver la double authentification</button>`
        : `<p class="muted" style="max-width:70ch;margin-bottom:0.8rem">Ajoute un code à 6 chiffres (Google Authenticator, Authy, 1Password, l'app Mots de passe d'Apple…) en plus du mot de passe. Une fois activée, la base refuse toute lecture sans ce code.</p>
           <button class="primary" data-action="mfa-enable">Activer la double authentification</button>`}</section>

    <section><div class="sec-head"><h2>Coffre</h2></div>
      ${vault.key ? `<button data-action="vault-change-pw">Changer le mot de passe maître</button>`
        : `<p class="muted">Déverrouille le <a href="#/coffre">coffre</a> pour changer son mot de passe maître.</p>`}</section>`;
}

function notFound() {
  return `<div class="empty-state"><p>Cette page n'existe plus. Elle a peut-être été supprimée.</p><a class="btn" href="#/">Retour au tableau de bord</a></div>`;
}

/* =========================================================
   Import / export
   ========================================================= */
async function importData(json) {
  if (!json || !Array.isArray(json.semesters) && !Array.isArray(json.exams) && !Array.isArray(json.links)) {
    throw new Error("Format non reconnu : il faut au moins une clé semesters, exams ou links.");
  }
  const n = { sem: 0, sub: 0, unit: 0, exam: 0, link: 0 };
  const codeMap = Object.fromEntries(state.subjects.filter((s) => s.code).map((s) => [s.code, s.id]));
  for (const s of json.semesters || []) {
    let sem = state.semesters.find((x) => x.name === s.name);
    if (!sem) {
      sem = await insert("semesters", { name: s.name, position: s.position ?? state.semesters.length, start_date: s.start_date || null, end_date: s.end_date || null });
      put("semesters", sem); n.sem++;
    }
    for (const m of s.subjects || []) {
      const sub = await insert("subjects", {
        semester_id: sem.id, name: m.name, code: m.code || null, ue: m.ue || null, ects: m.ects ?? null, coef: m.coef ?? null,
        teacher: m.teacher || null, description: m.description || null, position: subjectsIn(sem.id).length,
      });
      put("subjects", sub); n.sub++;
      if (m.code) codeMap[m.code] = sub.id;
      const units = (m.units || []).map((u, k) => {
        const o = typeof u === "string" ? { title: u } : u;
        return { subject_id: sub.id, title: o.title, kind: o.kind || "Chapitre", position: k, date: o.date || null,
          status: STATUS[o.status] ? o.status : "todo", confidence: o.confidence ?? null, notes: o.notes || null };
      });
      if (units.length) { (await q(sb.from("units").insert(units).select())).forEach((u) => put("units", u)); n.unit += units.length; }
    }
  }
  const exams = (json.exams || []).map((e) => ({
    title: e.title, kind: e.kind || null, starts_at: new Date(e.starts_at).toISOString(), location: e.location || null,
    coef: e.coef ?? null, grade: e.grade ?? null, notes: e.notes || null, subject_id: e.subject_code ? codeMap[e.subject_code] || null : null,
  }));
  if (exams.length) { (await q(sb.from("exams").insert(exams).select())).forEach((e) => put("exams", e)); n.exam = exams.length; }
  const links = (json.links || []).map((l, i) => ({ title: l.title, url: l.url, category: l.category || null, notes: l.notes || null, position: state.links.length + i }));
  if (links.length) { (await q(sb.from("links").insert(links).select())).forEach((l) => put("links", l)); n.link = links.length; }
  return n;
}

function exportData() {
  const codeOf = (id) => subjectOf(id)?.code || subjectOf(id)?.name || null;
  const out = {
    exported_at: new Date().toISOString(),
    semesters: [...state.semesters].sort(byPos).map((s) => ({
      name: s.name, position: s.position, start_date: s.start_date, end_date: s.end_date,
      subjects: subjectsIn(s.id).map((m) => ({
        code: m.code || m.name, name: m.name, ue: m.ue, ects: m.ects, coef: m.coef, teacher: m.teacher, description: m.description,
        units: unitsOf(m.id).map((u) => ({ title: u.title, kind: u.kind, date: u.date, status: u.status, confidence: u.confidence, notes: u.notes })),
      })),
    })),
    exams: state.exams.map((e) => ({ title: e.title, kind: e.kind, starts_at: e.starts_at, location: e.location, coef: e.coef, grade: e.grade, notes: e.notes, subject_code: codeOf(e.subject_id) })),
    links: [...state.links].sort(byPos).map((l) => ({ title: l.title, url: l.url, category: l.category, notes: l.notes })),
  };
  download(`carnet-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out, null, 2), "application/json");
}

function exportICS() {
  const f = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const escI = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Carnet ESIEE//FR", "CALSCALE:GREGORIAN"];
  for (const e of state.exams) {
    const sub = subjectOf(e.subject_id);
    lines.push("BEGIN:VEVENT", `UID:${e.id}@carnet`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(e.starts_at)}`,
      `DTEND:${f(new Date(new Date(e.starts_at).getTime() + 2 * 3600000))}`,
      `SUMMARY:${escI(`${e.kind ? e.kind + " : " : ""}${e.title}`)}`,
      ...(e.location ? [`LOCATION:${escI(e.location)}`] : []),
      `DESCRIPTION:${escI([sub?.name, e.notes].filter(Boolean).join("\n"))}`,
      "BEGIN:VALARM", "TRIGGER:-P2D", "ACTION:DISPLAY", "DESCRIPTION:Examen dans 2 jours", "END:VALARM", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  download("examens.ics", lines.join("\r\n"), "text/calendar");
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* =========================================================
   Actions (délégation)
   ========================================================= */
const actions = {
  "new-semester": () => semesterForm(),
  "edit-semester": (el) => semesterForm(semesterOf(el.dataset.id)),
  "new-subject": (el) => subjectForm(null, el.dataset.sem),
  "edit-subject": (el) => subjectForm(subjectOf(el.dataset.id)),
  "new-unit": (el) => unitForm(null, el.dataset.id),
  "edit-unit": (el) => unitForm(state.units.find((u) => u.id === el.dataset.id)),
  "new-exam": (el) => examForm(null, el.dataset.id),
  "edit-exam": (el) => examForm(state.exams.find((e) => e.id === el.dataset.id)),
  "new-link": () => linkForm(),
  "edit-link": (el) => linkForm(state.links.find((l) => l.id === el.dataset.id)),
  "new-link-res": (el) => resourceForm(null, el.dataset.id),
  "edit-res": (el) => resourceForm(state.resources.find((r) => r.id === el.dataset.id)),

  async "open-res"(el, ev) {
    ev.preventDefault();
    const r = state.resources.find((x) => x.id === el.dataset.id);
    const w = window.open("", "_blank");
    const { data, error } = await sb.storage.from("resources").createSignedUrl(r.storage_path, 600);
    if (error) { w?.close(); throw error; }
    if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
  },
  async cycle(el) { await setUnit(el.dataset.id, { status: CYCLE[state.units.find((u) => u.id === el.dataset.id).status] }); },
  async "set-status"(el) { await setUnit(el.dataset.id, { status: el.dataset.s }); },
  async "set-conf"(el) {
    const u = state.units.find((x) => x.id === el.dataset.id); const n = Number(el.dataset.n);
    await setUnit(u.id, { confidence: u.confidence === n ? n - 1 : n });
  },
  async "move-unit"(el) {
    const u = state.units.find((x) => x.id === el.dataset.id);
    const list = unitsOf(u.subject_id); const i = list.indexOf(u); const j = i + Number(el.dataset.dir);
    if (j < 0 || j >= list.length) return;
    list.splice(i, 1); list.splice(j, 0, u);
    const changed = list.map((x, k) => ({ x, k })).filter(({ x, k }) => x.position !== k);
    changed.forEach(({ x, k }) => (x.position = k)); render();
    await Promise.all(changed.map(({ x, k }) => update("units", x.id, { position: k })));
  },
  ics: exportICS,
  async "mfa-enable"() {
    // nettoie les essais d'enrôlement inachevés
    const { data: list } = await sb.auth.mfa.listFactors();
    for (const f of (list?.all || []).filter((x) => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Carnet ${new Date().toISOString().slice(0, 16)}` });
    if (error) throw error;
    const factorId = data.id;
    $modal.innerHTML = `<form novalidate>
      <h2>Activer la double authentification</h2>
      <p class="small muted">1. Scanne ce QR code avec ton application d'authentification.</p>
      <img src="${esc(data.totp.qr_code)}" alt="QR code à scanner" width="200" height="200" style="background:#fff;border:var(--bw) solid var(--line);border-radius:var(--r-sm);justify-self:start;padding:6px">
      <p class="small muted">Pas de caméra ? Saisis cette clé à la main : <code style="word-break:break-all">${esc(data.totp.secret)}</code></p>
      <label><span>2. Code à 6 chiffres affiché par l'application</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <footer><button type="button" data-cancel>Annuler</button><button type="submit" class="primary">Activer</button></footer></form>`;
    const form = $modal.querySelector("form");
    form.querySelector("[data-cancel]").onclick = async () => { $modal.close(); await sb.auth.mfa.unenroll({ factorId }).catch(() => {}); };
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const code = form.elements.code.value.trim();
      const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
      if (e2) { toast("Code incorrect. Vérifie l'heure de ton téléphone et réessaie.", true); return; }
      $modal.close(); state.mfaFactor = await verifiedFactor();
      toast("Double authentification activée."); render();
    };
    $modal.showModal(); form.elements.code.focus();
  },
  async "mfa-disable"() {
    if (!confirm("Désactiver la double authentification ? Ton mot de passe suffira de nouveau pour accéder au site.")) return;
    const { error } = await sb.auth.mfa.unenroll({ factorId: state.mfaFactor.id });
    if (error) throw error;
    state.mfaFactor = null; toast("Double authentification désactivée."); render();
  },
  shift(el) {
    const d = Number(el.dataset.d); const k = planning.view === "month" ? "month" : "week";
    planning[k] = d === 0 ? 0 : planning[k] + d; render();
  },
  "planning-view"(el) { planning.view = el.dataset.v; render(); },
  "goto-week"(el) {
    const d = new Date(el.dataset.date); const mon = new Date(d); mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    planning.week = Math.round((mon - weekStart(0)) / (7 * 86400000)); planning.view = "week"; render();
  },
  course(el) { const e = planning.events[Number(el.dataset.i)]; if (e) showPop(el, e); },
  "planning-refresh": () => loadPlanning(true),
  async "save-ics"() {
    const v = document.querySelector("[data-ics-url]").value.trim();
    if (v && !/^https:\/\//i.test(v)) { toast("Le lien doit commencer par https://", true); return; }
    const row = await q(sb.from("settings").upsert({ user_id: state.user.id, ics_url: v || null, updated_at: new Date().toISOString() }).select().single());
    state.settings = [row];
    Object.assign(planning, { events: [], loadedAt: 0, error: null });
    toast(v ? "Lien du planning enregistré." : "Lien du planning retiré.");
    render();
  },
  export: exportData,
  async import() {
    const txt = document.querySelector("[data-import-text]").value.trim();
    if (!txt) { toast("Colle d'abord le JSON à importer.", true); return; }
    let json; try { json = JSON.parse(txt); } catch { toast("Ce JSON est invalide. Vérifie les virgules et guillemets.", true); return; }
    toast("Import en cours…");
    const n = await importData(json);
    toast(`Importé : ${n.sem} semestre(s), ${n.sub} matière(s), ${n.unit} séance(s), ${n.exam} examen(s), ${n.link} accès.`);
    location.hash = "#/";
    render();
  },
  async logout() { vaultLock(); await sb.auth.signOut(); },

  "vault-lock": () => vaultLock(),
  "vault-new": () => vaultEntryForm(),
  "vault-edit": (el) => vaultEntryForm(vault.data.entries.find((e) => e.id === el.dataset.id)),
  "vault-reveal"(el) { const id = el.dataset.id; vault.revealed.has(id) ? vault.revealed.delete(id) : vault.revealed.add(id); render(); },
  async "vault-copy"(el) {
    const e = vault.data.entries.find((x) => x.id === el.dataset.id); const v = e[el.dataset.f];
    await navigator.clipboard.writeText(v);
    if (el.dataset.f === "password") {
      toast(`Mot de passe copié. Presse-papiers vidé dans ${CLIPBOARD_CLEAR_SEC} s.`);
      setTimeout(async () => {
        try { if ((await navigator.clipboard.readText()) !== v) return; } catch { /* lecture refusée : on vide quand même */ }
        navigator.clipboard.writeText("").catch(() => {});
      }, CLIPBOARD_CLEAR_SEC * 1000);
    } else toast("Identifiant copié.");
  },
  "vault-change-pw"() {
    openForm({
      title: "Changer le mot de passe maître",
      intro: "Le coffre sera rechiffré avec une nouvelle clé. Garde l'ancien mot de passe en tête jusqu'à la fin de l'opération.",
      fields: [
        { name: "current", label: "Mot de passe actuel", type: "password", autocomplete: "current-password", required: true },
        { name: "pw", label: "Nouveau mot de passe", type: "password", meter: true, required: true },
        { name: "pw2", label: "Confirmation", type: "password", required: true },
      ],
      submitLabel: "Rechiffrer le coffre",
      onSubmit: async (d) => {
        try { const k = await V.deriveKey(d.current, V.fromB64(vault.row.salt), vault.row.iterations); await V.decryptJSON(k, vault.row.iv, vault.row.ciphertext); }
        catch { throw new Error("Mot de passe actuel incorrect."); }
        if (d.pw.length < 12) throw new Error("12 caractères minimum.");
        if (d.pw !== d.pw2) throw new Error("La confirmation ne correspond pas.");
        const salt = V.newSalt();
        vault.key = await V.deriveKey(d.pw, salt, V.DEFAULT_ITERATIONS);
        vault.row = { ...vault.row, salt: V.toB64(salt), iterations: V.DEFAULT_ITERATIONS };
        await vaultSave();
        toast("Mot de passe maître changé.");
      },
    });
  },
};

async function setUnit(id, patch) {
  const u = state.units.find((x) => x.id === id);
  const before = { ...u };
  Object.assign(u, patch); render();
  try { put("units", await update("units", id, patch)); }
  catch (e) { Object.assign(u, before); render(); throw e; }
}

$app.addEventListener("click", async (ev) => {
  if (ev.target.closest("[data-menu]")) { document.querySelector(".shell")?.classList.toggle("open"); return; }
  if (ev.target.closest(".side a")) document.querySelector(".shell")?.classList.remove("open");
  const tog = ev.target.closest("[data-pw-toggle]");
  if (tog) { const i = tog.parentElement.querySelector("input"); const s = i.type === "password"; i.type = s ? "text" : "password"; tog.textContent = s ? "Masquer" : "Afficher"; return; }
  const el = ev.target.closest("[data-action]");
  if (!el || !actions[el.dataset.action]) return;
  try { await actions[el.dataset.action](el, ev); } catch (e) { fail(e); }
});

$app.addEventListener("submit", async (ev) => {
  const form = ev.target.closest("[data-form]"); if (!form) return;
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  const btn = form.querySelector("[type=submit]"); btn.disabled = true;
  try {
    if (form.dataset.form === "login") {
      const { error } = await sb.auth.signInWithPassword({ email: fd.email, password: fd.password });
      if (error) throw new Error(error.message === "Invalid login credentials" ? "Email ou mot de passe incorrect." : error.message);
    }
    if (form.dataset.form === "mfa") {
      const f = await verifiedFactor();
      if (!f) throw new Error("Aucun facteur de double authentification trouvé.");
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: String(fd.code).trim() });
      if (error) throw new Error("Code incorrect ou expiré.");
      await enterApp();
    }
    if (form.dataset.form === "signup") {
      const { data, error } = await sb.auth.signUp({ email: fd.email, password: fd.password });
      if (error) throw error;
      if (!data.session) toast("Compte créé. Confirme ton adresse via l'email reçu, puis connecte-toi.");
    }
    if (form.dataset.form === "vault-create") {
      if (fd.pw.length < 12) throw new Error("12 caractères minimum.");
      if (fd.pw !== fd.pw2) throw new Error("La confirmation ne correspond pas.");
      const salt = V.newSalt();
      vault.key = await V.deriveKey(fd.pw, salt, V.DEFAULT_ITERATIONS);
      vault.data = { version: 1, entries: [] };
      vault.row = { salt: V.toB64(salt), iterations: V.DEFAULT_ITERATIONS };
      await vaultSave(); vaultTouch(); render(); toast("Coffre créé.");
    }
    if (form.dataset.form === "vault-unlock") {
      const key = await V.deriveKey(fd.pw, V.fromB64(vault.row.salt), vault.row.iterations);
      try { vault.data = await V.decryptJSON(key, vault.row.iv, vault.row.ciphertext); }
      catch { throw new Error("Mot de passe maître incorrect."); }
      vault.key = key; vaultTouch(); render();
    }
  } catch (e) { fail(e); }
  finally { btn.disabled = false; }
});

$app.addEventListener("input", (ev) => {
  if (ev.target.matches(".lbl input")) meterUpdate(ev.target);
  if (ev.target.matches("[data-vault-search]")) {
    const qv = ev.target.value.toLowerCase().trim();
    document.querySelectorAll("[data-search]").forEach((r) => (r.hidden = qv && !r.dataset.search.includes(qv)));
    document.querySelectorAll("[data-vgroup]").forEach((g) => (g.hidden = ![...g.querySelectorAll("[data-search]")].some((r) => !r.hidden)));
  }
});

$app.addEventListener("change", async (ev) => {
  try {
    if (ev.target.matches("[data-upload]")) await uploadFiles(ev.target.files, ev.target.dataset.upload);
    if (ev.target.matches("[data-import-file]")) {
      document.querySelector("[data-import-text]").value = await ev.target.files[0].text();
      toast("Fichier chargé. Vérifie puis clique sur Importer.");
    }
  } catch (e) { fail(e); }
});

["dragover", "dragleave", "drop"].forEach((type) => $app.addEventListener(type, (ev) => {
  const z = ev.target.closest("[data-drop]"); if (!z) return;
  ev.preventDefault();
  z.classList.toggle("over", type === "dragover");
  if (type === "drop") uploadFiles(ev.dataTransfer.files, z.dataset.drop).catch(fail);
}));

/* =========================================================
   Rendu
   ========================================================= */
function screenSetup() {
  return `<div class="center"><div class="card"><h1>Configuration requise</h1>
    <p>Le site n'est pas encore relié à ta base Supabase. Renseigne l'URL du projet et la clé anon dans <code>js/config.js</code>, puis recharge la page.</p>
    <pre>export const SUPABASE_URL = "https://xxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi…";</pre>
    <p class="small muted">Le guide complet est dans le README du dépôt.</p></div></div>`;
}

let authMode = "login";
function screenLogin() {
  const signup = authMode === "signup";
  return `<div class="center"><form class="card" data-form="${signup ? "signup" : "login"}">
    <div class="brand" style="margin:0"><i><b style="background:var(--accent)"></b><b style="background:var(--hot)"></b><b style="background:var(--accent-2)"></b></i>Carnet ESIEE</div>
    <h1>${signup ? "Créer ton compte" : "Connexion"}</h1>
    <label><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
    <div class="lbl"><span>Mot de passe</span><div class="pw-row"><input type="password" name="password" autocomplete="${signup ? "new-password" : "current-password"}" required minlength="8"><button type="button" data-pw-toggle>Afficher</button></div></div>
    <button class="primary" type="submit">${signup ? "Créer le compte" : "Se connecter"}</button>
  </form></div>`;
}
function screenMfa() {
  return `<div class="center"><form class="card" data-form="mfa" autocomplete="off">
    <div class="brand" style="margin:0"><i><b style="background:var(--accent)"></b><b style="background:var(--hot)"></b><b style="background:var(--accent-2)"></b></i>Carnet ESIEE</div>
    <h1>Code de vérification</h1>
    <p class="muted">Saisis le code à 6 chiffres affiché dans ton application d'authentification.</p>
    <label><span>Code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
    <button class="primary" type="submit">Valider</button>
    <button type="button" class="ghost" data-action="logout">Se déconnecter</button>
  </form></div>`;
}
async function mfaRequired() {
  const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return false;
  return data.nextLevel === "aal2" && data.currentLevel !== "aal2";
}
async function verifiedFactor() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  return (data.totp || []).find((f) => f.status === "verified") || null;
}
async function enterApp() {
  state.needMfa = await mfaRequired();
  if (state.needMfa) { render(); return; }
  state.loaded = false; render();
  try { await loadAll(); state.mfaFactor = await verifiedFactor(); } catch (e) { fail(e); }
  render();
}
const themeLabel = () => (document.documentElement.dataset.theme === "dark" ? "☀ Mode clair" : "☾ Mode sombre");
actions["toggle-theme"] = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch { /* stockage indisponible : le choix vaut pour cette visite */ }
  render();
};
actions["toggle-auth"] = () => { authMode = authMode === "login" ? "signup" : "login"; render(); };

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [a, b] = h.split("/");
  return { a: a || "", b };
}

actions["revise-diff"] = (el) => { reviseDiff = el.dataset.d; render(); };
actions.study = (el) => startStudy(el.dataset.id, el.dataset.mode);
actions["study-regen"] = (el) => {
  if (!confirm("Régénérer le jeu de questions ? Le score repart de zéro pour ce niveau (l'historique est conservé).")) return;
  startStudy(el.dataset.id, "quiz", true);
};
actions.answer = (el) => {
  if (study.picked != null) return;
  study.picked = Number(el.dataset.k);
  const it = study.items[study.idx];
  if (study.picked === it.correct) study.score++; else study.misses.push({ ...it, answer: it.choices[it.correct] });
  render();
};
actions["next-q"] = () => { if (study.idx >= study.items.length - 1) return finishStudy(); study.idx++; study.picked = null; render(); };
actions.flip = () => { study.flipped = true; render(); };
actions.flash = (el) => {
  const it = study.items[study.idx];
  if (el.dataset.ok === "1") study.score++; else study.misses.push(it);
  if (study.idx >= study.items.length - 1) return finishStudy();
  study.idx++; study.flipped = false; render();
};
addEventListener("keydown", (ev) => {
  if (!study || study.done || study.loading || !location.hash.startsWith("#/reviser/") || ev.target.closest("input, textarea")) return;
  if (study.mode === "flashcards") {
    if (ev.key === " " && !study.flipped) { ev.preventDefault(); actions.flip(); }
    else if (study.flipped && (ev.key === "1" || ev.key === "2")) actions.flash({ dataset: { ok: ev.key === "1" ? "1" : "0" } });
  } else if (study.picked == null && "1234abcdABCD".includes(ev.key) && ev.key.length === 1) {
    const k = "1234".includes(ev.key) ? Number(ev.key) - 1 : "abcd".indexOf(ev.key.toLowerCase());
    actions.answer({ dataset: { k } });
  } else if (study.picked != null && ev.key === "Enter") actions["next-q"]();
});

// Semestres dépliés dans le menu, mémorisés d'une visite à l'autre
const openSems = new Set((() => { try { return JSON.parse(localStorage.getItem("openSems") || "[]"); } catch { return []; } })());
actions["toggle-sem"] = (el) => {
  const id = el.dataset.id;
  const wasOpen = el.getAttribute("aria-expanded") === "true";
  if (wasOpen) openSems.delete(id); else openSems.add(id);
  // replier le semestre de la page en cours : revenir au tableau de bord
  if (wasOpen && !openSems.has(id) && location.hash.match(new RegExp(`#/(s/${id}|m/(${subjectsIn(id).map((m) => m.id).join("|") || "-"}))`))) location.hash = "#/";
  try { localStorage.setItem("openSems", JSON.stringify([...openSems])); } catch { /* sans stockage : vaut pour cette visite */ }
  render();
};
function sidebar(r) {
  const sems = [...state.semesters].sort(byPos);
  const on = (cond) => (cond ? ` class="on" aria-current="page"` : "");
  return `<aside class="side">
    <a class="brand" href="#/"><i><b style="background:var(--accent)"></b><b style="background:var(--hot)"></b><b style="background:var(--accent-2)"></b></i>Carnet ESIEE</a>
    <nav class="nav">
      <a href="#/"${on(r.a === "")}>Tableau de bord</a>
      <a href="#/planning"${on(r.a === "planning")}>Planning</a>
      <a href="#/examens"${on(r.a === "examens")}>Examens</a>
      <a href="#/acces"${on(r.a === "acces")}>Accès</a>
      <a href="#/coffre"${on(r.a === "coffre")}>Coffre</a>
      <a href="#/reglages"${on(r.a === "reglages")}>Réglages</a>
    </nav>
    <nav class="tree" aria-label="Matières">
      ${sems.map((s) => {
        const subs = subjectsIn(s.id);
        // dépliée si choisie, ou si la page affichée appartient à ce semestre
        const here = (r.a === "s" && r.b === s.id) || (r.a === "m" && subjectOf(r.b)?.semester_id === s.id);
        const open = openSems.has(s.id) || here;
        const p = progress(subs.flatMap((m) => unitsOf(m.id)));
        return `<button class="sem-toggle${open ? " open" : ""}" data-action="toggle-sem" data-id="${s.id}" aria-expanded="${open}">
            <span>${esc(s.name)}</span><span class="pct">${p == null ? "" : p + " %"}</span></button>
          ${open ? `<div class="sem-list">
            <a href="#/s/${s.id}"${on(r.a === "s" && r.b === s.id)}><span>Vue du semestre</span></a>
            ${subs.map((m) => { const pm = progress(unitsOf(m.id));
              return `<a href="#/m/${m.id}"${on(r.a === "m" && r.b === m.id)}><span>${esc(m.name)}</span><span class="pct">${pm == null ? "" : pm + " %"}</span></a>`; }).join("")}
          </div>` : ""}`;
      }).join("")}
    </nav>
    <button class="theme-toggle" data-action="toggle-theme">${themeLabel()}</button></aside>`;
}

function render() {
  closePop();
  if (!configured) { $app.innerHTML = screenSetup(); return; }
  if (!state.user) { $app.innerHTML = screenLogin(); return; }
  if (state.needMfa) { $app.innerHTML = screenMfa(); $app.querySelector("[name=code]")?.focus(); return; }
  if (!state.loaded) { $app.innerHTML = `<div class="center"><p class="muted">Chargement…</p></div>`; return; }
  const r = route();
  const views = { "": viewDashboard, s: () => viewSemester(r.b), m: () => viewSubject(r.b), examens: viewExams, planning: viewPlanning, reviser: viewStudy, acces: viewLinks, coffre: viewVault, reglages: viewSettings };
  const scroll = scrollY;
  const keepScroll = $app.dataset.route === location.hash;
  const sideScroll = $app.querySelector(".side")?.scrollTop ?? 0; // le menu garde sa position d'une page à l'autre
  $app.innerHTML = `<div class="shell">${sidebar(r)}<div>
    <div class="topbar"><a class="brand" href="#/" style="margin:0"><i><b style="background:var(--accent)"></b><b style="background:var(--hot)"></b><b style="background:var(--accent-2)"></b></i>Carnet</a><button data-menu aria-label="Menu">Menu</button></div>
    <main>${(views[r.a] || notFound)()}</main></div></div>`;
  $app.dataset.route = location.hash;
  if (keepScroll) scrollTo(0, scroll); else scrollTo(0, 0);
  const side = $app.querySelector(".side");
  if (side) side.scrollTop = sideScroll;
  document.title = `Carnet ESIEE`;
}

addEventListener("hashchange", render);

async function boot() {
  if (!configured) return render();
  const { data } = await sb.auth.getSession();
  state.user = data.session?.user || null;
  render();
  if (state.user) await enterApp();
  sb.auth.onAuthStateChange(async (event, session) => {
    const prev = state.user?.id;
    state.user = session?.user || null;
    if (!state.user) {
      Object.assign(state, { loaded: false, needMfa: false, mfaFactor: null, semesters: [], subjects: [], units: [], resources: [], exams: [], links: [], settings: [] });
      vault.checked = false; vault.row = null; vaultLock();
      Object.assign(planning, { events: [], loadedAt: 0, error: null, week: 0, month: 0, view: "week" });
      render(); return;
    }
    if (prev !== state.user.id) await enterApp();
  });
}
boot();
