// tests/connectors.test.mjs
// Unit tests for the connector primitives that need no DB:
//   * reversible token encryption (round-trip, tamper-detection, IV uniqueness)
//   * Fireflies transcript → text normalisation (shape, speaker grouping, ids)
//
// Run with:
//   node --import ./scripts/reclassify/_preload-env.mjs --test tests/connectors.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The crypto module resolves its key lazily (first encrypt/decrypt), so setting
// this before the calls is sufficient. Only set if the env didn't already.
process.env.CONNECTOR_ENCRYPTION_KEY ||= 'unit-test-connector-key-passphrase';

const { encryptSecret, decryptSecret, connectorCryptoReady } = await import('../lib/connector-crypto.js');
const { normaliseTranscript } = await import('../lib/connectors/fireflies.js');

describe('connector-crypto', () => {
  it('reports ready when a key is configured', () => {
    assert.equal(connectorCryptoReady(), true);
  });

  it('round-trips a secret through encrypt → decrypt', () => {
    const secret = 'ff_live_3b9d2a1c-secret-api-key';
    const ct = encryptSecret(secret);
    assert.ok(ct.startsWith('v1.'), 'ciphertext is versioned');
    assert.notEqual(ct, secret, 'ciphertext is not the plaintext');
    assert.equal(decryptSecret(ct), secret, 'decrypt recovers the original');
  });

  it('treats null/empty as null in both directions', () => {
    assert.equal(encryptSecret(null), null);
    assert.equal(encryptSecret(''), null);
    assert.equal(decryptSecret(null), null);
    assert.equal(decryptSecret(''), null);
  });

  it('uses a fresh IV each time (same input → different ciphertext, same plaintext)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    assert.notEqual(a, b, 'random IV makes ciphertexts differ');
    assert.equal(decryptSecret(a), 'same-value');
    assert.equal(decryptSecret(b), 'same-value');
  });

  it('detects tampering via the GCM auth tag', () => {
    const ct = encryptSecret('integrity-matters');
    // Flip a character in the base64 payload.
    const flipped = ct.slice(0, -2) + (ct.slice(-2, -1) === 'A' ? 'B' : 'A') + ct.slice(-1);
    assert.throws(() => decryptSecret(flipped));
  });

  it('rejects an unknown ciphertext version', () => {
    assert.throws(() => decryptSecret('v2.AAAA'), /version/i);
  });
});

describe('fireflies normaliseTranscript', () => {
  const sample = {
    id: 'ABC123',
    title: 'Weekly sync',
    date: 1717718400000, // epoch ms → 2024-06-07
    duration: 32,
    participants: ['Ada Lovelace', 'Alan Turing'],
    summary: { overview: 'Discussed the roadmap.', action_items: ['Ship the connector'] },
    sentences: [
      { speaker_name: 'Ada',  text: 'Hello everyone.' },
      { speaker_name: 'Ada',  text: 'Let us begin.' },     // consecutive → grouped
      { speaker_name: 'Alan', text: 'Sounds good.' },
    ],
  };

  it('returns the external id and a non-empty body', () => {
    const n = normaliseTranscript(sample);
    assert.equal(n.externalId, 'ABC123');
    assert.equal(n.title, 'Weekly sync');
    assert.ok(n.content.length > 0);
  });

  it('includes title, summary, action items and the transcript', () => {
    const { content } = normaliseTranscript(sample);
    assert.match(content, /# Weekly sync/);
    assert.match(content, /Discussed the roadmap\./);
    assert.match(content, /Ship the connector/);
    assert.match(content, /## Transcript/);
  });

  it('collapses consecutive same-speaker lines into one turn', () => {
    const { content } = normaliseTranscript(sample);
    assert.match(content, /Ada: Hello everyone\. Let us begin\./);
    assert.match(content, /Alan: Sounds good\./);
  });

  it('parses epoch-ms dates to an ISO timestamp', () => {
    const n = normaliseTranscript(sample);
    assert.ok(n.date && n.date.startsWith('2024-06-'));
    assert.equal(n.externalUpdatedAt, n.date);
  });

  it('returns null when there is no id', () => {
    assert.equal(normaliseTranscript({ title: 'no id' }), null);
    assert.equal(normaliseTranscript(null), null);
  });

  it('falls back to a default title and still produces content', () => {
    const n = normaliseTranscript({ id: 'X', sentences: [{ speaker_name: 'A', text: 'hi' }] });
    assert.equal(n.title, 'Fireflies meeting');
    assert.match(n.content, /A: hi/);
  });
});
