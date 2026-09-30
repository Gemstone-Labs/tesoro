import sharp from "sharp";
const img = sharp("/home/ailton/Work/gemstone-labs/tesoro/art-source/ui-redesign/lobby-desktop/take-1.png");
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const at = (x, y) => {
  const i = (y * info.width + x) * info.channels;
  return "#" + [0, 1, 2].map((k) => data[i + k].toString(16).padStart(2, "0")).join("");
};
const pts = { main: [1000, 140], side: [100, 300], sidebarEdge: [266, 300], sidebarCard: [130, 700], navActive: [200, 180], search: [600, 40], chip: [300, 110], chipIn: [420, 120], balance: [1530, 40], balanceR: [1780, 40], footer: [1200, 1170], ticker: [1000, 940], rowbg: [560, 860], paycard: [700, 1085], offerA: [720, 1045], offerB: [790, 1100], playA: [330, 395], playB: [660, 420], redeem: [60, 780], pend: [60, 890], entrySelA: [440, 330], entrySelB: [550, 350], entry: [330, 330], sepline: [130, 386], sidebarborder: [267, 600], chipborder: [292, 110], tileborder: [293, 650], heroBorder: [292, 300] };
for (const [k, [x, y]] of Object.entries(pts)) console.log(k, at(x, y), info.channels);
