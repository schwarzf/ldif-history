/*
 * LDIF-Parser nach RFC 2849 und Hilfsfunktionen für Distinguished Names.
 *
 * Unterstützt Inhaltsdatensätze und Änderungsdatensätze (add, delete,
 * modify, modrdn/moddn), Zeilenfortsetzung, Kommentare, Base64-Werte (::)
 * und URL-Verweise (:<). Läuft im Browser (window.Ldif) und in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Ldif = api;
})(this, function () {
  'use strict';

  /** Präfix für Werte, die keine gültige UTF-8-Zeichenkette sind (z. B. Fotos). */
  const BINARY_PREFIX = '\u0000base64:';

  function isBinary(value) {
    return typeof value === 'string' && value.startsWith(BINARY_PREFIX);
  }

  function decodeBase64(b64) {
    const clean = b64.replace(/\s+/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Steuerzeichen deuten auf Binärdaten hin, auch wenn sie gültiges UTF-8 sind.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return BINARY_PREFIX + clean;
      return text;
    } catch (e) {
      return BINARY_PREFIX + clean;
    }
  }

  /** Zerlegt den Text in logische Zeilen (Fortsetzungszeilen werden angehängt). */
  function logicalLines(text) {
    const raw = text.replace(/^﻿/, '').split(/\r?\n/);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const l = raw[i];
      const prev = out[out.length - 1];
      if (l.startsWith(' ') && prev && !prev.blank) {
        prev.text += l.slice(1);
        prev.endLine = i + 1;
        continue;
      }
      out.push({ text: l, line: i + 1, endLine: i + 1, blank: l.trim() === '' });
    }
    return out;
  }

  class LdifError extends Error {
    constructor(message, line) {
      super(message);
      this.line = line;
    }
  }

  function parseAttrLine(l) {
    const m = /^([A-Za-z0-9][A-Za-z0-9.;-]*)\s*:(:|<)?\s*(.*)$/.exec(l.text);
    if (!m) throw new LdifError('Zeile ist keine gültige Attributzeile: „' + l.text + '“', l.line);
    let value = m[3];
    if (m[2] === ':') value = decodeBase64(value);
    else if (m[2] === '<') value = '[Verweis: ' + value.trim() + ']';
    return { name: m[1], value: value, line: l.line };
  }

  /**
   * Parst einen LDIF-Text.
   * @returns {{records: object[], errors: {line:number, message:string}[]}}
   */
  function parse(text) {
    const lines = logicalLines(text);
    const rawLines = text.replace(/^﻿/, '').split(/\r?\n/);
    const records = [];
    const errors = [];
    let group = [];
    let first = true;

    function flush() {
      const content = group.filter(l => !l.text.startsWith('#'));
      if (content.length) {
        const start = content[0].line;
        const end = content[content.length - 1].endLine;
        try {
          const rec = parseRecord(content, first);
          if (rec) {
            rec.line = start;
            rec.endLine = end;
            rec.source = rawLines.slice(start - 1, end).join('\n');
            records.push(rec);
          }
        } catch (e) {
          if (!(e instanceof LdifError)) throw e;
          errors.push({ line: e.line || start, message: e.message });
        }
        first = false;
      }
      group = [];
    }

    for (const l of lines) {
      if (l.blank) flush();
      else group.push(l);
    }
    flush();
    return { records, errors };
  }

  function parseRecord(lines, first) {
    let i = 0;
    if (first && /^version\s*:/i.test(lines[0].text)) {
      i++;
      if (i >= lines.length) return null;
    }
    const dnLine = parseAttrLine(lines[i]);
    if (dnLine.name.toLowerCase() !== 'dn') {
      throw new LdifError('Datensatz beginnt nicht mit „dn:“', lines[i].line);
    }
    const rec = { dn: dnLine.value.trim() };
    i++;
    while (i < lines.length && /^control\s*:/i.test(lines[i].text)) i++;

    let changetype = null;
    if (i < lines.length && /^changetype\s*:/i.test(lines[i].text)) {
      changetype = parseAttrLine(lines[i]).value.trim().toLowerCase();
      i++;
    }

    if (changetype === null || changetype === 'add') {
      rec.changetype = 'add';
      rec.content = changetype === null;
      rec.attrs = lines.slice(i).map(parseAttrLine).map(a => ({ name: a.name, value: a.value }));
    } else if (changetype === 'delete') {
      rec.changetype = 'delete';
      if (i < lines.length) throw new LdifError('Nach „changetype: delete“ dürfen keine Attribute folgen', lines[i].line);
    } else if (changetype === 'modrdn' || changetype === 'moddn') {
      rec.changetype = 'modrdn';
      for (; i < lines.length; i++) {
        const a = parseAttrLine(lines[i]);
        const n = a.name.toLowerCase();
        if (n === 'newrdn') rec.newrdn = a.value.trim();
        else if (n === 'deleteoldrdn') rec.deleteoldrdn = a.value.trim() === '1';
        else if (n === 'newsuperior') rec.newsuperior = a.value.trim();
        else throw new LdifError('Unbekanntes Feld „' + a.name + '“ in modrdn', a.line);
      }
      if (!rec.newrdn) throw new LdifError('modrdn ohne „newrdn“', lines[0].line);
      if (rec.deleteoldrdn === undefined) throw new LdifError('modrdn ohne „deleteoldrdn“', lines[0].line);
    } else if (changetype === 'modify') {
      rec.changetype = 'modify';
      rec.mods = [];
      let mod = null;
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (l.text.trim() === '-') {
          if (!mod) throw new LdifError('„-“ ohne vorherige Operation', l.line);
          mod = null;
          continue;
        }
        const a = parseAttrLine(l);
        if (!mod) {
          const op = a.name.toLowerCase();
          if (!['add', 'delete', 'replace', 'increment'].includes(op)) {
            throw new LdifError('Unbekannte modify-Operation „' + a.name + '“', l.line);
          }
          mod = { op: op, attr: a.value.trim(), values: [] };
          rec.mods.push(mod);
        } else {
          if (a.name.toLowerCase() !== mod.attr.toLowerCase()) {
            throw new LdifError('Attribut „' + a.name + '“ passt nicht zur Operation auf „' + mod.attr + '“', l.line);
          }
          mod.values.push(a.value);
        }
      }
    } else {
      throw new LdifError('Unbekannter changetype „' + changetype + '“', lines[0].line);
    }
    return rec;
  }

  // ---------- Distinguished Names ----------

  /** Zerlegt einen DN in seine RDNs (Escapes und Anführungszeichen werden beachtet). */
  function splitDn(dn) {
    const parts = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < dn.length; i++) {
      const c = dn[i];
      if (c === '\\' && i + 1 < dn.length) {
        cur += c + dn[i + 1];
        i++;
      } else if (c === '"') {
        quoted = !quoted;
        cur += c;
      } else if ((c === ',' || c === ';') && !quoted) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.trim() !== '' || parts.length) parts.push(cur.trim());
    return parts.filter(p => p !== '');
  }

  function unescapeValue(v) {
    v = v.trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    const bytes = [];
    const enc = new TextEncoder();
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (c === '\\' && i + 2 < v.length + 1 && /^[0-9a-fA-F]{2}$/.test(v.substr(i + 1, 2))) {
        bytes.push(parseInt(v.substr(i + 1, 2), 16));
        i += 2;
      } else if (c === '\\' && i + 1 < v.length) {
        bytes.push(...enc.encode(v[i + 1]));
        i++;
      } else {
        bytes.push(...enc.encode(c));
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  /** Zerlegt einen RDN in Attribut-Wert-Paare (mehrwertige RDNs mit „+“). */
  function parseRdn(rdn) {
    const pairs = [];
    let cur = '';
    for (let i = 0; i < rdn.length; i++) {
      const c = rdn[i];
      if (c === '\\' && i + 1 < rdn.length) {
        cur += c + rdn[i + 1];
        i++;
      } else if (c === '+') {
        pairs.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    pairs.push(cur);
    return pairs.map(p => {
      const eq = p.indexOf('=');
      if (eq < 0) return { attr: p.trim(), value: '' };
      return { attr: p.slice(0, eq).trim(), value: unescapeValue(p.slice(eq + 1)) };
    });
  }

  function normValue(v) {
    return v.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** Normalisierte Form eines DN zum Vergleichen (Groß-/Kleinschreibung, Leerzeichen). */
  function normDn(dn) {
    return splitDn(dn)
      .map(rdn => parseRdn(rdn)
        .map(p => p.attr.toLowerCase() + '=' + normValue(p.value))
        .sort()
        .join('+'))
      .join(',');
  }

  function parentDn(dn) {
    return splitDn(dn).slice(1).join(',');
  }

  function rdnOf(dn) {
    return splitDn(dn)[0] || '';
  }

  return {
    parse, splitDn, parseRdn, normDn, normValue, parentDn, rdnOf,
    decodeBase64, isBinary, BINARY_PREFIX,
  };
});
