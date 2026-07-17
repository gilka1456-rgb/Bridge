import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Landmark, OrientationMask } from "../models/types";
import { encodePersonMaskRLE } from "../pose/segmentation";
import { buildBodySilhouetteGroup } from "./body-silhouette";
import {
  buildTemplateBodyGeometry,
  shrinkWrapToHull,
} from "./template-body";

function standingLandmarks(): Landmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  const set = (index: number, x: number, y: number, z = 0) => {
    landmarks[index] = { x, y, z, visibility: 1 };
  };
  set(0, 0, -0.43, -0.02);
  set(7, -0.045, -0.4, 0);
  set(8, 0.045, -0.4, 0);
  set(11, -0.13, -0.28, 0);
  set(12, 0.13, -0.28, 0);
  set(13, -0.18, -0.04, 0);
  set(14, 0.18, -0.04, 0);
  set(15, -0.19, 0.18, 0);
  set(16, 0.19, 0.18, 0);
  set(23, -0.09, 0.08, 0);
  set(24, 0.09, 0.08, 0);
  set(25, -0.085, 0.3, 0);
  set(26, 0.085, 0.3, 0);
  set(27, -0.08, 0.51, 0);
  set(28, 0.08, 0.51, 0);
  return landmarks;
}

function lowQualityView(azimuth: number): OrientationMask {
  const width = 16;
  const height = 32;
  const mask = new Uint8Array(width * height);
  for (let y = 2; y < 30; y += 1) {
    for (let x = 5; x < 11; x += 1) mask[y * width + x] = 1;
  }
  return {
    azimuth,
    width,
    height,
    mask: encodePersonMaskRLE(mask),
    normalized: true,
    quality: 0.3,
  };
}

describe("template body", () => {
  it("builds a finite low-poly human geometry with plausible proportions", () => {
    const geometry = buildTemplateBodyGeometry(standingLandmarks());
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const size = new THREE.Vector3();
    box.getSize(size);
    const triangleCount = (geometry.index?.count ?? 0) / 3;
    const heightToWidth = size.y / Math.max(size.x, size.z);

    expect([...positions.array].every(Number.isFinite)).toBe(true);
    expect(triangleCount).toBeGreaterThan(100);
    expect(triangleCount).toBeLessThanOrEqual(5_000);
    expect(heightToWidth).toBeGreaterThanOrEqual(2.2);
    expect(heightToWidth).toBeLessThanOrEqual(4.5);
  });

  it("wraps only trusted regions and clamps outward movement to six centimeters", () => {
    const source = buildTemplateBodyGeometry(standingLandmarks());
    const before = source.getAttribute("position") as THREE.BufferAttribute;
    const regions = source.getAttribute("bridgeRegion") as THREE.BufferAttribute;
    const wrapped = shrinkWrapToHull(source, () => 0.2);
    const after = wrapped.getAttribute("position") as THREE.BufferAttribute;
    let movedTrusted = 0;
    for (let index = 0; index < before.count; index += 1) {
      const distance = new THREE.Vector3().fromBufferAttribute(before, index)
        .distanceTo(new THREE.Vector3().fromBufferAttribute(after, index));
      if (regions.getX(index) >= 0.5) {
        if (distance > 1e-5) movedTrusted += 1;
        expect(distance).toBeLessThanOrEqual(0.06001);
      } else {
        expect(distance).toBeLessThan(1e-6);
      }
    }
    expect(movedTrusted).toBeGreaterThan(0);
  });

  it("uses a complete pure template when only two low-quality views exist", () => {
    const group = buildBodySilhouetteGroup(standingLandmarks(), "wraith", {
      avatarId: "low-quality",
      orientations: [lowQualityView(0), lowQualityView(90)],
    });
    const template = group.getObjectByName("template") as THREE.Mesh | undefined;
    const softShell = group.getObjectByName("template-soft-shell") as THREE.Mesh | undefined;
    const hazeShell = group.getObjectByName("template-haze-shell") as THREE.Mesh | undefined;
    expect(template).toBeDefined();
    expect(softShell?.geometry).toBe(template?.geometry);
    expect(hazeShell?.geometry).toBe(template?.geometry);
    expect(softShell?.scale.x).toBeCloseTo(1.025);
    expect(hazeShell?.scale.x).toBeCloseTo(1.06);
    expect((softShell?.material as THREE.Material).blending).toBe(THREE.AdditiveBlending);
    expect((hazeShell?.material as THREE.Material).blending).toBe(THREE.AdditiveBlending);
    template!.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    template!.geometry.boundingBox!.getSize(size);
    expect(size.y).toBeGreaterThan(1.5);
    expect(size.x).toBeGreaterThan(0.4);
  });

  it("rebuilds both lower legs from the current pelvis when a partial scan has no knees or ankles", () => {
    const partial = standingLandmarks();
    for (let index = 25; index <= 32; index += 1) partial[index].visibility = 0;
    for (const index of [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24]) partial[index].x += 0.22;
    const geometry = buildTemplateBodyGeometry(partial);
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    const params = geometry.userData.templateParams as { height: number };
    const hipCenterX = ((partial[23].x + partial[24].x) / 2) * 2.2;
    const lowXs: number[] = [];
    let minimumY = Number.POSITIVE_INFINITY;
    for (let index = 0; index < positions.count; index += 1) {
      minimumY = Math.min(minimumY, positions.getY(index));
    }
    for (let index = 0; index < positions.count; index += 1) {
      if (positions.getY(index) < minimumY + params.height * 0.12) lowXs.push(positions.getX(index));
    }
    expect(Math.min(...lowXs)).toBeLessThan(hipCenterX - 0.04);
    expect(Math.max(...lowXs)).toBeGreaterThan(hipCenterX + 0.04);
    const pelvisWorldY = -partial[23].y * 2.4 - 0.1;
    expect(minimumY).toBeLessThan(pelvisWorldY - 1);
  });
});
