// Builds photo-tool-offline.html: photo-tool.html with every lib/ asset
// inlined (scripts verbatim, binary assets as data: URLs) so the tool works
// from a double-clicked file:// page with no network at all.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const lib = (f) => path.join(dir, "lib", f);
let html = fs.readFileSync(path.join(dir, "photo-tool.html"), "utf8");

// inline the two script tags
for (const f of ["selfie_segmentation.js", "jspdf.umd.min.js"]) {
  html = html.replace(
    `<script src="lib/${f}"></script>`,
    () => "<script>\n" + fs.readFileSync(lib(f), "utf8") + "\n</script>"
  );
}

// binary/runtime assets fetched by MediaPipe at run time -> data: URLs
const assets = [
  "selfie_segmentation.binarypb",
  "selfie_segmentation.tflite",
  "selfie_segmentation_landscape.tflite",
  "selfie_segmentation_solution_simd_wasm_bin.js",
  "selfie_segmentation_solution_simd_wasm_bin.wasm",
  "selfie_segmentation_solution_wasm_bin.js",
  "selfie_segmentation_solution_wasm_bin.wasm",
  "selfie_segmentation_solution_simd_wasm_bin.data",
];
const map = {};
for (const f of assets) {
  const buf = fs.readFileSync(lib(f));
  const mime = f.endsWith(".js") ? "text/javascript" : "application/octet-stream";
  map[f] = `data:${mime};base64,` + buf.toString("base64");
}

html = html.replace(
  'locateFile: (f) => "lib/" + f,',
  () => "locateFile: (f) => LIB_ASSETS[f] || f,"
);
// own script tag so it lands in the global scope before everything else
html = html.replace(
  "<head>",
  () => "<head>\n<script>var LIB_ASSETS = " + JSON.stringify(map) + ";</script>"
);

const out = path.join(dir, "photo-tool-offline.html");
fs.writeFileSync(out, html);
console.log(out, (fs.statSync(out).size / 1024 / 1024).toFixed(1) + " MB");
