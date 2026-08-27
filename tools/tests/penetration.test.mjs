#!/usr/bin/env node
/**
 * Samples interpenetration across a full busy engagement rather than a single
 * frame. A one-frame probe on a quiet moment proves nothing — the question is
 * whether characters ever end up inside geometry or inside each other while a
 * dozen units are crowding the same cover.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch( {
  executablePath: existsSync( CHROME ) ? CHROME : undefined,
  args: [ '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader', '--mute-audio' ],
} );
const page = await browser.newPage( { viewport: { width: 1200, height: 700 } } );
await page.goto( 'http://127.0.0.1:5210/', { waitUntil: 'domcontentloaded', timeout: 60000 } );
await page.waitForFunction( () => window.__GAME_READY__ === true, null, { timeout: 90000 } );

const out = await page.evaluate( () => {
  const g = window.__game;
  g.phase = 'playing';
  g.director.start();
  // Jump to a late wave so the arena is crowded.
  g.director.wave = 5;
  g.director._state = 'between';
  g.director._timer = 0.01;

  const dt = 1 / 60;
  let t = 0;
  let worstWorld = 0, worstPair = 0, framesWithWorld = 0, framesWithPair = 0, samples = 0;
  let peakUnits = 0;
  const examples = [];

  for ( let i = 0; i < 60 * 100; i++ ) {
    g.update( dt, t ); t += dt;
    if ( i % 6 ) continue;                 // sample at 10 Hz
    samples++;
    const p = window.__penetration();
    peakUnits = Math.max( peakUnits, p.units );
    if ( p.world.length ) {
      framesWithWorld++;
      for ( const w of p.world ) {
        if ( w.depth > worstWorld ) { worstWorld = w.depth; }
        if ( examples.length < 4 ) examples.push( { kind: 'world', ...w } );
      }
    }
    if ( p.pairs.length ) {
      framesWithPair++;
      for ( const q of p.pairs ) {
        if ( q.depth > worstPair ) { worstPair = q.depth; }
        if ( examples.length < 8 ) examples.push( { kind: 'pair', ...q } );
      }
    }
  }
  return { samples, peakUnits, framesWithWorld, framesWithPair,
    worstWorldDepth: +worstWorld.toFixed( 3 ), worstPairDepth: +worstPair.toFixed( 3 ), examples };
} );

await browser.close();
console.log( JSON.stringify( out, null, 2 ) );

// A capsule may momentarily overlap during a push-apart; a persistent or deep
// overlap is the failure.
const failed = out.worstWorldDepth > 0.12 || out.worstPairDepth > 0.22
  || out.framesWithWorld / out.samples > 0.05;
console.log( failed ? 'FAIL: persistent interpenetration' : 'PASS' );
process.exit( failed ? 1 : 0 );
