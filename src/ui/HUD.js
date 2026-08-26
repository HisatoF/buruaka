/**
 * BURUAKA — DOM heads-up display.
 *
 * Art direction: Blue Archive / "Kivotos" UI language — white paper cards on a
 * bright scene, cool hairline strokes, hard bottom-offset shadows, aggressive
 * -12deg parallelograms with counter-skewed upright text, segmented bars,
 * hazard stripes on warning states.
 *
 *   import { HUD, MOCK_STATE } from './ui/HUD.js';
 *   const hud = new HUD( document.getElementById( 'ui-root' ), {
 *     onSkill: ( i ) => game.castSkill( i ),
 *     onSettings: ( s ) => engine.applySettings( s ),
 *     onStart: () => game.start(),
 *     onRestart: () => game.restart(),
 *     onStick: ( x, y ) => input.setStick( x, y ),   // optional, touch only
 *     onFire: ( down ) => input.setFire( down ),     // optional, touch only
 *   } );
 *   // once per frame, after camera matrices are current:
 *   hud.update( state, camera, renderer );
 *
 * The HUD never rebuilds DOM inside `update()`. Every node is created once (or
 * pooled), cached on a `refs` object and mutated by diff. All layout-affecting
 * reads happen through a ResizeObserver, never inside the frame loop, so the
 * HUD contributes zero forced reflows per frame.
 *
 * See MOCK_STATE at the bottom of this file for the full state schema.
 */

const SVGNS = 'http://www.w3.org/2000/svg';
const CLAMP = ( v, a, b ) => ( v < a ? a : v > b ? b : v );

/* ---------------------------------------------------------------------- */
/* tiny DOM helpers                                                        */
/* ---------------------------------------------------------------------- */

function el( tag, cls, parent, text ) {
  const n = document.createElement( tag );
  if ( cls ) n.className = cls;
  if ( text !== undefined ) n.textContent = text;
  if ( parent ) parent.appendChild( n );
  return n;
}

/** textContent write guarded by a cached value — avoids needless invalidation. */
function txt( n, v ) {
  const s = v == null ? '' : String( v );
  if ( n.__t !== s ) { n.textContent = s; n.__t = s; }
}

/** custom-property write guarded by a cached value. */
function cssVar( n, k, v ) {
  const s = String( v );
  let c = n.__vars;
  if ( !c ) c = n.__vars = {};
  if ( c[ k ] !== s ) { n.style.setProperty( k, s ); c[ k ] = s; }
}

function tog( n, cls, on ) {
  on = !!on;
  if ( n.classList.contains( cls ) !== on ) n.classList.toggle( cls, on );
}

function attr( n, k, v ) {
  let c = n.__attrs;
  if ( !c ) c = n.__attrs = {};
  const s = v == null ? null : String( v );
  if ( c[ k ] === s ) return;
  c[ k ] = s;
  if ( s === null ) n.removeAttribute( k ); else n.setAttribute( k, s );
}

/** Restart a CSS animation without a forced reflow (Web Animations API). */
function replay( n ) {
  const anims = n.getAnimations ? n.getAnimations( { subtree: true } ) : [];
  if ( !anims.length ) return false;
  for ( const a of anims ) { try { a.cancel(); a.play(); } catch { /* finished */ } }
  return true;
}

/** Retrigger a one-shot class animation (removes on animationend). */
function pulse( n, cls ) {
  n.classList.remove( cls );
  if ( !replay( n ) ) void n.offsetWidth;      // fallback for zero-anim nodes
  n.classList.add( cls );
}

const fmt = ( n ) => Math.round( n ).toLocaleString( 'en-US' );
function clock( s ) {
  s = Math.max( 0, s | 0 );
  const m = ( s / 60 ) | 0;
  return `${String( m ).padStart( 2, '0' )}:${String( s % 60 ).padStart( 2, '0' )}`;
}

/* ---------------------------------------------------------------------- */
/* procedural art — portraits and skill glyphs (no binary assets)          */
/* ---------------------------------------------------------------------- */

const PORTRAIT_CACHE = new Map();

/** A tiny stylised student bust: hair silhouette, face, halo. */
function portraitSVG( seed, color ) {
  const key = seed + '|' + color;
  const hit = PORTRAIT_CACHE.get( key );
  if ( hit ) return hit;

  let h = 0;
  for ( let i = 0; i < seed.length; i++ ) h = ( h * 31 + seed.charCodeAt( i ) ) & 0xffff;
  const hair = color;
  const bang = h % 3;
  const bangs = [
    'M6 20 Q6 8 20 8 Q34 8 34 20 L34 25 Q30 15 26 19 Q22 12 14 19 Q10 15 6 25 Z',
    'M6 21 Q6 8 20 8 Q34 8 34 21 L34 26 Q28 16 20 20 Q12 16 6 26 Z',
    'M6 20 Q6 8 20 8 Q34 8 34 20 L34 24 Q24 14 20 22 Q16 14 6 24 Z',
  ][ bang ];

  const s =
`<svg viewBox="0 0 40 44" xmlns="${SVGNS}" aria-hidden="true">
  <rect width="40" height="44" fill="none"/>
  <ellipse cx="20" cy="5.5" rx="7.5" ry="2.3" fill="none" stroke="#ffffff" stroke-width="1.5" opacity=".95"/>
  <path d="M4 44 L4 24 Q4 10 20 10 Q36 10 36 24 L36 44 Z" fill="${hair}" opacity=".95"/>
  <path d="M11 44 L11 33 Q20 28 29 33 L29 44 Z" fill="#ffffff" opacity=".92"/>
  <path d="M20 30 l4 14 -8 0 z" fill="${hair}" opacity=".65"/>
  <ellipse cx="20" cy="24" rx="8.4" ry="9" fill="#ffe2cf"/>
  <path d="${bangs}" fill="${hair}"/>
  <ellipse cx="16.4" cy="25" rx="1.5" ry="2.1" fill="#2b2138"/>
  <ellipse cx="23.6" cy="25" rx="1.5" ry="2.1" fill="#2b2138"/>
  <ellipse cx="16.1" cy="24.3" rx=".6" ry=".8" fill="#ffffff"/>
  <ellipse cx="23.3" cy="24.3" rx=".6" ry=".8" fill="#ffffff"/>
  <path d="M18.7 28.4 q1.3 1.2 2.6 0" stroke="#c8213a" stroke-width=".9" fill="none" stroke-linecap="round"/>
</svg>`;
  PORTRAIT_CACHE.set( key, s );
  return s;
}

const GLYPHS = {
  burst: '<path d="M32 8 l5.5 14.5 L52 28 l-14.5 5.5 L32 48 l-5.5-14.5 L12 28 l14.5-5.5 Z"/>',
  bolt:  '<path d="M36 6 L18 32 h11 L26 58 L46 28 H34 Z"/>',
  shield:'<path d="M32 7 l19 7 v14 c0 12-8 20-19 25 -11-5-19-13-19-25 V14 Z"/>',
  heal:  '<path d="M26 8 h12 v14 h14 v12 H38 v14 H26 V34 H12 V22 h14 Z"/>',
  shot:  '<path d="M10 26 h30 l-6-9 h9 l11 12 -11 12 h-9 l6-9 H10 Z"/>',
  aoe:   '<path fill-rule="evenodd" d="M32 6 a26 26 0 1 0 .1 0 Z M32 16 a16 16 0 1 1 -.1 0 Z"/><circle cx="32" cy="32" r="7"/>',
};

function skillSVG( kind, color ) {
  const g = GLYPHS[ kind ] || GLYPHS.burst;
  const id = 'g' + Math.abs( hashStr( kind + color ) ).toString( 36 );
  return `<svg viewBox="0 0 64 64" xmlns="${SVGNS}" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}"/>
      <stop offset="1" stop-color="#12203a"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" fill="url(#${id})"/>
  <path d="M0 46 L64 26 L64 64 L0 64 Z" fill="#ffffff" opacity=".14"/>
  <g fill="#ffffff" opacity=".92">${g}</g>
</svg>`;
}

function hashStr( s ) {
  let h = 2166136261;
  for ( let i = 0; i < s.length; i++ ) { h ^= s.charCodeAt( i ); h = Math.imul( h, 16777619 ); }
  return h | 0;
}

/* ---------------------------------------------------------------------- */
/* WorldMarker — screen-space DOM anchored to a world position             */
/* ---------------------------------------------------------------------- */

/**
 * A DOM element parked at a world-space point. The game either declares
 * markers in `state.markers` (recommended) or drives them imperatively:
 *
 *   const m = hud.marker( 'boss', 'elite' );
 *   m.position = enemy.position;      // any { x, y, z } — THREE.Vector3 works
 *   m.setName( 'HIEROMONK' ); m.setHP( hp, max ); m.occluded = false;
 *   m.release();
 */
export class WorldMarker {
  constructor( type ) {
    this.type = type;
    this.position = { x: 0, y: 0, z: 0 };
    this.offset = 0;              // metres added to Y before projecting
    this.occluded = false;        // game-supplied visibility test
    this.offscreen = type === 'objective' || type === 'elite';
    this.alive = true;

    const root = el( 'div', 'mk' );
    root.dataset.type = type;
    const inner = el( 'div', 'mk__in', root );
    this.el = root;
    this.inner = inner;
    this.refs = { root, inner };
    this._build( type );
  }

  _build( type ) {
    const r = this.refs;
    if ( type === 'objective' ) {
      const pin = el( 'div', 'pin', this.inner );
      r.pinBody = el( 'div', 'pin__body', pin );
      r.pinTxt = el( 'span', null, r.pinBody );
      el( 'div', 'pin__stem', pin );
      el( 'div', 'pin__dot', pin );
    } else {
      const p = el( 'div', 'plate', this.inner );
      r.name = el( 'div', 'plate__name', p );
      r.lvl = el( 'em', null, r.name );
      r.nameTxt = el( 'span', null, r.name );
      const bar = el( 'div', 'bar plate__bar', p );
      r.ghost = el( 'i', 'ghost', bar );
      r.fill = el( 'i', 'fill', bar );
      r.shield = el( 'i', 'shield', bar );
      el( 'i', 'ticks', bar );
      r.bar = bar;
      r.tags = el( 'div', 'plate__tags', p );
    }
    // off-screen indicator (shared by every marker type)
    const off = el( 'div', 'off', this.inner );
    el( 'div', 'off__ring', off );
    r.arrow = el( 'div', 'off__arrow', off );
    r.ico = el( 'div', 'off__ico', off );
    r.dist = el( 'div', 'off__dist', off );
    r.off = off;
  }

  setName( name, level ) {
    if ( this.refs.nameTxt ) txt( this.refs.nameTxt, name );
    if ( this.refs.lvl ) txt( this.refs.lvl, level ? 'Lv' + level : '' );
    if ( this.refs.pinTxt ) txt( this.refs.pinTxt, name );
    txt( this.refs.ico, ( name || '?' ).slice( 0, 1 ).toUpperCase() );
  }

  setHP( hp, max, shield = 0 ) {
    const r = this.refs;
    if ( !r.fill ) return;
    const f = max > 0 ? CLAMP( hp / max, 0, 1 ) : 0;
    cssVar( r.fill, '--v', f.toFixed( 4 ) );
    cssVar( r.ghost, '--v', f.toFixed( 4 ) );
    cssVar( r.shield, '--v', ( max > 0 ? CLAMP( shield / max, 0, 1 ) : 0 ).toFixed( 4 ) );
    cssVar( r.shield, '--at', f.toFixed( 4 ) );
    cssVar( r.bar, '--tick', ( 100 / Math.max( 1, Math.min( 10, Math.ceil( max / 250 ) ) ) ).toFixed( 3 ) + '%' );
  }

  setTags( tags ) {
    const host = this.refs.tags;
    if ( !host ) return;
    const key = tags && tags.length ? tags.join( ',' ) : '';
    if ( host.__k === key ) return;
    host.__k = key;
    host.textContent = '';
    if ( !key ) return;
    for ( const t of tags ) el( 'i', null, host, t );
  }

  release() { this.alive = false; }
}

/* ---------------------------------------------------------------------- */
/* HUD                                                                     */
/* ---------------------------------------------------------------------- */

const DMG_POOL = 48;
const COST_PIPS = 10;

export class HUD {
  /**
   * @param {HTMLElement} root  container (e.g. #ui-root)
   * @param {object} cb         { onSkill, onSettings, onStart, onRestart,
   *                              onStick, onFire, onPause }
   */
  constructor( root, cb = {} ) {
    this.cb = cb;
    this.host = root;
    this.el = el( 'div', 'hud', root );
    this.el.setAttribute( 'role', 'region' );
    this.el.setAttribute( 'aria-label', 'Combat interface' );

    this.settings = { quality: 1, master: 0.8, sfx: 0.9 };
    this._w = root.clientWidth || window.innerWidth;
    this._h = root.clientHeight || window.innerHeight;
    this._phase = '';
    this._units = new Map();     // id -> { el, refs, ghost, order }
    this._markers = new Map();   // id -> WorldMarker
    this._mkPool = [];
    this._dmg = [];
    this._dmgHead = 0;
    this._skillCount = 0;
    this._banner = null;
    this._bannerT = 0;
    this._lastWave = -1;
    this._reduced = matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

    this._buildWorld();
    this._buildDamage();
    this._buildTop();
    this._buildBoss();
    this._buildSquad();
    this._buildDeck();
    this._buildFx();
    this._buildBanners();
    this._buildScreens();
    this._buildTouch();
    this._bind();
  }

  /* ---------------- construction ---------------- */

  _buildWorld() {
    this.world = el( 'div', 'world', this.el );
    this.world.setAttribute( 'aria-hidden', 'true' );
  }

  _buildDamage() {
    this.dmgLayer = el( 'div', 'dmglayer', this.el );
    this.dmgLayer.setAttribute( 'aria-hidden', 'true' );
    for ( let i = 0; i < DMG_POOL; i++ ) {
      const n = el( 'div', 'dmg', this.dmgLayer );
      const x = el( 'div', 'dmg__x', n );
      const y = el( 'div', 'dmg__y', x );
      const s = el( 'div', 'dmg__s', y );
      const tag = el( 'b', 'dmg__tag', s );
      const v = el( 'span', 'dmg__v', s );
      this._dmg.push( { el: n, s, tag, v, until: 0, pos: { x: 0, y: 0, z: 0 }, live: false } );
    }
  }

  _buildTop() {
    const top = el( 'div', 'hud-top', this.el );
    const mission = el( 'div', 'mission', top );

    const plate = el( 'div', 'mission__plate', mission );
    const pin = el( 'div', 'mission__in', plate );
    const name = el( 'div', 'mission__name', pin );
    const sub = el( 'div', 'mission__sub', pin );

    const obj = el( 'div', 'mission__obj', mission );
    const objIn = el( 'span', null, obj );
    el( 'b', null, objIn );
    const objTxt = el( 'span', null, objIn );

    el( 'div', 'spacer', top );

    const wave = el( 'div', 'wave', top );
    const waveIn = el( 'span', null, wave );
    el( 'em', null, waveIn, 'WAVE' );
    const waveN = el( 'i', 'n', waveIn );
    waveN.style.fontStyle = 'normal';
    el( 'i', 'sep', waveIn, '/' ).style.fontStyle = 'normal';
    const waveT = el( 'i', 't', waveIn );
    waveT.style.fontStyle = 'normal';

    const timer = el( 'div', 'timer', top );
    const timerIn = el( 'span', null, timer );
    el( 'i', 'cap', timerIn, 'TIME' ).style.fontStyle = 'normal';
    const clockEl = el( 'i', 'clock', timerIn );
    clockEl.style.fontStyle = 'normal';

    this.top = { top, name, sub, objTxt, wave, waveN, waveT, timer, clock: clockEl };
  }

  _buildBoss() {
    const boss = el( 'div', 'boss', this.el );
    boss.hidden = true;
    const head = el( 'div', 'boss__head', boss );
    const tag = el( 'div', 'boss__tag', head );
    const tagI = el( 'i', null, tag, 'BOSS' );
    const name = el( 'div', 'boss__name', head );
    const hp = el( 'div', 'boss__hp', head );
    const hpNow = el( 'span', null, hp );
    const hpMax = el( 'small', null, hp );

    const bar = el( 'div', 'bar boss__bar', boss );
    const ghost = el( 'i', 'ghost', bar );
    const fill = el( 'i', 'fill', bar );
    const shield = el( 'i', 'shield', bar );
    el( 'i', 'ticks', bar );
    el( 'i', 'gloss', bar );
    const gates = el( 'div', 'boss__gates', bar );
    const phases = el( 'div', 'boss__phases', boss );

    this.boss = { root: boss, tagI, name, hpNow, hpMax, bar, ghost, fill, shield, gates, phases, ghostV: 1, key: '' };
  }

  _buildSquad() {
    this.squad = el( 'div', 'squad', this.el );
    this.squad.setAttribute( 'aria-label', 'Squad status' );
  }

  _makeUnit( u ) {
    const root = el( 'div', 'unit is-enter' );
    const port = el( 'div', 'unit__port', root );
    port.innerHTML = portraitSVG( u.id || u.name || 'x', u.color || '#35a3ea' );
    const role = el( 'div', 'unit__role', port );
    const retire = el( 'div', 'unit__retire', port, 'RETIRE' );

    const body = el( 'div', 'unit__body', root );
    const row = el( 'div', 'unit__row', body );
    const name = el( 'div', 'unit__name', row );
    const hp = el( 'div', 'unit__hp', row );
    const hpNow = el( 'b', null, hp );
    const hpMax = el( 'span', null, hp );

    const bar = el( 'div', 'bar unit__bar', body );
    const ghost = el( 'i', 'ghost', bar );
    const fill = el( 'i', 'fill', bar );
    el( 'i', 'ticks', bar );
    el( 'i', 'gloss', bar );

    const pips = el( 'div', 'unit__pips', body );
    const status = el( 'div', 'unit__status', body );

    return { el: root, refs: { port, role, retire, name, hpNow, hpMax, bar, ghost, fill, pips, status },
      ghostV: 1, hp: -1, pipN: -1, statusKey: '', order: -1 };
  }

  _buildDeck() {
    const deck = el( 'div', 'deck', this.el );

    const cost = el( 'div', 'cost', deck );
    const pips = el( 'div', 'cost__pips', cost );
    const pipEls = [];
    for ( let i = 0; i < COST_PIPS; i++ ) pipEls.push( el( 'i', null, pips ) );
    const val = el( 'div', 'cost__val', cost );
    const valIn = el( 'span', null, val );
    const valInt = el( 'b', null, valIn );
    valInt.style.fontWeight = '700';
    const valFrac = el( 'small', null, valIn );

    const skills = el( 'div', 'skills', deck );
    skills.setAttribute( 'role', 'group' );
    skills.setAttribute( 'aria-label', 'EX skills' );

    this.deck = { deck, pips: pipEls, valInt, valFrac, skills, cards: [] };
  }

  _makeSkill( i ) {
    const b = el( 'button', 'skill' );
    b.type = 'button';
    b.dataset.i = String( i );
    const inn = el( 'span', 'skill__in', b );
    const art = el( 'span', 'skill__art', inn );
    el( 'span', 'skill__deco', inn );
    const cd = el( 'span', 'skill__cd', inn );
    const label = el( 'span', 'skill__label', inn );
    const name = el( 'span', 'skill__name', label );
    const student = el( 'span', 'skill__student', label );
    const cost = el( 'span', 'skill__cost', inn );
    const key = el( 'span', 'skill__key', inn );
    const cdnum = el( 'span', 'skill__cdnum', inn );
    el( 'span', 'skill__glow', inn );
    el( 'span', 'skill__sheen', inn );
    return { el: b, art, cd, name, student, cost, key, cdnum, costN: -1, artKey: '' };
  }

  _buildFx() {
    const fx = el( 'div', 'fx', this.el );
    fx.setAttribute( 'aria-hidden', 'true' );
    this.fx = {
      root: fx,
      vig: el( 'div', 'fx__vig', fx ),
      low: el( 'div', 'fx__low', fx ),
      flash: el( 'div', 'fx__flash', fx ),
      speed: el( 'div', 'fx__speed', fx ),
    };
  }

  _buildBanners() {
    this.banners = el( 'div', 'banners', this.el );
    this.banners.setAttribute( 'aria-live', 'assertive' );
  }

  _buildScreens() {
    /* ---- title ---- */
    const t = el( 'div', 'hud-screen', this.el );
    const title = el( 'div', 'title', t );
    el( 'div', 'title__halo', title );
    el( 'div', 'title__main', title, 'BURUAKA' );
    el( 'div', 'title__sub', title, 'KIVOTOS TACTICAL');
    el( 'div', 'title__rule', title );
    const row = el( 'div', 'title__row', title );
    const play = el( 'button', 'btn', row );
    play.type = 'button';
    el( 'span', null, play, 'PLAY' );
    play.setAttribute( 'aria-label', 'Start mission' );
    const setBtn = el( 'button', 'btn btn--ghost', row );
    setBtn.type = 'button';
    el( 'span', null, setBtn, 'SETTINGS' );
    el( 'div', 'title__hint', title, 'WASD MOVE — MOUSE AIM — 1-4 EX SKILL' );

    const st = this._buildSettings( t );

    /* ---- results ---- */
    const r = el( 'div', 'hud-screen', this.el );
    const res = el( 'div', 'res', r );
    res.setAttribute( 'role', 'dialog' );
    res.setAttribute( 'aria-label', 'Mission results' );
    const hd = el( 'div', 'res__hd', res );
    const rTitle = el( 'div', 'res__title', hd );
    el( 'div', 'res__rule', hd );
    const body = el( 'div', 'res__body', res );
    const stamp = el( 'div', 'stamp', body );
    el( 'div', 'stamp__ring', stamp );
    const stampL = el( 'div', 'stamp__l', stamp );
    el( 'div', 'stamp__c', stamp, 'RANK' );
    const right = el( 'div', null, body );
    right.style.display = 'grid';
    right.style.gap = '8px';
    right.style.minWidth = '0';
    const stats = el( 'div', 'res__stats', right );
    const units = el( 'div', 'res__units', right );
    const foot = el( 'div', 'res__foot', res );
    const again = el( 'button', 'btn btn--sm', foot );
    again.type = 'button';
    el( 'span', null, again, 'RETRY' );

    this.screens = {
      title: t, results: r, res, rTitle, stamp, stampL, stats, units,
      play, setBtn, again, settings: st, key: '',
    };
  }

  _buildSettings( host ) {
    const s = el( 'div', 'settings', host );
    s.setAttribute( 'role', 'dialog' );
    s.setAttribute( 'aria-label', 'Settings' );
    const hd = el( 'div', 'settings__hd', s );
    el( 'span', null, hd, 'SETTINGS' );
    const x = el( 'button', 'settings__x', hd, '✕' );
    x.type = 'button';
    x.setAttribute( 'aria-label', 'Close settings' );

    const q = el( 'div', 'set', s );
    const ql = el( 'div', 'set__lbl', q );
    el( 'span', null, ql, 'QUALITY' );
    const seg = el( 'div', 'seg', q );
    seg.setAttribute( 'role', 'radiogroup' );
    seg.setAttribute( 'aria-label', 'Render quality' );
    const segBtns = [];
    [ 'POTATO', 'BALANCED', 'MAXIMUM' ].forEach( ( n, i ) => {
      const b = el( 'button', null, seg );
      b.type = 'button';
      b.setAttribute( 'role', 'radio' );
      b.setAttribute( 'aria-label', n );
      el( 'span', null, b, n );
      b.addEventListener( 'click', () => this.setSettings( { quality: i } ) );
      segBtns.push( b );
    } );

    const mk = ( label, key ) => {
      const w = el( 'div', 'set', s );
      const l = el( 'div', 'set__lbl', w );
      el( 'span', null, l, label );
      const v = el( 'b', null, l );
      const inp = el( 'input', null, w );
      inp.type = 'range'; inp.min = '0'; inp.max = '100'; inp.step = '1';
      inp.setAttribute( 'aria-label', label );
      inp.addEventListener( 'input', () => this.setSettings( { [ key ]: inp.valueAsNumber / 100 } ) );
      return { inp, v };
    };
    const master = mk( 'MASTER VOLUME', 'master' );
    const sfx = mk( 'SFX VOLUME', 'sfx' );

    return { root: s, close: x, segBtns, master, sfx };
  }

  _buildTouch() {
    const t = el( 'div', 'touch', this.el );
    const zone = el( 'div', 'touch-zone', t );
    zone.setAttribute( 'aria-hidden', 'true' );
    const stick = el( 'div', 'stick', zone );
    const knob = el( 'div', 'stick__knob', stick );
    const cluster = el( 'div', 'tcluster', t );
    const fire = el( 'button', 'tbtn', cluster, 'FIRE' );
    fire.type = 'button';
    fire.setAttribute( 'aria-label', 'Fire' );
    const dash = el( 'button', 'tbtn tbtn--sm', cluster, 'DASH' );
    dash.type = 'button';
    dash.setAttribute( 'aria-label', 'Dash' );
    this.touch = { root: t, zone, stick, knob, fire, dash, id: -1, ox: 0, oy: 0 };

    const coarse = matchMedia( '(pointer: coarse)' );
    const apply = () => tog( this.el, 'is-touch', coarse.matches );
    apply();
    coarse.addEventListener?.( 'change', apply );
  }

  /* ---------------- events ---------------- */

  _bind() {
    const ro = new ResizeObserver( ( e ) => {
      const r = e[ 0 ].contentRect;
      this._w = r.width; this._h = r.height;
    } );
    ro.observe( this.el );
    this._ro = ro;

    /* The boss bar parks directly beneath the top bar, whose height depends on
       wrapping. Measure it here — on resize only — never inside update(). */
    const topRo = new ResizeObserver( ( e ) => {
      cssVar( this.el, '--top-h', Math.ceil( e[ 0 ].contentRect.height ) + 'px' );
    } );
    topRo.observe( this.top.top );
    this._topRo = topRo;

    this.deck.skills.addEventListener( 'click', ( e ) => {
      const b = e.target.closest( '.skill' );
      if ( b && !b.disabled ) this._fireSkill( Number( b.dataset.i ) );
    } );

    this._onKey = ( e ) => {
      if ( e.repeat ) return;
      if ( e.key >= '1' && e.key <= '9' ) {
        const i = Number( e.key ) - 1;
        const c = this.deck.cards[ i ];
        if ( c && !c.el.disabled ) { this._fireSkill( i ); }
      } else if ( e.key === 'Escape' ) {
        this._toggleSettings( false );
      }
    };
    window.addEventListener( 'keydown', this._onKey );

    const s = this.screens;
    s.play.addEventListener( 'click', () => { this._toggleSettings( false ); this.cb.onStart?.(); } );
    s.again.addEventListener( 'click', () => this.cb.onRestart?.() );
    s.setBtn.addEventListener( 'click', () => this._toggleSettings( ) );
    s.settings.close.addEventListener( 'click', () => this._toggleSettings( false ) );

    /* virtual stick */
    const t = this.touch;
    const R = 54;
    t.zone.addEventListener( 'pointerdown', ( e ) => {
      if ( t.id !== -1 ) return;
      t.id = e.pointerId;
      t.zone.setPointerCapture( e.pointerId );
      const r = t.zone.getBoundingClientRect();
      t.ox = e.clientX - r.left; t.oy = e.clientY - r.top;
      t.stick.style.transform = `translate3d(${t.ox}px, ${t.oy}px, 0)`;
      t.stick.classList.add( 'on' );
      t.knob.style.transform = 'translate3d(0,0,0)';
    } );
    t.zone.addEventListener( 'pointermove', ( e ) => {
      if ( e.pointerId !== t.id ) return;
      const r = t.zone.getBoundingClientRect();
      let dx = e.clientX - r.left - t.ox;
      let dy = e.clientY - r.top - t.oy;
      const d = Math.hypot( dx, dy ) || 1;
      const k = Math.min( 1, R / d );
      dx *= k; dy *= k;
      t.knob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      this.cb.onStick?.( dx / R, dy / R );
    } );
    const end = ( e ) => {
      if ( e.pointerId !== t.id ) return;
      t.id = -1;
      t.stick.classList.remove( 'on' );
      t.knob.style.transform = 'translate3d(0,0,0)';
      this.cb.onStick?.( 0, 0 );
    };
    t.zone.addEventListener( 'pointerup', end );
    t.zone.addEventListener( 'pointercancel', end );
    t.fire.addEventListener( 'pointerdown', () => this.cb.onFire?.( true ) );
    t.fire.addEventListener( 'pointerup', () => this.cb.onFire?.( false ) );
    t.dash.addEventListener( 'click', () => this.cb.onDash?.() );

    this._applySettings();                       // no callback during construction
  }

  _fireSkill( i ) {
    const c = this.deck.cards[ i ];
    if ( !c ) return;
    pulse( c.el, 'is-fire' );
    this.flash( 'rgba(127,214,255,.95)' );
    this.cb.onSkill?.( i );
  }

  _toggleSettings( force ) {
    const s = this.screens.settings.root;
    const on = force === undefined ? !s.classList.contains( 'is-on' ) : force;
    tog( s, 'is-on', on );
    if ( on ) this.screens.settings.master.inp.focus();
  }

  /** Merge a settings patch, refresh the controls and report it upward. */
  setSettings( patch ) {
    Object.assign( this.settings, patch );
    this._applySettings();
    this.cb.onSettings?.( { ...this.settings } );
  }

  /** Push `this.settings` into the controls without notifying the host. */
  _applySettings() {
    const s = this.screens.settings;
    const q = this.settings.quality | 0;
    s.segBtns.forEach( ( b, i ) => attr( b, 'aria-checked', i === q ? 'true' : 'false' ) );
    for ( const [ k, ui ] of [ [ 'master', s.master ], [ 'sfx', s.sfx ] ] ) {
      const v = Math.round( CLAMP( this.settings[ k ], 0, 1 ) * 100 );
      if ( ui.inp.valueAsNumber !== v ) ui.inp.value = String( v );
      cssVar( ui.inp, '--p', v + '%' );
      txt( ui.v, v + '%' );
    }
  }

  /* ---------------- per-frame update ---------------- */

  /**
   * @param {object} state   see MOCK_STATE
   * @param {THREE.Camera} camera
   * @param {THREE.WebGLRenderer} renderer  (optional — only used for size)
   */
  update( state, camera, renderer ) {
    if ( !state ) return;
    const now = performance.now();

    this._phaseTo( state.phase || 'playing' );
    this._updTop( state );
    this._updBoss( state );
    this._updSquad( state );
    this._updDeck( state );
    this._updFx( state );
    this._drain( state );
    this._updResults( state );

    if ( camera && camera.projectionMatrix ) {
      this._updWorld( state, camera );
      this._updDamage( camera, now );
    }
  }

  _phaseTo( phase ) {
    if ( phase === this._phase ) return;
    this._phase = phase;
    const menu = phase === 'title' || phase === 'results';
    tog( this.el, 'is-menu', menu );
    tog( this.screens.title, 'is-on', phase === 'title' );
    tog( this.screens.results, 'is-on', phase === 'results' );
    if ( phase !== 'title' ) this._toggleSettings( false );
    if ( phase === 'results' ) requestAnimationFrame( () => replay( this.screens.res ) );
  }

  _updTop( s ) {
    const m = s.mission || {};
    const t = this.top;
    txt( t.name, m.name || 'OPERATION' );
    txt( t.sub, m.subtitle || '' );
    txt( t.objTxt, m.objective || '' );
    txt( t.waveN, String( m.wave ?? 1 ).padStart( 2, '0' ) );
    txt( t.waveT, String( m.waves ?? 1 ).padStart( 2, '0' ) );
    txt( t.clock, clock( m.time ?? 0 ) );
    tog( t.timer, 'is-urgent', !!m.urgent || ( m.timeLimit > 0 && m.time <= 30 ) );
    if ( m.wave !== this._lastWave ) {
      if ( this._lastWave >= 0 ) pulse( t.wave, 'is-bump' );
      this._lastWave = m.wave;
    }
  }

  _updBoss( s ) {
    const b = this.boss;
    const d = s.boss;
    if ( !d || d.visible === false ) {
      if ( !b.root.hidden ) { b.root.hidden = true; tog( b.root, 'is-in', false ); }
      return;
    }
    if ( b.root.hidden ) { b.root.hidden = false; requestAnimationFrame( () => tog( b.root, 'is-in', true ) ); }

    txt( b.name, d.name || 'UNKNOWN' );
    txt( b.tagI, d.tag || 'BOSS' );
    const max = Math.max( 1, d.maxHp || 1 );
    const f = CLAMP( ( d.hp || 0 ) / max, 0, 1 );
    cssVar( b.fill, '--v', f.toFixed( 4 ) );
    cssVar( b.ghost, '--v', f.toFixed( 4 ) );
    cssVar( b.shield, '--v', CLAMP( ( d.shield || 0 ) / max, 0, 1 ).toFixed( 4 ) );
    cssVar( b.shield, '--at', f.toFixed( 4 ) );
    cssVar( b.bar, '--tick', ( 100 / Math.max( 2, Math.min( 40, d.ticks || 20 ) ) ).toFixed( 4 ) + '%' );
    txt( b.hpNow, fmt( d.hp || 0 ) );
    txt( b.hpMax, ' / ' + fmt( max ) );

    const phases = d.phases || [];
    const key = phases.map( ( p ) => p.label + ':' + p.at ).join( '|' );
    if ( key !== b.key ) {
      b.key = key;
      b.gates.textContent = '';
      b.phases.textContent = '';
      for ( let i = 0; i < phases.length; i++ ) {
        const hi = phases[ i ].at;
        const lo = i + 1 < phases.length ? phases[ i + 1 ].at : 0;
        if ( i > 0 ) el( 'i', null, b.gates ).style.left = ( hi * 100 ).toFixed( 2 ) + '%';
        const lab = el( 'span', null, b.phases );
        lab.style.left = ( ( hi + lo ) * 50 ).toFixed( 2 ) + '%';
        el( 'i', null, lab, phases[ i ].label );
      }
      b.phaseEls = Array.from( b.phases.children );
    }
    if ( b.phaseEls ) {
      for ( let i = 0; i < b.phaseEls.length; i++ ) {
        const lo = i + 1 < phases.length ? phases[ i + 1 ].at : 0;
        tog( b.phaseEls[ i ], 'is-done', f < lo - 1e-4 );
      }
    }
  }

  _updSquad( s ) {
    const list = s.squad || [];
    const seen = this._seen || ( this._seen = new Set() );
    seen.clear();

    let orderChanged = false;
    for ( let i = 0; i < list.length; i++ ) {
      const u = list[ i ];
      seen.add( u.id );
      let c = this._units.get( u.id );
      if ( !c ) {
        c = this._makeUnit( u );
        this._units.set( u.id, c );
        this.squad.appendChild( c.el );
        cssVar( c.el, '--u-col', u.color || '#35a3ea' );
        cssVar( c.refs.port, '--u-col', u.color || '#35a3ea' );
        orderChanged = true;
      }
      if ( c.order !== i ) { c.order = i; orderChanged = true; }
      this._updUnit( c, u );
    }

    for ( const [ id, c ] of this._units ) {
      if ( seen.has( id ) ) continue;
      c.el.remove();
      this._units.delete( id );
    }

    if ( orderChanged && this._units.size ) this._reorder( list );
  }

  /** FLIP reorder — runs only when the roster order actually changes. */
  _reorder( list ) {
    const cs = [];
    for ( const u of list ) {
      const c = this._units.get( u.id );
      if ( c ) cs.push( c );
    }
    const first = cs.map( ( c ) => c.el.getBoundingClientRect() );   // READ
    for ( const c of cs ) this.squad.appendChild( c.el );            // WRITE
    const last = cs.map( ( c ) => c.el.getBoundingClientRect() );    // READ
    for ( let i = 0; i < cs.length; i++ ) {
      const dx = first[ i ].left - last[ i ].left;
      const dy = first[ i ].top - last[ i ].top;
      if ( !dx && !dy ) continue;
      const n = cs[ i ].el;
      n.style.transition = 'none';
      n.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      requestAnimationFrame( () => { n.style.transition = ''; n.style.transform = ''; } );
    }
  }

  _updUnit( c, u ) {
    const r = c.refs;
    txt( r.name, u.name || '???' );
    txt( r.role, ( u.role || '' ).slice( 0, 3 ).toUpperCase() );
    const max = Math.max( 1, u.maxHp || 1 );
    const hp = CLAMP( u.hp || 0, 0, max );
    const f = hp / max;
    txt( r.hpNow, fmt( hp ) );
    txt( r.hpMax, '/' + fmt( max ) );
    cssVar( r.fill, '--v', f.toFixed( 4 ) );
    cssVar( r.ghost, '--v', f.toFixed( 4 ) );
    cssVar( r.bar, '--tick', ( 100 / Math.max( 2, Math.min( 12, Math.round( max / ( u.tickEvery || 500 ) ) ) ) ).toFixed( 4 ) + '%' );

    if ( c.hp >= 0 && hp < c.hp - 0.5 ) pulse( c.el, 'is-hurt' );
    c.hp = hp;

    tog( c.el, 'is-low', f > 0 && f <= 0.3 );
    tog( c.el, 'is-dead', !!u.dead || hp <= 0 );
    tog( c.el, 'is-active', !!u.active );

    /* shield pips */
    const pn = Math.max( 0, Math.min( 6, u.armorMax ?? ( u.maxShield ? 4 : 0 ) ) );
    if ( c.pipN !== pn ) {
      c.pipN = pn;
      r.pips.textContent = '';
      for ( let i = 0; i < pn; i++ ) el( 'i', null, r.pips );
      c.pipEls = Array.from( r.pips.children );
    }
    if ( pn ) {
      const on = Math.round( CLAMP( ( u.armor ?? ( u.shield / ( u.maxShield || 1 ) ) * pn ) || 0, 0, pn ) );
      for ( let i = 0; i < pn; i++ ) tog( c.pipEls[ i ], 'on', i < on );
    }

    /* status strip */
    const st = u.status || [];
    const key = st.map( ( x ) => x.id + '.' + ( x.stacks || 1 ) ).join( '|' );
    if ( key !== c.statusKey ) {
      c.statusKey = key;
      const host = r.status;
      while ( host.children.length > st.length ) host.lastChild.remove();
      while ( host.children.length < st.length ) {
        const n = el( 'div', 'st', host );
        el( 'span', null, n );
        el( 'b', null, n );
        el( 'u', null, n );
      }
      for ( let i = 0; i < st.length; i++ ) {
        const n = host.children[ i ];
        attr( n, 'data-k', st[ i ].kind || 'buff' );
        attr( n, 'title', st[ i ].name || st[ i ].id );
        txt( n.children[ 0 ], st[ i ].icon || '＋' );
        txt( n.children[ 1 ], st[ i ].stacks > 1 ? st[ i ].stacks : '' );
      }
    }
    for ( let i = 0; i < st.length; i++ ) {
      const d = st[ i ].duration != null && st[ i ].maxDuration
        ? CLAMP( st[ i ].duration / st[ i ].maxDuration, 0, 1 ) : 1;
      cssVar( r.status.children[ i ].children[ 2 ], '--d', d.toFixed( 3 ) );
    }
  }

  _updDeck( s ) {
    const d = this.deck;
    const cost = s.cost || { value: 0, max: 10 };
    const v = CLAMP( cost.value || 0, 0, COST_PIPS );

    for ( let i = 0; i < COST_PIPS; i++ ) {
      const f = CLAMP( v - i, 0, 1 );
      const p = d.pips[ i ];
      cssVar( p, '--f', f.toFixed( 3 ) );
      tog( p, 'is-partial', f > 0.001 && f < 0.999 );
      tog( p, 'is-full', f >= 0.999 );
    }
    txt( d.valInt, String( Math.floor( v ) ) );
    txt( d.valFrac, '.' + String( Math.floor( ( v % 1 ) * 10 ) ) );

    const skills = s.skills || [];
    while ( d.cards.length < skills.length ) {
      const c = this._makeSkill( d.cards.length );
      d.skills.appendChild( c.el );
      d.cards.push( c );
    }
    while ( d.cards.length > skills.length ) d.cards.pop().el.remove();

    for ( let i = 0; i < skills.length; i++ ) {
      const k = skills[ i ];
      const c = d.cards[ i ];
      const artKey = ( k.icon || 'burst' ) + ( k.color || '#35a3ea' );
      if ( c.artKey !== artKey ) { c.artKey = artKey; c.art.innerHTML = skillSVG( k.icon || 'burst', k.color || '#35a3ea' ); }
      txt( c.name, k.student || k.name || 'EX' );
      txt( c.student, k.student ? ( k.name || '' ) : '' );
      txt( c.key, k.key || String( i + 1 ) );

      const cn = Math.max( 0, Math.min( 8, k.cost | 0 ) );
      if ( c.costN !== cn ) {
        c.costN = cn;
        c.cost.textContent = '';
        for ( let j = 0; j < cn; j++ ) el( 'i', null, c.cost );
        c.costEls = Array.from( c.cost.children );
      }
      for ( let j = 0; j < cn; j++ ) tog( c.costEls[ j ], 'on', v >= j + 1 );

      const cdMax = k.cooldownMax || 0;
      const cd = CLAMP( k.cooldown || 0, 0, cdMax || 1 );
      const frac = cdMax > 0 ? cd / cdMax : 0;
      cssVar( c.cd, '--cd', frac.toFixed( 4 ) );
      cssVar( c.el, '--cdon', cd > 0.001 ? '1' : '0' );
      txt( c.cdnum, cd > 0.001 ? Math.ceil( cd ) : '' );

      const afford = v >= ( k.cost || 0 );
      const usable = afford && cd <= 0.001 && !k.locked;
      if ( c.el.disabled !== !usable ) c.el.disabled = !usable;
      tog( c.el, 'is-ready', usable );
      attr( c.el, 'aria-label',
        `${k.name || 'EX skill'}${k.student ? ', ' + k.student : ''}, cost ${k.cost || 0}, key ${k.key || i + 1}` +
        ( cd > 0.001 ? `, cooling down ${Math.ceil( cd )} seconds` : afford ? ', ready' : ', not enough cost' ) );
    }
  }

  _updFx( s ) {
    const low = !!( s.feedback && s.feedback.lowHp );
    tog( this.fx.low, 'on', low );
  }

  /* ---------------- world markers ---------------- */

  /**
   * Acquire (or reuse) an imperative marker. The caller owns it until it calls
   * `release()`. Declarative markers in `state.markers` use the same pool.
   */
  marker( id, type = 'enemy' ) {
    let m = this._markers.get( id );
    if ( m && m.type === type && m.alive ) return m;
    if ( m ) this._retire( id, m );
    m = this._acquire( type );
    m.declared = false;
    this._markers.set( id, m );
    return m;
  }

  _acquire( type ) {
    const pool = this._mkPool;
    for ( let i = 0; i < pool.length; i++ ) {
      if ( pool[ i ].type === type ) {
        const m = pool.splice( i, 1 )[ 0 ];
        m.alive = true;
        m.occluded = false;
        m.el.classList.remove( 'is-hidden', 'is-off', 'is-occluded' );
        this.world.appendChild( m.el );
        return m;
      }
    }
    const m = new WorldMarker( type );
    this.world.appendChild( m.el );
    return m;
  }

  _retire( id, m ) {
    this._markers.delete( id );
    m.alive = false;
    m.el.remove();
    m.el.classList.add( 'is-hidden' );
    if ( this._mkPool.length < 64 ) this._mkPool.push( m );
  }

  _updWorld( s, cam ) {
    const list = s.markers;
    if ( list ) {
      const seen = this._mkSeen || ( this._mkSeen = new Set() );
      seen.clear();
      for ( let i = 0; i < list.length; i++ ) {
        const d = list[ i ];
        if ( !d || d.id == null ) continue;
        seen.add( d.id );
        const type = d.type || 'enemy';
        let m = this._markers.get( d.id );
        if ( !m || m.type !== type ) {
          if ( m ) this._retire( d.id, m );
          m = this._acquire( type );
          this._markers.set( d.id, m );
          m.__nk = ''; m.__tk = '';
        }
        m.declared = true;
        if ( d.position ) m.position = d.position;
        m.offset = d.offset ?? ( type === 'objective' ? 0 : 2.0 );
        m.occluded = !!d.occluded;
        m.offscreen = d.offscreen ?? ( type === 'objective' || type === 'elite' );
        const nk = ( d.name || '' ) + '|' + ( d.level || '' );
        if ( m.__nk !== nk ) { m.__nk = nk; m.setName( d.name || '', d.level ); }
        if ( d.maxHp ) m.setHP( d.hp ?? 0, d.maxHp, d.shield || 0 );
        m.setTags( d.tags );
        cssVar( m.el, '--mk-col', d.color || ( type === 'objective' ? '#35a3ea' : '#ff5d6c' ) );
        if ( d.hp != null && d.maxHp ) tog( m.el, 'is-crit', d.hp / d.maxHp <= 0.25 );
      }
      for ( const [ id, m ] of this._markers ) {
        if ( m.declared && !seen.has( id ) ) this._retire( id, m );
      }
    }
    for ( const [ id, m ] of this._markers ) {
      if ( !m.alive ) { this._retire( id, m ); continue; }
      this._placeMarker( m, cam );
    }
  }

  _placeMarker( m, cam ) {
    const p = this._proj || ( this._proj = { x: 0, y: 0, z: 0, w: 0, d: 0 } );
    const pos = m.position;
    if ( !project( cam, pos.x, ( pos.y || 0 ) + m.offset, pos.z, p ) ) {
      tog( m.el, 'is-hidden', true );
      return;
    }

    const W = this._w, H = this._h;
    const behind = p.w <= 0;
    let sx = ( p.x * 0.5 + 0.5 ) * W;
    let sy = ( -p.y * 0.5 + 0.5 ) * H;
    if ( behind ) { sx = W - sx; sy = H - sy; }

    const pad = 34;
    const out = behind || sx < pad || sx > W - pad || sy < pad || sy > H - pad;

    if ( out && m.offscreen ) {
      const cx = W * 0.5, cy = H * 0.5;
      let dx = sx - cx, dy = sy - cy;
      const len = Math.hypot( dx, dy ) || 1;
      dx /= len; dy /= len;
      const hx = ( W * 0.5 - pad ) / ( Math.abs( dx ) || 1e-4 );
      const hy = ( H * 0.5 - pad ) / ( Math.abs( dy ) || 1e-4 );
      const t = Math.min( hx, hy );
      sx = cx + dx * t;
      sy = cy + dy * t;
      tog( m.el, 'is-off', true );
      tog( m.el, 'is-hidden', false );
      tog( m.el, 'is-occluded', false );
      cssVar( m.refs.arrow, '--rot', ( Math.atan2( dx, -dy ) * 57.29577951308232 ).toFixed( 1 ) + 'deg' );
      txt( m.refs.dist, Math.round( p.d ) + 'm' );
      cssVar( m.inner, '--s', '1' );
    } else {
      tog( m.el, 'is-off', false );
      tog( m.el, 'is-hidden', out );
      tog( m.el, 'is-occluded', m.occluded );
      const s = CLAMP( 16 / Math.max( 2, p.d ), 0.5, 1.25 );
      cssVar( m.inner, '--s', s.toFixed( 3 ) );
    }
    m.el.style.transform = `translate3d(${ sx.toFixed( 1 ) }px, ${ sy.toFixed( 1 ) }px, 0)`;
  }

  /* ---------------- damage numbers ---------------- */

  /**
   * Spawn one floating number.
   * @param {number|string} value
   * @param {string} kind  normal | crit | weak | heal | block | miss
   * @param {{x,y,z}} position  world point (or screen px when opts.screen)
   */
  damage( value, kind = 'normal', position = null, opts = {} ) {
    const d = this._dmg[ this._dmgHead ];
    this._dmgHead = ( this._dmgHead + 1 ) % this._dmg.length;

    attr( d.el, 'data-k', kind );
    txt( d.v, typeof value === 'number' ? fmt( value ) : String( value ) );
    const tag = opts.tag ?? ( kind === 'crit' ? 'CRITICAL' : kind === 'weak' ? 'WEAK POINT' : kind === 'block' ? 'GUARD' : '' );
    txt( d.tag, tag );
    d.tag.style.display = tag ? 'block' : 'none';

    const spread = kind === 'crit' ? 34 : 24;
    cssVar( d.el, '--dx', ( ( Math.random() * 2 - 1 ) * spread ).toFixed( 0 ) + 'px' );
    cssVar( d.el, '--dy', ( -( kind === 'crit' ? 64 : 44 ) - Math.random() * 18 ).toFixed( 0 ) + 'px' );

    d.screen = !!opts.screen;
    if ( position ) { d.pos.x = position.x; d.pos.y = position.y || 0; d.pos.z = position.z || 0; }
    d.jitter = ( Math.random() * 2 - 1 ) * 16;
    d.rise = opts.rise ?? 1.9;
    d.live = true;
    d.until = performance.now() + 950;
    d.el.classList.add( 'is-live' );
    replay( d.el );
    return d;
  }

  _updDamage( cam, now ) {
    const p = this._proj || ( this._proj = { x: 0, y: 0, z: 0, w: 0, d: 0 } );
    const W = this._w, H = this._h;
    for ( let i = 0; i < this._dmg.length; i++ ) {
      const d = this._dmg[ i ];
      if ( !d.live ) continue;
      if ( now >= d.until ) {
        d.live = false;
        d.el.classList.remove( 'is-live' );
        d.el.style.transform = 'translate3d(-9999px,-9999px,0)';
        continue;
      }
      let sx, sy;
      if ( d.screen ) { sx = d.pos.x; sy = d.pos.y; }
      else {
        if ( !project( cam, d.pos.x, d.pos.y + d.rise, d.pos.z, p ) || p.w <= 0 ) {
          d.el.style.transform = 'translate3d(-9999px,-9999px,0)';
          continue;
        }
        sx = ( p.x * 0.5 + 0.5 ) * W + d.jitter;
        sy = ( -p.y * 0.5 + 0.5 ) * H;
      }
      d.el.style.transform = `translate3d(${ sx.toFixed( 1 ) }px, ${ sy.toFixed( 1 ) }px, 0)`;
    }
  }

  /* ---------------- hit feedback ---------------- */

  /** Directional damage vignette. `angle` is radians, 0 = dead ahead. */
  hit( angle = 0, strength = 1 ) {
    const v = this.fx.vig;
    cssVar( v, '--hx', ( 50 + Math.sin( angle ) * 44 ).toFixed( 1 ) + '%' );
    cssVar( v, '--hy', ( 50 - Math.cos( angle ) * 44 ).toFixed( 1 ) + '%' );
    cssVar( v, '--hs', CLAMP( strength, 0.2, 1 ).toFixed( 2 ) );
    pulse( v, 'is-hit' );
  }

  /** Screen-edge flash — used on skill activation and big events. */
  flash( color = 'rgba(127,214,255,.95)' ) {
    cssVar( this.fx.flash, '--fc', color );
    pulse( this.fx.flash, 'is-on' );
  }

  /* ---------------- banners ---------------- */

  /**
   * @param {string} main   headline, e.g. "WAVE INCOMING"
   * @param {string} sub    kicker line
   * @param {string} kind   wave | danger | clear | defeat
   * @param {number} life   total ms on screen
   */
  banner( main, sub = '', kind = 'wave', life = 2400 ) {
    const n = el( 'div', 'bn', this.banners );
    attr( n, 'data-k', kind );
    cssVar( n, '--life', life + 'ms' );
    el( 'div', 'bn__band', n );
    const stripe = el( 'div', 'bn__stripe', n );
    if ( kind === 'wave' || kind === 'danger' ) stripe.classList.add( 'hazard' );
    const t = el( 'div', 'bn__txt', n );
    el( 'div', 'bn__main', t, main );
    if ( sub ) el( 'div', 'bn__sub', t, sub );
    const done = () => n.remove();
    n.addEventListener( 'animationend', ( e ) => { if ( e.target === n ) done(); } );
    setTimeout( done, life + 400 );
    return n;
  }

  /* ---------------- event queue ---------------- */

  /**
   * Consume `state.events` — a plain array the game pushes into and the HUD
   * empties every frame, so no allocation-per-event contract is imposed.
   */
  _drain( s ) {
    const q = s.events;
    if ( !q || !q.length ) return;
    for ( let i = 0; i < q.length; i++ ) {
      const e = q[ i ];
      if ( !e ) continue;
      switch ( e.t ) {
        case 'damage': this.damage( e.value, e.kind, e.position, e ); break;
        case 'hit':    this.hit( e.angle || 0, e.strength ); break;
        case 'flash':  this.flash( e.color ); break;
        case 'banner': this.banner( e.main, e.sub, e.kind, e.life ); break;
        case 'skill':  { const c = this.deck.cards[ e.index ]; if ( c ) pulse( c.el, 'is-fire' ); break; }
        default: break;
      }
    }
    q.length = 0;
  }

  /* ---------------- results ---------------- */

  _updResults( s ) {
    const r = s.results;
    const sc = this.screens;
    if ( !r ) return;
    const key = JSON.stringify( r );
    if ( key === sc.key ) return;
    sc.key = key;

    txt( sc.rTitle, r.title || ( r.fail ? 'MISSION FAILED' : 'MISSION COMPLETE' ) );
    tog( sc.rTitle, 'is-fail', !!r.fail );

    const rank = ( r.rank || 'C' ).toUpperCase();
    attr( sc.stamp, 'data-r', rank );
    txt( sc.stampL, rank );

    const rows = r.stats && r.stats.length ? r.stats : [
      { label: 'SCORE', value: fmt( r.score || 0 ) },
      { label: 'TIME', value: clock( r.time || 0 ) },
      { label: 'WAVES CLEARED', value: `${ r.waves || 0 } / ${ r.wavesTotal || r.waves || 0 }` },
      { label: 'MAX COMBO', value: fmt( r.combo || 0 ) },
    ];
    const host = sc.stats;
    while ( host.children.length > rows.length ) host.lastChild.remove();
    while ( host.children.length < rows.length ) {
      const n = el( 'div', 'rrow', host );
      el( 'em', null, n );
      el( 'b', null, n );
    }
    for ( let i = 0; i < rows.length; i++ ) {
      txt( host.children[ i ].children[ 0 ], rows[ i ].label );
      txt( host.children[ i ].children[ 1 ], rows[ i ].value );
    }

    const us = r.units || [];
    const uh = sc.units;
    while ( uh.children.length > us.length ) uh.lastChild.remove();
    while ( uh.children.length < us.length ) {
      const n = el( 'div', 'ru', uh );
      const nm = el( 'div', 'ru__n', n );
      el( 'i', null, nm );
      el( 'span', null, nm );
      for ( let c = 0; c < 3; c++ ) {
        const v = el( 'div', 'ru__v', n );
        el( 'span', null, v );
        el( 's', null, v );
      }
    }
    const COLS = [ [ 'damage', 'DAMAGE' ], [ 'kills', 'DEFEATED' ], [ 'healed', 'HEALED' ] ];
    for ( let i = 0; i < us.length; i++ ) {
      const n = uh.children[ i ];
      const u = us[ i ];
      cssVar( n, '--i', String( i ) );
      cssVar( n, '--u-col', u.color || '#35a3ea' );
      const chip = n.children[ 0 ].children[ 0 ];
      const ck = ( u.id || u.name || 'x' ) + '|' + ( u.color || '#35a3ea' );
      if ( chip.__ck !== ck ) { chip.__ck = ck; chip.innerHTML = portraitSVG( u.id || u.name || 'x', u.color || '#35a3ea' ); }
      txt( n.children[ 0 ].children[ 1 ], u.name || '???' );
      for ( let c = 0; c < 3; c++ ) {
        const cell = n.children[ c + 1 ];
        txt( cell.children[ 0 ], fmt( u[ COLS[ c ][ 0 ] ] || 0 ) );
        txt( cell.children[ 1 ], COLS[ c ][ 1 ] );
      }
    }
  }

  /* ---------------- lifecycle ---------------- */

  /** Show/hide the whole HUD without tearing it down. */
  setVisible( on ) { tog( this.el, 'is-hidden', !on ); }

  dispose() {
    window.removeEventListener( 'keydown', this._onKey );
    this._ro?.disconnect();
    this._topRo?.disconnect();
    this._markers.clear();
    this._units.clear();
    this.el.remove();
  }
}

/* ---------------------------------------------------------------------- */
/* projection — camera-agnostic, no THREE import                          */
/* ---------------------------------------------------------------------- */

/**
 * Project a world point through any THREE camera without importing THREE.
 * Writes NDC into `out.x/out.y/out.z`, clip w into `out.w` and view-space
 * distance into `out.d`. Returns false when the camera has no usable matrices.
 */
function project( cam, x, y, z, out ) {
  const vmi = cam.matrixWorldInverse, pmi = cam.projectionMatrix;
  if ( !vmi || !pmi || !vmi.elements || !pmi.elements ) return false;
  const v = vmi.elements, p = pmi.elements;

  const vx = v[ 0 ] * x + v[ 4 ] * y + v[ 8 ]  * z + v[ 12 ];
  const vy = v[ 1 ] * x + v[ 5 ] * y + v[ 9 ]  * z + v[ 13 ];
  const vz = v[ 2 ] * x + v[ 6 ] * y + v[ 10 ] * z + v[ 14 ];

  const cx = p[ 0 ] * vx + p[ 4 ] * vy + p[ 8 ]  * vz + p[ 12 ];
  const cy = p[ 1 ] * vx + p[ 5 ] * vy + p[ 9 ]  * vz + p[ 13 ];
  const cz = p[ 2 ] * vx + p[ 6 ] * vy + p[ 10 ] * vz + p[ 14 ];
  const cw = p[ 3 ] * vx + p[ 7 ] * vy + p[ 11 ] * vz + p[ 15 ];

  const iw = cw === 0 ? 1e6 : 1 / cw;
  out.x = cx * iw;
  out.y = cy * iw;
  out.z = cz * iw;
  out.w = cw;
  out.d = Math.hypot( vx, vy, vz );
  return true;
}

/* ---------------------------------------------------------------------- */
/* MOCK_STATE — the full `update(state)` schema, populated                 */
/* ---------------------------------------------------------------------- */

/**
 * Every field the HUD reads. Everything is optional except `phase`; missing
 * branches simply render nothing. `events` is a queue the game pushes into and
 * the HUD empties each frame.
 */
export const MOCK_STATE = {
  /* 'title' | 'playing' | 'results' */
  phase: 'playing',

  mission: {
    name: 'SHANHAIJING CORRIDOR',
    subtitle: 'OPERATION 04-3 · HARD',
    objective: 'Suppress the Hieromonk before reinforcements arrive',
    wave: 3,
    waves: 8,
    time: 214,          // seconds — counts however the game likes
    timeLimit: 300,
    urgent: false,
  },

  boss: {
    visible: true,
    name: 'HIEROMONK — GOZ',
    tag: 'BOSS',
    hp: 41200,
    maxHp: 68000,
    shield: 5400,
    ticks: 24,          // number of segment ticks along the bar
    phases: [           // `at` = HP fraction where the phase begins (descending)
      { label: 'PHASE I',   at: 1.00 },
      { label: 'PHASE II',  at: 0.66 },
      { label: 'PHASE III', at: 0.33 },
    ],
  },

  squad: [
    {
      id: 'aru', name: 'ARU', role: 'STRIKER', color: '#ff5d6c',
      hp: 1840, maxHp: 2400, tickEvery: 400,
      armor: 3, armorMax: 4,
      dead: false, active: true,
      status: [
        { id: 'atk', kind: 'buff',   icon: '▲', name: 'Attack Up',   stacks: 2, duration: 6.2, maxDuration: 10 },
        { id: 'brn', kind: 'debuff', icon: '火', name: 'Burning',     stacks: 1, duration: 2.1, maxDuration: 8 },
      ],
    },
    {
      id: 'hina', name: 'HINA', role: 'SPECIAL', color: '#7a6ce0',
      hp: 640, maxHp: 2900, tickEvery: 400,
      armor: 1, armorMax: 4,
      dead: false, active: false,
      status: [ { id: 'shd', kind: 'shield', icon: '盾', name: 'Barrier', stacks: 1, duration: 4, maxDuration: 12 } ],
    },
    {
      id: 'shiroko', name: 'SHIROKO', role: 'STRIKER', color: '#7fd6ff',
      hp: 2210, maxHp: 2210, tickEvery: 400,
      armor: 4, armorMax: 4,
      dead: false, active: false,
      status: [ { id: 'hst', kind: 'heal', icon: '＋', name: 'Regen', stacks: 3, duration: 9, maxDuration: 12 } ],
    },
    {
      id: 'hoshino', name: 'HOSHINO', role: 'TANK', color: '#ffb0c8',
      hp: 0, maxHp: 3600, tickEvery: 400,
      armor: 0, armorMax: 4,
      dead: true, active: false,
      status: [],
    },
  ],

  cost: { value: 6.4, max: 10 },

  skills: [
    { name: 'FULL BARRAGE', student: 'ARU',     key: '1', icon: 'burst',  color: '#ff5d6c', cost: 4, cooldown: 0,   cooldownMax: 22, locked: false },
    { name: 'DEMOLITION',   student: 'HINA',    key: '2', icon: 'aoe',    color: '#7a6ce0', cost: 5, cooldown: 8.4, cooldownMax: 26, locked: false },
    { name: 'PRECISION',    student: 'SHIROKO', key: '3', icon: 'shot',   color: '#7fd6ff', cost: 3, cooldown: 0,   cooldownMax: 18, locked: false },
    { name: 'BULWARK',      student: 'HOSHINO', key: '4', icon: 'shield', color: '#ffb0c8', cost: 8, cooldown: 0,   cooldownMax: 30, locked: false },
  ],

  /* World-anchored DOM. `position` may be a THREE.Vector3 or any {x,y,z}. */
  markers: [
    { id: 'e1', type: 'enemy', position: { x: -3.2, y: 0, z: -6 },  offset: 2.0,
      name: 'SENTRY', level: 42, hp: 620,  maxHp: 900,  shield: 0,   tags: [ 'LIGHT' ], occluded: false },
    { id: 'e2', type: 'enemy', position: { x: 4.6, y: 0, z: -9 },   offset: 2.0,
      name: 'GUNNER', level: 44, hp: 300,  maxHp: 900,  shield: 120, tags: [ 'LIGHT' ], occluded: true },
    { id: 'b1', type: 'elite', position: { x: 0.4, y: 0, z: -16 },  offset: 3.4,
      name: 'HIEROMONK', level: 60, hp: 41200, maxHp: 68000, shield: 5400,
      tags: [ 'ELASTIC', 'BOSS' ], color: '#ff5d6c', occluded: false, offscreen: true },
    { id: 'ally1', type: 'ally', position: { x: -1.6, y: 0, z: -2 }, offset: 2.0,
      name: 'SHIROKO', hp: 2210, maxHp: 2210, color: '#7fd6ff' },
    { id: 'obj', type: 'objective', position: { x: -14, y: 1.2, z: -22 }, offset: 0,
      name: 'EXTRACT', color: '#35a3ea', offscreen: true },
    { id: 'obj2', type: 'objective', position: { x: 18, y: 1.2, z: 12 }, offset: 0,
      name: 'SUPPLY', color: '#4ce0a4', offscreen: true },
  ],

  feedback: { lowHp: true },

  /* Drained and cleared by the HUD every frame. */
  events: [
    // { t:'damage', value:1234, kind:'crit', position:{x,y,z}, tag:'CRITICAL' }
    // { t:'hit', angle: 1.2, strength: 0.8 }
    // { t:'flash', color:'rgba(127,214,255,.95)' }
    // { t:'banner', main:'WAVE INCOMING', sub:'WAVE 04 / 08', kind:'wave', life:2400 }
    // { t:'skill', index: 0 }
  ],

  /* Only read while phase === 'results'. */
  results: {
    title: 'MISSION COMPLETE',
    fail: false,
    rank: 'S',
    score: 184920,
    time: 268,
    waves: 8,
    wavesTotal: 8,
    combo: 143,
    stats: [
      { label: 'SCORE',         value: '184,920' },
      { label: 'CLEAR TIME',    value: '04:28' },
      { label: 'WAVES CLEARED', value: '8 / 8' },
      { label: 'MAX COMBO',     value: '143' },
      { label: 'DAMAGE TAKEN',  value: '4,180' },
    ],
    units: [
      { id: 'aru',     name: 'ARU',     color: '#ff5d6c', damage: 84210, kills: 41, healed: 0 },
      { id: 'hina',    name: 'HINA',    color: '#7a6ce0', damage: 61905, kills: 33, healed: 0 },
      { id: 'shiroko', name: 'SHIROKO', color: '#7fd6ff', damage: 38820, kills: 22, healed: 1200 },
      { id: 'hoshino', name: 'HOSHINO', color: '#ffb0c8', damage: 9140,  kills: 4,  healed: 8640 },
    ],
  },
};
