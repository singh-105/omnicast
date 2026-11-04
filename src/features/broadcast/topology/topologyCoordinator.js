/**
 * OmniCast Tree-Mesh Topology Coordinator
 *
 * Implements:
 * - 5-child fanout constraint per relay.
 * - Breadth-first tier assignment (Origin = Tier 0, Tier 1, Tier 2...).
 * - Cycle prevention (a node can never select one of its descendants as parent).
 * - Standby parent candidate selection (up to 2 candidates).
 * - Rebalancing and orphan subtree recovery upon parent departure.
 * - Dynamic device tiering (desktop/fiber preferred as relays, mobile/cellular default leaves).
 */

export const MAX_CHILDREN_PER_RELAY = 5;

export class TopologyCoordinator {
  constructor({ maxChildren = MAX_CHILDREN_PER_RELAY } = {}) {
    this.maxChildren = maxChildren;
    // Map<broadcastId, BroadcastSession>
    this.broadcasts = new Map();
  }

  createBroadcast({ broadcastId, title, originPeerId, originPubKey, mimeType = 'video/webm; codecs="vp8,opus"', maxChildren = null }) {
    if (this.broadcasts.has(broadcastId)) {
      throw new Error(`Broadcast "${broadcastId}" already exists`);
    }

    const session = {
      broadcastId,
      title: title || 'OmniCast Live Stream',
      originPeerId,
      originPubKey,
      mimeType,
      maxChildren: maxChildren || this.maxChildren,
      createdAt: Date.now(),
      // Node metadata: peerId -> { isMobile, relayEligible, joinedAt, lastSeen }
      nodes: new Map(),
      // Tree edges:
      parents: new Map(), // childPeerId -> parentPeerId
      children: new Map(), // parentPeerId -> Set<childPeerId>
      tiers: new Map(), // peerId -> integer (0 = origin)
      standbys: new Map(), // childPeerId -> Array<standbyPeerId>
    };

    // Register origin
    session.nodes.set(originPeerId, {
      isMobile: false,
      relayEligible: true,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });
    session.children.set(originPeerId, new Set());
    session.tiers.set(originPeerId, 0);

    this.broadcasts.set(broadcastId, session);
    return session;
  }

  getBroadcast(broadcastId) {
    return this.broadcasts.get(broadcastId) || null;
  }

  listBroadcasts() {
    return Array.from(this.broadcasts.values()).map((b) => ({
      broadcastId: b.broadcastId,
      title: b.title,
      originPeerId: b.originPeerId,
      originPubKey: b.originPubKey,
      mimeType: b.mimeType,
      createdAt: b.createdAt,
      viewerCount: b.nodes.size - 1, // exclude origin
      tierDepth: Math.max(0, ...b.tiers.values()),
    }));
  }

  stopBroadcast(broadcastId) {
    const session = this.broadcasts.get(broadcastId);
    if (!session) return null;
    this.broadcasts.delete(broadcastId);
    return session;
  }

  /**
   * Assigns an eligible parent and standby parents to a joining viewer.
   */
  joinViewer({ broadcastId, peerId, capabilities = {} }) {
    const session = this.broadcasts.get(broadcastId);
    if (!session) {
      throw new Error(`Broadcast "${broadcastId}" not found`);
    }

    if (session.nodes.has(peerId)) {
      // Already joined; return current state
      return {
        broadcastId,
        peerId,
        parentPeerId: session.parents.get(peerId),
        standbyParents: session.standbys.get(peerId) || [],
        tier: session.tiers.get(peerId) || 1,
      };
    }

    const isMobile = Boolean(capabilities.isMobile);
    // User can opt out of forwarding; mobile devices are non-relaying leaves by default
    const relayEligible = !isMobile && (capabilities.userRelayPermitted !== undefined
      ? Boolean(capabilities.userRelayPermitted)
      : true);

    session.nodes.set(peerId, {
      isMobile,
      relayEligible,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
    });
    session.children.set(peerId, new Set());

    // Find best parent using BFS from origin
    const { parentPeerId, tier } = this.selectBestParent(session, peerId);
    session.parents.set(peerId, parentPeerId);
    session.children.get(parentPeerId).add(peerId);
    session.tiers.set(peerId, tier);

    // Find up to 2 standby parent candidates
    const standbyParents = this.selectStandbyParents(session, peerId, parentPeerId);
    session.standbys.set(peerId, standbyParents);

    return {
      broadcastId,
      peerId,
      parentPeerId,
      standbyParents,
      tier,
      originPeerId: session.originPeerId,
      originPubKey: session.originPubKey,
      mimeType: session.mimeType,
    };
  }

  /**
   * Breadth-first search for eligible relay parent with fewest children in lowest tier.
   */
  selectBestParent(session, newPeerId) {
    const queue = [session.originPeerId];
    const visited = new Set([session.originPeerId]);

    const candidatesByTier = new Map(); // tier -> Array<peerId>

    while (queue.length > 0) {
      const current = queue.shift();
      const currentTier = session.tiers.get(current) || 0;
      const currentChildren = session.children.get(current) || new Set();
      const nodeMeta = session.nodes.get(current);

      // Check if current node has capacity and is eligible to relay
      const canRelay = current === session.originPeerId || (nodeMeta && nodeMeta.relayEligible);
      const fanoutLimit = session.maxChildren || this.maxChildren;
      if (canRelay && currentChildren.size < fanoutLimit) {
        if (!candidatesByTier.has(currentTier)) {
          candidatesByTier.set(currentTier, []);
        }
        candidatesByTier.get(currentTier).push(current);
      }

      // Enqueue children for next tier exploration
      for (const child of currentChildren) {
        if (!visited.has(child)) {
          visited.add(child);
          queue.push(child);
        }
      }
    }

    // Pick candidate from lowest tier with lowest current load
    const sortedTiers = Array.from(candidatesByTier.keys()).sort((a, b) => a - b);
    if (sortedTiers.length > 0) {
      const bestTier = sortedTiers[0];
      const candidates = candidatesByTier.get(bestTier);
      // Sort by fewest children
      candidates.sort((a, b) => {
        const countA = (session.children.get(a) || new Set()).size;
        const countB = (session.children.get(b) || new Set()).size;
        return countA - countB;
      });
      const chosenParent = candidates[0];
      return {
        parentPeerId: chosenParent,
        tier: bestTier + 1,
      };
    }

    // Fallback directly to origin
    return {
      parentPeerId: session.originPeerId,
      tier: 1,
    };
  }

  /**
   * Selects up to 2 alternate standby candidates who could act as parent.
   */
  selectStandbyParents(session, peerId, activeParentId) {
    const standbys = [];
    for (const [candidateId, meta] of session.nodes) {
      if (candidateId === peerId || candidateId === activeParentId) continue;
      if (!this.isDescendant(session, peerId, candidateId)) {
        if (candidateId === session.originPeerId || meta.relayEligible) {
          standbys.push(candidateId);
          if (standbys.length >= 2) break;
        }
      }
    }
    return standbys;
  }

  /**
   * Cycle prevention check: Returns true if `targetId` is in the subtree under `ancestorId`.
   */
  isDescendant(session, ancestorId, targetId) {
    const children = session.children.get(ancestorId);
    if (!children || children.size === 0) return false;
    if (children.has(targetId)) return true;

    for (const child of children) {
      if (this.isDescendant(session, child, targetId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Handles peer removal (leave or unexpected disconnect).
   * Returns list of affected children that need reparenting.
   */
  removePeer({ broadcastId, peerId }) {
    const session = this.broadcasts.get(broadcastId);
    if (!session || !session.nodes.has(peerId)) {
      return { isOrigin: false, orphanedChildren: [] };
    }

    // If origin disconnected, stream ends
    if (peerId === session.originPeerId) {
      this.broadcasts.delete(broadcastId);
      return { isOrigin: true, orphanedChildren: [] };
    }

    // Remove from parent's child list
    const parentId = session.parents.get(peerId);
    if (parentId && session.children.has(parentId)) {
      session.children.get(parentId).delete(peerId);
    }

    const myChildren = Array.from(session.children.get(peerId) || []);

    // Clean up node records
    session.nodes.delete(peerId);
    session.parents.delete(peerId);
    session.children.delete(peerId);
    session.tiers.delete(peerId);
    session.standbys.delete(peerId);

    // Reparent each orphaned child
    const reparented = [];
    for (const orphanId of myChildren) {
      if (!session.nodes.has(orphanId)) continue;
      const { parentPeerId, tier } = this.selectBestParent(session, orphanId);
      session.parents.set(orphanId, parentPeerId);
      session.children.get(parentPeerId).add(orphanId);
      session.tiers.set(orphanId, tier);

      const standbys = this.selectStandbyParents(session, orphanId, parentPeerId);
      session.standbys.set(orphanId, standbys);

      reparented.push({
        childPeerId: orphanId,
        newParentPeerId: parentPeerId,
        standbyParents: standbys,
        tier,
      });
    }

    return {
      isOrigin: false,
      orphanedChildren: reparented,
    };
  }

  /**
   * Promotes a standby parent to active parent upon heartbeat loss.
   */
  promoteStandby({ broadcastId, peerId, standbyPeerId }) {
    const session = this.broadcasts.get(broadcastId);
    if (!session || !session.nodes.has(peerId)) return null;

    // Check standby candidate exists and won't create a cycle
    if (!session.nodes.has(standbyPeerId) || this.isDescendant(session, peerId, standbyPeerId)) {
      // Re-assign automatically
      const { parentPeerId, tier } = this.selectBestParent(session, peerId);
      return this.reassignParent(session, peerId, parentPeerId, tier);
    }

    const newTier = (session.tiers.get(standbyPeerId) || 0) + 1;
    return this.reassignParent(session, peerId, standbyPeerId, newTier);
  }

  reassignParent(session, peerId, newParentId, newTier) {
    const oldParentId = session.parents.get(peerId);
    if (oldParentId && session.children.has(oldParentId)) {
      session.children.get(oldParentId).delete(peerId);
    }

    session.parents.set(peerId, newParentId);
    if (!session.children.has(newParentId)) {
      session.children.set(newParentId, new Set());
    }
    session.children.get(newParentId).add(peerId);
    session.tiers.set(peerId, newTier);

    const standbys = this.selectStandbyParents(session, peerId, newParentId);
    session.standbys.set(peerId, standbys);

    return {
      broadcastId: session.broadcastId,
      peerId,
      parentPeerId: newParentId,
      standbyParents: standbys,
      tier: newTier,
    };
  }

  getTopologySnapshot(broadcastId) {
    const session = this.broadcasts.get(broadcastId);
    if (!session) return null;

    const nodes = [];
    for (const [id, meta] of session.nodes) {
      nodes.push({
        peerId: id,
        isOrigin: id === session.originPeerId,
        tier: session.tiers.get(id) || 0,
        parentPeerId: session.parents.get(id) || null,
        childCount: (session.children.get(id) || new Set()).size,
        isMobile: meta.isMobile,
        relayEligible: meta.relayEligible,
      });
    }

    return {
      broadcastId,
      title: session.title,
      originPeerId: session.originPeerId,
      totalViewers: session.nodes.size - 1,
      maxTier: Math.max(0, ...session.tiers.values()),
      nodes,
    };
  }
}

