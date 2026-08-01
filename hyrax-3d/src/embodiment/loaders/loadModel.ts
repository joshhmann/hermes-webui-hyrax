import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { Object3D, Box3, Vector3 } from "three";

export interface LoadedModel {
  scene: Object3D;
  vrm?: VRM;
}

/**
 * Load a VRM or GLB model from URL with optional abort signal.
 * The caller can abort the request by calling signal.abort().
 */
export async function loadModel(url: string, signal?: AbortSignal): Promise<LoadedModel> {
  const loader = new GLTFLoader();
  loader.register((parser: GLTFParser) => new VRMLoaderPlugin(parser));
  
  const gltf = await loader.loadAsync(url);
  // If aborted during load, signal.throwIfAborted() would have thrown.
  // Check post-load too so late resolutions after abort are discarded.
  if (signal?.aborted) {
    // Dispose the loaded scene data
    gltf.scene.traverse((child) => {
      if (child instanceof Object3D) {
        child.removeFromParent();
      }
    });
    signal.throwIfAborted();
  }

  const vrm = gltf.userData.vrm as VRM | undefined;

  if (vrm) {
    VRMUtils.rotateVRM0(vrm);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    return { scene: gltf.scene, vrm };
  }

  // Standard GLB normalization
  const scene = gltf.scene;
  
  // 1. Center the model at its feet
  const box = new Box3().setFromObject(scene);
  const center = new Vector3();
  box.getCenter(center);
  scene.position.x -= center.x;
  scene.position.z -= center.z;
  scene.position.y -= box.min.y; // Ground the feet at Y=0

  console.log(`[ModelLoader] Standard GLB normalized: ${url}`);
  return { scene };
}
