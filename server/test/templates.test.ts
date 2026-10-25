import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastText, renderTemplate, wrap } from '../src/templates.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('wraps by words and truncates with an ellipsis', () => {
  assert.deepEqual(wrap('Free whitening for new patients', 15, 3), ['Free whitening', 'for new', 'patients']);
  const t = wrap('one two three four five six seven', 7, 2);
  assert.equal(t.length, 2);
  assert.ok(t[1].endsWith('…'));
});

test('picks readable text color', () => {
  assert.equal(contrastText('#ffffff'), '#111111');
  assert.equal(contrastText('#0f766e'), '#ffffff');
  assert.equal(contrastText('#facc15'), '#111111');
});

test('renders each template and escapes text', () => {
  for (const template of ['bold', 'split', 'photo']) {
    const svg = renderTemplate({ template, headline: 'Tacos <script>alert(1)</script> & more', subline: 'Since "1999"', cta: 'Order now', businessName: 'Joe\'s', photoBase64: PNG });
    assert.ok(svg.startsWith('<svg'));
    assert.ok(!svg.includes('<script>'), `${template}: raw script tag must not appear`);
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.ok(svg.includes('viewBox="0 0 1920 1080"'));
  }
});

test('validates input', () => {
  assert.throws(() => renderTemplate({ template: 'nope', headline: 'x' }), /template must be/);
  assert.throws(() => renderTemplate({ template: 'bold' }), /headline is required/);
  assert.throws(() => renderTemplate({ template: 'bold', headline: 'x', bgColor: 'red' }), /#rrggbb/);
  assert.throws(() => renderTemplate({ template: 'photo', headline: 'x' }), /needs a photo/);
  assert.throws(() => renderTemplate({ template: 'split', headline: 'x', photoBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') }), /PNG, JPEG or WebP/);
});
