// 3D 지도 실행체: three.js 장면·카메라·후처리·장비 구슬과, 이름표·누르는 영역 DOM. React(FloorMap3D)는 생성·갱신·해제만 맡는다.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  createQualityGovernor,
  placeTagLabels,
  tagColors,
  worldPerPixel,
  type QualityLevel,
} from '../../lib/floor3d/runtime';
import { disposeGeometries, type buildFloorModel, type PlacedEquipment } from './buildFloor';

// 장비 구슬은 2D 지도(FloorMapView) 점과 같은 색·지름(화면 px)을 쓴다(theme.css map-marker-*)
type Status = { className: string; label: string; color: number };
const STATUS: Record<string, Status> = {
  checked_out: { className: 'map-marker-err', label: '대여 중', color: 0xef4444 },
  inactive: { className: 'map-marker-neutral', label: '비활성', color: 0x64748b },
  available: { className: 'map-marker-ok', label: '사용 가능', color: 0x22c55e },
};
const statusOf = (status?: string) => STATUS[status ?? 'available'] ?? STATUS.available;
const DOT_SIZE = 14;
const SPOTLIGHT_DOT_SIZE = 22;
const SPOTLIGHT_RING_SIZE = 40;
const HIT_SIZE = 28;
// 구슬 중심은 바닥에서 반지름의 이 배수만큼 띄우고, 바로 아래 바닥에 반지름의 이 배수만 한 그림자를 깐다
const BALL_LIFT = 1.8;
const SHADOW_SCALE = 1.25;
// 그림자는 바닥에 새긴 구역 이름(0.65) 위에 깐다
const SHADOW_LIFT = 0.2;

// 구슬 아래 그림자: 가장자리로 갈수록 흐려지는 원
function shadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(15,46,79,0.42)');
  gradient.addColorStop(1, 'rgba(15,46,79,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const TAG_STYLE =
  'position:absolute;transform:translate(-50%,-50%);z-index:2;border:1px solid rgba(15,46,79,.25);padding:2px 7px;font-size:11.5px;font-weight:650;line-height:16px;white-space:nowrap;box-shadow:0 1px 3px rgba(15,46,79,.16);pointer-events:none';

type Overlay = {
  dot: HTMLButtonElement;
  tag: HTMLDivElement;
  ball: THREE.Mesh;
  shadow: THREE.Mesh;
  equipment: PlacedEquipment;
};

export class MapEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(28, 1, 5, 9000);
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly ao: GTAOPass;
  private readonly sun: THREE.DirectionalLight;
  private readonly ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.ShadowMaterial({ opacity: 0.12 }),
  );
  private readonly onContextLost: (event: Event) => void;
  private readonly quality = createQualityGovernor();
  private floorGroup: THREE.Group | null = null;
  private marker: THREE.Group | null = null;
  // 장비 구슬과 그림자. geometry·material은 모든 장비가 나눠 쓴다
  private readonly balls = new THREE.Group();
  private readonly ballGeometry = new THREE.SphereGeometry(1, 32, 16);
  private readonly ballMaterials = new Map(
    Object.values(STATUS).map((s) => [s, new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.35 })]),
  );
  private readonly shadowGeometry = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
  private readonly shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture(),
    transparent: true,
    depthWrite: false,
  });
  private fitPoints: THREE.Vector3[] = [];
  private overlays: Overlay[] = [];
  private focusTagId: string | null = null;
  private showLabels = true;
  private frame = 0;
  private lastFrameAt = 0;
  private continuous = false;

  constructor(
    private readonly host: HTMLDivElement,
    private readonly layer: HTMLDivElement,
    private readonly lead: SVGSVGElement,
    private readonly onPick: (tagId: string) => void,
    onLost: () => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.onContextLost = (event: Event) => {
      event.preventDefault();
      onLost();
    };
    try {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.domElement.style.display = 'block';
      this.host.prepend(this.renderer.domElement);
      this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);

      this.scene.environment = new THREE.PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dee3, 0.45));
      this.sun = new THREE.DirectionalLight(0xfff4e6, 2.7);
      this.sun.position.set(-430, 640, -220);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      Object.assign(this.sun.shadow.camera, { left: -650, right: 650, top: 650, bottom: -650, near: 10, far: 3000 });
      this.sun.shadow.bias = -0.0003;
      this.sun.shadow.normalBias = 0.4;
      this.scene.add(this.sun);
      const ground = this.ground;
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -8.1;
      ground.receiveShadow = true;
      this.scene.add(ground);
      this.scene.add(this.balls);

      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      Object.assign(this.controls, {
        enableDamping: true,
        dampingFactor: 0.12,
        maxPolarAngle: Math.PI * 0.46,
        minDistance: 120,
        maxDistance: 4500,
        screenSpacePanning: true,
      });
      this.controls.addEventListener('change', () => this.requestRender());

      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.ao = new GTAOPass(this.scene, this.camera, 800, 600);
      this.ao.updateGtaoMaterial({ radius: 12, distanceExponent: 2, thickness: 4, scale: 1.6, samples: 16 });
      this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 8, rings: 2, samples: 16 });
      this.composer.addPass(this.ao);
      this.composer.addPass(new OutputPass());
    } catch (error) {
      // 렌더러를 만든 뒤 실패하면(일부 GPU의 텍스처·확장 미지원) 컨텍스트와 캔버스를 바로 놓는다
      this.releaseRenderer();
      throw error;
    }
  }

  resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  // fitView: 새 층이면 층 전체가 보이게 시점을 다시 맞춘다
  setFloor(floorModel: ReturnType<typeof buildFloorModel>, fitView: boolean) {
    if (this.floorGroup) {
      this.scene.remove(this.floorGroup);
      disposeGeometries(this.floorGroup);
    }
    this.floorGroup = floorModel.group;
    this.scene.add(this.floorGroup);
    this.fitPoints = floorModel.fitPoints;
    if (fitView) this.resetView();
    else this.requestRender();
  }

  setEquipment(placed: PlacedEquipment[]) {
    for (const o of this.overlays) {
      o.dot.remove();
      o.tag.remove();
    }
    this.balls.clear();
    this.overlays = placed.map((e) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.dataset.testid = `floor-map-3d-dot-${e.tag_id}`;
      dot.title = `${e.label} · ${statusOf(e.assetStatus).label}`;
      dot.setAttribute('aria-label', dot.title);
      dot.addEventListener('click', () => this.onPick(e.tag_id));
      const tag = document.createElement('div');
      tag.dataset.testid = `floor-map-3d-tag-${e.tag_id}`;
      this.layer.append(dot, tag);
      const ball = new THREE.Mesh(this.ballGeometry, this.ballMaterials.get(statusOf(e.assetStatus)));
      ball.position.copy(e.position);
      const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
      shadow.position.copy(e.position).setY(e.position.y + SHADOW_LIFT);
      this.balls.add(ball, shadow);
      const o = { dot, tag, ball, shadow, equipment: e };
      this.styleOverlay(o);
      return o;
    });
    this.requestRender();
  }

  // 목록에서 고른 장비, 또는 지도에서 누른 장비: 구슬은 2D 점처럼 키우고 흰 테두리와 고리를 띄우며, 이름표는 남색에 상태를 붙인다
  setFocus(tagId: string | null) {
    this.focusTagId = tagId;
    for (const o of this.overlays) this.styleOverlay(o);
    this.requestRender();
  }

  setHighlight(position: THREE.Vector3 | null) {
    if (this.marker) {
      this.scene.remove(this.marker);
      disposeGeometries(this.marker);
      this.marker = null;
    }
    if (position) {
      const color = 0x0d9488;
      this.marker = new THREE.Group();
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(14, 48),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }),
      );
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(13, 15.5, 64),
        new THREE.MeshBasicMaterial({ color, depthWrite: false }),
      );
      for (const m of [disc, rim]) {
        m.rotation.x = -Math.PI / 2;
        this.marker.add(m);
      }
      this.marker.position.copy(position);
      this.scene.add(this.marker);
    }
    this.requestRender();
  }

  // 장비 이름표만 켜고 끈다. 바닥에 새긴 구역 이름은 늘 보인다
  setLabelsVisible(visible: boolean) {
    this.showLabels = visible;
    this.requestRender();
  }

  // 남서쪽 위에서 층 외곽이 화면 가로 80%·세로 72%를 채우도록
  private resetView() {
    if (!this.fitPoints.length) return;
    const dir = new THREE.Vector3(-0.5, 0.92, 0.78).normalize();
    const target = new THREE.Box3().setFromPoints(this.fitPoints).getCenter(new THREE.Vector3()).setY(0);
    let distance = 1600;
    for (let i = 0; i < 8; i++) {
      this.camera.position.copy(target).addScaledVector(dir, distance);
      this.camera.lookAt(target);
      this.camera.updateMatrixWorld();
      this.camera.updateProjectionMatrix();
      const ndc = [9, -9, 9, -9];
      for (const p of this.fitPoints) {
        const v = p.clone().project(this.camera);
        ndc[0] = Math.min(ndc[0], v.x);
        ndc[1] = Math.max(ndc[1], v.x);
        ndc[2] = Math.min(ndc[2], v.y);
        ndc[3] = Math.max(ndc[3], v.y);
      }
      const halfH = distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      target
        .addScaledVector(right, ((ndc[0] + ndc[1]) / 2) * halfH * this.camera.aspect)
        .addScaledVector(up, ((ndc[2] + ndc[3]) / 2) * halfH);
      distance *= Math.max((ndc[1] - ndc[0]) / 1.6, (ndc[3] - ndc[2]) / 1.44);
    }
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.controls.target.copy(target);
    this.controls.update();
    this.requestRender();
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    for (const g of [this.floorGroup, this.marker]) if (g) disposeGeometries(g);
    for (const o of this.overlays) {
      o.dot.remove();
      o.tag.remove();
    }
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.ballGeometry.dispose();
    for (const m of this.ballMaterials.values()) m.dispose();
    this.shadowGeometry.dispose();
    this.shadowMaterial.map?.dispose();
    this.shadowMaterial.dispose();
    this.scene.environment?.dispose();
    this.ao.dispose();
    this.composer.dispose();
    this.releaseRenderer();
  }

  // 컨텍스트를 바로 놓아 브라우저의 동시 컨텍스트 한도에 남지 않게 한다. 일부러 놓는 것이므로 소실 알림은 먼저 뗀다
  private releaseRenderer() {
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private readonly tick = (now: number) => {
    this.frame = 0;
    const moving = this.controls.update();
    // 연속으로 그리는 동안의 프레임 간격으로 품질을 조절한다
    if (this.continuous && this.lastFrameAt) {
      const next = this.quality.record(now - this.lastFrameAt);
      if (next !== null) this.applyQuality(next);
    }
    this.camera.updateMatrixWorld();
    this.updateBalls();
    this.composer.render();
    this.updateOverlays();
    this.continuous = moving;
    this.lastFrameAt = now;
    if (moving) this.requestRender();
  };

  private applyQuality(level: QualityLevel) {
    if (level >= 1) this.ao.enabled = false;
    if (level >= 2) {
      this.sun.castShadow = false;
      this.renderer.shadowMap.enabled = false;
      this.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) for (const m of [mesh.material].flat()) m.needsUpdate = true;
      });
    }
    if (level >= 3) {
      this.renderer.setPixelRatio(1);
      this.composer.setPixelRatio(1);
    }
  }

  // 구슬은 장면에 그리고, 이 단추는 구슬 위의 보이지 않는 누르는 영역이다. 고른 장비만 2D처럼 흰 테두리와 퍼지는 고리를 덧그린다
  private styleOverlay({ dot, tag, equipment: e }: Overlay) {
    const focused = e.tag_id === this.focusTagId;
    const status = statusOf(e.assetStatus);
    dot.style.cssText = `position:absolute;transform:translate(-50%,-50%);z-index:${focused ? 3 : 1};display:flex;align-items:center;justify-content:center;width:${HIT_SIZE}px;height:${HIT_SIZE}px;padding:0;border:0;background:none;cursor:pointer;pointer-events:auto`;
    if (focused) {
      const ring = document.createElement('span');
      ring.className = `pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full opacity-70 ${status.className}`;
      ring.style.cssText = `width:${SPOTLIGHT_RING_SIZE}px;height:${SPOTLIGHT_RING_SIZE}px`;
      const rim = document.createElement('span');
      rim.className = 'relative block rounded-full map-marker-spotlight';
      rim.style.cssText = `width:${SPOTLIGHT_DOT_SIZE}px;height:${SPOTLIGHT_DOT_SIZE}px`;
      dot.replaceChildren(ring, rim);
    } else dot.replaceChildren();
    tag.style.cssText = TAG_STYLE;
    Object.assign(tag.style, tagColors(e.assetStatus, focused));
    if (focused) tag.style.zIndex = '4';
    tag.textContent = focused ? `${e.label} · ${status.label}` : e.label;
  }

  // 구슬과 그림자를 카메라 깊이에 맞춰 키워, 확대와 관계없이 화면에서 같은 지름으로 보이게 한다
  private updateBalls() {
    const h = this.host.clientHeight;
    if (!h) return;
    for (const o of this.overlays) {
      const size = o.equipment.tag_id === this.focusTagId ? SPOTLIGHT_DOT_SIZE : DOT_SIZE;
      const depth = -o.equipment.position.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
      const r = (size / 2) * worldPerPixel(Math.max(depth, 1), this.camera.fov, h);
      o.ball.scale.setScalar(r);
      o.ball.position.y = o.equipment.position.y + r * BALL_LIFT;
      o.shadow.scale.setScalar(r * SHADOW_SCALE);
    }
  }

  // 누르는 영역과 이름표를 구슬 중심에 맞추고, 이름표는 구슬 바로 위에 붙인다(겹치면 비키고 구슬까지 가는 선을 긋는다)
  private updateOverlays() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const shown: { o: Overlay; x: number; y: number }[] = [];
    for (const o of this.overlays) {
      const p = o.ball.position.clone().project(this.camera);
      const [x, y] = [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h];
      // 확대해 화면 밖으로 나간 장비는 누르는 영역도 숨긴다
      const onScreen = p.z < 1 && x >= 0 && x <= w && y >= 0 && y <= h;
      o.dot.style.display = onScreen ? 'flex' : 'none';
      o.dot.style.left = `${x}px`;
      o.dot.style.top = `${y}px`;
      const labelled = onScreen && (this.showLabels || o.equipment.tag_id === this.focusTagId);
      o.tag.style.display = labelled ? 'block' : 'none';
      if (labelled) shown.push({ o, x, y });
    }
    // 고른 장비의 이름표가 먼저 자리를 잡는다
    shown.sort(
      (a, b) => Number(b.o.equipment.tag_id === this.focusTagId) - Number(a.o.equipment.tag_id === this.focusTagId),
    );
    const spots = placeTagLabels(
      shown.map(({ o, x, y }) => ({ id: o.equipment.tag_id, x, y, w: o.tag.offsetWidth, h: o.tag.offsetHeight })),
      { left: 4, top: 4, right: w - 4, bottom: h - 4 },
    );
    let leads = '';
    for (const { o, x, y } of shown) {
      const spot = spots.get(o.equipment.tag_id)!;
      o.tag.style.left = `${spot.x}px`;
      o.tag.style.top = `${spot.y}px`;
      if (spot.moved)
        leads += `<path d="M${x} ${y} L${spot.x} ${spot.y}" stroke="#46607a" stroke-width="1" fill="none"/>`;
    }
    this.lead.innerHTML = leads;
  }
}
