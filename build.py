#!/usr/bin/env python3
"""
Liest alle Markdown-Rezepte aus ./recipes und schreibt data/recipes.js
(window.RECIPES = [...]), das vom Frontend ohne Server geladen werden kann.

Aufruf:  python3 build.py
"""
import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "recipes"
OUT = ROOT / "public" / "data" / "recipes.js"

FRACTIONS = {
    "½": 0.5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 0.25, "¾": 0.75,
    "⅕": 0.2, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
}
FRAC_CLASS = "".join(FRACTIONS)
NUM = r"(?:\d+(?:[.,]\d+)?[" + FRAC_CLASS + r"]?|[" + FRAC_CLASS + r"])"
AMOUNT_RE = re.compile(
    r"^\s*(?P<prefix>[^\d~" + FRAC_CLASS + r"]*?)\s*"
    r"~?(?P<a>" + NUM + r")"
    r"(?:\s*[–\-]\s*~?(?P<b>" + NUM + r"))?"
    r"\s*(?P<rest>.*)$"
)
SECTION_KEYS = {
    "zutaten": "ingredients",
    "zubereitung": "steps",
    "tipps": "tips",
    "nährwerte": "nutrition",
}


SLASH_FRACTION = re.compile(r"(?<![\d/,.])(\d{1,2})/(\d{1,2})(?![\d/])")


def normalize_fractions(text):
    """'1/2 TL' meint einen halben Teelöffel, keinen Bereich von 1 bis 2.
    Der Schrägstrich wird deshalb vor dem Parsen in einen Dezimalwert übersetzt."""
    def repl(m):
        num, den = int(m.group(1)), int(m.group(2))
        if den == 0 or num >= den:
            return m.group(0)
        value = num / den
        return f"{value:.3f}".rstrip("0").rstrip(".").replace(".", ",")
    return SLASH_FRACTION.sub(repl, text)


def to_num(tok):
    """'2' -> 2.0 | '½' -> 0.5 | '1½' -> 1.5 | '1,5' -> 1.5"""
    whole = 0.0
    if tok and tok[-1] in FRACTIONS:
        whole = FRACTIONS[tok[-1]]
        tok = tok[:-1]
    if not tok:
        return whole
    return float(tok.replace(",", ".")) + whole


def slugify(text):
    text = text.lower()
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss"),
                 ("ı", "i"), ("ş", "s"), ("ç", "c"), ("ğ", "g")):
        text = text.replace(a, b)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def strip_md(text):
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    return text.strip()


def parse_amount(raw):
    """'2 mittelgroße (~600 g)' -> qty 2, unit 'mittelgroße', note '(~600 g)'"""
    raw = strip_md(raw)
    parsed = normalize_fractions(raw)
    out = {"raw": raw, "prefix": "", "qty": None, "qtyTo": None, "unit": "", "note": ""}
    m = AMOUNT_RE.match(parsed)
    if not m:
        out["unit"] = raw
        return out
    out["prefix"] = m.group("prefix").strip()
    out["qty"] = to_num(m.group("a"))
    if m.group("b"):
        out["qtyTo"] = to_num(m.group("b"))
    rest = m.group("rest").strip()
    note = ""
    pm = re.search(r"\(.*\)$", rest)
    if pm:
        note = pm.group(0)
        rest = rest[: pm.start()].strip()
    out["unit"] = rest
    out["note"] = note
    return out


def split_sections(body):
    sections, current, buf = {}, None, []
    for line in body.splitlines():
        if line.startswith("## "):
            if current:
                sections[current] = buf
            head = strip_md(re.sub(r"[^\w\säöüßÄÖÜ()/,%\.-]", "", line[3:]).strip())
            key = None
            for needle, name in SECTION_KEYS.items():
                if needle in head.lower():
                    key = name
            current = key or slugify(head)
            sections[current] = []
            sections.setdefault("_captions", {})
            cap = re.search(r"\((.+)\)", head)
            sections["_captions"][current] = cap.group(1) if cap else ""
            buf = []
        elif current:
            buf.append(line)
    if current:
        sections[current] = buf
    return sections


def is_table_row(line):
    return line.strip().startswith("|")


def table_cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_ingredients(lines):
    groups, notes, current = [], [], None

    def ensure(name=""):
        nonlocal current
        if current is None or (name and current["name"] != name):
            current = {"name": name, "items": []}
            groups.append(current)
        return current

    for line in lines:
        s = line.strip()
        if not s:
            continue
        if is_table_row(s):
            cells = table_cells(s)
            if set("".join(cells)) <= set("-: "):
                continue
            if len(cells) < 2:
                continue
            left, right = cells[0], cells[1]
            if left.lower() in ("menge", "nährwert") or right.lower() in ("zutat", "menge"):
                continue
            if right == "" and left.startswith("**"):
                current = None
                ensure(strip_md(left).rstrip(":"))
                continue
            ensure()
            current["items"].append({"amount": parse_amount(left), "name": strip_md(right)})
        elif s.startswith(">"):
            note = strip_md(s.lstrip("> ").strip())
            if note:
                notes.append(note)
        elif s.startswith("**"):
            m = re.match(r"^\*\*(.+?):?\*\*:?\s*(.*)$", s)
            if m and m.group(2).strip():
                notes.append(f"{m.group(1).rstrip(':')}: {strip_md(m.group(2))}")
            else:
                current = None
                ensure(strip_md(s).rstrip(":"))
    return [g for g in groups if g["items"]], notes


def parse_steps(lines):
    groups, current = [], None

    def ensure(name=""):
        nonlocal current
        if current is None:
            current = {"name": name, "items": []}
            groups.append(current)
        return current

    for line in lines:
        s = line.strip()
        if not s:
            continue
        m = re.match(r"^\d+\.\s+(.*)$", s)
        if m:
            text = m.group(1)
            label = ""
            lm = re.match(r"^\*\*(.+?):?\*\*:?\s*(.*)$", text)
            if lm and lm.group(2):
                label, text = lm.group(1).rstrip(":"), lm.group(2)
            ensure()["items"].append({"label": label, "text": strip_md(text)})
        elif re.match(r"^\*\*.+\*\*:?$", s):
            current = None
            ensure(strip_md(s).rstrip(":"))
    return [g for g in groups if g["items"]]


def parse_tips(lines):
    return [strip_md(l.strip()[2:]) for l in lines if l.strip().startswith(("- ", "* "))]


def parse_nutrition(lines):
    rows = []
    for line in lines:
        s = line.strip()
        if not is_table_row(s):
            continue
        cells = table_cells(s)
        if len(cells) < 2 or set("".join(cells)) <= set("-: "):
            continue
        if cells[0].lower() in ("", "nährwert") and cells[1].lower() in ("wert", "menge"):
            continue
        rows.append({"label": strip_md(cells[0]), "value": strip_md(cells[1])})
    return rows


# Mengenangaben ohne Zahl – gewollt, keine Fehler
NO_QUANTITY = ("nach Bedarf", "nach Geschmack", "nach Belieben", "etwas", "optional", "")

KNOWN_CATEGORIES = {"Hauptspeise", "Vorspeise", "Backen", "Snack", "Dessert", "Zutat"}
KNOWN_HEALTH = {"Gesund", "Ausgewogen", "Genussrezept"}


def validate(r):
    """Gibt eine Liste von Warnungen zurück – nichts davon bricht den Build ab."""
    w = []
    if not r["time"]:
        w.append("Zubereitungszeit fehlt oder ist 0 – Rezept fällt aus dem Zeitfilter")
    if not r["servings"]:
        w.append("Portionen fehlen – Portionsrechner startet bei 1")
    if r["category"] not in KNOWN_CATEGORIES:
        w.append(f"Kategorie '{r['category']}' ist neu – Farbe in ACCENTS (assets/app.js) ergänzen")
    if r["health"] and r["health"] not in KNOWN_HEALTH:
        w.append(f"Gesundheitswert '{r['health']}' unbekannt – erwartet: {', '.join(KNOWN_HEALTH)}")
    if not r["health"]:
        w.append("Gesundheitswert fehlt – Rezept taucht im Ernährungsfilter nicht auf")
    if not r["ingredientCount"]:
        w.append("keine Zutaten erkannt – Tabellenform '| Menge | Zutat |' prüfen")
    if not r["stepGroups"]:
        w.append("keine Zubereitungsschritte erkannt – nummerierte Liste '1. ...' prüfen")
    if not r["nutrition"]:
        w.append("keine Nährwerte")
    for g in r["ingredientGroups"]:
        for it in g["items"]:
            a = it["amount"]
            if a["qty"] is None and a["unit"] not in NO_QUANTITY:
                w.append(f"Menge '{a['raw']}' bei '{it['name']}' nicht als Zahl lesbar – skaliert nicht mit")
    return w


# --------------------------------------------------------------- Mengen im Text
# Einheiten, die eine Zutatenmenge bezeichnen und deshalb mitskaliert werden.
# Zeit-, Temperatur- und Maßangaben (Minuten, °C, cm, Stufe) fehlen hier bewusst.
UNIT_RE = (r"g|kg|ml|l|EL|TL|Prisen?|Zehen?|Kugeln?|Dosen?|Bund|Handvoll|"
           r"Tassen?|Päckchen|Stängel|Blätter|Blatt")
INLINE_RE = re.compile(
    r"(?<![\w,.])(?P<a>\d+(?:[.,]\d+)?|[" + FRAC_CLASS + r"])"
    r"(?:\s*[–-]\s*(?P<b>\d+(?:[.,]\d+)?|[" + FRAC_CLASS + r"]))?"
    r"\s*(?P<unit>" + UNIT_RE + r")(?![\wäöüÄÖÜ])"
)
TOKEN_STOP = {
    "nach", "bedarf", "geschmack", "frisch", "frische", "frischer", "frisches",
    "gehackt", "gehackte", "gehackter", "gerieben", "geriebene", "geriebener",
    "fein", "feine", "feines", "grob", "grobe", "optional", "etwas", "zum", "zur",
    "oder", "und", "aus", "dem", "der", "die", "das", "mit", "ohne", "pro",
    "gross", "grosse", "klein", "kleine", "mittelgross", "reife", "reifer",
    "abgetropft", "gemahlen", "gemahlener", "bunt", "bunte",
}


def word_tokens(name):
    """Suchbegriffe für eine Zutat – nur das Grundwort, nicht die Beschreibung.

    'Kaltes Leitungswasser'  -> {'leitungswasser'}
    'Crispy Chili-Öl'        -> {'chiliöl'}      ('Crispy' beschreibt nur)
    'Paprika edelsüß'        -> {'paprika'}      (nachgestelltes Adjektiv, klein)

    Regel: das letzte Wort ist das Grundwort. Ist es kleingeschrieben, ist es ein
    nachgestelltes Adjektiv und das Wort davor trägt die Bedeutung. Ohne diese
    Unterscheidung landet in 'Crispy Reis als Basis' die Menge des Chili-Öls."""
    base = re.sub(r"\(.*?\)", " ", name).strip()
    words = re.findall(r"[A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*", base)
    words = [w for w in words if w.lower() not in TOKEN_STOP]
    while len(words) > 1 and words[-1][:1].islower():
        words.pop()
    head = words[-1].lower().replace("-", "") if words else ""
    return {head} if len(head) >= 4 else set()


def token_hit(word, token, loose=False, inject=False):
    """Toleranter Vergleich: Plural, Genitiv und zusammengesetzte Wörter.

    Die Richtung entscheidet: im Deutschen steht der Kopf eines Kompositums hinten.
    'Salz' trifft 'Meersalz' und 'Wasser' trifft 'Leitungswasser' – dort ist das
    gesuchte Wort der Kopf, es geht also um dieselbe Sache. 'Pizza' trifft dagegen
    NICHT 'Pizza-Soße', denn dort ist es nur das Bestimmungswort: die Soße ist eine
    Zutat, die Pizza das Gericht. Genau diese Unterscheidung verhindert, dass in
    'eine Pizza formen' die Menge der Pizza-Soße landet.
    Mit loose=True zählt auch die schwache Richtung – das reicht, um in der Nähe
    einer Zahl überhaupt eine Zutat zu erkennen."""
    if len(word) < 4 or len(token) < 4:
        return False
    if word == token:
        return True
    longer, shorter = (word, token) if len(word) > len(token) else (token, word)
    if longer.startswith(shorter) and len(longer) - len(shorter) <= 3:
        return True          # Plural/Beugung: avocados <-> avocado
    if token.endswith(word):
        return True          # Zutat ist das Kompositum: 'Salz' meint 'Meersalz'
    if word.endswith(token):
        # Umgekehrt ist Vorsicht geboten: 'Salzwasser' im Schritt ist Kochwasser
        # und nicht die Zutat 'heißes Wasser'. Zum Erkennen reicht es, zum
        # Einsetzen einer Menge nicht.
        return not inject
    return loose and longer.startswith(shorter)


# Steht eines dieser Wörter neben einer Menge, ist die Menge pro Stück gemeint
# ('125 g große Patties') und darf nicht mit den Portionen wachsen.
PER_PIECE = re.compile(r"\bà\b|\bje\b|\bpro\b|Patties|Stücke|Teiglinge|Portionen|Bällchen|Kugeln", re.I)


# Zeitangaben, aus denen im Kochmodus ein Timer wird. Bereiche starten mit dem
# unteren Wert – lieber einmal nachschauen als etwas verbrennen lassen.
TIME_RE = re.compile(
    r"(?<![\w])(?P<a>\d+(?:[.,]\d+)?)\s*(?:[–-]\s*(?P<b>\d+(?:[.,]\d+)?))?\s*"
    r"(?P<unit>Sekunden|Sek\.|Minuten|Min\.|Min\b|Stunden|Std\.)"
)
TIME_FACTOR = {"sek": 1, "min": 60, "std": 3600, "stu": 3600}


def time_seconds(value, unit):
    key = unit.lower()[:3]
    return int(value * TIME_FACTOR.get(key, 60))


def annotate_steps(step_groups, ingredient_groups, title=""):
    """Zerlegt jeden Schritt in Text- und Mengenstücke.

    Zwei Fälle:
    - Der Schritt nennt die Menge bereits ('mit 600 ml Wasser') -> Menge wird als
      skalierbares Stück markiert, sofern in der Nähe eine bekannte Zutat steht.
    - Der Schritt nennt nur die Zutat ('Salz hinzugeben') -> die Menge aus der
      Zutatenliste wird davorgesetzt, aber nur bei der ersten Erwähnung im Rezept
      und nur, wenn dort eine echte Zahl steht (kein 'nach Bedarf').
    """
    ingredients = [
        {"tokens": word_tokens(it["name"]), "name": it["name"],
         "amount": it["amount"], "done": False}
        for g in ingredient_groups for it in g["items"]
    ]

    def find_ingredient(word, loose=False):
        """Irgendeine passende Zutat – für die Frage 'steht hier überhaupt eine Zutat'."""
        for ing in ingredients:
            if any(token_hit(word, t, loose) for t in ing["tokens"]):
                return ing
        return None

    def next_unused(word):
        """Die erste noch nicht erwähnte Zutat dieses Namens.

        Sojasauce steht dreimal in der Liste – die zweite Erwähnung im Text meint
        den zweiten Eintrag, nicht wieder den ersten. Passen dagegen mehrere
        VERSCHIEDENE Zutaten ('Tofu' -> Naturtofu und Räuchertofu), bleibt offen,
        welche gemeint ist: dann lieber keine Menge als die falsche."""
        hits = [ing for ing in ingredients
                if not ing["done"] and ing["amount"]["qty"] is not None
                and any(token_hit(word, t, inject=True) for t in ing["tokens"])]
        if not hits:
            return None
        if len({h["name"].lower() for h in hits}) > 1:
            return None
        return hits[0]

    for group in step_groups:
        for step in group["items"]:
            text = normalize_fractions(step["text"])
            step["text"] = text
            spans = []     # (start, end, teil) – was gerendert wird
            claimed = []   # (start, end) – Textbereiche, die schon eine Zutat benennen

            def occupied(start, end):
                """Liegt in diesem Textstück schon eine Menge? Eingefügte Mengen
                haben die Breite null und gehören zum Wort direkt dahinter –
                sonst bekäme 'Paprika edelsüß' zweimal eine Menge davor."""
                for st, e, _ in spans:
                    if st == e:
                        if start <= st <= end:
                            return True
                    elif st < end and start < e:
                        return True
                # Innerhalb eines erkannten Zutatennamens darf kein zweites Mal
                # zugeordnet werden: in 'passierte Tomaten' ist 'Tomaten' bereits
                # vergeben und meint nicht die Kirschtomaten weiter unten.
                return any(st < end and start < e for st, e in claimed)

            # 1. Mengen, die schon im Text stehen
            for m in INLINE_RE.finditer(text):
                tail = text[m.end():m.end() + 60]
                head = text[max(0, m.start() - 40):m.start()]
                # Nicht nur ob, sondern WO die Zutat steht – sie wird später
                # gemeinsam mit der Menge hervorgehoben.
                candidates = [(m.end() + w.start(), m.end() + w.end(), w.group(0))
                              for w in list(re.finditer(r"[A-Za-zäöüßÄÖÜ]+", tail))[:4]]
                head_start = max(0, m.start() - 40)
                candidates += [(head_start + w.start(), head_start + w.end(), w.group(0))
                               for w in list(re.finditer(r"[A-Za-zäöüßÄÖÜ]+", head))[-3:]]
                hit, item_at = None, None
                for start, end, w in candidates:
                    found = find_ingredient(w.lower(), loose=True)
                    if found:
                        hit, item_at = found, (start, end)
                        break
                if not hit:
                    continue
                if PER_PIECE.search(text[max(0, m.start() - 25):m.end() + 25]):
                    continue
                hit["done"] = True
                spans.append((m.start(), m.end(), {
                    "type": "amount",
                    "qty": to_num(m.group("a")),
                    "qtyTo": to_num(m.group("b")) if m.group("b") else None,
                    "unit": m.group("unit"),
                    "added": False,
                }))
                if item_at and not occupied(*item_at):
                    spans.append((item_at[0], item_at[1],
                                  {"type": "item", "value": text[item_at[0]:item_at[1]]}))

            # 2a. Mehrwortige Zutatennamen zuerst: 'Paprika edelsüß' ist eindeutiger
            #     als 'Paprika' und darf den Treffer nicht an die Kurzform verlieren.
            for ing in sorted(ingredients, key=lambda i: -len(i["name"])):
                if ing["done"] or ing["amount"]["qty"] is None:
                    continue
                phrase = re.sub(r"\(.*?\)", "", ing["name"]).strip()
                if len(phrase.split()) < 2:
                    continue
                m = re.search(r"(?<![\wäöüß])" + re.escape(phrase) + r"(?![\wäöüß])",
                              text, re.I)
                if not m or occupied(m.start(), m.end()):
                    continue
                ing["done"] = True
                claimed.append((m.start(), m.end()))
                a = ing["amount"]
                spans.append((m.start(), m.start(), {
                    "type": "amount", "qty": a["qty"], "qtyTo": a["qtyTo"],
                    "unit": a["unit"], "added": True,
                }))
                spans.append((m.start(), m.end(),
                              {"type": "item", "value": text[m.start():m.end()]}))

            # 2b. Zutaten ohne Menge im Text -> Menge ergänzen
            for m in re.finditer(r"[A-Za-zäöüßÄÖÜ]{4,}", text):
                if occupied(m.start(), m.end()):
                    continue
                before = text[max(0, m.start() - 30):m.start()]
                if INLINE_RE.search(before) and len(before.strip()) < 12:
                    continue
                word = m.group(0).lower()
                # Teil eines Kompositums ('Kokos-Sriracha-Sauce') ist kein
                # eigenständiger Zutatenverweis – dort darf nichts eingeschoben werden.
                if text[m.start() - 1:m.start()] == "-" or text[m.end():m.end() + 1] == "-":
                    continue
                hit = next_unused(word)
                if not hit or hit["amount"]["qty"] is None:
                    continue
                # Steht die Einheit schon im Satz ('mit einem Spritzer Zitronensaft'),
                # würde die Ergänzung sie verdoppeln.
                # Wortgrenzen beachten: sonst findet die Einheit 'g' sich in
                # 'gemeinsam' wieder und die Menge fiele stillschweigend weg.
                unit = (hit["amount"]["unit"] or "").strip()
                if unit and re.search(r"(?<![a-zäöüß])" + re.escape(unit) + r"(?![a-zäöüß])",
                                      text[max(0, m.start() - 22):m.start()], re.I):
                    continue
                hit["done"] = True
                a = hit["amount"]
                spans.append((m.start(), m.start(), {
                    "type": "amount",
                    "qty": a["qty"],
                    "qtyTo": a["qtyTo"],
                    "unit": a["unit"],
                    "added": True,
                }))
                spans.append((m.start(), m.end(),
                              {"type": "item", "value": m.group(0)}))

            # 3. Zeitangaben – nur wo noch keine Menge markiert ist
            for m in TIME_RE.finditer(text):
                if occupied(m.start(), m.end()):
                    continue
                seconds = time_seconds(to_num(m.group("a")), m.group("unit"))
                if not 30 <= seconds <= 24 * 3600:
                    continue
                spans.append((m.start(), m.end(), {
                    "type": "time",
                    "seconds": seconds,
                    "value": text[m.start():m.end()],
                }))

            if not spans:
                step["parts"] = [{"type": "text", "value": text}]
                continue

            spans.sort(key=lambda s: (s[0], s[1]))
            parts, cursor = [], 0
            for start, end, piece in spans:
                if start > cursor:
                    parts.append({"type": "text", "value": text[cursor:start]})
                parts.append(piece)
                cursor = end
            if cursor < len(text):
                parts.append({"type": "text", "value": text[cursor:]})
            step["parts"] = parts
    return step_groups


# ------------------------------------------------------------------------ Tags
# Tags kommen aus zwei Quellen: aus dem Feld "Tags" in Notion (kommagetrennt)
# und aus diesen Regeln. Beides wird zusammengeführt.
#
# Jede Regel sagt, WO gesucht wird – das entscheidet über die Trefferqualität:
# ein Gerichttyp steht im Titel oder in den Zutaten, eine Zubereitungsart in den
# Schritten, ein Hinweis auf Vorkochen in den Tipps. Sucht man überall, wird aus
# "schmeckt auch auf Brot" fälschlich ein Brotrezept.
# "min" verlangt mehrere Treffer – eine einzelne Sojasauce macht noch kein
# asiatisches Gericht.
TAG_RULES = {
    "Frühstück":      {"fields": ["title"], "ends": True, "words": ["brot", "brötchen", "quarkstangen", "hüttenkäse"]},
    # "bbq" fehlt bewusst: eine BBQ-Sauce im Ofen ist kein Grillrezept.
    "Grillen":        {"fields": ["steps", "tips"], "words": ["plancha", "angrillen", "grillen", "holzkohle", "gasgrill", "grillrost", "räucherbox", "räuchern", "pizzaofen"]},
    "Ofengericht":    {"fields": ["steps"], "words": ["ofen", "backofen", "backblech", "umluft", "heißluft", "ober-/unterhitze"]},
    "Pfannengericht": {"fields": ["steps"], "words": ["pfanne", "anbraten", "anschwitzen"]},
    "Pasta":          {"fields": ["title", "ingredients"], "words": ["pasta", "nudeln", "ravioli", "tagliatelle", "orzo", "bandnudeln", "spaghetti", "fusilli", "mantı", "manti"]},
    "Burger":         {"fields": ["title", "ingredients"], "words": ["burger", "patty", "patties", "buns"]},
    # Zwei Wege zum Tag: der Titel nennt das Gebäck, oder es steckt ein echter Teig
    # dahinter. Ein Esslöffel Mehl zum Andicken macht aus Patatas Bravas noch
    # kein Brotrezept – deshalb zählt Mehl allein nicht.
    "Brot & Teig":    [{"fields": ["title"], "ends": True, "words": ["brot", "brötchen", "teig", "ciabatta", "buns"]},
                       {"fields": ["ingredients"], "ends": True, "words": ["hefe", "hartweizengrieß", "hartweizengriess"]}],
    "Bowl & Salat":   {"fields": ["title"], "words": ["bowl", "salat", "slaw"]},
    # Vorräte wie Pesto oder Nudelteig halten naturgemäß – das sagt nichts
    # darüber, ob sich eine Mahlzeit vorkochen lässt. Deshalb nicht für "Zutat".
    "Meal Prep":      {"fields": ["tips"], "not_categories": ["Zutat"], "words": ["nächsten tag", "einfrieren", "vorkochen", "vorrat", "hält sich", "am vorabend", "aufgewärmt", "durchgezogen", "vorher zubereiten"]},
    "Italienisch":    {"fields": ["ingredients"], "min": 2, "words": ["mozzarella", "parmesan", "pesto", "ricotta", "ciabatta", "basilikum", "orzo"]},
    "Asiatisch":      {"fields": ["ingredients"], "min": 2, "words": ["sojasauce", "sriracha", "ingwer", "kokosmilch", "edamame", "currypaste", "sesamöl", "reisessig", "mie-nudeln"]},
    "Orientalisch":   {"fields": ["ingredients"], "min": 2, "words": ["kreuzkümmel", "kurkuma", "couscous", "bulgur", "tahini", "granatapfel", "harissa", "ajvar", "cumin"]},
}

# Tierische Zutaten. Fleisch fehlt in dieser Sammlung durchgehend, deshalb wäre
# ein Tag "Vegetarisch" auf allen 30 Rezepten – als Filter wertlos. "Vegan"
# unterscheidet dagegen wirklich.
NOT_VEGAN = ["ei", "eier", "eigelb", "eiweiß", "butter", "milch", "sahne", "quark",
             "joghurt", "käse", "honig", "mozzarella", "parmesan", "feta", "halloumi",
             "ricotta", "brie", "crème", "mayo", "frischkäse", "cheddar", "ziegenfrischkäse",
             "burrata", "mascarpone", "schmand", "creme fraiche", "reibekäse", "hack",
             "hähnchen", "rind", "schwein", "speck", "schinken", "thunfisch", "lachs"]


# Zusammensetzungen, die trotz des Namens pflanzlich sind
VEGAN_ANYWAY = {"erdnussbutter", "kokosmilch", "mandelmilch", "sojamilch", "hafermilch",
                "erdnussmus", "kokosjoghurt", "sojajoghurt", "pflanzenmilch"}


def contains(haystack, needle, ends=False):
    """Wortgrenzen beachten: 'bun' darf nicht in 'Buntes' treffen.
    Mit ends=True zählt auch das Ende eines zusammengesetzten Wortes,
    damit 'brot' in 'Blitzbrot' und 'mehl' in 'Dinkelmehl' greift."""
    head = r"[a-zäöüß]*" if ends else r"(?<![a-zäöüß])"
    return re.search(head + re.escape(needle) + r"(?![a-zäöüß])", haystack) is not None


def has_animal_product(ingredients):
    """Prüft das Grundwort jeder Zutat: 'Magerquark' endet auf Quark und ist damit
    tierisch, 'Erdnussbutter' endet zwar auf Butter, steht aber auf der Ausnahmeliste."""
    for word in re.findall(r"[a-zäöüß]+", ingredients):
        if word in VEGAN_ANYWAY:
            continue
        if any(word == n or word.endswith(n) for n in NOT_VEGAN):
            return True
    return False


def derive_tags(recipe, manual):
    """Manuelle Tags aus Notion plus automatisch erkannte, ohne Dopplungen."""
    ingredients = " ".join(it["name"] for g in recipe["ingredientGroups"]
                           for it in g["items"]).lower()
    fields = {
        "title": recipe["title"].lower(),
        "ingredients": ingredients,
        "steps": " ".join(s["label"] + " " + s["text"]
                          for g in recipe["stepGroups"] for s in g["items"]).lower(),
        "tips": " ".join(recipe["tips"]).lower(),
    }

    tags = list(manual)
    for tag, rules in TAG_RULES.items():
        if tag in tags:
            continue
        for rule in (rules if isinstance(rules, list) else [rules]):
            if recipe["category"] in rule.get("not_categories", []):
                continue
            text = " ".join(fields[f] for f in rule["fields"])
            hits = sum(1 for w in rule["words"] if contains(text, w, rule.get("ends", False)))
            if hits >= rule.get("min", 1):
                tags.append(tag)
                break

    if not has_animal_product(ingredients):
        tags.append("Vegan")
    if recipe["time"] and recipe["time"] <= 30:
        tags.append("Schnell")
    return sorted(set(tags))


# ------------------------------------------------------- Frische Zutaten
# Whitelist statt Ausschlussliste: nur was hier steht, gilt als schnell
# verderblich. Alles andere - Mehl, Nudeln, Kichererbsen, Gewuerze, Konserven -
# ist damit automatisch Vorrat, ohne dass es aufgezaehlt werden muss.
# Links steht der gemeinsame Name, damit Kirschtomaten und Rispentomaten als
# dieselbe Zutat zusammenfinden. Lange haltbares Gemuese (Zwiebel, Knoblauch,
# Moehre, Kuerbis, Kartoffel) fehlt bewusst: es zwingt zu nichts.
FRESH_INGREDIENTS = {
    "Tomaten": ["tomate", "tomaten", "kirschtomaten", "cherrytomaten", "rispentomaten"],
    "Gurke": ["gurke", "salatgurke"],
    "Avocado": ["avocado", "avocados"],
    "Zitrone": ["zitrone", "zitronensaft"],
    "Limette": ["limette", "limettensaft"],
    "Granatapfel": ["granatapfel", "granatapfelkerne"],
    "Mango": ["mango"],
    "Pfirsich": ["pfirsich", "pfirsiche"],
    "Minze": ["minze"],
    "Petersilie": ["petersilie"],
    "Basilikum": ["basilikum", "basilikumblaetter"],
    "Koriander": ["koriander"],
    "Dill": ["dill"],
    "Thymian": ["thymian"],
    "Rosmarin": ["rosmarin"],
    "Schnittlauch": ["schnittlauch"],
    "Fruehlingszwiebeln": ["fruehlingszwiebel", "fruehlingszwiebeln"],
    "Blattsalat": ["babyspinat", "spinat", "rucola", "feldsalat"],
    "Paprika": ["paprika"],
    "Chili": ["chilischote", "jalapeno"],
    "Zucchini": ["zucchini"],
    "Blumenkohl": ["blumenkohl"],
    "Weisskohl": ["weisskohl", "spitzkohl"],
    "Pilze": ["austernpilze", "champignons", "kraeuterseitlinge"],
    "Ingwer": ["ingwer"],
    "Mozzarella": ["mozzarella", "bueffelmozzarella"],
    "Burrata": ["burrata"],
    "Feta": ["feta"],
    "Halloumi": ["halloumi"],
    "Ricotta": ["ricotta"],
    "Brie": ["brie"],
    "Frischkaese": ["frischkaese", "huettenkaese"],
    "Joghurt": ["joghurt", "skyr"],
    "Quark": ["quark"],
    "Sahne": ["sahne", "schmand", "fraiche"],
    "Milch": ["milch"],
    "Eier": ["ei", "eier", "eigelb", "eiweiss"],
    "Tofu": ["tofu"],
}

# Diese Zusaetze machen aus einer frischen Zutat ein Vorratsprodukt
PRESERVED = ["getrocknet", "tk", "gefroren", "dose", "passiert", "stueckige",
             "mark", "pulver", "sirup", "essig", "gewuerzgurke", "mandelmilch",
             "kokosmilch", "pflanzenmilch", "sojamilch", "hafermilch", "paniermehl",
             "pankomehl", "sauce", "sosse"]


def _fold(text):
    text = text.lower()
    for a, b in (("ae", "ae"), ("\u00e4", "ae"), ("\u00f6", "oe"),
                 ("\u00fc", "ue"), ("\u00df", "ss")):
        text = text.replace(a, b)
    return text


def fresh_ingredients(ingredient_groups):
    """Welche schnell verderblichen Zutaten kommen im Rezept vor?"""
    found = []
    for g in ingredient_groups:
        for it in g["items"]:
            name = _fold(it["name"])
            if any(p in name for p in PRESERVED):
                continue
            # Klammerzusätze zählen nicht mit: 'vgl. Eiernudelteig' ist ein
            # Verweis auf ein anderes Rezept, keine Zutat dieses Rezepts.
            words = re.findall(r"[a-z]+(?:-[a-z]+)*", re.sub(r"\(.*?\)", " ", name))
            for canonical, patterns in FRESH_INGREDIENTS.items():
                if canonical in found:
                    continue
                for word in words:
                    word = word.replace("-", "")
                    # Plural mitdenken: 'Bio-Zitronen' meint dieselbe Zitrone
                    # Plural mitdenken, jede Endung einzeln prüfen:
                    # 'Bio-Zitronen' ohne 'n' ergibt 'biozitrone' und trifft.
                    forms = {word} | {word[:-len(e)] for e in ("en", "n", "s")
                                      if word.endswith(e)}
                    # Kurze Stichwörter nur exakt vergleichen – sonst fände
                    # 'ei' sich in 'fein' wieder und Parmesan enthielte Eier.
                    if any(w == pat or (len(pat) >= 4 and w.endswith(pat)
                                        and len(w) - len(pat) <= 8)
                           for w in forms for pat in patterns):
                        found.append(canonical)
                        break
    return sorted(found)


# ------------------------------------------------------------------- Bilder
IMAGE_DIR = ROOT / "public" / "bilder"
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".avif")


def find_image(recipe_id):
    """Sucht public/bilder/<rezept-id>.<endung>.

    Der Dateiname ist die Rezept-ID – dieselbe, die auch in der URL steht.
    Damit braucht es keine Zuordnungstabelle: Bild ablegen genügt.
    An die URL kommt ein Hash des Inhalts, damit ein ausgetauschtes Bild
    nicht aus dem Browser-Cache kommt.
    """
    for suffix in IMAGE_SUFFIXES:
        path = IMAGE_DIR / f"{recipe_id}{suffix}"
        if path.exists():
            digest = hashlib.sha1(path.read_bytes()).hexdigest()[:8]
            return f"bilder/{path.name}?v={digest}"
    return ""


def parse_file(path):
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()
    title = next((l[2:].strip() for l in lines if l.startswith("# ")), path.stem)
    start = lines.index("# " + title) + 1 if "# " + title in lines else 0

    meta, i = {}, start
    while i < len(lines) and not lines[i].startswith("## "):
        m = re.match(r"^([A-Za-zÄÖÜäöüß ]+):\s*(.+)$", lines[i].strip())
        if m:
            meta[m.group(1).strip()] = m.group(2).strip()
        i += 1

    sections = split_sections("\n".join(lines[i:]))
    caps = sections.get("_captions", {})
    health = meta.get("Gesundheitswert", "")

    kcal = None
    for row in parse_nutrition(sections.get("nutrition", [])):
        if "kalorien" in row["label"].lower() or "energie" in row["label"].lower():
            m = re.search(r"(\d+)", row["value"])
            if m:
                kcal = int(m.group(1))

    ingredients, ing_notes = parse_ingredients(sections.get("ingredients", []))
    recipe = {
        "id": slugify(title),
        "title": title,
        "category": meta.get("Kategorie", "Sonstiges"),
        "health": re.sub(r"^[^\w]+", "", health).strip(),
        "healthIcon": health.split(" ")[0] if health else "",
        "servings": int(re.sub(r"\D", "", meta.get("Portionen", "0")) or 0),
        "time": int(re.sub(r"\D", "", meta.get("Zubereitungszeit", "0")) or 0),
        "source": meta.get("Quelle", ""),
        "kcal": kcal,
        "ingredientGroups": ingredients,
        "ingredientNotes": ing_notes,
        "ingredientCount": sum(len(g["items"]) for g in ingredients),
        "stepGroups": annotate_steps(parse_steps(sections.get("steps", [])), ingredients, title),
        "tips": parse_tips(sections.get("tips", [])),
        "nutrition": parse_nutrition(sections.get("nutrition", [])),
        "nutritionNote": caps.get("nutrition", ""),
        "file": path.name,
        "fresh": fresh_ingredients(ingredients),
    }
    recipe["image"] = find_image(recipe["id"])
    manual = [t.strip() for t in re.split(r"[,;]", meta.get("Tags", "")) if t.strip()]
    recipe["tags"] = derive_tags(recipe, manual)
    return recipe


def iso_duration(minutes):
    return f"PT{int(minutes)}M" if minutes else ""


def ingredient_line(item):
    """'1000 g Mehl' – so, wie Bring! eine Zutatenzeile erwartet."""
    a = item["amount"]
    parts = []
    if a["prefix"]:
        parts.append(a["prefix"])
    if a["qty"] is not None:
        q = a["qty"]
        num = str(int(q)) if float(q).is_integer() else str(q).replace(".", ",")
        if a["qtyTo"] is not None:
            t = a["qtyTo"]
            num += "-" + (str(int(t)) if float(t).is_integer() else str(t).replace(".", ","))
        parts.append(num)
    if a["unit"] and a["unit"] not in NO_QUANTITY:
        parts.append(a["unit"])
    parts.append(item["name"])
    return " ".join(parts)


def write_recipe_pages(recipes):
    """Erzeugt pro Rezept eine eigene Seite mit schema.org-Auszeichnung.

    Bring! ruft beim Import die URL serverseitig ab und liest dort das Rezept aus –
    die App selbst kann es nicht liefern, weil ihre Inhalte erst im Browser
    entstehen. Diese Seiten sind die maschinenlesbare Fassung dafür und leiten
    Besucher direkt in die App weiter.
    """
    out = ROOT / "public" / "rezept"
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.html"):
        f.unlink()

    for r in recipes:
        items = [it for g in r["ingredientGroups"] for it in g["items"]]
        data = {
            "@context": "https://schema.org",
            "@type": "Recipe",
            "name": r["title"],
            "author": {"@type": "Person", "name": r["source"] or "Private Sammlung"},
            "recipeCategory": r["category"],
            "recipeYield": f"{r['servings']} Portionen" if r["servings"] else "",
            "totalTime": iso_duration(r["time"]),
            "recipeIngredient": [ingredient_line(it) for it in items],
            "recipeInstructions": [
                {"@type": "HowToStep", "text": (s["label"] + ": " if s["label"] else "") + s["text"]}
                for g in r["stepGroups"] for s in g["items"]
            ],
        }
        if r.get("image"):
            data["image"] = "../" + r["image"].split("?")[0]
        if r["kcal"]:
            data["nutrition"] = {"@type": "NutritionInformation",
                                 "calories": f"{r['kcal']} kcal"}
        data = {k: v for k, v in data.items() if v}

        html = f"""<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc_html(r['title'])}</title>
<link rel="canonical" href="../#/r/{r['id']}">
<script type="application/ld+json">
{json.dumps(data, ensure_ascii=False, indent=1)}
</script>
<style>
 body {{ font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto;
        padding: 0 1.5rem; line-height: 1.6; color: #141A15; background: #E8EBE3; }}
 h1 {{ line-height: 1.1; }} li {{ margin: .2rem 0; }}
 a {{ color: #2F5D45; }}
</style>
</head>
<body>
<h1>{esc_html(r['title'])}</h1>
<p>{r['servings']} Portionen · {r['time']} Minuten</p>
<h2>Zutaten</h2>
<ul>{"".join(f"<li>{esc_html(line)}</li>" for line in data["recipeIngredient"])}</ul>
<h2>Zubereitung</h2>
<ol>{"".join(f"<li>{esc_html(s['text'])}</li>" for s in data.get("recipeInstructions", []))}</ol>
<p><a href="../#/r/{r['id']}">Rezept in der App öffnen</a></p>
</body>
</html>
"""
        (out / f"{r['id']}.html").write_text(html, encoding="utf-8")
    return len(recipes)


def esc_html(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def stamp_assets():
    """Hängt an CSS, JS und Daten einen Hash ihres Inhalts als ?v= an.

    Ohne das behält ein Browser die alte assets/app.js bis zu einer Stunde im
    Cache, bekommt aber sofort das neue index.html – neues HTML trifft dann auf
    altes JavaScript, das nach Elementen sucht, die es nicht mehr gibt, und die
    Seite bleibt leer. Mit Hash ändert sich die URL bei jeder Änderung, der
    Browser lädt zwingend neu, und unveränderte Dateien bleiben im Cache.
    """
    index = ROOT / "public" / "index.html"
    html = index.read_text(encoding="utf-8")
    for rel in ("assets/style.css", "assets/app.js", "data/recipes.js"):
        path = ROOT / "public" / rel
        if not path.exists():
            continue
        digest = hashlib.sha1(path.read_bytes()).hexdigest()[:10]
        html = re.sub(re.escape(rel) + r'(\?v=[0-9a-f]+)?', f"{rel}?v={digest}", html)
    index.write_text(html, encoding="utf-8")
    return True


def main():
    strict = "--strict" in os.sys.argv
    recipes = [parse_file(p) for p in sorted(SRC.glob("*.md"))]
    recipes.sort(key=lambda r: r["title"].lower())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(recipes, ensure_ascii=False, indent=1)
    OUT.write_text(
        "// Automatisch erzeugt von build.py – nicht manuell bearbeiten.\n"
        f"window.RECIPES = {payload};\n",
        encoding="utf-8",
    )
    (OUT.parent / "recipes.json").write_text(payload, encoding="utf-8")
    pages = write_recipe_pages(recipes)
    stamp_assets()
    print(f"{len(recipes)} Rezepte -> {OUT.relative_to(ROOT)}")
    print(f"{pages} Rezeptseiten für den Bring!-Import -> public/rezept/\n")

    issues = 0
    for r in recipes:
        warnings = validate(r)
        flag = "!" if warnings else " "
        print(f"{flag} {r['title'][:38]:40s} {r['category'][:12]:13s} "
              f"{r['ingredientCount']:2d} Zutaten  "
              f"{sum(len(g['items']) for g in r['stepGroups']):2d} Schritte  "
              f"{len(r['tips'])} Tipps  {len(r['nutrition'])} Nährwerte")
        for msg in warnings:
            print(f"    → {msg}")
            issues += 1

    if issues:
        print(f"\n{issues} Hinweise. Rezepte funktionieren trotzdem, "
              f"nur eingeschränkt filter- oder skalierbar.")
        if strict:
            raise SystemExit(1)
    else:
        print("\nAlle Rezepte vollständig.")


if __name__ == "__main__":
    main()
