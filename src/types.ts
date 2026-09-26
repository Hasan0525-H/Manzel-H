export type Point = { x: number; y: number };

export type Wall = {
  id: string;
  a: Point;
  b: Point;
  thickness: number;
};

export type OpeningKind = "door" | "window";

export type Opening = {
  id: string;
  wallId: string;
  kind: OpeningKind;
  centerT: number;
  widthM: number;
  heightM: number;
  sillM: number;
};

export type Rect = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type Room = {
  id: string;
  cells: Rect[];
  areaM2: number;
  centroid: Point;
  name: string;
};

export type Reconstruction = {
  rooms: Room[];
  exteriorWallIds: string[];
};

export type ProjectSnapshot = {
  version: 3;
  units: "meter" | "pixel";
  image: { width: number; height: number; dataUrl?: string };
  calibration: { knownMeters: number; metersPerPixel: number | null };
  building: {
    wallHeight: number;
    wallThicknessM: number;
    style: string;
    ceilingVisible: boolean;
    roofVisible: boolean;
    siteWallVisible: boolean;
  };
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
};
