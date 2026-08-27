/** Drives the pause veil, settings popover and results screen for capture. */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync( 'tools/out/ui2', { recursive: true } );
const browser = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio', '--hide-scrollbars' ],
} );
const page = await browser.newPage( { viewport: { width: 1500, height: 900 } } );
const errs = [];
page.on( 'pageerror', ( e ) => errs.push( e.message ) );
page.on( 'console', ( m ) => {
  const t = m.text();
  if ( m.type() === 'error' && !/fonts\.g|favicon|ERR_CONNECTION_RESET|Failed to load resource/.test( t ) ) errs.push( t );
} );

await page.goto( 'http://127.0.0.1:5210/', { waitUntil: 'domcontentloaded', timeout: 60000 } );
await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );
await page.evaluate( () => window.__startMission( 30 ) );
await page.waitForTimeout( 600 );

// Pause veil, with its settings/restart row.
await page.evaluate( () => window.__game.hud.setPaused( true ) );
await page.waitForTimeout( 400 );
await page.screenshot( { path: 'tools/out/ui2/pause.png' } );

// Settings popover reached from pause — previously impossible mid-mission.
await page.evaluate( () => window.__game.hud._toggleSettings( true ) );
await page.waitForTimeout( 400 );
await page.screenshot( { path: 'tools/out/ui2/settings.png' } );
const settingsVisible = await page.evaluate( () => {
  const s = document.querySelector( '.settings' );
  const r = s.getBoundingClientRect();
  return { w: Math.round( r.width ), h: Math.round( r.height ), visible: getComputedStyle( s ).visibility };
} );

// Results screen.
await page.evaluate( () => {
  const g = window.__game;
  g.hud.setPaused( false );
  g.hud._toggleSettings( false );
  g.failed = false;
  g.score = 84210; g.maxCombo = 143; g.time = 268;
  g.director.clearedWaves = 8;
  g.phase = 'results';
  g.hud.update( g.hudState(), g.camera, null );
} );
await page.waitForTimeout( 900 );
await page.screenshot( { path: 'tools/out/ui2/results.png' } );

await browser.close();
console.log( JSON.stringify( { settingsVisible }, null, 2 ) );
if ( errs.length ) { console.log( '--- ERRORS ---' ); errs.slice( 0, 6 ).forEach( e => console.log( e.slice( 0, 300 ) ) ); process.exit( 2 ); }
console.log( 'OK' );
