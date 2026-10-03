import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLeftoverEntities, readingDocument, readingParts, readingSource } from '../lib/reading-text';
import { htmlToText } from '../lib/html-text';
import { buildEmailDocument, defaultView } from '../components/email-body';

/**
 * The reading view and the fitted original view. The reading view is presentation only:
 * these tests check that words are never changed or dropped, only laid out.
 */

const text = (doc: ReturnType<typeof readingDocument>) => JSON.stringify(doc);

void test('leaked entities are decoded, and only real entities', () => {
  assert.equal(decodeLeftoverEntities('Thanks&nbsp;for&nbsp;the notes &amp; files &#8217;s &#x2014;'), 'Thanks for the notes & files ’s —');
  assert.equal(decodeLeftoverEntities('AT&T and &unknown; stay'), 'AT&T and &unknown; stay');
});

void test('paragraphs reflow hard-wrapped lines but keep deliberate line breaks', () => {
  const wrapped = 'This paragraph was wrapped by an old mail program at a fixed width of\nseventy-two characters, so its lines are long and should be joined back\ntogether into one paragraph for reading on any screen.';
  const doc = readingDocument(`${wrapped}\n\nBest,\nMaya Chen\nNorthstar Labs`);
  const [first, second] = doc.blocks;
  assert.equal(first.kind === 'paragraph' && first.lines.length, 1, 'the wrapped paragraph is one line again');
  assert.equal(second.kind === 'paragraph' && second.lines.length, 3, 'a sign-off keeps its line breaks');
});

void test('lists, headings and preformatted blocks are recognised conservatively', () => {
  const doc = readingDocument('Next steps:\n\n- Review the draft\n- Send comments\n\n1. First\n2. Second\n\n    const x = 1;\n    run(x);\n\nHi Alex,\n\nThanks.');
  const kinds = doc.blocks.map(block => block.kind);
  assert.deepEqual(kinds, ['heading', 'list', 'list', 'preformatted', 'paragraph', 'paragraph']);
  assert.equal(doc.blocks[1].kind === 'list' && doc.blocks[1].ordered, false);
  assert.equal(doc.blocks[2].kind === 'list' && doc.blocks[2].ordered, true);
  assert.equal(doc.blocks[3].kind === 'preformatted' && doc.blocks[3].text.includes('    run(x);'), true, 'code keeps its indentation');
  const aligned = readingDocument('Item        Qty    Price\nSeats       12     $24.00\nSupport     1      $49.00');
  assert.equal(aligned.blocks[0].kind, 'preformatted', 'space-aligned columns are not reflowed');
});

void test('links become compact, and only web links become links', () => {
  const parts = readingParts('Track it (https://carrier.example/track?id=123456789&utm=x) or see http://plain.example/a.');
  assert.deepEqual(parts.map(part => part.kind), ['text', 'link', 'text', 'link', 'text']);
  assert.equal(parts[0].kind === 'text' && parts[0].value, 'Track it ');
  assert.equal(parts[1].kind === 'link' && parts[1].label, 'carrier.example/…');
  assert.equal(parts[3].kind === 'link' && parts[3].href, 'http://plain.example/a');
  assert.equal(parts[4].kind === 'text' && parts[4].value, '.', 'sentence punctuation stays outside the link');
  assert.ok(readingParts('javascript:alert(1) and data:text/html,x').every(part => part.kind === 'text'));
});

void test('a trailing mailing-list footer is folded; anything else is left in place', () => {
  const doc = readingDocument('Your order shipped today and arrives Friday.\n\nQuestions? Reply to this email.\n\nYou are receiving this email because you bought from us. Unsubscribe | Manage preferences\n\nShop Inc, 120 Market Street, Springfield 01101');
  assert.equal(doc.footer.length, 2, 'the footer and the address beside it');
  assert.match(text({ ...doc, footer: [] }), /Questions\? Reply to this email/, 'the message itself is untouched');
  const early = readingDocument('Unsubscribe from our old list here if you like.\n\nThe real message is this paragraph, which comes afterwards.');
  assert.equal(early.footer.length, 0, 'only the very end can be folded');
  const mostlyLegal = readingDocument('Hi.\n\nYou are receiving this email because you signed up for updates, and here is a long legal notice explaining privacy policy, terms of use, all rights reserved, and how to unsubscribe at any time from any of our lists.');
  assert.equal(mostlyLegal.footer.length, 0, 'never fold away most of a message');
});

void test('a verification code above an unsubscribe footer stays visible', () => {
  const doc=readingDocument('Your account was updated.\n\nYour code 482913\n\nUnsubscribe | Privacy policy');
  assert.match(JSON.stringify(doc.blocks),/482913/);
  assert.doesNotMatch(JSON.stringify(doc.footer),/482913/);
});

void test('reading mode retains text after four hundred short paragraphs', () => {
  const doc=readingDocument(`${'Item\n\n'.repeat(450)}Please approve the final item.`);
  assert.match(JSON.stringify(doc.blocks.at(-1)),/Please approve the final item/);
});

void test('malformed active tags are processed in bounded time', () => {
  const input='<svg '.repeat(20000);
  const started=performance.now();
  buildEmailDocument(input);
  assert.ok(performance.now()-started<1000,'an unclosed tag must not repeatedly scan the rest of the message');
});

void test('the reading text keeps table cells apart, without changing the stored text', () => {
  const html = '<p>Thanks for your order.</p><table><tr><th>Item</th><th>Qty</th></tr><tr><td>Seats</td><td>12</td></tr></table><div class="gmail_quote">On Monday Jordan wrote:<blockquote>Old message</blockquote></div>';
  assert.match(htmlToText(html), /ItemQty/, 'the stored text, which fingerprints read, is unchanged');
  const source = readingSource({ html, body: 'unused' });
  assert.match(source, /Item\tQty\nSeats\t12/);
  const doc = readingDocument(source);
  assert.ok(doc.blocks.some(block => block.kind === 'table' && block.rows.length === 2));
  assert.equal(readingSource({ body: 'Plain only' }), 'Plain only');
});

void test('the original view fits wide layouts without breaking words or scaling text', () => {
  const doc = buildEmailDocument('<table width="720"><tr><td><img src="data:image/png;base64,AA" width="720"></td></tr></table>');
  assert.match(doc, /table\{width:auto!important;table-layout:auto!important\}/);
  assert.match(doc, /\[style\*="min-width"\]\{min-width:0!important\}/);
  assert.match(doc, /td,th\{[^}]*word-break:normal!important/, 'cells never break words mid-word');
  assert.match(doc, /@media \(max-width:520px\)\{table:has\(img\)/, 'image layouts stack on a narrow pane');
  assert.doesNotMatch(doc, /zoom|scale\(/, 'nothing is shrunk');
  assert.match(doc, /script-src 'none'/, 'the security policy is unchanged');
});

void test('a bordered “bulletproof” button keeps its sender’s sizing', () => {
  // Bank of America and many senders draw a button as a fixed-width link with thick side
  // borders. Counting those borders inside the width pushed the label off the button.
  const doc = buildEmailDocument('<a href="https://bank.example/pay" style="display:inline-block;border-left:40px solid #0052C2;border-right:40px solid #0052C2;width:240px;line-height:68px">MAKE PAYMENT</a>');
  assert.match(doc, /a,span,font,b,strong,em,i,u\{box-sizing:content-box\}/);
  assert.ok(doc.indexOf('box-sizing:content-box') > doc.indexOf('*,*::before,*::after{box-sizing:border-box}'), 'the exemption comes after the general rule');
});

void test('a designed layout narrower than the pane is centred; plain text is not', () => {
  const doc = buildEmailDocument('<table width="480"><tr><td>Your code is: 586110</td></tr></table>');
  assert.match(doc, /<body><div class="brief-fit"><table/, 'the sender’s markup sits in one wrapper');
  assert.match(doc, /\.brief-fit:has\(table,\[style\*="max-width"\]\)\{width:fit-content;max-width:100%;margin:0 auto\}/,
    'only table and width-capped layouts shrink to their content and centre; nothing can exceed the pane');
});

void test('conversations open as text; designed newsletters keep their layout', () => {
  assert.equal(defaultView({ html: '<p>Could you review the draft?</p>', body: 'Could you review the draft?', category: 'work' }), 'reading');
  assert.equal(defaultView({ html: '<img src=a><img src=b><img src=c><p>Sale</p>', body: 'Sale', category: 'personal' }), 'original');
  assert.equal(defaultView({ html: '<img src=hero><p>Hi</p>', body: 'Hi', category: 'work' }), 'original', 'an image with little text');
  assert.equal(defaultView({ html: '<p>Weekly digest</p>', body: 'Weekly digest', category: 'noise' }), 'original');
  assert.equal(defaultView({ body: 'Plain text only', category: 'work' }), 'reading');
});
