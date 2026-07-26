const loader = new GLTFLoader();
loader.register((p) => new VRMLoaderPlugin(p));
const gltf = await loader.loadAsync('/avatar.vrm');
const vrm = gltf.userData.vrm;
const motion = await (await fetch('/walk.motion.json')).json();
const rt = new SomaVrmRetargeter(vrm, motion, { srcHipsHeight: 0.954 }); // measure per skeleton!

// per render frame (clip mode):
const f = Math.floor(clock.elapsedTime * motion.fps) % motion.root_positions.length;
rt.applyFrame(f);
vrm.update(clock.getDelta());
