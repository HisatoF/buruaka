/**
 * Drives the game to the final wave and checks the boss, the boss bar state,
 * the status-effect strip and the in-process restart, all in the real page.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio' ],
} );
const page = await browser.newPage( { viewport: { width: 1400, height: 800 } } );
const errs = [];
page.on( 'pageerror', ( e ) => errs.push( e.message ) );
// Google Fonts is a progressive enhancement and is blocked in this sandbox;
// the stylesheet carries full local fallbacks, so it is not a failure.
const ignorable = ( t ) => /fonts\.g|favicon|ERR_CONNECTION_RESET|Failed to load resource/.test( t );
page.on( 'console', ( m ) => { if ( m.type() === 'error' && !ignorable( m.text() ) ) errs.push( m.text() ); } );

await page.goto( 'http://127.0.0.1:5210/', { waitUntil: 'domcontentloaded', timeout: 60000 } );
await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );

const out = await page.evaluate( () => {
  const g = window.__game;
  const log = {};
  g.phase = 'playing';
  g.director.start();

  // Skip straight to the final wave.
  g.director.wave = g.director.totalWaves - 1;
  g.director._state = 'between';
  g.director._timer = 0.01;

  const dt = 1 / 60;
  let t = 0, bossSeen = false, bossBar = null;
  for ( let i = 0; i < 60 * 90 && !bossSeen; i++ ) {
    g.update( dt, t ); t += dt;
    if ( g.boss ) {
      bossSeen = true;
      const st = g.hudState();
      bossBar = { visible: st.boss.visible, name: st.boss.name, hp: st.boss.hp, maxHp: st.boss.maxHp, phases: st.boss.phases?.length };
    }
  }
  log.wave = g.director.wave;
  log.bossSpawned = bossSeen;
  log.bossBar = bossBar;
  log.bossScale = g.boss?.character.design.scale ?? null;

  // Status effects: fire the AoE and the heal, then read the HUD strip.
  g.cost = 10;
  g.useSkill( 1 );
  g.useSkill( 3 );
  for ( let i = 0; i < 30; i++ ) { g.update( dt, t ); t += dt; }
  const st2 = g.hudState();
  log.squadStatuses = st2.squad.map( ( u ) => u.status.map( ( x ) => `${x.id}:${x.duration.toFixed(1)}s` ) );
  log.hostileStatuses = g.hostiles.filter( h => h.statuses.length ).slice( 0, 3 ).map( h => h.statuses.map( x => x.id ) );

  // Restart in-process.
  const beforeUnits = g.units.length;
  g.restart();
  for ( let i = 0; i < 20; i++ ) { g.update( dt, t ); t += dt; }
  log.restart = { beforeUnits, afterUnits: g.units.length, squad: g.squad.length, wave: g.director.wave, boss: !!g.boss, score: g.score };
  return log;
} );

await browser.close();
console.log( JSON.stringify( out, null, 2 ) );
if ( errs.length ) { console.log( '--- ERRORS ---' ); errs.slice( 0, 8 ).forEach( e => console.log( e.slice( 0, 300 ) ) ); process.exit( 2 ); }
console.log( 'OK' );
