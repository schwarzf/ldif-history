/*
 * Oberfläche: Zeitregler, Änderungsprotokoll, Verzeichnisbaum und Objekt-Historie.
 * Die Dateiliste kommt aus js/dateien.js (window.LDIF_DATEIEN).
 */
(function () {
  'use strict';

  const ORDNER = 'ldif/';

  const OP_TEXT = {
    add: 'Angelegt',
    delete: 'Gelöscht',
    modify: 'Geändert',
    modrdn: 'Umbenannt',
    moved: 'Mitverschoben',
    rejected: 'Abgelehnt',
  };
  /** Filter im Änderungsprotokoll: Art -> passende Operationen des Hauptereignisses. */
  const ARTEN = [
    { key: 'add', text: 'Neu', ops: ['add'] },
    { key: 'modify', text: 'Geändert', ops: ['modify'] },
    { key: 'modrdn', text: 'Verschoben/umbenannt', ops: ['modrdn', 'moved'] },
    { key: 'delete', text: 'Gelöscht', ops: ['delete'] },
    { key: 'rejected', text: 'Abgelehnt', ops: ['rejected'] },
  ];
  const PASSWORT_ATTRS = new Set(['userpassword']);
  const SUCH_ATTRS = new Set(['cn', 'uid', 'mail', 'displayname', 'sn', 'givenname', 'ou']);
  /** Ab so vielen Ereignissen zeigt die Objekt-Zeitleiste nur einen Ausschnitt. */
  const VERLAUF_FENSTER = 5;

  const $ = id => document.getElementById(id);

  let h = null;
  const ui = {
    step: 0,
    sel: null,
    tab: 'protokoll',
    query: '',
    protokollQuery: '',
    arten: new Set(),       // leer = alle Arten
    nurObjekt: false,
    nurGeaendert: false,
    passwoerter: false,
    hervorheben: true,
    verlaufAlle: false,
    klapp: new Map(),       // Objekt-ID -> true (offen) / false (zu), überschreibt die Vorgabe
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

  /** „2025-03-14 10:32“ -> „14.03.2025 10:32“ */
  function zeitText(zeit) {
    if (!zeit) return '';
    const [datum, uhr] = zeit.split(' ');
    const [j, m, t] = datum.split('-');
    return t + '.' + m + '.' + j + (uhr && uhr !== '00:00' ? ' ' + uhr : '');
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

  /** Eintrag eines Objekts zum Schritt s, sonst der letzte davor, sonst der erste überhaupt. */
  function bekannterEintrag(id, s) {
    const r = h.lastEntry(id, s) || h.lastEntry(id, h.steps.length - 1);
    return r ? r.entry : null;
  }

  function objektStatus(o, s) {
    if (s < o.created) return { text: 'noch nicht angelegt (ab ' + schrittText(o.created) + ')', art: 'zukunft' };
    if (o.deleted !== null && s >= o.deleted) return { text: 'gelöscht in ' + schrittText(o.deleted), art: 'geloescht' };
    return { text: 'vorhanden', art: 'da' };
  }

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

  /** Art eines Schritts für Filter und Anzeige. */
  function schrittArt(step) {
    if (!step.haupt) return step.warnings.length ? 'rejected' : null;
    return ARTEN.find(a => a.ops.includes(step.haupt.op)).key;
  }

  /** Scrollt nur den Listen-Container (nicht die ganze Seite), bis das Element sichtbar ist. */
  function inSicht(container, element) {
    const c = container.getBoundingClientRect();
    const e = element.getBoundingClientRect();
    if (e.top < c.top) container.scrollTop -= c.top - e.top + 8;
    else if (e.bottom > c.bottom) container.scrollTop += e.bottom - c.bottom + 8;
  }

  // ---------- Steuerung ----------

  function setStep(s) {
    ui.step = Math.max(0, Math.min(h.steps.length - 1, s));
    render();
  }

  function waehle(id, s) {
    ui.sel = id;
    ui.verlaufAlle = false;
    if (s !== undefined) ui.step = Math.max(0, Math.min(h.steps.length - 1, s));
    render();
  }

  function zeigeTab(tab) {
    ui.tab = tab;
    $('tab-protokoll').setAttribute('aria-selected', String(tab === 'protokoll'));
    $('tab-baum').setAttribute('aria-selected', String(tab === 'baum'));
    $('protokoll-panel').hidden = tab !== 'protokoll';
    $('baum-panel').hidden = tab !== 'baum';
    if (tab === 'protokoll') markiereProtokoll(true);
    else renderBaum();
  }

  /** Vorige/nächste Änderung des gewählten Objekts relativ zum aktuellen Schritt. */
  function objektSchritte(o) {
    return [...new Set(o.events.map(ev => ev.step))];
  }

  function springeObjekt(richtung) {
    if (ui.sel === null) return;
    const schritte = objektSchritte(h.objects[ui.sel]);
    const ziel = richtung < 0
      ? schritte.filter(s => s < ui.step).pop()
      : schritte.find(s => s > ui.step);
    if (ziel !== undefined) setStep(ziel);
  }

  // ---------- Zeitleiste ----------

  function renderZeit() {
    const regler = $('regler');
    regler.max = h.steps.length - 1;
    regler.value = ui.step;
    const st = h.steps[ui.step];
    $('zaehler').textContent = schrittText(ui.step) + ' von ' + (h.steps.length - 1);
    $('zurueck').disabled = ui.step === 0;
    $('vor').disabled = ui.step === h.steps.length - 1;
    $('zeit-info').replaceChildren(...[
      el('span', { class: 'zeit-datum', text: zeitText(st.zeit) }),
      st.index === 0 ? el('span', { class: 'marke m-neutral', text: 'Ausgangszustand' }) : st.haupt ? marke(st.haupt) : null,
      st.warnings.length && schrittArt(st) !== 'rejected'
        ? el('span', { class: 'marke m-rejected', text: '⚠ ' + st.warnings.length + ' abgelehnt' }) : null,
      el('span', { class: 'zeit-titel', text: st.titel || st.name }),
      el('span', { class: 'zeit-datei', text: st.name }),
    ].filter(Boolean));
  }

  // ---------- Änderungsprotokoll ----------

  function protokollSchritte() {
    const q = ui.protokollQuery.trim().toLowerCase();
    const objektSet = ui.nurObjekt && ui.sel !== null ? new Set(objektSchritte(h.objects[ui.sel])) : null;
    return h.steps.filter(step => {
      if (objektSet && !objektSet.has(step.index)) return false;
      if (ui.arten.size && !ui.arten.has(schrittArt(step))) return false;
      if (q) {
        const text = (step.titel + '\n' + step.name + '\n' + step.events.map(ev => ev.dnAfter || ev.dnBefore).join('\n')).toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
  }

  function renderFilter() {
    $('art-filter').replaceChildren(...ARTEN.map(a => {
      const anzahl = h.steps.filter(st => schrittArt(st) === a.key).length;
      return el('button', {
        type: 'button',
        class: 'filter-knopf f-' + a.key,
        'aria-pressed': String(ui.arten.has(a.key)),
        onclick: () => {
          ui.arten.has(a.key) ? ui.arten.delete(a.key) : ui.arten.add(a.key);
          renderFilter();
          renderProtokoll();
        },
      }, a.text, el('span', { class: 'anzahl', text: anzahl }));
    }));
  }

  function renderProtokoll() {
    const liste = protokollSchritte();
    const gesamt = h.steps.length - 1;
    const gefiltert = ui.arten.size || ui.protokollQuery.trim() || (ui.nurObjekt && ui.sel !== null);
    $('protokoll-titel').textContent = gefiltert
      ? liste.length + ' von ' + (gesamt + 1) + ' Schritten'
      : gesamt + ' Änderungen plus Ausgangszustand';
    $('protokoll').replaceChildren(...liste.map(step => {
      const haupt = step.haupt;
      const obj = haupt ? h.objects[haupt.objectId] : null;
      return el('li', { 'data-step': step.index },
        el('button', {
          type: 'button',
          class: 'eintrag',
          onclick: () => {
            if (obj && !ui.nurObjekt) waehle(obj.id, step.index);
            else setStep(step.index);
          },
        },
        el('span', { class: 'eintrag-kopf' },
          el('span', { class: 'nr', text: '#' + step.index }),
          el('span', { class: 'eintrag-zeit', text: zeitText(step.zeit) }),
          step.index === 0 ? el('span', { class: 'marke m-neutral', text: 'Ausgangszustand' }) : haupt ? marke(haupt) : null,
          step.warnings.length && schrittArt(step) !== 'rejected' ? el('span', { class: 'marke m-rejected', text: '⚠' }) : null),
        el('span', { class: 'eintrag-titel', text: step.titel || step.name })));
    }));
    markiereProtokoll(true);
  }

  /** Markiert den aktuellen Schritt im Protokoll, ohne die Liste neu aufzubauen. */
  function markiereProtokoll(scrollen) {
    const liste = $('protokoll');
    const alt = liste.querySelector('[aria-current]');
    if (alt) alt.removeAttribute('aria-current');
    const neu = liste.querySelector('li[data-step="' + ui.step + '"] > button');
    if (neu) {
      neu.setAttribute('aria-current', 'step');
      if (scrollen && !$('protokoll-panel').hidden) inSicht(liste, neu);
    }
  }

  // ---------- Baum ----------

  function ereignisseImSchritt(s) {
    const m = new Map();
    for (const ev of h.steps[s].events) {
      const alt = m.get(ev.objectId);
      if (!alt || Historie.OP_RANG[ev.op] > Historie.OP_RANG[alt.op]) m.set(ev.objectId, ev);
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
    for (const n of knoten.values()) {
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

  /** Normalisierte DNs aller Vorfahren der gegebenen DNs. */
  function vorfahren(dns) {
    const set = new Set();
    for (let dn of dns) {
      while ((dn = Ldif.parentDn(dn))) set.add(Ldif.normDn(dn));
    }
    return set;
  }

  function renderBaum() {
    if (ui.tab !== 'baum') return;
    const baum = $('baum');
    const s = ui.step;
    if (ui.query.trim()) {
      renderSuche(baum);
      return;
    }
    // Im Ausgangszustand ist alles „angelegt“ – das wäre keine hilfreiche Markierung.
    const geaendert = s === 0 ? new Map() : ereignisseImSchritt(s);
    const wurzeln = baueBaum(s);
    $('baum-titel').textContent = h.stateAt(s).size + ' Einträge nach ' + schrittText(s) +
      (geaendert.size ? ' · ' + geaendert.size + ' betroffen' : '');

    // Standardmäßig sind nur die oberen Ebenen offen, dazu der Weg zum gewählten
    // und zu den in diesem Schritt geänderten Objekten.
    const ziele = [];
    if (ui.sel !== null) {
      const e = bekannterEintrag(ui.sel, s);
      if (e) ziele.push(e.dn);
    }
    for (const ev of geaendert.values()) ziele.push(ev.dnAfter || ev.dnBefore);
    const aufWeg = vorfahren(ziele);

    const sichtbar = n => !ui.nurGeaendert || geaendert.has(n.id) || n.kinder.some(sichtbar);

    const zeichne = (liste, tiefe) => {
      const ul = el('ul');
      for (const n of liste) {
        if (!sichtbar(n)) continue;
        const ev = geaendert.get(n.id);
        const vorgabe = tiefe < 2 || aufWeg.has(Ldif.normDn(n.entry.dn));
        const offen = ui.nurGeaendert || (ui.klapp.has(n.id) ? ui.klapp.get(n.id) : vorgabe);
        const rdn = Ldif.rdnOf(n.entry.dn);
        const name = anzeigeName(n.entry);
        const zeigeName = Ldif.parseRdn(rdn)[0].value !== name;
        const zeile = el('div', { class: 'knoten' + (n.geist ? ' geist' : '') },
          n.kinder.length
            ? el('button', {
              type: 'button', class: 'klapp', 'aria-expanded': String(offen),
              'aria-label': offen ? 'Zuklappen' : 'Aufklappen',
              text: offen ? '▾' : '▸',
              onclick: () => { ui.klapp.set(n.id, !offen); renderBaum(); },
            })
            : el('span', { class: 'klapp-leer' }),
          el('button', {
            type: 'button', class: 'wahl', title: n.entry.dn,
            'aria-current': ui.sel === n.id ? 'true' : null,
            onclick: () => waehle(n.id),
          },
          el('span', { class: 'rdn', text: rdn }),
          zeigeName ? el('span', { class: 'name', text: name }) : null),
          n.kinder.length && !offen ? el('span', { class: 'kinderzahl', text: n.kinder.length }) : null,
          ev ? marke(ev) : null);
        const li = el('li', null, zeile);
        if (n.kinder.length && offen) li.append(zeichne(n.kinder, tiefe + 1));
        ul.append(li);
      }
      return ul;
    };
    baum.replaceChildren(zeichne(wurzeln, 0));
    const aktiv = baum.querySelector('.wahl[aria-current]');
    if (aktiv) inSicht(baum, aktiv);
  }

  function renderSuche(baum) {
    const q = ui.query.trim().toLowerCase();
    const treffer = h.objects.filter(o => suchText(o).includes(q));
    $('baum-titel').textContent = treffer.length + ' Treffer über alle Schritte (auch frühere DNs, alte Namen und gelöschte Objekte)';
    baum.replaceChildren(el('ul', { class: 'treffer' }, treffer.slice(0, 200).map(o => {
      const e = bekannterEintrag(o.id, ui.step);
      const st = objektStatus(o, ui.step);
      return el('li', null, el('button', {
        type: 'button',
        'aria-current': ui.sel === o.id ? 'true' : null,
        onclick: () => waehle(o.id),
      },
      el('span', { class: 'dn', text: e.dn }),
      el('span', { class: 'status', text: anzeigeName(e) + ' · ' + st.text + ' · ' +
        o.events.length + (o.events.length === 1 ? ' Ereignis' : ' Ereignisse') })));
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
      const reihe = el('tr', d ? { class: 'geaendert' } : null, el('th', { scope: 'row', text: a.name }));
      // Große Gruppen: ohne Änderung nur die Anzahl der Werte, aufklappbar.
      if (a.values.length > 12 && !d) {
        reihe.append(el('td', null, el('details', null,
          el('summary', { text: a.values.length + ' Werte' }), zellen)));
      } else if (a.values.length > 12) {
        const geaendert = zellen.filter(z => z.classList.contains('neu') || z.classList.contains('alt'));
        const rest = zellen.filter(z => !geaendert.includes(z));
        reihe.append(el('td', null, geaendert, el('details', null,
          el('summary', { text: 'weitere ' + rest.length + ' Werte' }), rest)));
      } else {
        reihe.append(el('td', null, zellen));
      }
      tbody.append(reihe);
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
        (ev.op === 'add' && ev.step === 0 ? ' (aus dem Ausgangszustand)' : '') });
    }
    if (!ev.changes.length) {
      return ev.op === 'modify' ? el('p', { class: 'hinweis', text: 'Keine effektive Änderung' }) : null;
    }
    return el('ul', { class: 'aenderungen' }, ev.changes.map(c => el('li', null,
      el('span', { class: 'a', text: c.attr + ': ' }),
      c.removed.map(v => el('span', { class: 'minus', text: '− ' + wertText(c.attr, v) + ' ' })),
      c.added.map(v => el('span', { class: 'plus', text: '+ ' + wertText(c.attr, v) + ' ' })))));
  }

  function ereignisEintrag(ev) {
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
          text: '#' + ev.step + ' · ' + zeitText(step.zeit) }),
        marke(ev),
        el('span', { class: 'datei', text: ev.file + ':' + ev.line })),
      step.titel ? el('p', { class: 'ereignis-titel', text: step.titel }) : null,
      ev.op === 'rejected'
        ? el('p', { class: 'fehler', text: '„' + ev.rejectedOp + '“ abgelehnt: ' + ev.message + ' – nicht angewendet.' })
        : null,
      dnZeile,
      via,
      ev.op === 'rejected' ? null : aenderungsListe(ev),
      el('details', null, el('summary', { text: 'LDIF-Datensatz' }), el('pre', { class: 'ldif', text: quellText(ev.source) }))));
  }

  function verlauf(o) {
    const events = o.events;
    if (ui.verlaufAlle || events.length <= 2 * VERLAUF_FENSTER + 2) {
      return el('ol', { class: 'verlauf' }, events.map(ereignisEintrag));
    }
    // Lange Verläufe (z. B. große Gruppen): nur die Ereignisse um den aktuellen Schritt.
    let mitte = events.findIndex(ev => ev.step >= ui.step);
    if (mitte < 0) mitte = events.length - 1;
    const von = Math.max(0, mitte - VERLAUF_FENSTER);
    const bis = Math.min(events.length, mitte + VERLAUF_FENSTER + 1);
    const alle = () => { ui.verlaufAlle = true; renderDetail(); };
    return el('div', null,
      von > 0 ? el('button', { type: 'button', class: 'mehr', onclick: alle, text: von + ' frühere Ereignisse anzeigen' }) : null,
      el('ol', { class: 'verlauf' }, events.slice(von, bis).map(ereignisEintrag)),
      bis < events.length ? el('button', { type: 'button', class: 'mehr', onclick: alle, text: (events.length - bis) + ' spätere Ereignisse anzeigen' }) : null);
  }

  function objektNavigation(o) {
    const schritte = objektSchritte(o);
    const vorher = schritte.filter(s => s < ui.step);
    const nachher = schritte.filter(s => s > ui.step);
    const hier = schritte.includes(ui.step);
    let pos;
    if (hier) pos = 'Änderung ' + (vorher.length + 1) + ' von ' + schritte.length;
    else if (!vorher.length) pos = 'vor der ersten von ' + schritte.length + ' Änderungen';
    else if (!nachher.length) pos = 'nach der letzten von ' + schritte.length + ' Änderungen';
    else pos = 'zwischen Änderung ' + vorher.length + ' und ' + (vorher.length + 1) + ' von ' + schritte.length;
    return el('div', { class: 'objekt-nav' },
      el('button', { type: 'button', disabled: !vorher.length, title: 'Vorige Änderung dieses Objekts (Umschalt + ←)',
        onclick: () => springeObjekt(-1) }, '◀ Vorige Änderung'),
      el('span', { class: 'objekt-pos', text: pos }),
      el('button', { type: 'button', disabled: !nachher.length, title: 'Nächste Änderung dieses Objekts (Umschalt + →)',
        onclick: () => springeObjekt(1) }, 'Nächste Änderung ▶'));
  }

  function renderDetail() {
    const box = $('detail');
    if (ui.sel === null || !h.objects[ui.sel]) {
      box.replaceChildren(el('div', { class: 'leer' },
        el('p', null, 'Eine Änderung im Protokoll anklicken oder ein Objekt im Verzeichnis wählen.'),
        el('p', null, 'Mit dem Regler oben oder den Pfeiltasten ← → durch die Schritte gehen; ',
          'mit Umschalt + ← → zur vorigen/nächsten Änderung des gewählten Objekts.')));
      return;
    }
    const s = ui.step;
    const o = h.objects[ui.sel];
    const entry = h.entryAt(o.id, s);
    const st = objektStatus(o, s);
    const zuletzt = entry || bekannterEintrag(o.id, s);
    const evJetzt = o.events.filter(ev => ev.step === s);

    const teile = [];
    teile.push(el('div', { class: 'detail-kopf' },
      el('h2', { text: anzeigeName(zuletzt) }),
      el('span', { class: 'marke ' + (st.art === 'geloescht' ? 'm-delete' : 'm-neutral'), text: st.text }),
      evJetzt.map(marke)));
    teile.push(el('p', { class: 'detail-dn', text: zuletzt.dn }));
    teile.push(objektNavigation(o));

    if (st.art === 'zukunft') {
      teile.push(el('p', { class: 'meldung info' }, 'Dieses Objekt existiert in ' + schrittText(s) + ' noch nicht.',
        el('button', { type: 'button', text: 'Zu ' + schrittText(o.created), onclick: () => setStep(o.created) })));
    } else if (st.art === 'geloescht') {
      teile.push(el('p', { class: 'meldung del' }, 'Gelöscht in ' + schrittText(o.deleted) + ' (' + zeitText(h.steps[o.deleted].zeit) + '). Unten steht der letzte Zustand vor dem Löschen.'));
    }
    for (const p of o.previous) {
      teile.push(el('p', { class: 'meldung info' }, 'Unter diesem DN gab es früher ein anderes Objekt: ',
        el('button', { type: 'button', class: 'link', text: 'früheres Objekt anzeigen', onclick: () => waehle(p) })));
    }
    for (const n of o.successors) {
      teile.push(el('p', { class: 'meldung info' }, 'Unter diesem DN wurde in ' + schrittText(h.objects[n].created) + ' ein neues Objekt angelegt: ',
        el('button', { type: 'button', class: 'link', text: 'neues Objekt anzeigen', onclick: () => waehle(n, h.objects[n].created) })));
    }
    for (const ev of evJetzt.filter(ev => ev.op === 'rejected')) {
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

    teile.push(el('h3', { text: 'Verlauf (' + o.events.length + (o.events.length === 1 ? ' Ereignis)' : ' Ereignisse)') }));
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
      el('button', { type: 'button', class: 'link', text: '#' + w.step + ' · ' + w.file + ':' + w.line,
        onclick: () => { if (w.objectId !== null && w.objectId !== undefined) waehle(w.objectId, w.step); else setStep(w.step); } }),
      ' – ', w.message, w.dn ? el('div', { class: 'dn', text: w.dn }) : null)));
  }

  // ---------- Adresse (#schritt=…&dn=…&objekt=…) ----------

  function schreibeHash() {
    const p = new URLSearchParams();
    p.set('schritt', ui.step);
    if (ui.sel !== null) {
      const e = bekannterEintrag(ui.sel, ui.step);
      if (e) p.set('dn', e.dn);
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

  let letzteAuswahl = null;

  function render() {
    renderZeit();
    // Die Liste hängt nur dann vom gewählten Objekt ab, wenn danach gefiltert wird.
    if (ui.nurObjekt && ui.sel !== letzteAuswahl) renderProtokoll();
    else markiereProtokoll(true);
    letzteAuswahl = ui.sel;
    renderBaum();
    renderDetail();
    renderDatei();
    schreibeHash();
  }

  function zeitHoehe() {
    document.documentElement.style.setProperty('--zeit-h', document.querySelector('.zeit').offsetHeight + 'px');
  }

  async function lade() {
    const dateien = window.LDIF_DATEIEN || [];
    const texte = [];
    // In kleinen Paketen laden, damit der Browser nicht hunderte Anfragen gleichzeitig stellt.
    for (let i = 0; i < dateien.length; i += 25) {
      const paket = dateien.slice(i, i + 25);
      texte.push(...await Promise.all(paket.map(async d => {
        const r = await fetch(ORDNER + d.name);
        if (!r.ok) throw new Error(d.name + ': HTTP ' + r.status);
        return Object.assign({ text: await r.text() }, d);
      })));
      $('zaehler').textContent = 'Lade ' + texte.length + ' von ' + dateien.length + ' Dateien …';
    }
    return Historie.build(texte);
  }

  function verbinde() {
    $('regler').addEventListener('input', e => setStep(parseInt(e.target.value, 10)));
    $('zurueck').addEventListener('click', () => setStep(ui.step - 1));
    $('vor').addEventListener('click', () => setStep(ui.step + 1));
    $('tab-protokoll').addEventListener('click', () => zeigeTab('protokoll'));
    $('tab-baum').addEventListener('click', () => zeigeTab('baum'));
    $('suche').addEventListener('input', e => { ui.query = e.target.value; renderBaum(); });
    $('nur-geaendert').addEventListener('change', e => { ui.nurGeaendert = e.target.checked; renderBaum(); });
    $('protokoll-suche').addEventListener('input', e => { ui.protokollQuery = e.target.value; renderProtokoll(); });
    $('nur-objekt').addEventListener('change', e => { ui.nurObjekt = e.target.checked; renderProtokoll(); });
    document.addEventListener('keydown', e => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type !== 'checkbox' || t instanceof HTMLTextAreaElement) return;
      const pfeil = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!pfeil) return;
      if (e.shiftKey) springeObjekt(pfeil);
      else setStep(ui.step + pfeil);
      e.preventDefault();
    });
    window.addEventListener('hashchange', () => { leseHash(); render(); });
    window.addEventListener('resize', zeitHoehe);
  }

  lade().then(ergebnis => {
    h = ergebnis;
    leseHash();
    verbinde();
    renderWarnungen();
    renderFilter();
    renderProtokoll();
    zeigeTab('protokoll');
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
