/* =========================================================================
   Rezepte – App-Logik
   Daten kommen aus data/recipes.js (window.RECIPES), erzeugt von build.py.
   ========================================================================= */
(() => {
"use strict";

/* Suchtext vereinheitlichen: "sosse" soll "Soße" finden und "mohre" die
   "Möhre". Index und Eingabe laufen durch dieselbe Funktion – entscheidend ist
   nicht die sprachliche Korrektheit, sondern dass beide Seiten gleich behandelt
   werden. */
function fold(text) {
  return String(text).toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u")
    .replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u");
}

const RECIPES = (window.RECIPES || []).map(r => ({
  ...r,
  search: [
    r.title, r.category, r.source, ...(r.tags || []),
    ...r.ingredientGroups.flatMap(g => [g.name, ...g.items.map(i => i.name)]),
    ...r.stepGroups.flatMap(g => [g.name, ...g.items.map(s => s.label + " " + s.text)]),
    ...r.tips
  ].join(" "),
}));
RECIPES.forEach(r => {
  r.search = fold(r.search);
  /* Einzelne Felder für die Rangfolge und den Hinweis, warum ein Rezept
     gefunden wurde – ein Treffer im Titel zählt mehr als einer im Fließtext. */
  r.find = {
    title: fold(r.title),
    tags: fold([r.category, ...(r.tags || [])].join(" ")),
    ingredients: r.ingredientGroups.flatMap(g => g.items.map(i => i.name)),
    steps: fold(r.stepGroups.flatMap(g => g.items.map(s => s.label + " " + s.text)).join(" ")),
  };
});

const ACCENTS = {
  "Hauptspeise": "var(--basil)",
  "Backen": "var(--saffron)",
  "Dessert": "var(--plum)",
  "Snack": "var(--ember)",
  "Vorspeise": "var(--teal)",
  "Zutat": "var(--slate)",
  "Sonstiges": "var(--ink-3)"
};
const accent = c => ACCENTS[c] || "var(--ink-2)";

/* ---------- Speicher (fällt still auf den Arbeitsspeicher zurück) ---------- */
const mem = {};
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : (key in mem ? mem[key] : fallback); }
    catch { return key in mem ? mem[key] : fallback; }
  },
  set(key, value) {
    mem[key] = value;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Privatmodus */ }
  }
};

/* ---------- Zustand ---------- */
const state = {
  q: "",
  terms: [],           // Suchwörter, gefaltet – alle müssen passen
  cat: null,
  maxTime: 120,
  tags: new Set(),
  sort: "title",
  view: "list",        // "list" oder "plan"
  open: null,          // aktuelles Rezept
  panel: null,         // "form" oder "draft:<id>" – Formular bzw. Entwurf im Sheet
  servings: 0,
  checkedIng: new Set(),
  checkedStep: new Set(),
  cook: false
};

const $ = sel => document.querySelector(sel);
/* Setzt eine Eigenschaft nur, wenn es das Element gibt. Fehlt eines – etwa weil
   der Browser noch eine ältere Fassung der Seite im Cache hat – läuft der Rest
   trotzdem weiter, statt dass die Liste leer bleibt. */
const set = (sel, apply) => { const n = $(sel); if (n) apply(n); return n; };
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- Mengen formatieren ---------- */
const FRACS = [[.125, "⅛"], [.25, "¼"], [.333, "⅓"], [.5, "½"], [.667, "⅔"], [.75, "¾"]];

function fmtQty(v, unit) {
  if (v == null) return "";
  const metric = /^(g|kg|ml|l)$/i.test(unit || "");
  if (metric) {
    if (v >= 100) v = Math.round(v / 5) * 5;
    else if (v >= 10) v = Math.round(v);
    else v = Math.round(v * 10) / 10;
  }
  const r = Math.round(v * 1000) / 1000;
  if (Math.abs(r - Math.round(r)) < 0.02) return String(Math.round(r));
  const whole = Math.floor(r), rest = r - whole;
  for (const [f, glyph] of FRACS) if (Math.abs(rest - f) < 0.03) return (whole || "") + glyph;
  return (Math.round(r * 100) / 100).toString().replace(".", ",");
}

function amountText(a, factor) {
  const f = factor || 1;
  const parts = [];
  if (a.prefix) parts.push(esc(a.prefix));
  if (a.qty != null) {
    let q = fmtQty(a.qty * f, a.unit);
    if (a.qtyTo != null) q += "–" + fmtQty(a.qtyTo * f, a.unit);
    parts.push(`<em>${q}</em>`);
  }
  if (a.unit) parts.push(esc(a.unit));
  let out = parts.join(" ");
  if (a.note) out += `<span class="ing__note">${esc(a.note)}</span>`;
  return out || esc(a.raw);
}

/* Schritt-Text mit mitskalierten Mengen. Die Stücke kommen aus build.py:
   'text' bleibt wie es ist, 'amount' wird mit dem Portionsfaktor gerechnet.
   'added' heißt: die Menge stand nicht im Originaltext, sondern kommt aus der
   Zutatenliste – sie braucht deshalb ein Leerzeichen zum folgenden Wort. */
/* Die Nährwerte beziehen sich je nach Rezept auf eine Portion, 100 g oder ein
   Stück. Ohne diesen Zusatz stünden auf zwei Karten nebeneinander "150 kcal"
   und "780 kcal", die nichts miteinander zu tun haben. */
const KCAL_UNITS = [
  [/pro portion/i, "Portion"],
  [/pro 100\s*g/i, "100 g"],
  [/pro burger/i, "Burger"],
  [/pro pizza/i, "Pizza"],
  [/pro br(ö|oe)tchen/i, "Brötchen"],
  [/pro scheibe/i, "Scheibe"],
  [/pro stange/i, "Stange"],
  [/pro st(ü|ue)ck/i, "Stück"],
];

function kcalUnit(note) {
  const hit = KCAL_UNITS.find(([re]) => re.test(note || ""));
  return hit ? hit[1] : "";
}

function stepText(step, factor) {
  const parts = step.parts || [{ type: "text", value: step.text }];
  return parts.map(p => {
    if (p.type === "text") return esc(p.value);
    if (p.type === "item") return `<span class="step__item">${esc(p.value)}</span>`;
    if (p.type === "time") return `<span class="step__time" role="button" tabindex="0"
      data-seconds="${p.seconds}" title="Timer starten">${esc(p.value)}</span>`;
    let q = fmtQty(p.qty * factor, p.unit);
    if (p.qtyTo != null) q += "–" + fmtQty(p.qtyTo * factor, p.unit);
    const label = p.unit ? `${q}\u202F${esc(p.unit)}` : q;
    return `<span class="step__amt">${label}</span>${p.added ? " " : ""}`;
  }).join("");
}

/* Bring! holt sich das Rezept serverseitig von seiner eigenen Seite unter
   /rezept/<id>.html – dort steht es als schema.org-Markup. baseQuantity und
   requestedQuantity übergeben die eingestellte Portionszahl, Bring rechnet die
   Mengen dann selbst um. Funktioniert nur auf der öffentlichen Adresse,
   nicht auf localhost: Bring muss die Seite erreichen können. */
function bringLink(r) {
  const page = new URL(`rezept/${r.id}.html`, location.href.split("#")[0]).href;
  const p = new URLSearchParams({
    url: page,
    source: "web",
    baseQuantity: String(r.servings || 1),
    requestedQuantity: String(state.servings || r.servings || 1),
  });
  return "https://api.getbring.com/rest/bringrecipes/deeplink?" + p;
}


/* =========================================================================
   Filter + Liste
   ========================================================================= */
/* =========================================================================
   Suche
   Mehrere Wörter grenzen ein ("feta paprika"). Während gesucht wird, steht
   oben, was am besten passt, und jede Karte sagt, wo das Wort vorkommt –
   sonst bleibt bei einem Treffer im Fließtext rätselhaft, warum das Rezept
   in der Liste steht.
   ========================================================================= */
/* Gleiche Sache, anderes Wort. Gefaltet geschrieben (siehe fold). Bewusst
   kurz gehalten: Jeder Eintrag erweitert die Treffer, ein zu großzügiger
   ("hack" trifft "gehackt") macht die Suche unbrauchbar. */
const SYNONYMS = [
  ["nudeln", "pasta", "spaghetti", "penne", "fusilli", "tagliatelle", "orzo", "ravioli"],
  ["sosse", "sauce"],
  ["chili", "chilli"],
  ["joghurt", "yoghurt", "jogurt"],
  ["brotchen", "buns"],
  ["burger", "patty", "patties"],
];

/* Ein Suchwort und seine Synonyme. "nudeln" findet so auch die Ravioli. */
function alts(term) {
  const group = SYNONYMS.find(g => g.includes(term));
  return group ? [term, ...group.filter(x => x !== term)] : [term];
}

const words = text => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const startsWord = (text, t) => words(text).some(w => w.startsWith(t));

/* Ein ganzes Wort zählt mehr als ein Wortteil: "kartoffel" soll die
   Kartoffeln der Patatas Bravas vor der Süßkartoffel im Titel finden. */
function termScore(r, t) {
  if (startsWord(r.title, t)) return 120;
  if (r.find.tags.includes(t)) return 50;
  if (r.find.ingredients.some(n => startsWord(n, t))) return 60;
  if (r.find.title.includes(t)) return 30;
  if (r.find.ingredients.some(n => fold(n).includes(t))) return 20;
  if (r.find.steps.includes(t)) return 8;
  return r.search.includes(t) ? 2 : 0;
}

function score(r) {
  return state.terms.reduce((sum, t) => sum + Math.max(...alts(t).map(a => termScore(r, a))), 0);
}

const termIn = (text, t) => alts(t).some(a => fold(text).includes(a));

/* Wo kommt das Wort vor? Nur für Wörter, die nicht schon im Titel stehen. */
function hitHint(r) {
  const ings = [], tags = [], other = [];
  const add = (list, v) => { if (!list.includes(v)) list.push(v); };
  state.terms.forEach(t => {
    if (termIn(r.title, t)) return;
    const ing = r.find.ingredients.find(n => termIn(n, t));
    const tag = (r.tags || []).find(x => termIn(x, t));
    if (ing) add(ings, mark(ing));
    else if (tag) add(tags, mark(tag));
    else add(other, termIn(r.find.steps, t) ? "in der Zubereitung" : "in den Tipps");
  });
  return [
    ings.length ? `${ings.length > 1 ? "Zutaten" : "Zutat"}: ${ings.join(", ")}` : "",
    tags.length ? `Tag: ${tags.join(", ")}` : "",
    ...other,
  ].filter(Boolean).join(" · ");
}

/* Hebt ganze Wörter hervor, die ein Suchwort enthalten. Ganze Wörter, weil
   fold() die Länge ändert ("ae" -> "a") und Zeichenpositionen sich deshalb
   nicht auf den Originaltext übertragen lassen. */
function mark(text) {
  if (!state.terms.length) return esc(text);
  return String(text).split(/([^\p{L}\p{N}]+)/u).map(w =>
    w && state.terms.some(t => termIn(w, t)) ? `<mark class="hit">${esc(w)}</mark>` : esc(w)
  ).join("");
}

/* "Meintest du …?" – für Tippfehler wie "zuchini". Verglichen wird mit allen
   Wörtern der Sammlung; ein Buchstabe Abstand, bei langen Wörtern zwei. */
let vocabulary = null;
function vocab() {
  if (vocabulary) return vocabulary;
  vocabulary = new Map();
  RECIPES.forEach(r => {
    const text = [r.title, ...(r.tags || []), ...r.find.ingredients,
      ...r.stepGroups.flatMap(g => g.items.map(s => s.text))].join(" ");
    text.split(/[^\p{L}]+/u).forEach(w => {
      if (w.length >= 4 && !vocabulary.has(fold(w))) vocabulary.set(fold(w), w);
    });
  });
  return vocabulary;
}

function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...cur) > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function correction(term) {
  if (term.length < 4 || RECIPES.some(r => alts(term).some(a => r.search.includes(a)))) return null;
  const max = term.length >= 8 ? 2 : 1;
  let best = null, bestD = max + 1;
  vocab().forEach((original, w) => {
    const d = distance(term, w, max);
    if (d < bestD) { best = original; bestD = d; }
  });
  return best;
}

function renderEmpty(count) {
  const host = $("#empty");
  if (!host) return;
  host.hidden = count > 0;
  if (count > 0) return;
  const fixes = state.terms.map(t => ({ t, fix: correction(t) })).filter(x => x.fix);
  if (!fixes.length) {
    host.textContent = "Kein Rezept passt zu dieser Kombination. Suchbegriff kürzen oder einen Filter lösen.";
    return;
  }
  const fixed = state.terms.map(t => fixes.find(x => x.t === t)?.fix || t).join(" ");
  host.innerHTML = `Nichts gefunden. Meintest du <button type="button" class="empty__fix">${esc(fixed)}</button>?`;
  host.querySelector("button").onclick = () => {
    const input = $("#search");
    input.value = fixed;
    setQuery(fixed);
  };
}

function matches(r) {
  if (state.terms.length && !state.terms.every(t => alts(t).some(a => r.search.includes(a)))) return false;
  if (state.cat && r.category !== state.cat) return false;
  if (r.time > state.maxTime) return false;
  if (state.tags.size && ![...state.tags].every(t => (r.tags || []).includes(t))) return false;
  return true;
}

function sorted(list) {
  const by = {
    title: (a, b) => a.title.localeCompare(b.title, "de"),
    time: (a, b) => a.time - b.time || a.title.localeCompare(b.title, "de"),
    kcal: (a, b) => (a.kcal ?? 1e9) - (b.kcal ?? 1e9),
    ingredients: (a, b) => a.ingredientCount - b.ingredientCount
  };
  const base = by[state.sort] || by.title;
  if (!state.terms.length) return [...list].sort(base);
  const scores = new Map(list.map(r => [r.id, score(r)]));
  return [...list].sort((a, b) => scores.get(b.id) - scores.get(a.id) || base(a, b));
}

function renderFacets() {
  const cats = [...new Set(RECIPES.map(r => r.category))].sort((a, b) => a.localeCompare(b, "de"));
  const catList = $("#catList");
  if (!catList) return;
  /* Mobil scrollt die Leiste seitlich. Ohne das Merken spränge sie bei jedem
     Klick an den Anfang, und die gerade gewählte Kategorie wäre weg. */
  const scrolled = catList.scrollLeft;
  catList.innerHTML = "";
  const mk = (label, value, n, dot) => {
    const b = el("button", "quickchip",
      `<span class="quickchip__dot" style="--dot:${dot}"></span>${esc(label)}<span class="quickchip__n">${n}</span>`);
    b.setAttribute("aria-pressed", String(state.cat === value));
    b.onclick = () => { state.cat = state.cat === value ? null : value; render(); };
    return b;
  };
  catList.append(mk("Alle", null, RECIPES.length, "var(--ink)"));
  cats.forEach(c => catList.append(mk(c, c, RECIPES.filter(r => r.category === c).length, accent(c))));
  catList.scrollLeft = scrolled;

  const tagCounts = new Map();
  RECIPES.forEach(r => (r.tags || []).forEach(t => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"));
  const tagHost = $("#tagList");
  if (!tagHost) return;
  tagHost.innerHTML = "";
  tags.forEach(([tag, n]) => {
    const b = el("button", "chip", `${esc(tag)} <span class="chip__n">${n}</span>`);
    b.setAttribute("aria-pressed", String(state.tags.has(tag)));
    b.onclick = () => { state.tags.has(tag) ? state.tags.delete(tag) : state.tags.add(tag); render(); };
    tagHost.append(b);
  });
}

function card(r) {
  const c = el("article", "card");
  c.style.setProperty("--accent", accent(r.category));
  c.tabIndex = 0;
  c.setAttribute("role", "button");
  c.innerHTML = `
    ${r.image ? `<figure class="card__figure"><img src="${esc(r.image)}" alt="" loading="lazy" decoding="async"></figure>` : ""}
    <div class="card__top">
      <span class="card__cat">${esc(r.category)}</span>
   </div>
    <h3 class="card__title">${mark(r.title)}${onMenu(r.id) ? ` <span class="card__onmenu">geplant</span>` : ""}</h3>
    ${state.terms.length && hitHint(r) ? `<p class="card__hit">${hitHint(r)}</p>` : ""}
    ${(r.tags || []).length ? `<p class="card__tags">${r.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join("")}</p>` : ""}
    <p class="card__spec">
      <span>${r.time} min</span><span class="card__sep">/</span>
      <span>${r.servings} Port.</span><span class="card__sep">/</span>
      <span>${r.ingredientCount} Zutaten</span>
      ${r.kcal ? `<span class="card__sep">/</span><span>${r.kcal} kcal${
        kcalUnit(r.nutritionNote) ? `<span class="card__per">/${esc(kcalUnit(r.nutritionNote))}</span>` : ""}</span>` : ""}
    </p>`;
  c.onclick = () => openRecipe(r.id);
  c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRecipe(r.id); } };
  return c;
}

/* =========================================================================
   Aktive Filter
   Auf dem Handy liegen Tags, Ernährung und Zeit in der eingeklappten
   Seitenleiste. Ohne diese Anzeige sah man nach dem Schließen nur noch
   "2 von 51 Rezepten" und wusste nicht, warum Rezepte fehlen.
   ========================================================================= */
function activeFilters() {
  const list = [];
  state.tags.forEach(t => list.push({ label: t, drop: () => state.tags.delete(t) }));
  if (state.maxTime < 120) list.push({ label: `bis ${state.maxTime} min`, drop: () => {
    state.maxTime = 120; set("#timeRange", n => { n.value = 120; });
  } });
  return list;
}

function renderActiveFilters(count) {
  const filters = activeFilters();
  set("#filterToggle", n => {
    const open = $("#rail")?.classList.contains("open");
    n.textContent = open ? "Schließen" : filters.length ? `Filter · ${filters.length}` : "Filter";
    n.setAttribute("aria-pressed", String(filters.length > 0));
  });
  set("#railDone", n => { n.textContent = count === 1 ? "1 Rezept anzeigen" : `${count} Rezepte anzeigen`; });
  const host = $("#activeFilters");
  if (!host) return;
  host.hidden = !filters.length;
  host.innerHTML = "";
  filters.forEach(f => {
    const b = el("button", "activechip", `${esc(f.label)}<span aria-hidden="true">×</span>`);
    b.setAttribute("aria-label", `Filter ${f.label} entfernen`);
    b.onclick = () => { f.drop(); render(); };
    host.append(b);
  });
  if (filters.length > 1) {
    const all = el("button", "activechip activechip--all", "Alle lösen");
    all.onclick = () => {
      state.tags.clear(); state.maxTime = 120;
      set("#timeRange", n => { n.value = 120; });
      render();
    };
    host.append(all);
  }
}

function render() {
  renderFacets();
  const list = sorted(RECIPES.filter(matches));
  const grid = $("#grid");
  grid.innerHTML = "";
  list.forEach(r => grid.append(card(r)));
  set("#count", n => {
    n.textContent = list.length === RECIPES.length
      ? `${list.length} Rezepte`
      : `${list.length} von ${RECIPES.length} Rezepten`;
  });
  const shownDrafts = drafts.filter(draftMatches);
  const hits = list.length + shownDrafts.length;
  set("#searchCount", n => {
    n.hidden = !state.q;
    n.textContent = hits === 1 ? "1 Treffer" : `${hits} Treffer`;
  });
  set("#searchClear", n => { n.hidden = !state.q; });
  document.body.classList.toggle("has-query", !!state.q);
  set("#timeOut", n => { n.textContent = state.maxTime >= 120 ? "beliebig" : `${state.maxTime} min`; });
  renderActiveFilters(list.length);
  renderEmpty(hits);
  renderDrafts(shownDrafts);
}


/* =========================================================================
   Essensplan

   Eigener Bereich neben der Rezeptliste. Ein Eintrag ist entweder ein Rezept
   aus der Sammlung oder nur ein Text ("Pizza bestellen") – kein Datum, keine
   Wochentage: geplant wird, was es demnächst gibt, nicht wann.
   Gespeichert wird allein im Browser dieses Geräts. Das ist bewusst so: ohne
   Server bleibt die App eine reine statische Seite. Preis dafür ist, dass der
   Plan nicht auf einem zweiten Gerät auftaucht.
   ========================================================================= */
const MENU_KEY = "essensplan.v1";
let menu = store.get(MENU_KEY, []);
if (!Array.isArray(menu)) menu = [];

const saveMenu = () => store.set(MENU_KEY, menu);
const menuOpen = () => menu.filter(e => !e.cooked);
const menuDone = () => menu.filter(e => e.cooked).sort((a, b) => (b.cookedAt || 0) - (a.cookedAt || 0));
const onMenu = id => menu.some(e => !e.cooked && e.recipe === id);

function menuAdd(title, recipeId) {
  title = String(title || "").trim();
  if (!title) return false;
  /* Dasselbe Rezept nicht zweimal offen führen – ein zweiter Haken bei
     "eingekauft" wäre sonst sinnlos. */
  if (recipeId && onMenu(recipeId)) return false;
  menu.push({
    id: "e" + Date.now() + Math.round(Math.random() * 1e4),
    recipe: recipeId || null,
    title,
    bought: false,
    cooked: false,
    cookedAt: null,
  });
  saveMenu();
  return true;
}

function menuPatch(id, patch) {
  const e = menu.find(x => x.id === id);
  if (!e) return;
  Object.assign(e, patch);
  saveMenu();
  renderMenu();
  if (state.view === "list") render();
}

/* Entfernen ohne Rückfrage, aber mit Rückgängig – ein Fehltipper auf das
   kleine Kreuz soll nichts kosten. */
function menuRemove(id) {
  const i = menu.findIndex(x => x.id === id);
  if (i < 0) return;
  const [entry] = menu.splice(i, 1);
  saveMenu();
  renderMenu();
  if (state.view === "list") render();
  toast(`„${entry.title}“ entfernt`, "Rückgängig", () => {
    menu.splice(Math.min(i, menu.length), 0, entry);
    saveMenu();
    renderMenu();
    if (state.view === "list") render();
    if (state.open) renderSheet();
  });
}

/* =========================================================================
   Zusammen kochen – Teil des Essensplans
   Was im Plan steht, bestimmt die frischen Zutaten. Vorgeschlagen werden
   Rezepte, die dieselben schnell verderblichen Zutaten aufbrauchen. Früher
   war das ein eigener Auswahlmodus in der Rezeptliste – zwei Arten zu planen
   nebeneinander, die nichts voneinander wussten.
   Gezählt wird nur, was schnell verdirbt – die Liste dazu entsteht in build.py.
   ========================================================================= */
function menuRecipes() {
  return menuOpen().map(e => RECIPES.find(r => r.id === e.recipe)).filter(Boolean);
}

function menuFresh() {
  const all = new Set();
  menuRecipes().forEach(r => (r.fresh || []).forEach(f => all.add(f)));
  return [...all].sort((a, b) => a.localeCompare(b, "de"));
}

function menuSuggestions() {
  const wanted = new Set(menuFresh());
  if (!wanted.size) return [];
  const planned = new Set(menuRecipes().map(r => r.id));
  return RECIPES
    .filter(r => !planned.has(r.id))
    .map(r => ({ recipe: r, shared: (r.fresh || []).filter(f => wanted.has(f)) }))
    .filter(x => x.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length ||
                    a.recipe.time - b.recipe.time ||
                    a.recipe.title.localeCompare(b.recipe.title, "de"))
    .slice(0, 6);
}

function renderMenuSuggest() {
  const host = $("#menuSuggest");
  if (!host) return;
  const fresh = menuFresh();
  host.innerHTML = "";
  if (!menuRecipes().length) return;
  host.append(el("div", "menu__fresh", `
    <h2 class="block__title">Frisch einzukaufen</h2>
    <p class="menu__freshlist">${fresh.length
      ? fresh.map(f => `<span>${esc(f)}</span>`).join("")
      : "Nichts davon verdirbt schnell – der Plan kann warten."}</p>`));
  const hits = menuSuggestions();
  if (!hits.length) return;
  host.append(el("h2", "block__title menu__sugtitle", "Passt dazu – verbraucht dieselben frischen Zutaten"));
  const wrap = el("div", "grid");
  hits.forEach(({ recipe, shared }) => {
    const c = card(recipe);
    c.classList.add("card--suggested");
    c.insertBefore(el("p", "card__shared",
      `teilt ${shared.length}: ${shared.map(f => esc(f)).join(", ")}`), c.querySelector(".card__spec"));
    const b = el("button", "plan-btn", "+ Einplanen");
    b.onclick = e => { e.stopPropagation(); menuAdd(recipe.title, recipe.id); renderMenu(); };
    c.append(b);
    wrap.append(c);
  });
  host.append(wrap);
}

function mealRow(e, archived) {
  const name = e.recipe
    ? `<button class="meal__title meal__title--link" data-open="${esc(e.recipe)}">${esc(e.title)}</button>`
    : `<span class="meal__title">${esc(e.title)}</span>`;
  const checks = archived ? `
      <button class="ghost-btn" data-again="${e.id}">Nochmal kochen</button>` : `
      <label class="check"><input type="checkbox" data-bought="${e.id}"${e.bought ? " checked" : ""}><span>eingekauft</span></label>
      <label class="check"><input type="checkbox" data-cooked="${e.id}"><span>gekocht</span></label>`;
  return `<li class="meal${archived ? " meal--done" : ""}${e.bought && !archived ? " meal--bought" : ""}">
    ${name}
    <div class="meal__actions">${checks}
      <button class="meal__x" data-del="${e.id}" aria-label="Eintrag entfernen">${ICON_CLOSE}</button>
    </div>
  </li>`;
}

function renderMenu() {
  const openHost = $("#menuOpen"), doneHost = $("#menuArchive");
  const n = menuOpen().length;
  [["#menuCount", n], ["#menuCountRail", n]].forEach(([sel, v]) =>
    set(sel, el => { el.textContent = v; el.hidden = v === 0; }));
  if (!openHost || !doneHost) return;

  const list = menuOpen();
  openHost.innerHTML = list.length
    ? `<h2 class="block__title">Geplant <span class="menu__n">${list.length}</span></h2>
       <ul class="meals">${list.map(e => mealRow(e, false)).join("")}</ul>`
    : `<p class="menu__empty">Noch nichts geplant. Oben ein Rezept auswählen oder frei eintippen – der Plan bleibt auf diesem Gerät.</p>`;

  renderMenuSuggest();

  const done = menuDone();
  doneHost.innerHTML = done.length
    ? `<h2 class="block__title menu__arch">Archiv <span class="menu__n">${done.length}</span></h2>
       <ul class="meals meals--archive">${done.map(e => mealRow(e, true)).join("")}</ul>`
    : "";

  const host = $("#menuview");
  host.querySelectorAll("[data-bought]").forEach(b =>
    b.onchange = () => menuPatch(b.dataset.bought, { bought: b.checked }));
  /* "gekocht" ist der Abschluss: der Eintrag wandert ins Archiv, statt in der
     Liste als abgehakt stehen zu bleiben. */
  host.querySelectorAll("[data-cooked]").forEach(b =>
    b.onchange = () => menuPatch(b.dataset.cooked, { cooked: true, cookedAt: Date.now() }));
  host.querySelectorAll("[data-again]").forEach(b =>
    b.onclick = () => menuPatch(b.dataset.again, { cooked: false, cookedAt: null, bought: false }));
  host.querySelectorAll("[data-del]").forEach(b =>
    b.onclick = () => menuRemove(b.dataset.del));
  host.querySelectorAll("[data-open]").forEach(b =>
    b.onclick = () => openRecipe(b.dataset.open));
}

/* =========================================================================
   Neue Rezepte

   Eingereicht wird über eine Netlify-Funktion, die das Rezept als Pull
   Request anlegt. In die Sammlung kommt es erst nach Überarbeitung und
   Freigabe – bis dahin steht es auf dem einreichenden Gerät als Entwurf,
   so wie es eingetippt wurde. Steht das fertige Rezept (gleiche ID) in der
   Sammlung, verschwindet der Entwurf von selbst.
   ========================================================================= */
const DRAFT_KEY = "entwuerfe.v1";
const CODE_KEY = "rezeptcode.v1";
const FROM_KEY = "rezeptvon.v1";
const CATEGORIES = ["Hauptspeise", "Vorspeise", "Backen", "Snack", "Dessert", "Zutat"];
let drafts = store.get(DRAFT_KEY, []);
if (!Array.isArray(drafts)) drafts = [];
drafts = drafts.filter(d => !RECIPES.some(r => r.id === d.id));
const saveDrafts = () => store.set(DRAFT_KEY, drafts.map(({ search, ...d }) => d));
saveDrafts();
let formDraft = null;   // halb ausgefülltes Formular, überlebt ein versehentliches Zurück

/* Wie slugify() in build.py – daran erkennt die App das freigegebene Rezept. */
function slugify(text) {
  let t = String(text).toLowerCase();
  for (const [a, b] of [["ä", "ae"], ["ö", "oe"], ["ü", "ue"], ["ß", "ss"],
                        ["ı", "i"], ["ş", "s"], ["ç", "c"], ["ğ", "g"]]) t = t.split(a).join(b);
  t = t.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const splitLines = s => String(s || "").split(/\r?\n/)
  .map(l => l.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "")).filter(Boolean);

function draftCard(d) {
  const c = el("article", "card card--draft");
  c.style.setProperty("--accent", accent(d.category));
  c.tabIndex = 0;
  c.setAttribute("role", "button");
  c.innerHTML = `
    <div class="card__top">
      <span class="card__cat">${esc(d.category)}</span>
      <span class="card__draft">${d.status === "sent" ? "Entwurf" : "Nicht gesendet"}</span>
    </div>
    <h3 class="card__title">${mark(d.title)}</h3>
    <p class="card__spec">
      ${d.time ? `<span>${d.time} min</span><span class="card__sep">/</span>` : ""}
      ${d.servings ? `<span>${d.servings} Port.</span><span class="card__sep">/</span>` : ""}
      <span>${d.ingredients.length ? `${d.ingredients.length} Zutaten`
        : d.photos?.length ? (d.photos.length === 1 ? "als Foto" : `${d.photos.length} Fotos`) : "als Text eingefügt"}</span>
    </p>`;
  c.onclick = () => openDraft(d.id);
  c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDraft(d.id); } };
  return c;
}

/* Entwürfe zählen bei Suche und Kategorie mit – wer sein eingereichtes
   Rezept sucht, soll es finden. Tags und Zeit haben sie noch nicht; ist
   einer dieser Filter aktiv, bleiben sie deshalb weg. */
function draftMatches(d) {
  if (state.tags.size || state.maxTime < 120) return false;
  if (state.cat && d.category !== state.cat) return false;
  if (!state.terms.length) return true;
  d.search ??= fold([d.title, d.category, d.source, ...d.ingredients, ...d.steps, ...d.tips, d.text || ""].join(" "));
  return state.terms.every(t => alts(t).some(a => d.search.includes(a)));
}

function renderDrafts(list) {
  const host = $("#drafts");
  if (!host) return;
  host.hidden = !list.length;
  if (!list.length) return;
  host.innerHTML = `<h2 class="drafts__title">Eingereicht · wartet auf Freigabe</h2><div class="grid drafts__grid"></div>`;
  list.forEach(d => host.querySelector(".drafts__grid").append(draftCard(d)));
}

function openPanel(panel, hash) {
  saveProgress();
  state.open = null;
  state.panel = panel;
  document.body.classList.add("locked");
  if (location.hash !== hash) history.pushState({ panel }, "", hash);
}

function openDraft(id) {
  if (!drafts.some(d => d.id === id)) return;
  openPanel("draft:" + id, "#/e/" + encodeURIComponent(id));
  renderDraft(id);
}

/* Der Weg zum neuen Rezept, Schritt für Schritt im selben Sheet:
     code → choice → link → form (vorausgefüllt) oder text (eingefügt)
                   → form (selbst geschrieben)
   Der Code kommt zuerst, damit niemand ein ganzes Rezept tippt und erst beim
   Absenden erfährt, dass er nicht einreichen darf. Ein einmal geprüfter Code
   wird gemerkt. */
let newStep = "code";
let newNotice = "";

async function api(body) {
  const res = await fetch("/api/rezept-einreichen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function openForm() {
  openPanel("form", "#/neu");
  newStep = store.get(CODE_KEY, "") ? (formDraft?.step || "choice") : "code";
  newNotice = "";
  renderNew();
}

function goStep(step, notice = "") {
  newStep = step;
  newNotice = notice;
  if (formDraft) formDraft.step = step === "code" ? formDraft.step : step;
  renderNew();
}

const TITLES = {
  code: "Rezept einreichen",
  choice: "Wie kommt das Rezept rein?",
  link: "Aus dem Netz übernehmen",
  form: "Rezept eintragen",
  text: "Rezepttext einfügen",
  photo: "Foto hochladen",
};

function renderNew() {
  const f = formDraft || {};
  const v = k => esc(f[k] || "");
  const sheet = $("#sheet");
  sheet.hidden = false;
  sheet.onclick = null;
  sheet.classList.remove("cook");
  sheet.style.setProperty("--accent", "var(--saffron)");

  const back = newStep === "code" || newStep === "choice" ? ""
    : `<button type="button" class="newrecipe__back" data-act="choice">← Andere Art wählen</button>`;
  const title = `
        <label class="newrecipe__field">
          <span>Titel</span>
          <input type="text" name="title" maxlength="120" required value="${v("title")}" placeholder="z. B. Türkische Linsensuppe">
          <small class="newrecipe__dupe" id="dupeHint" hidden></small>
        </label>`;
  const category = `
          <label class="newrecipe__field">
            <span>Kategorie</span>
            <select name="category">${CATEGORIES.map(c =>
              `<option${(f.category || "Hauptspeise") === c ? " selected" : ""}>${c}</option>`).join("")}</select>
          </label>`;
  const tail = `
        <label class="newrecipe__field">
          <span>Quelle <em>optional, Name oder Link</em></span>
          <input type="text" name="source" maxlength="300" value="${v("source")}" placeholder="z. B. Oma, Kochbuch oder https://…">
        </label>
        <label class="newrecipe__field">
          <span>Anmerkung für Marcel <em>optional</em></span>
          <textarea name="note" rows="2" maxlength="1000">${v("note")}</textarea>
        </label>
        <label class="newrecipe__field">
          <span>Von <em>optional</em></span>
          <input type="text" name="from" maxlength="60" autocomplete="name" value="${esc(f.from ?? store.get(FROM_KEY, ""))}">
        </label>
        <input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" class="feedback__trap">
        <div class="newrecipe__actions">
          <button type="submit" class="ghost-btn newrecipe__send">Einreichen</button>
          <span class="newrecipe__status" id="newRecipeStatus" role="status"></span>
        </div>`;

  const steps = {
    code: `
        <p class="newrecipe__intro">Neue Rezepte kann einreichen, wer den Zugangscode kennt. Den bekommst du von Marcel.</p>
        <label class="newrecipe__field newrecipe__field--narrow">
          <span>Zugangscode</span>
          <input type="password" name="code" required autocomplete="off" autocapitalize="off" enterkeyhint="go">
        </label>
        <div class="newrecipe__actions">
          <button type="submit" class="ghost-btn newrecipe__send">Weiter</button>
          <span class="newrecipe__status" id="newRecipeStatus" role="status"></span>
        </div>`,
    choice: `
        <div class="newrecipe__choices">
          <button type="button" class="newrecipe__choice" data-act="link">
            <strong>Aus dem Netz übernehmen</strong>
            <span>Link zu einem Rezept einfügen – von einer Rezeptseite oder aus Pinterest</span>
          </button>
          <button type="button" class="newrecipe__choice" data-act="photo">
            <strong>Foto hochladen</strong>
            <span>Rezept aus Kochbuch, Zeitschrift oder von einem Zettel fotografieren oder ein Bild auswählen</span>
          </button>
          <button type="button" class="newrecipe__choice" data-act="form">
            <strong>Selbst aufschreiben</strong>
            <span>Zutaten und Schritte von Hand eintragen – aus dem Kochbuch, von Oma oder aus dem Kopf</span>
          </button>
        </div>`,
    link: `
        <p class="newrecipe__intro">Füge den Link ein. Die App holt Titel, Zutaten und Schritte von der Seite, danach kannst du alles prüfen.</p>
        <label class="newrecipe__field">
          <span>Link</span>
          <input type="url" name="url" required inputmode="url" autocomplete="off" enterkeyhint="go" value="${v("url")}" placeholder="https://…">
        </label>
        <div class="newrecipe__actions">
          <button type="submit" class="ghost-btn newrecipe__send">Rezept holen</button>
          <span class="newrecipe__status" id="newRecipeStatus" role="status"></span>
        </div>`,
    form: `${title}
        <div class="newrecipe__row newrecipe__row--meta">${category}
          <label class="newrecipe__field">
            <span>Portionen</span>
            <input type="number" name="servings" min="1" max="24" inputmode="numeric" value="${v("servings")}" placeholder="2">
          </label>
          <label class="newrecipe__field">
            <span>Minuten</span>
            <input type="number" name="time" min="1" max="1440" inputmode="numeric" value="${v("time")}" placeholder="30">
          </label>
        </div>
        <label class="newrecipe__field">
          <span>Zutaten <em>eine pro Zeile, Menge zuerst</em></span>
          <textarea name="ingredients" rows="7" required placeholder="200 g rote Linsen&#10;1 Zwiebel&#10;2 EL Tomatenmark">${v("ingredients")}</textarea>
        </label>
        <label class="newrecipe__field">
          <span>Zubereitung <em>ein Schritt pro Zeile</em></span>
          <textarea name="steps" rows="7" required placeholder="Zwiebel würfeln und in Öl glasig dünsten.&#10;Linsen und Brühe dazugeben, 20 Minuten köcheln.">${v("steps")}</textarea>
        </label>
        <label class="newrecipe__field">
          <span>Tipps <em>optional</em></span>
          <textarea name="tips" rows="2">${v("tips")}</textarea>
        </label>${tail}`,
    text: `${title}
        <div class="newrecipe__row newrecipe__row--text">${category}</div>
        <label class="newrecipe__field">
          <span>Rezepttext <em>einfach alles einfügen, Marcel sortiert es</em></span>
          <textarea name="text" rows="12" required placeholder="Zutaten und Zubereitung, so wie sie im Beitrag stehen">${v("text")}</textarea>
        </label>${tail}`,
    photo: `${title}
        <div class="newrecipe__row newrecipe__row--text">${category}</div>
        <div class="newrecipe__field">
          <span>Fotos <em>bis zu ${MAX_PHOTOS}, z. B. für eine Doppelseite</em></span>
          <div class="newrecipe__photos" id="photoList"></div>
          <label class="ghost-btn newrecipe__pick" tabindex="0">
            <input type="file" accept="image/*" multiple id="photoInput" class="newrecipe__file">
            <span id="pickLabel">Foto aufnehmen oder auswählen</span>
          </label>
        </div>${tail}`,
  };

  sheet.innerHTML = `
    <div class="sheet__bar">
      <button class="icon-btn nowrap" data-act="close">←<span class="lbl"> Zurück</span></button>
    </div>
    <div class="sheet__wrap">
      <form class="newrecipe" id="newRecipeForm" novalidate>
        <header class="sheet__head">
          <p class="sheet__eyebrow">Neues Rezept</p>
          <h1 class="sheet__title" id="sheetTitle">${TITLES[newStep]}</h1>
        </header>
        ${back}
        ${newNotice ? `<p class="newrecipe__notice">${esc(newNotice)}</p>` : ""}
        ${steps[newStep]}
      </form>
    </div>`;

  const form = sheet.querySelector("#newRecipeForm");
  const status = sheet.querySelector("#newRecipeStatus");
  const read = () => Object.fromEntries(new FormData(form));
  const dupe = () => {
    if (!form.elements.title) return;
    const id = slugify(form.elements.title.value);
    const hit = id && (RECIPES.find(r => r.id === id) || drafts.find(d => d.id === id));
    set("#dupeHint", n => { n.hidden = !hit; n.textContent = hit ? `„${hit.title}“ gibt es schon.` : ""; });
  };
  form.oninput = () => {
    if (newStep === "code") return;
    const { code, website, ...values } = read();
    formDraft = { ...formDraft, ...values, step: newStep };
    dupe();
  };
  dupe();

  sheet.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === "close") closeRecipe();
    if (a === "choice") goStep("choice");
    if (a === "link" || a === "form" || a === "photo") {
      formDraft = { ...formDraft, step: a };
      goStep(a);
    }
  });
  const first = form.querySelector("input:not([type=hidden]):not(.feedback__trap), textarea");
  if (first && (newStep === "code" || newStep === "link")) first.focus();

  // Fotos: Vorschau mit ×, auf dem Handy bietet die Auswahl auch die Kamera an.
  const photoInput = form.querySelector("#photoInput");
  const renderPhotos = () => {
    const list = formDraft?.photos || [];
    const host = form.querySelector("#photoList");
    host.innerHTML = list.map((p, i) => `
      <figure class="newrecipe__photo">
        <img src="${p.thumb}" alt="Foto ${i + 1}">
        <button type="button" data-drop="${i}" aria-label="Foto ${i + 1} entfernen">×</button>
      </figure>`).join("");
    host.querySelectorAll("[data-drop]").forEach(b => b.onclick = () => {
      formDraft.photos.splice(+b.dataset.drop, 1);
      renderPhotos();
    });
    form.querySelector(".newrecipe__pick").hidden = list.length >= MAX_PHOTOS;
    form.querySelector("#pickLabel").textContent = list.length ? "Weiteres Foto" : "Foto aufnehmen oder auswählen";
  };
  if (photoInput) {
    renderPhotos();
    photoInput.onchange = async () => {
      const files = [...photoInput.files];
      photoInput.value = "";
      const room = MAX_PHOTOS - (formDraft?.photos?.length || 0);
      status.textContent = "Fotos werden vorbereitet …";
      let failed = false;
      for (const file of files.slice(0, room)) {
        try {
          const photo = await preparePhoto(file);
          formDraft = { ...formDraft, step: "photo", photos: [...(formDraft?.photos || []), photo] };
        } catch { failed = true; }
      }
      status.textContent = failed ? "Ein Bild ließ sich nicht öffnen."
        : files.length > room ? `Höchstens ${MAX_PHOTOS} Fotos – die übrigen wurden weggelassen.` : "";
      renderPhotos();
    };
  }

  form.onsubmit = async e => {
    e.preventDefault();
    if (newStep === "code") return checkCode(form, status);
    if (newStep === "link") return importLink(form, status);
    if (newStep === "form" || newStep === "text" || newStep === "photo") return submitNew(form, status, read());
  };
  sheet.scrollTop = 0;
}

async function checkCode(form, status) {
  const code = form.elements.code.value.trim();
  if (!code) { status.textContent = "Bitte den Zugangscode eintragen."; form.elements.code.focus(); return; }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  status.textContent = "Wird geprüft …";
  try {
    const { status: s } = await api({ action: "check", code });
    if (s === 200) {
      store.set(CODE_KEY, code);
      goStep(formDraft?.step && formDraft.step !== "code" ? formDraft.step : "choice");
      return;
    }
    status.textContent = s === 403 ? "Der Code stimmt nicht." : "Gerade nicht erreichbar. Bitte später nochmal versuchen.";
  } catch {
    status.textContent = "Gerade nicht erreichbar. Bitte später nochmal versuchen.";
  }
  button.disabled = false;
}

/* Gemerkter Code gilt nicht mehr (geändert): zurück zur Abfrage, das
   bisher Eingetippte bleibt in formDraft erhalten. */
function codeExpired() {
  store.set(CODE_KEY, "");
  goStep("code", "Der Zugangscode hat sich geändert. Bitte neu eingeben – dein Rezept bleibt erhalten.");
}

async function importLink(form, status) {
  const url = form.elements.url.value.trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(url)) { status.textContent = "Bitte einen vollständigen Link einfügen, beginnend mit https://"; return; }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  status.textContent = "Rezept wird geholt …";
  let res;
  try { res = await api({ action: "import", code: store.get(CODE_KEY, ""), url }); }
  catch { res = { status: 0, data: {} }; }
  button.disabled = false;
  if (res.status === 403) return codeExpired();
  const d = res.data || {};
  if (res.status === 200 && d.ok) {
    const r = d.recipe;
    formDraft = {
      ...formDraft, step: "form", url, title: r.title, category: r.category,
      servings: r.servings || "", time: r.time || "",
      ingredients: r.ingredients.join("\n"), steps: r.steps.join("\n"), tips: "",
      source: r.source || url, imported: d.host,
    };
    goStep("form", `Von ${d.host} übernommen. Bitte kurz prüfen und anpassen, wo nötig.`);
    return;
  }
  if (res.status !== 200) { status.textContent = "Gerade nicht erreichbar. Bitte später nochmal versuchen."; return; }
  if (d.error === "url") { status.textContent = "Mit diesem Link kann die App nichts anfangen. Bitte den Link prüfen."; return; }
  // Kein lesbares Rezept: Text einfügen lassen, Quelle steht schon drin.
  formDraft = { ...formDraft, step: "text", url, source: d.source || url, imported: "" };
  const network = (d.host || "").replace(/\.[a-z]+$/, "");
  goStep("text", d.error === "social"
    ? `${network[0].toUpperCase() + network.slice(1)} gibt Rezepte nicht direkt heraus. Öffne den Beitrag, kopiere den Text und füge ihn hier ein.`
    : d.error === "pin"
      ? "Dieser Pin führt zu keiner Rezeptseite. Kopiere den Rezepttext und füge ihn hier ein."
      : `Auf ${d.host || "der Seite"} war kein Rezept zu finden, das die App lesen kann. Kopiere den Rezepttext von der Seite und füge ihn hier ein.`);
}

/* Fotos werden schon im Browser verkleinert: Handyfotos haben 3–8 MB, die
   Funktion nimmt höchstens 6 MB je Aufruf. 1600 px reichen zum Abtippen.
   Die kleine Fassung bleibt als Vorschau beim Entwurf auf dem Gerät. */
const MAX_PHOTOS = 4;
const MAX_UPLOAD = 5_400_000;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bild")); };
    img.src = url;
  });
}

function scaledJpeg(img, max, quality) {
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

async function preparePhoto(file) {
  const img = await loadImage(file);
  return { full: scaledJpeg(img, 1600, .82), thumb: scaledJpeg(img, 360, .7) };
}

async function submitNew(form, status, data) {
  const mode = newStep;   // "form", "text" oder "photo"
  const photos = mode === "photo" ? (formDraft?.photos || []) : [];
  const missing = !data.title.trim() ? "title"
    : mode === "text" ? (data.text.trim().length < 20 ? "text" : null)
    : mode === "photo" ? (photos.length ? null : "photo")
    : !splitLines(data.ingredients).length ? "ingredients" : !splitLines(data.steps).length ? "steps" : null;
  if (missing) {
    status.textContent = { title: "Bitte einen Titel eintragen.", text: "Bitte den Rezepttext einfügen.",
      photo: "Bitte mindestens ein Foto hinzufügen.",
      ingredients: "Bitte mindestens eine Zutat eintragen.", steps: "Bitte mindestens einen Schritt eintragen." }[missing];
    (form.elements[missing] || form.querySelector(".newrecipe__pick"))?.focus();
    return;
  }
  if (photos.reduce((n, p) => n + p.full.length, 0) > MAX_UPLOAD) {
    status.textContent = "Die Fotos sind zusammen zu groß. Bitte eins weglassen.";
    return;
  }
  const id = slugify(data.title);
  if (RECIPES.some(r => r.id === id) || drafts.some(d => d.id === id)) {
    status.textContent = "Ein Rezept mit diesem Titel gibt es schon. Bitte anders benennen.";
    form.elements.title.focus();
    return;
  }
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  status.textContent = photos.length ? "Wird eingereicht, Fotos werden hochgeladen …" : "Wird eingereicht …";
  const typed = mode === "form";
  const draft = {
    id, title: data.title.trim(), category: data.category,
    servings: typed ? parseInt(data.servings, 10) || 0 : 0, time: typed ? parseInt(data.time, 10) || 0 : 0,
    ingredients: typed ? splitLines(data.ingredients) : [], steps: typed ? splitLines(data.steps) : [],
    tips: typed ? splitLines(data.tips) : [], text: mode === "text" ? data.text.trim() : "",
    photos: photos.map(p => p.thumb),
    source: data.source.trim(), note: data.note.trim(), from: data.from.trim(),
    imported: typed ? (formDraft?.imported || "") : "",
    submittedAt: Date.now(), status: "failed",
  };
  store.set(FROM_KEY, draft.from);
  const result = await sendDraft(draft, store.get(CODE_KEY, ""), data.website, photos.map(p => p.full));
  button.disabled = false;
  if (result === "code") return codeExpired();
  if (result === "invalid") { status.textContent = "Das Rezept ist unvollständig. Bitte Titel und Inhalt prüfen."; return; }
  /* Fotos in voller Größe passen nicht in den Gerätespeicher. Scheitert das
     Senden, bleibt das Formular deshalb offen, statt einen Entwurf anzulegen,
     der sich nicht mehr vollständig nachsenden ließe. */
  if (result === "failed" && photos.length) {
    status.textContent = "Hat nicht geklappt – bitte gleich nochmal versuchen. Deine Angaben bleiben stehen.";
    return;
  }
  drafts.unshift(draft);
  saveDrafts();
  formDraft = null;
  closeRecipe();
  toast(result === "sent" ? `„${draft.title}“ eingereicht` : "Nicht gesendet – als Entwurf gespeichert");
}

/* Schickt einen Entwurf ab und setzt seinen Status. Rückgabe: "sent",
   "code" (Code falsch), "invalid" (Angaben fehlen) oder "failed" (kein Netz,
   Server nicht erreichbar – der Entwurf bleibt und kann erneut gesendet werden). */
async function sendDraft(draft, code, website = "", photos = []) {
  try {
    const { status } = await api({
      code, website, title: draft.title, category: draft.category,
      servings: draft.servings, time: draft.time, source: draft.source, from: draft.from, note: draft.note,
      imported: draft.imported || "", text: draft.text || "", photos,
      ingredients: draft.ingredients.join("\n"), steps: draft.steps.join("\n"), tips: draft.tips.join("\n"),
    });
    if (status === 403) return "code";
    if (status === 422) return "invalid";
    if (status < 200 || status >= 300) throw new Error(status);
    draft.status = "sent";
    return "sent";
  } catch {
    draft.status = "failed";
    return "failed";
  }
}

function renderDraft(id) {
  const d = drafts.find(x => x.id === id);
  if (!d) return;
  const sheet = $("#sheet");
  sheet.hidden = false;
  sheet.classList.remove("cook");
  sheet.style.setProperty("--accent", accent(d.category));
  const sent = d.status === "sent";
  const when = new Date(d.submittedAt).toLocaleDateString("de-DE", { day: "numeric", month: "long" });
  sheet.innerHTML = `
    <div class="sheet__bar">
      <button class="icon-btn nowrap" data-act="close">←<span class="lbl"> Zurück</span></button>
      <div class="sheet__bar-actions">
        ${sent ? "" : `<button class="ghost-btn nowrap" data-act="resend">Erneut senden</button>`}
        <button class="ghost-btn nowrap" data-act="drop">Entfernen</button>
      </div>
    </div>
    <div class="sheet__wrap">
      <header class="sheet__head">
        <p class="sheet__eyebrow">${esc(d.category)} · ${sent ? `Entwurf vom ${when}, wartet auf Freigabe` : "Entwurf, noch nicht gesendet"}</p>
        <h1 class="sheet__title" id="sheetTitle">${esc(d.title)}</h1>
        <div class="spec">
          ${d.time ? `<div class="spec__cell"><span class="spec__k">Zeit</span><span class="spec__v">${d.time} min</span></div>` : ""}
          ${d.servings ? `<div class="spec__cell"><span class="spec__k">Portionen</span><span class="spec__v">${d.servings}</span></div>` : ""}
          ${d.ingredients.length ? `<div class="spec__cell"><span class="spec__k">Zutaten</span><span class="spec__v">${d.ingredients.length}</span></div>` : ""}
          ${d.source ? `<div class="spec__cell"><span class="spec__k">Quelle</span><span class="spec__v">${esc(d.source)}</span></div>` : ""}
        </div>
        <p class="draft__status" id="draftStatus" role="status"></p>
      </header>
      ${d.photos?.length ? `
      <div class="block">
        <h2 class="block__title">Fotos</h2>
        <div class="draft__photos">${d.photos.map((src, i) => `<img src="${src}" alt="Foto ${i + 1}">`).join("")}</div>
      </div>` : ""}
      ${d.text ? `
      <div class="block">
        <h2 class="block__title">Rezepttext</h2>
        <p class="draft__text">${esc(d.text)}</p>
      </div>` : ""}
      ${d.ingredients.length ? `
      <div class="cols">
        <div class="panel">
          <div class="block">
            <h2 class="block__title">Zutaten</h2>
            <ul class="draft__list">${d.ingredients.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
          </div>
        </div>
        <div>
          <div class="block">
            <h2 class="block__title">Zubereitung</h2>
            <ol class="draft__list draft__list--steps">${d.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
          </div>
          ${d.tips.length ? `<div class="block"><h2 class="block__title">Tipps</h2>
            <div class="tips">${d.tips.map(t => `<p class="tip"><span>${esc(t)}</span></p>`).join("")}</div></div>` : ""}
          ${d.note ? `<div class="block"><h2 class="block__title">Anmerkung</h2><p class="draft__note">${esc(d.note)}</p></div>` : ""}
        </div>
      </div>` : d.note ? `
      <div class="block"><h2 class="block__title">Anmerkung</h2><p class="draft__note">${esc(d.note)}</p></div>` : ""}
    </div>`;

  sheet.onclick = null;
  sheet.querySelectorAll("[data-act]").forEach(b => b.onclick = async () => {
    const a = b.dataset.act;
    if (a === "close") closeRecipe();
    if (a === "drop") {
      const index = drafts.indexOf(d);
      drafts.splice(index, 1);
      saveDrafts();
      closeRecipe();
      toast(`„${d.title}“ entfernt`, "Rückgängig", () => {
        drafts.splice(index, 0, d);
        saveDrafts();
        render();
      });
    }
    if (a === "resend") {
      const code = store.get(CODE_KEY, "");
      const status = sheet.querySelector("#draftStatus");
      b.disabled = true;
      status.textContent = "Wird eingereicht …";
      const result = code ? await sendDraft(d, code) : "code";
      saveDrafts();
      if (result === "sent") { renderDraft(id); toast(`„${d.title}“ eingereicht`); return; }
      b.disabled = false;
      status.textContent = result === "code" ? "Der gespeicherte Zugangscode stimmt nicht mehr. Bitte den Entwurf entfernen und neu einreichen."
        : result === "invalid" ? "Das Rezept ist unvollständig. Bitte entfernen und neu einreichen."
        : "Hat nicht geklappt – bitte später nochmal versuchen.";
    }
  });
  sheet.scrollTop = 0;
}

/* Bereich wechseln. Eigener Hash, damit der Zurück-Knopf des Handys aus dem
   Plan zurück in die Liste führt statt die App zu verlassen. */
function setView(view, skipHistory) {
  state.view = view;
  document.body.classList.toggle("view-plan", view === "plan");
  set("#menuview", n => { n.hidden = view !== "plan"; });
  set("#viewToggle", n => { n.firstChild.nodeValue = view === "plan" ? "Rezepte" : "Essensplan"; });
  // Titel und Knopf hießen im Plan beide "Rezepte" – der Titel sagt, wo man ist.
  set(".topbar__brand", n => { n.textContent = view === "plan" ? "Essensplan" : "Rezepte"; });
  document.querySelectorAll("[data-view]").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  $("#rail")?.classList.remove("open");
  if (!skipHistory) {
    const target = view === "plan" ? "#/plan" : location.pathname + location.search;
    if (location.hash !== (view === "plan" ? "#/plan" : "")) history.pushState({ view }, "", target);
  }
  // Im Plan Eingeplantes trägt in der Liste sofort sein "geplant".
  if (view === "plan") renderMenu(); else render();
  window.scrollTo(0, 0);
}


/* =========================================================================
   Rezeptansicht
   ========================================================================= */
/* Wer beim Kochen kurz in ein anderes Rezept schaut, soll beim Zurückkommen
   seine Haken, Portionen und den Kochmodus wiederfinden. Gilt für die
   Sitzung, nicht dauerhaft – beim nächsten Kochen beginnt alles von vorn. */
const progress = new Map();

function saveProgress() {
  if (!state.open) return;
  progress.set(state.open, {
    servings: state.servings,
    checkedIng: new Set(state.checkedIng),
    checkedStep: new Set(state.checkedStep),
    cook: state.cook,
  });
}

function openRecipe(id) {
  const r = RECIPES.find(x => x.id === id);
  if (!r) return;
  saveProgress();
  const saved = progress.get(id);
  state.open = id;
  state.panel = null;
  state.servings = saved ? saved.servings : (r.servings || 1);
  state.checkedIng = saved ? new Set(saved.checkedIng) : new Set();
  state.checkedStep = saved ? new Set(saved.checkedStep) : new Set();
  state.cook = saved ? saved.cook : false;
  if (state.cook) requestWakeLock();
  document.body.classList.add("locked");
  if (location.hash !== "#/r/" + id) history.pushState({ id }, "", "#/r/" + id);
  renderSheet();
}

function closeRecipe(pop) {
  saveProgress();
  state.open = null;
  state.panel = null;
  $("#sheet").hidden = true;
  $("#sheet").innerHTML = "";
  document.body.classList.remove("locked");
  releaseWakeLock();
  if (!pop) history.pushState({}, "", state.view === "plan" ? "#/plan" : location.pathname + location.search);
  if (state.view === "list") render();
  else renderMenu();
}

function renderSheet() {
  const r = RECIPES.find(x => x.id === state.open);
  if (!r) return;
  const factor = r.servings ? state.servings / r.servings : 1;
  const sheet = $("#sheet");
  sheet.hidden = false;
  sheet.classList.toggle("cook", state.cook);
  sheet.style.setProperty("--accent", accent(r.category));

  const totalSteps = r.stepGroups.reduce((n, g) => n + g.items.length, 0);
  const doneSteps = state.checkedStep.size;

  /* Auf dem Handy passen vier Knöpfe nicht in eine Zeile – die Leiste brach
     zweizeilig um und kostete beim Kochen dauerhaft Platz. Dort bleiben nur
     Zurück und Kochmodus sichtbar, der Rest liegt hinter "⋯". */
  sheet.innerHTML = `
    <div class="sheet__bar">
      <button class="icon-btn nowrap" data-act="close">←<span class="lbl"> Zurück</span></button>
      <div class="sheet__bar-actions">
        <button data-act="cook" class="ghost-btn nowrap" aria-pressed="${state.cook}">Kochmodus${totalSteps ? ` (${doneSteps}/${totalSteps})` : ""}</button>
        <button class="ghost-btn sheet__more" data-act="more" aria-expanded="false" aria-controls="sheetMenu" aria-label="Weitere Aktionen">⋯</button>
        <div class="sheet__menu" id="sheetMenu">
          <button data-act="menu" class="ghost-btn nowrap" aria-pressed="${onMenu(r.id)}">${onMenu(r.id) ? "Im Essensplan ✓" : "Einplanen"}</button>
          <a class="ghost-btn nowrap bring" href="${bringLink(r)}" target="_blank" rel="noopener">In Bring! öffnen</a>
          <button data-act="share" class="ghost-btn nowrap">Teilen</button>
        </div>
      </div>
    </div>
    <div class="sheet__wrap">
      <header class="sheet__head${r.image ? " sheet__head--illustrated" : ""}">
        ${r.image ? `<figure class="sheet__figure"><img src="${esc(r.image)}" alt="" decoding="async"></figure>` : ""}
        <p class="sheet__eyebrow">${esc(r.category)}</p>
        <h1 class="sheet__title" id="sheetTitle">${esc(r.title)}</h1>
        <div class="spec">
          <div class="spec__cell"><span class="spec__k">Zeit</span><span class="spec__v">${r.time} min</span></div>
          <div class="spec__cell"><span class="spec__k">Portionen</span><span class="spec__v">${state.servings}</span></div>
          <div class="spec__cell"><span class="spec__k">Zutaten</span><span class="spec__v">${r.ingredientCount}</span></div>
          ${r.kcal ? `<div class="spec__cell"><span class="spec__k">Energie${
            kcalUnit(r.nutritionNote) ? " je " + esc(kcalUnit(r.nutritionNote)) : ""
          }</span><span class="spec__v">${r.kcal} kcal</span></div>` : ""}
          ${r.source ? `<div class="spec__cell"><span class="spec__k">Quelle</span><span class="spec__v">${esc(r.source)}</span></div>` : ""}
        </div>
        ${(r.tags || []).length ? `<p class="sheet__tags">${r.tags.map(t => `<span>${esc(t)}</span>`).join("")}</p>` : ""}
      </header>

      <!-- Mobil stehen Zutaten und Schritte untereinander; die Zubereitung
           begann erst zwei Bildschirme tiefer. Die Sprungmarken kürzen das ab. -->
      <nav class="jump" aria-label="Abschnitte">
        <button data-jump="ingBlock">Zutaten</button>
        <button data-jump="stepBlock">Zubereitung</button>
        ${r.nutrition.length ? `<button data-jump="nutriBlock">Nährwerte</button>` : ""}
      </nav>

      <div class="cols">
        <div class="panel">
          <div class="block" id="ingBlock">
            <h2 class="block__title">Zutaten</h2>
            <div class="servings">
              <div>
                <div class="servings__label">Portionen</div>
                ${Math.abs(factor - 1) > .01 ? `<div class="factor">alle Mengen ×${fmtQty(factor)}</div>` : ""}
              </div>
              <div class="stepper">
                <button data-act="minus" aria-label="Weniger Portionen" ${state.servings <= 1 ? "disabled" : ""}>−</button>
                <span class="servings__val">${state.servings}</span>
                <button data-act="plus" aria-label="Mehr Portionen" ${state.servings >= 24 ? "disabled" : ""}>+</button>
              </div>
            </div>
            ${(r.ingredientNotes || []).map(n => `<p class="ing-note">${esc(n.replace(/^💡\s*/, ""))}</p>`).join("")}
            ${r.ingredientGroups.map((g, gi) => `
              <div class="igroup">
                ${g.name ? `<div class="igroup__name">${esc(g.name)}</div>` : ""}
                ${g.items.map((it, ii) => {
                  const key = gi + ":" + ii;
                  return `<button class="ing" data-ing="${key}" aria-pressed="${state.checkedIng.has(key)}">
                    <span class="ing__name">${esc(it.name)}</span>
                    <span class="ing__amt">${amountText(it.amount, factor)}</span>
                  </button>`;
                }).join("")}
              </div>`).join("")}
          </div>
        </div>

        <div>
          <div class="block" id="stepBlock">
            <h2 class="block__title">Zubereitung</h2>
            ${r.stepGroups.map((g, gi) => `
              <div class="sgroup">
                ${g.name ? `<div class="sgroup__name">${esc(g.name)}</div>` : ""}
                ${g.items.map((s, ii) => {
                  const key = gi + ":" + ii;
                  return `<button class="step" data-step="${key}" aria-pressed="${state.checkedStep.has(key)}">
                    <span class="step__n"><span>${String(ii + 1).padStart(2, "0")}</span></span>
                    <span class="step__body">${s.label ? `<span class="step__label">${esc(s.label)}</span>` : ""}${stepText(s, factor)}</span>
                  </button>`;
                }).join("")}
              </div>`).join("")}
          </div>

          ${r.tips.length ? `
          <div class="block">
            <h2 class="block__title">Tipps</h2>
            <div class="tips">${r.tips.map(t => `<p class="tip"><span>${esc(t)}</span></p>`).join("")}</div>
          </div>` : ""}

          ${r.nutrition.length ? `
          <div class="block" id="nutriBlock">
            <h2 class="block__title">Nährwerte</h2>
            <table class="nutri">
              ${r.nutritionNote ? `<caption>${esc(r.nutritionNote)}</caption>` : ""}
              <tbody>${r.nutrition.map(n => `<tr><td>${esc(n.label)}</td><td>${esc(n.value)}</td></tr>`).join("")}</tbody>
            </table>
          </div>` : ""}

          <section class="feedback" id="feedback">
            <button class="ghost-btn" data-act="feedback-open">Änderung vorschlagen</button>
            <form class="feedback__form" id="feedbackForm" hidden>
              <p class="feedback__intro">Was stimmt nicht oder fehlt? Geht direkt an Marcel.</p>
              <label class="feedback__field">
                <span>Worum geht es?</span>
                <select name="art">
                  <option>Menge stimmt nicht</option>
                  <option>Schritt ist unklar</option>
                  <option>Zutat fehlt</option>
                  <option>Tipp oder Idee</option>
                  <option>Sonstiges</option>
                </select>
              </label>
              <label class="feedback__field">
                <span>Dein Vorschlag</span>
                <textarea name="nachricht" rows="4" required
                  placeholder="z. B. 300 g Nudeln sind für 2 Portionen zu viel"></textarea>
              </label>
              <label class="feedback__field">
                <span>Von (optional)</span>
                <input type="text" name="von" autocomplete="name">
              </label>
              <input type="text" name="bot-field" tabindex="-1" autocomplete="off" aria-hidden="true" class="feedback__trap">
              <div class="feedback__actions">
                <button type="submit" class="ghost-btn">Abschicken</button>
                <span class="feedback__status" id="feedbackStatus" role="status"></span>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>`;

  const form = sheet.querySelector("#feedbackForm");
  if (form) {
    form.onsubmit = async e => {
      e.preventDefault();
      const status = sheet.querySelector("#feedbackStatus");
      const data = new FormData(form);
      data.append("form-name", "rezept-feedback");
      data.append("rezept", r.title);
      data.append("rezept-id", r.id);
      status.textContent = "Wird gesendet …";
      try {
        const res = await fetch("/", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(data).toString(),
        });
        if (!res.ok) throw new Error(res.status);
        form.reset();
        status.textContent = "Danke, ist angekommen.";
      } catch {
        status.textContent = "Hat nicht geklappt – bitte später nochmal versuchen.";
      }
    };
  }

  sheet.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === "close") closeRecipe();
    if (a === "feedback-open") {
      const f = sheet.querySelector("#feedbackForm");
      f.hidden = !f.hidden;
      b.textContent = f.hidden ? "Änderung vorschlagen" : "Abbrechen";
      if (!f.hidden) f.querySelector("textarea").focus();
    }
    if (a === "cook") { state.cook = !state.cook; state.cook ? requestWakeLock() : releaseWakeLock(); renderSheet(); }
    if (a === "more") {
      const open = sheet.querySelector(".sheet__menu").classList.toggle("open");
      b.setAttribute("aria-expanded", String(open));
    }
    if (a === "share") shareRecipe(r);
    /* Einmal drücken plant ein; ein zweites Mal nimmt den offenen Eintrag
       wieder heraus. Archivierte Einträge bleiben unberührt. */
    if (a === "menu") {
      const open = menu.find(e => !e.cooked && e.recipe === r.id);
      open ? menuRemove(open.id) : menuAdd(r.title, r.id);
      renderMenu();
      b.setAttribute("aria-pressed", String(onMenu(r.id)));
      b.textContent = onMenu(r.id) ? "Im Essensplan ✓" : "Einplanen";
    }
    if (a === "plus" || a === "minus") {
      state.servings = Math.min(24, Math.max(1, state.servings + (a === "plus" ? 1 : -1)));
      renderSheet();
      sheet.querySelectorAll(".ing__amt em, .step__amt").forEach(n => n.classList.add("flash"));
    }
  });
  /* Das Menü hinter "⋯" schließt bei jedem Tipp daneben – und nach jeder
     Aktion darin, damit es nicht offen über dem Rezept stehen bleibt. */
  sheet.onclick = e => {
    const m = sheet.querySelector(".sheet__menu.open");
    if (!m || e.target.closest('[data-act="more"]')) return;
    m.classList.remove("open");
    sheet.querySelector('[data-act="more"]')?.setAttribute("aria-expanded", "false");
  };
  sheet.querySelectorAll("[data-jump]").forEach(b => b.onclick = () => {
    const target = sheet.querySelector("#" + b.dataset.jump);
    const bar = sheet.querySelector(".sheet__bar");
    if (target) sheet.scrollTo({
      top: target.getBoundingClientRect().top + sheet.scrollTop - (bar ? bar.offsetHeight : 0) - 12,
      behavior: "smooth",
    });
  });
  sheet.querySelectorAll("[data-ing]").forEach(b => b.onclick = () => {
    const k = b.dataset.ing;
    state.checkedIng.has(k) ? state.checkedIng.delete(k) : state.checkedIng.add(k);
    b.setAttribute("aria-pressed", String(state.checkedIng.has(k)));
  });
  sheet.querySelectorAll(".step__time").forEach(el => {
    const fire = e => {
      e.stopPropagation();
      e.preventDefault();
      startTimer(Number(el.dataset.seconds), `${timerLabel(el, r)} · ${el.textContent.trim()}`);
      el.classList.add("step__time--running");
    };
    el.onclick = fire;
    el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") fire(e); };
  });

  sheet.querySelectorAll("[data-step]").forEach(b => b.onclick = () => {
    const k = b.dataset.step;
    state.checkedStep.has(k) ? state.checkedStep.delete(k) : state.checkedStep.add(k);
    b.setAttribute("aria-pressed", String(state.checkedStep.has(k)));
    const btn = sheet.querySelector('[data-act="cook"]');
    if (btn && totalSteps) btn.textContent = `Kochmodus (${state.checkedStep.size}/${totalSteps})`;
  });
  sheet.scrollTop = 0;
}

/* =========================================================================
   Kleinkram
   ========================================================================= */

/* Teilen über das Teilen-Menü des Handys; wo es das nicht gibt (Desktop),
   landet der Link in der Zwischenablage. */
async function shareRecipe(r) {
  const url = location.origin + location.pathname + "#/r/" + encodeURIComponent(r.id);
  if (navigator.share) {
    try { await navigator.share({ title: r.title, url }); } catch { /* abgebrochen */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link kopiert");
  } catch {
    toast(url);
  }
}

/* Kurze Meldung am unteren Rand, optional mit einer Aktion ("Rückgängig"). */
let toastTimer;
function toast(message, actionLabel, action) {
  const host = $("#toast");
  if (!host) return;
  clearTimeout(toastTimer);
  host.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ""}`;
  host.hidden = false;
  const btn = host.querySelector("button");
  if (btn) btn.onclick = () => { host.hidden = true; clearTimeout(toastTimer); action(); };
  toastTimer = setTimeout(() => { host.hidden = true; }, actionLabel ? 6000 : 2500);
}


/* =========================================================================
   Küchentimer

   Mehrere Timer gleichzeitig, weil Nudeln und Sauce selten gleich lang
   brauchen. Die Restzeit wird aus dem Zielzeitpunkt berechnet, nicht
   heruntergezählt: Android drosselt Timer im Hintergrund, ein Zähler würde
   nachgehen, ein Zeitstempel nicht.
   Signal bewusst ohne Benachrichtigungs-Berechtigung: Ton, Vibration und
   sichtbare Leiste reichen, wenn das Handy ohnehin in der Küche liegt.
   ========================================================================= */
// Eigene Symbole statt Unicode-Zeichen: Android rendert ▶ und ❙❙ als bunte
// Emoji, was in der schwarzen Leiste fehl am Platz wirkt.
const ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6l8-4.8z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

const timers = [];
let timerTick = null;
let swReady = null;

/* Benachrichtigungen laufen über einen Service Worker, weil Android den
   Notification-Konstruktor in Seiten sperrt. Die Erlaubnis wird erst beim
   ersten Timer erfragt – ein Dialog gleich beim Öffnen der App wäre aufdringlich
   und würde meistens abgelehnt. */
function ensureNotifications() {
  if (!("serviceWorker" in navigator)) return;
  if (!swReady) swReady = navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready)
    .catch(() => null);
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function scheduleNotification(timer) {
  if (!swReady || Notification?.permission !== "granted") return;
  swReady.then(reg => reg?.active?.postMessage({
    type: "timer", id: timer.id, at: timer.endsAt, label: timer.label,
    icon: "bilder/icon-192.png",
  })).catch(() => {});
}

function cancelNotification(id) {
  if (!swReady) return;
  swReady.then(reg => reg?.active?.postMessage({ type: "abbrechen", id })).catch(() => {});
}

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* Lange Rezepttitel kürzen – in der Timerleiste zählt, welcher Timer gemeint
   ist, nicht der vollständige Name. */
function shortTitle(text, max = 22) {
  text = String(text);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim() + "…";
}

/* Ein Timer heißt nach dem, was gerade passiert – nicht nach dem Rezept.
   Laufen zwei Timer im selben Gericht, wäre der Rezeptname zweimal dasselbe.
   Drei Quellen in dieser Reihenfolge: der Titel des Schritts, das Tätigkeitswort
   neben der Zeitangabe, sonst die Schrittnummer. */
const COOK_VERBS = /\b(backen|kochen|köcheln|garen|ziehen|ruhen|rösten|anrösten|braten|anbraten|simmern|marinieren|gehen|quellen|einweichen|abkühlen|grillen|dünsten|anschwitzen|durchziehen|räuchern|einkochen|eindicken|stehen|auftauen|antrocknen|schmelzen)\b/i;

function timerLabel(el, recipe) {
  const step = el.closest(".step");
  const heading = step?.querySelector(".step__label")?.textContent?.trim();
  if (heading) return shortTitle(heading, 24);

  const rest = (step?.textContent || "").split(el.textContent).pop() || "";
  const verb = rest.match(COOK_VERBS);
  if (verb) return verb[1][0].toUpperCase() + verb[1].slice(1).toLowerCase();

  const no = step?.querySelector(".step__n")?.textContent?.trim();
  return no ? `Schritt ${Number(no)}` : shortTitle(recipe.title, 24);
}

function startTimer(seconds, label) {
  if (timers.length >= 4) timers.shift();
  timers.push({
    id: Date.now() + Math.random(), label,
    endsAt: Date.now() + seconds * 1000,
    paused: false, remaining: seconds * 1000, done: false,
  });
  requestWakeLock();
  ensureNotifications();
  scheduleNotification(timers[timers.length - 1]);
  renderTimers();
  if (!timerTick) timerTick = setInterval(renderTimers, 500);
}

function togglePause(id) {
  const t = timers.find(x => x.id === id);
  if (!t || t.done) return;
  if (t.paused) {
    t.endsAt = Date.now() + t.remaining;
    t.paused = false;
    scheduleNotification(t);
  } else {
    t.remaining = Math.max(0, t.endsAt - Date.now());
    t.paused = true;
    cancelNotification(t.id);
  }
  renderTimers();
}

function stopTimer(id) {
  cancelNotification(id);
  const i = timers.findIndex(t => t.id === id);
  if (i > -1) timers.splice(i, 1);
  renderTimers();
  if (!timers.length && timerTick) { clearInterval(timerTick); timerTick = null; releaseWakeLock(); }
}

function alarm() {
  try { navigator.vibrate?.([400, 200, 400, 200, 600]); } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.5, 1].forEach(offset => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.35);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(ctx.currentTime + offset); osc.stop(ctx.currentTime + offset + 0.4);
    });
  } catch {}
}

function renderTimers() {
  const host = $("#timers");
  if (!host) return;
  timers.forEach(t => {
    if (!t.done && !t.paused && t.endsAt - Date.now() <= 0) { t.done = true; alarm(); }
  });
  host.hidden = timers.length === 0;
  // Meldungen ("Rückgängig") rücken über die Timerleiste statt darunter.
  document.documentElement.style.setProperty("--timers-h", host.hidden ? "0px" : host.offsetHeight + 8 + "px");
  host.innerHTML = timers.map(t => {
    const left = (t.paused ? t.remaining : t.endsAt - Date.now()) / 1000;
    return `<div class="timer${t.done ? " timer--done" : ""}${t.paused ? " timer--paused" : ""}">
      <span class="timer__time">${t.done ? "fertig" : fmtClock(left)}</span>
      <span class="timer__label">${esc(t.label)}</span>
      ${t.done ? "" : `<button class="timer__btn" data-pause="${t.id}"
        aria-label="${t.paused ? "Timer fortsetzen" : "Timer anhalten"}">${t.paused ? ICON_PLAY : ICON_PAUSE}</button>`}
      <button class="timer__btn" data-stop="${t.id}" aria-label="Timer löschen">${ICON_CLOSE}</button>
    </div>`;
  }).join("");
  host.querySelectorAll("[data-stop]").forEach(b =>
    b.onclick = () => stopTimer(Number(b.dataset.stop)));
  host.querySelectorAll("[data-pause]").forEach(b =>
    b.onclick = () => togglePause(Number(b.dataset.pause)));
}

let wakeLock = null;
async function requestWakeLock() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch { /* egal */ }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }

/* ---------- Events ---------- */
let searchTimer;
const setQuery = raw => {
  state.q = fold(raw.trim());
  state.terms = state.q.split(/\s+/).filter(Boolean);
  render();
};
$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => setQuery(v), 110);
});
/* Auf dem Handy verdeckt die Tastatur die halbe Seite. Solange das Suchfeld
   aktiv ist, rücken Überschrift und Kategorien weg und die Treffer direkt
   unter das Feld. Enter schließt die Tastatur, damit man die Liste sieht. */
$("#search").addEventListener("focus", () => document.body.classList.add("searching"));
$("#search").addEventListener("blur", () => document.body.classList.remove("searching"));
$("#search").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); setQuery(e.target.value); e.target.blur(); }
  if (e.key === "Escape" && e.target.value) { e.stopPropagation(); e.target.value = ""; setQuery(""); }
});
set("#searchClear", n => n.addEventListener("click", () => {
  const input = $("#search");
  input.value = "";
  setQuery("");
  input.focus();
}));
$("#sort").addEventListener("change", e => { state.sort = e.target.value; render(); });
set("#newRecipe", n => n.addEventListener("click", openForm));
$("#timeRange").addEventListener("input", e => { state.maxTime = +e.target.value; render(); });
set("#viewToggle", n => n.addEventListener("click", () =>
  setView(state.view === "plan" ? "list" : "plan")));
document.querySelectorAll("[data-view]").forEach(b =>
  b.addEventListener("click", () => setView(b.dataset.view)));

/* Ein Feld für beides: Steht im Feld der Titel eines Rezepts, wird es
   verknüpft (Klick im Plan öffnet es). Alles andere landet als freier Text. */
set("#menuAdd", form => form.addEventListener("submit", e => {
  e.preventDefault();
  const input = $("#menuInput");
  const typed = input.value.trim();
  const hit = RECIPES.find(r => fold(r.title) === fold(typed));
  menuAdd(hit ? hit.title : typed, hit ? hit.id : null);
  input.value = "";
  renderMenu();
  input.focus();
}));

$("#filterToggle").addEventListener("click", e => {
  const open = $("#rail").classList.toggle("open");
  e.currentTarget.setAttribute("aria-expanded", String(open));
  renderActiveFilters(sorted(RECIPES.filter(matches)).length);
});
set("#railDone", n => n.addEventListener("click", () => {
  $("#rail").classList.remove("open");
  set("#filterToggle", t => t.setAttribute("aria-expanded", "false"));
  render();
  window.scrollTo(0, 0);
}));

/* Android friert Zeitgeber im Hintergrund ein. Kommt die Seite zurück, wird
   deshalb sofort nachgerechnet: abgelaufene Timer melden sich dann hier, auch
   wenn während der Sperre nichts passiert ist. */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && timers.length) {
    renderTimers();
    if (wakeLock === null) requestWakeLock();
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "/" && document.activeElement !== $("#search")) { e.preventDefault(); $("#search").focus(); }
  if (e.key === "Escape" && (state.open || state.panel)) closeRecipe();
});

/* Adresse → Ansicht: Rezept, Entwurf oder das Formular für ein neues Rezept. */
function openFromHash() {
  const m = location.hash.match(/^#\/r\/(.+)$/);
  if (m) { openRecipe(decodeURIComponent(m[1])); return true; }
  const e = location.hash.match(/^#\/e\/(.+)$/);
  if (e && drafts.some(d => d.id === decodeURIComponent(e[1]))) { openDraft(decodeURIComponent(e[1])); return true; }
  if (location.hash === "#/neu") { openForm(); return true; }
  return false;
}

window.addEventListener("popstate", () => {
  if (openFromHash()) return;
  if (state.open || state.panel) closeRecipe(true);
  setView(location.hash === "#/plan" ? "plan" : "list", true);
});

/* ---------- Start ----------
   Chrome stellt beim Wiederherstellen eines Tabs die Werte von Eingabefeldern
   wieder her – ohne ein Event auszulösen. Sicht und Zustand liefen dadurch
   auseinander. Deshalb beim Aufruf alle Eingaben ausdrücklich auf Standard
   setzen, damit garantiert kein Filter aktiv ist. */
function resetFilters() {
  state.q = ""; state.terms = []; state.cat = null; state.maxTime = 120; state.sort = "title";
  state.tags.clear();
  set("#search", n => { n.value = ""; });
  set("#timeRange", n => { n.value = 120; });
  set("#sort", n => { n.value = "title"; });
}

set("#resetBtn", n => n.addEventListener("click", () => { resetFilters(); render(); }));

resetFilters();
set("#recipeNames", n => {
  n.innerHTML = RECIPES.map(r => `<option value="${esc(r.title)}">`).join("");
});
render();
renderMenu();
setView(location.hash === "#/plan" ? "plan" : "list", true);
openFromHash();

})();
