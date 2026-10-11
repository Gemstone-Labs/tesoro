/* THROWAWAY prototype: background patterns where every line joins two shapes. All keep the 360px period and the
   octagon centre at (160, 140), so the divider's lattice still snaps to them. Shapes may cross the tile edge: tiles are
   drawn overlapping, and a point outside [0, 360) is the same point in the next tile. */
export type Pt = [number, number];
export type Texture = { name: string; polys: Pt[][]; lines: [Pt, Pt][]; /** tile size, 360 x 360 unless set */ size?: Pt };

const shift = (poly: Pt[], dx: number, dy: number): Pt[] => poly.map(([x, y]) => [x + dx, y + dy]);

/* Small octagon for the tiled floor (180 wide, 53 corner cut) and its nested outline. */
const FLOOR_OUT: Pt[] = [[123, 50], [197, 50], [250, 103], [250, 177], [197, 230], [123, 230], [70, 177], [70, 103]];
const FLOOR_IN: Pt[] = [[135, 80], [185, 80], [220, 115], [220, 165], [185, 200], [135, 200], [100, 165], [100, 115]];

export const TEXTURES: Record<string, Texture> = {
  "0": {
    name: "Current",
    polys: [
      [[70, 40], [250, 40], [290, 80], [290, 200], [250, 240], [70, 240], [30, 200], [30, 80]],
      [[98, 68], [222, 68], [250, 96], [250, 184], [222, 212], [98, 212], [70, 184], [70, 96]],
    ],
    lines: [[[250, 40], [310, 0]], [[290, 200], [360, 240]], [[70, 240], [0, 300]], [[30, 80], [0, 60]]],
  },
  "1": {
    name: "Rails",
    polys: [
      [[70, 40], [160, 40], [250, 40], [290, 80], [290, 140], [290, 200], [250, 240], [160, 240], [70, 240], [30, 200], [30, 140], [30, 80]],
      [[98, 68], [222, 68], [250, 96], [250, 184], [222, 212], [98, 212], [70, 184], [70, 96]],
    ],
    // right side to the next octagon's left side, bottom to the next one's top
    lines: [[[290, 140], [390, 140]], [[160, 240], [160, 400]]],
  },
  "2": {
    name: "Chain",
    polys: [
      [[110, 20], [210, 20], [245, 55], [280, 90], [280, 190], [245, 225], [210, 260], [110, 260], [75, 225], [40, 190], [40, 90], [75, 55]],
      [[123, 52], [197, 52], [248, 103], [248, 177], [197, 228], [123, 228], [72, 177], [72, 103]],
    ],
    // corner facet to the diagonal neighbour's facing corner facet
    lines: [[[245, 225], [435, 415]], [[75, 225], [-115, 415]]],
  },
  "4": {
    name: "Chain, wide gems",
    // The current octagon (260 x 200) on a 360 x 300 tile: 100px gaps both ways, so the corner facets of diagonal
    // neighbours face each other and the links run at 45 degrees. 300 still divides by the divider's 30 / 20px lattice.
    size: [360, 300],
    polys: [
      [[70, 40], [250, 40], [270, 60], [290, 80], [290, 200], [270, 220], [250, 240], [70, 240], [50, 220], [30, 200], [30, 80], [50, 60]],
      [[98, 68], [222, 68], [250, 96], [250, 184], [222, 212], [98, 212], [70, 184], [70, 96]],
    ],
    lines: [[[270, 220], [410, 360]], [[50, 220], [-90, 360]]],
  },
  "3": {
    name: "Tiled floor",
    polys: [
      ...[[0, 0], [180, 0], [0, 180], [180, 180]].flatMap(([dx, dy]) => [shift(FLOOR_OUT, dx, dy), shift(FLOOR_IN, dx, dy)]),
    ],
    lines: [],
  },
};

export const TEXTURE_KEYS = Object.keys(TEXTURES);
