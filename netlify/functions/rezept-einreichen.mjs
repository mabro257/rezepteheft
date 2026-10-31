/* =========================================================================
   Neues Rezept einreichen

   Nimmt ein in der App eingetipptes Rezept an und legt es als Pull Request im
   Repository an – als Datei unter entwuerfe/, nicht unter recipes/. build.py
   liest nur recipes/, ein Entwurf erscheint also nie ungeprüft in der Sammlung,
   selbst wenn der Pull Request versehentlich gemergt würde.
   Überarbeitet und freigegeben wird im Chat: Format, Mengen, Tags, Nährwerte
   und ein neuer Bildprompt für Gemini.

   Umgebungsvariablen (nur im Netlify-Dashboard, nie im Repository):
     GITHUB_TOKEN   Fine-grained Token, nur dieses Repo, Contents + Pull
                    requests mit Lese- und Schreibrecht
     REZEPT_CODE    Zugangscode, den Einreichende kennen müssen
     GITHUB_REPO    optional, Standard mabro257/rezepteheft
   ========================================================================= */
import { createHash, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/rezept-einreichen" };

const REPO = process.env.GITHUB_REPO || "mabro257/rezepteheft";
const CATEGORIES = ["Hauptspeise", "Vorspeise", "Backen", "Snack", "Dessert", "Zutat"];
const MAX_BODY = 40_000;

/* Dieselbe Rezept-ID wie in build.py (slugify), damit die App einen
   Entwurf wiedererkennt, sobald das fertige Rezept in der Sammlung steht. */
function slugify(text) {
  let t = String(text).toLowerCase();
  for (const [a, b] of [["ä", "ae"], ["ö", "oe"], ["ü", "ue"], ["ß", "ss"],
                        ["ı", "i"], ["ş", "s"], ["ç", "c"], ["ğ", "g"]]) t = t.split(a).join(b);
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Steuerzeichen raus, Zeilen kürzen – der Text landet unverändert in Markdown.
const clean = (s, max) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, max);
const lines = (s, maxLines, maxLen) => String(s ?? "").split(/\r?\n/)
  .map(l => clean(l, maxLen).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))
  .filter(Boolean).slice(0, maxLines);

function sameCode(given, expected) {
  const a = createHash("sha256").update(String(given ?? "")).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "rezepteheft-einreichen",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${init.method || "GET"} ${path}: ${res.status} ${data.message || ""}`);
  return data;
}

function draftMarkdown(r, today) {
  const out = [
    `# ${r.title}`,
    "",
    `Status: Entwurf, eingereicht über die App am ${today}${r.from ? ` von ${r.from}` : ""}`,
    `Kategorie: ${r.category}`,
    r.servings ? `Portionen: ${r.servings}` : null,
    r.time ? `Zubereitungszeit: ${r.time}` : null,
    r.source ? `Quelle: ${r.source}` : null,
    "",
    "> Offen vor der Freigabe:",
    "> - [ ] Im Chat ins Rezeptformat überarbeiten (Zutatentabelle, Mengen in den Schritten, Gesundheitswert, Tags, Nährwerte)",
    "> - [ ] Neuen Bildprompt für Gemini erstellen (Stil: UEBERGABE.md, Abschnitt Neue Rezepte aus der App)",
    `> - [ ] Bild ablegen als public/bilder/${r.id}.jpg`,
    "> - [ ] Datei nach recipes/ verschieben, Entwurf löschen, build.py laufen lassen",
    "",
    "## 🛒 Zutaten (wie eingereicht)",
    "",
    ...r.ingredients.map(l => `- ${l}`),
    "",
    "## 👨‍🍳 Zubereitung (wie eingereicht)",
    "",
    ...r.steps.map((l, i) => `${i + 1}. ${l}`),
  ];
  if (r.tips.length) out.push("", "## 💡 Tipps (wie eingereicht)", "", ...r.tips.map(l => `- ${l}`));
  if (r.note) out.push("", "## Anmerkung der einreichenden Person", "", r.note);
  return out.filter(l => l !== null).join("\n") + "\n";
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method" });

  const token = process.env.GITHUB_TOKEN;
  const code = process.env.REZEPT_CODE;
  if (!token || !code) return json(503, { ok: false, error: "setup" });

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "too-large" });
  let input;
  try { input = JSON.parse(raw); } catch { return json(400, { ok: false, error: "json" }); }

  // Spam-Falle wie beim Feedback-Formular: unsichtbares Feld, Bots füllen es.
  if (input.website) return json(200, { ok: true });
  if (!sameCode(input.code, code)) return json(403, { ok: false, error: "code" });

  const title = clean(input.title, 120);
  const r = {
    title,
    id: slugify(title),
    category: CATEGORIES.includes(input.category) ? input.category : "Hauptspeise",
    servings: Math.min(24, Math.max(0, parseInt(input.servings, 10) || 0)),
    time: Math.min(1440, Math.max(0, parseInt(input.time, 10) || 0)),
    source: clean(input.source, 300),
    from: clean(input.from, 60),
    note: clean(input.note, 1000),
    ingredients: lines(input.ingredients, 80, 200),
    steps: lines(input.steps, 40, 1200),
    tips: lines(input.tips, 20, 600),
  };
  if (title.length < 3 || !r.id) return json(422, { ok: false, error: "title" });
  if (!r.ingredients.length) return json(422, { ok: false, error: "ingredients" });
  if (!r.steps.length) return json(422, { ok: false, error: "steps" });

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const branch = `entwurf/${r.id.slice(0, 60)}-${stamp}`;
  const path = `entwuerfe/${r.id}.md`;

  try {
    const main = await gh("/git/ref/heads/main", token);
    await gh("/git/refs", token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: main.object.sha }),
    });
    await gh(`/contents/${encodeURI(path)}`, token, {
      method: "PUT",
      body: JSON.stringify({
        message: `Entwurf: ${r.title}`,
        content: Buffer.from(draftMarkdown(r, today), "utf8").toString("base64"),
        branch,
      }),
    });
    const pr = await gh("/pulls", token, {
      method: "POST",
      body: JSON.stringify({
        title: `Neues Rezept: ${r.title}`,
        head: branch,
        base: "main",
        body: [
          `Eingereicht über die App am ${today}${r.from ? ` von ${r.from}` : ""}.`,
          "",
          "Wird im Chat überarbeitet, nicht per API. Vor dem Merge:",
          "- [ ] Ins Rezeptformat überarbeiten und nach `recipes/` verschieben",
          "- [ ] **Neuen Bildprompt für Gemini erstellen**",
          `- [ ] Bild als \`public/bilder/${r.id}.jpg\` ablegen`,
          "- [ ] `build.py` ohne Hinweise, Freigabe durch Marcel",
        ].join("\n"),
      }),
    });
    return json(201, { ok: true, id: r.id, pr: pr.number });
  } catch (err) {
    console.error(err.message);
    return json(502, { ok: false, error: "github" });
  }
};
