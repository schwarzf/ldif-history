// Ausführen mit: npm test  (oder: node --test tests/*.test.js)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ldif = require('../js/ldif.js');
const Historie = require('../js/historie.js');

const P = 'ou=Personen,dc=beispiel,dc=de';

function baue(...texte) {
  return Historie.build(texte.map((text, i) => ({ name: 'datei' + i + '.ldif', text })));
}

function werte(h, dn, attr, s) {
  const id = h.idAt(dn, s);
  const a = h.entryAt(id, s).attrs.get(attr.toLowerCase());
  return a ? a.values : [];
}

const BASIS = `version: 1

dn: dc=x
objectClass: domain
dc: x

dn: ou=a,dc=x
objectClass: organizationalUnit
ou: a

dn: uid=u1,ou=a,dc=x
objectClass: inetOrgPerson
uid: u1
cn: Erika
 Mustermann
sn:: TcO8bGxlcg==
`;

test('Parser: Fortsetzungszeilen, Base64, Kommentare, version', () => {
  const r = Ldif.parse('# Kommentar\n' + BASIS);
  assert.equal(r.errors.length, 0);
  assert.equal(r.records.length, 3);
  const u = r.records[2];
  assert.equal(u.dn, 'uid=u1,ou=a,dc=x');
  assert.equal(u.content, true);
  assert.deepEqual(u.attrs.find(a => a.name === 'cn').value, 'ErikaMustermann');
  assert.equal(u.attrs.find(a => a.name === 'sn').value, 'Müller');
  assert.equal(u.line, 12);
});

test('Parser: modify mit mehreren Operationen und modrdn', () => {
  const r = Ldif.parse(`dn: uid=u1,ou=a,dc=x
changetype: modify
add: mail
mail: a@x
mail: b@x
-
delete: sn
-
replace: cn
cn: Neu
-

dn: uid=u1,ou=a,dc=x
changetype: moddn
newrdn: uid=u2
deleteoldrdn: 1
newsuperior: dc=x
`);
  assert.equal(r.errors.length, 0);
  assert.deepEqual(r.records[0].mods, [
    { op: 'add', attr: 'mail', values: ['a@x', 'b@x'] },
    { op: 'delete', attr: 'sn', values: [] },
    { op: 'replace', attr: 'cn', values: ['Neu'] },
  ]);
  assert.equal(r.records[1].changetype, 'modrdn');
  assert.equal(r.records[1].newsuperior, 'dc=x');
  assert.equal(r.records[1].deleteoldrdn, true);
});

test('Parser: Syntaxfehler werden gesammelt, nicht geworfen', () => {
  const r = Ldif.parse('dn: dc=x\nchangetype: frobnicate\n\nkein attribut\n');
  assert.equal(r.records.length, 0);
  assert.equal(r.errors.length, 2);
});

test('DN-Normalisierung', () => {
  assert.equal(Ldif.normDn('UID=Foo , OU=Bar,DC=x'), 'uid=foo,ou=bar,dc=x');
  assert.deepEqual(Ldif.splitDn('cn=Müller\\, Hans,dc=x'), ['cn=Müller\\, Hans', 'dc=x']);
  assert.equal(Ldif.parseRdn('cn=Müller\\, Hans')[0].value, 'Müller, Hans');
  assert.equal(Ldif.parseRdn('cn=M\\C3\\BCller')[0].value, 'Müller');
  assert.equal(Ldif.parentDn('uid=a,ou=b,dc=x'), 'ou=b,dc=x');
});

test('Modify ändert nur den neuen Schritt, alte Zustände bleiben erhalten', () => {
  const h = baue(BASIS, `dn: uid=u1,ou=a,dc=x
changetype: modify
replace: cn
cn: Erika Neu
-
add: mail
mail: e@x
-
`);
  assert.deepEqual(werte(h, 'uid=u1,ou=a,dc=x', 'cn', 0), ['ErikaMustermann']);
  assert.deepEqual(werte(h, 'uid=u1,ou=a,dc=x', 'cn', 1), ['Erika Neu']);
  assert.deepEqual(werte(h, 'uid=u1,ou=a,dc=x', 'mail', 1), ['e@x']);
  const id = h.idAt('uid=u1,ou=a,dc=x', 1);
  assert.deepEqual([...h.entryAt(id, 1).attrs.keys()], ['objectclass', 'uid', 'cn', 'sn', 'mail'],
    'replace behält die Position des Attributs');
  const ev = h.steps[1].events[0];
  assert.equal(ev.op, 'modify');
  assert.deepEqual(ev.changes.map(c => c.attr), ['cn', 'mail']);
});

test('Fehlerhafter modify wird komplett abgelehnt', () => {
  const h = baue(BASIS, `dn: uid=u1,ou=a,dc=x
changetype: modify
add: mail
mail: e@x
-
delete: telephoneNumber
telephoneNumber: 123
-
`);
  assert.deepEqual(werte(h, 'uid=u1,ou=a,dc=x', 'mail', 1), []);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.steps[1].events[0].op, 'rejected');
});

test('Umbenennen einer OU verschiebt den Unterbaum, Identität bleibt', () => {
  const h = baue(BASIS, `dn: ou=a,dc=x
changetype: modrdn
newrdn: ou=b
deleteoldrdn: 1
`);
  const id = h.idAt('uid=u1,ou=a,dc=x', 0);
  assert.equal(h.idAt('uid=u1,ou=b,dc=x', 1), id);
  assert.equal(h.idAt('uid=u1,ou=a,dc=x', 1), undefined);
  assert.deepEqual(h.objects[id].dns, ['uid=u1,ou=a,dc=x', 'uid=u1,ou=b,dc=x']);
  assert.deepEqual(werte(h, 'ou=b,dc=x', 'ou', 1), ['b']);
  assert.equal(h.objects[id].events[1].op, 'moved');
});

test('Löschen eines Eintrags mit Kindern wird abgelehnt', () => {
  const h = baue(BASIS, 'dn: ou=a,dc=x\nchangetype: delete\n');
  assert.equal(h.warnings.length, 1);
  assert.notEqual(h.idAt('ou=a,dc=x', 1), undefined);
});

test('Neu angelegter DN nach Löschen ist ein neues Objekt', () => {
  const h = baue(BASIS, 'dn: uid=u1,ou=a,dc=x\nchangetype: delete\n',
    'dn: uid=u1,ou=a,dc=x\nchangetype: add\nobjectClass: inetOrgPerson\nuid: u1\ncn: Neu\nsn: Neu\n');
  const alt = h.idAt('uid=u1,ou=a,dc=x', 0);
  const neu = h.idAt('uid=u1,ou=a,dc=x', 2);
  assert.notEqual(alt, neu);
  assert.equal(h.objects[alt].deleted, 1);
  assert.deepEqual(h.objects[neu].previous, [alt]);
  assert.deepEqual(h.objects[alt].successors, [neu]);
  assert.equal(h.entryAt(alt, 1), undefined);
  assert.equal(h.lastEntry(alt, 2).step, 0);
});

test('Beispieldaten im Repo: alle Dateien laufen durch, nur die beabsichtigten Ablehnungen', () => {
  const ordner = path.join(__dirname, '..', 'ldif');
  const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  const namen = [...app.matchAll(/name: '([^']+\.ldif)'/g)].map(m => m[1]);
  assert.deepEqual(namen, fs.readdirSync(ordner).filter(n => n.endsWith('.ldif')).sort(),
    'Die Liste in js/app.js muss zu den Dateien in ldif/ passen');
  const h = Historie.build(namen.map(name => ({ name, text: fs.readFileSync(path.join(ordner, name), 'utf8') })));
  assert.equal(h.parseErrors.length, 0);
  assert.deepEqual(h.warnings.map(w => w.file + ':' + w.line), [
    '07-passwoerter-korrekturen.ldif:45',
    '07-passwoerter-korrekturen.ldif:54',
  ]);
  const last = h.steps.length - 1;
  const anna = h.idAt('uid=aschmidt,ou=Vertrieb,' + P, last);
  assert.equal(h.idAt('uid=amueller,ou=Vertrieb,' + P, 0), anna);
  assert.deepEqual(werte(h, 'uid=aschmidt,ou=Vertrieb,' + P, 'sn', last), ['Schmidt']);
  const felix = h.objects[h.idAt('uid=fwolf,ou=Plattform,' + P, last)];
  assert.equal(felix.dns.length, 3);
  // Nach allen Schritten zeigen alle DN-Verweise auf existierende Einträge.
  for (const e of h.stateAt(last).values()) {
    for (const a of e.attrs.values()) {
      if (!Historie.DN_ATTRS.has(a.name.toLowerCase())) continue;
      for (const v of a.values) assert.notEqual(h.idAt(v, last), undefined, e.dn + ' ' + a.name + ' ' + v);
    }
  }
});
