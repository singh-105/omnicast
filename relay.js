import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import net from 'node:net';
import fs from 'fs';
import { TopologyCoordinator } from './src/features/broadcast/topology/topologyCoordinator.js';

const KEY_FILE = './relay-key.json';
const SIGNALING_PATH = '/signaling';
const BROADCAST_ID_REGEX = /^[A-Za-z0-9_-]{1,16}$/;

// The single port Render or local dev exposes.
const PUBLIC_PORT = Number(process.env.PORT || 10000);
const LIBP2P_PORT = PUBLIC_PORT === 10101 ? 10102 : 10101;
const PUBLIC_HOST = process.env.RENDER_EXTERNAL_HOSTNAME;

async function getOrCreatePrivateKey() {
  if (fs.existsSync(KEY_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'));
      return privateKeyFromProtobuf(Uint8Array.from(raw));
    } catch (e) {
      console.warn('⚠️  Could not load saved key, generating new one:', e.message);
    }
  }

  const privateKey = await generateKeyPair('Ed25519');
  const protobuf = privateKeyToProtobuf(privateKey);
  fs.writeFileSync(KEY_FILE, JSON.stringify(Array.from(protobuf)));
  console.log('🔑 Generated and saved new persistent relay key.');
  return privateKey;
}

// ─── OmniCast WebRTC Signaling & Topology Coordinator ───
// Central WebSocket transmits ONLY signaling (SDP/ICE), session management,
// and tree topology coordination. ZERO MEDIA PAYLOAD BYTES ARE PERMITTED.
function createSignalingServer(topologyCoordinator) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024, // 256 KB max message payload
  });

  // Map: peerId -> { ws, capabilities, activeBroadcastId, role }
  const connectedPeers = new Map();

  function sendToPeer(peerId, message) {
    const peer = connectedPeers.get(peerId);
    if (peer && peer.ws.readyState === 1) { // 1 = OPEN
      try {
        peer.ws.send(JSON.stringify(message));
        return true;
      } catch (err) {
        console.warn(`[Signaling] Failed to send to peer ${peerId}:`, err.message);
      }
    }
    return false;
  }

  function broadcastToAll(message, excludePeerId = null) {
    const payload = JSON.stringify(message);
    for (const [pid, peer] of connectedPeers) {
      if (pid !== excludePeerId && peer.ws.readyState === 1) {
        try {
          peer.ws.send(payload);
        } catch (_) {}
      }
    }
  }

  function livePeerCount() {
    let count = 0;
    for (const [, peer] of connectedPeers) {
      if (peer.ws.readyState === 1) count++;
    }
    return count;
  }

  wss.on('connection', (ws) => {
    let thisPeerId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          // ── Peer announces identity ──
          case 'announce': {
            thisPeerId = msg.peerId;
            const existing = connectedPeers.get(thisPeerId);
            if (existing && existing.ws !== ws) {
              try { existing.ws.close(); } catch (_) {}
            }

            connectedPeers.set(thisPeerId, {
              ws,
              capabilities: msg.capabilities || {},
              activeBroadcastId: null,
              role: 'idle',
            });

            // Send current active broadcast list to newly connected peer
            ws.send(JSON.stringify({
              type: 'broadcast:list-response',
              broadcasts: topologyCoordinator.listBroadcasts(),
            }));

            console.log(`👤 Peer connected: ${thisPeerId.slice(-8)} (total live: ${livePeerCount()})`);
            break;
          }

          // ── Broadcaster creates a new live broadcast ──
          case 'broadcast:create': {
            const { broadcastId, title, originPubKey, mimeType, maxChildren } = msg;

            if (!broadcastId || !BROADCAST_ID_REGEX.test(broadcastId)) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'INVALID_BROADCAST_ID',
                message: 'Invalid broadcast ID format (1-16 alphanumeric or hyphen/underscore characters)',
              }));
              break;
            }

            const sanitizedTitle = (title || 'OmniCast Live Stream').slice(0, 100);

            try {
              const session = topologyCoordinator.createBroadcast({
                broadcastId,
                title: sanitizedTitle,
                originPeerId: thisPeerId,
                originPubKey,
                mimeType,
                maxChildren,
              });

              const peer = connectedPeers.get(thisPeerId);
              if (peer) {
                peer.activeBroadcastId = broadcastId;
                peer.role = 'broadcaster';
              }

              ws.send(JSON.stringify({
                type: 'broadcast:created',
                broadcastId,
                session: {
                  broadcastId: session.broadcastId,
                  title: session.title,
                  originPeerId: session.originPeerId,
                  createdAt: session.createdAt,
                },
              }));

              // Announce new broadcast to all other peers
              broadcastToAll({
                type: 'broadcast:announced',
                broadcast: {
                  broadcastId: session.broadcastId,
                  title: session.title,
                  originPeerId: session.originPeerId,
                  createdAt: session.createdAt,
                  viewerCount: 0,
                },
              }, thisPeerId);

              console.log(`📡 Broadcast created: "${sanitizedTitle}" [${broadcastId}] by ${thisPeerId.slice(-8)}`);
            } catch (err) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'BROADCAST_CREATE_FAILED',
                message: err.message,
              }));
            }
            break;
          }

          // ── Get list of active broadcasts ──
          case 'broadcast:list': {
            ws.send(JSON.stringify({
              type: 'broadcast:list-response',
              broadcasts: topologyCoordinator.listBroadcasts(),
            }));
            break;
          }

          // ── Broadcaster stops the stream ──
          case 'broadcast:stop': {
            const { broadcastId } = msg;
            const session = topologyCoordinator.stopBroadcast(broadcastId);
            if (session) {
              broadcastToAll({
                type: 'broadcast:ended',
                broadcastId,
              });
              console.log(`🛑 Broadcast stopped: [${broadcastId}]`);
            }
            break;
          }

          // ── Viewer joins a broadcast ──
          case 'broadcast:join': {
            const { broadcastId, capabilities } = msg;

            if (!broadcastId || !BROADCAST_ID_REGEX.test(broadcastId)) {
              ws.send(JSON.stringify({
                type: 'error',
                code: 'INVALID_BROADCAST_ID',
                message: 'Invalid broadcast ID format',
              }));
              break;
            }

            try {
              const assignment = topologyCoordinator.joinViewer({
                broadcastId,
                peerId: thisPeerId,
                capabilities: capabilities || {},
              });

              const peer = connectedPeers.get(thisPeerId);
              if (peer) {
                peer.activeBroadcastId = broadcastId;
                peer.role = assignment.tier === 1 ? 'tier1-relay' : `tier${assignment.tier}-viewer`;
              }

              // Send tree assignment to the joining viewer
              ws.send(JSON.stringify({
                type: 'topology:assigned',
                ...assignment,
              }));

              // Tell the assigned parent that a child is connecting
              sendToPeer(assignment.parentPeerId, {
                type: 'topology:child-assigned',
                broadcastId,
                childPeerId: thisPeerId,
                tier: assignment.tier,
              });

              // Notify broadcaster/all of viewer count update
              const bcast = topologyCoordinator.getBroadcast(broadcastId);
              if (bcast) {
                broadcastToAll({
                  type: 'broadcast:viewer-count',
                  broadcastId,
                  viewerCount: Math.max(0, bcast.nodes.size - 1),
                  maxTier: Math.max(0, ...bcast.tiers.values()),
                });
              }

              console.log(`👥 Peer ${thisPeerId.slice(-8)} joined [${broadcastId}], parent: ${assignment.parentPeerId.slice(-8)} (Tier ${assignment.tier})`);
            } catch (err) {
              ws.send(JSON.stringify({
                type: 'error',
                code: err.code || 'JOIN_FAILED',
                message: err.message,
              }));
            }
            break;
          }

          // ── Viewer leaves a broadcast ──
          case 'broadcast:leave': {
            const { broadcastId } = msg;
            handlePeerDepartureFromBroadcast(thisPeerId, broadcastId);
            break;
          }

          // ── WebRTC Signaling Relay (SDP Offer, Answer, ICE Candidate) ──
          // Strictly point-to-point forwarding; no video payloads on signaling path!
          case 'signal:relay': {
            const { toPeerId, broadcastId, signalType, signalData } = msg;
            const targetPeer = connectedPeers.get(toPeerId);

            if (!targetPeer) {
              ws.send(JSON.stringify({
                type: 'signal:failed',
                targetPeerId: toPeerId,
                reason: 'Peer unreachable or disconnected',
              }));
              break;
            }

            // Enforce same session if session is active
            if (broadcastId && targetPeer.activeBroadcastId && targetPeer.activeBroadcastId !== broadcastId) {
              ws.send(JSON.stringify({
                type: 'signal:failed',
                targetPeerId: toPeerId,
                reason: 'Cross-session signaling rejected',
              }));
              break;
            }

            if (signalType === 'offer' || signalType === 'answer') {
              console.log(`[Signal] ${thisPeerId.slice(-8)} -> ${toPeerId.slice(-8)}: ${signalType}`);
            }

            const delivered = sendToPeer(toPeerId, {
              type: 'signal:relay',
              fromPeerId: thisPeerId,
              broadcastId,
              signalType,
              signalData,
            });

            if (!delivered) {
              ws.send(JSON.stringify({
                type: 'signal:failed',
                targetPeerId: toPeerId,
                reason: 'Peer unreachable or disconnected',
              }));
            }
            break;
          }

          // ── Promote Standby Parent (failover trigger from client) ──
          case 'topology:promote-standby': {
            const { broadcastId, standbyPeerId } = msg;
            const newAssignment = topologyCoordinator.promoteStandby({
              broadcastId,
              peerId: thisPeerId,
              standbyPeerId,
            });

            if (newAssignment) {
              ws.send(JSON.stringify({
                type: 'topology:assigned',
                ...newAssignment,
              }));

              sendToPeer(newAssignment.parentPeerId, {
                type: 'topology:child-assigned',
                broadcastId,
                childPeerId: thisPeerId,
                tier: newAssignment.tier,
              });

              console.log(`⚡ Failover: Peer ${thisPeerId.slice(-8)} promoted standby parent ${newAssignment.parentPeerId.slice(-8)} (Tier ${newAssignment.tier})`);
            }
            break;
          }

          // ── Link Failed Notification (ICE or transport timeout) ──
          case 'topology:link-failed': {
            const { broadcastId, failedParentPeerId } = msg;
            const newAssignment = topologyCoordinator.reportLinkFailed({
              broadcastId,
              peerId: thisPeerId,
              failedParentPeerId,
            });

            if (newAssignment) {
              ws.send(JSON.stringify({
                type: 'topology:assigned',
                ...newAssignment,
              }));

              sendToPeer(newAssignment.parentPeerId, {
                type: 'topology:child-assigned',
                broadcastId,
                childPeerId: thisPeerId,
                tier: newAssignment.tier,
              });

              console.log(`⚠️ Link failure recovered: Peer ${thisPeerId.slice(-8)} reassigned to ${newAssignment.parentPeerId.slice(-8)} (Tier ${newAssignment.tier})`);
            }
            break;
          }

          // ── Telemetry report from client ──
          case 'telemetry:report': {
            // Can be logged or queried for diagnostics
            break;
          }

          default:
            console.warn('[Signaling] Unknown message type:', msg.type);
        }
      } catch (e) {
        console.warn('[Signaling] Malformed message:', e.message);
      }
    });

    ws.on('close', () => {
      if (thisPeerId) {
        const peer = connectedPeers.get(thisPeerId);
        if (peer && peer.activeBroadcastId) {
          handlePeerDepartureFromBroadcast(thisPeerId, peer.activeBroadcastId);
        }
        if (peer && peer.ws === ws) {
          connectedPeers.delete(thisPeerId);
        }
        console.log(`👋 Peer disconnected: ${thisPeerId.slice(-8)} (total live: ${livePeerCount()})`);
      }
    });

    function handlePeerDepartureFromBroadcast(peerId, broadcastId) {
      const departure = topologyCoordinator.removePeer({ broadcastId, peerId });

      if (departure.isOrigin) {
        // Broadcaster departed: stream ends!
        broadcastToAll({
          type: 'broadcast:ended',
          broadcastId,
        });
        console.log(`🛑 Broadcaster disconnected, broadcast [${broadcastId}] ended`);
      } else if (departure.orphanedChildren && departure.orphanedChildren.length > 0) {
        // Relay departed: inform orphaned children of their new parents
        for (const reparent of departure.orphanedChildren) {
          sendToPeer(reparent.childPeerId, {
            type: 'topology:reparent',
            broadcastId,
            newParentPeerId: reparent.newParentPeerId,
            standbyParents: reparent.standbyParents,
            tier: reparent.tier,
          });

          sendToPeer(reparent.newParentPeerId, {
            type: 'topology:child-assigned',
            broadcastId,
            childPeerId: reparent.childPeerId,
            tier: reparent.tier,
          });

          console.log(`🔄 Orphan ${reparent.childPeerId.slice(-8)} reparented to ${reparent.newParentPeerId.slice(-8)} (Tier ${reparent.tier})`);
        }
      }

      const bcast = topologyCoordinator.getBroadcast(broadcastId);
      if (bcast) {
        broadcastToAll({
          type: 'broadcast:viewer-count',
          broadcastId,
          viewerCount: Math.max(0, bcast.nodes.size - 1),
          maxTier: Math.max(0, ...bcast.tiers.values()),
        });
      }
    }
  });

  return wss;
}

// ─── Forward a WebSocket upgrade to libp2p's loopback listener ───
function proxyUpgradeToLibp2p(req, socket, head) {
  const upstream = net.connect(LIBP2P_PORT, '127.0.0.1', () => {
    let preamble = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      preamble += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    upstream.write(`${preamble}\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

async function main() {
  const privateKey = await getOrCreatePrivateKey();

  const server = await createLibp2p({
    privateKey,
    addresses: {
      listen: [`/ip4/127.0.0.1/tcp/${LIBP2P_PORT}/ws`],
      announce: PUBLIC_HOST ? [`/dns4/${PUBLIC_HOST}/tcp/443/wss`] : [],
    },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      relay: circuitRelayServer(),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
      identify: identify(),
    },
  });

  const peerId = server.peerId.toString();
  const topologyCoordinator = new TopologyCoordinator({ maxChildren: 5 });

  // ─── Single public HTTP server: health checks + REST API + WebSockets ───
  const httpServer = http.createServer((req, res) => {
    // Enable CORS for API routes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        peerId,
        activeBroadcasts: topologyCoordinator.listBroadcasts().length,
      }));
      return;
    }

    const urlPath = (req.url || '').split('?')[0].replace(/\/$/, '');

    if (urlPath === '/api/broadcasts') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(JSON.stringify(topologyCoordinator.listBroadcasts()));
      return;
    }

    const topologyMatch = req.url.match(/^\/api\/broadcasts\/([^/]+)\/topology$/);
    if (topologyMatch) {
      const bcastId = topologyMatch[1];
      const snapshot = topologyCoordinator.getTopologySnapshot(bcastId);
      if (snapshot) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Broadcast not found' }));
      }
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`OmniCast Relay Server\nPeer ID: ${peerId}\nSignaling: ${SIGNALING_PATH}\nActive Broadcasts: ${topologyCoordinator.listBroadcasts().length}\n`);
  });

  const wss = createSignalingServer(topologyCoordinator);

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch (_) {
      pathname = '/';
    }

    socket.setNoDelay(true);

    if (pathname === SIGNALING_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }

    proxyUpgradeToLibp2p(req, socket, head);
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PUBLIC_PORT, '0.0.0.0', resolve);
  });

  console.log(`\n🚀 OmniCast Relay & Signaling Server running!`);
  console.log(`   Peer ID: ${peerId}`);
  console.log(`🌐 Public port: ${PUBLIC_PORT}`);
  console.log(`📡 WebRTC Signaling & Topology: ws://0.0.0.0:${PUBLIC_PORT}${SIGNALING_PATH}`);
  console.log(`🔗 libp2p loopback on :${LIBP2P_PORT}`);
}

main().catch((err) => {
  console.error('Failed to start OmniCast relay server:', err);
  process.exit(1);
});
