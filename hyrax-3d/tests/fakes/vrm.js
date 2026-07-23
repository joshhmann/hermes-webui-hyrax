/**
 * Minimal fake @pixiv/three-vrm module for lifecycle testing.
 * Tracks lifecycle state of VRM instances.
 */

// Re-export the fake Object3D for use in VRM
import { Object3D, Group } from './three.js'

export class VRM {
  constructor() {
    this.scene = new Group()
    this.humanoid = this._createHumanoid()
    this.expressionManager = this._createExpressionManager()
    this.springBoneManager = null
  }

  _createHumanoid() {
    return {
      autoUpdateHumanBones: false,
      getRawBoneNode: () => null,
      getNormalizedBoneNode: () => null,
      update: () => {},
    }
  }

  _createExpressionManager() {
    return {
      setValue: () => {},
    }
  }

  update(dt) {}
}

export class VRMLoaderPlugin {
  constructor(parser) {
    this.parser = parser
  }
}

export const VRMUtils = {
  rotateVRM0: () => {},
  removeUnnecessaryVertices: () => {},
  combineSkeletons: () => {},
}

export class VRMSpringBoneJoint {
  constructor() {
    this.settings = {
      gravityDir: { x: 0, y: -1, z: 0 },
      gravityPower: 0.1,
    }
  }
}
