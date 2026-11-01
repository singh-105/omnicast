import { chromium } from 'playwright';
import assert from 'node:assert/strict';

async function runNavigationSuite() {
  console.log('🧭 Starting OmniCast Routing, Navigation, & Explore E2E Test Suite...\n');

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
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.on('console', (msg) => console.log(`   [ViewerPage] ${msg.text()}`));
    page.on('pageerror', (err) => console.log(`   [ViewerPage Error] ${err.message}`));

    // ─────────────────────────────────────────────────────────────────
    // 1. Direct URL loading & routes
    // ─────────────────────────────────────────────────────────────────
    console.log('1️⃣ Testing Direct URL Routing...');
    
    // Test /
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
    await page.waitForSelector('text=LIVE STREAMING,');
    console.log('   ✅ Direct load of "/" renders LandingView');

    // Test /explore
    await page.goto('http://localhost:5173/explore', { waitUntil: 'networkidle' });
    await page.waitForSelector('text=EXPLORE LIVE STREAMS');
    console.log('   ✅ Direct load of "/explore" renders ExploreView');

    // Test /studio
    await page.goto('http://localhost:5173/studio', { waitUntil: 'networkidle' });
    await page.waitForSelector('text=BROADCASTER STUDIO');
    console.log('   ✅ Direct load of "/studio" renders StudioView');

    // ─────────────────────────────────────────────────────────────────
    // 2. Client-side Navbar navigation & PopState history
    // ─────────────────────────────────────────────────────────────────
    console.log('\n2️⃣ Testing Navbar & PopState History Navigation...');
    
    // Navigate to Home via Navbar
    const homeBtn = await page.waitForSelector('header nav button:has-text("Home")');
    await homeBtn.click();
    await page.waitForSelector('text=LIVE STREAMING,');
    assert.equal(new URL(page.url()).pathname, '/', 'Path should be /');
    console.log('   ✅ Navbar "Home" navigated to "/"');

    // Navigate to Explore via Navbar
    const exploreBtn = await page.waitForSelector('header nav button:has-text("Explore")');
    await exploreBtn.click();
    await page.waitForSelector('text=EXPLORE LIVE STREAMS');
    assert.equal(new URL(page.url()).pathname, '/explore', 'Path should be /explore');
    console.log('   ✅ Navbar "Explore" navigated to "/explore"');

    // Browser Back (popstate)
    await page.goBack();
    await page.waitForSelector('text=LIVE STREAMING,');
    assert.equal(new URL(page.url()).pathname, '/', 'Path should be / after back');
    console.log('   ✅ Browser Back button successfully popped state to "/"');

    // Browser Forward (popstate)
    await page.goForward();
    await page.waitForSelector('text=EXPLORE LIVE STREAMS');
    assert.equal(new URL(page.url()).pathname, '/explore', 'Path should be /explore after forward');
    console.log('   ✅ Browser Forward button successfully pushed state to "/explore"');

    // ─────────────────────────────────────────────────────────────────
    // 3. Broadcast Lifecycle & Real-Time Feed Discovery
    // ─────────────────────────────────────────────────────────────────
    console.log('\n3️⃣ Testing Live Broadcast Announcement & Explore Discovery...');

    // Launch Broadcaster in a second page
    const bcastContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const bcastPage = await bcastContext.newPage();
    bcastPage.on('console', (msg) => console.log(`   [Bcast] ${msg.text()}`));
    bcastPage.on('pageerror', (err) => console.log(`   [Bcast Error] ${err.message}`));
    await bcastPage.goto('http://localhost:5173/studio', { waitUntil: 'networkidle' });
    
    // Set custom stream title
    const titleInput = await bcastPage.waitForSelector('input[value="My OmniCast Live Stream"]');
    await titleInput.fill('Ultra Fast P2P Stream');

    // Start Live Broadcast
    const startBtn = await bcastPage.waitForSelector('button:has-text("Start Live Broadcast")');
    await startBtn.click();
    await bcastPage.waitForSelector('button:has-text("End Broadcast")', { timeout: 10000 });

    // Extract stream ID
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

    // In the viewer explore page, refresh / verify stream card appears
    await page.waitForTimeout(1000);
    const refreshBtn = await page.waitForSelector('button[title="Refresh active broadcasts"]');
    await refreshBtn.click();

    await page.waitForFunction((id) => {
      return document.body.textContent.includes(id) || document.body.textContent.includes('Ultra Fast P2P Stream');
    }, broadcastId, { timeout: 10000 });
    console.log('   ✅ Explore page dynamically displays active broadcast card!');

    // ─────────────────────────────────────────────────────────────────
    // 4. Explore Search Filtering
    // ─────────────────────────────────────────────────────────────────
    console.log('\n4️⃣ Testing Search Filtering in ExploreView...');
    const searchInput = await page.waitForSelector('input[placeholder*="Search streams"]');
    
    // Search matching title
    await searchInput.fill('Ultra Fast');
    await page.waitForTimeout(300);
    let cardCount = await page.evaluate(() => document.querySelectorAll('.group.rounded-2xl').length);
    assert.equal(cardCount >= 1, true, 'Matching search should show at least 1 card');
    console.log('   ✅ Search matching title returns stream card');

    // Search non-matching text
    await searchInput.fill('nonexistent_stream_xyz_123');
    await page.waitForTimeout(300);
    const emptyNotice = await page.waitForSelector('text=No Matching Broadcasts Found');
    assert(emptyNotice, 'Empty state must appear for zero results');
    console.log('   ✅ Non-matching search displays clean empty state notice');

    // Clear search
    const clearBtn = await page.waitForSelector('button:has-text("Clear Search Filter")');
    await clearBtn.click();
    await page.waitForTimeout(300);
    cardCount = await page.evaluate(() => document.querySelectorAll('.group.rounded-2xl').length);
    assert.equal(cardCount >= 1, true, 'Clearing search restores stream card');
    console.log('   ✅ Clear search restores stream cards');

    // ─────────────────────────────────────────────────────────────────
    // 5. Direct Link / ID Join & Watcher Refresh Persistence
    // ─────────────────────────────────────────────────────────────────
    console.log('\n5️⃣ Testing Direct Link Paste Join & Watcher Refresh Persistence...');
    const directJoinInput = await page.waitForSelector('input[placeholder*="Paste stream link or ID"]');
    await directJoinInput.fill(`http://localhost:5173/watch/${broadcastId}`);
    
    const watchBtn = await page.waitForSelector('form button:has-text("Watch")');
    await watchBtn.click();

    // Verify URL is now /watch/:id
    await page.waitForSelector('text=LIVE BROADCAST');
    assert(page.url().includes(`/watch/${broadcastId}`) || page.url().includes(`watch=${broadcastId}`), 'URL must reflect stream');
    console.log('   ✅ Direct link paste joined stream at /watch/' + broadcastId);

    // Verify video is decoding & playing
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    console.log('   ✅ Watcher video is actively decoding and rendering frames via MSE!');

    // Test page refresh at /watch/:id
    console.log('   🔄 Refreshing Watcher page to test URL session persistence...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('text=LIVE BROADCAST');
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > 0;
    }, { timeout: 15000 });
    console.log('   ✅ Page refresh at /watch/:id seamlessly re-established live stream playback!');

    // Teardown
    const endBtn = await bcastPage.waitForSelector('button:has-text("End Broadcast")');
    await endBtn.click();
    console.log('\n🎉 ALL NAVIGATION, ROUTING, & EXPLORE TESTS PASSED!');
  } finally {
    await browser.close();
  }
}

runNavigationSuite().catch((err) => {
  console.error('\n❌ Navigation suite failed:', err);
  process.exit(1);
});

