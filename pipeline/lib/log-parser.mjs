/* ============================================================================
 * pipeline/lib/log-parser.mjs — parse MLB's official "Scoring Changes" page.
 *
 * Source: https://www.mlb.com/official-information/scoring-changes
 * (prior seasons: Internet Archive snapshots of that same page).
 *
 * The page is a numbered list. Two formats have been observed:
 *   2026:  "001. 3/26 PIT@NYM -- In the bottom of the 3rd inning, ..."
 *   2024/5 "1) 3/27 CLE@KC -- In the top of the 1st inning, ..."
 * plus irregularities that we FLAG rather than silently fix:
 *   - doubleheader suffixes: "CLE2", "SF2", " GM2", " (GM1)"
 *   - stray characters: "BOS@NYY!"
 *   - missing date: "11) LAA@HOU -- ..."
 *   - missing inning, out-of-order dates, name typos (handled downstream).
 *
 * Pure functions only (no I/O) so tests can run offline.
 * ==========================================================================*/

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', hellip: '\u2026', middot: '\u00b7',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Yacute: 'Ý',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù',
  Agrave: 'À', Egrave: 'È', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', yuml: 'ÿ',
  Auml: 'Ä', Euml: 'Ë', Iuml: 'Ï', Ouml: 'Ö', Uuml: 'Ü',
  ntilde: 'ñ', Ntilde: 'Ñ', ccedil: 'ç', Ccedil: 'Ç', atilde: 'ã', otilde: 'õ',
};

export function decodeEntities(input) {
  return String(input || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = NAMED_ENTITIES[code] ?? NAMED_ENTITIES[code.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/** Convert HTML to one-logical-line-per-block plain text. */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(p|div|li|h[1-6]|tr|td|th|section|article|header|footer|ul|ol|table|main|nav|aside|blockquote)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '').replace(/[ \t\u00a0\u2009\u202f]+/g, ' ');
  return s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

const ORDINAL_WORDS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
};

const INNING_NUM_RE = /\b(top|bottom)\s+(?:half\s+)?of\s+the\s+(\d{1,2})\s*(?:st|nd|rd|th)?\b/i;
const INNING_WORD_RE = new RegExp(
  `\\b(top|bottom)\\s+(?:half\\s+)?of\\s+the\\s+(${Object.keys(ORDINAL_WORDS).join('|')})\\b`, 'i');
const INNING_NOHALF_RE = /\bin\s+the\s+(\d{1,2})\s*(?:st|nd|rd|th)\s+inning\b/i;

/** Extract {half, inning} from entry prose. Missing pieces are null. */
export function parseInning(body) {
  const text = String(body || '');
  let m = text.match(INNING_NUM_RE);
  if (m) return { half: m[1].toLowerCase(), inning: Number(m[2]) };
  m = text.match(INNING_WORD_RE);
  if (m) return { half: m[1].toLowerCase(), inning: ORDINAL_WORDS[m[2].toLowerCase()] };
  m = text.match(INNING_NOHALF_RE);
  if (m) return { half: null, inning: Number(m[1]) };
  return { half: null, inning: null };
}

const ENTRY_RE = /^(\d{1,3})\s*[.)]\s*(.+)$/;
// [M/D ]AWAY@HOME[suffix] -- body      (suffix = "2", " GM2", " (GM1)", "!", ...)
const HEAD_RE = /^(?:(\d{1,2})\s*\/\s*(\d{1,2})\s+)?([A-Za-z]{2,3})\s*@\s*([A-Za-z]{2,3})(.*?)\s*(?:--|\u2013|\u2014)\s*(.+)$/;
const SECTION_RE = /^(20\d\d)\s+(regular season|postseason|post-season|playoffs|season|spring training)\b/i;

function pad2(n) { return String(n).padStart(2, '0'); }

/** Interpret a head suffix like "2", " GM2", " (GM1)", "!" → {gameNumber, flags}. */
export function parseSuffix(suffix) {
  const s = String(suffix || '').trim();
  if (!s) return { gameNumber: null, flags: [] };
  const flags = [];
  let gameNumber = null;
  const m = s.match(/^\(?\s*(?:gm|game|g)?\s*([12])\s*\)?$/i);
  if (m) {
    gameNumber = Number(m[1]);
  } else {
    flags.push(`unexpected_suffix:${s}`);
    const d = s.match(/([12])/);
    if (d && /gm|game/i.test(s)) gameNumber = Number(d[1]);
  }
  return { gameNumber, flags };
}

/**
 * Parse one entry line (without needing the section context).
 * Returns null when the line is not a numbered entry.
 */
export function parseEntryLine(line, seasonYear) {
  const m = String(line || '').match(ENTRY_RE);
  if (!m) return null;
  const seq = Number(m[1]);
  const rest = m[2].trim();
  const entry = {
    seq,
    raw: String(line).trim(),
    date: null,
    month: null,
    day: null,
    away: null,
    home: null,
    suffix: '',
    gameNumber: null,
    body: rest,
    half: null,
    inning: null,
    issues: [],
  };
  const h = rest.match(HEAD_RE);
  if (!h) {
    entry.issues.push('unparsed_head');
  } else {
    if (h[1] && h[2]) {
      entry.month = Number(h[1]);
      entry.day = Number(h[2]);
      if (entry.month < 1 || entry.month > 12 || entry.day < 1 || entry.day > 31) {
        entry.issues.push('invalid_date');
      } else if (seasonYear) {
        entry.date = `${seasonYear}-${pad2(entry.month)}-${pad2(entry.day)}`;
      }
    } else {
      entry.issues.push('missing_date');
    }
    entry.away = h[3].toUpperCase();
    entry.home = h[4].toUpperCase();
    entry.suffix = h[5] || '';
    const suf = parseSuffix(entry.suffix);
    entry.gameNumber = suf.gameNumber;
    entry.issues.push(...suf.flags);
    entry.body = h[6].trim();
  }
  const inn = parseInning(entry.body);
  entry.half = inn.half;
  entry.inning = inn.inning;
  if (inn.inning == null) entry.issues.push('missing_inning');
  else if (inn.half == null) entry.issues.push('missing_half');
  if (/&[a-z]+;|&#\d+;/i.test(entry.body)) entry.issues.push('undecoded_entity');
  return entry;
}

/**
 * Parse page text into sections of entries.
 * Only lines that look like log entries (number + "@" matchup or " -- ")
 * are accepted, so stray numbered navigation text cannot leak in.
 */
export function parseLogText(text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  let current = null;
  let pendingHeader = null;
  for (const line of lines) {
    const sm = line.match(SECTION_RE);
    if (sm && line.length < 80) {
      pendingHeader = { label: line.trim(), season: Number(sm[1]) };
      continue;
    }
    const em = line.match(ENTRY_RE);
    if (!em) continue;
    const looksLikeEntry = /@/.test(line) && /(--|\u2013|\u2014)/.test(line);
    if (!looksLikeEntry) continue;
    const seq = Number(em[1]);
    const restart = current && seq <= 1 && current.entries.length > 0;
    if (!current || pendingHeader || restart) {
      const header = pendingHeader || (restart ? { label: null, season: current.season } : { label: null, season: null });
      current = { label: header.label, season: header.season, entries: [], issues: [] };
      sections.push(current);
      pendingHeader = null;
    }
    const entry = parseEntryLine(line, current.season);
    if (entry) current.entries.push(entry);
  }
  for (const sec of sections) {
    if (!sec.label) sec.issues.push('section_without_header');
    const seen = new Map();
    let prev = null;
    for (const e of sec.entries) {
      if (seen.has(e.seq)) sec.issues.push(`duplicate_seq:${e.seq}`);
      seen.set(e.seq, true);
      if (prev != null && e.seq !== prev + 1) sec.issues.push(`seq_gap:${prev}->${e.seq}`);
      prev = e.seq;
    }
  }
  return sections;
}

/** Convenience: HTML → sections. */
export function parseLogHtml(html) {
  return parseLogText(htmlToText(html));
}
