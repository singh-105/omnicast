import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializePacket,
  deserializePacket,
  fragmentChunk,
  PacketReassembler,
  PacketType,
  PacketFlags,
} from '../src/features/broadcast/protocol/framing.js';
import {
  MediaRingBuffer,
  SequenceReorderQueue,
} from '../src/features/broadcast/protocol/ringBuffer.js';

describe('OmniCast Protocol Framing', () => {
  it('serializes and deserializes a single media chunk correctly', () => {
    const originalPayload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const originalSignature = new Uint8Array(64).fill(7);

    const buffer = serializePacket({
      type: PacketType.MEDIA_CHUNK,
      flags: PacketFlags.KEYFRAME,
      sequence: 142,
      fragIndex: 0,
      fragTotal: 1,
      timestamp: 1729930000000,
      sessionId: 'stream-alpha-99',
      signature: originalSignature,
      payload: originalPayload,
    });

    const packet = deserializePacket(buffer);

    assert.equal(packet.type, PacketType.MEDIA_CHUNK);
    assert.equal(packet.flags, PacketFlags.KEYFRAME);
    assert.equal(packet.sequence, 142);
    assert.equal(packet.fragIndex, 0);
    assert.equal(packet.fragTotal, 1);
    assert.equal(packet.timestamp, 1729930000000);
    assert.equal(packet.sessionId, 'stream-alpha-99');
    assert.deepEqual(packet.payload, originalPayload);
    assert.deepEqual(packet.signature, originalSignature);
  });

  it('rejects corrupted magic bytes or truncated buffer', () => {
    const buffer = serializePacket({
      sequence: 1,
      sessionId: 'test',
      payload: new Uint8Array([1, 2, 3]),
    });

    const corrupt = new Uint8Array(buffer);
    corrupt[0] = 0x00; // invalidate magic

    assert.throws(() => deserializePacket(corrupt.buffer), /Invalid magic bytes/);
    assert.throws(() => deserializePacket(new ArrayBuffer(10)), /Packet too small/);
  });

  it('fragments and reassembles a large chunk across multiple packets', () => {
    // 120 KB payload, will be split into 3 fragments of 48KB, 48KB, 24KB
    const largePayload = new Uint8Array(120 * 1024);
    for (let i = 0; i < largePayload.length; i++) {
      largePayload[i] = i % 256;
    }

    const fragments = fragmentChunk({
      type: PacketType.MEDIA_CHUNK,
      isKeyframe: true,
      sequence: 55,
      timestamp: 12345678,
      sessionId: 'large-stream-1',
      chunkPayload: largePayload,
    });

    assert.equal(fragments.length, 3);

    const reassembler = new PacketReassembler();

    // Ingest fragment 0 (not complete yet)
    const p0 = deserializePacket(fragments[0]);
    assert.equal(reassembler.ingest(p0), null);

    // Ingest fragment 2 out of order (not complete yet)
    const p2 = deserializePacket(fragments[2]);
    assert.equal(reassembler.ingest(p2), null);

    // Ingest fragment 1 (completes the chunk!)
    const p1 = deserializePacket(fragments[1]);
    const reassembled = reassembler.ingest(p1);

    assert.ok(reassembled !== null);
    assert.equal(reassembled.sequence, 55);
    assert.equal(reassembled.sessionId, 'large-stream-1');
    assert.equal(reassembled.isKeyframe, true);
    assert.equal(reassembled.payload.byteLength, 120 * 1024);
    assert.deepEqual(reassembled.payload, largePayload);
  });
});

describe('OmniCast Media Ring Buffer & Reorder Queue', () => {
  it('buffers and retrieves items, and prunes older entries', () => {
    const ring = new MediaRingBuffer({ maxItems: 3, maxDurationMs: 5000 });

    ring.add({ sequence: 1, payload: new Uint8Array(100) });
    ring.add({ sequence: 2, payload: new Uint8Array(200) });
    ring.add({ sequence: 3, payload: new Uint8Array(300) });
    assert.equal(ring.size(), 3);
    assert.equal(ring.has(2), true);

    // Adding 4th item should evict oldest (seq 1)
    ring.add({ sequence: 4, payload: new Uint8Array(400) });
    assert.equal(ring.size(), 3);
    assert.equal(ring.has(1), false);
    assert.equal(ring.has(4), true);

    const range = ring.getRange(2, 4);
    assert.equal(range.length, 3);
    assert.equal(range[0].sequence, 2);
    assert.equal(range[2].sequence, 4);
  });

  it('reorders out-of-order chunks and deduplicates', () => {
    const emitted = [];
    const queue = new SequenceReorderQueue({
      onEmit: (chunk) => emitted.push(chunk.sequence),
    });

    // Receive sequence 0
    queue.push({ sequence: 0 });
    assert.deepEqual(emitted, [0]);

    // Receive sequence 2, then 3 (out of order, gap: missing 1)
    queue.push({ sequence: 2 });
    queue.push({ sequence: 3 });
    assert.deepEqual(emitted, [0]); // nothing emitted yet

    // Duplicate 0 pushed (should be ignored)
    queue.push({ sequence: 0 });
    assert.deepEqual(emitted, [0]);

    // Finally sequence 1 arrives -> should flush 1, 2, 3!
    queue.push({ sequence: 1 });
    assert.deepEqual(emitted, [0, 1, 2, 3]);
  });
});

