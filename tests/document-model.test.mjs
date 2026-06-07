// tests/document-model.test.mjs
// Unit tests for the two-layer document model primitives that need no DB:
//   * content hashing (normalisation + idempotency semantics)
//   * chunkText overlap (Phase 1 fix to the previously-dead overlap param)
//
// Run with:
//   node --import ./scripts/reclassify/_preload-env.mjs --test tests/document-model.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeText, hashChunk, hashDocument } = await import('../lib/content-hash.js');
const { chunkText } = await import('../tools/storage.js');

describe('content-hash', () => {
  it('normalises whitespace so trivial differences do not defeat the hash', () => {
    assert.equal(normalizeText('a   b\n\nc\t d'), 'a b c d');
    assert.equal(hashChunk('hello   world'), hashChunk('hello\nworld'));
    assert.equal(hashChunk('  trimmed  '), hashChunk('trimmed'));
  });

  it('different content yields different chunk hashes', () => {
    assert.notEqual(hashChunk('alpha'), hashChunk('beta'));
  });

  it('document hash binds to tenant: same text, two tenants, two hashes', () => {
    const text = 'the CFTE handover brief, full text here';
    assert.equal(hashDocument(text, 'tenant-A'), hashDocument(text, 'tenant-A'));
    assert.notEqual(hashDocument(text, 'tenant-A'), hashDocument(text, 'tenant-B'));
  });

  it('document hash is stable across whitespace reflow (re-extraction drift)', () => {
    assert.equal(
      hashDocument('para one\n\npara two', 't1'),
      hashDocument('para one   para two', 't1'),
    );
  });
});

describe('chunkText', () => {
  it('keeps a short doc as a single chunk', () => {
    const chunks = chunkText('one paragraph only', 2500, 100);
    assert.equal(chunks.length, 1);
  });

  it('carries an overlap tail across a boundary (overlap is no longer dead)', () => {
    // Two ~30-char paragraphs, size 40 forces a split. The tail of chunk 1 must
    // reappear at the head of chunk 2.
    const p1 = 'alpha bravo charlie delta echo';   // 30 chars
    const p2 = 'foxtrot golf hotel india juliet';  // 31 chars
    const chunks = chunkText(`${p1}\n\n${p2}`, 40, 12);
    assert.ok(chunks.length >= 2, 'should split into at least two chunks');
    const tail = p1.split(' ').pop();              // 'echo'
    assert.ok(chunks[1].includes(tail), `overlap tail "${tail}" should appear in chunk 2: ${chunks[1]}`);
  });

  it('hard-splits a single oversize paragraph into overlapping slices', () => {
    const big = 'x'.repeat(6000);
    const chunks = chunkText(big, 2500, 100);
    assert.ok(chunks.length >= 3, 'a 6000-char paragraph should produce 3+ slices');
    for (const c of chunks) assert.ok(c.length <= 2500, 'no slice exceeds the size budget');
  });

  it('never returns an empty chunk', () => {
    for (const c of chunkText('a\n\n\n\nb\n\n   \n\nc', 2500, 100)) {
      assert.ok(c.trim().length > 0);
    }
  });
});
