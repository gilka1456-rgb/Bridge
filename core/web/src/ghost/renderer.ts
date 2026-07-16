import * as THREE from "three";
import type { AvatarPose, BodyBuildOptions, Placement } from "../models/types";
import { buildBodySilhouetteGroup } from "./body-silhouette";
import { updateHolographicMaterials } from "./ghost-shader";

export interface GhostBuildOptions {
  placement?: Partial<Placement>;
  bodyOptions?: BodyBuildOptions;
  rotationY?: number;
}

export function buildGhostGroup(pose: AvatarPose, options?: GhostBuildOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = `ghost-${pose.id}`;

  const silhouette = buildBodySilhouetteGroup(pose.landmarks, pose.style, {
    ...options?.bodyOptions,
    orientations: pose.orientations,
    avatarId: pose.id,
  });
  group.add(silhouette);

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
}

export class GhostScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private animationId = 0;
  private groups: THREE.Group[] = [];
  private time = 0;
  private dragRotation = false;
  private lastPointerX = 0;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private pointerMoved = false;
  private readonly raycaster = new THREE.Raycaster();

  constructor(canvas: HTMLCanvasElement, options: GhostSceneOptions = {}) {
    const transparentBackground = options.transparentBackground ?? false;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = transparentBackground ? null : new THREE.Color(0x020308);
    this.scene.fog = transparentBackground ? null : new THREE.FogExp2(0x020308, 0.08);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 1.2, 4.2);
    this.camera.lookAt(0, 0.8, 0);

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

  setPoses(poses: Array<{ pose: AvatarPose; placement?: Partial<Placement>; bodyOptions?: BodyBuildOptions; rotationY?: number }>): void {
    this.groups.forEach((group) => {
      this.scene.remove(group);
      disposeObjectResources(group);
    });
    this.groups = poses.map((entry) => {
      const group = buildGhostGroup(entry.pose, {
        placement: entry.placement,
        bodyOptions: entry.bodyOptions,
        rotationY: entry.rotationY,
      });
      this.scene.add(group);
      return group;
    });
  }

  setPreviewRotation(degrees: number): void {
    const radians = THREE.MathUtils.degToRad(degrees);
    this.groups.forEach((group) => {
      group.rotation.y = radians;
    });
  }

  resize(): void {
    const { clientWidth, clientHeight } = this.canvas;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
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
    this.time = performance.now() * 0.001;
    this.groups.forEach((group, index) => {
      group.position.y = Math.sin(this.time * 0.8 + index) * 0.04;
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
