# ldif-history

Weboberfläche, mit der sich die Zustände beliebiger LDAP-Objekte durchspielen
lassen. Grundlage ist ein vollständiger LDIF-Export und viele kleine
Änderungs-LDIFs, die nacheinander eingespielt wurden.

Die Seite ist statisch (HTML, CSS und JavaScript ohne Build-Schritt und ohne
Abhängigkeiten) und läuft direkt auf GitHub Pages.

## Funktionen

Im Mittelpunkt stehen die **Objekte**: Man wählt ein Objekt und spielt dann
nur dessen Änderungen auf einem eigenen Zeitstrahl durch.

- **Objekte wählen** (Reiter links):
  - **Objekte:** Liste aller Objekte, die es je gab, auch gelöschter. Sie ist
    durchsuchbar nach Name, uid, Mail oder DN, auch nach früheren Namen und
    DNs. Filter nach Typ (Personen, Gruppen, OUs, Dienstkonten) und Status
    (vorhanden, ehemalig, gelöscht). Sortierbar nach Name, zuletzt geändert
    oder Anzahl der Änderungen.
  - **Verzeichnis:** der LDAP-Baum zum gerade angezeigten Zeitpunkt.
  - **Änderungsprotokoll:** alle Änderungsdateien chronologisch, filterbar
    nach Art und Text. Ein Klick öffnet das betroffene Objekt an dieser
    Stelle.
- **Zeitstrahl des Objekts:**
  - Ein Punkt je Änderung, zeitlich proportional über das Jahr und farbig
    nach Art (angelegt, geändert, verschoben/umbenannt, gelöscht,
    abgelehnt). Der graue Balken zeigt, wie lange das Objekt existiert.
  - Navigation mit ⏮ ◀ ▶ ⏭, per Klick auf einen Punkt oder mit den Tasten
    ← → Pos1 Ende
  - Zu jeder Station gibt es eine Karte: Anlass (Titel der Datei), Datei,
    Änderungen (− alt, + neu), DN-Wechsel, abgelehnte Datensätze,
    Original-LDIF und die ganze Datei. Außerdem sind die übrigen Objekte
    verlinkt, die dieselbe Datei geändert hat (z. B. die Gruppen eines neuen
    Users).
- **Zustand** des Objekts zur gewählten Station mit hervorgehobenen
  Änderungen. Große Gruppen zeigen nur die geänderten Mitglieder, der Rest
  ist aufklappbar.
- **Verweise** (`member`, `manager`, …) sind anklickbar und öffnen das
  verlinkte Objekt **zum gleichen Zeitpunkt**. Liegt dieser zwischen zwei
  Stationen des neuen Objekts, zeigt die Ansicht dessen Stand an diesem Tag
  und einen Sprung zur letzten Änderung davor. Zeigt ein Verweis ins Leere,
  wird er markiert.
- **Objektidentität:** Ein Objekt bleibt bei `modrdn`/`moddn` dasselbe, auch
  wenn es nur mit seinem übergeordneten Eintrag verschoben wird; der
  DN-Verlauf wird angezeigt. Wird ein gelöschter DN später neu angelegt,
  entsteht ein neues Objekt, so wie im Verzeichnis eine neue `entryUUID`
  vergeben wird. Beide Objekte sind miteinander verlinkt.
- **Abgelehnte Datensätze:** Datensätze, die ein LDAP-Server zurückweisen
  würde, werden nicht angewendet und als eigene Station markiert. Beispiele:
  `add` auf einen vorhandenen Eintrag, `delete` eines fehlenden Werts,
  Änderung an einem gelöschten Eintrag. Ein `modify` ist dabei atomar: Schlägt
  eine Operation fehl, gilt der ganze Datensatz als abgelehnt.
- Passwörter werden standardmäßig maskiert.
- Die Adresse merkt sich Objekt und Zeitpunkt (`#dn=…&objekt=…&schritt=…`),
  so lassen sich Links auf einen bestimmten Zustand teilen.

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
