import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TopologyCoordinator } from '../src/features/broadcast/topology/topologyCoordinator.js';

describe('Topology Coordinator Scale & Invariants', () => {
  it('supports 500 concurrent viewers within max depth 4 and fanout <= 8 in < 5 seconds', () => {
    const startTime = performance.now();
    const coordinator = new TopologyCoordinator({
      maxChildren: 8,
      maxViewers: 500,
      maxDepth: 4,
    });

    const broadcastId = 'scale_bcast_500';
    const originPeerId = 'origin_root_node';

    // 1. Create broadcast session
    coordinator.createBroadcast({
      broadcastId,
      title: '500 Viewers Scale Test',
      originPeerId,
      originPubKey: 'origin_test_key',
      maxChildren: 8,
    });

    // 2. Join 500 viewers (70% desktop / 30% mobile leaves)
    const totalViewers = 500;
    const joinedViewers = [];

    for (let i = 0; i < totalViewers; i++) {
      const peerId = `viewer_${i.toString().padStart(4, '0')}`;
      const isMobile = i % 10 < 3; // 30% mobile

      const assignment = coordinator.joinViewer({
        broadcastId,
        peerId,
        capabilities: { isMobile, userRelayPermitted: !isMobile },
      });

      assert.ok(assignment, `Viewer ${peerId} must receive an assignment`);
      assert.ok(assignment.parentPeerId, `Viewer ${peerId} must have an assigned parent`);
      assert.ok(assignment.tier <= 4, `Viewer ${peerId} tier ${assignment.tier} exceeds max depth 4`);
      joinedViewers.push(peerId);
    }

    const session = coordinator.getBroadcast(broadcastId);
    assert.equal(session.nodes.size, totalViewers + 1); // 500 viewers + origin

    // 3. Verify Tree Invariants:
    // a) Every node has <= 8 children
    for (const [parentId, childrenSet] of session.children) {
      assert.ok(
        childrenSet.size <= 8,
        `Node ${parentId} has ${childrenSet.size} children, exceeding fanout 8`
      );
    }

    // b) No cycles and all nodes have a valid path to origin
    for (const viewerId of joinedViewers) {
      let current = viewerId;
      const visitedInPath = new Set();
      let hops = 0;

      while (current !== originPeerId) {
        assert.ok(!visitedInPath.has(current), `Cycle detected involving ${current}!`);
        visitedInPath.add(current);
        const parent = session.parents.get(current);
        assert.ok(parent, `Node ${current} has no parent (orphaned)!`);
        current = parent;
        hops++;
        assert.ok(hops <= 4, `Path from ${viewerId} to origin exceeds max depth 4 (hops: ${hops})`);
      }
    }

    // 4. Verify 20% random churn/departures
    const viewersToRemove = joinedViewers.filter((_, idx) => idx % 5 === 0); // 20% departures
    for (const departureId of viewersToRemove) {
      coordinator.removePeer({ broadcastId, peerId: departureId });
    }

    // Verify remaining nodes still have valid path to origin and no cycles
    const remainingViewers = joinedViewers.filter((_, idx) => idx % 5 !== 0);
    for (const viewerId of remainingViewers) {
      let current = viewerId;
      const visitedInPath = new Set();
      let hops = 0;

      while (current !== originPeerId) {
        assert.ok(!visitedInPath.has(current), `Post-churn cycle detected involving ${current}!`);
        visitedInPath.add(current);
        const parent = session.parents.get(current);
        assert.ok(parent, `Post-churn: Node ${current} has no parent (orphaned)!`);
        current = parent;
        hops++;
        assert.ok(hops <= 4, `Post-churn: Path from ${viewerId} to origin exceeds max depth 4`);
      }
    }

    // 5. Test capacity cap enforcement: trying to join past 500 throws ROOM_FULL
    const needed = 500 - (session.nodes.size - 1);
    for (let i = 0; i < needed; i++) {
      coordinator.joinViewer({
        broadcastId,
        peerId: `refill_${i}`,
        capabilities: { isMobile: false },
      });
    }

    assert.throws(
      () => {
        coordinator.joinViewer({
          broadcastId,
          peerId: 'overflow_viewer',
          capabilities: { isMobile: false },
        });
      },
      (err) => err.code === 'ROOM_FULL' || err.message.includes('capacity')
    );

    const elapsedMs = performance.now() - startTime;
    console.log(`✅ 500-viewer scale and churn test completed in ${Math.round(elapsedMs)} ms`);
    assert.ok(elapsedMs < 5000, `Execution time ${elapsedMs} ms exceeded 5000 ms limit`);
  });
});
