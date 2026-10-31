# Rezepte-App — Übergabe und Projektwissen

Stand: 80 Rezepte, live unter `rezepteheft.netlify.app`.

Dieses Dokument richtet sich an jemanden, der das Projekt zum ersten Mal sieht
und daran weiterarbeiten soll. Es beschreibt nicht nur *was* gebaut ist, sondern
*warum* es so gebaut ist — die meisten Eigenheiten sind Reaktionen auf konkrete
Fehler, die ohne Erklärung wie Willkür aussehen und beim Aufräumen versehentlich
zurückgebaut würden.

---

## 1. Was das ist

Eine private Rezeptsammlung als statische Website. Keine Datenbank, keine
Build-Tools, keine Abhängigkeiten außer der Python-Standardbibliothek. Einzige
Serverfunktion ist das Einreichen neuer Rezepte (Abschnitt 6.2). Quelle der Rezepte sind die Markdown-Dateien in
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
| `netlify.toml` | Build-Befehl, Funktionsordner, Cache-Header |
| `netlify/functions/rezept-einreichen.mjs` | Nimmt neue Rezepte an und legt sie als Pull Request an (6.2) |
| `recipes/*.md` | Die Rezepte |
| `entwuerfe/*.md` | Eingereichte Rezepte, nur in den Pull-Request-Branches, nie auf `main` |
| `.env.example`, `sync.sh` | Lokaler Sync-Komfort |

## 4. Format der Rezeptdateien

Siehe den separaten Skill `rezept-erstellen` — dort steht die vollständige
Spezifikation inklusive Vorlage, Beispiel und Checkliste. Kurzfassung:

```markdown
# Titel

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

Die Felder `Schwierigkeitsgrad` und `Gesundheitswert` (Gesund / Ausgewogen /
Genussrezept, „Ernährung“ in der Seitenleiste) gab es früher, beide wurden auf
Wunsch entfernt. Ältere Dateien enthalten die Zeile `Gesundheitswert:` noch,
`build.py` ignoriert sie. Neue Rezepte bekommen sie nicht.

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

Ergebnis heute: 719 verknüpfte Mengen über 80 Rezepte, ohne bekannte Fehlzuordnung.

**Hervorheben ohne Menge (Schritt 2c):** Jede weitere Nennung einer Zutat wird
markiert, auch ohne Menge – optionale Zutaten, „nach Bedarf“, zweite
Erwähnungen, mehrdeutige Treffer. Dafür gibt es eigene Suchwörter
(`mention_tokens`), die Sammelzeilen wie „Salz, Pfeffer, Chili“ zerlegen und
kurze Wörter (Öl, Ei) behalten. Für das Einsetzen von Mengen bleiben sie tabu.
Regeln in `mention_hit`: nur großgeschriebene Wörter (sonst wären „salzen“,
„pfeffern“, „garnieren“ Zutaten), kurze Wörter nur exakt (sonst trifft „In“ den
Rotwein), Sammelwörter wie „Sauce“ oder „Füllung“ nur exakt (sonst wird „in die
Sauce geben“ zur Worcestershiresauce).

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

Grundlage für „Zusammen kochen“ im Essensplan. **Whitelist** statt Ausschlussliste:
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
Abbruch. Aktuell ist kein Hinweis offen.

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

- **Suche** über Titel, Kategorie, Tags, Zutaten, Schritte, Tipps. Mehrere
  Wörter grenzen ein. Treffer sind nach Relevanz sortiert (Titel vor Tag vor
  Zutat vor Fließtext), das Suchwort ist markiert, und jede Karte nennt, wo es
  vorkommt („Zutat: veganer Feta“). Auf dem Handy klebt das Feld oben, und
  Überschrift, Kategorien und Sortierleiste weichen, solange gesucht wird –
  vorher verdeckte die Tastatur sämtliche Treffer. Trefferzahl und Leeren-Knopf
  stehen im Feld. Ganze Wörter zählen mehr als Wortteile („kartoffel“ bringt
  erst Kartoffeln, dann Süßkartoffeln). Kleine Synonymliste `SYNONYMS`
  (Nudeln/Pasta/Ravioli, Soße/Sauce …) – bewusst kurz, jeder Eintrag erweitert
  die Treffer. Ohne Treffer schlägt die App ein Wort der Sammlung mit einem
  Buchstaben Abstand vor („Meintest du Zucchini?“).
- **Kategorie-Schnellfilter** als Chips direkt unter der Suche, mobil als
  wischbare Leiste
- **Seitenleiste** mit Tags, Zeit-Regler, Zurücksetzen. Mobil zeigt
  der Knopf die Zahl aktiver Filter („Filter · 2“), unter der Suche stehen sie
  als lösbare Chips, und unten in der Leiste schließt „N Rezepte anzeigen“.
- **Sortierung** A–Z, Zeit, Kalorien, Anzahl Zutaten
- **Rezeptansicht** als Vollbild-Sheet mit eigener URL (`#/r/<id>`). Mobil nur
  Zurück und Kochmodus in der Leiste, Einplanen / Bring! / Teilen hinter „⋯“;
  Sprungmarken zu Zutaten, Zubereitung, Nährwerten; Bild klein neben dem Titel.
- **Teilen** über das Teilen-Menü des Handys, sonst Link in die Zwischenablage
- **Portionsregler**, der Zutatenliste *und* Fließtext live umrechnet
- **Kochmodus**: größere Schrift, abhakbare Schritte, Display bleibt an (Wake Lock).
  Haken, Portionen und Kochmodus bleiben pro Rezept für die Sitzung erhalten
  (`progress`), wer zwischendurch ein anderes Rezept ansieht, verliert nichts.
- **Bring!-Import** je Rezept
- **Änderungsvorschlag** je Rezept über Netlify Forms
- **Essensplan** als eigener Bereich (`#/plan`), siehe 6.1

### 6.1 Essensplan

Eigener Bereich neben der Rezeptliste, erreichbar über den Knopf oben rechts
(mobil) bzw. die Navigation in der Seitenleiste (Desktop), eigene Adresse
`#/plan`.

- Ein Eingabefeld für beides: steht dort der exakte Titel eines Rezepts
  (`datalist` schlägt alle vor), wird der Eintrag mit dem Rezept verknüpft und
  im Plan anklickbar. Alles andere wird freier Text („Pizza bestellen").
- Zwei Haken je Eintrag: *eingekauft* und *gekocht*. **gekocht** ist der
  Abschluss — der Eintrag wandert sofort ins Archiv, statt abgehakt stehen zu
  bleiben. Zurück geht es über *Nochmal kochen* (setzt auch *eingekauft*
  zurück).
- **Kein Datum, keine Wochentage.** Ausdrückliche Vorgabe: geplant wird, *was*
  es demnächst gibt, nicht wann. Nicht eigenmächtig Tage einbauen.
- Keine Bring!-Kopplung. *eingekauft* ist nur ein Haken; der Bring!-Export
  bleibt wie gehabt am einzelnen Rezept.
- Ein Rezept kann nur einmal **offen** im Plan stehen, im Archiv beliebig oft.
- In der Rezeptansicht gibt es *Einplanen* / *Im Essensplan ✓*, in der
  Rezeptliste tragen geplante Rezepte ein kleines „geplant“ am Titel.
- Entfernen geht ohne Rückfrage, dafür mit *Rückgängig* in einer Meldung.
- **Zusammen kochen ist Teil des Plans.** Unter den offenen Einträgen stehen
  die frischen Zutaten aller geplanten Rezepte und bis zu sechs Vorschläge, die
  dieselben Zutaten aufbrauchen, jeweils mit *+ Einplanen*. Früher war das ein
  eigener Auswahlmodus in der Rezeptliste, der vom Plan nichts wusste – und
  dessen Rückmeldung oben erschien, während man unten eine Karte antippte.

**Speicherort:** `localStorage`, Schlüssel `essensplan.v1`, Struktur
`[{id, recipe|null, title, bought, cooked, cookedAt}]`. Das ist eine bewusste
Entscheidung: ohne Server bleibt die App eine rein statische Seite. Preis dafür
ist, dass der Plan nur auf dem Gerät existiert, auf dem er entsteht. Soll er
geteilt werden, braucht es eine Netlify Function plus Speicher (z. B. Netlify
Blobs) — dann ist es keine rein statische Seite mehr.

**Namen im Code:** Der Essensplan heißt durchgehend `menu` (`menuAdd`,
`menuPatch`, `renderMenu`, `#menuview`), Zusammen kochen darin `menuFresh` /
`menuSuggestions`. Die früheren `state.plan`, `planbar` und `togglePlan` gibt
es nicht mehr.

### 6.2 Neue Rezepte aus der App

Über „+ Rezept“ in der Leiste über der Liste (`#/neu`) kann jeder mit dem
Zugangscode ein Rezept einreichen. Der Weg im Sheet (`newStep`):

1. **Zugangscode** – kommt zuerst und wird sofort geprüft (`action: "check"`),
   damit niemand ein ganzes Rezept tippt und erst beim Absenden scheitert.
   Ein geprüfter Code wird gemerkt, beim nächsten Mal entfällt der Schritt.
   Ändert sich der Code, fragt die App beim Absenden neu – das Eingetippte
   bleibt erhalten (`formDraft`).
2. **Auswahl:** „Aus dem Netz übernehmen“, „Foto hochladen“ oder „Selbst
   aufschreiben“. Instagram wird dort bewusst nicht als Beispiel genannt, weil
   es nur über eingefügten Text geht.
3. **Aus dem Netz:** Link einfügen, die Funktion holt die Seite
   (`action: "import"`) und liest das schema.org-Rezept (Titel, Portionen,
   Zeit, Zutaten, Schritte, Kategorie geraten). Pinterest: über den Link des
   Pins zur Originalseite. Ergebnis landet vorausgefüllt im Formular.
   Getestet: Bianca Zapatka, Chefkoch, lecker.de, utopia.de, essenrezept.de
   klappen; Pins ohne Originallink und Seiten ohne Rezeptdaten nicht.
   Instagram, TikTok, Facebook und alles ohne lesbare Daten führen zu
   **„Rezepttext einfügen“**: Titel, Kategorie und ein freies Textfeld, die
   Quelle ist schon eingetragen. Zerlegt wird der Text erst im Chat.
4. **Selbst aufschreiben:** Titel, Kategorie, Portionen, Minuten, Zutaten
   (eine pro Zeile), Schritte (einer pro Zeile), optional Tipps.
5. **Foto hochladen:** Titel, Kategorie, bis zu 4 Fotos (auf dem Handy auch
   direkt mit der Kamera). Die App verkleinert sie vor dem Senden auf 1600 px
   (JPEG), weil Netlify-Funktionen höchstens 6 MB je Aufruf annehmen. Die
   Funktion legt sie als `entwuerfe/<id>-foto-N.jpg` in den Branch; im Chat
   werden sie abgetippt und danach mit dem Entwurf gelöscht. Auf dem Gerät
   bleibt nur eine kleine Vorschau. Scheitert das Senden, bleibt das Formular
   offen (volle Fotos passen nicht in den Gerätespeicher).
   Alle Wege enden mit Quelle, Anmerkung, Name und „Einreichen“.

**Ablauf (Vorgabe von Marcel):**
1. Die Funktion `/api/rezept-einreichen` legt einen Branch `entwurf/<id>-<zeit>`
   an, darin `entwuerfe/<id>.md` **genau so wie eingereicht**, und öffnet einen
   Pull Request „Neues Rezept: …“ mit Checkliste.
2. Auf dem einreichenden Gerät steht das Rezept als **Entwurf** über der Liste
   (`localStorage`, Schlüssel `entwuerfe.v1`; Zugangscode und Name werden
   gemerkt). Kam die Einreichung nicht an, heißt es „Nicht gesendet“ und lässt
   sich erneut senden. Entwürfe werden in der Suche und über die Kategorie
   gefunden; sind Tags oder Zeit gefiltert, bleiben sie weg (die haben sie
   noch nicht).
3. **Überarbeitet wird im Chat, nicht per API.** Branch auschecken, Entwurf in
   das Rezeptformat bringen (Zutatentabelle, Mengen in den Schritten,
   Tags, Nährwerte), nach `recipes/` verschieben, Entwurf und Fotos löschen,
   `build.py` laufen lassen.
4. **Für jedes neue Rezept einen neuen Gemini-Bildprompt erstellen** und
   Marcel geben (Vorlage unten). Das Bild kommt als `public/bilder/<id>.jpg`.
5. **Freigabe durch Marcel**, dann Merge. Sobald das Rezept mit derselben ID in
   der Sammlung steht, verschwindet der Entwurf auf dem Gerät von selbst. Die ID
   kommt aus `slugify()` – die Kopien in `app.js` und in der Funktion müssen zu
   `build.py` passen. Wird der Titel bei der Überarbeitung geändert, bleibt der
   Entwurf stehen, bis man ihn entfernt.

`entwuerfe/` liest `build.py` nicht. Ein versehentlich unbearbeitet
gemergter Entwurf taucht also nicht in der Sammlung auf.

**Einrichtung (einmalig, nur im Netlify-Dashboard):**
- `GITHUB_TOKEN`: Fine-grained Token, nur Repository `rezepteheft`,
  Berechtigungen *Contents* und *Pull requests* jeweils Read and write.
- `REZEPT_CODE`: Zugangscode für Einreichende.
- Optional `GITHUB_REPO` (Standard `mabro257/rezepteheft`).
Fehlt eine Variable, antwortet die Funktion mit 503, und die App speichert das
Rezept als „Nicht gesendet“.

**Bildprompt-Vorlage** (Stil der vorhandenen Bilder, Beispiel Gözleme):

```
Strictly black-and-white pen-and-ink engraving illustration, monochrome black
ink on white paper only, vintage cookbook etching style with fine
cross-hatching and stippling. A single round ceramic plate seen from a slight
three-quarter angle, holding <Gericht mit sichtbaren Zutaten>. <Details:
Anschnitt, Garnitur>. Three thin curling wisps of steam rising above. Pure
white background, no shadow on the background, no table, no text, isolated
centered composition, square format 1:1. Absolutely no color anywhere: no
colored food, no sepia, no beige or cream paper tone, no tinted highlights, no
gray watercolor washes - only black ink lines, hatching and dots on pure white.
```

Der Schluss gegen Farbe ist auf Marcels Wunsch bewusst so ausführlich: Die
Bilder sollen ausschließlich schwarz-weiß sein. Ein Farbton oder cremefarbenes
Papier würde außerdem von `mix-blend-mode: multiply` nicht ausgeblendet und
passte nicht zu den übrigen Bildern.

Die Funktion ruft nur öffentliche Adressen ab (keine lokalen oder internen
Hosts) und das nur mit gültigem Code, damit sie kein offener Abrufdienst wird.

Noch nicht gebaut: Teilen-Ziel auf Android (Link direkt aus Instagram oder
Chrome in die App teilen).

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

**Absolute URLs sind Pflicht.** Nachdem die Rezeptbilder dazukamen, stand im
JSON-LD zuerst ein relativer Pfad (`../bilder/<id>.jpg`); Bring! meldete
daraufhin „falsches Format". Der Parser läuft auf Bring-Servern und kann einen
relativen Pfad nicht auflösen. `build.py` setzt `image` und `canonical` deshalb
über die Konstante `SITE_URL` zusammen (liest Netlifys `URL` bzw.
`DEPLOY_PRIME_URL`, sonst `https://rezepteheft.netlify.app`). Beim Umzug auf
eine andere Domain nichts ändern müssen — Netlify liefert die Variable selbst.

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


- **Lebensmittelmarken** stehen noch in drei Rezepten („Uncle Bens Reis
  Mexican", „LikeHack", „Vegeta"). Gerätemarken sind entfernt, Lebensmittel
  bewusst nicht.
- **Nährwerte** sind teils geschätzt und als solche gekennzeichnet.

## 10. Arbeitsanweisungen für Folgechats

1. **Neues Rezept?** Skill `rezept-erstellen` verwenden. Er enthält Format,
   Vorlage, Beispiel und Checkliste. Eingereichte Rezepte aus der App nach 6.2
   bearbeiten – immer mit neuem Gemini-Bildprompt, Merge erst nach Marcels
   Freigabe.
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

- 80 Rezepte: 54 Hauptspeise, 7 Backen, 7 Zutat, 6 Snack, 5 Vorspeise, 1 Dessert
- 14 Tags, häufigste: Pfannengericht 39, Schnell 34, Ofengericht 32, Meal Prep 26, Vegan 22
- 719 Mengen im Fließtext verknüpft

28 Rezepte stammen aus dem Pinterest-Abschnitt „Ausprobiert und Lecker :)“
(lorenabrockmann/essen). Die Pins liefert Pinterests öffentliche Resource-API
(`BoardSectionResource` für die ID, dann `BoardSectionPinsResource`, page_size
höchstens 50); die Rezepte kamen aus schema.org-Daten bzw. dem Seitentext.
Fleisch wurde vegetarisch ersetzt (Speck → Räuchertofu, Hähnchen → Tofu bzw.
vegane Hähnchenstücke, Hühnerbrühe → Gemüsebrühe). Nicht übertragbar, weil die
Seite weg ist, hinter einem Login liegt oder das Archiv blockte:
Limette-Basilikum-Risotto mit Burrata, Kartoffel-Halloumi-Auflauf,
Kichererbsen-Masala, Blumenkohl-Wings mit Honig-Senf-Dip, Ofengemüse mit
Ziegenkäse, Kürbissuppe mit Kokosmilch, Afrikanischer Erdnusseintopf,
Kartoffel-Brokkoli-Pfanne mit Feta, Kichererbsen-Pfanne mit Feta,
Kürbisgemüse mit karamellisiertem Ziegenkäse, Auberginen-Reispfanne mit Feta,
Flammkuchen mit Pesto.
- Alle Rezepte mit Nährwerten
- Code: ~900 Zeilen `build.py`, ~600 `app.js`, ~700 CSS
