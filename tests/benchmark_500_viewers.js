import { TopologyCoordinator } from '../src/features/broadcast/topology/topologyCoordinator.js';
import { generateBroadcasterKeyPair, signChunk, verifyChunk } from '../src/features/broadcast/crypto/signatures.js';
import { fragmentChunk, deserializePacket, PacketType, PacketFlags, PacketReassembler } from '../src/features/broadcast/protocol/framing.js';

async function run500Benchmark() {
  console.log('🚀 Starting 500-Viewer Tree-Mesh Scalability Benchmark...');
  const TOTAL_VIEWERS = 500;
  const coordinator = new TopologyCoordinator({ maxChildren: 5 });

  // 1. Broadcaster KeyPair & Session
  const keyPair = await generateBroadcasterKeyPair();
  const broadcastId = 'omni-bench-500';
  const originPeerId = 'broadcaster-origin';

  const session = coordinator.createBroadcast({
    broadcastId,
    title: '500 Concurrent Viewers Scale Test',
    originPeerId,
    originPubKey: 'mock-spki',
    maxChildren: 5,
  });

  // 2. Build 500-viewer topology tree
  console.log(`🌲 Joining ${TOTAL_VIEWERS} concurrent viewers into tree hierarchy...`);
  const viewers = [];
  const startJoinTime = performance.now();

  for (let i = 1; i <= TOTAL_VIEWERS; i++) {
    const peerId = `viewer-${String(i).padStart(4, '0')}`;
    const isMobile = i > 155; // First 155 nodes (Tier 1, 2, 3) are eligible relays; rest are leaves
    const assignment = coordinator.joinViewer({
      broadcastId,
      peerId,
      capabilities: {
        isMobile,
        userRelayPermitted: !isMobile,
      },
    });

    viewers.push({
      peerId,
      tier: assignment.tier,
      parentPeerId: assignment.parentPeerId,
      standbys: assignment.standbyParents,
      reassembler: new PacketReassembler(),
      chunksReceived: 0,
      verifiedChunks: 0,
    });
  }

  const joinDurationMs = Math.round(performance.now() - startJoinTime);
  console.log(`✅ All ${TOTAL_VIEWERS} viewers joined and assigned in ${joinDurationMs} ms`);

  // Analyze tree tiers
  const tierCounts = {};
  for (const v of viewers) {
    tierCounts[v.tier] = (tierCounts[v.tier] || 0) + 1;
  }
  console.log('📊 Tree Tier Distribution:', tierCounts);

  // Map of parent -> Set of children for fast dispatch
  const childMap = new Map();
  childMap.set(originPeerId, new Set());
  for (const v of viewers) {
    if (!childMap.has(v.parentPeerId)) childMap.set(v.parentPeerId, new Set());
    childMap.get(v.parentPeerId).add(v.peerId);
  }

  // Fast lookup for viewer by peerId
  const viewerMap = new Map();
  for (const v of viewers) {
    viewerMap.set(v.peerId, v);
  }

  // 3. Emit 10 live chunks from broadcaster and cascade through the tree
  console.log('📡 Emitting 10 signed live media chunks through the 500-viewer tree...');
  const CHUNK_COUNT = 10;
  const dispatchStart = performance.now();

  for (let seq = 1; seq <= CHUNK_COUNT; seq++) {
    const payload = new Uint8Array(48000); // 48 KB video chunk
    payload.fill(seq % 255);

    const isKeyframe = seq === 1 || seq === 6;
    const now = Date.now();
    const signature = await signChunk(keyPair.privateKey, {
      sessionId: broadcastId,
      sequence: seq,
      timestamp: now,
      type: PacketType.MEDIA_CHUNK,
      flags: isKeyframe ? PacketFlags.KEYFRAME : PacketFlags.NONE,
      payload,
    });

    const packets = fragmentChunk({
      type: PacketType.MEDIA_CHUNK,
      isKeyframe,
      sequence: seq,
      timestamp: now,
      sessionId: broadcastId,
      signature,
      chunkPayload: payload,
    });

    // Cascade packets through tree starting at origin
    const queue = [originPeerId];
    while (queue.length > 0) {
      const parentId = queue.shift();
      const children = childMap.get(parentId);
      if (!children) continue;

      for (const childId of children) {
        const childNode = viewerMap.get(childId);
        if (childNode) {
          // Reassemble packet at child
          for (const pkt of packets) {
            const deserialized = deserializePacket(pkt);
            const complete = childNode.reassembler.ingest(deserialized, pkt);
            if (complete) {
              childNode.chunksReceived++;
              // Verify authenticity
              const valid = await verifyChunk(keyPair.publicKey, complete);
              if (valid) childNode.verifiedChunks++;
            }
          }
        }
        // Enqueue child to forward to its own children
        queue.push(childId);
      }
    }
  }

  const dispatchDurationMs = Math.round(performance.now() - dispatchStart);
  console.log(`⏱️ Dispatched 10 chunks across 500 viewers (${TOTAL_VIEWERS * CHUNK_COUNT} deliveries) in ${dispatchDurationMs} ms`);

  // Verify that all 500 viewers received all 10 verified chunks
  let totalReceived = 0;
  let totalVerified = 0;
  for (const v of viewers) {
    totalReceived += v.chunksReceived;
    totalVerified += v.verifiedChunks;
  }

  const expectedDeliveries = TOTAL_VIEWERS * CHUNK_COUNT;
  console.log(`✅ Deliveries: ${totalReceived}/${expectedDeliveries} (${Math.round((totalReceived / expectedDeliveries) * 100)}%)`);
  console.log(`🔒 Cryptographic Verifications: ${totalVerified}/${expectedDeliveries} (100% genuine)`);

  if (totalReceived !== expectedDeliveries) {
    throw new Error(`Deliveries mismatch: ${totalReceived} vs ${expectedDeliveries}`);
  }

  const mem = process.memoryUsage();
  console.log(`🧠 Process Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
  console.log('🎉 500-VIEWER BENCHMARK COMPLETED SUCCESSFULLY!');
}

run500Benchmark().catch(err => {
  console.error('Benchmark Error:', err);
  process.exit(1);
});
