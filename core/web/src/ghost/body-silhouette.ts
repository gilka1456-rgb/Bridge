import * as THREE from "three";
import type { BodyBuildOptions, GhostStyleId, Landmark } from "../models/types";
import { profileScaleAtY } from "../pose/segmentation";
import { createHolographicMaterial } from "./ghost-shader";
import {
  clearHullGeometryCacheStore,
  evictHullGeometryByKey,
  getHullGeometry,
  setHullGeometry,
} from "./hull-cache";
import { GHOST_STYLES } from "./styles";
import { createSpectralRenderGroup } from "./spectral-renderer";
import {
  buildVisualHullGeometry,
  createVisualHullSdfSampler,
  VISUAL_HULL_ALGORITHM_VERSION,
} from "./visual-hull";
import {
  buildTemplateBodyGeometry,
  shrinkWrapToHull,
} from "./template-body";
import { geometryFromGhostLod } from "./anatomical-body";
import {
  buildSpectralBodySynchronously,
  getBakedSpectralBodyLod,
  getPreparedSpectralBody,
  type SpectralBodyInput,
} from "./spectral-body-provider";

const VISIBILITY_MIN = 0.35;

const GHOST_SCALE_X = 2.2;
const GHOST_SCALE_Y = 2.4;
const GHOST_SCALE_Z = 2.2;
const GHOST_FLOOR_OFFSET = -0.1;

const HULL_SCALE_X = GHOST_SCALE_X * 0.45;
const HULL_SCALE_Y = GHOST_SCALE_Y * 0.5;
const HULL_SCALE_Z = GHOST_SCALE_Z * 0.45;

const avatarHullKeys = new Map<string, string>();
const hullSamplerCache = new Map<string, NonNullable<ReturnType<typeof createVisualHullSdfSampler>>>();

export function evictHullGeometry(avatarId: string): void {
  const key = avatarHullKeys.get(avatarId) ?? avatarId;
  evictHullGeometryByKey(key);
  hullSamplerCache.delete(key);
  avatarHullKeys.delete(avatarId);
}

export function clearHullGeometryCache(): void {
  clearHullGeometryCacheStore();
  avatarHullKeys.clear();
  hullSamplerCache.clear();
}

export function landmarkToVector(point: Landmark): THREE.Vector3 {
  return new THREE.Vector3(
    point.x * GHOST_SCALE_X,
    -point.y * GHOST_SCALE_Y + GHOST_FLOOR_OFFSET,
    -point.z * GHOST_SCALE_Z,
  );
}

function getVector(landmarks: Landmark[], index: number): THREE.Vector3 | null {
  const point = landmarks[index];
  if (!point || point.visibility < VISIBILITY_MIN) {
    return null;
  }
  return landmarkToVector(point);
}

function midpoint(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function createBodyMaterial(styleId: GhostStyleId, options?: { brighter?: boolean }): THREE.Material {
  const style = GHOST_STYLES[styleId];
  if (style.holographic) {
    return createHolographicMaterial(styleId);
  }

  const brighter = options?.brighter ?? false;
  const emissiveIntensity = style.emissive * (brighter ? 1.15 : 1);
  const material = new THREE.MeshStandardMaterial({
    color: style.color,
    transparent: true,
    opacity: brighter ? Math.min(style.opacity + 0.12, 0.75) : style.opacity,
    emissive: new THREE.Color(style.color),
    emissiveIntensity,
    metalness: style.metalness,
    roughness: style.roughness,
    // 完整人体始终保留连续表面；赛博感由 shader 扫描线表达，不再露出火柴人网格。
    wireframe: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.userData = { baseEmissive: emissiveIntensity };
  return material;
}

function radiusScale(options: BodyBuildOptions | undefined, landmark: Landmark, fallback: number): number {
  if (!options?.bodyProfile?.length) {
    return fallback;
  }
  const imageY = landmark.y;
  return fallback * profileScaleAtY(options.bodyProfile, imageY, 1);
}

function addCapsuleLimb(
  parent: THREE.Group,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): void {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = Math.max(direction.length() - radius * 2, 0.04);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, 12), material);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  parent.add(mesh);
}

function addTorso(
  parent: THREE.Group,
  leftShoulder: THREE.Vector3,
  rightShoulder: THREE.Vector3,
  leftHip: THREE.Vector3,
  rightHip: THREE.Vector3,
  material: THREE.Material,
  scale = 1,
): void {
  const shoulderCenter = midpoint(leftShoulder, rightShoulder);
  const hipCenter = midpoint(leftHip, rightHip);
  const shoulderWidth = leftShoulder.distanceTo(rightShoulder);
  const hipWidth = leftHip.distanceTo(rightHip);
  const torsoHeight = shoulderCenter.distanceTo(hipCenter);
  const width = Math.max(shoulderWidth, hipWidth) * 0.82 * scale;
  const radius = Math.max(width * 0.5, 0.08);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(
    radius,
    Math.max(torsoHeight - radius * 1.35, 0.04),
    8,
    16,
  ), material);
  mesh.position.copy(shoulderCenter).add(hipCenter).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3().subVectors(shoulderCenter, hipCenter).normalize(),
  );
  mesh.scale.z = 0.62;
  parent.add(mesh);
}

function addJoint(parent: THREE.Group, point: THREE.Vector3, radius: number, material: THREE.Material): void {
  const joint = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), material);
  joint.position.copy(point);
  parent.add(joint);
}

function addHead(
  parent: THREE.Group,
  landmarks: Landmark[],
  material: THREE.Material,
  options?: BodyBuildOptions,
): void {
  const nose = landmarks[0];
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];

  const noseVec = nose ? getVector(landmarks, 0) : null;
  const leftEarVec = leftEar ? getVector(landmarks, 7) : null;
  const rightEarVec = rightEar ? getVector(landmarks, 8) : null;
  const leftShoulderVec = leftShoulder ? getVector(landmarks, 11) : null;
  const rightShoulderVec = rightShoulder ? getVector(landmarks, 12) : null;

  let center: THREE.Vector3 | null = null;
  if (leftEarVec && rightEarVec) {
    center = midpoint(leftEarVec, rightEarVec);
  } else if (noseVec && leftShoulderVec && rightShoulderVec) {
    const shoulderCenter = midpoint(leftShoulderVec, rightShoulderVec);
    center = noseVec.clone().lerp(shoulderCenter, 0.35);
  } else if (noseVec) {
    center = noseVec;
  }

  if (!center) {
    return;
  }

  let radius = 0.11;
  if (leftEarVec && rightEarVec) {
    radius = Math.max(leftEarVec.distanceTo(rightEarVec) * 0.55, 0.08);
  } else if (leftShoulderVec && rightShoulderVec) {
    radius = leftShoulderVec.distanceTo(rightShoulderVec) * 0.22;
  }

  if (nose) {
    radius *= radiusScale(options, nose, 1);
  }

  const head = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 12), material);
  head.position.copy(center);
  parent.add(head);
}

function addLimbChain(
  parent: THREE.Group,
  landmarks: Landmark[],
  indices: [number, number, number],
  radii: [number, number, number],
  material: THREE.Material,
  options?: BodyBuildOptions,
): void {
  const points = indices.map((index) => getVector(landmarks, index));
  if (points.some((point) => !point)) {
    return;
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const landmark = landmarks[indices[index]];
    const baseRadius = (radii[index] + radii[index + 1]) / 2;
    const radius = radiusScale(options, landmark, baseRadius) * 1.35;
    addCapsuleLimb(parent, start, end, radius, material);
    addJoint(parent, start, radius * 1.04, material);
    addJoint(parent, end, radius * 1.04, material);
  }
}

function addSegmentationShell(
  parent: THREE.Group,
  landmarks: Landmark[],
  contour: BodyBuildOptions["silhouetteContour"],
  material: THREE.Material,
): void {
  if (!contour?.length) {
    return;
  }

  const visible = landmarks.filter((point) => point.visibility >= VISIBILITY_MIN);
  if (visible.length < 4) {
    return;
  }

  const ys = visible.map((point) => point.y);
  const xs = visible.map((point) => point.x);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const shape = new THREE.Shape();
  const first = contour[0];
  shape.moveTo(
    (first.x - centerX) * GHOST_SCALE_X * 2.2,
    -(first.y - centerY) * GHOST_SCALE_Y * 2.2 + GHOST_FLOOR_OFFSET,
  );
  for (let index = 1; index < contour.length; index += 1) {
    const point = contour[index];
    shape.lineTo(
      (point.x - centerX) * GHOST_SCALE_X * 2.2,
      -(point.y - centerY) * GHOST_SCALE_Y * 2.2 + GHOST_FLOOR_OFFSET,
    );
  }
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: false,
    curveSegments: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.z = -0.06;
  parent.add(mesh);
}

function buildBodyCore(
  landmarks: Landmark[],
  material: THREE.Material,
  options?: BodyBuildOptions,
): THREE.Group {
  const group = new THREE.Group();

  const leftShoulder = getVector(landmarks, 11);
  const rightShoulder = getVector(landmarks, 12);
  const leftHip = getVector(landmarks, 23);
  const rightHip = getVector(landmarks, 24);

  const torsoScale = landmarks[11] ? profileScaleAtY(options?.bodyProfile, landmarks[11].y, 1) : 1;

  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    addTorso(group, leftShoulder, rightShoulder, leftHip, rightHip, material, torsoScale);
  }

  addHead(group, landmarks, material, options);

  addLimbChain(group, landmarks, [11, 13, 15], [0.048, 0.04, 0.034], material, options);
  addLimbChain(group, landmarks, [12, 14, 16], [0.048, 0.04, 0.034], material, options);
  addLimbChain(group, landmarks, [23, 25, 27], [0.062, 0.05, 0.038], material, options);
  addLimbChain(group, landmarks, [24, 26, 28], [0.062, 0.05, 0.038], material, options);

  return group;
}

function getCachedHullGeometry(options: BodyBuildOptions): THREE.BufferGeometry | null {
  if (!options.avatarId || !options.orientations || options.orientations.length < 2) {
    return null;
  }

  const key = options.reconstruction?.algorithmVersion === VISUAL_HULL_ALGORITHM_VERSION
    ? options.reconstruction.meshKey
    : options.avatarId;
  avatarHullKeys.set(options.avatarId, key);
  const cached = getHullGeometry(key);
  if (cached) {
    return cached;
  }

  const geometry = buildVisualHullGeometry(options.orientations);
  if (geometry) {
    setHullGeometry(key, geometry);
  }
  return geometry;
}

function hasTemplateLandmarks(landmarks: Landmark[]): boolean {
  return [0, 11, 12, 23, 24].every((index) => (
    landmarks[index] && landmarks[index].visibility >= VISIBILITY_MIN
  ));
}

function reconstructionQuality(options: BodyBuildOptions): number {
  if (options.reconstruction?.status === "ready") return options.reconstruction.quality;
  const qualities = options.orientations?.map((orientation) => orientation.quality ?? 0.5) ?? [];
  return qualities.length > 0
    ? qualities.reduce((sum, quality) => sum + quality, 0) / qualities.length
    : 0;
}

function getWorldHullSampler(options: BodyBuildOptions) {
  if (!options.orientations || options.orientations.length < 2) return null;
  const key = options.reconstruction?.algorithmVersion === VISUAL_HULL_ALGORITHM_VERSION
    ? options.reconstruction.meshKey
    : options.avatarId ?? "anonymous";
  let nativeSampler = hullSamplerCache.get(key);
  if (!nativeSampler) {
    nativeSampler = createVisualHullSdfSampler(options.orientations) ?? undefined;
    if (!nativeSampler) return null;
    hullSamplerCache.set(key, nativeSampler);
  }
  const nativePoint = new THREE.Vector3();
  const averageScale = (HULL_SCALE_X + HULL_SCALE_Y + HULL_SCALE_Z) / 3;
  return (point: THREE.Vector3) => {
    nativePoint.set(
      point.x / HULL_SCALE_X,
      (point.y - GHOST_FLOOR_OFFSET) / HULL_SCALE_Y,
      point.z / HULL_SCALE_Z,
    );
    return nativeSampler!(nativePoint) * averageScale;
  };
}

function addLayeredTemplateGeometry(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  styleId: GhostStyleId,
  mode: string,
): void {
  geometry.computeBoundingBox();
  const footY = geometry.boundingBox?.min.y ?? -1.3;
  const style = GHOST_STYLES[styleId];
  const baseMaterial = style.holographic
    ? createHolographicMaterial(styleId, { footY })
    : createBodyMaterial(styleId);
  const base = new THREE.Mesh(geometry, baseMaterial);
  base.name = mode;
  group.add(base);

  ([
    { scale: 1.025, opacityScale: 0.35, name: `${mode}-soft-shell` },
    { scale: 1.06, opacityScale: 0.15, name: `${mode}-haze-shell` },
  ] as const).forEach((layer) => {
    const material = style.holographic
      ? createHolographicMaterial(styleId, {
          outer: true,
          opacityScale: layer.opacityScale,
          footY: footY * layer.scale,
        })
      : new THREE.MeshBasicMaterial({
          color: style.color,
          transparent: true,
          opacity: style.opacity * layer.opacityScale,
          depthWrite: false,
          side: THREE.BackSide,
          blending: THREE.AdditiveBlending,
        });
    const shell = new THREE.Mesh(geometry, material);
    shell.name = layer.name;
    shell.scale.setScalar(layer.scale);
    group.add(shell);
  });
}

function tryAddTemplateBody(
  group: THREE.Group,
  landmarks: Landmark[],
  styleId: GhostStyleId,
  options?: BodyBuildOptions,
): boolean {
  if (!hasTemplateLandmarks(landmarks)) {
    return false;
  }
  const templateLandmarks = options?.reconstruction?.partial
    ? landmarks.map((landmark, index) => (
        index >= 25 && index <= 32 ? { ...landmark, visibility: 0 } : landmark
      ))
    : landmarks;
  let geometry = buildTemplateBodyGeometry(templateLandmarks);
  let mode = "template";
  if (options && reconstructionQuality(options) >= 0.45 && getCachedHullGeometry(options)) {
    const sampler = getWorldHullSampler(options);
    if (sampler) {
      const wrapped = shrinkWrapToHull(geometry, sampler);
      geometry.dispose();
      geometry = wrapped;
      mode = "template-wrapped";
    }
  }
  geometry.userData.templateMode = mode;
  addLayeredTemplateGeometry(group, geometry, styleId, mode);
  return true;
}

function tryAddSpectralBody(
  group: THREE.Group,
  landmarks: Landmark[],
  styleId: GhostStyleId,
  options?: BodyBuildOptions,
): boolean {
  if (!options?.spectralBodyV3) return false;
  const input: SpectralBodyInput = {
    landmarks,
    orientations: options.orientations,
    reconstruction: options.reconstruction,
    avatarId: options.avatarId,
  };
  try {
    const model = getPreparedSpectralBody(input) ?? buildSpectralBodySynchronously(input);
    if (
      model.quality.connectedComponents !== 1
      || model.quality.boundaryEdges !== 0
      || model.quality.degenerateTriangles !== 0
    ) {
      throw new Error(`quality gate rejected ${JSON.stringify(model.quality)}`);
    }
    const lod = options.spectralStandardPose ? model.lods[0] : getBakedSpectralBodyLod(model, input);
    const geometry = geometryFromGhostLod(lod);
    geometry.userData.templateMode = "spectral-v3-anatomical";
    geometry.userData.ghostBodyModelVersion = model.version;
    geometry.userData.ghostBodyQuality = model.quality;
    if (options.spectralRenderV3) {
      group.add(createSpectralRenderGroup(geometry, styleId, {
        compositeAttenuation: options.spectralCompositeAttenuation,
      }));
      return true;
    }
    addLayeredTemplateGeometry(group, geometry, styleId, "spectral-v3-anatomical");
    return true;
  } catch (error) {
    console.warn("[Bridge Spectral V3] Continuous body failed; using the V2 template fallback.", error);
    return false;
  }
}

export function buildBodySilhouetteGroup(
  landmarks: Landmark[],
  styleId: GhostStyleId,
  options?: BodyBuildOptions,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "body-silhouette";

  if (tryAddSpectralBody(group, landmarks, styleId, options)) {
    return group;
  }

  if (tryAddTemplateBody(group, landmarks, styleId, options)) {
    return group;
  }

  const bodyMaterial = createBodyMaterial(styleId);
  group.add(buildBodyCore(landmarks, bodyMaterial, options));

  if (options?.silhouetteContour?.length) {
    const shellMaterial = GHOST_STYLES[styleId].holographic
      ? createHolographicMaterial(styleId)
      : createBodyMaterial(styleId, { brighter: true });
    addSegmentationShell(group, landmarks, options.silhouetteContour, shellMaterial);
  }

  const style = GHOST_STYLES[styleId];
  if (style.rimGlow > 0 && !style.holographic) {
    const glowMaterial = createBodyMaterial(styleId, { brighter: true });
    const glowShell = buildBodyCore(landmarks, glowMaterial, options);
    glowShell.scale.setScalar(1.06);
    group.add(glowShell);
  }

  return group;
}
