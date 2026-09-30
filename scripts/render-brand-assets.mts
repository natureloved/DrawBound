import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function render() {
  const browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: true,
  });

  try {
    const page = await browser.newPage();

    // 1. Render banner.png (1200x630)
    await page.setViewportSize({ width: 1200, height: 630 });
    const bannerSvg = fs.readFileSync(path.resolve("public/brand/banner.svg"), "utf8");
    await page.setContent(`<!DOCTYPE html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body, html { width: 1200px; height: 630px; overflow: hidden; background: #0a0908; }
      svg { width: 1200px; height: 630px; display: block; }
    </style>
  </head>
  <body>${bannerSvg}</body>
</html>`);
    await page.screenshot({ path: path.resolve("public/brand/banner.png") });
    console.log("Rendered public/brand/banner.png (1200x630)");

    // 2. Render logo-256.png (256x256)
    await page.setViewportSize({ width: 256, height: 256 });
    const logoSvg = fs.readFileSync(path.resolve("public/brand/logo.svg"), "utf8");
    await page.setContent(`<!DOCTYPE html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body, html { width: 256px; height: 256px; overflow: hidden; background: transparent; }
      svg { width: 256px; height: 256px; display: block; }
    </style>
  </head>
  <body>${logoSvg}</body>
</html>`);
    await page.screenshot({ path: path.resolve("public/brand/logo-256.png"), omitBackground: true });
    console.log("Rendered public/brand/logo-256.png (256x256)");

    // 3. Render logo-mark-128.png (128x128)
    await page.setViewportSize({ width: 128, height: 128 });
    const logoMarkSvg = fs.readFileSync(path.resolve("public/brand/logo-mark.svg"), "utf8");
    await page.setContent(`<!DOCTYPE html>
<html>
  <head>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body, html { width: 128px; height: 128px; overflow: hidden; background: transparent; }
      svg { width: 128px; height: 128px; display: block; }
    </style>
  </head>
  <body>${logoMarkSvg}</body>
</html>`);
    await page.screenshot({ path: path.resolve("public/brand/logo-mark-128.png"), omitBackground: true });
    console.log("Rendered public/brand/logo-mark-128.png (128x128)");

    // 4. Also copy banner.png to src/app/opengraph-image.png and src/app/twitter-image.png
    fs.copyFileSync(path.resolve("public/brand/banner.png"), path.resolve("src/app/opengraph-image.png"));
    fs.copyFileSync(path.resolve("public/brand/banner.png"), path.resolve("src/app/twitter-image.png"));
    console.log("Copied to src/app/opengraph-image.png and src/app/twitter-image.png");
  } finally {
    await browser.close();
  }
}

render().catch(console.error);
