/*
 * Oberfläche: Objekte wählen (Liste, Verzeichnisbaum, Änderungsprotokoll) und
 * die Änderungen eines Objekts auf seinem eigenen Zeitstrahl durchspielen.
 *
 * Intern ist „Zeit“ immer ein Schritt (Index der LDIF-Datei). Die Stationen
 * eines Objekts sind die Schritte, in denen es sich geändert hat. Wechselt man
 * über einen Verweis zu einem anderen Objekt, bleibt der Schritt erhalten.
 * Die Dateiliste kommt aus js/dateien.js (window.LDIF_DATEIEN).
 */
(function () {
  'use strict';

  const ORDNER = 'ldif/';
  /**
   * Versionsnummer aus der Skript-Adresse (js/app.js?v=…). Sie wird auch an die
   * LDIF-Dateien gehängt, damit der Browser nach einem Update keine alten
   * Dateien aus dem Zwischenspeicher mit neuen mischt.
   */
  const VERSION = new URL(document.currentScript.src).searchParams.get('v') || '';

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
  const TYPEN = [
    { key: 'person', text: 'Personen', einzahl: 'Person' },
    { key: 'gruppe', text: 'Gruppen', einzahl: 'Gruppe' },
    { key: 'ou', text: 'OUs', einzahl: 'OU' },
    { key: 'dienstkonto', text: 'Dienstkonten', einzahl: 'Dienstkonto' },
    { key: 'sonstige', text: 'Sonstige', einzahl: 'Sonstiges' },
  ];
  const STATUS = [
    { key: 'aktiv', text: 'Vorhanden' },
    { key: 'ehemalig', text: 'Ehemalige' },
    { key: 'geloescht', text: 'Gelöscht' },
  ];
  const MONATE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const PASSWORT_ATTRS = new Set(['userpassword']);
  const SUCH_ATTRS = new Set(['cn', 'uid', 'mail', 'displayname', 'sn', 'givenname', 'ou']);

  const $ = id => document.getElementById(id);

  let h = null;
  let letzter = 0;          // Index des letzten Schritts
  let info = [];            // Objekt-ID -> { typ, status, name, aenderungen, zuletzt, stationen }
  const ui = {
    step: 0,
    sel: null,
    tab: 'objekte',
    objektQuery: '',
    typen: new Set(),       // leer = alle
    status: new Set(),      // leer = alle
    sortierung: 'name',
    protokollQuery: '',
    arten: new Set(),       // leer = alle
    passwoerter: false,
    hervorheben: true,
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
        else if (k === 'style') e.setAttribute('style', v);
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kind of kinder.flat(Infinity)) {
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

  function zeitMs(zeit) {
    const [datum, uhr] = (zeit || '').split(' ');
    const ms = Date.parse(datum + 'T' + (uhr || '00:00') + ':00');
    return isNaN(ms) ? 0 : ms;
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

  /** Eintrag eines Objekts zum Schritt s, sonst der letzte davor, sonst der letzte überhaupt. */
  function bekannterEintrag(id, s) {
    const r = h.lastEntry(id, s) || h.lastEntry(id, letzter);
    return r ? r.entry : null;
  }

  /** Kurzform eines DN ohne gemeinsames Suffix: „uid=x · ou=Entwicklung“. */
  function kurzDn(dn) {
    const rdns = Ldif.splitDn(dn);
    return rdns.slice(0, Math.min(2, Math.max(1, rdns.length - 2))).join(' · ');
  }

  function bestimmeTyp(entry) {
    const oc = new Set(((entry.attrs.get('objectclass') || {}).values || []).map(v => v.toLowerCase()));
    if (oc.has('groupofnames') || oc.has('groupofuniquenames') || oc.has('posixgroup')) return 'gruppe';
    if (oc.has('organizationalunit')) return 'ou';
    if (oc.has('person') || oc.has('inetorgperson')) return 'person';
    if (oc.has('account') || oc.has('simplesecurityobject')) return 'dienstkonto';
    return 'sonstige';
  }

  /** Stationen eines Objekts: ein Eintrag je Schritt, in dem es Ereignisse gab. */
  function bildeStationen(o) {
    const stationen = [];
    for (const ev of o.events) {
      let st = stationen[stationen.length - 1];
      if (!st || st.step !== ev.step) {
        st = { step: ev.step, events: [], haupt: ev };
        stationen.push(st);
      }
      st.events.push(ev);
      if (Historie.OP_RANG[ev.op] > Historie.OP_RANG[st.haupt.op]) st.haupt = ev;
    }
    return stationen;
  }

  function berechneInfo() {
    info = h.objects.map(o => {
      const e = bekannterEintrag(o.id, letzter);
      let status = 'aktiv';
      if (o.deleted !== null) status = 'geloescht';
      else if (/(^|,)ou=ehemalige,/.test(Ldif.normDn(e.dn))) status = 'ehemalig';
      const stationen = bildeStationen(o);
      return {
        typ: bestimmeTyp(e),
        status,
        name: anzeigeName(e),
        aenderungen: stationen.filter(st => st.step > 0).length,
        zuletzt: stationen[stationen.length - 1].step,
        stationen,
      };
    });
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

  function filterKnoepfe(container, liste, aktiv, zaehle, neuZeichnen) {
    container.replaceChildren(...liste.map(f => {
      const anzahl = zaehle(f.key);
      if (!anzahl && !aktiv.has(f.key)) return null;
      return el('button', {
        type: 'button',
        class: 'filter-knopf f-' + f.key,
        'aria-pressed': String(aktiv.has(f.key)),
        onclick: () => {
          aktiv.has(f.key) ? aktiv.delete(f.key) : aktiv.add(f.key);
          filterKnoepfe(container, liste, aktiv, zaehle, neuZeichnen);
          neuZeichnen();
        },
      }, f.text, el('span', { class: 'anzahl', text: anzahl }));
    }).filter(Boolean));
  }

  // ---------- Steuerung ----------

  function setStep(s) {
    ui.step = Math.max(0, Math.min(letzter, s));
    render();
  }

  /** Objekt wählen; ohne Schrittangabe bleibt der Zeitpunkt erhalten. */
  function waehle(id, s) {
    ui.sel = id;
    if (s !== undefined) ui.step = Math.max(0, Math.min(letzter, s));
    render();
  }

  /** Objekt aus der Liste wählen: neuester Stand des Objekts. */
  function waehleNeuesten(id) {
    waehle(id, info[id].zuletzt);
    zurAnsicht();
  }

  /** Auf schmalen Bildschirmen steht die Objektansicht unter der Liste: dorthin scrollen. */
  function zurAnsicht() {
    if (window.matchMedia('(max-width: 860px)').matches) $('detail').scrollIntoView({ block: 'start' });
  }

  function zeigeTab(tab) {
    ui.tab = tab;
    for (const t of ['objekte', 'baum', 'protokoll']) {
      $('tab-' + t).setAttribute('aria-selected', String(t === tab));
      $(t + '-panel').hidden = t !== tab;
    }
    if (tab === 'objekte') markiereObjekte(true);
    if (tab === 'baum') renderBaum();
    if (tab === 'protokoll') markiereProtokoll(true);
  }

  function aktuelleStation(id) {
    const st = info[id].stationen;
    let idx = -1;
    for (let i = 0; i < st.length; i++) if (st[i].step <= ui.step) idx = i;
    return idx;
  }

  /** Zur vorigen/nächsten Station des gewählten Objekts springen. */
  function springeStation(richtung) {
    if (ui.sel === null) return;
    const st = info[ui.sel].stationen;
    const schritte = st.map(s => s.step);
    let ziel;
    if (richtung === -Infinity) ziel = schritte[0];
    else if (richtung === Infinity) ziel = schritte[schritte.length - 1];
    else if (richtung < 0) ziel = schritte.filter(s => s < ui.step).pop();
    else ziel = schritte.find(s => s > ui.step);
    if (ziel !== undefined) setStep(ziel);
  }

  // ---------- Objektliste ----------

  function gefilterteObjekte() {
    const q = ui.objektQuery.trim().toLowerCase();
    const liste = h.objects.filter(o => {
      const i = info[o.id];
      if (ui.typen.size && !ui.typen.has(i.typ)) return false;
      if (ui.status.size && !ui.status.has(i.status)) return false;
      return !q || suchText(o).includes(q);
    });
    const vergleich = {
      name: (a, b) => info[a.id].name.localeCompare(info[b.id].name, 'de'),
      zuletzt: (a, b) => info[b.id].zuletzt - info[a.id].zuletzt,
      anzahl: (a, b) => info[b.id].aenderungen - info[a.id].aenderungen,
    }[ui.sortierung];
    return liste.sort((a, b) => vergleich(a, b) || info[a.id].name.localeCompare(info[b.id].name, 'de'));
  }

  function renderObjektFilter() {
    filterKnoepfe($('typ-filter'), TYPEN, ui.typen, k => info.filter(i => i.typ === k).length, renderObjekte);
    filterKnoepfe($('status-filter'), STATUS, ui.status, k => info.filter(i => i.status === k).length, renderObjekte);
  }

  function renderObjekte() {
    const liste = gefilterteObjekte();
    $('objekte-titel').textContent = liste.length === h.objects.length
      ? h.objects.length + ' Objekte (alle, die es je gab)'
      : liste.length + ' von ' + h.objects.length + ' Objekten';
    $('objekte').replaceChildren(...liste.map(o => {
      const i = info[o.id];
      const e = bekannterEintrag(o.id, letzter);
      return el('li', { 'data-id': o.id }, el('button', {
        type: 'button', class: 'objekt', onclick: () => waehleNeuesten(o.id),
      },
      el('span', { class: 'objekt-kopf' },
        el('span', { class: 'objekt-name', text: i.name }),
        i.status === 'geloescht' ? el('span', { class: 'marke m-delete', text: 'gelöscht' }) : null,
        i.status === 'ehemalig' ? el('span', { class: 'marke m-neutral', text: 'ehemalig' }) : null,
        el('span', { class: 'objekt-zahl', title: 'Änderungen nach dem Ausgangszustand',
          text: i.aenderungen ? i.aenderungen + ' Änd.' : '–' })),
      el('span', { class: 'objekt-dn', text: kurzDn(e.dn) })));
    }));
    markiereObjekte(true);
  }

  function markiereObjekte(scrollen) {
    const liste = $('objekte');
    const alt = liste.querySelector('[aria-current]');
    if (alt) alt.removeAttribute('aria-current');
    const neu = ui.sel === null ? null : liste.querySelector('li[data-id="' + ui.sel + '"] > button');
    if (neu) {
      neu.setAttribute('aria-current', 'true');
      if (scrollen && !$('objekte-panel').hidden) inSicht(liste, neu);
    }
  }

  // ---------- Änderungsprotokoll (nachrangig) ----------

  function renderProtokoll() {
    const q = ui.protokollQuery.trim().toLowerCase();
    const liste = h.steps.filter(step => {
      if (ui.arten.size && !ui.arten.has(schrittArt(step))) return false;
      if (q) {
        const text = (step.titel + '\n' + step.name + '\n' + step.events.map(ev => ev.dnAfter || ev.dnBefore).join('\n')).toLowerCase();
        if (!text.includes(q)) return false;
      }
      return true;
    });
    $('protokoll-titel').textContent = liste.length === h.steps.length
      ? letzter + ' Änderungsdateien plus Ausgangszustand'
      : liste.length + ' von ' + h.steps.length + ' Dateien';
    $('protokoll').replaceChildren(...liste.map(step => {
      const haupt = step.haupt;
      return el('li', { 'data-step': step.index },
        el('button', {
          type: 'button',
          class: 'eintrag',
          onclick: () => { if (haupt) { waehle(haupt.objectId, step.index); zurAnsicht(); } else setStep(step.index); },
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

  // ---------- Verzeichnisbaum ----------

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
    const geaendert = s === 0 ? new Map() : ereignisseImSchritt(s);
    const wurzeln = baueBaum(s);
    $('baum-titel').textContent = 'Stand am ' + zeitText(h.steps[s].zeit) + ' (Schritt ' + s + ') · ' +
      h.stateAt(s).size + ' Einträge';

    // Offen sind die oberen Ebenen und der Weg zum gewählten Objekt.
    const ziele = [];
    if (ui.sel !== null) {
      const e = bekannterEintrag(ui.sel, s);
      if (e) ziele.push(e.dn);
    }
    const aufWeg = vorfahren(ziele);

    const zeichne = (liste, tiefe) => {
      const ul = el('ul');
      for (const n of liste) {
        const ev = geaendert.get(n.id);
        const vorgabe = tiefe < 2 || aufWeg.has(Ldif.normDn(n.entry.dn));
        const offen = ui.klapp.has(n.id) ? ui.klapp.get(n.id) : vorgabe;
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
            onclick: () => { waehle(n.id); zurAnsicht(); },
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

  // ---------- Objektansicht: Zeitstrahl ----------

  function zeitstrahl(o) {
    const t0 = zeitMs(h.steps[0].zeit);
    const t1 = zeitMs(h.steps[letzter].zeit);
    const pos = s => (t1 > t0 ? (zeitMs(h.steps[s].zeit) - t0) / (t1 - t0) * 100 : 0);
    const stationen = info[o.id].stationen;
    const aktiv = aktuelleStation(o.id);
    const anStation = aktiv >= 0 && stationen[aktiv].step === ui.step;

    const spur = el('div', { class: 'zs-spur' });
    // Monatsmarken
    const start = new Date(t0);
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) {
      const p = (d.getTime() - t0) / (t1 - t0) * 100;
      if (p < 0) continue;
      spur.append(el('span', { class: 'zs-monat', style: 'left:' + p + '%' }, el('span', { text: MONATE[d.getMonth()] })));
    }
    // Lebensdauer des Objekts
    const ende = o.deleted !== null ? pos(o.deleted) : 100;
    spur.append(el('span', { class: 'zs-leben', style: 'left:' + pos(o.created) + '%;width:' + (ende - pos(o.created)) + '%' }));
    // Aktueller Zeitpunkt (kann zwischen zwei Stationen liegen)
    spur.append(el('span', { class: 'zs-jetzt', style: 'left:' + pos(ui.step) + '%', title: 'Angezeigter Zeitpunkt: ' + zeitText(h.steps[ui.step].zeit) }));
    stationen.forEach((st, i) => {
      const step = h.steps[st.step];
      spur.append(el('button', {
        type: 'button',
        class: 'zs-punkt p-' + st.haupt.op,
        style: 'left:' + pos(st.step) + '%',
        'aria-current': i === aktiv && anStation ? 'step' : null,
        'aria-label': 'Station ' + (i + 1) + ': ' + zeitText(step.zeit) + ' – ' + opText(st.haupt),
        title: zeitText(step.zeit) + ' · ' + opText(st.haupt) + (step.titel ? ' · ' + step.titel : ''),
        onclick: () => setStep(st.step),
      }));
    });

    let pos_text;
    if (aktiv < 0) pos_text = 'vor der ersten Station';
    else if (anStation) pos_text = 'Station ' + (aktiv + 1) + ' von ' + stationen.length;
    else pos_text = 'nach Station ' + (aktiv + 1) + ' von ' + stationen.length;

    const vor = stationen.some(st => st.step > ui.step);
    const zurueck = stationen.some(st => st.step < ui.step);
    return el('div', { class: 'zeitstrahl' },
      el('div', { class: 'zs-rahmen' }, spur),
      el('div', { class: 'zs-steuerung' },
        el('button', { type: 'button', disabled: !zurueck, title: 'Erste Station (Pos1)', 'aria-label': 'Erste Station', onclick: () => springeStation(-Infinity) }, '⏮'),
        el('button', { type: 'button', disabled: !zurueck, title: 'Vorige Station (←)', onclick: () => springeStation(-1) }, '◀ Zurück'),
        el('span', { class: 'zs-position' },
          el('strong', { text: zeitText(h.steps[ui.step].zeit) }), ' · ', pos_text),
        el('button', { type: 'button', disabled: !vor, title: 'Nächste Station (→)', onclick: () => springeStation(1) }, 'Weiter ▶'),
        el('button', { type: 'button', disabled: !vor, title: 'Letzte Station (Ende)', 'aria-label': 'Letzte Station', onclick: () => springeStation(Infinity) }, '⏭')));
  }

  // ---------- Objektansicht: Station und Zustand ----------

  function dnWert(attr, v, s, aktiv) {
    if (!aktiv || !Historie.DN_ATTRS.has(attr.toLowerCase())) return document.createTextNode(wertText(attr, v));
    const ziel = h.idAt(v, s);
    if (ziel !== undefined) {
      return el('button', { type: 'button', class: 'link', title: 'Objekt zum gleichen Zeitpunkt anzeigen', text: v, onclick: () => waehle(ziel) });
    }
    return el('span', null, v, ' ',
      el('span', { class: 'baumelt', title: 'Verweist auf einen DN, den es zu diesem Zeitpunkt nicht gibt', text: '⚠ existiert nicht' }));
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
      // Große Gruppen: nur die geänderten Werte sichtbar, der Rest aufklappbar.
      if (a.values.length > 12) {
        const geaendert = zellen.filter(z => z.classList.contains('neu') || z.classList.contains('alt'));
        const rest = zellen.filter(z => !geaendert.includes(z));
        reihe.append(el('td', null, geaendert, el('details', null,
          el('summary', { text: (geaendert.length ? 'weitere ' : '') + rest.length + ' Werte' }), rest)));
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

  function ereignisDetails(ev) {
    let via = null;
    if (ev.op === 'moved') {
      const vater = h.objects[ev.via];
      via = el('p', { class: 'hinweis' }, 'durch Umbenennung von ',
        el('button', { type: 'button', class: 'link', text: Ldif.rdnOf(vater.dns[0]), onclick: () => waehle(vater.id) }));
    }
    return [
      ev.op === 'rejected'
        ? el('p', { class: 'fehler', text: '„' + ev.rejectedOp + '“ abgelehnt: ' + ev.message + ' – nicht angewendet.' })
        : null,
      ev.op === 'modrdn' || ev.op === 'moved'
        ? el('p', { class: 'dn-wechsel' }, ev.dnBefore, el('br'), '→ ', ev.dnAfter)
        : null,
      via,
      ev.op === 'rejected' ? null : aenderungsListe(ev),
      el('details', null, el('summary', { text: 'LDIF-Datensatz (' + ev.file + ':' + ev.line + ')' }),
        el('pre', { class: 'ldif', text: quellText(ev.source) })),
    ];
  }

  /** Karte zur aktuellen Station: Anlass, Änderungen, LDIF, weitere betroffene Objekte. */
  function stationsKarte(o) {
    const stationen = info[o.id].stationen;
    const idx = aktuelleStation(o.id);
    if (idx < 0) return null;
    const st = stationen[idx];
    const step = h.steps[st.step];

    if (st.step !== ui.step) {
      return el('div', { class: 'station zwischen' },
        el('p', null, 'Angezeigt wird der Stand am ', el('strong', { text: zeitText(h.steps[ui.step].zeit) }),
          '. Die letzte Änderung dieses Objekts davor war am ' + zeitText(step.zeit) + '.'),
        el('button', { type: 'button', onclick: () => setStep(st.step) }, 'Zu dieser Änderung (Station ' + (idx + 1) + ')'));
    }

    // Im Ausgangszustand ist alles „geändert“ – die Liste wäre dort nutzlos.
    const andere = [];
    if (step.index > 0) for (const ev of step.events) {
      if (ev.objectId !== o.id && !andere.includes(ev.objectId)) andere.push(ev.objectId);
    }
    return el('div', { class: 'station' },
      el('div', { class: 'station-kopf' },
        st.events.map(marke),
        el('strong', { class: 'station-titel', text: step.index === 0 ? 'Ausgangszustand' : (step.titel || step.name) })),
      el('p', { class: 'station-datei', text: zeitText(step.zeit) + ' · ' + step.name }),
      st.events.map(ereignisDetails),
      andere.length
        ? el('p', { class: 'station-andere' }, 'In derselben Datei außerdem geändert: ',
          andere.slice(0, 12).map((id, i) => [i ? ', ' : '', el('button', {
            type: 'button', class: 'link', text: info[id].name, onclick: () => waehle(id),
          })]),
          andere.length > 12 ? ' und ' + (andere.length - 12) + ' weitere' : '')
        : null,
      step.index > 0
        ? el('details', null, el('summary', { text: 'Ganze LDIF-Datei anzeigen (' + step.records + ' Datensätze)' }),
          el('pre', { class: 'ldif', text: quellText(step.source) }))
        : null);
  }

  function startSeite() {
    const top = h.objects.filter(o => info[o.id].typ === 'person' || info[o.id].typ === 'gruppe')
      .sort((a, b) => info[b.id].aenderungen - info[a.id].aenderungen).slice(0, 8);
    return el('div', { class: 'leer' },
      el('p', null, 'Links ein Objekt wählen – über die Liste, den Verzeichnisbaum oder das Änderungsprotokoll.'),
      el('p', null, 'Danach lassen sich seine Änderungen auf dem Zeitstrahl durchspielen (← → oder ◀ ▶).'),
      el('h3', { text: 'Objekte mit den meisten Änderungen' }),
      el('ul', { class: 'start-liste' }, top.map(o => el('li', null,
        el('button', { type: 'button', class: 'link', text: info[o.id].name, onclick: () => waehleNeuesten(o.id) }),
        ' – ' + info[o.id].aenderungen + ' Änderungen'))));
  }

  function renderDetail() {
    const box = $('detail');
    if (ui.sel === null || !h.objects[ui.sel]) {
      box.replaceChildren(startSeite());
      return;
    }
    const s = ui.step;
    const o = h.objects[ui.sel];
    const i = info[o.id];
    const entry = h.entryAt(o.id, s);
    const zuletzt = entry || bekannterEintrag(o.id, s);
    const typText = TYPEN.find(t => t.key === i.typ).einzahl;

    const teile = [];
    teile.push(el('div', { class: 'detail-kopf' },
      el('h2', { text: anzeigeName(zuletzt) }),
      el('span', { class: 'marke m-neutral', text: typText }),
      i.status === 'geloescht' ? el('span', { class: 'marke m-delete', text: 'gelöscht am ' + zeitText(h.steps[o.deleted].zeit) }) : null,
      i.status === 'ehemalig' ? el('span', { class: 'marke m-neutral', text: 'ehemalig' }) : null));
    teile.push(el('p', { class: 'detail-dn', text: zuletzt.dn }));
    teile.push(zeitstrahl(o));

    if (s < o.created) {
      teile.push(el('p', { class: 'meldung info' }, 'Am ' + zeitText(h.steps[s].zeit) + ' existiert dieses Objekt noch nicht.',
        el('button', { type: 'button', text: 'Zur Anlage am ' + zeitText(h.steps[o.created].zeit), onclick: () => setStep(o.created) })));
    } else if (o.deleted !== null && s > o.deleted) {
      teile.push(el('p', { class: 'meldung del' }, 'Am ' + zeitText(h.steps[s].zeit) + ' ist dieses Objekt bereits gelöscht.'));
    }
    for (const p of o.previous) {
      teile.push(el('p', { class: 'meldung info' }, 'Unter diesem DN gab es früher ein anderes Objekt: ',
        el('button', { type: 'button', class: 'link', text: info[p].name + ' (früheres Objekt)', onclick: () => waehle(p, info[p].zuletzt) })));
    }
    for (const n of o.successors) {
      teile.push(el('p', { class: 'meldung info' }, 'Unter diesem DN wurde am ' + zeitText(h.steps[h.objects[n].created].zeit) + ' ein neues Objekt angelegt: ',
        el('button', { type: 'button', class: 'link', text: info[n].name + ' (neues Objekt)', onclick: () => waehle(n, h.objects[n].created) })));
    }

    const karte = stationsKarte(o);
    if (karte) teile.push(karte);

    teile.push(el('div', { class: 'optionen' },
      el('label', { class: 'schalter' },
        el('input', { type: 'checkbox', checked: ui.hervorheben, onchange: e => { ui.hervorheben = e.target.checked; renderDetail(); } }),
        'Änderungen hervorheben'),
      el('label', { class: 'schalter' },
        el('input', { type: 'checkbox', checked: ui.passwoerter, onchange: e => { ui.passwoerter = e.target.checked; renderDetail(); } }),
        'Passwörter anzeigen')));

    if (entry) {
      teile.push(el('h3', { text: 'Zustand am ' + zeitText(h.steps[s].zeit) }));
      teile.push(attributTabelle(entry, s > 0 ? (h.entryAt(o.id, s - 1) || null) : undefined, s, false));
    } else if (o.deleted !== null && s >= o.deleted) {
      teile.push(el('h3', { text: 'Letzter Zustand vor dem Löschen' }));
      teile.push(attributTabelle(zuletzt, undefined, s, true));
    }

    if (o.dns.length > 1) {
      const dnSchritte = o.events.filter(ev => ev.op === 'add' || ev.op === 'modrdn' || ev.op === 'moved');
      teile.push(el('h3', { text: 'DN-Verlauf' }));
      teile.push(el('ol', { class: 'dn-verlauf' }, dnSchritte.map(ev => el('li', null, ev.dnAfter, ' ',
        el('span', { class: 'schritt-hinweis', text: '(ab ' + zeitText(h.steps[ev.step].zeit) + ')' })))));
    }

    teile.push(el('details', { class: 'alle-stationen' },
      el('summary', { text: 'Alle ' + i.stationen.length + ' Stationen als Liste' }),
      el('ol', { class: 'stationen-liste' }, i.stationen.map((st, n) => el('li', st.step === s ? { class: 'aktuell' } : null,
        el('button', { type: 'button', class: 'link', onclick: () => setStep(st.step), text: zeitText(h.steps[st.step].zeit) }),
        ' ', marke(st.haupt), ' ',
        h.steps[st.step].index === 0 ? 'Ausgangszustand' : (h.steps[st.step].titel || h.steps[st.step].name))))));

    box.replaceChildren(...teile);
  }

  // ---------- Adresse (#schritt=…&dn=…&objekt=…) ----------

  function schreibeHash() {
    const p = new URLSearchParams();
    if (ui.sel !== null) {
      const e = bekannterEintrag(ui.sel, ui.step);
      if (e) p.set('dn', e.dn);
      // Gleicher DN, verschiedene Objekte: die Objektnummer macht die Auswahl eindeutig.
      p.set('objekt', ui.sel);
    }
    p.set('schritt', ui.step);
    const neu = '#' + p.toString();
    if (location.hash !== neu) history.replaceState(null, '', neu);
  }

  function leseHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const s = parseInt(p.get('schritt'), 10);
    ui.step = isNaN(s) ? letzter : Math.max(0, Math.min(letzter, s));
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
    markiereObjekte(true);
    markiereProtokoll(true);
    renderBaum();
    renderDetail();
    schreibeHash();
  }

  async function lade() {
    const dateien = window.LDIF_DATEIEN || [];
    const texte = [];
    // In kleinen Paketen laden, damit der Browser nicht hunderte Anfragen gleichzeitig stellt.
    for (let i = 0; i < dateien.length; i += 25) {
      const paket = dateien.slice(i, i + 25);
      texte.push(...await Promise.all(paket.map(async d => {
        const r = await fetch(ORDNER + d.name + (VERSION ? '?v=' + VERSION : ''));
        if (!r.ok) throw new Error(d.name + ': HTTP ' + r.status);
        return Object.assign({ text: await r.text() }, d);
      })));
      $('detail').replaceChildren(el('p', { class: 'leer', text: 'Lade ' + texte.length + ' von ' + dateien.length + ' Dateien …' }));
    }
    return Historie.build(texte);
  }

  function verbinde() {
    for (const t of ['objekte', 'baum', 'protokoll']) $('tab-' + t).addEventListener('click', () => zeigeTab(t));
    $('objekt-suche').addEventListener('input', e => { ui.objektQuery = e.target.value; renderObjekte(); });
    $('sortierung').addEventListener('change', e => { ui.sortierung = e.target.value; renderObjekte(); });
    $('protokoll-suche').addEventListener('input', e => { ui.protokollQuery = e.target.value; renderProtokoll(); });
    document.addEventListener('keydown', e => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement && t.type !== 'checkbox' || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      const richtung = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
      if (richtung === undefined || ui.sel === null) return;
      springeStation(richtung);
      e.preventDefault();
    });
    window.addEventListener('hashchange', () => { leseHash(); render(); });
  }

  lade().then(ergebnis => {
    h = ergebnis;
    letzter = h.steps.length - 1;
    berechneInfo();
    leseHash();
    verbinde();
    renderObjektFilter();
    renderObjekte();
    filterKnoepfe($('art-filter'), ARTEN, ui.arten, k => h.steps.filter(st => schrittArt(st) === k).length, renderProtokoll);
    renderProtokoll();
    zeigeTab('objekte');
    render();
  }).catch(err => {
    console.error(err);
    document.querySelector('main').replaceChildren(el('section', { class: 'panel fehlerseite' },
      el('h2', { text: 'Die LDIF-Dateien konnten nicht geladen werden' }),
      el('p', { text: String(err.message || err) }),
      location.protocol === 'file:'
        ? el('p', null, 'Wird die Seite direkt als Datei geöffnet (file://), blockiert der Browser das Laden. ',
          'Bitte über einen Webserver öffnen, z. B. ', el('code', { text: 'python3 -m http.server 8000' }),
          ' und dann ', el('code', { text: 'http://localhost:8000/' }), '.')
        : el('p', null, 'Möglicherweise stammt ein Teil der Seite noch aus dem Zwischenspeicher des Browsers. ',
          'Bitte die Seite neu laden, ohne Zwischenspeicher: Strg+Umschalt+R (Mac: Cmd+Umschalt+R).')));
  });
})();
