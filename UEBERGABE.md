# Rezepte-App — Übergabe und Projektwissen

Stand: 50 Rezepte, live unter `rezepteheft.netlify.app`.

Dieses Dokument richtet sich an jemanden, der das Projekt zum ersten Mal sieht
und daran weiterarbeiten soll. Es beschreibt nicht nur *was* gebaut ist, sondern
*warum* es so gebaut ist — die meisten Eigenheiten sind Reaktionen auf konkrete
Fehler, die ohne Erklärung wie Willkür aussehen und beim Aufräumen versehentlich
zurückgebaut würden.

---

## 1. Was das ist

Eine private Rezeptsammlung als statische Website. Kein Backend, keine
Datenbank, keine Build-Tools, keine Abhängigkeiten außer der
Python-Standardbibliothek. Quelle der Rezepte sind die Markdown-Dateien in
`recipes/` im Repository; daraus entstehen die Daten fürs Frontend.

Es gab früher einen Notion-Sync (`sync_notion.py`), der die Dateien aus einer
Notion-Datenbank erzeugt hat. Er wurde bewusst entfernt: Inzwischen stecken in
den Markdown-Dateien viele Korrekturen, die in Notion nie nachgetragen wurden –
Tags, entfernte Gerätemarken, ergänzte Nährwerte, korrigierte Portionsangaben.
Ein Sync hätte sie beim nächsten Build überschrieben. Das Repository ist damit
die alleinige Quelle.

Zielgruppe sind Endnutzer in der Küche, nicht Entwickler. Deshalb tauchen im
Interface keine Dateinamen, Formathinweise oder technischen Begriffe auf.

## 2. Datenfluss

```
recipes/*.md              ← Quelle der Wahrheit
      │  build.py         (Parser, Regeln, Anreicherung)
      ▼
public/data/recipes.js    ← window.RECIPES, vom Frontend direkt geladen
public/data/recipes.json  ← dasselbe als JSON, für Auswertungen
public/rezept/<id>.html   ← je Rezept eine Seite mit schema.org-Markup für Bring!
      │
      ▼
public/index.html + assets/  ← die eigentliche App
```

Ein Rezept ändern heißt: Markdown-Datei bearbeiten, `python3 build.py` laufen
lassen, committen, pushen.

## 3. Dateien

| Datei | Zweck |
| --- | --- |
| `build.py` | Parser und Regelwerk. Erzeugt Daten, Bring!-Seiten und Cache-Hashes. ~900 Zeilen, der inhaltliche Kern des Projekts |
| `public/index.html` | Statisches Grundgerüst, alles Weitere rendert JavaScript |
| `public/assets/app.js` | Filter, Suche, Rezeptansicht, Portionsrechner, Planungsmodus, Feedback |
| `public/assets/style.css` | Design-Tokens und Layout |
| `netlify.toml` | Build-Befehl, Cache-Header |
| `recipes/*.md` | Die Rezepte |
| `.env.example`, `sync.sh` | Lokaler Sync-Komfort |

## 4. Format der Rezeptdateien

Siehe den separaten Skill `rezept-erstellen` — dort steht die vollständige
Spezifikation inklusive Vorlage, Beispiel und Checkliste. Kurzfassung:

```markdown
# Titel

Gesundheitswert: ⚖️ Ausgewogen      # 🥦 Gesund | ⚖️ Ausgewogen | 🍰 Genussrezept
Kategorie: Hauptspeise              # Hauptspeise|Vorspeise|Backen|Snack|Dessert|Zutat
Portionen: 2
Quelle: Rezeptheft
Tags: Italienisch, Pasta
Zubereitungszeit: 30

## 🛒 Zutaten      (Tabelle | Menge | Zutat |, optional Gruppen via **Name:**)
## 👨‍🍳 Zubereitung (nummerierte Liste, optional **Label:** je Schritt)
## 💡 Tipps        (Aufzählung)
## 📊 Nährwerte (pro Portion)
```

Ein Feld `Schwierigkeitsgrad` gab es früher, es wurde bewusst entfernt.

## 5. Was build.py macht — und warum

### 5.1 Mengen parsen

`parse_amount()` zerlegt „2 mittelgroße (~600 g)" in Präfix, Zahl, Bereich,
Einheit und Klammernotiz. Versteht Unicode-Brüche (`½`), Schrägstrich-Brüche
(`1/2`), gemischte (`1½`), Bereiche (`3–4 EL`) und Text vor der Zahl („Saft von
½–1").

**Learning:** `1/2` wurde anfangs als Bereich „1 bis 2" gelesen — beim
Hokkaido-Salat hätte das die vierfache Menge Paprikapulver ergeben. Deshalb
übersetzt `normalize_fractions()` Schrägstrich-Brüche vor dem Parsen in
Dezimalwerte, und `/` ist kein Bereichstrenner mehr.

### 5.2 Mengen im Fließtext (`annotate_steps`)

Das aufwendigste Stück. Es verknüpft Zutatenliste und Zubereitung, sodass in den
Schritten „**25 g Salz** hinzugeben" steht und beides mit dem Portionsregler
mitwächst. Zwei Fälle: Menge steht schon im Text (wird markiert) oder fehlt
(wird aus der Liste ergänzt, nur bei der ersten Erwähnung im Rezept).

Die Regeln darin sind allesamt Antworten auf echte Fehler:

| Regel | Ausgelöst durch |
| --- | --- |
| Richtungsabhängiger Wortvergleich: `Salz`→`Meersalz` ja, `Pizza`→`Pizza-Soße` nein | „eine 2 EL Pizza formen" |
| Beim Einsetzen zusätzlich: `Salzwasser` meint nicht die Zutat `Wasser` | „in kochendem ½ Glas Salzwasser garen" |
| Gleiche Zutat mehrfach in der Liste → zweite Erwähnung bekommt zweiten Eintrag | Sojasauce steht dreimal, nur die erste wurde gefunden |
| Mehrere *verschiedene* Treffer → gar keine Menge | „Tofu" bei Natur- und Räuchertofu |
| Voller Name schlägt Kurzform | „Paprika edelsüß" vs. Paprikaschote |
| Innerhalb eines erkannten Namens nicht erneut zuordnen | „passierte 1 Handvoll Tomaten" |
| Beschreibende Wörter zählen nicht als Zutat (nur das Grundwort) | „1 EL Crispy Reis als Basis" |
| Keine Einfügung an Bindestrichen | „Kokos-1–2 TL Sriracha-Sauce" |
| Einheit schon im Satz → keine Verdopplung, mit Wortgrenze geprüft | „einem Spritzer 1 Spritzer Zitronensaft"; ohne Wortgrenze verschwand „15 **g** Olivenöl" wegen „**g**emeinsam" |
| Mengen pro Stück (`à`, `je`, `pro`, `Patties`, …) skalieren nicht | „125 g große Patties" wurde zu 250 g |
| Zeiten, Temperaturen, Stufen bleiben unberührt | Einheitenliste `UNIT_RE` enthält bewusst kein `Minuten`, `°C`, `cm` |

Ergebnis heute: 326 verknüpfte Mengen über 50 Rezepte, ohne bekannte Fehlzuordnung.

Im Frontend werden **Menge und Zutat gemeinsam** hervorgehoben — gleiche Schrift
wie der Fließtext, fett, safranfarben unterlegt. Das war eine bewusste Abkehr
von der früheren Mono-Schrift: Beim Kochen sucht das Auge beides zusammen.

### 5.3 Tags (`derive_tags`)

14 Tags, abgeleitet aus Titel, Zutaten, Schritten und Tipps. Jede Regel legt
fest, **wo** gesucht wird — Gerichttyp im Titel/den Zutaten, Zubereitungsart in
den Schritten, Vorkoch-Hinweise in den Tipps. Küchenrichtungen verlangen zwei
Treffer.

**Learnings:**
- Ohne Feldbegrenzung wurde aus dem Tipp „schmeckt auch auf Brot" ein Brotrezept.
- Ohne Wortgrenzen traf „bun" das Wort „**Bun**tes Ofengemüse".
- `Vegetarisch` wurde gestrichen: Die Sammlung ist durchgehend fleischlos, der
  Tag träfe alle 50 Rezepte und filtert damit nichts. `Vegan` prüft stattdessen
  das Grundwort jeder Zutat — erkennt Magerquark als tierisch, Erdnussbutter
  trotz des Namens als pflanzlich (Ausnahmeliste `VEGAN_ANYWAY`).
- `Meal Prep` gilt nicht für die Kategorie `Zutat`: Dass ein Pesto haltbar ist,
  sagt nichts über Vorkochen einer Mahlzeit.
- `BBQ` ist kein Grillsignal (BBQ-Sauce im Ofen), `EARL`/`FAT TONY` wurden mit
  den Gerätemarken entfernt und durch Gasgrill, Grillrost, Räucherbox ersetzt.

**Wichtig:** Manuelle `Tags:`-Zeilen in den Dateien gewinnen gegen die
Automatik. Nach einer Regeländerung müssen die Zeilen neu erzeugt werden, sonst
passiert scheinbar nichts. Das ist schon zweimal passiert.

### 5.4 Frische Zutaten (`fresh_ingredients`)

Grundlage für den Modus „Zusammen kochen". **Whitelist** statt Ausschlussliste:
Nur was in `FRESH_INGREDIENTS` steht, gilt als schnell verderblich — Mehl,
Nudeln, Kichererbsen, Gewürze und Konserven müssen deshalb nirgends aufgezählt
werden. Links steht ein gemeinsamer Name, damit Kirschtomaten, Cherrytomaten und
Rispentomaten zusammenfinden. `PRESERVED` zieht Treffer wieder ab, bei denen ein
Zusatz die Haltbarkeit ändert (getrocknete Tomaten, TK-Edamame, Tomatenmark,
Paprikapulver, Gewürzgurken, Kokosmilch).

**Bewusst nicht enthalten:** Zwiebel, Knoblauch, Möhre, Kürbis, Kartoffel,
Süßkartoffel. Sie halten Wochen und würden fast jedes Rezept mit fast jedem
verbinden — die Vorschläge wären beliebig.

**Learnings:** „Bio-Zitronen" wurde nicht erkannt, weil der Plural fehlte
(jede Endung wird jetzt einzeln geprüft). Und „Parmesan, fein gerieben" galt als
Ei, weil das Kürzel „ei" in „f**ei**n" traf — Stichwörter unter vier Zeichen
werden nur noch exakt verglichen.

### 5.5 Validierung

`build.py` meldet fehlende Angaben, unbekannte Kategorien und nicht skalierbare
Mengen. Die Hinweise brechen den Build **nicht** ab; `--strict` erzwingt einen
Abbruch. Aktuell ist genau ein Hinweis offen (siehe Abschnitt 9).

### 5.6 Cache-Hashes (`stamp_assets`)

Hängt an CSS, JS und Daten einen Inhalts-Hash als `?v=...` und trägt ihn in
`index.html` ein.

**Warum:** Netlify liefert HTML immer frisch, Assets aber gecacht. Ohne Hash
bleibt die URL bei jedem Deploy gleich — ein Gerät bekam neues HTML und behielt
die alte `app.js`, die nach inzwischen entfernten Elementen suchte, mit einem
Fehler abbrach und eine leere Rezeptliste hinterließ. Cache-Leeren im Browser
half nicht, weil der Tab aus der Sitzung wiederhergestellt wurde. Genau dieser
Fall ist auf einem Pixel 9 aufgetreten und war von außen nicht als Cache-Problem
erkennbar.

## 6. Das Frontend

Ein einziges IIFE in `app.js`, kein Framework, kein Build-Schritt. Zustand in
einem `state`-Objekt, alles rendert aus `RECIPES`.

### Funktionen

- **Suche** über Titel, Kategorie, Tags, Zutaten, Schritte, Tipps
- **Kategorie-Schnellfilter** als Chips direkt unter der Suche
- **Seitenleiste** mit Tags, Ernährung, Zeit-Regler, Zurücksetzen
- **Sortierung** A–Z, Zeit, Kalorien, Anzahl Zutaten
- **Rezeptansicht** als Vollbild-Sheet mit eigener URL (`#/r/<id>`)
- **Portionsregler**, der Zutatenliste *und* Fließtext live umrechnet
- **Kochmodus**: größere Schrift, abhakbare Schritte, Display bleibt an (Wake Lock)
- **Zusammen kochen**: Rezepte markieren, gemeinsame frische Zutaten sehen,
  Vorschläge nach Überschneidung sortiert
- **Bring!-Import** je Rezept
- **Änderungsvorschlag** je Rezept über Netlify Forms

### Entfernt (nicht versehentlich, sondern auf Wunsch)

Einkaufsliste, Favoriten/Merken, „Überrasch mich", Aufwand/Schwierigkeitsgrad,
Statistikzeile auf der Startseite, Dateiname unter dem Rezept, Entwicklerhinweis
in der Seitenleiste. Nicht wieder einbauen ohne Rückfrage.

### Robustheit beim Start

`resetFilters()` läuft vor dem ersten Render und setzt alle Eingaben auf
Standard — Chrome stellt beim Wiederherstellen eines Tabs alte Feldwerte
zurück, ohne ein Event auszulösen, wodurch Anzeige und Zustand auseinanderliefen.
Der Zugriff auf einzelne Bedienelemente läuft über einen `set()`-Helfer, damit
ein fehlendes Element nie die ganze Liste verschwinden lässt.

### Design

Bewusst kein generisches Food-Blog-Aussehen. Porzellanfarbener Grund (`#E8EBE3`),
grünschwarze Schrift, Safran als Akzent, Basilikum und Pflaume für Kategorien.
Drei Schriften mit klarer Aufgabenteilung: Bricolage Grotesque für Titel,
Newsreader für Lesetext, IBM Plex Mono für Metadaten. Keine Bilder — die
Sammlung hat keine, und leere Platzhalter sähen schlechter aus als eine
typografische Lösung.

## 7. Bring!-Import

Bring! importiert **Rezepte**, keine Listen, und holt sie serverseitig von einer
öffentlichen URL. Deshalb erzeugt `build.py` zu jedem Rezept eine Seite unter
`public/rezept/<id>.html` mit schema.org-Auszeichnung. Der Button ruft
`api.getbring.com/rest/bringrecipes/deeplink` mit `url`, `source=web`,
`baseQuantity` und `requestedQuantity` auf — Bring rechnet die Mengen anhand der
eingestellten Portionszahl selbst um.

Funktioniert nur auf der öffentlichen Adresse, nicht lokal. Eine aggregierte
Einkaufsliste über mehrere Rezepte ginge nur mit einer Netlify Function, die die
Liste serverseitig als Rezeptseite ausgibt — bewusst nicht gebaut.

## 8. Deployment

Git-Repo mit Netlify verbinden. Drag & Drop funktioniert **nicht**, weil Netlify
dabei keinen Build ausführt und die Daten damit nicht erzeugt werden.

```toml
publish = "public"
command = "python3 build.py"
```

  case-insensitiv gelesen). Datenbank-ID steckt als Standardwert im Skript.
- Assets ein Jahr cachen (Hash-URLs), HTML nie.
- Feedback-Einsendungen im Netlify-Dashboard unter *Forms → rezept-feedback*;
  dort E-Mail-Benachrichtigung einrichten, sonst bleiben sie liegen.

## 9. Offene Punkte

- **Pasta-Teig mit Hartweizengriess** hat keinen `Gesundheitswert` und fehlt
  deshalb im Ernährungsfilter. Eine Zeile in der Markdown-Datei.
- **Lebensmittelmarken** stehen noch in drei Rezepten („Uncle Bens Reis
  Mexican", „LikeHack", „Vegeta"). Gerätemarken sind entfernt, Lebensmittel
  bewusst nicht.
- **Nährwerte** sind teils geschätzt und als solche gekennzeichnet.

## 10. Arbeitsanweisungen für Folgechats

1. **Neues Rezept?** Skill `rezept-erstellen` verwenden. Er enthält Format,
   Vorlage, Beispiel und Checkliste.
2. **Nach jeder Änderung an Rezepten oder Regeln `python3 build.py` laufen
   lassen** und die Hinweise abarbeiten.
3. **Nach Regeländerungen an Tags die `Tags:`-Zeilen neu erzeugen.** Sonst
   wirkt die Änderung nicht.
4. **Fließtext gegenlesen.** Nach jedem Eingriff in `annotate_steps` stichprobenartig
   prüfen, ob Mengen an sinnvollen Stellen stehen — die Fehler sind still.
5. **Textersetzungen per Skript kontrollieren.** In diesem Projekt sind mehrfach
   `str.replace`-Aufrufe ins Leere gelaufen, weil sich der Zielstring vorher
   geändert hatte. Immer danach prüfen, ob die Ersetzung tatsächlich griff.
6. **Keine Entwicklerhinweise im Interface.** Kein Dateiname, kein Format, kein
   Build-Befehl.
7. **Vor dem Deploy prüfen:** Rezeptzahl, keine Parser-Hinweise, keine
   Gerätemarken, Asset-Hashes in `index.html` aktualisiert.
8. **Bei Problemen auf echten Geräten zuerst das Deployment abrufen**, statt zu
   raten — der Pixel-Fall war nur so zu klären.

## 11. Zahlen zum Stand

- 50 Rezepte: 27 Hauptspeise, 7 Zutat, 5 Backen, 5 Vorspeise, 5 Snack, 1 Dessert
- 14 Tags, häufigste: Schnell 22, Ofengericht 20, Pfannengericht 20, Vegan 13, Meal Prep 13
- 326 Mengen im Fließtext verknüpft
- Alle Rezepte mit Nährwerten
- Code: ~900 Zeilen `build.py`, ~600 `app.js`, ~700 CSS
