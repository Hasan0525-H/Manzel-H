import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Column, Opening, Room, Stair, Wall } from "./types";

type Props = {
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  columns: Column[];
  stairs: Stair[];
  exteriorWallIds: string[];
  imageSize: { w: number; h: number };
  metersPerPixel: number | null;
  wallHeight: number;
  wallThicknessM: number;
  style: string;
  mode: "white" | "real";
  showExports?: boolean;
  modelUrl?: string;
};

type PatternKind = "stucco" | "stone" | "wood" | "tile" | "site" | "drive" | "grass";

function makePatternTexture(
  kind: PatternKind,
  renderer: THREE.WebGLRenderer,
  mobile: boolean,
): THREE.CanvasTexture {
  const size = mobile ? 256 : 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  const fill = (value: number) => {
    const v = Math.max(0, Math.min(255, Math.round(value)));
    ctx.fillStyle = `rgb(${v},${v},${v})`;
  };

  fill(242);
  ctx.fillRect(0, 0, size, size);

  if (kind === "stucco") {
    for (let i = 0; i < size * 5; i++) {
      const v = 220 + Math.random() * 35;
      fill(v);
      const s = Math.random() < 0.92 ? 1 : 2;
      ctx.globalAlpha = 0.22 + Math.random() * 0.18;
      ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
    }
  } else if (kind === "stone") {
    const h = Math.max(22, Math.floor(size / 11));
    const w = Math.max(54, Math.floor(size / 5));
    ctx.lineWidth = Math.max(2, Math.floor(size / 160));
    ctx.strokeStyle = "rgb(175,175,175)";
    for (let row = 0; row < Math.ceil(size / h) + 1; row++) {
      const offset = row % 2 ? -w / 2 : 0;
      for (let x = offset; x < size; x += w) {
        const shade = 208 + ((row + Math.floor(x / w)) % 4) * 7;
        fill(shade);
        ctx.fillRect(x + 1, row * h + 1, w - 2, h - 2);
        ctx.strokeRect(x, row * h, w, h);
      }
    }
  } else if (kind === "wood") {
    fill(215);
    ctx.fillRect(0, 0, size, size);
    for (let x = 0; x < size; x += 5) {
      const shade = 180 + Math.sin(x * 0.13) * 18 + Math.random() * 10;
      fill(shade);
      ctx.globalAlpha = 0.28;
      ctx.fillRect(x, 0, 1 + (x % 3), size);
    }
    for (let i = 0; i < 25; i++) {
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = "rgb(95,95,95)";
      ctx.beginPath();
      ctx.ellipse(
        Math.random() * size,
        Math.random() * size,
        10 + Math.random() * 24,
        2 + Math.random() * 4,
        Math.random() * Math.PI,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
  } else if (kind === "tile") {
    fill(234);
    ctx.fillRect(0, 0, size, size);
    const cell = Math.max(48, Math.floor(size / 5));
    ctx.strokeStyle = "rgb(188,188,188)";
    ctx.lineWidth = Math.max(2, Math.floor(size / 180));
    for (let x = 0; x <= size; x += cell) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }
    for (let y = 0; y <= size; y += cell) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  } else {
    const base = kind === "grass" ? 176 : kind === "drive" ? 168 : 220;
    fill(base);
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < size * 4; i++) {
      const spread = kind === "grass" ? 50 : 24;
      fill(base - spread / 2 + Math.random() * spread);
      ctx.globalAlpha = kind === "grass" ? 0.35 : 0.2;
      const s = kind === "grass" ? 2 : 1;
      ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
    }
  }

  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  const repeat =
    kind === "stone" ? 2.4 :
    kind === "wood" ? 2.2 :
    kind === "tile" ? 4 :
    kind === "grass" ? 8 :
    kind === "drive" ? 7 :
    kind === "site" ? 5 :
    3.5;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), mobile ? 2 : 8);
  texture.needsUpdate = true;
  return texture;
}

function enhancedRemoteMaterial(
  original: THREE.Material,
  renderer: THREE.WebGLRenderer,
  mobile: boolean,
  cache: Map<string, THREE.Texture>,
): THREE.Material {
  const source = original as THREE.MeshStandardMaterial;
  const name = (original.name || "").toLowerCase();
  const color = source.color?.clone() ?? new THREE.Color(0xffffff);

  if (name.includes("glass")) {
    return new THREE.MeshPhysicalMaterial({
      name: original.name,
      color,
      roughness: 0.08,
      metalness: 0.03,
      transparent: true,
      opacity: 0.54,
      transmission: mobile ? 0.05 : 0.16,
      thickness: 0.04,
      envMapIntensity: 1.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  let kind: PatternKind = "stucco";
  if (name.includes("stone")) kind = "stone";
  else if (name.includes("wood") || name.includes("metal")) kind = "wood";
  else if (name.includes("tile")) kind = "tile";
  else if (name.includes("grass")) kind = "grass";
  else if (name.includes("drive")) kind = "drive";
  else if (name.includes("site")) kind = "site";

  let map = cache.get(kind);
  if (!map) {
    map = makePatternTexture(kind, renderer, mobile);
    cache.set(kind, map);
  }

  const material = new THREE.MeshStandardMaterial({
    name: original.name,
    color,
    map,
    roughness:
      kind === "wood" ? 0.54 :
      kind === "tile" ? 0.66 :
      kind === "stucco" ? 0.88 :
      0.92,
    metalness: kind === "wood" ? 0.05 : 0,
    envMapIntensity: kind === "stucco" ? 0.72 : 0.9,
  });
  return material;
}

export default function ThreeScene(props: Props) {
  const mount = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  const exportPng = () => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
    const a = document.createElement("a");
    a.href = renderer.domElement.toDataURL("image/png", 0.95);
    a.download = "manzel-h.png";
    a.click();
  };

  const exportGlb = async () => {
    if (!rootRef.current) return;
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    new GLTFExporter().parse(
      rootRef.current,
      (result) => {
        if (!(result instanceof ArrayBuffer)) return;
        const blob = new Blob([result], { type: "model/gltf-binary" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "manzel-h.glb";
        a.click();
        URL.revokeObjectURL(a.href);
      },
      console.error,
      { binary: true, onlyVisible: true },
    );
  };

  useEffect(() => {
    if (!mount.current) return;

    const host = mount.current;
    const real = props.mode === "real";
    const useRemote = real && !!props.modelUrl;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 900;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(real ? 0xdce3e6 : 0xeeeeec);
    scene.fog = real ? new THREE.Fog(0xdce3e6, 55, 160) : new THREE.Fog(0xeeeeec, 45, 130);

    const camera = new THREE.PerspectiveCamera(
      mobile ? 48 : 43,
      host.clientWidth / Math.max(host.clientHeight, 1),
      0.08,
      500,
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: !mobile,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1.2 : 1.65));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = real ? 1.06 : 1.0;
    renderer.shadowMap.enabled = real;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.touchAction = "none";
    rendererRef.current = renderer;
    host.replaceChildren(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, real ? 0x7a7469 : 0xbdbdbd, real ? 1.7 : 2.4);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff4de, real ? 3.8 : 1.7);
    sun.position.set(16, 26, 12);
    sun.castShadow = real;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0xc8def4, real ? 0.75 : 0.25);
    fill.position.set(-12, 10, -14);
    scene.add(fill);

    let controls: import("three/examples/jsm/controls/OrbitControls.js").OrbitControls | null = null;
    let environmentTexture: THREE.Texture | null = null;
    let disposed = false;
    const textureCache = new Map<string, THREE.Texture>();

    Promise.all([
      import("three/examples/jsm/controls/OrbitControls.js"),
      import("three/examples/jsm/environments/RoomEnvironment.js"),
    ]).then(([{ OrbitControls }, { RoomEnvironment }]) => {
      if (disposed) return;

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = mobile ? 0.085 : 0.075;
      controls.rotateSpeed = mobile ? 0.48 : 0.56;
      controls.zoomSpeed = 0.74;
      controls.panSpeed = 0.55;
      controls.screenSpacePanning = false;
      controls.minPolarAngle = 0.16;
      controls.maxPolarAngle = Math.PI / 2 - 0.025;
      controls.minDistance = 3.5;
      controls.maxDistance = 125;

      if (real) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        const envScene = new RoomEnvironment();
        environmentTexture = pmrem.fromScene(envScene, 0.04).texture;
        scene.environment = environmentTexture;
        envScene.dispose();
        pmrem.dispose();
      }
    });

    const scale = props.metersPerPixel ?? 0.02;
    const cx = props.imageSize.w * scale / 2;
    const cy = props.imageSize.h * scale / 2;
    const planW = Math.max(8, props.imageSize.w * scale);
    const planH = Math.max(8, props.imageSize.h * scale);

    const group = new THREE.Group();
    group.visible = !useRemote;
    rootRef.current = group;

    const palette: Record<string, { wall: number; accent: number; floor: number; stone: number }> = {
      "سعودي حديث": { wall: 0xeadfce, accent: 0x5e4634, floor: 0xd7c7b2, stone: 0xb59b7b },
      "نجدي حديث": { wall: 0xcba77e, accent: 0x65452f, floor: 0xbe9d78, stone: 0x9b7655 },
      "حجازي حديث": { wall: 0xead2ad, accent: 0x315e73, floor: 0xd7bc95, stone: 0xb18c65 },
      "Minimal": { wall: 0xf2eee8, accent: 0x5e5952, floor: 0xd8d0c7, stone: 0xbeb5aa },
    };
    const colors = palette[props.style] ?? palette["سعودي حديث"];

    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    const wallMat = real ? new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.82 }) : whiteMat;
    const accentMat = real ? new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.58 }) : whiteMat;
    const stoneMat = real ? new THREE.MeshStandardMaterial({ color: colors.stone, roughness: 0.94 }) : whiteMat;
    const floorMat = real ? new THREE.MeshStandardMaterial({ color: colors.floor, roughness: 0.78 }) : whiteMat;
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: real ? 0x4f8295 : 0xe9eef1,
      roughness: real ? 0.1 : 0.42,
      transparent: true,
      opacity: real ? 0.52 : 0.82,
      transmission: real && !mobile ? 0.12 : 0,
      depthWrite: false,
    });

    const addBox = (
      length: number,
      height: number,
      depth: number,
      x: number,
      y: number,
      z: number,
      angle: number,
      material: THREE.Material,
      parent: THREE.Group = group,
    ) => {
      if (length <= 0.02 || height <= 0.02 || depth <= 0.01) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, depth), material);
      mesh.position.set(x, y, z);
      mesh.rotation.y = angle;
      mesh.castShadow = real && !mobile;
      mesh.receiveShadow = real;
      parent.add(mesh);
    };

    for (const wall of props.walls) {
      const ax = wall.a.x * scale - cx;
      const az = wall.a.y * scale - cy;
      const bx = wall.b.x * scale - cx;
      const bz = wall.b.y * scale - cy;
      const dx = bx - ax;
      const dz = bz - az;
      const length = Math.hypot(dx, dz);
      if (length < 0.05) continue;
      const angle = -Math.atan2(dz, dx);
      const thickness = props.metersPerPixel ? Math.max(0.08, wall.thickness * scale) : props.wallThicknessM;
      const ux = dx / length;
      const uz = dz / length;
      const list = props.openings.filter((o) => o.wallId === wall.id).sort((a, b) => a.centerT - b.centerT);
      let cursor = 0;

      for (const opening of list) {
        const center = opening.centerT * length;
        const start = Math.max(cursor, center - opening.widthM / 2);
        const end = Math.min(length, center + opening.widthM / 2);

        if (start > cursor) {
          const segment = start - cursor;
          const mid = cursor + segment / 2;
          addBox(segment, props.wallHeight, thickness, ax + ux * mid, props.wallHeight / 2, az + uz * mid, angle, wallMat);
        }

        const width = Math.max(0.05, end - start);
        const sill = Math.max(0, opening.sillM);
        const top = Math.min(props.wallHeight, sill + opening.heightM);
        const mid = start + width / 2;

        if (sill > 0.01) addBox(width, sill, thickness, ax + ux * mid, sill / 2, az + uz * mid, angle, wallMat);
        if (top < props.wallHeight) {
          addBox(width, props.wallHeight - top, thickness, ax + ux * mid, top + (props.wallHeight - top) / 2, az + uz * mid, angle, wallMat);
        }

        if (opening.kind === "window") {
          addBox(width * 0.92, Math.max(0.35, opening.heightM * 0.88), Math.max(0.035, thickness * 0.14), ax + ux * mid, sill + opening.heightM / 2, az + uz * mid, angle, glassMat);
        } else {
          addBox(width * 0.92, Math.max(0.4, opening.heightM * 0.94), Math.max(0.04, thickness * 0.12), ax + ux * mid, opening.heightM / 2, az + uz * mid, angle, accentMat);
        }

        cursor = Math.max(cursor, end);
      }

      if (cursor < length) {
        const segment = length - cursor;
        const mid = cursor + segment / 2;
        addBox(segment, props.wallHeight, thickness, ax + ux * mid, props.wallHeight / 2, az + uz * mid, angle, wallMat);
      }
    }

    let hasFloor = false;
    for (const room of props.rooms) {
      for (const cell of room.cells) {
        hasFloor = true;
        const w = Math.max(0.05, (cell.x2 - cell.x1) * scale);
        const d = Math.max(0.05, (cell.y2 - cell.y1) * scale);
        const x = ((cell.x1 + cell.x2) / 2) * scale - cx;
        const z = ((cell.y1 + cell.y2) / 2) * scale - cy;
        addBox(w, 0.055, d, x, 0.027, z, 0, floorMat);
      }
    }

    if (!hasFloor && props.walls.length) {
      addBox(planW * 0.86, 0.07, planH * 0.86, 0, 0.035, 0, 0, floorMat);
    }

    for (const column of props.columns) {
      const x = column.point.x * scale - cx;
      const z = column.point.y * scale - cy;
      addBox(column.widthM, column.heightM, column.depthM, x, column.heightM / 2, z, 0, real ? stoneMat : whiteMat);
    }

    for (const stair of props.stairs) {
      const x = stair.origin.x * scale - cx;
      const z = stair.origin.y * scale - cy;
      const steps = Math.max(3, stair.steps);
      const rise = stair.riseM / steps;
      const run = stair.runM / steps;
      const sg = new THREE.Group();
      for (let i = 0; i < steps; i++) {
        addBox(stair.widthM, rise, run, 0, rise * (i + 0.5), -stair.runM / 2 + run * (i + 0.5), 0, floorMat, sg);
      }
      sg.position.set(x, 0, z);
      sg.rotation.y = THREE.MathUtils.degToRad(-stair.rotationDeg);
      group.add(sg);
    }

    if (!real) {
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(planW + 10, planH + 10),
        new THREE.MeshStandardMaterial({ color: 0xe6e6e2, roughness: 1 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);
    }

    scene.add(group);

    const frameCamera = (object: THREE.Object3D, extra = 1.22) => {
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;

      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      object.position.x -= center.x;
      object.position.z -= center.z;

      const aligned = new THREE.Box3().setFromObject(object);
      object.position.y -= aligned.min.y;

      const fitted = new THREE.Box3().setFromObject(object);
      const fittedSize = fitted.getSize(new THREE.Vector3());
      const maxDim = Math.max(fittedSize.x, fittedSize.z, fittedSize.y * 1.5, 6);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const distance = (maxDim / (2 * Math.tan(fov / 2))) * extra;

      camera.position.set(distance * 0.72, distance * 0.52, distance * 0.78);
      const targetY = Math.max(1.0, Math.min(fittedSize.y * 0.34, 2.2));
      camera.lookAt(0, targetY, 0);
      if (controls) {
        controls.target.set(0, targetY, 0);
        controls.minDistance = Math.max(2.5, maxDim * 0.28);
        controls.maxDistance = Math.max(45, maxDim * 5.5);
        controls.update();
      }
    };

    if (!useRemote) {
      camera.position.set(planW * 0.62, Math.max(8, planW * 0.42), planH * 0.72);
      camera.lookAt(0, 1.2, 0);
    }

    if (useRemote && props.modelUrl) {
      import("three/examples/jsm/loaders/GLTFLoader.js").then(({ GLTFLoader }) => {
        if (disposed) return;
        const loader = new GLTFLoader();
        loader.load(
          props.modelUrl!,
          (gltf) => {
            if (disposed) return;

            let materialIndex = 0;
            gltf.scene.traverse((obj) => {
              if (!(obj instanceof THREE.Mesh)) return;

              const raw = Array.isArray(obj.material) ? obj.material : [obj.material];
              const upgraded = raw.map((mat) => {
                const result = enhancedRemoteMaterial(mat, renderer, mobile, textureCache);
                materialIndex += 1;
                return result;
              });
              obj.material = Array.isArray(obj.material) ? upgraded : upgraded[0];

              const materialNames = upgraded.map((m) => m.name.toLowerCase()).join(" ");
              const isGlass = materialNames.includes("glass");
              const isGround =
                materialNames.includes("site") ||
                materialNames.includes("drive") ||
                materialNames.includes("grass");

              obj.castShadow = real && !mobile && !isGlass && !isGround;
              obj.receiveShadow = real && !isGlass;
              obj.frustumCulled = true;
            });

            scene.add(gltf.scene);
            rootRef.current = gltf.scene;
            frameCamera(gltf.scene, mobile ? 1.34 : 1.2);
          },
          undefined,
          console.error,
        );
      });
    }

    const syncControlsTarget = () => {
      if (!controls) return;
      if (!useRemote) {
        controls.target.set(0, 1.2, 0);
        controls.update();
      }
    };
    const controlSyncTimer = window.setTimeout(syncControlsTarget, 100);

    const resize = new ResizeObserver(() => {
      const w = Math.max(host.clientWidth, 1);
      const h = Math.max(host.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    resize.observe(host);

    let frame = 0;
    let lastTime = 0;
    const targetFrameMs = 1000 / 60;
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (time - lastTime < targetFrameMs - 1) return;
      lastTime = time;

      controls?.update();
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      window.clearTimeout(controlSyncTimer);
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls?.dispose();
      environmentTexture?.dispose();

      for (const texture of textureCache.values()) texture.dispose();
      textureCache.clear();

      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });

      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      rootRef.current = null;
    };
  }, [props]);

  return (
    <div className={`scene ${props.mode === "real" ? "scene-real" : "scene-white"}`}>
      <div ref={mount} className="scene-canvas" />
      {props.showExports && (
        <div className="scene-actions">
          <button onClick={exportPng}>PNG</button>
          <button onClick={exportGlb}>GLB</button>
        </div>
      )}
    </div>
  );
}
