import * as THREE from "three";
import type { VisualHullMeshData } from "./visual-hull";
import { geometryFromMeshData } from "./visual-hull";

const geometryCache = new Map<string, THREE.BufferGeometry>();

export function getHullGeometry(key: string): THREE.BufferGeometry | undefined {
  return geometryCache.get(key);
}

export function installHullGeometry(key: string, mesh: VisualHullMeshData): THREE.BufferGeometry {
  const existing = geometryCache.get(key);
  if (existing) return existing;
  const geometry = geometryFromMeshData(mesh);
  geometry.userData.bridgeSharedGeometry = true;
  geometryCache.set(key, geometry);
  return geometry;
}

export function setHullGeometry(key: string, geometry: THREE.BufferGeometry): void {
  const previous = geometryCache.get(key);
  if (previous && previous !== geometry) previous.dispose();
  geometry.userData.bridgeSharedGeometry = true;
  geometryCache.set(key, geometry);
}

export function evictHullGeometryByKey(key: string): void {
  geometryCache.get(key)?.dispose();
  geometryCache.delete(key);
}

export function clearHullGeometryCacheStore(): void {
  geometryCache.forEach((geometry) => geometry.dispose());
  geometryCache.clear();
}
