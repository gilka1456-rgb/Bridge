import * as THREE from "three";
import type { AvatarPose, BodyBuildOptions, Placement } from "../models/types";
import { buildBodySilhouetteGroup } from "./body-silhouette";
import { updateHolographicMaterials } from "./ghost-shader";
import { prepareAvatarReconstruction } from "./reconstruction-provider";
import { resolveGhostFeatureFlags } from "./feature-flags";
import { prepareSpectralBody } from "./spectral-body-provider";
import {
  GhostQualityController,
  qualityTierLodIndex,
  resolveDistanceLodIndex,
} from "./quality-controller";
import type { GhostRenderPerformanceStats } from "./performance-probe";

export const SPECTRAL_HOVER_AMPLITUDE_METERS = 0.006;
export const SPECTRAL_WORLD_GROUND_Y = -0.895;

export function spectralGroundingOffsetY(bodyMinimumY: number): number {
  if (!Number.isFinite(bodyMinimumY)) return 0;
  // At the lowest point of the hover cycle the sole may touch, but never sink
  // through, the shared world-space projector/mist plane.
  return SPECTRAL_WORLD_GROUND_Y + SPECTRAL_HOVER_AMPLITUDE_METERS - bodyMinimumY;
}

export interface SpectralBodyBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SpectralCameraFit {
  target: [number, number, number];
  position: [number, number, number];
}

export function resolveSpectralCameraFit(
  bounds: SpectralBodyBounds,
  aspect: number,
  fieldOfViewDegrees = 45,
  padding = 1.14,
): SpectralCameraFit {
  const centerX = (bounds.min[0] + bounds.max[0]) * 0.5;
  const centerY = (bounds.min[1] + bounds.max[1]) * 0.5;
  const centerZ = (bounds.min[2] + bounds.max[2]) * 0.5;
  const halfHeight = Math.max(0.05, (bounds.max[1] - bounds.min[1]) * 0.5);
  const halfWidth = Math.max(0.05, (bounds.max[0] - bounds.min[0]) * 0.5);
  const verticalTangent = Math.tan(THREE.MathUtils.degToRad(fieldOfViewDegrees * 0.5));
  const safeAspect = Math.max(0.25, aspect);
  const distance = Math.max(
    halfHeight / Math.max(verticalTangent, 1e-4),
    halfWidth / Math.max(verticalTangent * safeAspect, 1e-4),
  ) * Math.max(1, padding);
  return {
    target: [centerX, centerY, centerZ],
    position: [centerX, centerY, bounds.max[2] + distance],
  };
}

export function sampleSpectralHoverOffset(timeSeconds: number, index: number): number {
  return Math.sin(timeSeconds * 0.8 + index) * SPECTRAL_HOVER_AMPLITUDE_METERS;
}

export function anchoredSpectralGroundLocalY(worldAnchorY: number, groupOffsetY: number): number {
  return worldAnchorY - groupOffsetY;
}

export interface GhostBuildOptions {
  placement?: Partial<Placement>;
  bodyOptions?: BodyBuildOptions;
  rotationY?: number;
}

export function buildGhostGroup(pose: AvatarPose, options?: GhostBuildOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = `ghost-${pose.id}`;

  const search = typeof window === "undefined" ? "" : window.location.search;
  const featureFlags = resolveGhostFeatureFlags(search);
  const query = new URLSearchParams(search);
  const forcedLodValue = query.get("ghost-lod");
  const cpuSkinningRollback = query.get("ghost-skinning") === "cpu";
  const forcedLod = forcedLodValue !== null && ["0", "1", "2"].includes(forcedLodValue)
    ? Number(forcedLodValue) as 0 | 1 | 2
    : undefined;
  const fantasyStyle = pose.style === "wraith" || pose.style === "phantom";
  const cyberStyle = pose.style === "cyber" || pose.style === "quantum";
  group.userData.spectralGroundedMotion = fantasyStyle || cyberStyle;

  const silhouette = buildBodySilhouetteGroup(pose.landmarks, pose.style, {
    ...options?.bodyOptions,
    orientations: pose.orientations,
    avatarId: pose.id,
    reconstruction: pose.reconstruction,
    spectralTintHex: pose.spectralTint,
    spectralBodyV3: options?.bodyOptions?.spectralBodyV3
      ?? (featureFlags.bodyV3 || featureFlags.fantasyV5 || featureFlags.cyberV6),
    spectralRenderV3: options?.bodyOptions?.spectralRenderV3
      ?? (featureFlags.renderV3 || featureFlags.fantasyV5 || featureFlags.cyberV6),
    spectralRuntimeSkinning: options?.bodyOptions?.spectralRuntimeSkinning
      ?? ((featureFlags.renderV3 || featureFlags.fantasyV5 || featureFlags.cyberV6) && !cpuSkinningRollback),
    spectralForcedLod: options?.bodyOptions?.spectralForcedLod ?? forcedLod,
    spectralFantasyV5: options?.bodyOptions?.spectralFantasyV5
      ?? (featureFlags.fantasyV5 && fantasyStyle),
    spectralCyberV6: options?.bodyOptions?.spectralCyberV6
      ?? (featureFlags.cyberV6 && cyberStyle),
  });
  group.add(silhouette);

  if (group.userData.spectralGroundedMotion === true) {
    const bodyBounds = new THREE.Box3();
    silhouette.traverse((child) => {
      if (child.name !== "spectral-v3-main-surface" || !(child instanceof THREE.Mesh)) return;
      child.geometry.computeBoundingBox();
      if (child.geometry.boundingBox) bodyBounds.union(child.geometry.boundingBox);
    });
    group.userData.spectralGroundingOffsetY = spectralGroundingOffsetY(bodyBounds.min.y);
    if (!bodyBounds.isEmpty()) {
      group.userData.spectralBodyBounds = {
        min: bodyBounds.min.toArray(),
        max: bodyBounds.max.toArray(),
      } satisfies SpectralBodyBounds;
    }
  }

  const placement = options?.placement;
  const rotationY = options?.rotationY ?? placement?.rotationY ?? 0;
  group.rotation.y = THREE.MathUtils.degToRad(rotationY);

  if (placement) {
    group.position.set(placement.offsetX ?? 0, 0, placement.offsetZ ?? 0);
  }

  return group;
}

export interface GhostSceneOptions {
  /** 透明背景：用于「看见」相机合成，移除深色背景、雾和地面圆盘 */
  transparentBackground?: boolean;
  /** Deterministic visual-capture time. Undefined keeps the live animation clock. */
  fixedTimeSeconds?: number;
  /** Optional deterministic camera overrides used by visual regression capture. */
  cameraPosition?: [number, number, number];
  cameraTarget?: [number, number, number];
  /** Visual regression can force DPR 1 while the product keeps device DPR. */
  pixelRatio?: number;
  /** Scan preview only: keep variable-height reconstructed bodies fully framed. */
  autoFrameSpectralBody?: boolean;
  /** Live scenes default on; deterministic capture can explicitly keep it off. */
  automaticQualitySwitching?: boolean;
}

export function resolveGhostSceneAutomaticQuality(options: GhostSceneOptions): boolean {
  return options.automaticQualitySwitching ?? (options.fixedTimeSeconds === undefined);
}

export class GhostScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly fixedTimeSeconds?: number;
  private readonly spectralCompositeAttenuation: number;
  private readonly autoFrameSpectralBody: boolean;
  private readonly qualityController: GhostQualityController;
  private readonly lodWorldPosition = new THREE.Vector3();
  private animationId = 0;
  private groups: THREE.Group[] = [];
  private time = 0;
  private dragRotation = false;
  private lastPointerX = 0;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private pointerMoved = false;
  private readonly raycaster = new THREE.Raycaster();
  private poseGeneration = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: GhostSceneOptions = {}) {
    const transparentBackground = options.transparentBackground ?? false;
    this.fixedTimeSeconds = options.fixedTimeSeconds;
    this.spectralCompositeAttenuation = transparentBackground ? 0.68 : 1;
    this.autoFrameSpectralBody = options.autoFrameSpectralBody === true;
    this.qualityController = new GhostQualityController({
      automaticSwitching: resolveGhostSceneAutomaticQuality(options),
    });
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(options.pixelRatio ?? Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.scene = new THREE.Scene();
    this.scene.background = transparentBackground ? null : new THREE.Color(0x020308);
    this.scene.fog = transparentBackground ? null : new THREE.FogExp2(0x020308, 0.08);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.fromArray(options.cameraPosition ?? [0, 1.2, 4.2]);
    this.camera.lookAt(...(options.cameraTarget ?? [0, 0.8, 0]));

    const ambient = new THREE.AmbientLight(0x8ea6ff, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 4, 3);
    const rim = new THREE.DirectionalLight(0x6b8cff, 0.6);
    rim.position.set(-2, 2, -3);
    this.scene.add(ambient, key, rim);

    if (!transparentBackground) {
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(6, 64),
        new THREE.MeshStandardMaterial({ color: 0x10131d, transparent: true, opacity: 0.45 }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.9;
      this.scene.add(floor);
    }

    this.bindDragRotate();
    this.resize();
    this.animate();
  }

  async setPoses(poses: Array<{ pose: AvatarPose; placement?: Partial<Placement>; bodyOptions?: BodyBuildOptions; rotationY?: number }>): Promise<void> {
    const generation = ++this.poseGeneration;
    if (poses.length > 0) {
      const queryFlags = resolveGhostFeatureFlags(typeof window === "undefined" ? "" : window.location.search);
      await Promise.all(poses.map((entry) => {
        const bodyV3 = entry.bodyOptions?.spectralBodyV3 ?? queryFlags.bodyV3;
        const preparation = bodyV3
          ? prepareSpectralBody({
              landmarks: entry.pose.landmarks,
              orientations: entry.pose.orientations,
              reconstruction: entry.pose.reconstruction,
              avatarId: entry.pose.id,
            })
          : prepareAvatarReconstruction(entry.pose);
        return preparation.catch((error) => {
          console.warn(bodyV3
            ? "[Bridge Spectral V3] Unable to prepare continuous body; the renderer will fall back."
            : "[Bridge reconstruction] Unable to prepare visual hull.", error);
        });
      }));
    }
    if (this.disposed || generation !== this.poseGeneration) return;
    this.groups.forEach((group) => {
      this.scene.remove(group);
      disposeObjectResources(group);
    });
    this.groups = poses.map((entry) => {
      const group = buildGhostGroup(entry.pose, {
        placement: entry.placement,
        bodyOptions: {
          ...entry.bodyOptions,
          spectralCompositeAttenuation: entry.bodyOptions?.spectralCompositeAttenuation
            ?? this.spectralCompositeAttenuation,
        },
        rotationY: entry.rotationY,
      });
      this.scene.add(group);
      return group;
    });
    if (this.autoFrameSpectralBody) this.frameSpectralBodies();
  }

  setPreviewRotation(degrees: number): void {
    const radians = THREE.MathUtils.degToRad(degrees);
    this.groups.forEach((group) => {
      group.rotation.y = radians;
    });
  }

  getPerformanceSnapshot(): GhostRenderPerformanceStats {
    const quality = this.qualityController.snapshot();
    let lodIndex = 0;
    this.groups.forEach((group) => {
      group.traverse((child) => {
        if (child.name === "spectral-v4-lods") {
          lodIndex = Math.max(lodIndex, Number(child.userData.activeLod ?? 0));
        }
      });
    });
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      qualityTier: quality.activeTier,
      recommendedTier: quality.recommendedTier,
      lodIndex,
    };
  }

  resize(): void {
    const { clientWidth, clientHeight } = this.canvas;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
    if (this.autoFrameSpectralBody && this.groups.length > 0) this.frameSpectralBodies();
  }

  private frameSpectralBodies(): void {
    const combined = new THREE.Box3();
    let hasBounds = false;
    this.groups.forEach((group) => {
      const stored = group.userData.spectralBodyBounds as SpectralBodyBounds | undefined;
      if (!stored) return;
      const grounding = Number(group.userData.spectralGroundingOffsetY ?? 0);
      const bounds = new THREE.Box3(
        new THREE.Vector3(stored.min[0] + group.position.x, stored.min[1] + grounding, stored.min[2] + group.position.z),
        new THREE.Vector3(stored.max[0] + group.position.x, stored.max[1] + grounding, stored.max[2] + group.position.z),
      );
      combined.union(bounds);
      hasBounds = true;
    });
    if (!hasBounds || combined.isEmpty()) return;
    const fit = resolveSpectralCameraFit({
      min: combined.min.toArray(),
      max: combined.max.toArray(),
    }, this.camera.aspect, this.camera.fov);
    this.camera.position.fromArray(fit.position);
    this.camera.lookAt(...fit.target);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.poseGeneration += 1;
    cancelAnimationFrame(this.animationId);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerUp);
    disposeObjectResources(this.scene);
    this.groups = [];
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private bindDragRotate(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerUp);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.dragRotation = true;
    this.pointerMoved = false;
    this.lastPointerX = event.clientX;
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragRotation) {
      return;
    }
    if (
      Math.abs(event.clientX - this.pointerDownX) > 6 ||
      Math.abs(event.clientY - this.pointerDownY) > 6
    ) {
      this.pointerMoved = true;
    }
    if (this.groups.length === 0) {
      return;
    }
    const delta = event.clientX - this.lastPointerX;
    this.lastPointerX = event.clientX;
    const deltaDeg = delta * 0.6;
    this.canvas.dispatchEvent(new CustomEvent("ghost-rotation", { detail: { deltaDeg } }));
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.dragRotation = false;
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    if (!this.pointerMoved) {
      const index = this.pickGroupIndex(event.clientX, event.clientY);
      if (index >= 0) {
        this.canvas.dispatchEvent(new CustomEvent("ghost-pick", { detail: { index } }));
      }
    }
  };

  private pickGroupIndex(clientX: number, clientY: number): number {
    if (this.groups.length === 0) {
      return -1;
    }
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const intersections = this.raycaster.intersectObjects(this.groups, true);
    if (intersections.length === 0) {
      return -1;
    }
    let node: THREE.Object3D | null = intersections[0].object;
    while (node) {
      const idx = this.groups.indexOf(node as THREE.Group);
      if (idx >= 0) {
        return idx;
      }
      node = node.parent;
    }
    return -1;
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);
    const nowMs = performance.now();
    this.time = this.fixedTimeSeconds ?? nowMs * 0.001;
    const quality = this.qualityController.recordFrame(nowMs);
    this.groups.forEach((group, index) => {
      group.traverse((child) => {
        if (child.name !== "spectral-v4-lods") return;
        const availableLods = Number(child.userData.spectralLodCount ?? child.children.length);
        const forcedLod = child.userData.forcedLod as number | undefined;
        child.getWorldPosition(this.lodWorldPosition);
        const distance = this.camera.position.distanceTo(this.lodWorldPosition);
        const previousDistanceLod = Number(child.userData.distanceLod ?? 0);
        const distanceLod = resolveDistanceLodIndex(distance, previousDistanceLod, availableLods);
        const maximum = Math.max(0, availableLods - 1);
        const activeLod = forcedLod === undefined
          ? Math.min(maximum, Math.max(distanceLod, qualityTierLodIndex(quality.activeTier)))
          : Math.max(0, Math.min(maximum, Math.trunc(forcedLod)));
        child.userData.distanceLod = distanceLod;
        child.userData.activeLod = activeLod;
        child.children.forEach((lodChild, lodIndex) => {
          lodChild.visible = lodIndex === activeLod;
        });
      });
      const groundedMotion = group.userData.spectralGroundedMotion === true;
      const groundingOffset = Number(group.userData.spectralGroundingOffsetY ?? 0);
      group.position.y = groundedMotion
        ? groundingOffset + sampleSpectralHoverOffset(this.time, index)
        : Math.sin(this.time * 0.8 + index) * 0.04;
      if (groundedMotion) {
        group.traverse((child) => {
          const groundAnchorY = child.userData.spectralGroundAnchorY;
          if (typeof groundAnchorY === "number") {
            child.position.y = anchoredSpectralGroundLocalY(groundAnchorY, group.position.y);
          }
        });
      }
      updateHolographicMaterials(group, this.time);
      group.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
          const baseEmissive = child.material.userData.baseEmissive as number | undefined;
          if (baseEmissive !== undefined) {
            const pulse = 0.88 + Math.sin(this.time * 1.8 + index) * 0.12;
            child.material.emissiveIntensity = baseEmissive * pulse;
          }
        }
      });
    });
    this.renderer.render(this.scene, this.camera);
  };
}

function disposeObjectResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      if (!object.geometry.userData.bridgeSharedGeometry) {
        geometries.add(object.geometry);
      }
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => {
    Object.values(material).forEach((value) => {
      if (value instanceof THREE.Texture) {
        value.dispose();
      }
    });
    material.dispose();
  });
}
