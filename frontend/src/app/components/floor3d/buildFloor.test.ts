import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { dimOutsideSpotlight, type ZonePx } from './buildFloor';

// 2D 지도 덮개와 같다: #0f2e4f를 60% 섞는다(sRGB 0~255)
const overlay = ([r, g, b]: number[]) => [r * 0.4 + 15 * 0.6, g * 0.4 + 46 * 0.6, b * 0.4 + 79 * 0.6];
const srgb = (material: THREE.Material) => {
  const c = (material as THREE.MeshStandardMaterial).color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return [c.r * 255, c.g * 255, c.b * 255];
};
const expectColor = (material: THREE.Material, expected: number[]) =>
  srgb(material).forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(1));

const box = (material: THREE.Material | THREE.Material[], readerId?: string) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  if (readerId) mesh.userData.readerId = readerId;
  return mesh;
};
// 평면 위 선분을 따라 세운 두께 thickness의 조각(벽·창·문·걸레받이). 상자 면 순서: +x -x +y -y +z -z
const seg = (material: THREE.Material, a: [number, number], c: [number, number], thickness = 2.4) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, thickness), material);
  mesh.userData.seg = [a, c];
  return mesh;
};
const faces = (mesh: THREE.Mesh) => mesh.material as THREE.Material[];
// 상자의 face번 면만 원래 재질이고 나머지 면은 어둡다
const expectOnlyFaceLit = (mesh: THREE.Mesh, face: number, material: THREE.Material, rgb: number[]) => {
  expect(faces(mesh)).toHaveLength(6);
  faces(mesh).forEach((m, i) => (i === face ? expect(m).toBe(material) : expectColor(m, overlay(rgb))));
};

// 실물 구역 M501: (0,0)~(100,100) 정사각형
const LIT: ZonePx[] = [
  {
    readerId: 'M501',
    name: '중앙수술센터',
    poly: [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
  },
];
const noStructure = new Set<THREE.Material>();

describe('dimOutsideSpotlight', () => {
  it('keeps meshes of spotlit zones as they are', () => {
    const floor = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const side = new THREE.MeshStandardMaterial({ color: 0xf6f5f2 });
    const lit = box([floor, side], 'M501');

    dimOutsideSpotlight(new THREE.Group().add(lit), LIT, noStructure);

    expect(lit.material).toEqual([floor, side]);
    expect((lit.material as THREE.Material[])[0]).toBe(floor);
  });

  it('darkens every other mesh toward the 2D overlay color, including nested ones', () => {
    const wall = new THREE.MeshStandardMaterial({ color: 0xf6f5f2 });
    const zoneFloor = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const otherZone = box([zoneFloor, wall], 'M101');
    const corridor = box(wall);
    const toilet = new THREE.Group().add(box(wall));

    dimOutsideSpotlight(new THREE.Group().add(otherZone, corridor, toilet), LIT, noStructure);

    const [top, sideMat] = otherZone.material as THREE.Material[];
    expectColor(top, overlay([255, 255, 255]));
    expectColor(sideMat, overlay([246, 245, 242]));
    expectColor(corridor.material as THREE.Material, overlay([246, 245, 242]));
    expectColor((toilet.children[0] as THREE.Mesh).material as THREE.Material, overlay([246, 245, 242]));
    expectColor(wall, [246, 245, 242]);
  });

  it('keeps only the face of an enclosing wall that looks into the spotlit zone', () => {
    const wall = new THREE.MeshStandardMaterial({ color: 0xf6f5f2 });
    const WALL = [246, 245, 242];
    // 왼쪽→오른쪽 선분의 +z 면은 평면 아래쪽(구역 안)을 본다
    const top = seg(wall, [0, 0], [100, 0]);
    // 같은 방향이지만 구역 아래 경계라 -z 면이 구역 안을 본다
    const bottom = seg(wall, [0, 100], [100, 100]);
    // 외벽: 두께 6, 중심선이 구역 경계에서 3 떨어져 있다
    const outer = seg(wall, [103, 0], [103, 100], 6);

    dimOutsideSpotlight(new THREE.Group().add(top, bottom, outer), LIT, new Set([wall]));

    expectOnlyFaceLit(top, 4, wall, WALL);
    expectOnlyFaceLit(bottom, 5, wall, WALL);
    expectOnlyFaceLit(outer, 4, wall, WALL);
  });

  it('keeps structure standing inside a spotlit zone and darkens walls that only touch it', () => {
    const wall = new THREE.MeshStandardMaterial({ color: 0xf6f5f2 });
    const inside = seg(wall, [40, 20], [45, 32], 0.8);
    const farWall = seg(wall, [150, 0], [150, 100]);
    const crossing = seg(wall, [100, 50], [160, 50]);

    dimOutsideSpotlight(new THREE.Group().add(inside, farWall, crossing), LIT, new Set([wall]));

    expect(inside.material).toBe(wall);
    expectColor(farWall.material as THREE.Material, overlay([246, 245, 242]));
    expectColor(crossing.material as THREE.Material, overlay([246, 245, 242]));
  });

  it("darkens a neighbor's trim next to the shared wall", () => {
    const wall = new THREE.MeshStandardMaterial({ color: 0xf6f5f2 });
    const skirting = new THREE.MeshStandardMaterial({ color: 0x8fa3b8 });
    const neighborTrim = seg(skirting, [101.7, 0], [101.7, 100]);

    dimOutsideSpotlight(new THREE.Group().add(neighborTrim), LIT, new Set([wall]));

    expectColor(neighborTrim.material as THREE.Material, overlay([0x8f, 0xa3, 0xb8]));
  });

  it('shares one darkened copy per source material and keeps its texture', () => {
    const map = new THREE.Texture();
    const tile = new THREE.MeshStandardMaterial({ color: 0xffffff, map });
    const a = box(tile);
    const b = box(tile);

    dimOutsideSpotlight(new THREE.Group().add(a, b), [], noStructure);

    expect(a.material).toBe(b.material);
    expect(a.material).not.toBe(tile);
    expect((a.material as THREE.MeshStandardMaterial).map).toBe(map);
  });

  it('darkens a mesh-owned material in place so it is disposed with the mesh', () => {
    const own = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const label = box(own);
    label.userData.ownsMaterial = true;

    dimOutsideSpotlight(new THREE.Group().add(label), LIT, noStructure);

    expect(label.material).toBe(own);
    expectColor(own, overlay([255, 255, 255]));
  });
});
