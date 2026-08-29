/** Captures the results screen at several viewports for review. */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync( 'tools/out/results', { recursive: true } );
const browser = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio' ],
} );

for ( const [ w, h ] of [ [ 1600, 900 ], [ 1280, 800 ], [ 390, 844 ] ] ) {
  const page = await browser.newPage( { viewport: { width: w, height: h } } );
  await page.goto( 'http://127.0.0.1:5210/', { waitUntil: 'domcontentloaded', timeout: 60000 } );
  await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );
  await page.evaluate( () => {
    const g = window.__game;
    window.__startMission( 12 );
    g.failed = false;
    g.score = 184920; g.maxCombo = 143; g.time = 268; g.damageTaken = 4180;
    g.director.clearedWaves = 8;
    g.squad.forEach( ( u, i ) => { u.damageDealt = 84210 - i * 21000; u.kills = 41 - i * 9; u.healingDone = i === 3 ? 8640 : 0; } );
    g._results = null;
    g.phase = 'results';
    g.hud.update( g.hudState(), g.camera, null );
  } );
  await page.waitForTimeout( 1600 );
  await page.screenshot( { path: `tools/out/results/${w}x${h}.png` } );
  await page.close();
}
await browser.close();
console.log( 'OK' );
