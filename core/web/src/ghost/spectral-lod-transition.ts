import * as THREE from "three";

export const SPECTRAL_LOD_TRANSITION_VERSION = "spectral-lod-transition-v1-effects-crossfade" as const;
export const SPECTRAL_LOD_EFFECT_TRANSITION_MS = 140;

const SPECTRAL_COMMON_PASS_NAMES = new Set([
  "spectral-v3-depth-prepass",
  "spectral-v3-main-surface",
]);

export interface SpectralLodTransitionState {
  from: number;
  to: number;
  startedAtMs: number;
  durationMs: number;
}

export interface SpectralLodTransitionSnapshot {
  activeLod: number;
  transitioning: boolean;
  from: number;
  to: number;
  progress: number;
}

function lodGroup(root: THREE.Group, index: number): THREE.Group | undefined {
  const child = root.children[index];
  return child instanceof THREE.Group ? child : undefined;
}

function setCommonPassVisibility(group: THREE.Group, visible: boolean): void {
  group.traverse((object) => {
    if (SPECTRAL_COMMON_PASS_NAMES.has(object.name)) object.visible = visible;
  });
}

function setEffectPassOpacity(group: THREE.Group, factor: number): void {
  const safeFactor = THREE.MathUtils.clamp(factor, 0, 1);
  group.traverse((object) => {
    if (SPECTRAL_COMMON_PASS_NAMES.has(object.name)) return;
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      if (!(material instanceof THREE.ShaderMaterial)) return;
      const composite = material.uniforms.uCompositeAttenuation;
      if (!composite || typeof composite.value !== "number") return;
      const storedBase = material.userData.spectralLodBaseCompositeAttenuation;
      const base = typeof storedBase === "number" ? storedBase : composite.value;
      material.userData.spectralLodBaseCompositeAttenuation = base;
      composite.value = base * safeFactor;
    });
  });
}

function finishTransition(root: THREE.Group, state: SpectralLodTransitionState): void {
  root.children.forEach((child, index) => {
    child.visible = index === state.to;
  });
  const from = lodGroup(root, state.from);
  const to = lodGroup(root, state.to);
  if (from) {
    setCommonPassVisibility(from, true);
    setEffectPassOpacity(from, 1);
  }
  if (to) {
    setCommonPassVisibility(to, true);
    setEffectPassOpacity(to, 1);
  }
  root.userData.activeLod = state.to;
  delete root.userData.spectralLodTransition;
}

function startTransition(
  root: THREE.Group,
  fromIndex: number,
  toIndex: number,
  nowMs: number,
  durationMs: number,
): SpectralLodTransitionState {
  const state: SpectralLodTransitionState = {
    from: fromIndex,
    to: toIndex,
    startedAtMs: nowMs,
    durationMs,
  };
  root.children.forEach((child, index) => {
    child.visible = index === fromIndex || index === toIndex;
  });
  const from = lodGroup(root, fromIndex);
  const to = lodGroup(root, toIndex);
  if (from) {
    // The target depth and dense surface take over immediately. Only the old
    // shell, particles and ground interaction survive for the short fade.
    setCommonPassVisibility(from, false);
    setEffectPassOpacity(from, 1);
  }
  if (to) {
    setCommonPassVisibility(to, true);
    setEffectPassOpacity(to, 0);
  }
  root.userData.activeLod = toIndex;
  root.userData.spectralLodTransition = state;
  return state;
}

export function updateSpectralLodTransition(
  root: THREE.Group,
  requestedLod: number,
  nowMs: number,
  durationMs = SPECTRAL_LOD_EFFECT_TRANSITION_MS,
): SpectralLodTransitionSnapshot {
  const maximum = Math.max(0, root.children.length - 1);
  const requested = THREE.MathUtils.clamp(Math.trunc(requestedLod), 0, maximum);
  const safeNow = Number.isFinite(nowMs) ? nowMs : 0;
  const safeDuration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  let active = THREE.MathUtils.clamp(
    Math.trunc(Number(root.userData.activeLod ?? 0)),
    0,
    maximum,
  );
  let state = root.userData.spectralLodTransition as SpectralLodTransitionState | undefined;

  if (state && state.to !== requested) {
    finishTransition(root, state);
    active = state.to;
    state = undefined;
  }
  if (!state && requested !== active) {
    state = startTransition(root, active, requested, safeNow, safeDuration);
  }
  if (!state) {
    root.userData.activeLod = requested;
    return {
      activeLod: requested,
      transitioning: false,
      from: requested,
      to: requested,
      progress: 1,
    };
  }

  const progress = state.durationMs <= 0
    ? 1
    : THREE.MathUtils.clamp((safeNow - state.startedAtMs) / state.durationMs, 0, 1);
  const from = lodGroup(root, state.from);
  const to = lodGroup(root, state.to);
  if (from) setEffectPassOpacity(from, 1 - progress);
  if (to) setEffectPassOpacity(to, progress);
  if (progress >= 1) {
    finishTransition(root, state);
    return {
      activeLod: state.to,
      transitioning: false,
      from: state.from,
      to: state.to,
      progress: 1,
    };
  }
  return {
    activeLod: state.to,
    transitioning: true,
    from: state.from,
    to: state.to,
    progress,
  };
}
