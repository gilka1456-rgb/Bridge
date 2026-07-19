import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  SPECTRAL_LOD_EFFECT_TRANSITION_MS,
  updateSpectralLodTransition,
} from "./spectral-lod-transition";

function shaderMaterial(base: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uCompositeAttenuation: { value: base } },
  });
}

function makeLod(index: number, base = 0.68): THREE.Group {
  const group = new THREE.Group();
  group.name = `spectral-v4-lod-${index}`;
  const depth = new THREE.Mesh(new THREE.BufferGeometry(), shaderMaterial(base));
  depth.name = "spectral-v3-depth-prepass";
  const surface = new THREE.Mesh(new THREE.BufferGeometry(), shaderMaterial(base));
  surface.name = "spectral-v3-main-surface";
  const shell = new THREE.Mesh(new THREE.BufferGeometry(), shaderMaterial(base));
  shell.name = "spectral-v3-additive-back-shell";
  group.add(depth, surface, shell);
  return group;
}

function effectOpacity(group: THREE.Group): number {
  const shell = group.getObjectByName("spectral-v3-additive-back-shell") as THREE.Mesh;
  return (shell.material as THREE.ShaderMaterial).uniforms.uCompositeAttenuation.value;
}

describe("spectral LOD effect transition", () => {
  it("hands depth and the dense surface to the target immediately while effects crossfade", () => {
    const root = new THREE.Group();
    root.userData.activeLod = 0;
    root.add(makeLod(0), makeLod(1), makeLod(2));
    root.children.forEach((child, index) => { child.visible = index === 0; });

    const start = updateSpectralLodTransition(root, 1, 1_000);
    expect(start).toMatchObject({ activeLod: 1, transitioning: true, from: 0, to: 1, progress: 0 });
    expect(root.children.map((child) => child.visible)).toEqual([true, true, false]);
    expect(root.children[0].getObjectByName("spectral-v3-depth-prepass")?.visible).toBe(false);
    expect(root.children[0].getObjectByName("spectral-v3-main-surface")?.visible).toBe(false);
    expect(root.children[1].getObjectByName("spectral-v3-depth-prepass")?.visible).toBe(true);
    expect(effectOpacity(root.children[0] as THREE.Group)).toBeCloseTo(0.68);
    expect(effectOpacity(root.children[1] as THREE.Group)).toBe(0);

    const middle = updateSpectralLodTransition(
      root,
      1,
      1_000 + SPECTRAL_LOD_EFFECT_TRANSITION_MS / 2,
    );
    expect(middle.progress).toBeCloseTo(0.5);
    expect(effectOpacity(root.children[0] as THREE.Group)).toBeCloseTo(0.34);
    expect(effectOpacity(root.children[1] as THREE.Group)).toBeCloseTo(0.34);

    const complete = updateSpectralLodTransition(
      root,
      1,
      1_000 + SPECTRAL_LOD_EFFECT_TRANSITION_MS,
    );
    expect(complete.transitioning).toBe(false);
    expect(root.children.map((child) => child.visible)).toEqual([false, true, false]);
    expect(root.children[0].getObjectByName("spectral-v3-depth-prepass")?.visible).toBe(true);
    expect(effectOpacity(root.children[0] as THREE.Group)).toBeCloseTo(0.68);
    expect(effectOpacity(root.children[1] as THREE.Group)).toBeCloseTo(0.68);
  });

  it("retargets a transition without leaving stale passes visible", () => {
    const root = new THREE.Group();
    root.userData.activeLod = 0;
    root.add(makeLod(0, 1), makeLod(1, 1), makeLod(2, 1));
    root.children.forEach((child, index) => { child.visible = index === 0; });

    updateSpectralLodTransition(root, 1, 0);
    const retargeted = updateSpectralLodTransition(root, 2, 40);
    expect(retargeted).toMatchObject({ activeLod: 2, transitioning: true, from: 1, to: 2 });
    expect(root.children.map((child) => child.visible)).toEqual([false, true, true]);
    expect(root.children[0].getObjectByName("spectral-v3-depth-prepass")?.visible).toBe(true);
    expect(root.children[1].getObjectByName("spectral-v3-depth-prepass")?.visible).toBe(false);

    updateSpectralLodTransition(root, 2, 180);
    expect(root.children.map((child) => child.visible)).toEqual([false, false, true]);
    expect(effectOpacity(root.children[1] as THREE.Group)).toBe(1);
    expect(effectOpacity(root.children[2] as THREE.Group)).toBe(1);
  });
});
