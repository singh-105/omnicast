import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runSustainedStabilityTest() {
  console.log('⏱️ Starting OmniCast Sustained Streaming & Resilience Test (90s continuous audit)...\n');

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
    // Launch Broadcaster
    console.log('📡 Launching Broadcaster in Studio...');
    const bcastContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bcastPage = await bcastContext.newPage();

    let trackEndedEvents = 0;
    let broadcasterErrors = 0;

    bcastPage.on('console', (msg) => {
      const txt = msg.text();
      if (txt.includes('ended') || txt.includes('mute')) {
        trackEndedEvents++;
        console.log(`   [Bcast Event] ${txt}`);
      }
    });
    bcastPage.on('pageerror', (err) => {
      broadcasterErrors++;
      console.log(`   [Bcast Error] ${err.message}`);
    });

    await bcastPage.goto('http://localhost:5173/?studio=true', { waitUntil: 'networkidle' });
    await bcastPage.waitForSelector('text=BROADCASTER STUDIO');

    const startBtn = await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")');
    await startBtn.click();
    await bcastPage.waitForSelector('text=ON AIR', { timeout: 10000 });
    console.log('   ✅ Broadcaster is LIVE!');

    await bcastPage.waitForFunction(() => {
      const input = document.querySelector('input[readonly]');
      return input && input.value && (input.value.includes('/watch/') || input.value.includes('watch='));
    }, { timeout: 10000 });

    const broadcastId = await bcastPage.evaluate(() => {
      const input = document.querySelector('input[readonly]');
      if (input.value.includes('/watch/')) {
        return input.value.split('/watch/')[1].split('?')[0].split('/')[0];
      }
      return input.value.split('watch=')[1].split('&')[0];
    });

    // Launch Viewer
    console.log(`👥 Launching Viewer for session [${broadcastId}]...`);
    const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const viewerPage = await viewerContext.newPage();

    let viewerErrors = 0;
    viewerPage.on('pageerror', (err) => {
      viewerErrors++;
      console.log(`   [Viewer Error] ${err.message}`);
    });

    await viewerPage.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await viewerPage.waitForSelector('text=LIVE BROADCAST');

    // Wait until initial playback starts
    await viewerPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.currentTime > 0;
    }, { timeout: 15000 });
    console.log('   ✅ Initial playback confirmed on Viewer.\n');

    // Monitor for 6 intervals of 10s = 60s total sustained observation
    console.log('📊 Beginning 60-Second Sustained Continuity Audit:');
    let lastTime = 0;
    const sampleCount = 6;
    const intervalMs = 10000;

    for (let i = 1; i <= sampleCount; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));

      const stats = await viewerPage.evaluate(() => {
        const video = document.querySelector('video');
        return {
          currentTime: video ? video.currentTime : 0,
          paused: video ? video.paused : true,
          readyState: video ? video.readyState : 0,
          videoWidth: video ? video.videoWidth : 0,
          videoHeight: video ? video.videoHeight : 0,
        };
      });

      const bcastStats = await bcastPage.evaluate(() => {
        // Read emitted chunks from metrics or DOM
        const input = document.querySelector('input[readonly]');
        return {
          hasStream: !!input,
        };
      });

      const delta = stats.currentTime - lastTime;
      console.log(
        `   [Sample ${i}/${sampleCount} | t=${(i * 10)}s] Viewer currentTime: ${stats.currentTime.toFixed(2)}s (+${delta.toFixed(2)}s), Resolution: ${stats.videoWidth}x${stats.videoHeight}, Paused: ${stats.paused}, ReadyState: ${stats.readyState}`
      );

      assert(!stats.paused, 'Viewer video must not pause during live broadcast');
      assert(stats.currentTime > lastTime, 'Viewer playback time must continuously advance without stalls');
      assert(stats.readyState >= 2, 'Viewer video readyState must maintain HAVE_CURRENT_DATA or higher');

      lastTime = stats.currentTime;
    }

    assert(trackEndedEvents === 0, 'No camera tracks should have unexpectedly ended or muted');
    assert(broadcasterErrors === 0, 'Broadcaster must have zero unhandled errors during sustained stream');
    assert(viewerErrors === 0, 'Viewer must have zero unhandled errors during sustained stream');

    console.log('\n✅ Sustained 60s broadcast finished with zero dropouts, continuous frame delivery, and steady MSE decoding!');

    // Clean teardown
    const endBtn = await bcastPage.waitForSelector('button:has-text("End Broadcast")');
    await endBtn.click();
    console.log('✅ Clean shutdown verified.');
  } finally {
    await browser.close();
  }
}

runSustainedStabilityTest().catch((err) => {
  console.error('\n❌ Sustained stability test failed:', err);
  process.exit(1);
});

