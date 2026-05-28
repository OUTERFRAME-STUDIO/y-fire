/**
 * Post-build checks for dist/*.js (ESM output without "type": "module").
 *
 * 1. Regression: async class-field kill() used to emit `super.destroy()` inside
 *    an __awaiter generator — invalid JS for Node/webpack.
 * 2. Syntax: node --check on a temporary .mjs copy (Node treats .js as CJS).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const files = ["dist/provider.js", "dist/index.js"];

const INVALID_SUPER_IN_GENERATOR =
  /__awaiter\([\s\S]*?function\*\s*\(\)\s*\{[\s\S]*?\bsuper\.destroy\s*\(/;

for (const rel of files) {
  const filePath = path.join(root, rel);
  const src = fs.readFileSync(filePath, "utf8");

  if (rel === "dist/provider.js" && INVALID_SUPER_IN_GENERATOR.test(src)) {
    console.error(
      `${rel}: invalid super.destroy() inside __awaiter generator (use async kill() class method)`,
    );
    process.exit(1);
  }

  const tmpPath = path.join(root, rel.replace(/\.js$/, ".verify.mjs"));
  try {
    fs.writeFileSync(tmpPath, src);
    const result = spawnSync(process.execPath, ["--check", tmpPath], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

console.log("dist ok");
