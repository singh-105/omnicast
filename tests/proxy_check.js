import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

async function testViteProxy() {
  console.log('Testing Vite reverse-proxy for REST and WebSockets on port 5173...\n');

  // 1. Test REST proxy: http://localhost:5173/api/broadcasts
  console.log('1. Checking REST /api/broadcasts proxy...');
  const res = await fetch('http://localhost:5173/api/broadcasts');
  assert.equal(res.status, 200, 'REST proxy must return HTTP 200');
  const data = await res.json();
  console.log('   ✅ REST proxy succeeded! Response:', data);

  // 2. Test WebSocket proxy: ws://localhost:5173/signaling
  console.log('2. Checking WebSocket /signaling upgrade proxy...');
  const ws = new WebSocket('ws://localhost:5173/signaling');

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('   ✅ WebSocket proxy upgrade on port 5173 succeeded!');
      ws.send(JSON.stringify({ type: 'announce', peerId: 'test-proxy-peer' }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      console.log('   ✅ Received response from relay over proxy:', msg.type);
      assert.ok(['announced', 'broadcast:list-response'].includes(msg.type));
      ws.close();
      resolve();
    });

    ws.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => reject(new Error('Timeout waiting for WebSocket proxy response')), 5000);
  });

  console.log('\n🎉 VITE SAME-ORIGIN REVERSE PROXY VERIFIED! Remote phones on https://... can now connect via single port!');
}

testViteProxy().catch((err) => {
  console.error('❌ Proxy check failed:', err);
  process.exit(1);
});
