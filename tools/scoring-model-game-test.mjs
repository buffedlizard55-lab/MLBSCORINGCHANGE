#!/usr/bin/env node
/* ============================================================================
 * scoring-model-game-test.mjs — the game page's model hook contract.
 *
 * reviews.js renderReviewCard (used by game.html's Challenges & Reviews tab)
 * appends window.MLBScoringModelCard(review) for ✏️ scoring-change and
 * ⚖️ pending cards only; without the hook — or if it throws — the card renders
 * exactly as before. SYNTHETIC review objects.
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeNode(tag) {
  return {
    tag, cls: '', text: '', attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
  };
}
const UI = {
  el: (tag, cls, text, attrs) => {
    const n = makeNode(tag);
    if (cls) n.cls = cls;
    if (text != null) n.text = String(text);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v); });
    return n;
  },
  clear: (n) => { n.children.length = 0; return n; },
};
const windowStub = {};
const context = { window: windowStub, UI, console, module: { exports: {} }, Map, Set, Math, Date, JSON };
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../assets/js/reviews.js', import.meta.url), 'utf8'), context);
const R = windowStub.MLBReviews || context.module.exports;
assert.equal(typeof R.renderReviewCard, 'function');

const find = (node, cls) => (node.cls && node.cls.split(/\s+/).includes(cls) ? node
  : node.children.reduce((acc, c) => acc || find(c, cls), null));
const scoring = {
  typeKey: 'scoring_change', reviewType: 'Scoring Change', outcome: 'changed', outcomeLabel: 'Rescored',
  atBatIndex: 12, halfInning: 'top', inningLabel: 'Top 3rd', reason: 'Field Error → Single',
  initial: { eventType: 'field_error', label: 'Field Error', category: 'error' },
  final: { eventType: 'single', label: 'Single', category: 'hit' },
  description: 'X singles.', initialDescription: 'X reaches on a fielding error.',
};
const pending = { typeKey: 'pending_scoring', reviewType: 'Official Scoring Pending', inProgress: true, outcome: 'in_progress', outcomeLabel: 'Ruling Pending', atBatIndex: 13, description: 'Official Scorer Ruling Pending', pendingCodes: ['os_ruling_pending_primary'] };
const abs = { typeKey: 'abs', reviewType: 'ABS Challenge', outcome: 'overturned', outcomeLabel: 'Overturned', atBatIndex: 14, description: 'Ball' };

// 1. No hook → no model line (unchanged rendering).
assert.equal(find(R.renderReviewCard(scoring), 'feed-model'), null);

// 2. Hook present → appended for scoring + pending, never for other types.
const seen = [];
windowStub.MLBScoringModelCard = (review) => { seen.push(review.typeKey); return UI.el('div', 'feed-model', `model for ${review.typeKey}`); };
assert.ok(find(R.renderReviewCard(scoring), 'feed-model'), 'scoring-change card gets the model line');
assert.ok(find(R.renderReviewCard(pending), 'feed-model'), 'pending card gets the model line');
assert.equal(find(R.renderReviewCard(abs), 'feed-model'), null, 'other cards do not');
assert.deepEqual(seen, ['scoring_change', 'pending_scoring']);

// 3. A throwing hook never breaks the card.
windowStub.MLBScoringModelCard = () => { throw new Error('boom'); };
const card = R.renderReviewCard(scoring);
assert.ok(find(card, 'feed-scoring'), 'card still renders its scoring block');
assert.equal(find(card, 'feed-model'), null);

console.log('scoring-model-game-test: OK');
