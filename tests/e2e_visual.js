import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR = process.env.ARTIFACT_DIR || null;

async function runVisualTests() {
  console.log('🎨 Starting OmniCast Visual & UI Verification Suite...');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const screenshotsDir = path.resolve('tests/screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const saveBoth = async (page, filename) => {
    const localP = path.join(screenshotsDir, filename);
    await page.screenshot({ path: localP, fullPage: true });
    if (ARTIFACT_DIR) {
      const artP = path.join(ARTIFACT_DIR, filename);
      try {
        await page.screenshot({ path: artP, fullPage: true });
      } catch (_) {}
    }
    console.log(`   Saved: ${filename}`);
  };

  try {
    // 1. Desktop Landing Page (1440x900)
    console.log('📸 1. Capturing Desktop Landing Page (1440x900)...');
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto('http://localhost:5173/', { waitUntil: 'networkidle' });

    // Verify background color is jet black #0a0a0a
    const bgColor = await desktopPage.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });
    console.log('   Background color:', bgColor);
    assert(bgColor === 'rgb(10, 10, 10)' || bgColor === '#0a0a0a', `Expected #0A0A0A, got ${bgColor}`);

    // Verify brand typography and navbar
    const pageText = await desktopPage.textContent('body');
    assert(pageText.includes('OmniCast'), 'Must include OmniCast wordmark');
    assert(pageText.includes('Live Streams'), 'Must include Live Streams section');
    assert(pageText.includes('Go Live'), 'Must include Go Live action');

    await saveBoth(desktopPage, '01-landing-desktop.png');

    // 1b. Desktop Explore Page
    console.log('📸 1b. Capturing Explore Page (1440x900)...');
    const explorePage = await desktopContext.newPage();
    await explorePage.goto('http://localhost:5173/explore', { waitUntil: 'networkidle' });
    await explorePage.waitForSelector('text=EXPLORE LIVE STREAMS');
    await saveBoth(explorePage, '01b-explore-desktop.png');

    // 2. Tablet Landing Page (768x1024)
    console.log('📸 2. Capturing Tablet Landing Page (768x1024)...');
    const tabletContext = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 2,
    });
    const tabletPage = await tabletContext.newPage();
    await tabletPage.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
    await saveBoth(tabletPage, '02-landing-tablet.png');

    // 3. Mobile Landing Page (375x812)
    console.log('📸 3. Capturing Mobile Landing Page (375x812)...');
    const mobileContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
    await saveBoth(mobilePage, '03-landing-mobile.png');

    // 4. Broadcaster Studio View (Desktop - Live)
    console.log('📸 4. Capturing Broadcaster Studio View...');
    const studioPage = await desktopContext.newPage();
    await studioPage.goto('http://localhost:5173/?studio=true', { waitUntil: 'networkidle' });
    await studioPage.waitForSelector('text=BROADCASTER STUDIO');

    // Start broadcast
    const startBtn = await studioPage.waitForSelector('button:has-text("Start Live Broadcast")');
    await startBtn.click();
    await studioPage.waitForSelector('text=ON AIR', { timeout: 10000 });
    await studioPage.waitForTimeout(2000);

    await saveBoth(studioPage, '04-studio-desktop.png');

    // Get active broadcast ID
    const broadcastId = await studioPage.evaluate(() => {
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

    // 5. Watcher View Playing (Desktop)
    console.log(`📸 5. Capturing Watcher View for stream [${broadcastId}]...`);
    const watcherPage = await desktopContext.newPage();
    await watcherPage.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await watcherPage.waitForSelector('text=LIVE BROADCAST');
    await watcherPage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.currentTime > 0;
    }, { timeout: 15000 });
    await watcherPage.waitForTimeout(1500);

    await saveBoth(watcherPage, '05-watcher-desktop.png');

    // 6. Watcher View on Mobile (375x812)
    console.log('📸 6. Capturing Watcher View on Mobile Phone (375x812)...');
    const watcherMobileContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const watcherMobilePage = await watcherMobileContext.newPage();
    await watcherMobilePage.goto(`http://localhost:5173/?watch=${broadcastId}`, { waitUntil: 'networkidle' });
    await watcherMobilePage.waitForSelector('text=LIVE BROADCAST');
    await watcherMobilePage.waitForFunction(() => {
      const video = document.querySelector('video');
      return video && !video.paused && video.currentTime > 0;
    }, { timeout: 15000 });
    await watcherMobilePage.waitForTimeout(1500);

    await saveBoth(watcherMobilePage, '06-watcher-mobile.png');

    // Clean teardown
    const endBtn = await studioPage.waitForSelector('button:has-text("End Broadcast")');
    await endBtn.click();
    console.log('\n🎉 ALL VISUAL VERIFICATIONS COMPLETE!');
  } finally {
    await browser.close();
  }
}

runVisualTests().catch((err) => {
  console.error('\n❌ Visual tests error:', err);
  process.exit(1);
});
