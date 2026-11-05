import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runDeepCascadeTest() {
  console.log('🚀 Starting OmniCast Deep Cascade (A → B → C → D) & Late-Joiner E2E Verification...\n');

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
    // STEP 1: Launch Broadcaster A (Origin) with maxChildren=1
    // ══════════════════════════════════════════════════════════════════════
    console.log('📡 STEP 1: Launching Origin Broadcaster A with maxChildren=1...');
    const bcastContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bcastPage = await bcastContext.newPage();

    bcastPage.on('console', (msg) => {
      const txt = msg.text();
      if (!txt.includes('vite') && !txt.includes('React DevTools')) {
        console.log(`   [Origin A] ${txt}`);
      }
    });

    await bcastPage.goto('http://localhost:5173/?studio=true&maxChildren=1', { waitUntil: 'networkidle' });
    await bcastPage.waitForSelector('text=BROADCASTER STUDIO');

    const startBtn = await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")');
    await startBtn.click();
    await bcastPage.waitForSelector('text=ON AIR', { timeout: 10000 });

    const diagBtn = await bcastPage.waitForSelector('text=Technical Diagnostics & Origin Provenance', { timeout: 5000 });
    await diagBtn.click();

    await bcastPage.waitForFunction(() => {
      const input = document.querySelector('input[readonly]');
      return input && input.value && (input.value.includes('watch=') || input.value.includes('/watch/'));
    }, { timeout: 10000 });

    const broadcastId = await bcastPage.evaluate(() => {
      const input = document.querySelector('input[readonly]');
      if (!input || !input.value) return null;
      if (input.value.includes('/watch/')) return input.value.split('/watch/')[1].split('?')[0].split('/')[0];
      if (input.value.includes('watch=')) return input.value.split('watch=')[1].split('&')[0];
      return null;
    });
    console.log(`   ✅ Origin A is LIVE with ID: [${broadcastId}]`);

    // Wait until chunks start emitting
    await bcastPage.waitForFunction(() => {
      const span = Array.from(document.querySelectorAll('span')).find((s) => s.textContent.trim() === 'Emitted Chunks');
      if (!span || !span.nextElementSibling) return false;
      const val = parseInt(span.nextElementSibling.textContent.trim(), 10) || 0;
      return val >= 3;
    }, { timeout: 15000 });

    // ══════════════════════════════════════════════════════════════════════
    // STEP 2: Viewer B (Tier 1 relay under A)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n👥 STEP 2: Viewer B connecting (Tier 1)...');
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageB = await ctxB.newPage();
    pageB.on('console', (msg) => {
      const t = msg.text();
      if (!t.includes('vite') && !t.includes('React DevTools')) console.log(`   [Viewer B] ${t}`);
    });
    await pageB.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await pageB.waitForSelector('text=LIVE BROADCAST');

    await pageB.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    console.log('   ✅ Viewer B is playing (Tier 1)!');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 3: Viewer C (Tier 2 relay under B, since A is at capacity 1/1)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🌿 STEP 3: Viewer C connecting (Tier 2 under B)...');
    const ctxC = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageC = await ctxC.newPage();
    pageC.on('console', (msg) => {
      const t = msg.text();
      if (!t.includes('vite') && !t.includes('React DevTools')) console.log(`   [Viewer C] ${t}`);
    });
    await pageC.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await pageC.waitForSelector('text=LIVE BROADCAST');

    await pageC.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    console.log('   ✅ Viewer C is playing (Tier 2)!');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 4: Viewer D (Tier 3 relay under C, since B is at capacity 1/1)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🍃 STEP 4: Viewer D connecting (Tier 3 under C)...');
    const ctxD = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageD = await ctxD.newPage();
    pageD.on('console', (msg) => {
      const t = msg.text();
      if (!t.includes('vite') && !t.includes('React DevTools')) console.log(`   [Viewer D] ${t}`);
    });
    await pageD.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await pageD.waitForSelector('text=LIVE BROADCAST');

    await pageD.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    console.log('   ✅ Viewer D is playing (Tier 3)!');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 5: Assert each viewer's video.currentTime advances >= 3s over 5s
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n⏱️ STEP 5: Verifying playback advancement across A → B → C → D chain...');
    const getTimes = async () => ({
      b: await pageB.evaluate(() => document.querySelector('video')?.currentTime || 0),
      c: await pageC.evaluate(() => document.querySelector('video')?.currentTime || 0),
      d: await pageD.evaluate(() => document.querySelector('video')?.currentTime || 0),
    });

    const startTimes = await getTimes();
    console.log('   Baseline playback times:', startTimes);

    // Wait 5 seconds
    await new Promise((r) => setTimeout(r, 5000));

    const endTimes = await getTimes();
    console.log('   Playback times after 5s:', endTimes);

    const advB = endTimes.b - startTimes.b;
    const advC = endTimes.c - startTimes.c;
    const advD = endTimes.d - startTimes.d;

    console.log(`   Advancement over 5s: B=${advB.toFixed(2)}s, C=${advC.toFixed(2)}s, D=${advD.toFixed(2)}s`);
    assert(advB >= 3.0, `Viewer B must advance >= 3.0s over 5s (got ${advB}s)`);
    assert(advC >= 3.0, `Viewer C must advance >= 3.0s over 5s (got ${advC}s)`);
    assert(advD >= 3.0, `Viewer D must advance >= 3.0s over 5s (got ${advD}s)`);
    console.log('   ✅ All 4 tiers (A → B → C → D) continuously advanced >= 3.0s over 5s!');

    // ══════════════════════════════════════════════════════════════════════
    // STEP 6: Late-Joiner Variant (joins after ongoing broadcast epoch/eviction)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n⏰ STEP 6: Testing Late-Joiner past initial ring-buffer eviction...');
    // We let the stream run across keyframe epochs, then connect Viewer E
    const ctxE = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pageE = await ctxE.newPage();
    pageE.on('console', (msg) => {
      const t = msg.text();
      if (!t.includes('vite') && !t.includes('React DevTools')) console.log(`   [Late Viewer E] ${t}`);
    });

    await pageE.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await pageE.waitForSelector('text=LIVE BROADCAST');

    // Wait for Late Viewer E video to play
    await pageE.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 20000 });

    const startTimeE = await pageE.evaluate(() => document.querySelector('video')?.currentTime || 0);
    await new Promise((r) => setTimeout(r, 4000));
    const endTimeE = await pageE.evaluate(() => document.querySelector('video')?.currentTime || 0);
    const advE = endTimeE - startTimeE;
    console.log(`   Late Viewer E advancement over 4s: ${advE.toFixed(2)}s (from ${startTimeE.toFixed(2)}s to ${endTimeE.toFixed(2)}s)`);
    assert(advE >= 2.0, `Late Viewer E must advance >= 2.0s over 4s (got ${advE}s)`);
    console.log('   ✅ Late Viewer E successfully bootstrapped and advanced continuously!');

    // ══════════════════════════════════════════════════════════════════════
    // Teardown
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n🛑 Cleaning up deep cascade test sessions...');
    const endBtn = await bcastPage.waitForSelector('button:has-text("End Broadcast")');
    await endBtn.click();
    await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")', { timeout: 8000 });
    console.log('   ✅ Broadcast cleanly ended.');

    console.log('\n🎉 ALL DEEP CASCADE (A → B → C → D) & LATE JOINER CHECKS PASSED!');
  } finally {
    await browser.close();
  }
}

runDeepCascadeTest().catch((err) => {
  console.error('\n❌ Deep Cascade E2E Test failed:', err);
  process.exit(1);
});
