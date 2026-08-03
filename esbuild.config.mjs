import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

await esbuild.build({
  banner: { js: "/* 面试复盘助手 - 千问版 */" },
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outdir: ".",
  minify: prod,
}).catch(() => process.exit(1));
