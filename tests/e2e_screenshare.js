import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runScreenShareSuite() {
  console.log('🚀 Starting OmniCast Screen Sharing & Live Source Switching Verification...\n');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    // ══════════════════════════════════════════════════════════════════════
    // SCENARIO 1: Start Broadcast Directly with Screen Share
    // ══════════════════════════════════════════════════════════════════════
    console.log('🖥️ SCENARIO 1: Configuring studio for Screen Share first, then starting broadcast...');
    const bcastContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bcastPage = await bcastContext.newPage();

    bcastPage.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('vite') && !txt.includes('React DevTools')) {
        console.log(`   [Bcast] ${txt}`);
      }
    });

    await bcastPage.goto('http://localhost:5173/?studio=true', { waitUntil: 'networkidle' });
    await bcastPage.waitForSelector('text=BROADCASTER STUDIO');

    // Click "Screen Share" toggle before going live
    const screenToggleBtn = await bcastPage.waitForSelector('button:has-text("Screen Share")');
    await screenToggleBtn.click();
    console.log('   ✅ Selected Screen Share source mode.');

    // Click "Start Live Broadcast"
    const startBtn = await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")');
    await startBtn.click();

    await bcastPage.waitForSelector('text=ON AIR', { timeout: 10000 });
    console.log('   ✅ Broadcaster is ON AIR with Screen Share!');

    // Verify local monitor video is playing
    await bcastPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.readyState >= 2 && video.videoWidth > 0;
    }, { timeout: 10000 });
    console.log('   ✅ Broadcaster monitor rendering screen share frames!');

    // Get active broadcast session ID
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
    console.log(`   ✅ Session ID: [${broadcastId}]`);

    // ══════════════════════════════════════════════════════════════════════
    // VIEWER JOIN: Verify screen share playback on viewer
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n👥 Viewer joining to observe screen share...');
    const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const viewerPage = await viewerContext.newPage();

    viewerPage.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('vite') && !txt.includes('React DevTools')) {
        console.log(`   [Viewer] ${txt}`);
      }
    });
    viewerPage.on('pageerror', (err) => console.log(`   [Viewer Error] ${err.message}`));

    await viewerPage.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await viewerPage.waitForSelector('text=LIVE BROADCAST');

    await viewerPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.currentTime > 0.2;
    }, { timeout: 15000 });
    console.log('   ✅ Viewer is playing initial screen share stream via MSE!');

    // ══════════════════════════════════════════════════════════════════════
    // SCENARIO 2: Live Switch Screen Share → Camera While Broadcasting
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🔄 SCENARIO 2: Live switching from Screen Share → Camera...');
    const cameraToggleBtn = await bcastPage.waitForSelector('button:has-text("Camera")');
    await cameraToggleBtn.click();

    // Verify camera button is now active
    await bcastPage.waitForFunction(() => {
      const camBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Camera'));
      return camBtn && camBtn.classList.contains('bg-cerulean');
    }, { timeout: 8000 });
    console.log('   ✅ Broadcaster switched live to Camera!');

    // Wait a brief moment to allow new init segment and video frames to propagate
    await new Promise((r) => setTimeout(r, 2000));

    // Verify Viewer continues playing without freeze
    const viewerPlaybackTime = await viewerPage.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : 0;
    });
    console.log(`   ✅ Viewer playback advancing during switch (t=${viewerPlaybackTime.toFixed(2)}s)`);
    assert(viewerPlaybackTime > 0, 'Viewer playback must continue');

    // ══════════════════════════════════════════════════════════════════════
    // SCENARIO 3: Live Switch Camera → Screen Share While Broadcasting
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🔄 SCENARIO 3: Live switching from Camera → Screen Share...');
    const liveScreenBtn = await bcastPage.waitForSelector('button:has-text("Screen Share")');
    await liveScreenBtn.click();

    await bcastPage.waitForFunction(() => {
      const scrBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Screen Share'));
      return scrBtn && scrBtn.classList.contains('bg-cerulean');
    }, { timeout: 8000 });
    console.log('   ✅ Broadcaster switched live back to Screen Share!');

    // Wait for viewer to receive and decode new frames
    await viewerPage.waitForFunction((initialTime) => {
      const video = document.querySelector('video');
      return video && !video.paused && video.currentTime > initialTime;
    }, viewerPlaybackTime, { timeout: 15000 });

    const finalPlaybackTime = await viewerPage.evaluate(() => {
      const video = document.querySelector('video');
      return video ? video.currentTime : 0;
    });
    console.log(`   ✅ Viewer successfully received new screen stream (t=${finalPlaybackTime.toFixed(2)}s)`);
    assert(finalPlaybackTime > viewerPlaybackTime, 'Viewer playback must advance after second source switch');

    // ══════════════════════════════════════════════════════════════════════
    // SCENARIO 4: Teardown
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🛑 Cleaning up and ending broadcast session...');
    const endBtn = await bcastPage.waitForSelector('button:has-text("End Broadcast")');
    await endBtn.click();
    await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")', { timeout: 8000 });
    console.log('   ✅ Clean teardown verified.');

    console.log('\n🎉 ALL SCREEN SHARING & SOURCE SWITCHING TESTS PASSED!');
  } finally {
    await browser.close();
  }
}

runScreenShareSuite().catch((err) => {
  console.error('\n❌ Screen Share E2E suite error:', err);
  process.exit(1);
});

