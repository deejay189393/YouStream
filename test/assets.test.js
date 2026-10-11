/**
 * The addon's artwork: real files on disk, referenced by the manifest and the
 * configure page. Nothing else in the suite would notice one being deleted,
 * truncated or swapped for the wrong size, so they are checked directly.
 */
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { app } = require("../server");
const { ADDON_VERSION } = require("../src/manifest");

const PUBLIC = path.join(__dirname, "..", "public");
const read = (f) => fs.readFileSync(path.join(PUBLIC, f));

/** Width and height out of a PNG's IHDR chunk, which is always first. */
function pngSize(buf) {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("artwork on disk", () => {
  // The addon protocol is specific, and a client that enforces it refuses
  // the image and falls back to a generated letter avatar.
  test("logo.png is exactly 256x256, as the manifest spec requires", () => {
    expect(pngSize(read("logo.png"))).toEqual({ width: 256, height: 256 });
  });

  test("background.png is 1920x1080, above the spec's minimum of 1024x786", () => {
    expect(pngSize(read("background.png"))).toEqual({ width: 1920, height: 1080 });
  });

  test("both are non-interlaced 8-bit PNGs, which every decoder accepts", () => {
    ["logo.png", "background.png"].forEach((f) => {
      const buf = read(f);
      expect(buf.readUInt8(24)).toBe(8);
      expect(buf.readUInt8(28)).toBe(0);
    });
  });

  test("the SVG sources are well-formed, sized by a viewBox, and draw shapes rather than text", () => {
    ["logo.svg", "background.svg"].forEach((f) => {
      const svg = read(f).toString("utf8");
      expect(svg.trimStart().startsWith("<svg")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(svg).toMatch(/viewBox="[\d\s.]+"/);
      expect(svg).not.toContain("<text");
    });
  });
});

describe("artwork is served", () => {
  test.each([
    ["/logo.png", "image/png"],
    ["/background.png", "image/png"],
    ["/logo.svg", "image/svg+xml"],
    ["/background.svg", "image/svg+xml"]
  ])("%s as %s", async (route, type) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(type);
  });

  // Apps cache addon artwork by URL; new bytes at an old URL would leave the
  // old picture on screen indefinitely.
  test("the manifest's artwork URLs carry the version, and resolve", async () => {
    const manifest = (await request(app).get("/manifest.json")).body;
    for (const url of [manifest.logo, manifest.background]) {
      const { pathname, search, searchParams } = new URL(url);
      expect(searchParams.get("v")).toBe(ADDON_VERSION);
      expect((await request(app).get(pathname + search)).status).toBe(200);
    }
  });
});
