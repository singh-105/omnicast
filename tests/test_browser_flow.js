import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const bPage = await browser.newPage();
  const vPage = await browser.newPage();

  bPage.on('console', msg => console.log('[Broadcaster]', msg.text()));
  vPage.on('console', msg => console.log('[Viewer]', msg.text()));

  await bPage.goto('http://localhost:5173');
  await new Promise(r => setTimeout(r, 1000));

  // Click 'GO LIVE' button
  const goLiveBtn = await bPage.waitForSelector('button:has-text("GO LIVE")', { timeout: 5000 });
  await goLiveBtn.click();
  await new Promise(r => setTimeout(r, 1500));

  // Find 'Start Broadcast' or 'Go Live' button
  const startBtn = await bPage.waitForSelector('button:has-text("Start"), button:has-text("Go Live"), button:has-text("Start Streaming")', { timeout: 5000 });
  console.log('Clicking start button:', await startBtn.textContent());
  await startBtn.click();
  await new Promise(r => setTimeout(r, 3000));

  // Viewer loads home
  await vPage.goto('http://localhost:5173');
  await new Promise(r => setTimeout(r, 2000));

  // Look for broadcast card or watch button
  const watchCard = await vPage.waitForSelector('button:has-text("Watch"), a:has-text("Watch"), [data-testid="broadcast-card"], .group:has-text("LIVE")', { timeout: 5000 });
  console.log('Clicking watch card...');
  await watchCard.click();

  // Wait 10 seconds to observe streaming
  await new Promise(r => setTimeout(r, 10000));

  // Check stats on viewer page
  const viewerMetrics = await vPage.evaluate(() => {
    const text = document.body.innerText;
    return text;
  });
  console.log('--- VIEWER PAGE TEXT ---');
  console.log(viewerMetrics.slice(0, 500));

  await browser.close();
}

run().catch(console.error);

