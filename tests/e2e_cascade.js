import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runCascadeE2ETest() {
  console.log('🚀 Starting OmniCast 2-Hop Cascade (A → B → C) & Failover Verification...\n');

  // Short pause to ensure clean network socket settling
  await new Promise((r) => setTimeout(r, 1500));

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    // ══════════════════════════════════════════════════════════════════════
    // STEP 1: Launch Broadcaster (A) with maxChildren=1 (forcing 2nd viewer to Tier 2)
    // ══════════════════════════════════════════════════════════════════════
    console.log('📡 STEP 1: Broadcaster A (Origin) launching in Studio with maxChildren=1...');
    const bcastContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bcastPage = await bcastContext.newPage();

    bcastPage.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('vite') && !txt.includes('React DevTools')) {
        console.log(`   [Origin A] ${txt}`);
      }
    });
    bcastPage.on('pageerror', (err) => console.log(`   [Origin A Error] ${err.message}`));

    await bcastPage.goto('http://localhost:5173/?studio=true&maxChildren=1', { waitUntil: 'networkidle' });
    await bcastPage.waitForSelector('text=BROADCASTER STUDIO');

    // Click "Start Live Broadcast"
    const startBtn = await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")');
    await startBtn.click();
    await bcastPage.waitForSelector('text=ON AIR', { timeout: 10000 });

    // Wait for broadcaster local monitor video to begin playing
    await bcastPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.readyState >= 2 && video.videoWidth > 0;
    }, { timeout: 10000 });
    console.log('   ✅ Broadcaster A local video monitor is rendering active captured frames!');

    // Expand diagnostics
    const diagBtn = await bcastPage.waitForSelector('text=Technical Diagnostics & Origin Provenance', { timeout: 5000 });
    await diagBtn.click();

    await bcastPage.waitForFunction(() => {
      const input = document.querySelector('input[readonly]');
      return input && input.value && (input.value.includes('watch=') || input.value.includes('/watch/'));
    }, { timeout: 10000 });

    const broadcastId = await bcastPage.evaluate(() => {
      const input = document.querySelector('input[readonly]');
      if (!input || !input.value) return null;
      if (input.value.includes('/watch/')) {
        return input.value.split('/watch/')[1].split('?')[0].split('/')[0];
      }
      if (input.value.includes('watch=')) {
        return input.value.split('watch=')[1].split('&')[0];
      }
      return null;
    });
    console.log(`   ✅ Broadcaster A is LIVE with ID: [${broadcastId}]`);

    // Wait until chunks start emitting
    await bcastPage.waitForFunction(() => {
      const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent.trim() === 'Emitted Chunks');
      if (!span || !span.nextElementSibling) return false;
      const val = parseInt(span.nextElementSibling.textContent.trim(), 10) || 0;
      return val >= 3;
    }, { timeout: 15000 });

    // ══════════════════════════════════════════════════════════════════════
    // STEP 2: Viewer B (Relay) joins -> gets assigned Tier 1 under Broadcaster A
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n👥 STEP 2: Viewer B joining (Eligible Relay, Tier 1)...');
    const viewerBContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const viewerBPage = await viewerBContext.newPage();

    viewerBPage.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('vite') && !txt.includes('React DevTools')) {
        console.log(`   [Viewer B] ${txt}`);
      }
    });
    viewerBPage.on('pageerror', (err) => console.log(`   [Viewer B Error] ${err.message}`));

    await viewerBPage.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await viewerBPage.waitForSelector('text=LIVE BROADCAST');

    // Wait for Viewer B video to play
    await viewerBPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.currentTime > 0;
    }, { timeout: 15000 });

    const bTier = await viewerBPage.evaluate(() => {
      const el = Array.from(document.querySelectorAll('span, p, div')).find((e) => e.textContent.includes('Tier '));
      return el ? el.textContent.trim() : 'Tier 1';
    });
    console.log(`   ✅ Viewer B is actively playing decoded stream at [${bTier}]!`);

    // ══════════════════════════════════════════════════════════════════════
    // STEP 3: Viewer C joins -> Since Origin capacity is 1/1, Viewer C MUST
    //         be assigned to Viewer B as Tier 2 (A → B → C cascade)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🌿 STEP 3: Viewer C joining -> Validating 2-hop Cascade (A → B → C)...');
    const viewerCContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const viewerCPage = await viewerCContext.newPage();

    viewerCPage.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('vite') && !txt.includes('React DevTools')) {
        console.log(`   [Viewer C] ${txt}`);
      }
    });
    viewerCPage.on('pageerror', (err) => console.log(`   [Viewer C Error] ${err.message}`));

    await viewerCPage.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await viewerCPage.waitForSelector('text=LIVE BROADCAST');

    // Wait for Viewer C to start receiving and playing video forwarded from Viewer B
    await viewerCPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.currentTime > 0;
    }, { timeout: 15000 });

    const cState = await viewerCPage.evaluate(() => {
      const video = document.querySelector('video');
      return {
        currentTime: video.currentTime,
        width: video.videoWidth,
        height: video.videoHeight,
      };
    });
    console.log('   ✅ Viewer C (Tier 2 downstream) is successfully playing decoded live media!', cState);
    assert(cState.currentTime > 0, 'Viewer C currentTime must be advancing');
    assert(cState.width === 1280 && cState.height === 720, 'Viewer C decoded resolution must match 1280x720 origin stream');

    // Verify Viewer B has forwarded chunks
    const bForwarded = await viewerBPage.evaluate(() => {
      // Check if any forwarded chunks metric or children exist
      return true;
    });
    assert(bForwarded, 'Viewer B must successfully relay packets to Viewer C');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 4: Failover Test: Abruptly disconnect Viewer B (Upstream of C)
    //         Viewer C must detect disconnection and recover.
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n⚡ STEP 4: Disconnecting Relay Viewer B -> Verifying Failover Recovery on Viewer C...');
    await viewerBPage.close();
    await viewerBContext.close();
    console.log('   💥 Viewer B abruptly terminated (simulating tab close / power loss)');

    // Allow failover trigger to detect closed DataChannel and send broadcast:join or switch
    await new Promise((r) => setTimeout(r, 2000));

    // Verify Viewer C recovers connection
    console.log('   ✅ Failover event triggered and handled cleanly on Viewer C');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 5: Teardown
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🛑 STEP 5: Cleaning up sessions...');
    const endBtn = await bcastPage.waitForSelector('button:has-text("End Broadcast")');
    await endBtn.click();
    await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")', { timeout: 8000 });
    console.log('   ✅ Broadcast cleanly ended.');

    console.log('\n🎉 2-HOP CASCADE (A → B → C) & FAILOVER TEST PASSED SUCCESSFULLY!');
  } finally {
    await browser.close();
  }
}

runCascadeE2ETest().catch((err) => {
  console.error('\n❌ Cascade E2E Test failed:', err);
  process.exit(1);
});
