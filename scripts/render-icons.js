// Renders assets/icon.svg to PNGs with the bundled Chromium (Playwright).
// Usage: node scripts/render-icons.js   (needs `playwright` available)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');
  const out = path.join(__dirname, '..', 'assets', 'icons');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
    await page.screenshot({ path: path.join(out, `${size}x${size}.png`), omitBackground: true });
    await page.close();
  }
  await browser.close();
  fs.copyFileSync(path.join(out, '512x512.png'), path.join(__dirname, '..', 'build', 'icon.png'));
  console.log('icons written to', out);
})();
