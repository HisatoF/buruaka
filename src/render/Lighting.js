import * as THREE from 'three';

/**
 * The lighting rig every toon material reads from.
 *
 * Only `key` feeds the cel ramp (the shader reads directionalLights[0]) — the
 * fill and bounce are folded into each material's hemispheric ambient instead,
 * because adding real lights would soften the hard ramp edge that makes the
 * shading read as cel.
 */
export class LightingRig {
  constructor( scene, options = {} ) {
    this.scene = scene;

    this.sunDirection = new THREE.Vector3()
      .copy( options.sunDirection ?? new THREE.Vector3( 0.42, 0.68, 0.6 ) )
      .normalize();

    this.key = new THREE.DirectionalLight( options.keyColor ?? 0xfff3e0, options.keyIntensity ?? 1.0 );
    this.key.castShadow = true;
    this.key.shadow.mapSize.set( options.shadowMapSize ?? 2048, options.shadowMapSize ?? 2048 );
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.055;
    this.key.shadow.radius = 0.65;
    this.key.shadow.intensity = 1;

    const d = options.shadowExtent ?? 26;   // metres; halving it doubles texel density
    const cam = this.key.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
    cam.near = 0.5; cam.far = 90;
    cam.updateProjectionMatrix();

    this.target = new THREE.Object3D();
    scene.add( this.target );
    this.key.target = this.target;
    scene.add( this.key );

    // Present so that any stock three material dropped into the scene (debug
    // helpers, imported props) is still lit sensibly.
    this.ambient = new THREE.HemisphereLight(
      options.skyColor ?? 0xbcd8ff,
      options.groundColor ?? 0x8a7f9c,
      options.ambientIntensity ?? 0.7
    );
    scene.add( this.ambient );

    this.shadowDistance = options.shadowDistance ?? 18;
    this._updateSunPosition( new THREE.Vector3() );
  }

  _updateSunPosition( focus ) {
    this.target.position.copy( focus );
    this.key.position.copy( focus ).addScaledVector( this.sunDirection, 40 );
  }

  /** Keeps the shadow frustum snapped around whatever the camera is watching. */
  followFocus( focus ) {
    // Snap to texel increments so the shadow edge doesn't crawl as we pan.
    const texelWorld = ( this.key.shadow.camera.right - this.key.shadow.camera.left ) / this.key.shadow.mapSize.x;
    const snapped = focus.clone();
    snapped.x = Math.round( snapped.x / texelWorld ) * texelWorld;
    snapped.z = Math.round( snapped.z / texelWorld ) * texelWorld;
    snapped.y = 0;
    this._updateSunPosition( snapped );
  }

  applyPreset( preset ) {
    if ( preset.sunDirection ) this.sunDirection.copy( preset.sunDirection ).normalize();
    if ( preset.keyColor !== undefined ) this.key.color.set( preset.keyColor );
    if ( preset.keyIntensity !== undefined ) this.key.intensity = preset.keyIntensity;
    if ( preset.skyColor !== undefined ) this.ambient.color.set( preset.skyColor );
    if ( preset.groundColor !== undefined ) this.ambient.groundColor.set( preset.groundColor );
  }

  setQuality( level ) {
    this.key.castShadow = level >= 1;
    const size = level >= 2 ? 2048 : 1024;
    if ( this.key.shadow.mapSize.x !== size ) {
      this.key.shadow.mapSize.set( size, size );
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
  }
}
