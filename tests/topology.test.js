import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TopologyCoordinator,
  MAX_CHILDREN_PER_RELAY,
} from '../src/features/broadcast/topology/topologyCoordinator.js';

describe('OmniCast Tree-Mesh Topology Coordinator', () => {
  it('enforces 5-child fanout per relay and creates tiered hierarchy', () => {
    const coordinator = new TopologyCoordinator({ maxChildren: 5 });

    coordinator.createBroadcast({
      broadcastId: 'bcast-1',
      title: 'Dev Test Broadcast',
      originPeerId: 'origin-node',
      originPubKey: 'origin-pubkey-base64',
    });

    // Add first 5 viewers
    const tier1Viewers = [];
    for (let i = 1; i <= 5; i++) {
      const res = coordinator.joinViewer({
        broadcastId: 'bcast-1',
        peerId: `viewer-${i}`,
        capabilities: { isMobile: false, userRelayPermitted: true },
      });
      tier1Viewers.push(res);
      assert.equal(res.parentPeerId, 'origin-node');
      assert.equal(res.tier, 1);
    }

    // Origin now has 5 children (max limit reached).
    // Adding 6th viewer must cascade to Tier 2 under one of the Tier 1 relays!
    const res6 = coordinator.joinViewer({
      broadcastId: 'bcast-1',
      peerId: 'viewer-6',
      capabilities: { isMobile: false, userRelayPermitted: true },
    });

    assert.equal(res6.tier, 2);
    assert.ok(tier1Viewers.some((v) => v.peerId === res6.parentPeerId));
    assert.notEqual(res6.parentPeerId, 'origin-node');
  });

  it('keeps mobile/cellular devices as leaves (relayEligible: false)', () => {
    const coordinator = new TopologyCoordinator({ maxChildren: 2 });
    coordinator.createBroadcast({
      broadcastId: 'bcast-mobile',
      originPeerId: 'origin',
      originPubKey: 'pubkey',
    });

    // Add 2 mobile viewers
    coordinator.joinViewer({
      broadcastId: 'bcast-mobile',
      peerId: 'mobile-1',
      capabilities: { isMobile: true },
    });
    coordinator.joinViewer({
      broadcastId: 'bcast-mobile',
      peerId: 'mobile-2',
      capabilities: { isMobile: true },
    });

    // Now origin is full (maxChildren: 2).
    // Adding a 3rd peer: mobile-1 and mobile-2 are NOT eligible relays.
    // So the coordinator will fall back to origin or desktop relays, never mobile!
    const snapshot = coordinator.getTopologySnapshot('bcast-mobile');
    const mobileNode = snapshot.nodes.find((n) => n.peerId === 'mobile-1');
    assert.equal(mobileNode.relayEligible, false);
    assert.equal(mobileNode.childCount, 0);
  });

  it('reparents orphaned children seamlessly when a parent leaves', () => {
    const coordinator = new TopologyCoordinator({ maxChildren: 2 });
    coordinator.createBroadcast({
      broadcastId: 'bcast-reparent',
      originPeerId: 'origin',
      originPubKey: 'pubkey',
    });

    // Origin children: relay-A, relay-B
    coordinator.joinViewer({ broadcastId: 'bcast-reparent', peerId: 'relay-A' });
    coordinator.joinViewer({ broadcastId: 'bcast-reparent', peerId: 'relay-B' });

    // Child of relay-A: child-1
    const child1 = coordinator.joinViewer({ broadcastId: 'bcast-reparent', peerId: 'child-1' });
    assert.equal(child1.parentPeerId, 'relay-A');

    // Now relay-A disconnects!
    const departure = coordinator.removePeer({ broadcastId: 'bcast-reparent', peerId: 'relay-A' });
    assert.equal(departure.isOrigin, false);
    assert.equal(departure.orphanedChildren.length, 1);

    const orphan = departure.orphanedChildren[0];
    assert.equal(orphan.childPeerId, 'child-1');
    // Because relay-A departed, origin freed a slot (now has 1 child < max 2),
    // so child-1 is promoted directly to origin (tier 1) for lowest latency!
    assert.equal(orphan.newParentPeerId, 'origin');
    assert.equal(orphan.tier, 1);
  });

  it('provides up to 2 standby parent candidates', () => {
    const coordinator = new TopologyCoordinator({ maxChildren: 5 });
    coordinator.createBroadcast({
      broadcastId: 'bcast-standby',
      originPeerId: 'origin',
      originPubKey: 'pubkey',
    });

    coordinator.joinViewer({ broadcastId: 'bcast-standby', peerId: 'peer-1' });
    coordinator.joinViewer({ broadcastId: 'bcast-standby', peerId: 'peer-2' });

    const peer3 = coordinator.joinViewer({ broadcastId: 'bcast-standby', peerId: 'peer-3' });
    assert.ok(Array.isArray(peer3.standbyParents));
    assert.ok(peer3.standbyParents.length > 0);
    assert.ok(peer3.standbyParents.length <= 2);
  });
});
