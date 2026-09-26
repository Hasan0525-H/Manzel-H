import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { Column, Opening, Room, Stair, Wall } from "./types";

type Props = {
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  columns: Column[];
  stairs: Stair[];
  imageSize: { w: number; h: number };
  metersPerPixel: number | null;
  wallHeight: number;
  wallThicknessM: number;
  style: string;
  roofVisible: boolean;
  furnitureVisible: boolean;
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
    scene.background = new THREE.Color(0xf2f0eb);

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(host.clientHeight, 1), 0.1, 500);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.shadowMap.enabled = true;
    rendererRef.current = renderer;
    host.replaceChildren(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8b7a67, 2.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.8);
    sun.position.set(16, 24, 12);
    sun.castShadow = true;
    scene.add(sun);

    const scale = props.metersPerPixel ?? 0.02;
    const cx = props.imageSize.w * scale / 2;
    const cy = props.imageSize.h * scale / 2;
    const group = new THREE.Group();
    rootRef.current = group;

    const palette: Record<string, { wall: number; accent: number; floor: number }> = {
      "سعودي حديث": { wall: 0xeee8de, accent: 0x775d45, floor: 0xd8cec0 },
      "نجدي حديث": { wall: 0xd2b08b, accent: 0x704b2f, floor: 0xc7aa87 },
      "حجازي حديث": { wall: 0xf0dfc5, accent: 0x426879, floor: 0xd8c2a5 },
      "Minimal": { wall: 0xf4f2ee, accent: 0x6f675d, floor: 0xd8d3cc },
    };
    const colors = palette[props.style] ?? palette["سعودي حديث"];
    const wallMat = new THREE.MeshStandardMaterial({ color: colors.wall, roughness: 0.76 });
    const accentMat = new THREE.MeshStandardMaterial({ color: colors.accent, roughness: 0.7 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fc7d8, transparent: true, opacity: 0.48, roughness: 0.15 });
    const floorMat = new THREE.MeshStandardMaterial({ color: colors.floor, roughness: 0.9 });

    const addBox = (length: number, height: number, depth: number, x: number, y: number, z: number, angle: number, mat: THREE.Material) => {
      if (length <= 0.02 || height <= 0.02) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, depth), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.y = angle;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
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
          addBox(width * 0.9, Math.max(0.3, opening.heightM * 0.88), Math.max(0.03, thickness * 0.15), ax + ux * mid, sill + opening.heightM / 2, az + uz * mid, angle, glassMat);
        } else {
          addBox(width * 0.92, Math.max(0.3, opening.heightM * 0.94), Math.max(0.03, thickness * 0.12), ax + ux * mid, opening.heightM / 2, az + uz * mid, angle, accentMat);
        }
        cursor = Math.max(cursor, end);
      }

      if (cursor < length) {
        const segment = length - cursor;
        const mid = cursor + segment / 2;
        addBox(segment, props.wallHeight, thickness, ax + ux * mid, props.wallHeight / 2, az + uz * mid, angle, wallMat);
      }
    }

    for (const room of props.rooms) {
      for (const cell of room.cells) {
        const w = (cell.x2 - cell.x1) * scale;
        const d = (cell.y2 - cell.y1) * scale;
        const x = ((cell.x1 + cell.x2) / 2) * scale - cx;
        const z = ((cell.y1 + cell.y2) / 2) * scale - cy;
        addBox(w, 0.05, d, x, 0.025, z, 0, floorMat);
        if (props.roofVisible) addBox(w + 0.08, 0.14, d + 0.08, x, props.wallHeight + 0.07, z, 0, floorMat);
      }
    }

    for (const column of props.columns) {
      const x = column.point.x * scale - cx;
      const z = column.point.y * scale - cy;
      addBox(column.widthM, column.heightM, column.depthM, x, column.heightM / 2, z, 0, accentMat);
    }

    for (const stair of props.stairs) {
      const x = stair.origin.x * scale - cx;
      const z = stair.origin.y * scale - cy;
      const steps = Math.max(3, stair.steps);
      const rise = stair.riseM / steps;
      const run = stair.runM / steps;
      const sg = new THREE.Group();
      for (let i = 0; i < steps; i++) {
        const tread = new THREE.Mesh(new THREE.BoxGeometry(stair.widthM, rise, run), floorMat);
        tread.position.set(0, rise * (i + 0.5), -stair.runM / 2 + run * (i + 0.5));
        sg.add(tread);
      }
      sg.position.set(x, 0, z);
      sg.rotation.y = THREE.MathUtils.degToRad(-stair.rotationDeg);
      group.add(sg);
    }

    if (props.furnitureVisible) {
      for (const room of props.rooms.slice(0, 10)) {
        const x = room.centroid.x * scale - cx;
        const z = room.centroid.y * scale - cy;
        if (/نوم|bed/i.test(room.name)) addBox(1.8, 0.42, 2, x, 0.21, z, 0, floorMat);
        else if (/مجلس|صالة|living/i.test(room.name)) addBox(2.2, 0.72, 0.8, x, 0.36, z, 0, accentMat);
      }
    }

    scene.add(group);

    const planW = Math.max(10, props.imageSize.w * scale);
    const planH = Math.max(10, props.imageSize.h * scale);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(planW + 10, planH + 10), new THREE.MeshStandardMaterial({ color: 0xd8d1c6, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let yaw = 0.72;
    let pitch = 0.62;
    let radius = Math.max(16, Math.max(planW, planH) * 1.15);

    const updateCamera = () => {
      pitch = Math.max(0.16, Math.min(1.35, pitch));
      camera.position.set(Math.cos(yaw) * Math.cos(pitch) * radius, Math.sin(pitch) * radius, Math.sin(yaw) * Math.cos(pitch) * radius);
      camera.lookAt(0, 1.2, 0);
    };
    updateCamera();

    const down = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
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
      radius = Math.max(5, Math.min(100, radius));
      updateCamera();
    };

    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerup", up);
    renderer.domElement.addEventListener("pointerleave", up);
    renderer.domElement.addEventListener("wheel", wheel, { passive: false });

    const resize = new ResizeObserver(() => {
      const w = host.clientWidth;
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
      renderer.dispose();
      rendererRef.current = null;
      rootRef.current = null;
    };
  }, [props]);

  return (
    <div className="scene">
      <div ref={mount} className="scene-canvas" />
      <div className="scene-actions">
        <button onClick={exportPng}>PNG</button>
        <button onClick={exportGlb}>GLB</button>
      </div>
    </div>
  );
}
