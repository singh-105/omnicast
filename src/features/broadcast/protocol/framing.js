/**
 * OmniCast Binary Framing Protocol
 * Compact binary wire format for WebRTC RTCDataChannel media chunk transmission.
 */

export const PROTOCOL_MAGIC = new Uint8Array([0x4F, 0x4D, 0x4E, 0x49]); // "OMNI"
export const PROTOCOL_VERSION = 1;

export const PacketType = {
  INIT_SEGMENT: 0x01,
  MEDIA_CHUNK: 0x02,
  HEARTBEAT: 0x03,
  RETRANSMIT_REQ: 0x04,
  RETRANSMIT_RESP: 0x05,
};

export const PacketFlags = {
  NONE: 0x00,
  KEYFRAME: 0x01,
  FIRST_FRAG: 0x02,
  LAST_FRAG: 0x04,
};

// Safe fragment size for RTCDataChannel transmission across browsers
export const MAX_FRAGMENT_PAYLOAD = 48 * 1024; // 48 KB

/**
 * Encodes a 16-character broadcastId string into a 16-byte Uint8Array.
 */
export function encodeSessionId(sessionId) {
  const bytes = new Uint8Array(16);
  const encoder = new TextEncoder();
  const encoded = encoder.encode(String(sessionId || ''));
  if (encoded.length > 16) {
    console.warn(`[framing] sessionId "${sessionId}" exceeds 16 bytes (${encoded.length}B) and will be truncated in binary wire format!`);
  }
  bytes.set(encoded.subarray(0, 16));
  return bytes;
}

/**
 * Decodes 16-byte Uint8Array into a trimmed string.
 */
export function decodeSessionId(bytes) {
  const decoder = new TextDecoder();
  return decoder.decode(bytes).replace(/\0+$/, '').trim();
}

/**
 * Serializes a single packet/fragment into an ArrayBuffer.
 *
 * Header Layout:
 * [0..3]    Magic "OMNI" (4 bytes)
 * [4]       Version (1 byte)
 * [5]       Packet Type (1 byte)
 * [6]       Flags (1 byte)
 * [7..10]   Sequence ID (uint32, 4 bytes)
 * [11..12]  Fragment Index (uint16, 2 bytes)
 * [13..14]  Fragment Total (uint16, 2 bytes)
 * [15..22]  Timestamp ms (uint64 BigInt, 8 bytes)
 * [23..38]  Session ID (16 bytes)
 * [39]      Signature Length (uint8, 1 byte)
 * [40..40+sigLen-1] Signature bytes
 * [..+4]    Payload Length (uint32, 4 bytes)
 * [..+N]    Payload bytes
 */
export function serializePacket({
  type = PacketType.MEDIA_CHUNK,
  flags = PacketFlags.NONE,
  sequence = 0,
  fragIndex = 0,
  fragTotal = 1,
  timestamp = Date.now(),
  sessionId = '',
  signature = null, // Uint8Array or null
  payload = new Uint8Array(0), // Uint8Array
}) {
  const sigBytes = signature instanceof Uint8Array ? signature : new Uint8Array(0);
  const sigLen = sigBytes.byteLength;
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const payloadLen = payloadBytes.byteLength;

  const headerLen = 4 + 1 + 1 + 1 + 4 + 2 + 2 + 8 + 16 + 1 + sigLen + 4;
  const totalLen = headerLen + payloadLen;

  const buffer = new ArrayBuffer(totalLen);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // Magic
  uint8.set(PROTOCOL_MAGIC, 0);
  // Version
  view.setUint8(4, PROTOCOL_VERSION);
  // Type
  view.setUint8(5, type);
  // Flags
  view.setUint8(6, flags);
  // Sequence ID
  view.setUint32(7, sequence, false); // big-endian
  // Fragment Index & Total
  view.setUint16(11, fragIndex, false);
  view.setUint16(13, fragTotal, false);
  // Timestamp ms
  view.setBigUint64(15, BigInt(timestamp), false);
  // Session ID (16 bytes)
  const sessionBytes = encodeSessionId(sessionId);
  uint8.set(sessionBytes, 23);
  // Signature Length
  view.setUint8(39, sigLen);
  // Signature bytes
  let offset = 40;
  if (sigLen > 0) {
    uint8.set(sigBytes, offset);
    offset += sigLen;
  }
  // Payload Length
  view.setUint32(offset, payloadLen, false);
  offset += 4;
  // Payload
  if (payloadLen > 0) {
    uint8.set(payloadBytes, offset);
  }

  return buffer;
}

/**
 * Deserializes an ArrayBuffer into a packet object.
 */
export function deserializePacket(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    if (buffer.buffer instanceof ArrayBuffer) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } else {
      throw new Error('deserializePacket: Invalid buffer type');
    }
  }

  if (buffer.byteLength < 44) {
    throw new Error(`deserializePacket: Packet too small (${buffer.byteLength} bytes)`);
  }

  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // Check magic
  if (
    uint8[0] !== PROTOCOL_MAGIC[0] ||
    uint8[1] !== PROTOCOL_MAGIC[1] ||
    uint8[2] !== PROTOCOL_MAGIC[2] ||
    uint8[3] !== PROTOCOL_MAGIC[3]
  ) {
    throw new Error('deserializePacket: Invalid magic bytes');
  }

  const version = view.getUint8(4);
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`deserializePacket: Unsupported protocol version ${version}`);
  }

  const type = view.getUint8(5);
  const flags = view.getUint8(6);
  const sequence = view.getUint32(7, false);
  const fragIndex = view.getUint16(11, false);
  const fragTotal = view.getUint16(13, false);
  const timestamp = Number(view.getBigUint64(15, false));
  const sessionId = decodeSessionId(uint8.subarray(23, 39));
  const sigLen = view.getUint8(39);

  let offset = 40;
  if (buffer.byteLength < offset + sigLen + 4) {
    throw new Error('deserializePacket: Buffer truncated before payload length');
  }

  let signature = null;
  if (sigLen > 0) {
    signature = uint8.slice(offset, offset + sigLen);
    offset += sigLen;
  }

  const payloadLen = view.getUint32(offset, false);
  offset += 4;

  if (buffer.byteLength < offset + payloadLen) {
    throw new Error(`deserializePacket: Incomplete payload (expected ${payloadLen}, got ${buffer.byteLength - offset})`);
  }

  const payload = uint8.slice(offset, offset + payloadLen);

  return {
    version,
    type,
    flags,
    sequence,
    fragIndex,
    fragTotal,
    timestamp,
    sessionId,
    signature,
    payload,
  };
}

/**
 * Splits a full logical media chunk into one or more transport fragments.
 */
export function fragmentChunk({
  type = PacketType.MEDIA_CHUNK,
  isKeyframe = false,
  sequence,
  timestamp = Date.now(),
  sessionId,
  signature = null,
  chunkPayload, // Uint8Array
}) {
  const payloadBytes = chunkPayload instanceof Uint8Array ? chunkPayload : new Uint8Array(chunkPayload);
  const totalLength = payloadBytes.byteLength;

  if (totalLength === 0) {
    let flags = PacketFlags.FIRST_FRAG | PacketFlags.LAST_FRAG;
    if (isKeyframe) flags |= PacketFlags.KEYFRAME;
    return [
      serializePacket({
        type,
        flags,
        sequence,
        fragIndex: 0,
        fragTotal: 1,
        timestamp,
        sessionId,
        signature,
        payload: payloadBytes,
      }),
    ];
  }

  const fragTotal = Math.ceil(totalLength / MAX_FRAGMENT_PAYLOAD);
  const packets = [];

  for (let i = 0; i < fragTotal; i++) {
    const start = i * MAX_FRAGMENT_PAYLOAD;
    const end = Math.min(start + MAX_FRAGMENT_PAYLOAD, totalLength);
    const slice = payloadBytes.subarray(start, end);

    let flags = PacketFlags.NONE;
    if (i === 0) flags |= PacketFlags.FIRST_FRAG;
    if (i === fragTotal - 1) flags |= PacketFlags.LAST_FRAG;
    if (isKeyframe) flags |= PacketFlags.KEYFRAME;

    packets.push(
      serializePacket({
        type,
        flags,
        sequence,
        fragIndex: i,
        fragTotal,
        timestamp,
        sessionId,
        signature, // Attached to all fragments so reassembly/verification succeeds easily
        payload: slice,
      })
    );
  }

  return packets;
}

/**
 * Reassembles incoming fragments into full logical chunks.
 * Bounded by memory and age.
 */
export class PacketReassembler {
  constructor(timeoutMs = 4000) {
    this.timeoutMs = timeoutMs;
    // Map: `${sessionId}:${sequence}` -> { receivedAt, fragTotal, fragments: Map<fragIndex, Uint8Array>, meta }
    this.pending = new Map();
  }

  /**
   * Ingest a deserialized packet fragment.
   * Returns the complete chunk object if this fragment completes it, or null.
   */
  ingest(packet, rawBuffer = null) {
    this.prune();

    const { sessionId, sequence, fragIndex, fragTotal, payload, flags, type, timestamp, signature } = packet;

    // Single fragment chunk
    if (fragTotal === 1) {
      return {
        sessionId,
        sequence,
        type,
        flags,
        isKeyframe: Boolean(flags & PacketFlags.KEYFRAME),
        timestamp,
        signature,
        payload,
        rawPackets: rawBuffer ? [rawBuffer] : [],
      };
    }

    const key = `${sessionId}:${sequence}`;
    let entry = this.pending.get(key);

    if (!entry) {
      entry = {
        receivedAt: Date.now(),
        fragTotal,
        fragments: new Map(),
        rawPackets: new Map(),
        type,
        flags,
        timestamp,
        signature: signature || null,
        sessionId,
        sequence,
      };
      this.pending.set(key, entry);
    }

    // Store signature from any fragment that has it
    if (!entry.signature && signature) {
      entry.signature = signature;
    }
    if (flags & PacketFlags.KEYFRAME) {
      entry.flags |= PacketFlags.KEYFRAME;
    }

    entry.fragments.set(fragIndex, payload);
    if (rawBuffer) {
      entry.rawPackets.set(fragIndex, rawBuffer);
    }

    // Check if complete
    if (entry.fragments.size === entry.fragTotal) {
      this.pending.delete(key);

      // Calculate total byte length
      let totalBytes = 0;
      for (let i = 0; i < entry.fragTotal; i++) {
        const frag = entry.fragments.get(i);
        if (!frag) {
          // Missing fragment
          return null;
        }
        totalBytes += frag.byteLength;
      }

      // Reassemble continuous buffer
      const fullPayload = new Uint8Array(totalBytes);
      let offset = 0;
      const rawList = [];
      for (let i = 0; i < entry.fragTotal; i++) {
        const frag = entry.fragments.get(i);
        fullPayload.set(frag, offset);
        offset += frag.byteLength;
        const raw = entry.rawPackets.get(i);
        if (raw) rawList.push(raw);
      }

      return {
        sessionId: entry.sessionId,
        sequence: entry.sequence,
        type: entry.type,
        flags: entry.flags,
        isKeyframe: Boolean(entry.flags & PacketFlags.KEYFRAME),
        timestamp: entry.timestamp,
        signature: entry.signature,
        payload: fullPayload,
        rawPackets: rawList,
      };
    }

    return null;
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now - entry.receivedAt > this.timeoutMs) {
        this.pending.delete(key);
      }
    }
  }

  clear() {
    this.pending.clear();
  }
}

