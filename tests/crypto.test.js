import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateBroadcasterKeyPair,
  exportPublicKeyInfo,
  importPublicKey,
  signChunk,
  verifyChunk,
} from '../src/features/broadcast/crypto/signatures.js';

describe('OmniCast Origin Authenticity & Cryptography', () => {
  it('generates key pair and exports fingerprint', async () => {
    const keyPair = await generateBroadcasterKeyPair();
    assert.ok(keyPair.privateKey);
    assert.ok(keyPair.publicKey);

    const info = await exportPublicKeyInfo(keyPair.publicKey);
    assert.ok(info.spkiBase64.length > 0);
    assert.ok(info.fingerprint.includes(':'));
    assert.equal(info.fingerprint.split(':').length, 16);
  });

  it('signs and verifies a valid media chunk payload', async () => {
    const keyPair = await generateBroadcasterKeyPair();
    const info = await exportPublicKeyInfo(keyPair.publicKey);
    const importedPub = await importPublicKey(info.spkiBase64);

    const chunkData = {
      sessionId: 'broadcast-xyz',
      sequence: 12,
      timestamp: 1729930050000,
      type: 0x02,
      flags: 1,
      payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    };

    const signature = await signChunk(keyPair.privateKey, chunkData);
    assert.ok(signature instanceof Uint8Array);
    assert.ok(signature.byteLength >= 64);

    const isValid = await verifyChunk(importedPub, {
      ...chunkData,
      signature,
    });
    assert.equal(isValid, true);
  });

  it('rejects a chunk with tampered payload or modified sequence', async () => {
    const keyPair = await generateBroadcasterKeyPair();
    const chunkData = {
      sessionId: 'broadcast-xyz',
      sequence: 12,
      timestamp: 1729930050000,
      type: 0x02,
      flags: 1,
      payload: new Uint8Array([1, 2, 3, 4, 5]),
    };

    const signature = await signChunk(keyPair.privateKey, chunkData);

    // Tampered payload
    const tamperedChunk = {
      ...chunkData,
      payload: new Uint8Array([1, 2, 3, 4, 99]), // modified byte
      signature,
    };
    const isTamperedValid = await verifyChunk(keyPair.publicKey, tamperedChunk);
    assert.equal(isTamperedValid, false);

    // Tampered sequence ID
    const tamperedSeqChunk = {
      ...chunkData,
      sequence: 13,
      signature,
    };
    const isSeqValid = await verifyChunk(keyPair.publicKey, tamperedSeqChunk);
    assert.equal(isSeqValid, false);
  });

  it('rejects a chunk verified with an untrusted / different public key', async () => {
    const keyPair1 = await generateBroadcasterKeyPair();
    const keyPair2 = await generateBroadcasterKeyPair(); // Attacker key

    const chunkData = {
      sessionId: 'broadcast-1',
      sequence: 1,
      timestamp: 1729930000000,
      type: 0x02,
      flags: 0,
      payload: new Uint8Array([42, 42, 42]),
    };

    const signatureFromOrigin = await signChunk(keyPair1.privateKey, chunkData);

    // Verifying origin signature with attacker's public key must FAIL
    const isValid = await verifyChunk(keyPair2.publicKey, {
      ...chunkData,
      signature: signatureFromOrigin,
    });
    assert.equal(isValid, false);
  });
});

