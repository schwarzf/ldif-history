# ldif-history

Weboberfläche, mit der sich die Zustände beliebiger LDAP-Objekte durchspielen
lassen. Grundlage ist ein vollständiger LDIF-Export und viele kleine
Änderungs-LDIFs, die nacheinander eingespielt wurden.

Die Seite ist statisch (HTML, CSS und JavaScript ohne Build-Schritt und ohne
Abhängigkeiten) und läuft direkt auf GitHub Pages.

## Funktionen

- **Zeitregler:** Mit Schieberegler oder Pfeiltasten ← → durch die Schritte
  gehen. Die Zeile darunter zeigt Datum, Art und Titel der aktuellen Änderung
  sowie den Dateinamen.
- **Änderungsprotokoll:** Liste aller Änderungen mit Nummer, Zeitpunkt, Art und
  Titel. Sie lässt sich nach Art filtern (Neu, Geändert,
  Verschoben/umbenannt, Gelöscht, Abgelehnt), per Text durchsuchen und auf die
  Änderungen am gewählten Objekt einschränken. Ein Klick springt zu diesem
  Schritt und wählt das Hauptobjekt der Änderung aus.
- **Verzeichnisbaum** zum gewählten Zeitpunkt. Die Abteilungen sind
  eingeklappt; der Weg zum gewählten und zu den gerade geänderten Objekten ist
  aufgeklappt. Änderungen im Schritt sind markiert, gelöschte Objekte bleiben
  durchgestrichen sichtbar. Optional lassen sich nur die geänderten Objekte
  zeigen.
- **Suche** über alle Schritte: nach DN, uid, Name oder Mail. Gefunden werden
  auch frühere DNs, alte Namen (z. B. vor einer Heirat) und gelöschte Objekte.
- **Objektansicht:**
  - Sprünge zur vorigen und nächsten Änderung des Objekts (auch mit
    Umschalt + ← →) mit Positionsanzeige („Änderung 3 von 7“)
  - Zustand nach dem gewählten Schritt; Änderungen gegenüber dem vorherigen
    Schritt sind hervorgehoben (+ neu, − entfernt). Große Gruppen zeigen nur
    die geänderten Mitglieder, der Rest ist aufklappbar.
  - DN-Verlauf bei Umbenennungen und Verschiebungen
  - Zeitleiste der Ereignisse mit Datei und Zeile, Änderungsübersicht und
    Original-LDIF. Bei langen Verläufen sieht man nur die Ereignisse um den
    aktuellen Schritt.
  - DN-Verweise (`member`, `manager`, …) sind anklickbar. Zeigt ein Verweis
    ins Leere, wird er markiert.
- **Objektidentität:** Ein Objekt bleibt bei `modrdn`/`moddn` dasselbe, auch
  wenn es nur mit seinem übergeordneten Eintrag verschoben wird. Wird ein
  gelöschter DN später neu angelegt, entsteht ein neues Objekt, so wie im
  Verzeichnis eine neue `entryUUID` vergeben wird. Beide Objekte sind
  miteinander verlinkt.
- **Abgelehnte Datensätze:** Datensätze, die ein LDAP-Server zurückweisen
  würde, werden nicht angewendet und aufgelistet. Beispiele: `add` auf einen
  vorhandenen Eintrag, `delete` eines fehlenden Werts, Änderung an einem
  gelöschten Eintrag. Ein `modify` ist dabei atomar: Schlägt eine Operation
  fehl, gilt der ganze Datensatz als abgelehnt.
- Passwörter werden standardmäßig maskiert.
- Die Adresse merkt sich Schritt und Objekt (`#schritt=42&dn=…`), so lassen
  sich Links auf einen bestimmten Zustand teilen.

## Beispieldaten

Im Ordner `ldif/` liegt ein fiktives Firmenverzeichnis `dc=beispiel,dc=de`:

- `0000_2025-01-01_basis.ldif`: vollständiger Export mit 150 Personen in 8
  Abteilungen, 17 Gruppen und 4 Dienstkonten. Das Format entspricht einem
  `slapcat`-Export (Nicht-ASCII-Werte als Base64).
- 300 Änderungsdateien vom 03.01. bis 19.12.2025, benannt nach dem Muster
  `NNNN_JJJJ-MM-TT_HHMM_art_objekt.ldif`. Jede Datei hat einen Anlass für ein
  Hauptobjekt und enthält bei Bedarf die passenden Gruppenänderungen. Die
  Dateien sind wie für `ldapmodify` geschrieben (UTF-8 direkt), oben steht
  jeweils ein Kommentar mit Zeitpunkt und Anlass.

Enthaltene Arten von Änderungen:

- Neue User (mit Gruppen), Löschungen, Austritte (Verschieben nach
  `ou=Ehemalige` und Sperren), Löschung nach Aufbewahrungsfrist, Rückkehr aus
  `ou=Ehemalige`
- Abteilungswechsel (`moddn`), Namensänderungen (teils mit neuer uid per
  `modrdn`); die Gruppen werden jeweils auf den neuen DN umgestellt
- Neue Funktion, Durchwahl, Diensthandy, Raum, Mail-Alias, Teilzeit,
  Passwort-Resets (auch für Dienstkonten)
- Gruppenbeitritte und -austritte, neue Gruppen, eine gelöschte Gruppe
- Neuanlage unter dem DN eines früher gelöschten Kontos (neues Objekt)
- Vier absichtlich fehlerhafte Dateien, die der Server ablehnen würde
  (markiert mit `# Hinweis: Dieser Datensatz wird vom Server abgelehnt.`)

### Eigene Dateien verwenden

Die Dateiliste ist fest hinterlegt, in [`js/dateien.js`](js/dateien.js). Für
eigene Daten die Dateien in `ldif/` ablegen und dort mit Zeitpunkt und Titel
eintragen. Die Reihenfolge der Liste ist die Abspielreihenfolge, die erste
Datei ist der Ausgangszustand. Ein Test prüft, dass die Liste und der
Ordnerinhalt übereinstimmen.

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

### Zwischenspeicher

GitHub Pages erlaubt Browsern, Dateien bis zu 10 Minuten zwischenzuspeichern.
Damit nach einem Update keine alten Skripte mit neuen Dateien gemischt werden,
hängen alle CSS- und JS-Adressen in `index.html` eine Versionsnummer an
(`?v=…`). Die Oberfläche hängt dieselbe Nummer auch an die LDIF-Dateien. **Bei
jeder Änderung an CSS, JS oder LDIF-Dateien die Nummer in `index.html` an allen
Stellen erhöhen.**

## Tests

```bash
npm test
```

Die Tests laufen mit dem eingebauten Test-Runner von Node (ab Version 18) und
brauchen keine Abhängigkeiten. Sie prüfen den Parser, die DN-Behandlung und
die Replay-Logik. Bei den Beispieldaten prüfen sie außerdem: Die Dateiliste
passt, nur die markierten Datensätze werden abgelehnt, und in keinem Schritt
zeigt ein DN-Verweis ins Leere. Die GitHub Action
`.github/workflows/tests.yml` führt die Tests bei jedem Push aus.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html` | Seite |
| `css/style.css` | Styles (hell/dunkel nach Systemeinstellung) |
| `js/ldif.js` | LDIF-Parser (RFC 2849) und DN-Hilfsfunktionen |
| `js/historie.js` | Abspielen der Dateien, Objekt-Ereignisse und Zustände je Schritt |
| `js/dateien.js` | Fest hinterlegte Liste der LDIF-Dateien |
| `js/app.js` | Oberfläche |
| `ldif/` | Beispieldaten |
| `tests/` | Tests für Node |

## Grenzen

- Kein Schema-Wissen: Werte werden ohne Beachtung von Groß-/Kleinschreibung
  verglichen. Ausnahmen sind `userPassword` (exakt) und DN-Attribute
  (DN-normalisiert).
- Serverseitige Nebeneffekte wie `refint` oder `memberOf` werden nicht
  nachgebildet. Es zählt nur, was in den LDIF-Dateien steht.
- `:<`-Verweise auf externe Dateien werden als Text angezeigt, nicht geladen.
- Alle Dateien werden beim Öffnen geladen und komplett abgespielt. Bei 300
  Dateien dauert das etwa eine Sekunde, bei sehr vielen Dateien entsprechend
  länger.
