/** Generate the synthetic fixture images used by the M3 editor trial (public/fixtures/email/*.png). */
import fs from "node:fs";
import { PNG } from "pngjs";

function make(file: string, w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) << 2;
      const [r, g, b] = paint(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  fs.mkdirSync("public/fixtures/email", { recursive: true });
  fs.writeFileSync(`public/fixtures/email/${file}`, PNG.sync.write(png));
}

make("logo.png", 140, 40, (x) => (x < 40 ? [31, 95, 139] : [235, 240, 245]));
make("hero.png", 600, 240, (x, y) => [31 + Math.round((x / 600) * 80), 95 + Math.round((y / 240) * 60), 139]);
make("hero-alt.png", 600, 240, (x, y) => [217, 72 + Math.round((y / 240) * 80), 15 + Math.round((x / 600) * 60)]);
make("product-1.png", 260, 160, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? [228, 236, 242] : [196, 214, 228]);
make("product-2.png", 260, 160, (x, y) => ((x >> 4) + (y >> 4)) % 2 ? [250, 236, 222] : [240, 214, 190]);
console.log("fixture images written to public/fixtures/email/");
