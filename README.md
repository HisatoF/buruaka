# BURUAKA — Kivotos Tactical

A cel-shaded anime tactical shooter built in Three.js.

**Every asset is generated at runtime from code.** There is not a single
image, model, or audio file in this repository — the characters, their faces,
the weapons, the arena, the textures, the sound effects and the music are all
synthesised when the page loads.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
```

## Controls

| Input | Action |
|---|---|
| `W A S D` | Move the squad's rally point |
| Mouse drag | Orbit the camera |
| Mouse wheel | Zoom |
| `1` – `4` | Fire a student's EX skill |
| `P` / `Esc` | Pause |

The squad fights autonomously — they advance to contact, take cover, pick
targets and reload on their own. Your job is positioning and timing the EX
skills against a shared cost bar, which is the shape the genre is built on.

## What's in here

### Rendering

The look is a three-tone cel shader (`src/render/ToonMaterial.js`) with
hue-shifted violet shadows rather than flat darkening, a hard-edged specular
band for hair and gunmetal, and a fresnel rim gated to the silhouette.
Outlines are inverted hulls that hold a constant pixel width at any distance,
backed by an averaged-normal attribute so hard edges don't split open.

The post stack deliberately skips ACES. A filmic curve desaturates exactly the
flat saturated primaries that make cel shading read as cel shading, so
`src/render/PostFX.js` uses a hue-preserving highlight rolloff, a split-tone,
and a grade applied in gamma space instead.

### Characters

Characters are modelled as plain geometry in bind pose and skinned afterwards
by solving weights against per-bone capsules (`src/gen/Rig.js`), so a new
outfit piece is correctly skinned the moment it is modelled. Hair is built in
three layers — an offset skull shell with the face carved out, static clumps
welded to the head, and bone-driven chains for twintails and ponytails.

Faces are sprite cards on a shared atlas rather than baked into the head
texture, so blinking and expression are UV writes and the whole face renders
in one draw call. The eye art is drawn with variable-width filled ink strokes:
a fixed `lineWidth` stroke is what makes procedural line art look procedural.

An entire character — skin, shirt, skirt, socks, shoes — merges into a single
draw call via a vertex tint attribute, while still reading as separate
materials.

### Animation

No clips. `src/anim/Animator.js` layers breathing, locomotion, flinch, reload,
skill and downed poses as additive Euler offsets in a pose buffer applied once
per frame, so blending is order-independent. Aiming is analytic two-bone IK
onto an actual weapon transform rather than authored joint angles — one pose
then serves every weapon at every target elevation.

Hair and cloth get Verlet spring chains recovered as swing-only rotations,
with cone limits and body-sphere collision, on a fixed timestep so they behave
identically at 30 and 144 fps.

### Simulation

`src/physics/World.js` is a purpose-built collision layer: uniform-grid
broadphase, capsule collide-and-slide with step-up and ground snapping, and a
pooled ballistics system that spherecasts each substep so a 300 m/s round
cannot tunnel a thin wall.

## Verification

```bash
node tools/screenshot.mjs --play 55 --shots game,firefight,portrait   # renders + fails on any console error
node tools/perf.mjs --play 60                                          # frame-time distribution
node tools/tests/physics.test.mjs                                      # collision, ballistics, queries
node tools/tests/ik.test.mjs                                           # two-bone IK reach and elbow orientation
```

`tools/screenshot.mjs` boots a dev server, renders in headless Chromium and
exits non-zero on any console error, page exception or failed shader compile,
so a broken frame can't quietly pass. `--play N` fast-forwards the simulation
N seconds so captures show a live firefight rather than a menu.

Two debug pages exist for judging art in isolation: `char.html` (character
viewer, no HUD) and `debug.html` (2D face/eye/brow/mouth atlases).
`audio.html` renders every synthesised sound through an `OfflineAudioContext`
and reports peak, RMS and onset taper.

## Layout

```
src/
  core/     Engine (renderer, frame loop, adaptive resolution), Input, Audio
  render/   ToonMaterial, PostFX, Sky, Lighting, Particles
  gen/      Geometry, Rig, Character, Hair, Face, Weapon, Level, Textures
  anim/     Animator (pose layers + two-bone IK)
  physics/  World (collision, ballistics, queries), SpringBone
  game/     Game, Unit, Skills, Waves, CameraRig
  ui/       HUD, styles
```

See `docs/ARCHITECTURE.md` for module contracts and conventions.
