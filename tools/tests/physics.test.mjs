import * as THREE from 'three';
import { PhysicsWorld, Ballistics, LAYER_STATIC, LAYER_CHARACTER, LAYER_ALL } from '/home/user/buruaka/src/physics/World.js';

const w = new PhysicsWorld();
w.addPlane(0);
w.addBox(new THREE.Vector3(3,1,0), new THREE.Vector3(0.5,1,3), { tag:'wall' });

// 1. capsule falls and rests
const body = w.addCapsule(new THREE.Vector3(0,3,0), 0.3, 1.0, { tag:'char' });
for (let i=0;i<400;i++) w.step(1/60);
console.log('rest y =', body.position.y.toFixed(4), 'vel =', body.velocity?.length?.().toFixed(5) ?? 'n/a');

// 2. slide along a wall
const b2 = w.addCapsule(new THREE.Vector3(1.5,1,0), 0.3, 1.0, { tag:'char' });
for (let i=0;i<120;i++){ w.moveCharacter(b2, new THREE.Vector3(0.03, 0, 0.02)); w.step(1/60); }
console.log('slide pos =', b2.position.x.toFixed(3), b2.position.z.toFixed(3), '(x must stay < 2.5)');

// 3. raycast
const r = w.raycast(new THREE.Vector3(0,1,0), new THREE.Vector3(1,0,0), 10, LAYER_ALL);
console.log('raycast hit =', r.hit, 'dist =', r.hit ? r.distance.toFixed(3) : '-', 'tag =', r.tag);

// 4. fast projectile vs thin wall
w.addBox(new THREE.Vector3(-5,1,0), new THREE.Vector3(0.05,1,3), { tag:'thin' });
let hits = 0;
const bal = new Ballistics(w);
bal.spawn({ origin:new THREE.Vector3(0,1,0), direction:new THREE.Vector3(-1,0,0), speed:300, radius:0.02, mask:LAYER_ALL, maxLife:2, onHit:(h)=>{hits++;} });
for (let i=0;i<60;i++) bal.step ? bal.step(1/60) : bal.update(1/60);
console.log('projectile hits =', hits, '(expect 1)');

// 5. lineOfSight + cover
console.log('LOS through wall =', w.lineOfSight(new THREE.Vector3(0,1,0), new THREE.Vector3(6,1,0), LAYER_STATIC));
const cov = w.evaluateCover(new THREE.Vector3(4,1,0), new THREE.Vector3(-6,1,0), LAYER_STATIC);
console.log('cover behind box =', JSON.stringify(cov && {inCover:cov.inCover, quality:+cov.quality?.toFixed?.(2)}));

// 6. bench
const t0 = performance.now();
for (let i=0;i<40;i++) w.addCapsule(new THREE.Vector3((i%8)-4, 1, Math.floor(i/8)-2), 0.3, 1.0, {tag:'char'});
for (let i=0;i<600;i++) w.step(1/60);
console.log('bench ms/step =', ((performance.now()-t0)/600).toFixed(3));
