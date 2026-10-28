/*
 * Oberfläche: globaler Zeitregler, Verzeichnisbaum und Objekt-Historie.
 */
(function () {
  'use strict';

  /** Fest hinterlegte LDIF-Dateien in Abspielreihenfolge (erste = Ausgangszustand). */
  const DATEIEN = [
    { name: '00-basis.ldif', datum: '2025-01-01', titel: 'Initialer Export' },
    { name: '01-neueinstellungen.ldif', datum: '2025-01-15', titel: 'Neueinstellungen' },
    { name: '02-kontaktdaten-befoerderung.ldif', datum: '2025-02-03', titel: 'Beförderung, Kontaktdaten' },
    { name: '03-abteilungswechsel.ldif', datum: '2025-02-20', titel: 'Abteilungswechsel' },
    { name: '04-namensaenderung.ldif', datum: '2025-03-10', titel: 'Namensänderung' },
    { name: '05-austritte.ldif', datum: '2025-04-01', titel: 'Austritte' },
    { name: '06-umstrukturierung-it.ldif', datum: '2025-05-12', titel: 'Umstrukturierung IT' },
    { name: '07-passwoerter-korrekturen.ldif', datum: '2025-06-30', titel: 'Passwörter, Korrekturen' },
    { name: '08-wiedereinstellung.ldif', datum: '2025-08-15', titel: 'Wiedereinstellungen' },
  ];
  const ORDNER = 'ldif/';

  const OP_TEXT = {
    add: 'Angelegt',
    delete: 'Gelöscht',
    modify: 'Geändert',
    modrdn: 'Umbenannt',
    moved: 'Mitverschoben',
    rejected: 'Abgelehnt',
  };
  /** Wichtigkeit eines Ereignisses für die Markierung im Baum. */
  const OP_RANG = { add: 5, delete: 5, modrdn: 4, moved: 3, modify: 2, rejected: 1 };
  const PASSWORT_ATTRS = new Set(['userpassword']);

  const $ = id => document.getElementById(id);

  let h = null;
  const ui = {
    step: 0,
    sel: null,
    query: '',
    nurGeaendert: false,
    passwoerter: false,
    hervorheben: true,
    zu: new Set(),   // zugeklappte Objekt-IDs im Baum
  };

  // ---------- Hilfsfunktionen ----------

  function el(tag, props, ...kinder) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kind of kinder.flat()) {
      if (kind === null || kind === undefined || kind === false) continue;
      e.append(kind instanceof Node ? kind : String(kind));
    }
    return e;
  }

  function datumText(iso) {
    if (!iso) return '';
    const [j, m, t] = iso.split('-');
    return t + '.' + m + '.' + j;
  }

  function schrittText(s) {
    return 'Schritt ' + s;
  }

  function opText(ev) {
    if (ev.op === 'modrdn') {
      if (ev.moved && ev.renamed) return 'Umbenannt & verschoben';
      if (ev.moved) return 'Verschoben';
      return 'Umbenannt';
    }
    return OP_TEXT[ev.op];
  }

  function marke(ev) {
    return el('span', { class: 'marke m-' + ev.op, text: opText(ev) });
  }

  function wertText(attr, v) {
    if (Ldif.isBinary(v)) {
      const b64 = v.slice(Ldif.BINARY_PREFIX.length);
      return '(Binärdaten, ' + Math.floor(b64.length * 3 / 4) + ' Bytes)';
    }
    if (!ui.passwoerter && PASSWORT_ATTRS.has(attr.toLowerCase())) return '••••••••';
    return v;
  }

  function quellText(text) {
    if (ui.passwoerter) return text;
    return text.replace(/^(userPassword::?)[ \t]*\S.*$/gim, '$1 ••••••••');
  }

  /** Anzeigename eines Eintrags: cn, sonst der RDN-Wert. */
  function anzeigeName(entry) {
    const cn = entry.attrs.get('cn');
    if (cn && cn.values.length) return cn.values[0];
    const p = Ldif.parseRdn(Ldif.rdnOf(entry.dn))[0];
    return p ? p.value : entry.dn;
  }

  const SUCH_ATTRS = new Set(['cn', 'uid', 'mail', 'displayname', 'sn', 'givenname', 'ou']);
  const suchCache = new Map();

  /** Alle DNs und Namenswerte, die ein Objekt je hatte (auch frühere). */
  function suchText(o) {
    if (!suchCache.has(o.id)) {
      const teile = o.dns.slice();
      for (const ev of o.events) {
        for (const c of ev.changes) if (SUCH_ATTRS.has(c.attr.toLowerCase())) teile.push(...c.added);
      }
      suchCache.set(o.id, teile.join('\n').toLowerCase());
    }
    return suchCache.get(o.id);
  }

  function objektStatus(o, s) {
    if (s < o.created) return { text: 'noch nicht angelegt (ab ' + schrittText(o.created) + ')', art: 'zukunft' };
    if (o.deleted !== null && s >= o.deleted) return { text: 'gelöscht in ' + schrittText(o.deleted), art: 'geloescht' };
    return { text: 'vorhanden', art: 'da' };
  }

  // ---------- Steuerung ----------

  function setStep(s) {
    ui.step = Math.max(0, Math.min(h.steps.length - 1, s));
    render();
  }

  function waehle(id, s) {
    ui.sel = id;
    if (s !== undefined) ui.step = s;
    render();
  }

  // ---------- Zeitleiste ----------

  function zahlen(step) {
    const n = { add: 0, delete: 0, modify: 0, move: 0 };
    for (const ev of step.events) {
      if (ev.op === 'add') n.add++;
      else if (ev.op === 'delete') n.delete++;
      else if (ev.op === 'modify') n.modify++;
      else if (ev.op === 'modrdn' || ev.op === 'moved') n.move++;
    }
    return el('span', { class: 'zahlen' },
      n.add ? el('span', { class: 'z-add', title: 'angelegt', text: '+' + n.add }) : null,
      n.modify ? el('span', { class: 'z-mod', title: 'geändert', text: '~' + n.modify }) : null,
      n.move ? el('span', { class: 'z-move', title: 'umbenannt/verschoben', text: '⇄' + n.move }) : null,
      n.delete ? el('span', { class: 'z-del', title: 'gelöscht', text: '−' + n.delete }) : null,
      step.warnings.length ? el('span', { class: 'z-warn', title: 'abgelehnt', text: '⚠' + step.warnings.length }) : null);
  }

  function renderZeit() {
    const regler = $('regler');
    regler.max = h.steps.length - 1;
    regler.value = ui.step;
    const st = h.steps[ui.step];
    $('zaehler').textContent = schrittText(ui.step) + ' von ' + (h.steps.length - 1) + ' · ' + datumText(st.datum);
    $('zurueck').disabled = ui.step === 0;
    $('vor').disabled = ui.step === h.steps.length - 1;

    const liste = $('schritte');
    liste.replaceChildren(...h.steps.map(step => el('li', null,
      el('button', {
        type: 'button',
        'aria-current': step.index === ui.step ? 'step' : null,
        title: step.name,
        onclick: () => setStep(step.index),
      },
      el('span', { class: 'datum', text: step.index + ' · ' + datumText(step.datum) }),
      el('span', { class: 'titel', text: step.titel }),
      zahlen(step)))));
    const aktiv = liste.querySelector('[aria-current]');
    if (aktiv) aktiv.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- Baum ----------

  function ereignisseImSchritt(s) {
    const m = new Map();
    for (const ev of h.steps[s].events) {
      const alt = m.get(ev.objectId);
      if (!alt || OP_RANG[ev.op] > OP_RANG[alt.op]) m.set(ev.objectId, ev);
    }
    return m;
  }

  function baueBaum(s) {
    const knoten = new Map();
    for (const e of h.stateAt(s).values()) {
      knoten.set(Ldif.normDn(e.dn), { id: e.id, entry: e, kinder: [], geist: false });
    }
    // Im aktuellen Schritt gelöschte Objekte bleiben als durchgestrichene Einträge sichtbar.
    for (const ev of h.steps[s].events) {
      if (ev.op === 'delete') {
        const entry = h.entryAt(ev.objectId, s - 1);
        knoten.set('geist:' + ev.objectId, { id: ev.objectId, entry, kinder: [], geist: true });
      }
    }
    const wurzeln = [];
    for (const [k, n] of knoten) {
      const eltern = knoten.get(Ldif.normDn(Ldif.parentDn(n.entry.dn)));
      if (eltern && eltern !== n && !eltern.geist) eltern.kinder.push(n);
      else wurzeln.push(n);
    }
    const sortiere = liste => {
      liste.sort((a, b) => Ldif.rdnOf(a.entry.dn).localeCompare(Ldif.rdnOf(b.entry.dn), 'de'));
      liste.forEach(n => sortiere(n.kinder));
    };
    sortiere(wurzeln);
    return wurzeln;
  }

  function renderBaum() {
    const baum = $('baum');
    const s = ui.step;
    if (ui.query.trim()) {
      renderSuche(baum);
      return;
    }
    // Im Ausgangszustand ist alles „angelegt“ – das wäre keine hilfreiche Markierung.
    const geaendert = s === 0 ? new Map() : ereignisseImSchritt(s);
    const wurzeln = baueBaum(s);
    const anzahl = h.stateAt(s).size;
    $('baum-titel').textContent = anzahl + ' Einträge nach ' + schrittText(s) +
      (geaendert.size ? ' · ' + geaendert.size + ' betroffen' : '');

    const sichtbar = n => !ui.nurGeaendert || geaendert.has(n.id) || n.kinder.some(sichtbar);

    const zeichne = liste => {
      const ul = el('ul');
      for (const n of liste) {
        if (!sichtbar(n)) continue;
        const ev = geaendert.get(n.id);
        const offen = !ui.zu.has(n.id) || ui.nurGeaendert;
        const rdn = Ldif.rdnOf(n.entry.dn);
        const name = anzeigeName(n.entry);
        const zeigeName = Ldif.parseRdn(rdn)[0].value !== name;
        const zeile = el('div', { class: 'knoten' + (n.geist ? ' geist' : '') },
          n.kinder.length
            ? el('button', {
              type: 'button', class: 'klapp', 'aria-expanded': String(offen),
              'aria-label': offen ? 'Zuklappen' : 'Aufklappen',
              text: offen ? '▾' : '▸',
              onclick: () => { ui.zu.has(n.id) ? ui.zu.delete(n.id) : ui.zu.add(n.id); renderBaum(); },
            })
            : el('span', { class: 'klapp-leer' }),
          el('button', {
            type: 'button', class: 'wahl', title: n.entry.dn,
            'aria-current': ui.sel === n.id ? 'true' : null,
            onclick: () => waehle(n.id),
          },
          el('span', { class: 'rdn', text: rdn }),
          zeigeName ? el('span', { class: 'name', text: name }) : null),
          ev ? marke(ev) : null);
        const li = el('li', null, zeile);
        if (n.kinder.length && offen) li.append(zeichne(n.kinder));
        ul.append(li);
      }
      return ul;
    };
    baum.replaceChildren(zeichne(wurzeln));
  }

  function renderSuche(baum) {
    const q = ui.query.trim().toLowerCase();
    const treffer = h.objects.filter(o => suchText(o).includes(q));
    $('baum-titel').textContent = treffer.length + ' Treffer über alle Schritte (auch frühere DNs und gelöschte Objekte)';
    baum.replaceChildren(el('ul', { class: 'treffer' }, treffer.map(o => {
      const r = h.lastEntry(o.id, ui.step) || h.lastEntry(o.id, h.steps.length - 1);
      const st = objektStatus(o, ui.step);
      return el('li', null, el('button', {
        type: 'button',
        'aria-current': ui.sel === o.id ? 'true' : null,
        onclick: () => waehle(o.id),
      },
      el('span', { class: 'dn', text: r.entry.dn }),
      el('span', { class: 'status', text: anzeigeName(r.entry) + ' · ' + st.text +
        (o.dns.length > 1 ? ' · ' + o.dns.length + ' DNs im Verlauf' : '') })));
    })));
  }

  // ---------- Detail ----------

  function dnWert(attr, v, s, aktiv) {
    if (!aktiv || !Historie.DN_ATTRS.has(attr.toLowerCase())) return document.createTextNode(wertText(attr, v));
    const ziel = h.idAt(v, s);
    if (ziel !== undefined) {
      return el('button', { type: 'button', class: 'link', title: 'Objekt anzeigen', text: v, onclick: () => waehle(ziel) });
    }
    return el('span', null, v, ' ',
      el('span', { class: 'baumelt', title: 'Verweist auf einen DN, den es in diesem Schritt nicht gibt', text: '⚠ existiert nicht' }));
  }

  function attributTabelle(entry, vorher, s, vergangen) {
    const diff = ui.hervorheben && vorher !== undefined
      ? Historie.diffEntries(vorher, entry) : [];
    const diffMap = new Map(diff.map(d => [d.attr.toLowerCase(), d]));
    const tbody = el('tbody');
    const keys = [...entry.attrs.keys()];
    keys.sort((a, b) => (b === 'objectclass') - (a === 'objectclass'));
    for (const k of keys) {
      const a = entry.attrs.get(k);
      const d = diffMap.get(k);
      const zellen = a.values.map(v => el('span', { class: 'wert' + (d && d.added.includes(v) ? ' neu' : '') },
        dnWert(a.name, v, s, !vergangen)));
      if (d) for (const v of d.removed) zellen.push(el('span', { class: 'wert alt', text: wertText(a.name, v) }));
      tbody.append(el('tr', null, el('th', { scope: 'row', text: a.name }), el('td', null, zellen)));
    }
    // Komplett entfernte Attribute
    for (const d of diff) {
      if (entry.attrs.has(d.attr.toLowerCase())) continue;
      tbody.append(el('tr', { class: 'weg' }, el('th', { scope: 'row', text: d.attr }),
        el('td', null, d.removed.map(v => el('span', { class: 'wert alt', text: wertText(d.attr, v) })))));
    }
    return el('table', { class: 'attribute' + (vergangen ? ' vergangen' : '') }, tbody);
  }

  function aenderungsListe(ev) {
    if (ev.op === 'add' || ev.op === 'delete') {
      return el('p', { class: 'hinweis', text: ev.changes.length + ' Attribute' +
        (ev.op === 'add' && ev.content ? ' (aus dem Basis-Export)' : '') });
    }
    if (!ev.changes.length) {
      return ev.op === 'modify' ? el('p', { class: 'hinweis', text: 'Keine effektive Änderung' }) : null;
    }
    return el('ul', { class: 'aenderungen' }, ev.changes.map(c => el('li', null,
      el('span', { class: 'a', text: c.attr + ': ' }),
      c.removed.map(v => el('span', { class: 'minus', text: '− ' + wertText(c.attr, v) + ' ' })),
      c.added.map(v => el('span', { class: 'plus', text: '+ ' + wertText(c.attr, v) + ' ' })))));
  }

  function verlauf(o) {
    return el('ol', { class: 'verlauf' }, o.events.map(ev => {
      const klasse = ev.step === ui.step ? 'aktuell' : ev.step > ui.step ? 'zukunft' : '';
      const step = h.steps[ev.step];
      let dnZeile = null;
      if (ev.op === 'modrdn' || ev.op === 'moved') {
        dnZeile = el('p', { class: 'dn-wechsel' }, ev.dnBefore, el('br'), '→ ', ev.dnAfter);
      }
      let via = null;
      if (ev.op === 'moved') {
        const vater = h.objects[ev.via];
        via = el('p', { class: 'hinweis' }, 'durch Umbenennung von ',
          el('button', { type: 'button', class: 'link', text: Ldif.rdnOf(vater.dns[0]), onclick: () => waehle(vater.id, ev.step) }));
      }
      return el('li', { class: klasse }, el('div', { class: 'ereignis' },
        el('div', { class: 'ereignis-kopf' },
          el('button', { type: 'button', title: 'Zu diesem Schritt springen', onclick: () => setStep(ev.step),
            text: schrittText(ev.step) + ' · ' + datumText(step.datum) }),
          marke(ev),
          el('span', { class: 'datei', text: ev.file + ':' + ev.line })),
        ev.op === 'rejected'
          ? el('p', { class: 'fehler', text: '„' + ev.rejectedOp + '“ abgelehnt: ' + ev.message + ' – nicht angewendet.' })
          : null,
        dnZeile,
        via,
        ev.op === 'rejected' ? null : aenderungsListe(ev),
        el('details', null, el('summary', { text: 'LDIF-Datensatz' }), el('pre', { class: 'ldif', text: quellText(ev.source) }))));
    }));
  }

  function renderDetail() {
    const box = $('detail');
    if (ui.sel === null || !h.objects[ui.sel]) {
      box.replaceChildren(el('div', { class: 'leer' },
        el('p', null, 'Ein Objekt im Baum anklicken oder über die Suche finden.'),
        el('p', null, 'Mit dem Regler oben (oder den Pfeiltasten ← →) durch die Schritte gehen.')));
      return;
    }
    const s = ui.step;
    const o = h.objects[ui.sel];
    const entry = h.entryAt(o.id, s);
    const st = objektStatus(o, s);
    const zuletzt = entry || (h.lastEntry(o.id, s) || {}).entry || h.entryAt(o.id, o.created);
    const evJetzt = o.events.filter(ev => ev.step === s);

    const teile = [];
    teile.push(el('div', { class: 'detail-kopf' },
      el('h2', { text: anzeigeName(zuletzt) }),
      el('span', { class: 'marke ' + (st.art === 'da' ? 'm-neutral' : st.art === 'geloescht' ? 'm-delete' : 'm-neutral'), text: st.text }),
      evJetzt.map(marke)));
    teile.push(el('p', { class: 'detail-dn', text: zuletzt.dn }));

    if (st.art === 'zukunft') {
      teile.push(el('p', { class: 'meldung info' }, 'Dieses Objekt existiert in ' + schrittText(s) + ' noch nicht.',
        el('button', { type: 'button', text: 'Zu ' + schrittText(o.created), onclick: () => setStep(o.created) })));
    } else if (st.art === 'geloescht') {
      teile.push(el('p', { class: 'meldung del' }, 'Gelöscht in ' + schrittText(o.deleted) + ' (' + datumText(h.steps[o.deleted].datum) + '). Unten steht der letzte Zustand vor dem Löschen.'));
    }
    for (const p of o.previous) {
      teile.push(el('p', { class: 'meldung info' }, 'Unter diesem DN gab es früher ein anderes Objekt: ',
        el('button', { type: 'button', class: 'link', text: 'früheres Objekt anzeigen', onclick: () => waehle(p) })));
    }
    for (const n of o.successors) {
      teile.push(el('p', { class: 'meldung info' }, 'Unter diesem DN wurde in ' + schrittText(h.objects[n].created) + ' ein neues Objekt angelegt: ',
        el('button', { type: 'button', class: 'link', text: 'neues Objekt anzeigen', onclick: () => waehle(n, h.objects[n].created) })));
    }
    const abgelehnt = evJetzt.filter(ev => ev.op === 'rejected');
    for (const ev of abgelehnt) {
      teile.push(el('p', { class: 'meldung warn' }, 'In diesem Schritt wurde ein Datensatz abgelehnt: ' + ev.message));
    }

    if (o.dns.length > 1) {
      const dnSchritte = o.events.filter(ev => ev.op === 'add' || ev.op === 'modrdn' || ev.op === 'moved');
      teile.push(el('h3', { text: 'DN-Verlauf' }));
      teile.push(el('ol', { class: 'dn-verlauf' }, dnSchritte.map(ev => el('li', null, ev.dnAfter, ' ',
        el('span', { class: 'schritt-hinweis', text: '(ab ' + schrittText(ev.step) + ')' })))));
    }

    teile.push(el('div', { class: 'optionen' },
      el('label', { class: 'schalter' },
        el('input', { type: 'checkbox', checked: ui.hervorheben, onchange: e => { ui.hervorheben = e.target.checked; renderDetail(); } }),
        'Änderungen gegenüber dem vorherigen Schritt hervorheben'),
      el('label', { class: 'schalter' },
        el('input', { type: 'checkbox', checked: ui.passwoerter, onchange: e => { ui.passwoerter = e.target.checked; renderDetail(); renderDatei(); } }),
        'Passwörter anzeigen')));

    if (entry) {
      teile.push(el('h3', { text: 'Zustand nach ' + schrittText(s) }));
      teile.push(attributTabelle(entry, s > 0 ? (h.entryAt(o.id, s - 1) || null) : undefined, s, false));
    } else if (st.art === 'geloescht') {
      teile.push(el('h3', { text: 'Letzter Zustand (vor ' + schrittText(o.deleted) + ')' }));
      teile.push(attributTabelle(zuletzt, undefined, s, true));
    }

    teile.push(el('h3', { text: 'Verlauf (' + o.events.length + ' Ereignisse)' }));
    teile.push(verlauf(o));
    box.replaceChildren(...teile);
  }

  // ---------- Datei und Warnungen ----------

  function renderDatei() {
    const st = h.steps[ui.step];
    $('datei-titel').textContent = 'LDIF-Datei dieses Schritts: ' + st.name + ' (' + st.records + ' Datensätze)';
    $('datei-inhalt').textContent = quellText(st.source);
  }

  function renderWarnungen() {
    const liste = $('warnungen');
    if (!h.warnings.length) {
      liste.replaceChildren(el('li', { text: 'Keine.' }));
      return;
    }
    liste.replaceChildren(...h.warnings.map(w => el('li', null,
      el('button', { type: 'button', class: 'link', text: schrittText(w.step) + ' · ' + w.file + ':' + w.line,
        onclick: () => { if (w.objectId !== null && w.objectId !== undefined) waehle(w.objectId, w.step); else setStep(w.step); } }),
      ' – ', w.message, w.dn ? el('div', { class: 'dn', text: w.dn }) : null)));
  }

  // ---------- Adresse (#schritt=…&dn=…) ----------

  function schreibeHash() {
    const p = new URLSearchParams();
    p.set('schritt', ui.step);
    if (ui.sel !== null) {
      const r = h.lastEntry(ui.sel, ui.step) || h.lastEntry(ui.sel, h.steps.length - 1);
      if (r) p.set('dn', r.entry.dn);
      // Gleicher DN, verschiedene Objekte: die Objektnummer macht die Auswahl eindeutig.
      p.set('objekt', ui.sel);
    }
    const neu = '#' + p.toString();
    if (location.hash !== neu) history.replaceState(null, '', neu);
  }

  function leseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const s = parseInt(p.get('schritt'), 10);
    if (!isNaN(s)) ui.step = Math.max(0, Math.min(h.steps.length - 1, s));
    const oid = parseInt(p.get('objekt'), 10);
    const dn = p.get('dn');
    if (!isNaN(oid) && h.objects[oid] && (!dn || h.objects[oid].dns.some(d => Ldif.normDn(d) === Ldif.normDn(dn)))) {
      ui.sel = oid;
    } else if (dn) {
      const id = h.idAt(dn, ui.step);
      const passend = h.objects.filter(o => o.dns.some(d => Ldif.normDn(d) === Ldif.normDn(dn)));
      ui.sel = id !== undefined ? id : (passend.length ? passend[passend.length - 1].id : null);
    }
  }

  // ---------- Start ----------

  function render() {
    renderZeit();
    renderBaum();
    renderDetail();
    renderDatei();
    schreibeHash();
  }

  function zeitHoehe() {
    document.documentElement.style.setProperty('--zeit-h', document.querySelector('.zeit').offsetHeight + 'px');
  }

  async function lade() {
    const texte = await Promise.all(DATEIEN.map(async d => {
      const r = await fetch(ORDNER + d.name, { cache: 'no-cache' });
      if (!r.ok) throw new Error(d.name + ': HTTP ' + r.status);
      return Object.assign({ text: await r.text() }, d);
    }));
    return Historie.build(texte);
  }

  function verbinde() {
    $('regler').addEventListener('input', e => setStep(parseInt(e.target.value, 10)));
    $('zurueck').addEventListener('click', () => setStep(ui.step - 1));
    $('vor').addEventListener('click', () => setStep(ui.step + 1));
    $('suche').addEventListener('input', e => { ui.query = e.target.value; renderBaum(); });
    $('nur-geaendert').addEventListener('change', e => { ui.nurGeaendert = e.target.checked; renderBaum(); });
    document.addEventListener('keydown', e => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type !== 'checkbox' || t instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowLeft') { setStep(ui.step - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setStep(ui.step + 1); e.preventDefault(); }
    });
    window.addEventListener('hashchange', () => { leseHash(); render(); });
    window.addEventListener('resize', zeitHoehe);
  }

  lade().then(ergebnis => {
    h = ergebnis;
    leseHash();
    verbinde();
    renderWarnungen();
    render();
    zeitHoehe();
  }).catch(err => {
    console.error(err);
    document.querySelector('main').replaceChildren(el('section', { class: 'panel fehlerseite' },
      el('h2', { text: 'Die LDIF-Dateien konnten nicht geladen werden' }),
      el('p', { text: String(err.message || err) }),
      el('p', null, 'Wird die Seite direkt als Datei geöffnet (file://), blockiert der Browser das Laden. ',
        'Bitte über einen Webserver öffnen, z. B. ', el('code', { text: 'python3 -m http.server 8000' }),
        ' und dann ', el('code', { text: 'http://localhost:8000/' }), '.')));
  });
})();
