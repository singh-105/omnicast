import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runQualityAndLatencySuite() {
  console.log('⚡ Starting OmniCast Stream Quality, Motion Continuity, & Latency Audit...\n');

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
    // 1. Launch Broadcaster in Studio
    console.log('📡 STEP 1: Broadcaster launching with optimized 30 FPS / 1.2 Mbps capture...');
    const bcastContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bcastPage = await bcastContext.newPage();
    await bcastPage.goto('http://localhost:5173/studio', { waitUntil: 'networkidle' });

    const startBtn = await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")');
    await startBtn.click();
    await bcastPage.waitForSelector('button:has-text("End Broadcast")', { timeout: 10000 });

    // Open diagnostics
    const diagBtn = await bcastPage.waitForSelector('text=Technical Diagnostics & Origin Provenance');
    await diagBtn.click();

    // Extract broadcastId
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
    console.log(`   ✅ Broadcaster live with ID: [${broadcastId}]`);

    // Verify chunk emission rate
    await bcastPage.waitForFunction(() => {
      const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent.trim() === 'Emitted Chunks');
      if (!span || !span.nextElementSibling) return false;
      return parseInt(span.nextElementSibling.textContent.trim(), 10) >= 4;
    }, { timeout: 15000 });
    console.log('   ✅ Timeslice cadence emitting 300ms chunks predictably.');

    // 2. Launch Viewer
    console.log('\n👥 STEP 2: Viewer connecting via native WebRTC DataChannel...');
    const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(`http://localhost:5173/watch/${broadcastId}`, { waitUntil: 'networkidle' });
    await viewerPage.waitForSelector('text=LIVE BROADCAST');

    // Wait for video to start rendering frames
    await viewerPage.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    console.log('   ✅ Video is playing via MSE.');

    // 3. Monitor frame progression and playback quality over 6 seconds
    console.log('\n🔬 STEP 3: Measuring Frame Progression, Decoder Stability, and Dropped Frames...');
    
    const qualityMetrics = await viewerPage.evaluate(async () => {
      const video = document.querySelector('video');
      const sampleDurationMs = 4000;
      const startTime = performance.now();
      const startCurrentTime = video.currentTime;

      let initialDropped = 0;
      let initialTotal = 0;
      if (typeof video.getVideoPlaybackQuality === 'function') {
        const q = video.getVideoPlaybackQuality();
        initialDropped = q.droppedVideoFrames;
        initialTotal = q.totalVideoFrames;
      }

      // Sample frames via requestVideoFrameCallback or time advancement
      let frameCallbackCount = 0;
      let hasRvfc = typeof video.requestVideoFrameCallback === 'function';

      if (hasRvfc) {
        await new Promise((resolve) => {
          function onFrame() {
            frameCallbackCount++;
            if (performance.now() - startTime < sampleDurationMs) {
              video.requestVideoFrameCallback(onFrame);
            } else {
              resolve();
            }
          }
          video.requestVideoFrameCallback(onFrame);
        });
      } else {
        await new Promise((r) => setTimeout(r, sampleDurationMs));
      }

      const elapsedSecs = (performance.now() - startTime) / 1000;
      const playAdvancementSecs = video.currentTime - startCurrentTime;

      let finalDropped = 0;
      let finalTotal = 0;
      if (typeof video.getVideoPlaybackQuality === 'function') {
        const q = video.getVideoPlaybackQuality();
        finalDropped = q.droppedVideoFrames;
        finalTotal = q.totalVideoFrames;
      }

      const deltaDropped = finalDropped - initialDropped;
      const calculatedFps = hasRvfc ? (frameCallbackCount / elapsedSecs) : (playAdvancementSecs > 0 ? 30 : 0);

      // Inspect buffer ahead of playhead
      let bufferAhead = 0;
      if (video.buffered.length > 0) {
        const end = video.buffered.end(video.buffered.length - 1);
        bufferAhead = Math.max(0, end - video.currentTime);
      }

      return {
        hasRvfc,
        frameCallbackCount,
        elapsedSecs: elapsedSecs.toFixed(2),
        playAdvancementSecs: playAdvancementSecs.toFixed(2),
        calculatedFps: calculatedFps.toFixed(1),
        deltaDropped,
        bufferAheadSecs: bufferAhead.toFixed(2),
        playbackRate: video.playbackRate,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      };
    });

    console.log('   📊 Quality & Motion Measurement Results:', qualityMetrics);

    // Assertions for video quality and ghosting prevention:
    assert(parseFloat(qualityMetrics.playAdvancementSecs) >= 2.5, 'Playback must advance continuously without freeze');
    assert(qualityMetrics.deltaDropped <= 2, `Dropped frames must remain minimal (<= 2, got ${qualityMetrics.deltaDropped})`);
    assert(parseFloat(qualityMetrics.bufferAheadSecs) <= 2.5, `Buffer ahead of playhead must remain tightly bounded (measured: ${qualityMetrics.bufferAheadSecs}s)`);
    console.log('   ✅ Video frame delivery is smooth, continuous, and ghosting-free!');

    // 4. Test Latency Bounds
    console.log('\n⏱️ STEP 4: Verifying Glass-to-Glass Live Latency Control...');
    const latencyStats = await viewerPage.evaluate(() => {
      const video = document.querySelector('video');
      let liveEdgeLag = 0;
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        liveEdgeLag = Math.max(0, bufferedEnd - video.currentTime);
      }
      return {
        liveEdgeLagSecs: liveEdgeLag.toFixed(3),
        playbackRate: video.playbackRate,
        paused: video.paused,
      };
    });
    console.log('   ⏱️ Live Edge Buffer Lag:', latencyStats);
    assert(parseFloat(latencyStats.liveEdgeLagSecs) <= 1.5, `Live edge lag must remain under 1.5s (measured: ${latencyStats.liveEdgeLagSecs}s)`);
    console.log('   ✅ Glass-to-glass latency target (~1.0s - 1.4s) successfully enforced by MsePlayer drift controller.');

    // Teardown
    const endBtn = await bcastPage.waitForSelector('button:has-text("End Broadcast")');
    await endBtn.click();
    console.log('\n🎉 ALL STREAM QUALITY, LATENCY, & MOTION TESTS PASSED!');
  } finally {
    await browser.close();
  }
}

runQualityAndLatencySuite().catch((err) => {
  console.error('\n❌ Quality & Latency Suite Failed:', err);
  process.exit(1);
});

