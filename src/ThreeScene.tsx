import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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
    a.href = renderer.domElement.toDataURL("image/png", 0.96);
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
      { binary: true, onlyVisible: true }
    );
  };

  useEffect(() => {
    if (!mount.current) return;
    const host = mount.current;
    const real = props.mode === "real";
    const useRemote = real && !!props.modelUrl;
    const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    const isSmallScreen = Math.min(window.innerWidth, window.innerHeight) < 700;
    const mobileProfile = coarsePointer || isSmallScreen;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(real ? 0xd9e0e4 : 0xe5e7e6);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      real ? 38 : 42,
      host.clientWidth / Math.max(host.clientHeight, 1),
      0.08,
      450,
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = real ? 1.0 : 1.08;
    renderer.shadowMap.enabled = real;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobileProfile ? 1.35 : 1.75));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.domElement.style.touchAction = "none";
    rendererRef.current = renderer;
    host.replaceChildren(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, real ? 0.34 : 0.52);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(
      real ? 0xf6fbff : 0xffffff,
      real ? 0x7f7568 : 0x9b9d9d,
      real ? 1.05 : 0.92,
    );
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(real ? 0xfff1d6 : 0xffffff, real ? 2.05 : 1.15);
    sun.position.set(18, 24, 14);
    sun.castShadow = real;
    sun.shadow.mapSize.set(mobileProfile ? 1024 : 1536, mobileProfile ? 1024 : 1536);
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 110;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.025;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(real ? 0xdcecff : 0xe5e9ed, real ? 0.72 : 0.52);
    fill.position.set(-14, 12, -10);
    scene.add(fill);

    const scale = props.metersPerPixel ?? 0.02;
    const cx = props.imageSize.w * scale / 2;
    const cy = props.imageSize.h * scale / 2;
    const group = new THREE.Group();
    group.visible = !useRemote;
    rootRef.current = group;

    const palette: Record<string, { wall: number; accent: number; floor: number; stone: number }> = {
      "سعودي حديث": { wall: 0xe1d4c1, accent: 0x4e3b2c, floor: 0xc8b89f, stone: 0xa98e6e },
      "نجدي حديث": { wall: 0xc39a70, accent: 0x5a3d29, floor: 0xb38f69, stone: 0x8f6848 },
      "حجازي حديث": { wall: 0xe2c59b, accent: 0x28556d, floor: 0xcdb18a, stone: 0xa47d58 },
      "Minimal": { wall: 0xe9e5df, accent: 0x514d47, floor: 0xcfc8bf, stone: 0xaaa198 },
    };
    const colors = palette[props.style] ?? palette["سعودي حديث"];

    const whiteWallMat = new THREE.MeshStandardMaterial({
      color: 0xf6f3ed,
      roughness: 0.82,
      metalness: 0.0,
    });
    const whiteAccentMat = new THREE.MeshStandardMaterial({
      color: 0xc8c2b8,
      roughness: 0.72,
    });
    const whiteFloorMat = new THREE.MeshStandardMaterial({
      color: 0xe2dfd8,
      roughness: 0.92,
    });

    const wallMat = real
      ? new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.72, metalness: 0.0 })
      : whiteWallMat;
    const accentMat = real
      ? new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.55, metalness: 0.08 })
      : whiteAccentMat;
    const stoneMat = real
      ? new THREE.MeshStandardMaterial({ color: colors.stone, roughness: 0.90, metalness: 0.0 })
      : whiteAccentMat;
    const floorMat = real
      ? new THREE.MeshStandardMaterial({ color: colors.floor, roughness: 0.82 })
      : whiteFloorMat;
    const darkGlassMat = new THREE.MeshPhysicalMaterial({
      color: real ? 0x426a7a : 0x91a7b0,
      roughness: real ? 0.16 : 0.34,
      metalness: 0.0,
      transmission: real ? 0.18 : 0.0,
      transparent: true,
      opacity: real ? 0.56 : 0.58,
      side: THREE.DoubleSide,
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
      cast = real,
      receive = true,
    ) => {
      if (length <= 0.02 || height <= 0.02 || depth <= 0.01) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, depth), material);
      mesh.position.set(x, y, z);
      mesh.rotation.y = angle;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      parent.add(mesh);
    };

    const openingsByWall = new Map<string, Opening[]>();
    for (const opening of props.openings) {
      const list = openingsByWall.get(opening.wallId) ?? [];
      list.push(opening);
      openingsByWall.set(opening.wallId, list);
    }
    for (const list of openingsByWall.values()) {
      list.sort((a, b) => a.centerT - b.centerT);
    }

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
      const thickness = props.metersPerPixel
        ? Math.max(0.08, Math.min(0.42, wall.thickness * scale))
        : props.wallThicknessM;
      const ux = dx / length;
      const uz = dz / length;
      const list = openingsByWall.get(wall.id) ?? [];
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

        if (sill > 0.01) {
          addBox(width, sill, thickness, ax + ux * mid, sill / 2, az + uz * mid, angle, wallMat);
        }
        if (top < props.wallHeight) {
          addBox(
            width,
            props.wallHeight - top,
            thickness,
            ax + ux * mid,
            top + (props.wallHeight - top) / 2,
            az + uz * mid,
            angle,
            wallMat,
          );
        }

        if (opening.kind === "window") {
          addBox(
            width * 0.90,
            Math.max(0.34, opening.heightM * 0.86),
            Math.max(0.032, thickness * 0.12),
            ax + ux * mid,
            sill + opening.heightM / 2,
            az + uz * mid,
            angle,
            darkGlassMat,
            group,
            false,
            false,
          );
          addBox(width, 0.055, thickness + 0.025, ax + ux * mid, sill + 0.03, az + uz * mid, angle, accentMat, group, false);
          addBox(width, 0.055, thickness + 0.025, ax + ux * mid, top - 0.03, az + uz * mid, angle, accentMat, group, false);
        } else {
          addBox(
            width * 0.91,
            Math.max(0.4, opening.heightM * 0.95),
            Math.max(0.04, thickness * 0.14),
            ax + ux * mid,
            opening.heightM / 2,
            az + uz * mid,
            angle,
            accentMat,
          );
        }

        cursor = Math.max(cursor, end);
      }

      if (cursor < length) {
        const segment = length - cursor;
        const mid = cursor + segment / 2;
        addBox(segment, props.wallHeight, thickness, ax + ux * mid, props.wallHeight / 2, az + uz * mid, angle, wallMat);
      }

      if (real && props.exteriorWallIds.includes(wall.id)) {
        addBox(length, 0.09, thickness + 0.045, (ax + bx) / 2, props.wallHeight - 0.09, (az + bz) / 2, angle, accentMat, group, false);
        const claddingLength = Math.min(1.2, length * 0.28);
        if (claddingLength > 0.35) {
          addBox(
            claddingLength,
            props.wallHeight * 0.70,
            thickness + 0.035,
            ax + ux * (claddingLength / 2),
            props.wallHeight * 0.36,
            az + uz * (claddingLength / 2),
            angle,
            stoneMat,
          );
        }
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
        addBox(w, 0.055, d, x, 0.027, z, 0, floorMat, group, false, true);
        if (real) {
          addBox(w + 0.10, 0.12, d + 0.10, x, props.wallHeight + 0.06, z, 0, wallMat, group, false, true);
        }
      }
    }

    const planW = Math.max(8, props.imageSize.w * scale);
    const planH = Math.max(8, props.imageSize.h * scale);

    if (!hasFloor && props.walls.length) {
      addBox(planW * 0.86, 0.07, planH * 0.86, 0, 0.035, 0, 0, floorMat, group, false, true);
      if (real) {
        addBox(planW * 0.88, 0.12, planH * 0.88, 0, props.wallHeight + 0.06, 0, 0, wallMat, group, false, true);
      }
    }

    for (const column of props.columns) {
      const x = column.point.x * scale - cx;
      const z = column.point.y * scale - cy;
      addBox(column.widthM, column.heightM, column.depthM, x, column.heightM / 2, z, 0, real ? stoneMat : whiteAccentMat);
    }

    for (const stair of props.stairs) {
      const x = stair.origin.x * scale - cx;
      const z = stair.origin.y * scale - cy;
      const steps = Math.max(3, stair.steps);
      const rise = stair.riseM / steps;
      const run = stair.runM / steps;
      const sg = new THREE.Group();
      for (let i = 0; i < steps; i++) {
        addBox(stair.widthM, rise, run, 0, rise * (i + 0.5), -stair.runM / 2 + run * (i + 0.5), 0, floorMat, sg, false, true);
      }
      sg.position.set(x, 0, z);
      sg.rotation.y = THREE.MathUtils.degToRad(-stair.rotationDeg);
      group.add(sg);
    }

    if (real && !useRemote) {
      for (const room of props.rooms.slice(0, 10)) {
        const x = room.centroid.x * scale - cx;
        const z = room.centroid.y * scale - cy;
        if (/نوم|bed/i.test(room.name)) {
          addBox(1.8, 0.34, 2.0, x, 0.17, z, 0, new THREE.MeshStandardMaterial({ color: 0xd5cec4, roughness: 0.88 }), group, false, true);
        } else if (/مجلس|صالة|living/i.test(room.name)) {
          addBox(2.2, 0.68, 0.80, x, 0.34, z, 0, accentMat, group, false, true);
        } else if (/مطبخ|kitchen/i.test(room.name)) {
          addBox(1.7, 0.86, 0.74, x, 0.43, z, 0, stoneMat, group, false, true);
        }
      }

      const siteMat = new THREE.MeshStandardMaterial({ color: 0xc8bdac, roughness: 0.98 });
      const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x696b6c, roughness: 0.96 });
      const grassMat = new THREE.MeshStandardMaterial({ color: 0x718967, roughness: 0.96 });

      const site = new THREE.Mesh(new THREE.PlaneGeometry(planW + 12, planH + 12), siteMat);
      site.rotation.x = -Math.PI / 2;
      site.receiveShadow = true;
      scene.add(site);

      const drive = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(3.6, planW * 0.28), planH + 8), asphaltMat);
      drive.rotation.x = -Math.PI / 2;
      drive.position.set(planW * 0.34, 0.008, 0);
      drive.receiveShadow = true;
      scene.add(drive);

      const lawn = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(2.5, planW * 0.22), Math.max(3, planH * 0.45)), grassMat);
      lawn.rotation.x = -Math.PI / 2;
      lawn.position.set(-planW * 0.36, 0.01, -planH * 0.2);
      lawn.receiveShadow = true;
      scene.add(lawn);

      const perimeter = new THREE.Group();
      const sw = planW + 6;
      const sh = planH + 6;
      addBox(sw, 1.7, 0.16, 0, 0.85, -sh / 2, 0, stoneMat, perimeter);
      addBox(sw, 1.7, 0.16, 0, 0.85, sh / 2, 0, stoneMat, perimeter);
      addBox(sh, 1.7, 0.16, -sw / 2, 0.85, 0, Math.PI / 2, stoneMat, perimeter);
      addBox(sh, 1.7, 0.16, sw / 2, 0.85, 0, Math.PI / 2, stoneMat, perimeter);
      scene.add(perimeter);

      addBox(3.4, 0.15, 1.8, 0, 0.075, planH * 0.42, 0, stoneMat, group, false, true);
      addBox(3.5, 0.15, 1.4, 0, 2.65, planH * 0.43, 0, accentMat, group, true, true);
    } else if (!real) {
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(planW + 10, planH + 10),
        new THREE.MeshStandardMaterial({ color: 0xd7dad9, roughness: 1 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = false;
      scene.add(ground);
    }

    scene.add(group);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = mobileProfile ? 0.085 : 0.07;
    controls.rotateSpeed = mobileProfile ? 0.62 : 0.72;
    controls.zoomSpeed = 0.95;
    controls.panSpeed = 0.72;
    controls.screenSpacePanning = false;
    controls.minPolarAngle = 0.14;
    controls.maxPolarAngle = 1.46;
    controls.minDistance = 3.5;
    controls.maxDistance = 120;
    controls.target.set(0, 1.2, 0);

    let targetRadius = Math.max(13, Math.max(planW, planH) * (real ? 1.05 : 1.12));
    camera.position.set(targetRadius * 0.58, targetRadius * (real ? 0.48 : 0.66), targetRadius * 0.64);
    camera.lookAt(controls.target);
    controls.update();

    let disposed = false;

    const fitLoadedObject = (object: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const center = sphere.center;
      const radius = Math.max(4, sphere.radius);
      controls.target.copy(center);
      controls.target.y = Math.max(0.9, Math.min(center.y, 1.8));
      targetRadius = Math.max(9, radius * 2.0);
      camera.position.set(
        center.x + targetRadius * 0.62,
        controls.target.y + targetRadius * 0.42,
        center.z + targetRadius * 0.68,
      );
      camera.near = Math.max(0.05, radius / 120);
      camera.far = Math.max(180, radius * 24);
      camera.updateProjectionMatrix();
      controls.maxDistance = Math.max(80, radius * 8);
      controls.update();
    };

    if (useRemote && props.modelUrl) {
      import("three/examples/jsm/loaders/GLTFLoader.js").then(({ GLTFLoader }) => {
        if (disposed) return;
        const loader = new GLTFLoader();
        loader.load(
          props.modelUrl!,
          (gltf) => {
            if (disposed) return;

            gltf.scene.traverse((obj) => {
              if (!(obj instanceof THREE.Mesh)) return;

              const n = obj.name.toLowerCase();
              const largeArchitectural =
                n.includes("wall") ||
                n.includes("roof") ||
                n.includes("parapet") ||
                n.includes("canopy") ||
                n.includes("portal") ||
                n.includes("boundary") ||
                n.includes("gate");

              obj.castShadow = !mobileProfile && largeArchitectural;
              obj.receiveShadow = n.includes("site") || n.includes("drive") || n.includes("floor") || largeArchitectural;

              const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
              for (const mat of materials) {
                if (mat instanceof THREE.MeshStandardMaterial) {
                  mat.envMapIntensity = 0.75;
                  mat.needsUpdate = true;
                }
              }
            });

            scene.add(gltf.scene);
            rootRef.current = gltf.scene;
            fitLoadedObject(gltf.scene);
          },
          undefined,
          console.error,
        );
      });
    }

    const resize = new ResizeObserver(() => {
      const w = Math.max(host.clientWidth, 1);
      const h = Math.max(host.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    resize.observe(host);

    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const elapsed = now - last;
      if (elapsed >= 14) {
        last = now;
        controls.update();
        renderer.render(scene, camera);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();

      scene.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      });

      renderer.dispose();
      renderer.forceContextLoss();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      rootRef.current = null;
    };
  }, [
    props.walls,
    props.openings,
    props.rooms,
    props.columns,
    props.stairs,
    props.exteriorWallIds,
    props.imageSize.w,
    props.imageSize.h,
    props.metersPerPixel,
    props.wallHeight,
    props.wallThicknessM,
    props.style,
    props.mode,
    props.modelUrl,
  ]);

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
