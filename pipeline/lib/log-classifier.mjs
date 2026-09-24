/* ============================================================================
 * pipeline/lib/log-classifier.mjs — classify an official scoring-change entry.
 *
 * Output answers: "what was the play's ruling BEFORE, and what is it AFTER?"
 * Categories for a ruling phrase:
 *   hit, hit+error, error, fc, fc+error, sac, sac+error, out, other
 * A transition is only produced when an explicit template matches:
 *   T1  "<new ruling> ... instead of <old ruling>"
 *   T2  "... originally ruled/scored <old>. This has been changed to <new>"
 *       "The original ruling was <old>"   /   "had been credited with <old>"
 *   T3  "the <old> for/charged to NAME has been changed to <new>"
 *   T4  "NAME now has a <hit>. The error charged to X remains ..."
 * Anything else is `unclassified` (non-play changes such as earned runs,
 * RBIs, assists, SB/DI, WP/PB are recognised and labelled as such).
 * Every result records the rule id and phrases used, so each label can be
 * checked by hand against the official text.
 * ==========================================================================*/

// Remove periods that do not end sentences (initials, Jr./Sr./St.), so that
// "J.P. Crawford" or "LaMonte Wade Jr." cannot split a sentence.
// "Jr."/"Sr." still END a sentence when a typical sentence opener follows
// (official text: "... first baseman LaMonte Wade Jr. As a result, ...").
const SENTENCE_OPENERS = '(?:As|This|The|That|It|He|His|Both|All|One|Two|Three|Also|Additionally|Therefore|Thus)\\b';
const SUFFIX_MID_RE = new RegExp(`\\b(Jr|Sr)\\.(?!\\s+${SENTENCE_OPENERS})`, 'g');

function protectAbbreviations(text) {
  return String(text || '')
    .replace(SUFFIX_MID_RE, '$1')
    .replace(/\b(St|Mr|Dr|vs|No|Ft)\./g, '$1')
    .replace(/\b([A-Z])\.(?=\s?[A-Z])/g, '$1')
    .replace(/\b([A-Z])\.\s/g, '$1 ');
}

export function splitSentences(text) {
  return protectAbbreviations(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HIT_RE = /\b(single|singles|singled|double|doubles|doubled|triple|triples|tripled|home run|homer|homered|base hit|infield hit|bunt hit|a hit)\b/i;
const NOT_HIT_RE = /\b(double play|double-play|triple play|triple-play|double switch|hit by (a )?pitch|hit into)\b/gi;
const ERROR_RE = /\b(error|errors|E[1-9]|missed catch|dropped catch|dropped throw|dropped fly|muffed)\b/i;
const FC_RE = /\bfielder'?s'?\s+choice\b|\bfielders\s+choice\b|\bfielders'\s+choice\b|\bFC\b/i;
const SAC_RE = /\bsac(rifice)?\b|\bSAC\b/i;
const OUT_RE = /\b(ground ?out|groundout|grounded out|fly ?out|flyout|flied out|line ?out|lineout|lined out|pop ?out|popout|popped out|force ?out|forceout|forced out|out)\b/i;

/** Categorise one ruling phrase. */
export function categorize(phrase) {
  const p = String(phrase || '').replace(NOT_HIT_RE, ' ');
  const hit = HIT_RE.test(p);
  const error = ERROR_RE.test(p);
  const fc = FC_RE.test(p);
  const sac = SAC_RE.test(p);
  const out = OUT_RE.test(p);
  if (fc && error) return 'fc+error';
  if (sac && error) return 'sac+error';
  if (hit && error) return 'hit+error';
  if (fc) return 'fc';
  if (sac) return 'sac';
  if (hit) return 'hit';
  if (error) return 'error';
  if (out) return 'out';
  return 'other';
}

/** Hit type named in a phrase (for single ↔ double style changes). */
export function hitType(phrase) {
  const p = String(phrase || '').replace(NOT_HIT_RE, ' ').toLowerCase();
  if (/\bhome run|\bhomer/.test(p)) return 'home_run';
  if (/\btripl/.test(p)) return 'triple';
  if (/\bdoubl/.test(p)) return 'double';
  if (/\bsingl|base hit|infield hit|bunt hit|\ba hit\b/.test(p)) return 'single';
  return null;
}

const INNING_PREFIX_RE = /^\s*in the (top|bottom)\s+(half\s+)?of the [^,]+?inning,?\s*/i;

function stripInningPrefix(sentence) {
  return String(sentence || '').replace(INNING_PREFIX_RE, '');
}

function trimPhrase(p) {
  return String(p || '').replace(/^[\s,;:]+|[\s,;:.]+$/g, '').trim();
}

/** Non-play ("bookkeeping") change detection when no transition template fires. */
function bookkeepingKind(text) {
  const t = String(text || '').toLowerCase();
  if (/defensive indifference|stolen base|caught stealing|\bsteal/.test(t)) return 'baserunning';
  if (/wild pitch|passed ball/.test(t)) return 'wild_pitch_passed_ball';
  if (/\bassist|\bputout|put-out|put out\b/.test(t)) return 'fielding_credit';
  if (/\brbi\b|run batted in|runs batted in/.test(t)) return 'rbi';
  if (/\bunearned|\bearned\b/.test(t)) return 'earned_run';
  if (/error .*has been removed|error .*removed/.test(t)) return 'error_removed';
  if (/\bwin\b|\bloss\b|\bsave\b|\bhold\b|blown save/.test(t)) return 'pitching_decision';
  return 'unclassified';
}

/**
 * Classify an entry body.
 * @returns {{kind:string, initial:string|null, final:string|null,
 *   initialHitType:string|null, finalHitType:string|null,
 *   rule:string|null, oldPhrase:string|null, newPhrase:string|null,
 *   transition:string|null}}
 */
export function classifyEntry(body) {
  const sentences = splitSentences(body);
  const result = {
    kind: 'unclassified', initial: null, final: null,
    initialHitType: null, finalHitType: null,
    rule: null, oldPhrase: null, newPhrase: null, transition: null,
  };
  const finish = (rule, oldPhrase, newPhrase) => {
    result.rule = rule;
    result.oldPhrase = trimPhrase(oldPhrase);
    result.newPhrase = trimPhrase(newPhrase);
    result.initial = categorize(result.oldPhrase);
    result.final = categorize(result.newPhrase);
    result.initialHitType = hitType(result.oldPhrase);
    result.finalHitType = hitType(result.newPhrase);
    result.transition = `${result.initial}->${result.final}`;
    result.kind = 'ruling_change';
    return result;
  };

  // T1: "<new> instead of <old>"
  for (const s of sentences) {
    const body1 = stripInningPrefix(s);
    const idx = body1.search(/\binstead of\b/i);
    if (idx < 0) continue;
    const newPhrase = body1.slice(0, idx);
    const oldPhrase = body1.slice(idx).replace(/^instead of\s*/i, '');
    if (categorize(oldPhrase) === 'other' && categorize(newPhrase) === 'other') continue;
    return finish('T1', oldPhrase, newPhrase);
  }

  // T3: "the <old> for/charged to/by NAME has been changed to <new>"
  for (const s of sentences) {
    const m = stripInningPrefix(s).match(/\bthe\s+(.+?)\s+(?:for|charged to|by|on)\s+.+?\s+(?:has|have|had)\s+been\s+changed\s+to\s+(.+)$/i);
    if (m && categorize(m[1]) !== 'other') return finish('T3', m[1], m[2]);
  }

  // T2: originally ruled/scored ... / original ruling was ... / had been credited with ...
  for (let i = 0; i < sentences.length; i += 1) {
    const s = sentences[i];
    const m = s.match(/\b(?:was\s+)?originally\s+(?:ruled|scored|called)\s+(?:as\s+)?(.+?)(?:\.\s*$|$)/i)
      || s.match(/\bthe\s+original\s+ruling\s+was\s+(.+?)(?:\.\s*$|$)/i)
      || s.match(/\bhad\s+(?:originally\s+)?been\s+(?:credited\s+with|scored(?:\s+as)?|ruled(?:\s+as)?)\s+(.+?)(?:\.\s*$|$)/i)
      || s.match(/\bthe\s+play\s+had\s+been\s+scored\s+(.+?)(?:\.\s*$|$)/i);
    if (!m) continue;
    let oldPhrase = m[1];
    // The old phrase may itself contain "... . This has been changed to <new>"
    const inline = oldPhrase.match(/^(.+?)\.\s*this\s+(?:has\s+been|was)\s+changed\s+to\s+(.+)$/i);
    if (inline) return finish('T2', inline[1], inline[2]);
    // "changed to" in the following sentence
    const next = sentences[i + 1] || '';
    const cm = next.match(/\b(?:this|it|that|the\s+(?:play|ruling))\s+(?:has\s+been|was|is\s+now)\s+changed\s+to\s+(.+?)(?:\.\s*$|$)/i);
    if (cm) return finish('T2', oldPhrase, cm[1]);
    // Otherwise the new ruling is the main clause of the previous sentence
    const prev = i > 0 ? stripInningPrefix(sentences[i - 1]) : stripInningPrefix(s.slice(0, m.index));
    if (prev && categorize(prev) !== 'other') {
      oldPhrase = oldPhrase.replace(/^(?:as\s+)?/, '');
      return finish('T2', oldPhrase, prev);
    }
  }

  // T4: "NAME now has a <hit>." + "The error charged to X remains ..."
  const hitSentence = sentences.find((s) => /\bnow\s+(?:has|is credited with|gets)\s+(?:a|an)\s+(?:rbi\s+)?(single|double|triple)\b/i.test(s));
  const remains = sentences.find((s) => /\berror\b.*\bremains\b/i.test(s));
  if (hitSentence && remains) {
    return finish('T4', 'an error (the error remains for other advances)', stripInningPrefix(hitSentence));
  }

  result.kind = bookkeepingKind(body);
  return result;
}

/** Convenience flags used by the model builder. */
export function transitionFlags(c) {
  const init = c && c.initial;
  const fin = c && c.final;
  const isHit = (x) => x === 'hit' || x === 'hit+error';
  return {
    errorToHit: c && c.kind === 'ruling_change' && init === 'error' && isHit(fin),
    hitToError: c && c.kind === 'ruling_change' && isHit(init) && fin === 'error',
    hitTypeChange: c && c.kind === 'ruling_change' && isHit(init) && isHit(fin)
      && c.initialHitType && c.finalHitType && c.initialHitType !== c.finalHitType,
    fcToHit: c && c.kind === 'ruling_change' && (init === 'fc' || init === 'fc+error') && isHit(fin),
    hitToFc: c && c.kind === 'ruling_change' && isHit(init) && (fin === 'fc' || fin === 'fc+error'),
    errorToFc: c && c.kind === 'ruling_change' && init === 'error' && (fin === 'fc' || fin === 'fc+error'),
    errorToError: c && c.kind === 'ruling_change' && init === 'error' && fin === 'error',
  };
}
