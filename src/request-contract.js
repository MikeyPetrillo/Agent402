// Compact, seller-authored request evidence for marketplace rows.
//
// This module reports whether a buyer can construct the documented request. It
// never invents values, probes a paid route, verifies runtime behavior, ranks a
// seller, or authorizes payment. Examples remain seller-authored and bounded so
// one hostile OpenAPI document cannot turn the index cache into a secret or
// memory sink.

import { looksLikeListingInjection } from "./listing-injection.js";

const LOCATIONS = ["path", "query", "header", "body"];
const MAX_REQUIRED = 16;
const MAX_REQUIRED_NAME = 96;
const MAX_STORED_BYTES = 1024;
const MAX_EXAMPLE_BYTES = 1536;
const MAX_EXAMPLE_DEPTH = 3;
const MAX_EXAMPLE_KEYS = 16;
const MAX_EXAMPLE_ARRAY = 8;
const MAX_EXAMPLE_STRING = 512;

const CREDENTIAL_LIKE = /(authorization|apikey|accesskey|accesstoken|refreshtoken|authtoken|bearertoken|clientsecret|secretkey|password|passwd|privatekey|signature|credential|cookie|sessionid|sessiontoken)/;
const PRIVATE_WORDS = new Set(["token", "key", "auth", "jwt", "otp", "pin", "email", "passcode", "mfa", "totp"]);
const PRIVATE_COMPACT_NAMES = new Set(["clientid", "verificationcode", "recoverycode"]);
const PROTOTYPE_SPECIAL_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function credentialLike(value) {
  return CREDENTIAL_LIKE.test(String(value).toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function privateValueLike(value, schema) {
  const normalized = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = String(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return credentialLike(value) || PRIVATE_COMPACT_NAMES.has(normalized) || words.some((word) => PRIVATE_WORDS.has(word)) ||
    schema?.writeOnly === true || schema?.["x-sensitive"] === true ||
    ["password", "email"].includes(String(schema?.format || "").toLowerCase());
}

function prototypeSpecial(value) {
  return PROTOTYPE_SPECIAL_NAMES.has(String(value || "").toLowerCase());
}

function listingInjectionLike(value) {
  // Router case-folds listing hay before looksLikeListingInjection. Projected
  // names and examples need the same fold, plus bounded decoded variants and
  // URL path/query/fragment parts, or mixed-case and encoded commands leak.
  const text = String(value);
  if (decodedVariants(text).some((variant) => looksLikeListingInjection(variant.toLowerCase()))) return true;
  if (!/^https?:\/\//i.test(text)) return false;
  try {
    const parsed = new URL(text);
    return [parsed.pathname, parsed.hash, ...[...parsed.searchParams].flatMap(([name, item]) => [name, item])]
      .some((part) => decodedVariants(part).some((variant) => looksLikeListingInjection(variant.toLowerCase())));
  } catch {
    return false;
  }
}

function safeName(value) {
  const name = String(value || "");
  return name && name.length <= MAX_REQUIRED_NAME && !prototypeSpecial(name) && !/[\u0000-\u001f\u007f]/.test(name) && !listingInjectionLike(name) ? name : null;
}

function pointerPart(value) {
  return String(value).replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(document, value, seen = new Set(), { schema = false } = {}) {
  let current = value;
  for (let depth = 0; depth < 12; depth++) {
    const ref = current?.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return current;
    if (seen.has(ref)) return null;
    seen.add(ref);
    const target = ref.slice(2).split("/").map(pointerPart).reduce((node, key) => node?.[key], document);
    if (!target || typeof target !== "object") return null;
    const siblings = Object.fromEntries(Object.entries(current).filter(([key]) => key !== "$ref"));
    current = schema && String(document?.openapi || "").startsWith("3.1") && Object.keys(siblings).length
      ? { ...target, ...siblings }
      : target;
  }
  return null;
}

function firstExample(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.example !== undefined) return value.example;
  if (Array.isArray(value.examples) && value.examples.length) return value.examples[0];
  for (const candidate of Object.values(value.examples || {})) {
    if (candidate && typeof candidate === "object" && candidate.value !== undefined) return candidate.value;
  }
  return undefined;
}

function authoredSchemaExample(document, rawSchema, depth = 0, seen = new Set()) {
  if (depth > MAX_EXAMPLE_DEPTH) return undefined;
  const ref = typeof rawSchema?.$ref === "string" ? rawSchema.$ref : null;
  if (ref && seen.has(ref)) return undefined;
  const walkSeen = new Set(seen);
  const schema = resolveLocalRef(document, rawSchema, walkSeen, { schema: true });
  if (!schema || typeof schema !== "object" || walkSeen.has(schema)) return undefined;
  walkSeen.add(schema);
  if (schema.example !== undefined) return schema.example;
  if (schema.type === "object" || schema.properties) {
    const out = Object.create(null);
    // Walk required names only, and never enumerate a hostile properties object.
    const names = Array.isArray(schema.required) && schema.required.length
      ? schema.required
      : Object.keys(schema.properties || {});
    for (const rawName of names.slice(0, MAX_EXAMPLE_KEYS)) {
      const name = safeName(rawName);
      if (!name) continue;
      const example = authoredSchemaExample(document, schema.properties?.[name], depth + 1, walkSeen);
      if (example !== undefined) out[name] = example;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (schema.type === "array" && schema.items) {
    const item = authoredSchemaExample(document, schema.items, depth + 1, walkSeen);
    return item === undefined ? undefined : [item];
  }
  return undefined;
}

function secretValueShape(value) {
  const text = String(value);
  return /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text) ||
    /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|(?:gh[pousr]|npm)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:sk|rk)_live_[A-Za-z0-9]{12,}|whsec_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{30,})\b/.test(text) ||
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/.test(text) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ||
    /(?:^|[^A-Za-z0-9_-])(?:sid|session(?:id|token)?|token|auth|jwt|api[_-]?key|password|passwd|secret)\s*=\s*[^;,\s]+/i.test(text);
}

function decodedVariants(value) {
  const values = [String(value)];
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(values.at(-1));
      if (decoded === values.at(-1)) break;
      values.push(decoded);
    } catch {
      break;
    }
  }
  return values;
}

function safeScalar(value) {
  if (typeof value === "string") {
    if (value.length > MAX_EXAMPLE_STRING || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return { ok: false };
    if (/^\s*(bearer|basic)\s+/i.test(value) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return { ok: false };
    // A seller can put a credential in an innocently named field. Names and
    // schema markers are therefore only the first privacy boundary: reject
    // common secret and identity value shapes before anything enters cache.
    if (secretValueShape(value) || listingInjectionLike(value)) return { ok: false };
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        const privateUrlPart = [...parsed.searchParams].some(([key, item]) =>
          privateValueLike(key) || decodedVariants(item).some(secretValueShape),
        ) || [parsed.pathname, parsed.hash].some((part) => decodedVariants(part).some(secretValueShape));
        if (parsed.username || parsed.password || privateUrlPart) return { ok: false };
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, value };
  }
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (typeof value === "boolean") return { ok: true, value };
  return { ok: false };
}

function sanitizeExample(value, depth = 0) {
  if (depth > MAX_EXAMPLE_DEPTH) return { ok: false };
  const scalar = safeScalar(value);
  if (scalar.ok) return scalar;
  if (value === null) return { ok: true, value: null };
  if (Array.isArray(value)) {
    if (value.length > MAX_EXAMPLE_ARRAY) return { ok: false };
    const out = [];
    for (const item of value) {
      const clean = sanitizeExample(item, depth + 1);
      if (!clean.ok) return { ok: false };
      out.push(clean.value);
    }
    return { ok: true, value: out };
  }
  if (!value || typeof value !== "object") return { ok: false };
  const entries = Object.entries(value);
  if (entries.length > MAX_EXAMPLE_KEYS) return { ok: false };
  const out = Object.create(null);
  for (const [key, item] of entries) {
    if (!safeName(key) || privateValueLike(key)) continue;
    const clean = sanitizeExample(item, depth + 1);
    if (!clean.ok) continue;
    out[key] = clean.value;
  }
  return { ok: true, value: out };
}

function requiredSchemaPaths(document, rawSchema, prefix = "", depth = 0, seen = new Set()) {
  if (depth > MAX_EXAMPLE_DEPTH) return { paths: [], truncated: true, redacted: 0 };
  const ref = typeof rawSchema?.$ref === "string" ? rawSchema.$ref : null;
  if (ref && seen.has(ref)) return { paths: [], truncated: true, redacted: 0 };
  const walkSeen = new Set(seen);
  const schema = resolveLocalRef(document, rawSchema, walkSeen, { schema: true });
  if (!schema || typeof schema !== "object") return { paths: [], truncated: false, redacted: 0 };
  if (walkSeen.has(schema)) return { paths: [], truncated: true, redacted: 0 };
  walkSeen.add(schema);
  if (schema.type === "array" && schema.items) {
    return requiredSchemaPaths(document, schema.items, prefix ? `${prefix}[]` : "[]", depth + 1, walkSeen);
  }
  const paths = [];
  let truncated = false;
  let redacted = 0;
  const requiredNames = Array.isArray(schema.required) ? schema.required : [];
  if (requiredNames.length > MAX_REQUIRED) truncated = true;
  for (const rawName of requiredNames.slice(0, MAX_REQUIRED)) {
    if (paths.length >= MAX_REQUIRED) {
      truncated = true;
      break;
    }
    const name = safeName(rawName);
    if (!name) {
      truncated = true;
      continue;
    }
    const property = resolveLocalRef(document, schema.properties?.[name], new Set(walkSeen), { schema: true });
    // OpenAPI required+readOnly means required in responses, not in requests.
    if (property?.readOnly === true) continue;
    if (privateValueLike(name, property)) {
      redacted++;
      continue;
    }
    const path = prefix ? `${prefix}.${name}` : String(name);
    paths.push(path);
    if (paths.length >= MAX_REQUIRED) {
      truncated = true;
      break;
    }
    const child = requiredSchemaPaths(document, schema.properties?.[name], path, depth + 1, walkSeen);
    for (const childPath of child.paths) {
      if (paths.length < MAX_REQUIRED) paths.push(childPath);
      else {
        truncated = true;
        break;
      }
    }
    truncated ||= child.truncated;
    redacted += child.redacted;
  }
  return { paths: [...new Set(paths)], truncated, redacted };
}

function requiredOnlyExample(document, rawSchema, value, depth = 0, seen = new Set()) {
  if (depth > MAX_EXAMPLE_DEPTH) return { ok: false };
  const ref = typeof rawSchema?.$ref === "string" ? rawSchema.$ref : null;
  if (ref && seen.has(ref)) return { ok: false };
  const walkSeen = new Set(seen);
  const schema = resolveLocalRef(document, rawSchema, walkSeen, { schema: true });
  if (!schema || typeof schema !== "object") return sanitizeExample(value, depth);
  if (walkSeen.has(schema)) return { ok: false };
  walkSeen.add(schema);
  if (schema.type === "array" || schema.items) {
    if (!Array.isArray(value) || value.length > MAX_EXAMPLE_ARRAY) return { ok: false };
    const out = [];
    for (const item of value) {
      const clean = requiredOnlyExample(document, schema.items, item, depth + 1, walkSeen);
      if (!clean.ok) return { ok: false };
      out.push(clean.value);
    }
    return { ok: true, value: out };
  }
  const required = Array.isArray(schema.required) ? schema.required.slice(0, MAX_REQUIRED) : [];
  if ((schema.type === "object" || schema.properties) && required.length === 0) {
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value: {} } : { ok: false };
  }
  if ((schema.type === "object" || schema.properties) && required.length) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    const out = Object.create(null);
    for (const rawName of required) {
      const name = safeName(rawName);
      const property = resolveLocalRef(document, schema.properties?.[name], new Set(walkSeen), { schema: true });
      if (property?.readOnly === true) continue;
      if (!name || privateValueLike(name, property)) continue;
      if (!(name in value)) return { ok: false };
      const clean = requiredOnlyExample(document, schema.properties?.[name], value[name], depth + 1, walkSeen);
      if (!clean.ok) return { ok: false };
      out[name] = clean.value;
    }
    return { ok: true, value: out };
  }
  return sanitizeExample(value, depth);
}

function bodyPathParts(path) {
  return String(path || "").split(".").filter(Boolean).map((part) => ({ name: part.replace(/\[\]$/, ""), array: part.endsWith("[]") }));
}

function buildBodyTrie(paths) {
  const root = Object.create(null);
  for (const path of paths) {
    if (path === "$") continue;
    let node = root;
    for (const part of bodyPathParts(path)) {
      if (!safeName(part.name)) break;
      node[part.name] ||= { array: part.array, children: Object.create(null) };
      node[part.name].array ||= part.array;
      node = node[part.name].children;
    }
  }
  return root;
}

function selectBodyExample(value, trie, depth = 0) {
  if (depth > MAX_EXAMPLE_DEPTH || !value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const out = Object.create(null);
  for (const [name, rule] of Object.entries(trie)) {
    if (privateValueLike(name) || !(name in value)) return { ok: false };
    const childRules = rule.children || {};
    let selected;
    if (rule.array) {
      if (!Array.isArray(value[name]) || value[name].length > MAX_EXAMPLE_ARRAY) return { ok: false };
      selected = [];
      for (const item of value[name]) {
        const clean = Object.keys(childRules).length ? selectBodyExample(item, childRules, depth + 1) : sanitizeExample(item, depth + 1);
        if (!clean.ok) return { ok: false };
        selected.push(clean.value);
      }
    } else if (Object.keys(childRules).length) {
      const clean = selectBodyExample(value[name], childRules, depth + 1);
      if (!clean.ok) return { ok: false };
      selected = clean.value;
    } else {
      const clean = sanitizeExample(value[name], depth + 1);
      if (!clean.ok) return { ok: false };
      selected = clean.value;
    }
    out[name] = selected;
  }
  return { ok: true, value: out };
}

function exampleHasPath(value, path) {
  if (path === "$") return value !== undefined;
  const parts = String(path).split(".");
  let nodes = [value];
  for (const raw of parts) {
    const array = raw.endsWith("[]");
    const name = array ? raw.slice(0, -2) : raw;
    const next = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || !(name in node)) continue;
      const child = node[name];
      if (array) {
        if (!Array.isArray(child) || child.length === 0) continue;
        next.push(...child);
      } else next.push(child);
    }
    if (!next.length) return false;
    nodes = next;
  }
  return nodes.every((node) => node !== undefined);
}

function compactGroups(groups) {
  let remaining = MAX_REQUIRED;
  const out = {};
  let truncated = false;
  for (const key of LOCATIONS) {
    const values = [...new Set(groups[key] || [])];
    if (values.length > remaining) truncated = true;
    const kept = values.slice(0, remaining);
    if (kept.length) out[key] = kept;
    remaining -= kept.length;
  }
  return { groups: out, truncated };
}

function compactExample(groups) {
  const out = Object.fromEntries(LOCATIONS.filter((key) => groups[key] !== undefined).map((key) => [key, groups[key]]));
  if (!Object.keys(out).length) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(out)) > MAX_EXAMPLE_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return out;
}

function normalizeStoredTuple(raw) {
  const source = raw?.[0] === "c" || raw?.[0] === "o" || raw?.[0] === "b" ? raw[0] : "n";
  const originalState = raw?.[1] === "d" || raw?.[1] === "m" ? raw[1] : "a";
  const originalRequired = raw?.[2] && typeof raw[2] === "object" && !Array.isArray(raw[2]) ? raw[2] : {};
  const filtered = { path: [], query: [], header: [], body: [] };
  let redacted = Math.max(0, Math.min(MAX_REQUIRED, Number(raw?.[4]) || 0));
  let truncated = raw?.[5] === 1;
  for (const location of LOCATIONS) {
    for (const value of Array.isArray(originalRequired[location]) ? originalRequired[location] : []) {
      const name = safeName(value);
      const segments = location === "body" && name ? bodyPathParts(name).map((part) => part.name) : [name];
      if (!name || segments.some((segment) => !safeName(segment))) {
        truncated = true;
        continue;
      }
      if (segments.some((segment) => privateValueLike(segment))) {
        redacted = Math.min(MAX_REQUIRED, redacted + 1);
        continue;
      }
      filtered[location].push(name);
    }
  }
  const capped = compactGroups(filtered);
  truncated ||= capped.truncated;
  const examples = {};
  const rawExample = raw?.[3] && typeof raw[3] === "object" && !Array.isArray(raw[3]) ? raw[3] : {};
  for (const location of ["path", "query"]) {
    if (!capped.groups[location]?.length || !rawExample[location] || typeof rawExample[location] !== "object") continue;
    for (const name of capped.groups[location]) {
      const clean = safeScalar(rawExample[location][name]);
      if (clean.ok) (examples[location] ||= {})[name] = clean.value;
    }
  }
  if (capped.groups.body?.length && !capped.groups.body.includes("$") && rawExample.body !== undefined) {
    const clean = selectBodyExample(rawExample.body, buildBodyTrie(capped.groups.body));
    if (clean.ok) examples.body = clean.value;
  }
  let example = compactExample(examples) || null;
  const hasRequired = Object.values(capped.groups).some((values) => values.length);
  const complete = ["path", "query"].every((location) => (capped.groups[location] || []).every((name) => name in (examples[location] || {}))) &&
    !(capped.groups.header?.length) &&
    (capped.groups.body || []).every((path) => exampleHasPath(examples.body, path));
  let state = originalState === "a" && !hasRequired && !redacted ? "a" :
    originalState === "d" && hasRequired && complete && !redacted && !truncated ? "d" : "m";
  const tuple = [source, state, capped.groups, example, redacted, truncated ? 1 : 0];
  try {
    if (Buffer.byteLength(JSON.stringify(tuple)) > MAX_STORED_BYTES) {
      tuple[1] = tuple[1] === "a" ? "a" : "m";
      tuple[3] = null;
      tuple[5] = 1;
    }
    while (Buffer.byteLength(JSON.stringify(tuple)) > MAX_STORED_BYTES) {
      const key = [...LOCATIONS].reverse().find((location) => tuple[2]?.[location]?.length);
      if (!key) break;
      tuple[2][key].pop();
      if (!tuple[2][key].length) delete tuple[2][key];
    }
  } catch {
    return [source, state === "a" ? "a" : "m", {}, null, 0, 1];
  }
  return tuple;
}

/** Build a bounded request report from one OpenAPI operation. */
export function requestContractFromOperation(document, method, route, operation, pathItem = {}, { source = "seller_openapi" } = {}) {
  const required = { path: [], query: [], header: [], body: [] };
  const examples = {};
  let redactedRequired = 0;
  let truncated = false;
  let missing = false;
  let encounteredRequired = 0;

  const merged = new Map();
  for (const raw of [...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation?.parameters) ? operation.parameters : [])]) {
    const parameter = resolveLocalRef(document, raw);
    if (!parameter || typeof parameter !== "object") continue;
    const where = String(parameter.in || "").toLowerCase();
    const name = String(parameter.name || "");
    if (!name || !["path", "query", "header", "cookie", "body"].includes(where)) continue;
    merged.set(`${where}:${name}`, parameter);
  }

  for (const parameter of merged.values()) {
    const where = String(parameter.in).toLowerCase();
    const name = safeName(parameter.name);
    if (!name) {
      truncated = true;
      continue;
    }
    const isRequired = parameter.required === true || where === "path";
    if (!isRequired) continue;
    encounteredRequired++;
    if (encounteredRequired > MAX_REQUIRED) {
      truncated = true;
      break;
    }
    const parameterMedia = !parameter.schema && parameter.content && typeof parameter.content === "object"
      ? Object.values(parameter.content).find((entry) => entry && typeof entry === "object")
      : null;
    const parameterSchema = resolveLocalRef(document, parameter.schema || parameterMedia?.schema, new Set(), { schema: true });
    if (where === "cookie" || privateValueLike(name, parameterSchema)) {
      redactedRequired++;
      missing = true;
      continue;
    }
    if (where === "body") {
      const bodyPaths = requiredSchemaPaths(document, parameterSchema);
      required.body.push(...(bodyPaths.paths.length ? bodyPaths.paths : ["$"]));
      redactedRequired += bodyPaths.redacted;
      truncated ||= bodyPaths.truncated;
      let example = firstExample(parameter);
      if (example === undefined) example = firstExample(parameterMedia);
      if (example === undefined) example = authoredSchemaExample(document, parameterSchema);
      const clean = requiredOnlyExample(document, parameterSchema, example);
      if (clean.ok) examples.body = clean.value;
      else missing = true;
      continue;
    }
    if (required[where].length < MAX_REQUIRED) required[where].push(name);
    else truncated = true;
    let example = firstExample(parameter);
    if (example === undefined) example = firstExample(parameterMedia);
    if (example === undefined) example = firstExample(parameterSchema);
    if (where === "header") {
      // Header values are disproportionately likely to be credentials or
      // identity-bearing. Report the required name but do not copy its value.
      missing = true;
    } else {
      const clean = safeScalar(example);
      if (clean.ok) (examples[where] ||= {})[name] = clean.value;
      else missing = true;
    }
  }

  const rawBody = resolveLocalRef(document, operation?.requestBody);
  if (rawBody?.required === true) {
    encounteredRequired++;
    const content = rawBody.content && typeof rawBody.content === "object" ? rawBody.content : {};
    const mediaKeys = Object.keys(content);
    const normalizedMedia = (key) => key.toLowerCase().split(";", 1)[0].trim();
    const mediaKey = mediaKeys.find((key) => normalizedMedia(key) === "application/json") ||
      mediaKeys.find((key) => normalizedMedia(key).startsWith("application/") && normalizedMedia(key).endsWith("+json"));
    const media = mediaKey ? content[mediaKey] : null;
    const schema = resolveLocalRef(document, media?.schema, new Set(), { schema: true });
    const bodyPaths = requiredSchemaPaths(document, schema);
    required.body.push(...(bodyPaths.paths.length ? bodyPaths.paths : ["$"]));
    redactedRequired += bodyPaths.redacted;
    truncated ||= bodyPaths.truncated;
    let example = firstExample(media);
    if (example === undefined) example = authoredSchemaExample(document, schema);
    const clean = requiredOnlyExample(document, schema, example);
    if (clean.ok) examples.body = clean.value;
    else missing = true;
  }

  const capped = compactGroups(required);
  truncated ||= capped.truncated;
  for (const key of LOCATIONS) required[key] = capped.groups[key] || [];
  for (const key of ["path", "query", "header"]) {
    for (const name of required[key]) if (!(name in (examples[key] || {}))) missing = true;
  }
  for (const path of required.body) if (!exampleHasPath(examples.body, path)) missing = true;

  const requiredCount = LOCATIONS.reduce((sum, key) => sum + required[key].length, 0) + redactedRequired;
  const example = compactExample(examples);
  if (Object.keys(examples).length && !example) missing = true;
  const state = requiredCount === 0 && encounteredRequired === 0 && !truncated
    ? "absent"
    : missing || truncated || redactedRequired > 0
      ? "missing_example"
      : "declared";
  return {
    source,
    state,
    required: capped.groups,
    ...(example ? { example } : {}),
    ...(redactedRequired ? { redactedRequired } : {}),
    ...(truncated ? { truncated: true } : {}),
    runtimeVerified: false,
  };
}

/** Build the same report from a CDP/x402 Bazaar item already in memory. */
export function requestContractFromBazaarItem(item) {
  const bazaar = item?.extensions?.bazaar;
  const info = bazaar?.info?.input;
  const schema = bazaar?.schema;
  if (!info || typeof info !== "object" || !schema || typeof schema !== "object") {
    // Missing Bazaar request metadata is no evidence about required input. It
    // must not be projected as a seller-declared input-free operation.
    return { source: "none", state: "unknown", required: {}, runtimeVerified: false };
  }
  const inputSchema = resolveLocalRef(schema, schema.properties?.input, new Set(), { schema: true }) || {};
  const method = String(info.method || item?.method || "GET").toUpperCase();
  const queryMethod = ["GET", "HEAD", "DELETE", "OPTIONS"].includes(method);
  const operation = { parameters: [] };
  for (const [field, where] of [["pathParams", "path"], ["queryParams", "query"], ["headers", "header"]]) {
    const locationSchema = resolveLocalRef(schema, inputSchema.properties?.[field], new Set(), { schema: true }) || {};
    const examples = info[field] && typeof info[field] === "object" ? info[field] : {};
    for (const [name, property] of Object.entries(locationSchema.properties || {})) {
      operation.parameters.push({
        name,
        in: where,
        required: where === "path" || (locationSchema.required || []).includes(name),
        schema: property,
        ...(examples[name] === undefined ? {} : { example: examples[name] }),
      });
    }
  }
  const bodySchema = resolveLocalRef(schema, inputSchema.properties?.body, new Set(), { schema: true });
  const bodyRequired = Boolean(!queryMethod && bodySchema && (
    (Array.isArray(bodySchema.required) && bodySchema.required.length) ||
    (Array.isArray(inputSchema.required) && inputSchema.required.includes("body"))
  ));
  if (bodyRequired) {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: bodySchema,
          ...(info.body === undefined ? {} : { example: info.body }),
        },
      },
    };
  }
  return requestContractFromOperation(schema, method, item?.resource || "/", operation, {}, { source: "seller_bazaar" });
}

/** Adapt Agent402's canonical catalog discovery record without inventing data. */
export function requestContractFromDiscovery(tool) {
  const [method = "GET", route = "/"] = String(tool?.route || "GET /").split(" ");
  const schema = tool?.discovery?.inputSchema || {};
  const input = tool?.discovery?.input ?? tool?.discovery?.example;
  const upper = method.toUpperCase();
  const document = { paths: { [route]: {} } };
  let operation;
  if (["GET", "DELETE", "HEAD", "OPTIONS"].includes(upper)) {
    operation = {
      parameters: Object.entries(schema.properties || {}).map(([name, property]) => ({
        name,
        in: "query",
        required: (schema.required || []).includes(name),
        schema: property,
        ...(input?.[name] === undefined ? {} : { example: input[name] }),
      })),
    };
  } else {
    const bodyRequired = (Array.isArray(schema.required) && schema.required.length > 0) || input !== undefined;
    operation = {
      ...(bodyRequired ? {
        requestBody: {
          required: true,
          content: { "application/json": { schema, ...(input === undefined ? {} : { example: input }) } },
        },
      } : {}),
    };
  }
  return requestContractFromOperation(document, upper, route, operation, {}, { source: "seller_catalog" });
}

/** Persist a compact tuple in the crawler cache. */
export function requestContractStorage(value) {
  const source = value?.source === "seller_catalog" ? "c" : value?.source === "seller_openapi" ? "o" : value?.source === "seller_bazaar" ? "b" : "n";
  const state = value?.state === "declared" ? "d" : value?.state === "missing_example" ? "m" : "a";
  const capped = compactGroups(value?.required && typeof value.required === "object" ? value.required : {});
  return normalizeStoredTuple([
    source,
    capped.truncated && state === "d" ? "m" : state,
    capped.groups,
    value?.example && typeof value.example === "object" ? value.example : null,
    Math.max(0, Math.min(MAX_REQUIRED, Number(value?.redactedRequired) || 0)),
    value?.truncated === true || capped.truncated ? 1 : 0,
  ]);
}

/** Prefer a complete OpenAPI declaration, otherwise keep the strongest
 * seller-authored evidence already carried by the Bazaar row. */
export function preferRequestContractStorage(primaryTool, fallbackTool) {
  const primary = requestContractStorageProjection(primaryTool).requestContractEvidence;
  const fallback = requestContractStorageProjection(fallbackTool).requestContractEvidence;
  if (!primary) return fallback ? { requestContractEvidence: fallback } : {};
  if (!fallback) return { requestContractEvidence: primary };
  const rank = (stored) => stored[1] === "d" ? 2 : stored[1] === "m" ? 1 : 0;
  return { requestContractEvidence: rank(primary) >= rank(fallback) ? primary : fallback };
}

export function requestContractStorageProjection(tool) {
  if (Array.isArray(tool?.requestContractEvidence)) return { requestContractEvidence: normalizeStoredTuple(tool.requestContractEvidence) };
  if (tool?.requestContract && typeof tool.requestContract === "object") return { requestContractEvidence: requestContractStorage(tool.requestContract) };
  return {};
}

function unknownRequestContract() {
  return {
    requestContract: {
      source: "none",
      state: "unknown",
      required: {},
      runtimeVerified: false,
    },
  };
}

/** Expand the compact tuple on every public marketplace projection. */
export function requestContractProjection(tool) {
  const hasTuple = Array.isArray(tool?.requestContractEvidence)
    || (tool?.requestContract && typeof tool.requestContract === "object");
  if (!hasTuple) return unknownRequestContract();
  const rawStored = Array.isArray(tool.requestContractEvidence)
    ? tool.requestContractEvidence
    : requestContractStorage(tool.requestContract);
  const stored = normalizeStoredTuple(rawStored);
  const source = stored[0] === "c" ? "seller_catalog" : stored[0] === "o" ? "seller_openapi" : stored[0] === "b" ? "seller_bazaar" : "none";
  // source "n" is not a seller-authored tuple — we have no evidence, which is
  // not the same as "this operation declared no required input".
  if (source === "none") return unknownRequestContract();
  const state = stored[1] === "d" ? "declared" : stored[1] === "m" ? "missing_example" : "absent";
  const required = stored[2] && typeof stored[2] === "object" ? stored[2] : {};
  const example = stored[3] && typeof stored[3] === "object" ? stored[3] : null;
  return {
    requestContract: {
      source,
      state,
      required,
      ...(example ? { example } : {}),
      ...(Number(stored[4]) > 0 ? { redactedRequired: Math.min(MAX_REQUIRED, Number(stored[4])) } : {}),
      ...(stored[5] === 1 ? { truncated: true } : {}),
      runtimeVerified: false,
    },
  };
}

export function requestContractProjectionFromDiscovery(tool) {
  return requestContractProjection({ requestContractEvidence: requestContractStorage(requestContractFromDiscovery(tool)) });
}
