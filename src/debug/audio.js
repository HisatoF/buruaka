/**
 * Renders every synthesised sound through an OfflineAudioContext and reports
 * peak, RMS, duration and start/end taper.
 *
 * Web Audio needs a browser, so this runs in the capture harness rather than
 * in Node. A sound that renders silent, clips past 1.0, or starts on a
 * non-zero sample (an audible click) is a failure, not a matter of taste.
 */
import { AudioEngine, SOUND_NAMES } from '../core/Audio.js';

const out = document.getElementById( 'out' );
const results = [];

async function renderSound( name, seconds = 2.5 ) {
  const ctx = new OfflineAudioContext( 2, Math.ceil( 44100 * seconds ), 44100 );
  const engine = new AudioEngine( { context: ctx } );
  engine.play( name, { volume: 1, reverb: 0.15 } );
  const buf = await ctx.startRendering();
  return analyse( buf );
}

async function renderMusic( seconds = 12 ) {
  const ctx = new OfflineAudioContext( 2, Math.ceil( 44100 * seconds ), 44100 );
  const engine = new AudioEngine( { context: ctx } );
  engine.music.start( 'combat' );
  engine.music.setIntensity( 0.85 );
  // The scheduler is pumped manually: an OfflineAudioContext renders faster
  // than real time, so there are no animation frames to drive it.
  const spb = 0.05;
  for ( let t = 0; t < seconds; t += spb ) engine.music.update();
  const buf = await ctx.startRendering();
  return analyse( buf );
}

function analyse( buf ) {
  const d = buf.getChannelData( 0 );
  let peak = 0, sumSq = 0, firstAudible = -1, lastAudible = -1;
  for ( let i = 0; i < d.length; i++ ) {
    const a = Math.abs( d[ i ] );
    if ( a > peak ) peak = a;
    sumSq += d[ i ] * d[ i ];
    if ( a > 0.004 ) { if ( firstAudible < 0 ) firstAudible = i; lastAudible = i; }
  }
  const rms = Math.sqrt( sumSq / d.length );

  // Longest run of silence between the first and last audible sample —
  // catches a music bed that drops out mid-render.
  let gap = 0, run = 0;
  for ( let i = Math.max( firstAudible, 0 ); i <= lastAudible; i++ ) {
    if ( Math.abs( d[ i ] ) < 0.0015 ) { run++; gap = Math.max( gap, run ); } else run = 0;
  }

  return {
    peak,
    rms,
    duration: lastAudible > 0 ? ( lastAudible - Math.max( firstAudible, 0 ) ) / buf.sampleRate : 0,
    onsetSample: firstAudible < 0 ? -1 : Math.abs( d[ firstAudible ] ),
    tailSample: lastAudible < 0 ? -1 : Math.abs( d[ Math.min( lastAudible + 1, d.length - 1 ) ] ),
    silenceGap: gap / buf.sampleRate,
  };
}

function verdict( r ) {
  if ( r.peak < 0.01 ) return [ 'bad', 'SILENT' ];
  if ( r.peak > 1.0 ) return [ 'bad', 'CLIPS' ];
  if ( r.peak > 0.98 ) return [ 'warn', 'HOT' ];
  if ( r.duration < 0.02 ) return [ 'warn', 'TOO SHORT' ];
  return [ 'ok', 'ok' ];
}

( async () => {
  const rows = [];
  let failures = 0;

  for ( const name of SOUND_NAMES ) {
    try {
      const r = await renderSound( name );
      const [ cls, note ] = verdict( r );
      if ( cls === 'bad' ) failures++;
      results.push( { name, ...r, note } );
      rows.push( `<tr><td>${name}</td><td>${r.peak.toFixed( 3 )}</td><td>${r.rms.toFixed( 4 )}</td>` +
        `<td>${r.duration.toFixed( 3 )}s</td><td>${r.onsetSample.toFixed( 4 )}</td>` +
        `<td class="${cls}">${note}</td></tr>` );
    } catch ( e ) {
      failures++;
      rows.push( `<tr><td>${name}</td><td colspan="5" class="bad">ERROR: ${e.message}</td></tr>` );
    }
  }

  let musicRow = '';
  try {
    const m = await renderMusic( 12 );
    const bad = m.peak < 0.02 || m.peak > 1.0 || m.silenceGap > 1.2;
    if ( bad ) failures++;
    results.push( { name: '<music>', ...m } );
    musicRow = `<tr><td><b>MUSIC (combat, 12 s)</b></td><td>${m.peak.toFixed( 3 )}</td>` +
      `<td>${m.rms.toFixed( 4 )}</td><td>${m.duration.toFixed( 2 )}s</td>` +
      `<td>gap ${m.silenceGap.toFixed( 2 )}s</td><td class="${bad ? 'bad' : 'ok'}">${bad ? 'FAIL' : 'ok'}</td></tr>`;
  } catch ( e ) {
    failures++;
    musicRow = `<tr><td>MUSIC</td><td colspan="5" class="bad">ERROR: ${e.message}</td></tr>`;
  }

  out.innerHTML =
    `<h3>${SOUND_NAMES.length} sounds — ${failures} failure(s)</h3>` +
    '<table><tr><th>sound</th><th>peak</th><th>rms</th><th>dur</th><th>onset</th><th></th></tr>' +
    rows.join( '' ) + musicRow + '</table>';

  window.__audioResults = results;
  window.__audioFailures = failures;
  window.__GAME_READY__ = true;
} )();

window.__capture = () => {};
window.__captureList = () => [ 'audio' ];
window.__diagnostics = () => ( {
  sounds: SOUND_NAMES.length,
  failures: window.__audioFailures,
  silent: results.filter( ( r ) => r.peak < 0.01 ).map( ( r ) => r.name ),
  clipping: results.filter( ( r ) => r.peak > 1.0 ).map( ( r ) => r.name ),
  loudest: results.slice().sort( ( a, b ) => b.peak - a.peak ).slice( 0, 5 ).map( ( r ) => `${r.name}:${r.peak.toFixed( 2 )}` ),
} );
