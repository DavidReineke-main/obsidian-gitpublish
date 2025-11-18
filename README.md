# Git Publisher

Git Publisher ist ein Obsidian Plugin um ausgewählte Markdown Dateien automatisiert auf ein GitHub Repository zu veröffentlichen.

## Funktionsüberblick
- Frontmatter Flag `published: true` bestimmt welche Dateien veröffentlicht werden.
- Automatisches Batch-Publishing nach konfigurierbarer Session-Dauer.
- Einzel-Publish nach Inaktivität (Sekunden konfigurierbar).
- Manuelle Aktionen: aktuelles File publishen, alle pending Files publishen, Rescan.
- Pending-Status (lokale Änderungen gegenüber Remote) wird erkannt und visuell markiert (blau).
- Unpublish (`published: false`) löscht die Datei aus dem Repository.
- Größenlimit pro Datei (KB) schützt vor versehentlichen großen Commits.
- Initialer Scan prüft Repository und Branch, legt Branch an falls leer.
- Logging in `gitpublish-log.ndjson` (Rotation >1MB).


## Konfiguration
Öffne die Einstellungen (Settings Tab "Git Publisher Einstellungen") und setze:
- GitHub Repo URL: `https://github.com/OWNER/REPO`
- GitHub Token: Fine-grained Token mit `Contents: Read & write`
- Auto Publish: Aktiviert/Deaktiviert Automatik
- Inaktivitäts-Sekunden: Zeit ohne Tipp bis ein einzelnes File veröffentlicht wird
- Session-Minuten: Maximale Dauer bis alle pending Dateien veröffentlicht werden
- Debounce (ms): Entprellung für Eingabeaktivität
- Batch Commit Message: Präfix für Commit-Nachrichten
- Branch: Zielbranch (Standard `main`)
- Max Dateigröße (KB): Größengrenze für Veröffentlichung

## Nutzung
1. Füge im Frontmatter einer Markdown Datei `published: true` hinzu.
2. Schreibe – Timer starten automatisch.
3. Bei Inaktivität (z. B. 30s) wird die Datei veröffentlicht (falls pending).
4. Spätestens nach dem Session-Intervall (z. B. 5 Minuten) werden alle pending Dateien im Batch veröffentlicht.
5. Über das Seiten-Panel (Ribbon Icon "Upload Cloud") kannst du pending Dateien ansehen und manuell publishen.
6. Setze `published: false` um eine Datei aus dem Repo zu entfernen.

## Statusanzeige
Unten rechts in der Statusbar:
- Grün: Datei ist veröffentlicht und synchron
- Blau: Datei veröffentlicht aber lokale Änderungen nicht gepusht (pending)
- Rot: (Toggle deaktiviert) kein aktives File oder Auto Publish deaktiviert


## Logging
Datei: `gitpublish-log.ndjson` im Plugin Ordner. Jeder Eintrag ist eine JSON-Zeile mit Zeitstempel und Event.
Rotation bei >1MB (alte Datei wird nach `.1` umbenannt).

## Bekannte Grenzen
- Kein Diff-Viewer integriert.
- Rate Limit Handling nur rudimentär (Hinweis bei Konflikt). 
- Keine automatisierte Entfernung von `.gitkeep` nach erstem echten Commit (optional nachrüstbar).

## Manuelle Fehlerbehebung
- 409 Konflikte direkt nach Initialisierung: Warte kurz oder rescan.
- Token Fehler (403): Prüfe Rechte (Contents Read/Write) und Branch-Namen.
- Branch existiert nicht: Stelle sicher, dass Repo erstellt ist (leeres Repo ohne README ist ok, Plugin legt Branch an).
