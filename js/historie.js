/*
 * Spielt ein Basis-LDIF und Änderungs-LDIFs der Reihe nach ab und merkt sich
 * für jedes Objekt alle Ereignisse sowie den Zustand nach jedem Schritt.
 *
 * Ein Objekt behält seine Identität über Umbenennungen und Verschiebungen
 * hinweg (wie die entryUUID im Verzeichnis). Wird ein gelöschter DN später neu
 * angelegt, entsteht ein neues Objekt.
 *
 * Fehlerhafte Datensätze werden wie vom LDAP-Server abgelehnt: Sie werden nicht
 * angewendet und als Warnung festgehalten.
 */
(function (root, factory) {
  const Ldif = (typeof module === 'object' && module.exports) ? require('./ldif.js') : root.Ldif;
  const api = factory(Ldif);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Historie = api;
})(this, function (Ldif) {
  'use strict';

  /** Attribute, deren Werte DNs sind (werden DN-normalisiert verglichen und verlinkt). */
  const DN_ATTRS = new Set(['member', 'uniquemember', 'manager', 'owner', 'seealso',
    'secretary', 'roleoccupant', 'modifiersname', 'creatorsname']);
  /** Attribute, deren Werte exakt (case-sensitiv) verglichen werden. */
  const EXACT_ATTRS = new Set(['userpassword']);

  function valueKey(attrLower, value) {
    if (Ldif.isBinary(value) || EXACT_ATTRS.has(attrLower)) return value;
    if (DN_ATTRS.has(attrLower)) return Ldif.normDn(value);
    return Ldif.normValue(value);
  }

  class Ablehnung extends Error {}

  // Einträge werden nie verändert, sondern immer kopiert. So bleiben die
  // Zustände früherer Schritte gültig, ohne alles zu kopieren.
  function cloneEntry(e) {
    const attrs = new Map();
    for (const [k, a] of e.attrs) attrs.set(k, { name: a.name, values: a.values.slice() });
    return { id: e.id, dn: e.dn, attrs };
  }

  function addValue(entry, name, value, strict) {
    const k = name.toLowerCase();
    let a = entry.attrs.get(k);
    if (!a) {
      a = { name, values: [] };
      entry.attrs.set(k, a);
    }
    const key = valueKey(k, value);
    if (a.values.some(v => valueKey(k, v) === key)) {
      if (strict) throw new Ablehnung('Wert „' + value + '“ ist in „' + a.name + '“ bereits vorhanden');
      return;
    }
    a.values.push(value);
  }

  function removeValue(entry, name, value, strict) {
    const k = name.toLowerCase();
    const a = entry.attrs.get(k);
    const key = valueKey(k, value);
    const idx = a ? a.values.findIndex(v => valueKey(k, v) === key) : -1;
    if (idx < 0) {
      if (strict) throw new Ablehnung('Wert „' + value + '“ ist in „' + name + '“ nicht vorhanden');
      return;
    }
    a.values.splice(idx, 1);
    if (!a.values.length) entry.attrs.delete(k);
  }

  /** Vergleicht zwei Zustände eines Eintrags (exakter Wertvergleich). */
  function diffEntries(before, after) {
    const keys = [];
    const seen = new Set();
    for (const e of [after, before]) {
      if (!e) continue;
      for (const k of e.attrs.keys()) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
    const changes = [];
    for (const k of keys) {
      const b = before && before.attrs.get(k);
      const a = after && after.attrs.get(k);
      const bv = b ? b.values : [];
      const av = a ? a.values : [];
      const removed = bv.filter(v => !av.includes(v));
      const added = av.filter(v => !bv.includes(v));
      if (removed.length || added.length) {
        changes.push({ attr: (a || b).name, removed, added, kept: av.filter(v => bv.includes(v)) });
      }
    }
    return changes;
  }

  /**
   * @param {{name:string, text:string, datum?:string, titel?:string}[]} files
   *   in Abspielreihenfolge; die erste Datei ist der Ausgangszustand.
   */
  function build(files) {
    const state = new Map();     // id -> Eintrag
    const dnIndex = new Map();   // normalisierter DN -> id
    const objects = [];          // id -> Objekt mit Ereignissen
    const steps = [];
    const snapshots = [];
    const warnings = [];
    const parseErrors = [];
    let eventSeq = 0;

    files.forEach((file, s) => {
      const step = { index: s, name: file.name, datum: file.datum || '', titel: file.titel || '',
        source: file.text, records: 0, events: [], warnings: [] };
      steps.push(step);
      const parsed = Ldif.parse(file.text);
      for (const err of parsed.errors) {
        const w = { step: s, file: file.name, line: err.line, dn: '', message: 'Syntaxfehler: ' + err.message, source: '' };
        parseErrors.push(w);
        warnings.push(w);
        step.warnings.push(w);
      }
      for (const rec of parsed.records) {
        step.records++;
        try {
          apply(rec, s, file);
        } catch (e) {
          if (!(e instanceof Ablehnung)) throw e;
          reject(rec, s, file, e.message);
        }
      }
      snapshots.push(new Map(state));
    });

    function newEvent(objectId, rec, s, file, props) {
      const ev = Object.assign({ id: eventSeq++, objectId, step: s, file: file.name,
        line: rec.line, source: rec.source, changes: [] }, props);
      objects[objectId].events.push(ev);
      steps[s].events.push(ev);
      return ev;
    }

    function reject(rec, s, file, message) {
      const id = dnIndex.get(Ldif.normDn(rec.dn));
      const w = { step: s, file: file.name, line: rec.line, dn: rec.dn, message, source: rec.source,
        objectId: id === undefined ? null : id, op: rec.changetype };
      warnings.push(w);
      steps[s].warnings.push(w);
      if (id !== undefined) {
        newEvent(id, rec, s, file, { op: 'rejected', dnBefore: state.get(id).dn, dnAfter: state.get(id).dn,
          message, rejectedOp: rec.changetype });
      }
    }

    function lookup(dn) {
      const id = dnIndex.get(Ldif.normDn(dn));
      if (id === undefined) throw new Ablehnung('Eintrag „' + dn + '“ existiert nicht');
      return id;
    }

    function hasChildren(norm) {
      for (const k of dnIndex.keys()) if (k.endsWith(',' + norm)) return true;
      return false;
    }

    function apply(rec, s, file) {
      const norm = Ldif.normDn(rec.dn);
      if (rec.changetype === 'add') {
        if (dnIndex.has(norm)) throw new Ablehnung('Eintrag existiert bereits');
        const id = objects.length;
        const entry = { id, dn: rec.dn, attrs: new Map() };
        for (const a of rec.attrs) addValue(entry, a.name, a.value, false);
        const previous = objects.filter(o => o.dns.some(d => Ldif.normDn(d) === norm)).map(o => o.id);
        objects.push({ id, dns: [rec.dn], created: s, deleted: null, events: [], previous, successors: [] });
        for (const p of previous) objects[p].successors.push(id);
        state.set(id, entry);
        dnIndex.set(norm, id);
        newEvent(id, rec, s, file, { op: 'add', dnBefore: null, dnAfter: rec.dn,
          changes: diffEntries(null, entry), content: rec.content });
      } else if (rec.changetype === 'delete') {
        const id = lookup(rec.dn);
        if (hasChildren(norm)) throw new Ablehnung('Eintrag hat Untereinträge und kann nicht gelöscht werden');
        const entry = state.get(id);
        state.delete(id);
        dnIndex.delete(norm);
        objects[id].deleted = s;
        newEvent(id, rec, s, file, { op: 'delete', dnBefore: entry.dn, dnAfter: null,
          changes: diffEntries(entry, null) });
      } else if (rec.changetype === 'modify') {
        const id = lookup(rec.dn);
        const before = state.get(id);
        const work = cloneEntry(before);
        for (const mod of rec.mods) applyMod(work, mod);
        state.set(id, work);
        newEvent(id, rec, s, file, { op: 'modify', dnBefore: before.dn, dnAfter: before.dn,
          changes: diffEntries(before, work) });
      } else if (rec.changetype === 'modrdn') {
        modrdn(rec, s, file, norm);
      }
    }

    function applyMod(entry, mod) {
      const k = mod.attr.toLowerCase();
      if (mod.op === 'add') {
        if (!mod.values.length) throw new Ablehnung('„add: ' + mod.attr + '“ ohne Werte');
        for (const v of mod.values) addValue(entry, mod.attr, v, true);
      } else if (mod.op === 'delete') {
        if (!mod.values.length) {
          if (!entry.attrs.has(k)) throw new Ablehnung('Attribut „' + mod.attr + '“ ist nicht vorhanden');
          entry.attrs.delete(k);
        } else {
          for (const v of mod.values) removeValue(entry, mod.attr, v, true);
        }
      } else if (mod.op === 'replace') {
        // Vorhandenes Attribut an seiner Stelle lassen, damit die Reihenfolge stabil bleibt.
        const a = entry.attrs.get(k);
        if (a && mod.values.length) a.values = [];
        else entry.attrs.delete(k);
        for (const v of mod.values) addValue(entry, mod.attr, v, false);
      } else if (mod.op === 'increment') {
        const a = entry.attrs.get(k);
        if (!a || a.values.length !== 1 || !/^-?\d+$/.test(a.values[0].trim())) {
          throw new Ablehnung('„increment“ braucht genau einen ganzzahligen Wert in „' + mod.attr + '“');
        }
        const delta = parseInt(mod.values[0] || '1', 10);
        a.values = [String(parseInt(a.values[0], 10) + delta)];
      }
    }

    function modrdn(rec, s, file, norm) {
      const id = lookup(rec.dn);
      const before = state.get(id);
      const parent = rec.newsuperior !== undefined ? rec.newsuperior : Ldif.parentDn(before.dn);
      if (rec.newsuperior !== undefined && rec.newsuperior !== '' && !dnIndex.has(Ldif.normDn(rec.newsuperior))) {
        throw new Ablehnung('Neuer übergeordneter Eintrag „' + rec.newsuperior + '“ existiert nicht');
      }
      const newDn = parent ? rec.newrdn + ',' + parent : rec.newrdn;
      const newNorm = Ldif.normDn(newDn);
      if (newNorm !== norm && dnIndex.has(newNorm)) throw new Ablehnung('Ziel „' + newDn + '“ existiert bereits');
      if (newNorm.endsWith(',' + norm)) throw new Ablehnung('Ein Eintrag kann nicht unter sich selbst verschoben werden');

      const work = cloneEntry(before);
      work.dn = newDn;
      const oldPairs = Ldif.parseRdn(Ldif.rdnOf(before.dn));
      const newPairs = Ldif.parseRdn(rec.newrdn);
      for (const p of newPairs) addValue(work, p.attr, p.value, false);
      if (rec.deleteoldrdn) {
        for (const p of oldPairs) {
          const stays = newPairs.some(n => n.attr.toLowerCase() === p.attr.toLowerCase() &&
            valueKey(n.attr.toLowerCase(), n.value) === valueKey(p.attr.toLowerCase(), p.value));
          if (!stays) removeValue(work, p.attr, p.value, false);
        }
      }

      // Untereinträge wandern mit.
      const depth = Ldif.splitDn(before.dn).length;
      const children = [];
      for (const [k, cid] of dnIndex) if (k.endsWith(',' + norm)) children.push([k, cid]);

      dnIndex.delete(norm);
      dnIndex.set(newNorm, id);
      state.set(id, work);
      objects[id].dns.push(newDn);
      const moved = rec.newsuperior !== undefined && Ldif.normDn(rec.newsuperior) !== Ldif.normDn(Ldif.parentDn(before.dn));
      const renamed = Ldif.normDn(rec.newrdn) !== Ldif.normDn(Ldif.rdnOf(before.dn));
      newEvent(id, rec, s, file, { op: 'modrdn', dnBefore: before.dn, dnAfter: newDn,
        changes: diffEntries(before, work), moved, renamed, childCount: children.length });

      for (const [k, cid] of children) {
        const c = state.get(cid);
        const rdns = Ldif.splitDn(c.dn);
        const cw = cloneEntry(c);
        cw.dn = rdns.slice(0, rdns.length - depth).concat(newDn).join(',');
        dnIndex.delete(k);
        dnIndex.set(Ldif.normDn(cw.dn), cid);
        state.set(cid, cw);
        objects[cid].dns.push(cw.dn);
        newEvent(cid, rec, s, file, { op: 'moved', dnBefore: c.dn, dnAfter: cw.dn, via: id });
      }
    }

    const dnCache = new Map();
    /** Index normalisierter DN -> id für den Zustand nach Schritt s. */
    function dnIndexAt(s) {
      if (!dnCache.has(s)) {
        const idx = new Map();
        for (const [id, e] of snapshots[s]) idx.set(Ldif.normDn(e.dn), id);
        dnCache.set(s, idx);
      }
      return dnCache.get(s);
    }

    return {
      steps,
      objects,
      warnings,
      parseErrors,
      /** Zustand nach Schritt s: Map id -> {id, dn, attrs: Map}. */
      stateAt: s => snapshots[s],
      /** Eintrag eines Objekts nach Schritt s (oder undefined). */
      entryAt: (id, s) => (s >= 0 ? snapshots[s].get(id) : undefined),
      /** id des Objekts, das nach Schritt s unter dem DN existiert. */
      idAt: (dn, s) => dnIndexAt(s).get(Ldif.normDn(dn)),
      /** Letzter bekannter Zustand eines Objekts bis einschließlich Schritt s. */
      lastEntry(id, s) {
        for (let i = Math.min(s, snapshots.length - 1); i >= 0; i--) {
          const e = snapshots[i].get(id);
          if (e) return { entry: e, step: i };
        }
        return null;
      },
    };
  }

  return { build, diffEntries, valueKey, DN_ATTRS };
});
