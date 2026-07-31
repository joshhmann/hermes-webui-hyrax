import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createIkSession,
  solveFabrikPositions,
  solveTwoBonePositions,
} from '../core/ik.js'

function distance(left, right) {
  return Math.hypot(...left.map((value, index) => value - right[index]))
}

test('FABRIK reaches a valid target while preserving segment lengths', () => {
  const input = [
    [0, 1, 0],
    [0, 0.55, 0],
    [0, 0.1, 0.08],
  ]
  const target = [0.2, 0.2, 0.1]
  const output = solveFabrikPositions(input, target, {
    maxIterations: 32,
    toleranceM: 1e-8,
  })
  assert.ok(distance(output.at(-1), target) < 1e-7)
  assert.ok(Math.abs(distance(output[0], output[1]) - distance(input[0], input[1])) < 1e-9)
  assert.ok(Math.abs(distance(output[1], output[2]) - distance(input[1], input[2])) < 1e-9)
  assert.deepEqual(output[0], input[0])
})

test('FABRIK fails closed on degenerate chains', () => {
  assert.throws(
    () => solveFabrikPositions(
      [[0, 0, 0], [0, 0, 0], [0, 1, 0]],
      [0, 0.5, 0],
    ),
    /degenerate segment/,
  )
})

test('two-bone solving preserves a declared knee pole', () => {
  const input = [
    [0, 1, 0],
    [0, 0.5, 0.1],
    [0, 0, 0],
  ]
  const output = solveTwoBonePositions(input, [0.2, 0.1, 0], [0, 0, 1])
  assert.ok(Math.abs(distance(output[0], output[1]) - distance(input[0], input[1])) < 1e-9)
  assert.ok(Math.abs(distance(output[1], output[2]) - distance(input[1], input[2])) < 1e-9)
  assert.ok(output[1][2] > 0)
})

test('temporal foot locks preserve planted XZ and blend out on release', () => {
  const profile = {
    mapping: [
      { semantic: 'hips', target_parent_semantic: null },
      { semantic: 'leftUpperLeg', target_parent_semantic: 'hips' },
      { semantic: 'leftLowerLeg', target_parent_semantic: 'leftUpperLeg' },
      { semantic: 'leftFoot', target_parent_semantic: 'leftLowerLeg' },
    ],
    rest_calibration: {
      per_bone: {
        leftUpperLeg: {
          target_parent_rest_world_quaternion: [0, 0, 0, 1],
        },
        leftFoot: {
          target_rest_world_quaternion: [0, 0, 0, 1],
        },
      },
    },
    ik: {
      enabled: true,
      pelvis_compensation: {
        enabled: true,
        max_lowering_m: 0.2,
      },
      targets: {
        leftFoot: {
          chain: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
          contact_channel: 0,
          contact_threshold: 0.5,
          contact_hysteresis: 0.1,
          ground_y: 0,
          sole_offset_m: 0,
          lock_horizontal: true,
          lock_orientation: true,
          lock_blend_frames: 2,
          pole_world_direction: [0, 0, 1],
          max_iterations: 16,
          tolerance_m: 1e-6,
        },
      },
    },
  }
  const motion = {
    fps: 30,
    foot_contacts: [[1, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
  }
  const pitchedFoot = [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)]
  const makePose = (footX) => ({
    bones: [
      {
        semantic: 'hips',
        world_position: [0, 1.1, 0],
        world_quaternion: [0, 0, 0, 1],
        local_quaternion: [0, 0, 0, 1],
      },
      {
        semantic: 'leftUpperLeg',
        world_position: [0, 1, 0],
        world_quaternion: [0, 0, 0, 1],
        local_quaternion: [0, 0, 0, 1],
      },
      {
        semantic: 'leftLowerLeg',
        world_position: [0, 0.55, 0.1],
        world_quaternion: [0, 0, 0, 1],
        local_quaternion: [0, 0, 0, 1],
      },
      {
        semantic: 'leftFoot',
        world_position: [footX, 0.1, 0],
        world_quaternion: [...pitchedFoot],
        local_quaternion: [...pitchedFoot],
      },
    ],
  })
  const session = createIkSession(profile)
  const acquired = session.apply(makePose(0), motion, 0)
  const planted = session.apply(makePose(0.2), motion, 1)
  const releasing = session.apply(makePose(0.4), motion, 2)
  const released = session.apply(makePose(0.6), motion, 3)

  assert.equal(acquired.ik.leftFoot.lock_weight, 0.5)
  assert(acquired.corrections.pelvis_lowering_m < 0)
  assert(acquired.corrections.pelvis_lowering_m >= -0.2)
  assert(acquired.ik.leftFoot.error_m < 1e-6)
  assert.equal(planted.ik.leftFoot.target_world_position[0], 0)
  assert.equal(planted.ik.leftFoot.lock_weight, 1)
  assert.ok(distance(
    planted.ik.leftFoot.solved_world_quaternion,
    [0, 0, 0, 1],
  ) < 1e-12)
  assert.ok(Math.abs(releasing.ik.leftFoot.target_world_position[0] - 0.2) < 1e-12)
  assert.equal(releasing.ik.leftFoot.lock_weight, 0.5)
  assert.deepEqual(released.ik, {})
})
