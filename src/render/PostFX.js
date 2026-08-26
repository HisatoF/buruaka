import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * Anime grade pass.
 *
 * Deliberately not ACES: filmic curves desaturate exactly the saturated
 * primaries that make cel shading read as cel shading. Instead this rolls
 * highlights off toward white while holding hue, then applies a split-tone
 * (cool shadows / warm highlights), saturation lift, vignette and a touch of
 * edge-only chromatic aberration.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1.0 },
    uContrast: { value: 1.045 },
    uSaturation: { value: 1.10 },
    uLift: { value: new THREE.Color( 0x0a1120 ) },
    uGain: { value: new THREE.Color( 0xfff4e2 ) },
    uSplitStrength: { value: 0.35 },
    uVignette: { value: 0.30 },
    uVignetteSoft: { value: 0.62 },
    uAberration: { value: 0.0008 },
    uGrain: { value: 0.011 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2( 1920, 1080 ) },
    uHighlightRolloff: { value: 0.82 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color( 0xffffff ) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure, uContrast, uSaturation, uSplitStrength;
    uniform vec3  uLift, uGain;
    uniform float uVignette, uVignetteSoft, uAberration, uGrain, uTime;
    uniform float uHighlightRolloff, uFlash;
    uniform vec3  uFlashColor;
    uniform vec2  uResolution;
    varying vec2 vUv;

    float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

    float hash( vec2 p ) {
      return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot( centered, centered );

      // Chromatic aberration scaled by r^2 so the centre stays perfectly sharp.
      vec3 color;
      if ( uAberration > 0.0 ) {
        vec2 off = centered * uAberration * r2 * 4.0;
        color.r = texture2D( tDiffuse, uv + off ).r;
        color.g = texture2D( tDiffuse, uv ).g;
        color.b = texture2D( tDiffuse, uv - off ).b;
      } else {
        color = texture2D( tDiffuse, uv ).rgb;
      }

      color *= uExposure;

      // Hue-preserving highlight rolloff: compress the max channel and scale
      // the rest with it, so a blown-out red stays red instead of going pink.
      float m = max( max( color.r, color.g ), color.b );
      if ( m > uHighlightRolloff ) {
        float k = uHighlightRolloff;
        float compressed = k + ( 1.0 - k ) * ( 1.0 - exp( -( m - k ) / max( 1.0 - k, 1e-3 ) ) );
        color *= compressed / max( m, 1e-4 );
      }

      // Everything below is a colourist's grade, and a colourist works in a
      // perceptual space. Applying contrast around a 0.5 pivot to LINEAR
      // radiance crushes every saturated dark to black — a navy skirt at
      // linear 0.055 lands at 0.015, which is why this has to round-trip
      // through gamma first.
      vec3 g = pow( max( color, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );

      float l = luma( g );
      vec3 shadowPush = uLift * ( 1.0 - smoothstep( 0.0, 0.55, l ) );
      vec3 highlightPush = ( uGain - vec3( 1.0 ) ) * smoothstep( 0.45, 1.0, l );
      g += ( shadowPush + highlightPush ) * uSplitStrength;

      g = ( g - 0.5 ) * uContrast + 0.5;
      g = mix( vec3( luma( g ) ), g, uSaturation );

      // Vignette.
      float vig = smoothstep( 0.85, uVignetteSoft * 0.5, sqrt( r2 ) );
      g *= mix( 1.0, vig, uVignette );

      // Fine grain keeps large flat cel areas from banding. Applied in gamma
      // space so it stays perceptually even instead of vanishing in shadow.
      g += ( hash( gl_FragCoord.xy + fract( uTime ) * 137.0 ) - 0.5 ) * uGrain;

      color = pow( max( g, vec3( 0.0 ) ), vec3( 2.2 ) );

      color = mix( color, uFlashColor, clamp( uFlash, 0.0, 1.0 ) );

      gl_FragColor = vec4( max( color, vec3( 0.0 ) ), 1.0 );
    }
  `,
};

export class PostFX {
  constructor( renderer, scene, camera, options = {} ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const size = renderer.getSize( new THREE.Vector2() );
    const pixelRatio = renderer.getPixelRatio();

    this.composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget( size.x * pixelRatio, size.y * pixelRatio, {
        type: THREE.HalfFloatType,
        samples: options.msaa ?? 0,
      } )
    );

    this.renderPass = new RenderPass( scene, camera );
    this.composer.addPass( this.renderPass );

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2( size.x, size.y ),
      options.bloomStrength ?? 0.62,
      options.bloomRadius ?? 0.62,
      options.bloomThreshold ?? 0.94
    );
    this.composer.addPass( this.bloomPass );

    this.gradePass = new ShaderPass( GradeShader );
    this.gradePass.uniforms.uResolution.value.set( size.x, size.y );
    this.composer.addPass( this.gradePass );

    this.smaaPass = new SMAAPass();
    this.composer.addPass( this.smaaPass );

    this.outputPass = new OutputPass();
    this.composer.addPass( this.outputPass );

    this.grade = this.gradePass.uniforms;
  }

  /** Full-screen colour flash, used for skill activations and big hits. */
  flash( color = 0xffffff, amount = 0.6, decay = 3.2 ) {
    this.grade.uFlashColor.value.set( color );
    this._flash = amount;
    this._flashDecay = decay;
  }

  setSize( width, height, pixelRatio ) {
    this.composer.setPixelRatio( pixelRatio );
    this.composer.setSize( width, height );
    this.bloomPass.setSize( width * pixelRatio, height * pixelRatio );
    this.grade.uResolution.value.set( width * pixelRatio, height * pixelRatio );
  }

  setQuality( level ) {
    // 0 = potato, 1 = balanced, 2 = maximum.
    this.bloomPass.enabled = level >= 1;
    this.smaaPass.enabled = level >= 1;
    this.grade.uAberration.value = level >= 2 ? 0.0008 : 0;
    this.grade.uGrain.value = level >= 1 ? 0.011 : 0;
  }

  render( dt, elapsed ) {
    this.grade.uTime.value = elapsed;
    if ( this._flash > 0 ) {
      this._flash = Math.max( 0, this._flash - dt * this._flashDecay );
    }
    this.grade.uFlash.value = this._flash || 0;

    if ( this.enabled ) {
      this.composer.render( dt );
    } else {
      this.renderer.render( this.scene, this.camera );
    }
  }

  dispose() {
    this.composer.dispose();
  }
}

export { GradeShader };
