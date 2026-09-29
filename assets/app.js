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
    r.title, r.category, r.health, r.source, ...(r.tags || []),
    ...r.ingredientGroups.flatMap(g => [g.name, ...g.items.map(i => i.name)]),
    ...r.stepGroups.flatMap(g => [g.name, ...g.items.map(s => s.label + " " + s.text)]),
    ...r.tips
  ].join(" "),
}));
RECIPES.forEach(r => { r.search = fold(r.search); });

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
  cat: null,
  health: new Set(),
  maxTime: 120,
  tags: new Set(),
  planning: false,
  plan: new Set(),
  sort: "title",
  open: null,          // aktuelles Rezept
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
function matches(r) {
  if (state.q && !r.search.includes(state.q)) return false;
  if (state.cat && r.category !== state.cat) return false;
  if (state.health.size && !state.health.has(r.health)) return false;
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
  return [...list].sort(by[state.sort] || by.title);
}

function renderFacets() {
  const cats = [...new Set(RECIPES.map(r => r.category))].sort((a, b) => a.localeCompare(b, "de"));
  const catList = $("#catList");
  if (!catList) return;
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

  const chips = (host, values, chosen) => {
    if (!host) return;
    host.innerHTML = "";
    values.forEach(v => {
      const b = el("button", "chip", esc(v));
      b.setAttribute("aria-pressed", String(chosen.has(v)));
      b.onclick = () => { chosen.has(v) ? chosen.delete(v) : chosen.add(v); render(); };
      host.append(b);
    });
  };
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

  const healths = [...new Set(RECIPES.map(r => r.health))].filter(Boolean);
  chips($("#healthList"), healths, state.health);
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
      ${r.health ? `<span class="card__health">${esc(r.health)}</span>` : ""}
    </div>
    <h3 class="card__title">${esc(r.title)}</h3>
    ${(r.tags || []).length ? `<p class="card__tags">${r.tags.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join("")}</p>` : ""}
    <p class="card__spec">
      <span>${r.time} min</span><span class="card__sep">/</span>
      <span>${r.servings} Port.</span><span class="card__sep">/</span>
      <span>${r.ingredientCount} Zutaten</span>
      ${r.kcal ? `<span class="card__sep">/</span><span>${r.kcal} kcal${
        kcalUnit(r.nutritionNote) ? `<span class="card__per">/${esc(kcalUnit(r.nutritionNote))}</span>` : ""}</span>` : ""}
    </p>`;
  if (state.planning) {
    const planned = state.plan.has(r.id);
    const b = el("button", "plan-btn", planned ? "Geplant ✓" : "+ Planen");
    b.setAttribute("aria-pressed", String(planned));
    b.onclick = e => { e.stopPropagation(); togglePlan(r.id); };
    c.append(b);
    c.classList.toggle("card--planned", planned);
  }
  c.onclick = () => openRecipe(r.id);
  c.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRecipe(r.id); } };
  return c;
}

/* =========================================================================
   Zusammen kochen: Rezepte vorschlagen, die dieselben frischen Zutaten nutzen.
   Gezählt wird nur, was schnell verdirbt – die Liste dazu entsteht in build.py.
   ========================================================================= */
function togglePlan(id) {
  state.plan.has(id) ? state.plan.delete(id) : state.plan.add(id);
  render();
}

function planned() {
  return [...state.plan].map(id => RECIPES.find(r => r.id === id)).filter(Boolean);
}

function planFresh() {
  const set = new Set();
  planned().forEach(r => (r.fresh || []).forEach(f => set.add(f)));
  return [...set].sort((a, b) => a.localeCompare(b, "de"));
}

function suggestions() {
  const wanted = new Set(planFresh());
  if (!wanted.size) return [];
  return RECIPES
    .filter(r => !state.plan.has(r.id))
    .map(r => ({ recipe: r, shared: (r.fresh || []).filter(f => wanted.has(f)) }))
    .filter(x => x.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length ||
                    a.recipe.time - b.recipe.time ||
                    a.recipe.title.localeCompare(b.recipe.title, "de"))
    .slice(0, 6);
}

function renderPlan() {
  const bar = $("#planbar"), sug = $("#suggest");
  if (!bar || !sug) return;
  if (!state.planning || !state.plan.size) {
    bar.hidden = true; sug.hidden = true;
    bar.innerHTML = ""; sug.innerHTML = "";
    return;
  }
  const fresh = planFresh();
  bar.hidden = false;
  bar.innerHTML = `
    <div class="planbar__row">
      <span class="planbar__label">Geplant</span>
      <div class="planbar__items">${planned().map(r =>
        `<button class="planchip" data-drop="${r.id}">${esc(r.title)}<span aria-hidden="true">×</span></button>`).join("")}</div>
      <button class="ghost-btn" data-clear>Auswahl leeren</button>
    </div>
    <p class="planbar__fresh">${fresh.length
      ? `Frisch einzukaufen: ${fresh.map(f => `<span>${esc(f)}</span>`).join("")}`
      : "Diese Auswahl braucht nichts, was schnell verdirbt."}</p>`;
  bar.querySelectorAll("[data-drop]").forEach(b =>
    b.onclick = () => togglePlan(b.dataset.drop));
  bar.querySelector("[data-clear]").onclick = () => { state.plan.clear(); render(); };

  const hits = suggestions();
  sug.hidden = false;
  sug.innerHTML = `<h2 class="suggest__title">Passt dazu</h2>`;
  if (!hits.length) {
    sug.innerHTML += `<p class="suggest__empty">Kein anderes Rezept teilt diese frischen Zutaten.</p>`;
    return;
  }
  const wrap = el("div", "grid");
  hits.forEach(({ recipe, shared }) => {
    const c = card(recipe);
    c.classList.add("card--suggested");
    const note = el("p", "card__shared",
      `teilt ${shared.length}: ${shared.map(f => esc(f)).join(", ")}`);
    c.insertBefore(note, c.querySelector(".card__spec"));
    wrap.append(c);
  });
  sug.append(wrap);
}

function render() {
  renderFacets();
  const list = sorted(RECIPES.filter(matches));
  const grid = $("#grid");
  grid.innerHTML = "";
  list.forEach(r => grid.append(card(r)));
  set("#empty", n => { n.hidden = list.length > 0; });
  set("#count", n => {
    n.textContent = list.length === RECIPES.length
      ? `${list.length} Rezepte`
      : `${list.length} von ${RECIPES.length} Rezepten`;
  });
  set("#timeOut", n => { n.textContent = state.maxTime >= 120 ? "beliebig" : `${state.maxTime} min`; });
  set("#planToggle", n => {
    n.setAttribute("aria-pressed", String(state.planning));
    n.textContent = state.planning ? `Zusammen kochen (${state.plan.size})` : "Zusammen kochen";
  });
  renderPlan();
}


/* =========================================================================
   Rezeptansicht
   ========================================================================= */
function openRecipe(id) {
  const r = RECIPES.find(x => x.id === id);
  if (!r) return;
  state.open = id;
  state.servings = r.servings || 1;
  state.checkedIng = new Set();
  state.checkedStep = new Set();
  state.cook = false;
  document.body.classList.add("locked");
  if (location.hash !== "#/r/" + id) history.pushState({ id }, "", "#/r/" + id);
  renderSheet();
}

function closeRecipe(pop) {
  state.open = null;
  $("#sheet").hidden = true;
  $("#sheet").innerHTML = "";
  document.body.classList.remove("locked");
  releaseWakeLock();
  if (!pop) history.pushState({}, "", location.pathname + location.search);
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

  sheet.innerHTML = `
    <div class="sheet__bar">
      <button class="icon-btn nowrap" data-act="close">←<span class="lbl"> Zurück</span></button>
      <div class="sheet__bar-actions">
        <a class="ghost-btn nowrap bring" href="${bringLink(r)}" target="_blank" rel="noopener">In Bring! öffnen</a>
        <button data-act="cook" class="ghost-btn nowrap" aria-pressed="${state.cook}">Kochmodus${totalSteps ? ` (${doneSteps}/${totalSteps})` : ""}</button>
      </div>
    </div>
    <div class="sheet__wrap">
      <header class="sheet__head${r.image ? " sheet__head--illustrated" : ""}">
        ${r.image ? `<figure class="sheet__figure"><img src="${esc(r.image)}" alt="" decoding="async"></figure>` : ""}
        <p class="sheet__eyebrow">${esc(r.category)}${r.health ? " · " + esc(r.health) : ""}</p>
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

      <div class="cols">
        <div class="panel">
          <div class="block">
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
          <div class="block">
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
          <div class="block">
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
    if (a === "plus" || a === "minus") {
      state.servings = Math.min(24, Math.max(1, state.servings + (a === "plus" ? 1 : -1)));
      renderSheet();
      sheet.querySelectorAll(".ing__amt em, .step__amt").forEach(n => n.classList.add("flash"));
    }
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
$("#search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  const v = fold(e.target.value.trim());
  searchTimer = setTimeout(() => { state.q = v; render(); }, 110);
});
set("#planToggle", n => n.addEventListener("click", () => {
  state.planning = !state.planning;
  if (!state.planning) state.plan.clear();
  render();
}));
$("#sort").addEventListener("change", e => { state.sort = e.target.value; render(); });
$("#timeRange").addEventListener("input", e => { state.maxTime = +e.target.value; render(); });
$("#filterToggle").addEventListener("click", e => {
  const open = $("#rail").classList.toggle("open");
  e.currentTarget.setAttribute("aria-expanded", String(open));
  e.currentTarget.textContent = open ? "Schließen" : "Filter";
});

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
  if (e.key === "Escape" && state.open) closeRecipe();
});

window.addEventListener("popstate", () => {
  const m = location.hash.match(/^#\/r\/(.+)$/);
  if (m) openRecipe(decodeURIComponent(m[1]));
  else if (state.open) closeRecipe(true);
});

/* ---------- Start ----------
   Chrome stellt beim Wiederherstellen eines Tabs die Werte von Eingabefeldern
   wieder her – ohne ein Event auszulösen. Sicht und Zustand liefen dadurch
   auseinander. Deshalb beim Aufruf alle Eingaben ausdrücklich auf Standard
   setzen, damit garantiert kein Filter aktiv ist. */
function resetFilters() {
  state.q = ""; state.cat = null; state.maxTime = 120; state.sort = "title";
  state.health.clear(); state.tags.clear();
  state.planning = false; state.plan.clear();
  set("#search", n => { n.value = ""; });
  set("#timeRange", n => { n.value = 120; });
  set("#sort", n => { n.value = "title"; });
}

set("#resetBtn", n => n.addEventListener("click", () => { resetFilters(); render(); }));

resetFilters();
render();
const initial = location.hash.match(/^#\/r\/(.+)$/);
if (initial) openRecipe(decodeURIComponent(initial[1]));

})();
