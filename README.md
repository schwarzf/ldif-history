# ldif-history

Weboberfläche, mit der sich die Zustände beliebiger LDAP-Objekte durchspielen
lassen. Grundlage ist ein initialer LDIF-Export und eine Reihe von
Änderungs-LDIFs, die nacheinander eingespielt wurden.

Die Seite ist statisch (HTML, CSS und JavaScript ohne Build-Schritt und ohne
Abhängigkeiten) und läuft direkt auf GitHub Pages.

## Funktionen

- **Globaler Zeitregler:** Mit Schieberegler, Schritt-Kacheln oder den
  Pfeiltasten ← → durch die LDIF-Dateien gehen. Jede Kachel zeigt, wie viele
  Objekte angelegt (+), geändert (~), umbenannt/verschoben (⇄) oder gelöscht (−)
  wurden und wie viele Datensätze abgelehnt wurden (⚠).
- **Verzeichnisbaum** zum gewählten Zeitpunkt. Objekte, die sich in diesem
  Schritt geändert haben, sind markiert. Im Schritt gelöschte Objekte bleiben
  durchgestrichen sichtbar. Optional lassen sich nur die geänderten Objekte
  anzeigen.
- **Suche** über alle Schritte: nach DN, uid, Name oder Mail. Gefunden werden
  auch frühere DNs, alte Namen (z. B. vor einer Heirat) und gelöschte Objekte.
- **Objektansicht:**
  - Zustand des Objekts nach dem gewählten Schritt; Änderungen gegenüber dem
    vorherigen Schritt sind hervorgehoben (+ neu, − entfernt)
  - DN-Verlauf bei Umbenennungen und Verschiebungen
  - Zeitleiste aller Ereignisse mit Datei und Zeile, Änderungsübersicht und
    dem Original-LDIF-Datensatz
  - DN-Verweise (`member`, `manager`, …) sind anklickbar. Zeigt ein Verweis
    ins Leere, wird er markiert.
- **Objektidentität:** Ein Objekt bleibt bei `modrdn`/`moddn` dasselbe, auch
  wenn es nur mit seinem übergeordneten Eintrag verschoben wird. Wird ein
  gelöschter DN später neu angelegt, entsteht ein neues Objekt, so wie im
  Verzeichnis eine neue `entryUUID` vergeben wird. Beide Objekte sind
  miteinander verlinkt.
- **Abgelehnte Datensätze:** Datensätze, die ein LDAP-Server zurückweisen
  würde, werden nicht angewendet und aufgelistet. Beispiele: `add` auf einen
  vorhandenen Eintrag, `delete` eines fehlenden Werts, Löschen eines Eintrags
  mit Untereinträgen. Ein `modify` ist dabei atomar: Schlägt eine Operation
  fehl, gilt der ganze Datensatz als abgelehnt.
- Passwörter werden standardmäßig maskiert.
- Die Adresse merkt sich Schritt und Objekt (`#schritt=4&dn=…`), so lassen
  sich Links auf einen bestimmten Zustand teilen.

## Beispieldaten

Im Ordner `ldif/` liegt ein fiktives Firmenverzeichnis `dc=beispiel,dc=de`:

| Datei | Datum | Inhalt |
| --- | --- | --- |
| `00-basis.ldif` | 01.01.2025 | Initialer Export: 16 Personen, Abteilungs-OUs, 6 Gruppen, ein Dienstkonto |
| `01-neueinstellungen.ldif` | 15.01.2025 | Zwei neue Personen, Gruppenmitgliedschaften |
| `02-kontaktdaten-befoerderung.ldif` | 03.02.2025 | Beförderung, Übernahme eines Werkstudenten, neue Telefonnummern |
| `03-abteilungswechsel.ldif` | 20.02.2025 | `moddn` vom Vertrieb in die Entwicklung, Gruppen nachgezogen |
| `04-namensaenderung.ldif` | 10.03.2025 | `modrdn` nach Heirat (amueller → aschmidt). Ein Vorgesetzten-Verweis wird vergessen. |
| `05-austritte.ldif` | 01.04.2025 | Ein Konto gelöscht, eines nach `ou=Ehemalige` verschoben |
| `06-umstrukturierung-it.ldif` | 12.05.2025 | OU umbenannt (Unterbaum wandert mit), Gruppe umbenannt |
| `07-passwoerter-korrekturen.ldif` | 30.06.2025 | Passwort-Rotation, Korrektur des vergessenen Verweises, **zwei absichtlich fehlerhafte Datensätze** |
| `08-wiedereinstellung.ldif` | 15.08.2025 | Rückkehr aus `ou=Ehemalige`, Neuanlage unter einem früher gelöschten DN, neue Gruppe |

Das Basis-LDIF hat das Format eines `slapcat`-Exports (Nicht-ASCII-Werte als
Base64). Die Änderungsdateien sind von Hand geschrieben, wie für `ldapmodify`.

### Eigene Dateien verwenden

Die Dateiliste ist in dieser ersten Version fest hinterlegt: Konstante
`DATEIEN` am Anfang von [`js/app.js`](js/app.js). Für eigene Daten die Dateien
in `ldif/` ablegen und dort eintragen. Die Reihenfolge der Liste ist die
Abspielreihenfolge, die erste Datei ist der Ausgangszustand. Ein Test prüft,
dass die Liste und der Ordnerinhalt übereinstimmen.

## Lokal starten

Browser blockieren das Laden der LDIF-Dateien, wenn die Seite als `file://`
geöffnet wird. Deshalb einen kleinen Webserver verwenden:

```bash
python3 -m http.server 8000
```

Dann `http://localhost:8000/` öffnen.

## GitHub Pages

Unter *Settings → Pages* als Quelle „Deploy from a branch“ wählen, Branch
`main`, Ordner `/ (root)`. Die Datei `.nojekyll` sorgt dafür, dass GitHub die
Dateien unverändert ausliefert.

## Tests

```bash
npm test
```

Die Tests laufen mit dem eingebauten Test-Runner von Node (ab Version 18) und
brauchen keine Abhängigkeiten. Sie prüfen den Parser, die DN-Behandlung, die
Replay-Logik und die Beispieldaten. Die GitHub Action
`.github/workflows/tests.yml` führt sie bei jedem Push aus.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html` | Seite |
| `css/style.css` | Styles (hell/dunkel nach Systemeinstellung) |
| `js/ldif.js` | LDIF-Parser (RFC 2849) und DN-Hilfsfunktionen |
| `js/historie.js` | Abspielen der Dateien, Objekt-Ereignisse und Zustände je Schritt |
| `js/app.js` | Oberfläche und fest hinterlegte Dateiliste |
| `ldif/` | Beispieldaten |
| `tests/` | Tests für Node |

## Grenzen der ersten Version

- Kein Schema-Wissen: Werte werden ohne Beachtung von Groß-/Kleinschreibung
  verglichen. Ausnahmen sind `userPassword` (exakt) und DN-Attribute
  (DN-normalisiert).
- Serverseitige Nebeneffekte wie `refint` oder `memberOf` werden nicht
  nachgebildet. Es zählt nur, was in den LDIF-Dateien steht.
- `:<`-Verweise auf externe Dateien werden als Text angezeigt, nicht geladen.
