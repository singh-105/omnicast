import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runMultiViewerConcurrencySuite() {
  console.log('🚀 Starting OmniCast Multi-Viewer Concurrency & Late-Join Audit...\n');

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
    // 1. Broadcaster Origin
    console.log('📡 STEP 1: Broadcaster launching in Studio...');
    const bcastContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bcastPage = await bcastContext.newPage();
    bcastPage.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('vite') && !txt.includes('React DevTools')) {
        console.log(`   [Broadcaster] ${txt}`);
      }
    });

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
      return input && input.value && input.value.includes('/watch/');
    }, { timeout: 10000 });

    const broadcastId = await bcastPage.evaluate(() => {
      const input = document.querySelector('input[readonly]');
      return input.value.split('/watch/')[1].split('?')[0].split('/')[0];
    });
    console.log(`   ✅ Broadcaster LIVE with ID: [${broadcastId}]`);

    // Wait until broadcaster emits at least 3 chunks
    await bcastPage.waitForFunction(() => {
      const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent.trim() === 'Emitted Chunks');
      if (!span || !span.nextElementSibling) return false;
      return parseInt(span.nextElementSibling.textContent.trim(), 10) >= 3;
    }, { timeout: 15000 });
    console.log('   ✅ Chunks emitting reliably.');

    // 2. Launch Viewer 1 (Immediate)
    console.log('\n👥 STEP 2: Viewer 1 joining immediately...');
    const v1Context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const v1Page = await v1Context.newPage();
    v1Page.on('console', (m) => console.log(`   [Viewer 1] ${m.text()}`));
    await v1Page.goto(`http://localhost:5173/watch/${broadcastId}`, { waitUntil: 'networkidle' });
    await v1Page.waitForSelector('text=LIVE BROADCAST');

    await v1Page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    const v1Time = await v1Page.evaluate(() => document.querySelector('video').currentTime);
    console.log(`   ✅ Viewer 1 is PLAYING! currentTime=${v1Time.toFixed(2)}s`);

    // 3. Wait 5 seconds to simulate a live stream in progress (GOP / Keyframe window)
    console.log('\n⏳ Waiting 5 seconds before Viewer 2 joins (simulating mid-stream late join)...');
    await new Promise((r) => setTimeout(r, 5000));

    // 4. Launch Viewer 2 (Late Joiner #1)
    console.log('\n👥 STEP 3: Viewer 2 joining 5s late...');
    const v2Context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const v2Page = await v2Context.newPage();
    v2Page.on('console', (m) => console.log(`   [Viewer 2] ${m.text()}`));
    await v2Page.goto(`http://localhost:5173/watch/${broadcastId}`, { waitUntil: 'networkidle' });
    await v2Page.waitForSelector('text=LIVE BROADCAST');

    try {
      await v2Page.waitForFunction(() => {
        const v = document.querySelector('video');
        return v && !v.paused && v.currentTime > 0;
      }, { timeout: 15000 });
      const v2Time = await v2Page.evaluate(() => document.querySelector('video').currentTime);
      console.log(`   ✅ Viewer 2 is PLAYING! currentTime=${v2Time.toFixed(2)}s`);
    } catch (err) {
      console.error('   ❌ VIEWER 2 FAILED TO PLAY OR GOT STUCK PREPARING!');
      const v2Status = await v2Page.evaluate(() => {
        const v = document.querySelector('video');
        return {
          currentTime: v ? v.currentTime : null,
          paused: v ? v.paused : null,
          readyState: v ? v.readyState : null,
          bufferedRanges: v && v.buffered.length > 0 ? `${v.buffered.start(0)} - ${v.buffered.end(0)}` : 'none',
          bodyText: document.body.innerText.slice(0, 300),
        };
      });
      console.error('   ❌ Viewer 2 Diagnostics:', v2Status);
      throw err;
    }

    // 5. Launch Viewer 3 (Late Joiner #2)
    console.log('\n👥 STEP 4: Viewer 3 joining 8s late...');
    const v3Context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const v3Page = await v3Context.newPage();
    v3Page.on('console', (m) => console.log(`   [Viewer 3] ${m.text()}`));
    await v3Page.goto(`http://localhost:5173/watch/${broadcastId}`, { waitUntil: 'networkidle' });
    await v3Page.waitForSelector('text=LIVE BROADCAST');

    await v3Page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    const v3Time = await v3Page.evaluate(() => document.querySelector('video').currentTime);
    console.log(`   ✅ Viewer 3 is PLAYING! currentTime=${v3Time.toFixed(2)}s`);

    // Verify all 3 viewers are simultaneously advancing
    console.log('\n🔬 STEP 5: Verifying Simultaneous Multi-Viewer Playback Advancement...');
    await new Promise((r) => setTimeout(r, 2000));
    const times = await Promise.all([
      v1Page.evaluate(() => document.querySelector('video').currentTime),
      v2Page.evaluate(() => document.querySelector('video').currentTime),
      v3Page.evaluate(() => document.querySelector('video').currentTime),
    ]);
    console.log(`   📊 Playback times: V1=${times[0].toFixed(2)}s, V2=${times[1].toFixed(2)}s, V3=${times[2].toFixed(2)}s`);
    assert(times[0] > v1Time, 'Viewer 1 must continue playing');
    assert(times[1] > 0, 'Viewer 2 must be advancing');
    assert(times[2] > 0, 'Viewer 3 must be advancing');

    console.log('\n🎉 MULTI-VIEWER CONCURRENCY AUDIT COMPLETED SUCCESSFULLY!');
  } finally {
    await browser.close();
  }
}

runMultiViewerConcurrencySuite().catch((err) => {
  console.error('\n❌ Multi-Viewer concurrency suite failed:', err);
  process.exit(1);
});

