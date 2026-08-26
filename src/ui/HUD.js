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
  aoe:   '<path d="M32 6 a26 26 0 1 1 -.1 0 Z M32 16 a16 16 0 1 0 .1 0 Z"/><circle cx="32" cy="32" r="7"/>',
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

    const bar = el( 'div', 'bar boss__bar', boss );
    const ghost = el( 'i', 'ghost', bar );
    const fill = el( 'i', 'fill', bar );
    const shield = el( 'i', 'shield', bar );
    el( 'i', 'ticks', bar );
    el( 'i', 'gloss', bar );
    const gates = el( 'div', 'boss__gates', bar );
    const phases = el( 'div', 'boss__phases', boss );

    this.boss = { root: boss, tagI, name, hp, bar, ghost, fill, shield, gates, phases, ghostV: 1, key: '' };
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

    this.setSettings( this.settings );
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
    const s = this.screens.settings;
    const q = this.settings.quality | 0;
    s.segBtns.forEach( ( b, i ) => attr( b, 'aria-checked', i === q ? 'true' : 'false' ) );
    for ( const [ k, ui ] of [ [ 'master', s.master ], [ 'sfx', s.sfx ] ] ) {
      const v = Math.round( CLAMP( this.settings[ k ], 0, 1 ) * 100 );
      if ( ui.inp.valueAsNumber !== v ) ui.inp.value = String( v );
      cssVar( ui.inp, '--p', v + '%' );
      txt( ui.v, v + '%' );
    }
    this.cb.onSettings?.( { ...this.settings } );
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
    if ( phase === 'results' ) pulse( this.screens.res, 'res' );
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
    cssVar( b.bar, '--tick', ( 100 / Math.max( 2, Math.min( 40, d.ticks || 20 ) ) ).toFixed( 4 ) + '%' );
    txt( b.hp, fmt( d.hp || 0 ) );

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
      txt( c.name, k.name || 'EX SKILL' );
      txt( c.student, k.student || '' );
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
