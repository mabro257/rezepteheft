#!/usr/bin/env python3
"""
Verkleinert die Illustrationen in public/bilder auf Web-Maß.

Läuft bewusst nur lokal vor dem Commit, nicht im Netlify-Build: Der Build soll
ohne Zusatzpakete auskommen, dieses Skript braucht Pillow.

    pip install pillow
    python3 optimize_images.py

Strichzeichnungen brauchen keine 1024 Pixel – dargestellt werden sie mit
maximal 240. 800 Pixel lassen Spielraum für Bildschirme mit hoher Dichte und
sparen rund 80 Prozent der Dateigröße.
"""
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow fehlt:  pip install pillow")

ORDNER = Path(__file__).parent / "public" / "bilder"
MAX_KANTE = 800
QUALITAET = 82


def main():
    if not ORDNER.exists():
        sys.exit(f"{ORDNER} gibt es nicht.")

    dateien = sorted(p for p in ORDNER.iterdir()
                     if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    if not dateien:
        sys.exit("Keine Bilder gefunden.")

    vorher = nachher = 0
    for pfad in dateien:
        alt = pfad.stat().st_size
        bild = Image.open(pfad).convert("RGB")

        if max(bild.size) > MAX_KANTE:
            faktor = MAX_KANTE / max(bild.size)
            bild = bild.resize((round(bild.width * faktor), round(bild.height * faktor)),
                               Image.LANCZOS)

        ziel = pfad.with_suffix(".jpg")
        bild.save(ziel, "JPEG", quality=QUALITAET, optimize=True, progressive=True)
        if ziel != pfad:
            pfad.unlink()

        neu = ziel.stat().st_size
        vorher += alt
        nachher += neu
        print(f"  {ziel.name:52s} {alt // 1024:5d} KB -> {neu // 1024:4d} KB")

    print(f"\n{len(dateien)} Bilder: {vorher // 1024} KB -> {nachher // 1024} KB "
          f"({100 - round(100 * nachher / vorher)} % gespart)")
    print("Danach: python3 build.py")


if __name__ == "__main__":
    main()
