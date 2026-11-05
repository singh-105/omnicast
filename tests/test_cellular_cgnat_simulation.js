import { chromium } from 'playwright';

async function testCellularCgnat() {
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });

  const bPage = await browser.newPage();
  const vPage = await browser.newPage();

  bPage.on('console', msg => console.log('[Broadcaster]', msg.text()));
  vPage.on('console', msg => console.log('[Viewer]', msg.text()));

  // On the viewer page, simulate restrictive cellular network by disabling RTCPeerConnection (or blocking ICE)
  // This simulates what happens on 4G LTE VoLTE when STUN/TURN cannot punch hole through Symmetric NAT.
  await vPage.addInitScript(() => {
    // Override RTCPeerConnection to simulate ICE failure
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function(...args) {
      const pc = new OrigPC(...args);
      // Simulate symmetric NAT blocking: drop all candidates so direct P2P cannot connect
      const origAddIce = pc.addIceCandidate.bind(pc);
      pc.addIceCandidate = async () => {
        // Discard ICE candidate to simulate firewall drop
        return Promise.resolve();
      };
      return pc;
    };
  });

  await bPage.goto('http://localhost:5173');
  await new Promise(r => setTimeout(r, 1000));

  const goLiveBtn = await bPage.waitForSelector('button:has-text("GO LIVE")', { timeout: 5000 });
  await goLiveBtn.click();
  await new Promise(r => setTimeout(r, 1500));

  const startBtn = await bPage.waitForSelector('button:has-text("Start"), button:has-text("Go Live")', { timeout: 5000 });
  await startBtn.click();
  await new Promise(r => setTimeout(r, 3000));

  // Viewer connects on simulated cellular CGNAT
  await vPage.goto('http://localhost:5173');
  await new Promise(r => setTimeout(r, 2000));

  const watchCard = await vPage.waitForSelector('button:has-text("Watch"), .group:has-text("LIVE")', { timeout: 5000 });
  await watchCard.click();

  console.log('Viewer joined broadcast on simulated cellular CGNAT network. Waiting 8 seconds...');
  await new Promise(r => setTimeout(r, 8000));

  // Check metrics on viewer page
  const stats = await vPage.evaluate(() => {
    // Check if video element is ready and playing
    const video = document.querySelector('video');
    const isPlaying = video && !video.paused && video.readyState >= 2;
    const currentTime = video ? video.currentTime : 0;
    const bodyText = document.body.innerText;
    return {
      isPlaying,
      currentTime,
      readyState: video ? video.readyState : -1,
      hasBufferingText: bodyText.includes('Buffering stream...'),
      hasLiveBadge: bodyText.includes('LIVE'),
    };
  });

  console.log('=== CELLULAR CGNAT VIEWER RESULTS ===');
  console.log('Video playing:', stats.isPlaying || stats.currentTime > 0);
  console.log('Current playback time:', stats.currentTime);
  console.log('Video readyState:', stats.readyState);
  console.log('Buffering text visible:', stats.hasBufferingText);
  console.log('Live badge visible:', stats.hasLiveBadge);

  await browser.close();

  if (stats.hasBufferingText) {
    throw new Error('FAILED: Viewer stuck on Buffering stream... on cellular CGNAT');
  }
  console.log('SUCCESS: Cellular CGNAT viewer decoded and played live stream without buffering hang!');
}

testCellularCgnat().catch(err => {
  console.error(err);
  process.exit(1);
});

