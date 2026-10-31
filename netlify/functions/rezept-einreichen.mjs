/* =========================================================================
   Neues Rezept einreichen

   Eine Funktion, drei Aufgaben (Feld "action"), alle nur mit Zugangscode:
     check   Code prüfen – die App fragt ihn ab, bevor jemand etwas eintippt
     import  Rezept von einer Webseite holen (schema.org/Recipe) und als
             Vorschlag fürs Formular zurückgeben; Pinterest über den Link
             des Pins zur Originalseite
     (leer)  Einreichen: legt das Rezept als Pull Request im Repository an

   Eingereicht wird als Datei unter entwuerfe/, nicht unter recipes/. build.py
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
const MAX_BODY = 60_000;
const MAX_PAGE = 3_000_000;

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

/* ---------- Import von Webseiten ---------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  frac12: "½", frac14: "¼", frac34: "¾", deg: "°", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "„" };
const text = s => String(s ?? "")
  .replace(/<[^>]*>/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
  .replace(/\s+/g, " ").trim();

/* Nur öffentliche Adressen – die Funktion soll nicht als Umweg ins
   Netlify-Innere oder auf lokale Geräte dienen. */
function publicUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")
      || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith("[")) return null;
  return u;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(9000),
    headers: {
      // Viele Rezeptseiten sperren unbekannte Abrufer aus; mit Browserkennung
      // kommt dieselbe Seite, die auch das Handy bekäme.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.6",
    },
  });
  if (!res.ok) throw new Error("page " + res.status);
  const html = await res.text();
  return { html: html.slice(0, MAX_PAGE), url: res.url || url };
}

function findRecipe(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  const type = [].concat(node["@type"] || []).map(String);
  if (type.some(t => /recipe$/i.test(t))) return node;
  return findRecipe(node["@graph"]) || findRecipe(node.mainEntity);
}

function minutes(iso) {
  const m = String(iso || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return 0;
  return (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

function instructionLines(node, out = []) {
  if (!node) return out;
  if (typeof node === "string") {
    // Manche Seiten liefern alle Schritte als einen HTML-Block.
    node.split(/<\/p>|<\/li>|<br\s*\/?>|\n+/i).map(text).filter(Boolean).forEach(l => out.push(l));
    return out;
  }
  if (Array.isArray(node)) { node.forEach(n => instructionLines(n, out)); return out; }
  if (node.itemListElement) {
    // Abschnittsnamen wie "Für den Teig" bleiben als eigene Zeile stehen,
    // ein bloßes "Zubereitung" wäre doppelt.
    const name = text(node.name).replace(/:+$/, "");
    if (name && !/^(zubereitung|anleitung|instructions?)$/i.test(name)) out.push(`${name}:`);
    return instructionLines(node.itemListElement, out);
  }
  const t = text(node.text || node.name || "");
  if (t) out.push(t);
  return out;
}

function guessCategory(r) {
  const c = text([].concat(r.recipeCategory || []).join(" ") + " " + (r.name || "")).toLowerCase();
  if (/dessert|nachtisch|nachspeise|eis\b|pudding/.test(c)) return "Dessert";
  if (/kuchen|torte|brot|brötchen|gebäck|backen|muffin|cookie|keks/.test(c)) return "Backen";
  if (/vorspeise|starter|appetizer|suppe/.test(c)) return "Vorspeise";
  if (/snack|fingerfood/.test(c)) return "Snack";
  if (/sauce|soße|dip|dressing|pesto|gewürz/.test(c)) return "Zutat";
  return "Hauptspeise";
}

function recipeFromHtml(html) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let data;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    const r = findRecipe(data);
    if (!r) continue;
    const yieldRaw = [].concat(r.recipeYield || []).map(String).join(" ");
    const servings = parseInt((yieldRaw.match(/\d+/) || [])[0], 10) || 0;
    const time = minutes(r.totalTime) || minutes(r.prepTime) + minutes(r.cookTime);
    const ingredients = [].concat(r.recipeIngredient || r.ingredients || []).map(text).filter(Boolean);
    const steps = instructionLines(r.recipeInstructions).filter(Boolean);
    if (!ingredients.length && !steps.length) continue;
    return {
      title: text(r.name).slice(0, 120),
      category: guessCategory(r),
      servings: servings > 0 && servings <= 24 ? servings : 0,
      time: time > 0 && time <= 1440 ? time : 0,
      ingredients: ingredients.slice(0, 80),
      steps: steps.slice(0, 40),
      author: text([].concat(r.author || [])[0]?.name || [].concat(r.author || [])[0] || ""),
    };
  }
  return null;
}

/* Ein Pin ist meist nur ein Verweis. Die Originalseite steht im Seitencode –
   je nach Pinterest-Fassung an verschiedenen Stellen, deshalb mehrere Muster. */
function pinterestTarget(html) {
  const patterns = [
    /"link":"(https?:[^"]+)"/,
    /"sourceUrl":"(https?:[^"]+)"/,
    /<meta[^>]+property=["']og:see_also["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']alternate["'][^>]+href=["'](https?:\/\/(?!(?:[a-z]+\.)?pinterest\.)[^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (!m) continue;
    const url = m[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    if (!/pinterest\.|pin\.it/i.test(new URL(url).hostname)) return url;
  }
  return null;
}

async function importRecipe(raw) {
  const u = publicUrl(raw);
  if (!u) return { ok: false, error: "url" };
  const host = u.hostname.replace(/^www\./, "");
  if (/(^|\.)instagram\.com$|(^|\.)tiktok\.com$|(^|\.)facebook\.com$/.test(host)) return { ok: false, error: "social", host };
  try {
    let page = await fetchPage(u.href);
    let source = page.url;
    if (/(^|\.)pinterest\.[a-z.]+$|^pin\.it$/.test(new URL(page.url).hostname.replace(/^www\./, "")) || /pin\.it$/.test(host)) {
      const target = pinterestTarget(page.html);
      const t = target && publicUrl(target);
      if (!t) return { ok: false, error: "pin", host };
      page = await fetchPage(t.href);
      source = page.url;
    }
    const recipe = recipeFromHtml(page.html);
    if (!recipe) return { ok: false, error: "none", host: new URL(source).hostname.replace(/^www\./, ""), source };
    return { ok: true, recipe: { ...recipe, source }, host: new URL(source).hostname.replace(/^www\./, "") };
  } catch (err) {
    console.error("import", err.message);
    return { ok: false, error: "fetch", host };
  }
}

/* ---------- Einreichen als Pull Request ---------- */

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
    r.imported ? `Übernommen von: ${r.imported}` : null,
    "",
    "> Offen vor der Freigabe:",
    "> - [ ] Im Chat ins Rezeptformat überarbeiten (Zutatentabelle, Mengen in den Schritten, Gesundheitswert, Tags, Nährwerte)",
    "> - [ ] Neuen Bildprompt für Gemini erstellen (Stil: UEBERGABE.md, Abschnitt Neue Rezepte aus der App)",
    `> - [ ] Bild ablegen als public/bilder/${r.id}.jpg`,
    "> - [ ] Datei nach recipes/ verschieben, Entwurf löschen, build.py laufen lassen",
  ];
  if (r.ingredients.length) out.push("", "## 🛒 Zutaten (wie eingereicht)", "", ...r.ingredients.map(l => `- ${l}`));
  if (r.steps.length) out.push("", "## 👨‍🍳 Zubereitung (wie eingereicht)", "", ...r.steps.map((l, i) => `${i + 1}. ${l}`));
  if (r.tips.length) out.push("", "## 💡 Tipps (wie eingereicht)", "", ...r.tips.map(l => `- ${l}`));
  if (r.text) out.push("", "## Rezepttext (wie eingefügt)", "", "```text", r.text.replace(/```/g, "'''"), "```");
  if (r.note) out.push("", "## Anmerkung der einreichenden Person", "", r.note);
  return out.filter(l => l !== null).join("\n") + "\n";
}

async function submit(input, token) {
  const title = clean(input.title, 120);
  const r = {
    title,
    id: slugify(title),
    category: CATEGORIES.includes(input.category) ? input.category : "Hauptspeise",
    servings: Math.min(24, Math.max(0, parseInt(input.servings, 10) || 0)),
    time: Math.min(1440, Math.max(0, parseInt(input.time, 10) || 0)),
    source: clean(input.source, 300),
    imported: input.imported ? clean(input.imported, 120) : "",
    from: clean(input.from, 60),
    note: clean(input.note, 1000),
    ingredients: lines(input.ingredients, 80, 200),
    steps: lines(input.steps, 40, 1200),
    tips: lines(input.tips, 20, 600),
    // Frei eingefügter Text (z. B. aus Instagram), wird erst im Chat zerlegt.
    text: String(input.text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, 15000),
  };
  if (title.length < 3 || !r.id) return json(422, { ok: false, error: "title" });
  if (r.text.length < 20 && (!r.ingredients.length || !r.steps.length)) return json(422, { ok: false, error: "content" });

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
          `Eingereicht über die App am ${today}${r.from ? ` von ${r.from}` : ""}`
            + (r.imported ? `, übernommen von ${r.imported}.` : r.text ? ", als eingefügter Text." : ", selbst geschrieben."),
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

  if (input.action === "check") return json(200, { ok: true });
  if (input.action === "import") return json(200, await importRecipe(input.url));
  return submit(input, token);
};
