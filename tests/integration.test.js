import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { TopologyCoordinator } from '../src/features/broadcast/topology/topologyCoordinator.js';

describe('OmniCast Signaling & WebRTC Relay Integration', () => {
  let httpServer;
  let wss;
  let port;
  const coordinator = new TopologyCoordinator({ maxChildren: 5 });

  before(async () => {
    httpServer = http.createServer();
    wss = new WebSocketServer({ noServer: true });

    const connectedPeers = new Map();

    function sendToPeer(peerId, message) {
      const peer = connectedPeers.get(peerId);
      if (peer && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(JSON.stringify(message));
        return true;
      }
      return false;
    }

    function broadcastToAll(message) {
      const payload = JSON.stringify(message);
      for (const [, peer] of connectedPeers) {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(payload);
        }
      }
    }

    wss.on('connection', (ws) => {
      let thisPeerId = null;

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'announce':
            thisPeerId = msg.peerId;
            connectedPeers.set(thisPeerId, { ws });
            ws.send(JSON.stringify({ type: 'announced', peerId: thisPeerId }));
            break;

          case 'broadcast:create': {
            const session = coordinator.createBroadcast({
              broadcastId: msg.broadcastId,
              title: msg.title,
              originPeerId: thisPeerId,
              originPubKey: msg.originPubKey,
            });
            ws.send(JSON.stringify({ type: 'broadcast:created', broadcastId: session.broadcastId }));
            break;
          }

          case 'broadcast:join': {
            const assignment = coordinator.joinViewer({
              broadcastId: msg.broadcastId,
              peerId: thisPeerId,
            });
            ws.send(JSON.stringify({ type: 'topology:assigned', ...assignment }));
            sendToPeer(assignment.parentPeerId, {
              type: 'topology:child-assigned',
              broadcastId: msg.broadcastId,
              childPeerId: thisPeerId,
            });
            break;
          }

          case 'signal:relay': {
            sendToPeer(msg.toPeerId, {
              type: 'signal:relay',
              fromPeerId: thisPeerId,
              broadcastId: msg.broadcastId,
              signalType: msg.signalType,
              signalData: msg.signalData,
            });
            break;
          }

          case 'broadcast:stop': {
            coordinator.stopBroadcast(msg.broadcastId);
            broadcastToAll({ type: 'broadcast:ended', broadcastId: msg.broadcastId });
            break;
          }
        }
      });
    });

    httpServer.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    await new Promise((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    wss.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('completes full broadcaster creation, viewer join, and WebRTC SDP signaling exchange', async () => {
    const wsUrl = `ws://127.0.0.1:${port}`;

    // 1. Broadcaster connects
    const broadcasterWs = new WebSocket(wsUrl);
    await new Promise((r) => (broadcasterWs.onopen = r));
    broadcasterWs.send(JSON.stringify({ type: 'announce', peerId: 'broadcaster-1' }));

    await new Promise((resolve) => {
      broadcasterWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'announced') resolve();
      };
    });

    // 2. Broadcaster creates session
    broadcasterWs.send(JSON.stringify({
      type: 'broadcast:create',
      broadcastId: 'live-stream-integration',
      title: 'Integration Test Stream',
      originPubKey: 'mock-spki-key',
    }));

    await new Promise((resolve) => {
      broadcasterWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'broadcast:created') {
          assert.equal(msg.broadcastId, 'live-stream-integration');
          resolve();
        }
      };
    });

    // 3. Viewer connects and joins stream
    const viewerWs = new WebSocket(wsUrl);
    await new Promise((r) => (viewerWs.onopen = r));
    viewerWs.send(JSON.stringify({ type: 'announce', peerId: 'viewer-1' }));

    await new Promise((r) => setTimeout(r, 50));

    viewerWs.send(JSON.stringify({
      type: 'broadcast:join',
      broadcastId: 'live-stream-integration',
    }));

    // Viewer should receive topology assignment pointing to broadcaster as parent
    await new Promise((resolve) => {
      viewerWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'topology:assigned') {
          assert.equal(msg.parentPeerId, 'broadcaster-1');
          assert.equal(msg.tier, 1);
          resolve();
        }
      };
    });

    // 4. Viewer sends WebRTC SDP Offer to Broadcaster over signaling
    viewerWs.send(JSON.stringify({
      type: 'signal:relay',
      toPeerId: 'broadcaster-1',
      broadcastId: 'live-stream-integration',
      signalType: 'offer',
      signalData: { type: 'offer', sdp: 'v=0\r\no=viewer 1234 5678...' },
    }));

    // Broadcaster should receive the SDP offer
    await new Promise((resolve) => {
      broadcasterWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'signal:relay' && msg.signalType === 'offer') {
          assert.equal(msg.fromPeerId, 'viewer-1');
          assert.equal(msg.signalData.type, 'offer');
          resolve();
        }
      };
    });

    // 5. Broadcaster sends WebRTC SDP Answer back to Viewer
    broadcasterWs.send(JSON.stringify({
      type: 'signal:relay',
      toPeerId: 'viewer-1',
      broadcastId: 'live-stream-integration',
      signalType: 'answer',
      signalData: { type: 'answer', sdp: 'v=0\r\no=broadcaster 5678 1234...' },
    }));

    // Viewer should receive the SDP answer
    await new Promise((resolve) => {
      viewerWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'signal:relay' && msg.signalType === 'answer') {
          assert.equal(msg.fromPeerId, 'broadcaster-1');
          assert.equal(msg.signalData.type, 'answer');
          resolve();
        }
      };
    });

    // 6. Broadcaster stops stream -> Viewer receives broadcast:ended
    broadcasterWs.send(JSON.stringify({
      type: 'broadcast:stop',
      broadcastId: 'live-stream-integration',
    }));

    await new Promise((resolve) => {
      viewerWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'broadcast:ended') {
          assert.equal(msg.broadcastId, 'live-stream-integration');
          resolve();
        }
      };
    });

    broadcasterWs.close();
    viewerWs.close();
  });
});

