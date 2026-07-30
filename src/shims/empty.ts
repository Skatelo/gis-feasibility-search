// Empty shim for jsPDF's OPTIONAL peer dependencies.
//
// jsPDF statically imports `canvg` (SVG rasterising) and `dompurify` (HTML
// sanitising) for its .svg() and .html() helpers. This app uses neither — pages
// are rasterised by html2canvas and added with .addImage() — but the bundler
// still has to resolve the specifiers, and failing to do so breaks the build
// with "Rolldown failed to resolve import 'canvg'".
//
// Aliasing them here keeps the bundle smaller than installing packages we never
// call. If jsPDF's .svg()/.html() are ever needed, install the real packages and
// drop the matching alias from vite.config.ts.
export default {};
