# Rezepte

Statische Web-App für die eigene Rezeptsammlung. Quelle sind die
Markdown-Dateien in `recipes/`; `build.py` erzeugt daraus die Daten fürs
Frontend, die Bring!-Seiten und die Cache-Hashes. Kein Server, keine Datenbank,
keine Abhängigkeiten außer der Python-Standardbibliothek.

```
netlify.toml         Build-Befehl und Cache-Header
build.py             Parser und Regelwerk – der inhaltliche Kern
optimize_images.py   verkleinert die Illustrationen (lokal, braucht Pillow)
recipes/*.md         die Rezepte
public/              wird deployed
  index.html
  sw.js              Service Worker, nur für Timer-Benachrichtigungen
  assets/            app.js und style.css
  data/              generiert
  rezept/            generiert, schema.org-Seiten für den Bring!-Import
  bilder/            Illustrationen
```

## Arbeitsablauf

```bash
python3 build.py        # nach jeder Änderung an recipes/ oder an den Regeln
git add -A && git commit -m "…" && git push
```

Der Push löst den Netlify-Build aus, der ebenfalls nur `python3 build.py`
ausführt. Damit ist das Repository die alleinige Quelle: Was hier liegt, steht
auf der Seite.

Lokal ansehen ohne Server: `public/index.html` im Browser öffnen. Für Bring! und
den Service Worker braucht es die öffentliche Adresse.

## Deployment

Git-Repo in Netlify verbinden (*Project configuration → Developer settings →
Continuous deployment → Repository*). Build-Befehl und Publish-Verzeichnis
kommen aus `netlify.toml` und müssen in der Oberfläche nicht eingetragen werden.
Drag & Drop funktioniert nicht, weil Netlify dabei keinen Build ausführt.

Es werden keine Umgebungsvariablen und keine Zugangsdaten benötigt.

## Neues Rezept anlegen

**Direkt als Markdown:** Datei nach `recipes/` legen, `python3 build.py`. Aufbau:

```markdown
# Titel

Gesundheitswert: 🥦 Gesund
Kategorie: Hauptspeise
Portionen: 2
Quelle: Rezeptheft
Zubereitungszeit: 40

## 🛒 Zutaten

**Dressing**            <- optionale Gruppe

| Menge | Zutat |
| --- | --- |
| 2 EL | Tahini |

## 👨‍🍳 Zubereitung

**Tag 1:**              <- optionale Gruppe

1. **Ofen vorheizen:** 200 °C Heißluft.

## 💡 Tipps

- Kichererbsen vorher trocken tupfen.

## 📊 Nährwerte (pro Portion)

|  | Wert |
| --- | --- |
| Kalorien | ca. 520 kcal |
```


`build.py` meldet fehlende Angaben, unbekannte Kategorien und Mengen, die sich nicht skalieren lassen. Diese Hinweise brechen den Build nicht ab; `python3 build.py --strict` erzwingt einen Abbruch, falls du das im Deploy hart absichern willst.

Der Mengen-Parser versteht Brüche (`½`, `1½`), Bereiche (`4–5 EL`), Präfixe (`Saft von ½–1 Zitrone`), Klammerzusätze (`1 Dose (400 g, abgetropft)`), `nach Bedarf`, `nach Geschmack` und `etwas`. Nur echte Zahlen werden beim Umrechnen der Portionen skaliert.

Neue Kategorie? Farbe in `ACCENTS` in `public/assets/app.js` ergänzen, sonst wird sie grau dargestellt.

---

## Funktionen der App

- Suche über Titel, Zutaten, Zubereitungsschritte und Tipps
- Kategorie als Schnellfilter direkt unter der Suche, dazu Filter nach Tags, Ernährung, Aufwand und maximaler Zeit; mehrere Tags wirken zusammen (UND-Verknüpfung)
- Sortierung nach A–Z, Zeit, Kalorien, Anzahl Zutaten
- Portionsregler rechnet alle Mengen live um
- Zutaten und Schritte abhaken; Kochmodus mit größerer Schrift und Display-Wachhalten
- Bring!-Import je Rezept: `build.py` legt zu jedem Rezept eine Seite unter `public/rezept/<id>.html` mit schema.org-Auszeichnung ab. Der Button "In Bring! öffnen" schickt Bring auf diese Seite und übergibt die eingestellte Portionszahl, Bring rechnet die Mengen um. Funktioniert nur auf der öffentlichen Adresse, nicht lokal — Bring holt die Seite von seinem eigenen Server.
- Jedes Rezept hat eine eigene URL (`#/r/rezept-id`) und ist teilbar


Tastatur: `/` springt in die Suche, `Esc` schließt das Rezept.

## Mengen im Zubereitungstext

`build.py` verknüpft Zutatenliste und Zubereitung, damit die Schritte die Mengen selbst nennen. Zwei Fälle:

- Der Schritt nennt die Menge schon ("mit 600 ml Wasser") — sie wird als skalierbar markiert, sofern in der Nähe eine bekannte Zutat steht.
- Der Schritt nennt nur die Zutat ("Salz hinzugeben") — die Menge aus der Zutatenliste wird ergänzt, aber nur bei der ersten Erwähnung im Rezept und nur, wenn dort eine echte Zahl steht. "nach Bedarf" wird nie eingefügt.

Im Text werden Menge **und** Zutat gemeinsam hervorgehoben ("**250 g Agavendicksaft**") – gleiche Schrift wie der Fließtext, nur fett und unterlegt, damit beim Kochen beides auf einen Blick zu finden ist.

Bewusst nicht angefasst werden Zeiten, Temperaturen, Herdstufen und Maße, weil deren Einheiten nicht in der Liste `UNIT_RE` stehen. Ebenso wenig Mengen pro Stück ("125 g große Patties"), erkennbar an Wörtern aus `PER_PIECE` — die wachsen nicht mit den Portionen, es werden stattdessen mehr Stück. Wörter aus dem Rezepttitel gelten als Gerichtsname, nicht als Zutat, damit aus "eine Pizza formen" nicht "2 EL Pizza formen" wird.

Zutat und Text werden über das Grundwort verknüpft, nicht über die ganze Bezeichnung: "Salz" findet "Feines Meersalz", "Wasser" findet "Kaltes Leitungswasser". Die Richtung ist entscheidend — im Deutschen steht der Kopf eines Kompositums hinten. Deshalb trifft "Pizza" eben *nicht* "Pizza-Soße": dort ist es nur das Bestimmungswort, das Gericht und nicht die Zutat.

Weitere Regeln, die aus echten Fehlern entstanden sind:

- Steht eine Zutat mehrfach in der Liste (Sojasauce dreimal in verschiedenen Gruppen), bekommt die zweite Erwähnung im Text den zweiten Eintrag, nicht wieder den ersten.
- Passen mehrere *verschiedene* Zutaten auf ein Wort ("Tofu" → Naturtofu und Räuchertofu), bleibt die Stelle leer. Lieber keine Menge als die falsche.
- Der vollständige Name gewinnt gegen die Kurzform: in "Mit Paprika edelsüß" landet der Teelöffel Gewürzpaprika, nicht die Paprikaschote.
- Innerhalb eines erkannten Namens wird nicht erneut zugeordnet, sonst würde aus "passierte Tomaten" ein "passierte 1 Handvoll Tomaten".
- Beschreibende Wörter zählen nicht als Zutat: "Crispy Reis als Basis" bekommt nicht die Menge des Crispy Chili-Öls.

Wenn eine Zutat in deinen Rezepten anders benannt wird als im Schritt und die Zuordnung nicht klappt, hilft ein Blick auf `TOKEN_STOP` und `token_hit()` in `build.py`.

## Tags

Tags speisen sich aus zwei Quellen, die zusammengeführt werden:

1. Die Zeile `Tags:` in der Rezeptdatei. Was dort steht, gilt immer.
2. Regeln in `build.py` (`TAG_RULES`), die Titel, Zutaten, Schritte und Tipps auswerten.

Jede Regel legt fest, *wo* gesucht wird — das entscheidet über die Qualität. Ein Gerichttyp steht im Titel oder in den Zutaten, eine Zubereitungsart in den Schritten, ein Hinweis auf Vorkochen in den Tipps. Sucht man überall, wird aus "schmeckt auch auf Brot" ein Brotrezept. Küchenrichtungen verlangen zwei Treffer, denn eine einzelne Sojasauce macht noch kein asiatisches Gericht.

Ein neuer Tag ist eine Zeile in `TAG_RULES`. Soll ein einzelnes Rezept einen Tag bekommen, den keine Regel trifft, schreibst du ihn in die `Tags:`-Zeile der Datei.

Achtung: Eine vorhandene `Tags:`-Zeile gewinnt gegen die Automatik. Nach einer Regeländerung müssen die Zeilen neu erzeugt werden, sonst wirkt die Änderung nicht.

`Vegetarisch` gibt es bewusst nicht: die Sammlung enthält kein Fleisch, der Tag träfe alle 30 Rezepte und würde nichts filtern. `Vegan` prüft das Grundwort jeder Zutat, erkennt deshalb Magerquark als tierisch und Erdnussbutter trotz des Namens als pflanzlich.

## Zusammen kochen

Der Modus beantwortet die Frage: was koche ich noch, damit die frische Ware aufgebraucht wird? Über "Zusammen kochen" in der Toolbar lassen sich Rezepte markieren; darüber erscheint, welche frischen Zutaten die Auswahl teilt, darunter passende Vorschläge mit den jeweils geteilten Zutaten.

Gezählt wird ausschließlich, was schnell verdirbt. `build.py` arbeitet dafür mit einer **Whitelist** (`FRESH_INGREDIENTS`) statt einer Ausschlussliste: Mehl, Nudeln, Kichererbsen, Gewürze und Konserven müssen nirgends aufgezählt werden, weil alles Unbekannte automatisch als Vorrat gilt. Lange haltbares Gemüse wie Zwiebel, Knoblauch, Möhre, Kürbis und Kartoffel fehlt bewusst — es zwingt zu nichts.

Links in der Liste steht ein gemeinsamer Name, damit Kirschtomaten, Cherrytomaten und Rispentomaten als dieselbe Zutat zusammenfinden. `PRESERVED` entfernt Treffer wieder, bei denen ein Zusatz die Haltbarkeit ändert: getrocknete Tomaten, TK-Edamame, Tomatenmark, Paprikapulver, Gewürzgurken und Kokosmilch zählen nicht als frisch.

Eine neue Zutat ist eine Zeile in `FRESH_INGREDIENTS`.

## Caching und Deploys

`build.py` hängt an die URLs von `assets/style.css`, `assets/app.js` und `data/recipes.js` einen Hash ihres Inhalts (`?v=...`) und trägt ihn in `index.html` ein. Deshalb stehen in `netlify.toml` für `/assets/*` und `/data/*` lange Cache-Zeiten, für das HTML dagegen keine.

Der Grund: ohne Hash bleibt die URL bei jedem Deploy gleich. Ein Gerät, das die Seite kurz vorher besucht hat, bekommt dann das neue HTML, behält aber die alte `app.js` im Cache. Sucht das alte JavaScript nach einem Element, das es im neuen HTML nicht mehr gibt, bricht es ab und die Rezeptliste bleibt leer — ohne Fehlermeldung, und ein Cache-Leeren im Browser hilft oft nicht, weil der Tab aus der Sitzung wiederhergestellt wird. Mit Hash ändert sich die URL bei jeder Änderung, der Browser lädt zwingend neu.

Zwei weitere Schutzmaßnahmen im Frontend: Beim Aufruf werden alle Filtereingaben ausdrücklich auf Standard gesetzt, weil Chrome beim Wiederherstellen eines Tabs alte Eingabewerte zurückschreibt, ohne ein Event auszulösen. Und der Zugriff auf einzelne Bedienelemente ist abgesichert, damit ein fehlendes Element nie die ganze Liste verschwinden lässt.

## Nährwerte

Alle 49 Rezepte haben Nährwerte. Wo sie in der Quelle fehlten, wurden sie aus den Zutatenmengen geschätzt und sind im Tabellentitel als solche gekennzeichnet ("pro Portion, geschätzt"). Die Bezugsgröße steht immer dabei, weil sie sich zwischen den Rezepten unterscheidet — mal pro Portion, mal pro 100 g, mal pro Stück.

## Änderungsvorschläge von Nutzern

Am Ende jedes Rezepts steht "Änderung vorschlagen". Die Einsendung geht über **Netlify Forms** — das Formular `rezept-feedback` liegt statisch in `index.html`, damit Netlify es beim Deploy erkennt; die sichtbare Eingabe in der Rezeptansicht wird per `fetch` dorthin geschickt. Rezeptname und ID werden automatisch mitgesendet, sodass jede Meldung eindeutig zuzuordnen ist.

Einsendungen stehen im Netlify-Dashboard unter **Forms → rezept-feedback**. Damit sie nicht liegen bleiben, dort unter *Form notifications* eine E-Mail-Benachrichtigung einrichten (oder Slack).

Wichtig: Formulare funktionieren nur auf der deployten Seite, nicht lokal — Netlify nimmt die Einsendung an, nicht der lokale Server. Ein Feld namens `bot-field` dient als Spam-Falle: es ist unsichtbar, und wenn ein Bot es ausfüllt, verwirft Netlify die Einsendung.

Das kostenlose Kontingent liegt bei 100 Einsendungen pro Monat.

## Illustrationen

Bilder gehören nach `public/bilder/` und heißen wie die Rezept-ID, also so wie
das Rezept in der URL steht: `rotweinzwiebeln.jpg`, `neapolitanische-pizza.jpg`.
`build.py` findet sie von selbst, eine Zuordnungstabelle gibt es nicht. Erkannt
werden `.jpg`, `.jpeg`, `.png`, `.webp` und `.avif`.

Die Rezept-ID steht in `public/data/recipes.json` im Feld `id`.

Dargestellt werden die Zeichnungen mit `mix-blend-mode: multiply`. Dadurch
verschwindet der weiße Hintergrund der Strichzeichnung im Kartenton, ohne dass
die Dateien freigestellt werden müssen. Rezepte ohne Bild behalten die rein
typografische Karte – die Sammlung darf also unvollständig bebildert sein.

Vor dem Commit einmal `python3 optimize_images.py` laufen lassen: Das verkleinert
die Bilder auf 800 Pixel Kantenlänge und spart rund 80 Prozent Dateigröße. Der
Netlify-Build ruft das Skript bewusst nicht auf, damit er ohne Zusatzpakete
auskommt.

An die Bild-URLs hängt `build.py` einen Inhalts-Hash, ein ausgetauschtes Bild
wird also sofort sichtbar und nicht aus dem Cache geliefert.

## Küchentimer

Jede Zeitangabe in den Zubereitungsschritten ist antippbar und startet einen
Timer. Der Timer heißt nach dem Schritt, nicht nach dem Rezept — bei zwei
laufenden Timern im selben Gericht wäre der Rezeptname zweimal derselbe. Die
Bezeichnung kommt in dieser Reihenfolge aus dem Titel des Schritts, dem
Tätigkeitswort neben der Zeit ("Backen", "Köcheln") oder der Schrittnummer.

Mehrere Timer laufen parallel, jeder lässt sich anhalten und löschen. Die
Restzeit wird aus dem Zielzeitpunkt berechnet, nicht heruntergezählt: Android
drosselt Zeitgeber im Hintergrund, ein Zähler ginge nach.

### Benachrichtigungen

`public/sw.js` ist ein Service Worker, der ausschließlich Benachrichtigungen
zeigt — Android sperrt den Notification-Konstruktor in Seiten, deshalb führt
kein Weg daran vorbei. Die Erlaubnis wird beim ersten Timer erfragt, nicht beim
Öffnen der App.

**Der Worker cacht bewusst nichts und hat keinen fetch-Handler.** Die App hatte
schon einmal das Problem, dass neues HTML auf alte JavaScript-Dateien traf und
die Seite leer blieb; ein cachender Worker wäre dieselbe Falle, nur
hartnäckiger.

Grenzen, die technisch bestehen bleiben: Bei gesperrtem Bildschirm kann das
System den Worker beenden, bevor ein langer Timer abläuft. Dagegen hilft
zweierlei — solange ein Timer läuft, bleibt der Bildschirm per Wake Lock an, und
sobald die Seite wieder sichtbar wird, rechnet sie nach und meldet abgelaufene
Timer sofort. Eine garantierte Weckfunktion wie bei einer nativen App gibt es im
Browser nicht; dafür wäre Web Push mit Server nötig.
