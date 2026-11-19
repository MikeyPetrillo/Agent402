// A CycloneDX 1.5 software bill of materials (JSON) for the server, built
// from package-lock.json alone: no network, no node_modules, no clock. Two
// runs on one lockfile print the same bytes (the serial number is derived
// from the lockfile's own hash, and no timestamp is written).
//
//   node scripts/sbom.js                       print the SBOM
//   node scripts/sbom.js --out sbom.cdx.json   write it to a file
//   node scripts/sbom.js --omit-dev            leave out development-only packages
//   node scripts/sbom.js --lock <path>         read another lockfile (v2 or v3)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The npm package URL of a name and version (a scope's @ is percent-encoded). */
export function purlOf(name, version) {
  const n = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${n}@${encodeURIComponent(version)}`;
}

/** CycloneDX hashes from an npm integrity string ("sha512-<base64>" ...). */
export function hashesOf(integrity) {
  const ALG = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" };
  const out = [];
  for (const part of String(integrity || "").split(/\s+/).filter(Boolean)) {
    const m = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(part);
    if (m) out.push({ alg: ALG[m[1]], content: Buffer.from(m[2], "base64").toString("hex") });
  }
  return out;
}

/** The package name a lockfile path installs ("node_modules/a/node_modules/@s/b" -> "@s/b"). */
export function nameOfPath(path, entry) {
  if (entry?.name) return entry.name;
  const i = path.lastIndexOf("node_modules/");
  return i < 0 ? path : path.slice(i + "node_modules/".length);
}

/** The lockfile path npm resolves dependency `dep` to from the package at `from` (or null). */
export function resolveFrom(packages, from, dep) {
  let base = from;
  for (;;) {
    const p = base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`;
    if (packages[p]) return p;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i < 0 ? "" : base.slice(0, i);
  }
}

export function buildSbom(lockText, { omitDev = false } = {}) {
  const lock = JSON.parse(lockText);
  const packages = lock.packages;
  if (!packages || typeof packages !== "object") throw new Error("package-lock.json has no `packages` map (lockfile v2 or v3 is required)");
  const root = packages[""] || {};
  const rootName = root.name || lock.name || "app";
  const rootVersion = root.version || lock.version || "0.0.0";
  const rootRef = purlOf(rootName, rootVersion);

  const refOf = new Map();
  const components = [];
  for (const path of Object.keys(packages).sort()) {
    if (!path) continue;
    const e = packages[path];
    if (e.link || !e.version) continue;
    if (omitDev && e.dev) continue;
    const name = nameOfPath(path, e);
    const ref = purlOf(name, e.version);
    refOf.set(path, ref);
    if (components.some((c) => c["bom-ref"] === ref)) continue;
    const slash = name.startsWith("@") ? name.indexOf("/") : -1;
    const c = {
      type: "library",
      "bom-ref": ref,
      ...(slash > 0 ? { group: name.slice(0, slash), name: name.slice(slash + 1) } : { name }),
      version: e.version,
      scope: e.dev ? "excluded" : e.optional ? "optional" : "required",
      purl: ref,
    };
    const h = hashesOf(e.integrity);
    if (h.length) c.hashes = h;
    if (typeof e.license === "string" && e.license) c.licenses = [/^[A-Za-z0-9.+-]+$/.test(e.license) ? { license: { id: e.license } } : { expression: e.license }];
    if (e.resolved) c.externalReferences = [{ type: "distribution", url: e.resolved }];
    components.push(c);
  }

  const depsOf = (path, e) => {
    const names = Object.keys({ ...(e.dependencies || {}), ...(e.optionalDependencies || {}), ...(path === "" && !omitDev ? e.devDependencies || {} : {}) });
    const refs = new Set();
    for (const d of names) { const p = resolveFrom(packages, path, d); if (p && refOf.has(p)) refs.add(refOf.get(p)); }
    return [...refs].sort();
  };
  const graph = new Map([[rootRef, depsOf("", root)]]);
  for (const [path, ref] of refOf) {
    const list = depsOf(path, packages[path]);
    graph.set(ref, [...new Set([...(graph.get(ref) || []), ...list])].sort());
  }

  const digest = createHash("sha256").update(lockText).digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      tools: { components: [{ type: "application", name: "scripts/sbom.js" }] },
      component: { type: "application", "bom-ref": rootRef, name: rootName, version: rootVersion, purl: rootRef, ...(root.license ? { licenses: [{ license: { id: root.license } }] } : {}) },
      properties: [{ name: "package-lock:sha256", value: digest }],
    },
    components: components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
    dependencies: [...graph].sort(([a], [b]) => a.localeCompare(b)).map(([ref, dependsOn]) => ({ ref, dependsOn })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const lockPath = at("--lock") || join(ROOT, "package-lock.json");
  const text = JSON.stringify(buildSbom(readFileSync(lockPath, "utf8"), { omitDev: args.includes("--omit-dev") }), null, 2) + "\n";
  const out = at("--out");
  if (out) { writeFileSync(out, text); console.error(`wrote ${out}`); } else process.stdout.write(text);
}
