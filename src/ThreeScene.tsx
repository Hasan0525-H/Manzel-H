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
};

export default function ThreeScene(props: Props) {
  const mount = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<THREE.Group | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const exportPng = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const a = document.createElement("a");
    a.href = renderer.domElement.toDataURL("image/png");
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
    const scene = new THREE.Scene();
    const real = props.mode === "real";
    scene.background = new THREE.Color(real ? 0xcfd9df : 0xeeeeec);
    scene.fog = new THREE.Fog(real ? 0xcfd9df : 0xeeeeec, 40, 120);

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(host.clientHeight, 1), 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.shadowMap.enabled = real;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendererRef.current = renderer;
    host.replaceChildren(renderer.domElement);

    scene.add(new THREE.HemisphereLight(real ? 0xffffff : 0xffffff, real ? 0x7b6c5c : 0xb8b8b8, real ? 2.2 : 2.7));
    const sun = new THREE.DirectionalLight(real ? 0xfff4dc : 0xffffff, real ? 3.3 : 1.8);
    sun.position.set(18, 28, 12);
    sun.castShadow = real;
    sun.shadow.mapSize.set(2048, 2048);
    scene.add(sun);

    const scale = props.metersPerPixel ?? 0.02;
    const cx = props.imageSize.w * scale / 2;
    const cy = props.imageSize.h * scale / 2;
    const group = new THREE.Group();
    rootRef.current = group;

    const palette: Record<string, { wall: number; accent: number; floor: number; stone: number }> = {
      "سعودي حديث": { wall: 0xeadfce, accent: 0x5e4634, floor: 0xd7c7b2, stone: 0xb59b7b },
      "نجدي حديث": { wall: 0xcba77e, accent: 0x65452f, floor: 0xbe9d78, stone: 0x9b7655 },
      "حجازي حديث": { wall: 0xead2ad, accent: 0x315e73, floor: 0xd7bc95, stone: 0xb18c65 },
      "Minimal": { wall: 0xf2eee8, accent: 0x5e5952, floor: 0xd8d0c7, stone: 0xbeb5aa },
    };
    const colors = palette[props.style] ?? palette["سعودي حديث"];

    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    const wallMat = real ? new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.78 }) : whiteMat;
    const accentMat = real ? new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.66 }) : whiteMat;
    const stoneMat = real ? new THREE.MeshStandardMaterial({ color: colors.stone, roughness: 0.95 }) : whiteMat;
    const floorMat = real ? new THREE.MeshStandardMaterial({ color: colors.floor, roughness: 0.88 }) : whiteMat;
    const glassMat = real
      ? new THREE.MeshStandardMaterial({ color: 0x7fb4c8, metalness: 0.05, roughness: 0.08, transparent: true, opacity: 0.55 })
      : new THREE.MeshStandardMaterial({ color: 0xe9eef1, roughness: 0.4, transparent: true, opacity: 0.85 });
    const darkGlassMat = real
      ? new THREE.MeshStandardMaterial({ color: 0x335564, metalness: 0.12, roughness: 0.08, transparent: true, opacity: 0.52 })
      : glassMat;

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
      mesh.castShadow = real;
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
        if (top < props.wallHeight) addBox(width, props.wallHeight - top, thickness, ax + ux * mid, top + (props.wallHeight - top) / 2, az + uz * mid, angle, wallMat);

        if (opening.kind === "window") {
          addBox(width * 0.92, Math.max(0.35, opening.heightM * 0.88), Math.max(0.035, thickness * 0.14), ax + ux * mid, sill + opening.heightM / 2, az + uz * mid, angle, darkGlassMat);
          if (real) {
            addBox(width, 0.065, thickness + 0.035, ax + ux * mid, sill + 0.03, az + uz * mid, angle, accentMat);
            addBox(width, 0.065, thickness + 0.035, ax + ux * mid, top - 0.03, az + uz * mid, angle, accentMat);
          }
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

      if (real && props.exteriorWallIds.includes(wall.id)) {
        addBox(length, 0.12, thickness + 0.055, (ax + bx) / 2, props.wallHeight - 0.12, (az + bz) / 2, angle, accentMat);
        const claddingLength = Math.min(1.15, length * 0.3);
        if (claddingLength > 0.35) {
          addBox(claddingLength, props.wallHeight * 0.72, thickness + 0.04, ax + ux * (claddingLength / 2), props.wallHeight * 0.38, az + uz * (claddingLength / 2), angle, stoneMat);
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
        addBox(w, 0.055, d, x, 0.027, z, 0, floorMat);
        if (real) addBox(w + 0.12, 0.14, d + 0.12, x, props.wallHeight + 0.07, z, 0, wallMat);
      }
    }

    const planW = Math.max(8, props.imageSize.w * scale);
    const planH = Math.max(8, props.imageSize.h * scale);
    if (!hasFloor && props.walls.length) {
      addBox(planW * 0.86, 0.07, planH * 0.86, 0, 0.035, 0, 0, floorMat);
      if (real) addBox(planW * 0.88, 0.14, planH * 0.88, 0, props.wallHeight + 0.07, 0, 0, wallMat);
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

    if (real) {
      for (const room of props.rooms.slice(0, 12)) {
        const x = room.centroid.x * scale - cx;
        const z = room.centroid.y * scale - cy;
        if (/نوم|bed/i.test(room.name)) {
          addBox(1.8, 0.36, 2.0, x, 0.18, z, 0, new THREE.MeshStandardMaterial({ color: 0xd7d0c7, roughness: 0.9 }));
        } else if (/مجلس|صالة|living/i.test(room.name)) {
          addBox(2.3, 0.72, 0.82, x, 0.36, z, 0, accentMat);
        } else if (/مطبخ|kitchen/i.test(room.name)) {
          addBox(1.7, 0.88, 0.76, x, 0.44, z, 0, stoneMat);
        }
      }

      const siteMat = new THREE.MeshStandardMaterial({ color: 0xc9bda9, roughness: 1 });
      const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 1 });
      const grassMat = new THREE.MeshStandardMaterial({ color: 0x79926a, roughness: 1 });

      const site = new THREE.Mesh(new THREE.PlaneGeometry(planW + 12, planH + 12), siteMat);
      site.rotation.x = -Math.PI / 2;
      site.receiveShadow = true;
      scene.add(site);

      const drive = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(3.6, planW * 0.28), planH + 8), asphaltMat);
      drive.rotation.x = -Math.PI / 2;
      drive.position.set(planW * 0.34, 0.008, 0);
      drive.receiveShadow = true;
      scene.add(drive);

      const lawn1 = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(2.5, planW * 0.22), Math.max(3, planH * 0.45)), grassMat);
      lawn1.rotation.x = -Math.PI / 2;
      lawn1.position.set(-planW * 0.36, 0.01, -planH * 0.2);
      scene.add(lawn1);

      const perimeter = new THREE.Group();
      const sw = planW + 6;
      const sh = planH + 6;
      addBox(sw, 1.7, 0.16, 0, 0.85, -sh / 2, 0, stoneMat, perimeter);
      addBox(sw, 1.7, 0.16, 0, 0.85, sh / 2, 0, stoneMat, perimeter);
      addBox(sh, 1.7, 0.16, -sw / 2, 0.85, 0, Math.PI / 2, stoneMat, perimeter);
      addBox(sh, 1.7, 0.16, sw / 2, 0.85, 0, Math.PI / 2, stoneMat, perimeter);
      scene.add(perimeter);

      const porch = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.16, 1.8), stoneMat);
      porch.position.set(0, 0.08, planH * 0.42);
      porch.castShadow = true;
      group.add(porch);

      const canopy = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.16, 1.4), accentMat);
      canopy.position.set(0, 2.65, planH * 0.43);
      canopy.castShadow = true;
      group.add(canopy);

      const warm = new THREE.PointLight(0xffd29a, 18, 10, 2);
      warm.position.set(0, 2.4, planH * 0.38);
      group.add(warm);
    } else {
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(planW + 10, planH + 10),
        new THREE.MeshStandardMaterial({ color: 0xe4e4e1, roughness: 1 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      scene.add(ground);
    }

    scene.add(group);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let yaw = real ? 0.72 : 0.82;
    let pitch = real ? 0.55 : 0.72;
    let radius = Math.max(15, Math.max(planW, planH) * 1.18);

    const updateCamera = () => {
      pitch = Math.max(0.14, Math.min(1.38, pitch));
      camera.position.set(
        Math.cos(yaw) * Math.cos(pitch) * radius,
        Math.sin(pitch) * radius,
        Math.sin(yaw) * Math.cos(pitch) * radius
      );
      camera.lookAt(0, 1.25, 0);
    };
    updateCamera();

    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - lastX) * 0.008;
      pitch += (e.clientY - lastY) * 0.006;
      lastX = e.clientX;
      lastY = e.clientY;
      updateCamera();
    };
    const up = () => { dragging = false; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      radius *= e.deltaY > 0 ? 1.08 : 0.92;
      radius = Math.max(5, Math.min(110, radius));
      updateCamera();
    };

    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("pointerleave", up);
    renderer.domElement.addEventListener("wheel", wheel, { passive: false });

    const resize = new ResizeObserver(() => {
      const w = Math.max(host.clientWidth, 1);
      const h = Math.max(host.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resize.observe(host);

    let frame = 0;
    const loop = () => {
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      renderer.domElement.removeEventListener("pointerdown", down);
      renderer.domElement.removeEventListener("pointermove", move);
      renderer.domElement.removeEventListener("pointerup", up);
      renderer.domElement.removeEventListener("pointerleave", up);
      renderer.domElement.removeEventListener("wheel", wheel);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      renderer.dispose();
      rendererRef.current = null;
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
