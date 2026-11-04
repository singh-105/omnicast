/**
 * OmniCast Stream Authenticity & Cryptography
 *
 * Implements Web Crypto ECDSA P-256 origin signing and SHA-256 chunk verification.
 * Guarantees stream authenticity: viewers and relays verify that media originated
 * from the broadcaster's private key and was not tampered with or replaced.
 */

function getCryptoSubtle() {
  if (typeof window !== 'undefined' && window.crypto?.subtle) {
    return window.crypto.subtle;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto API (crypto.subtle) is not available in this environment');
}

/**
 * Generate a new ECDSA P-256 key pair for the broadcaster origin session.
 */
export async function generateBroadcasterKeyPair() {
  const subtle = getCryptoSubtle();
  return await subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true, // extractable
    ['sign', 'verify']
  );
}

/**
 * Export public key to base64 SPKI format and compute a human-readable SHA-256 fingerprint.
 */
export async function exportPublicKeyInfo(publicKey) {
  const subtle = getCryptoSubtle();
  const spkiBuffer = await subtle.exportKey('spki', publicKey);
  const spkiBytes = new Uint8Array(spkiBuffer);

  // Compute SHA-256 fingerprint of the public key
  const hashBuffer = await subtle.digest('SHA-256', spkiBuffer);
  const hashBytes = new Uint8Array(hashBuffer);

  // Format as hex colon-delimited string (e.g. "a1:b2:c3:...")
  const fingerprint = Array.from(hashBytes.subarray(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();

  // Base64 encode SPKI for signaling distribution
  let binary = '';
  for (let i = 0; i < spkiBytes.byteLength; i++) {
    binary += String.fromCharCode(spkiBytes[i]);
  }
  const spkiBase64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');

  return {
    spkiBase64,
    spkiBytes,
    fingerprint,
  };
}

/**
 * Import a base64 SPKI public key for signature verification.
 */
export async function importPublicKey(spkiBase64OrBytes) {
  const subtle = getCryptoSubtle();
  let spkiBytes;

  if (typeof spkiBase64OrBytes === 'string') {
    const binary = typeof atob === 'function'
      ? atob(spkiBase64OrBytes)
      : Buffer.from(spkiBase64OrBytes, 'base64').toString('binary');
    spkiBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      spkiBytes[i] = binary.charCodeAt(i);
    }
  } else if (spkiBase64OrBytes instanceof Uint8Array) {
    spkiBytes = spkiBase64OrBytes;
  } else {
    throw new Error('importPublicKey: Expected base64 string or Uint8Array');
  }

  return await subtle.importKey(
    'spki',
    spkiBytes,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['verify']
  );
}

/**
 * Creates the canonical binary envelope bytes to sign or verify.
 *
 * Envelope format:
 * UTF-8: "OMNICAST-V1" + "|" + sessionId + "|" + sequence + "|" + timestamp + "|" + type + "|" + flags + "|" + payloadHashHex
 */
export async function createCanonicalEnvelope({
  sessionId,
  sequence,
  timestamp,
  type = 0x02,
  flags = 0,
  payload = new Uint8Array(0),
}) {
  const subtle = getCryptoSubtle();
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);

  // SHA-256 hash of payload
  const digestBuffer = await subtle.digest('SHA-256', payloadBytes);
  const digestBytes = new Uint8Array(digestBuffer);
  let payloadHashHex = '';
  for (let i = 0; i < digestBytes.byteLength; i++) {
    payloadHashHex += digestBytes[i].toString(16).padStart(2, '0');
  }

  // Mask out transport-only fragment flags (FIRST_FRAG, LAST_FRAG), preserving logical media flags (KEYFRAME).
  // For stream initialization segments (type 0x01), flags are normalized to 0.
  const logicalFlags = (type === 0x01) ? 0 : (flags & 0x01);

  const envelopeString = `OMNICAST-V1|${sessionId}|${sequence}|${timestamp}|${type}|${logicalFlags}|${payloadHashHex}`;
  return new TextEncoder().encode(envelopeString);
}

/**
 * Signs a media chunk using the origin's ECDSA P-256 private key.
 * Returns Uint8Array signature bytes.
 */
export async function signChunk(privateKey, chunkData) {
  const subtle = getCryptoSubtle();
  const canonicalBytes = await createCanonicalEnvelope(chunkData);
  const signatureBuffer = await subtle.sign(
    {
      name: 'ECDSA',
      hash: { name: 'SHA-256' },
    },
    privateKey,
    canonicalBytes
  );

  const sig = new Uint8Array(signatureBuffer);
  return sig;
}

/**
 * Verifies a media chunk signature using the origin's public key.
 * Returns true if valid, false if signature fails or payload was modified.
 */
export async function verifyChunk(publicKey, chunkData) {
  if (!publicKey || !chunkData || !chunkData.signature) {
    return false;
  }

  try {
    const subtle = getCryptoSubtle();
    const canonicalBytes = await createCanonicalEnvelope(chunkData);
    const sigBytes = chunkData.signature instanceof Uint8Array
      ? chunkData.signature
      : new Uint8Array(chunkData.signature);

    const valid = await subtle.verify(
      {
        name: 'ECDSA',
        hash: { name: 'SHA-256' },
      },
      publicKey,
      sigBytes,
      canonicalBytes
    );

    if (!valid) {
      console.warn(`[Crypto] Signature invalid for seq ${chunkData.sequence}! Canonical: "${new TextDecoder().decode(canonicalBytes)}"`);
    }

    return valid;
  } catch (err) {
    console.warn('[Crypto] Chunk signature verification error:', err.message);
    return false;
  }
}

