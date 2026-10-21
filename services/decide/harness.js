// Specialized planners ("harnesses"). Each one serves a cluster of tasks,
// inherits the base planner (base-planner.js) and overrides exactly ONE seam,
// calling the base for everything else. It is declared in code with:
//
//   id             a short stable name, recorded on the decision
//   cluster        { description, classifier, appliesTo(task, signals) }:
//                  the structural description of the tasks it serves, the
//                  short prompt the router reads, and a cheap pre-check that
//                  decides whether the router is offered it at all
//   seam           the one seam it overrides (SEAMS)
//   override       function (base, ...args): `base` runs the base seam
//   designLesson   what it changes and why
//   routingLesson  when it helps and when the base is better, for the router
//
// A harness never sees retrieval, scoring, the primary, which backups are
// kept or their order: those are module functions in base-planner.js, and
// the prototypes here are frozen with the seam as their only own method.

import { BasePlanner, SEAMS } from "./base-planner.js";

const ID = /^[a-z][a-z0-9-]{2,40}$/;

export function defineHarness(spec) {
  const fail = (m) => { throw new Error(`harness ${spec?.id || "?"}: ${m}`); };
  if (!spec || typeof spec !== "object") fail("spec must be an object");
  if (!ID.test(String(spec.id || "")) || spec.id === "base") fail("id must be a short lowercase name other than base");
  if (!SEAMS.includes(spec.seam)) fail(`seam must be one of ${SEAMS.join(", ")}`);
  if (typeof spec.override !== "function") fail("override must be a function");
  const c = spec.cluster || {};
  if (typeof c.description !== "string" || c.description.length < 20) fail("cluster.description is required");
  if (typeof c.classifier !== "string" || c.classifier.length < 20) fail("cluster.classifier is required");
  if (typeof c.appliesTo !== "function") fail("cluster.appliesTo is required");
  for (const k of ["designLesson", "routingLesson"]) if (typeof spec[k] !== "string" || spec[k].length < 40) fail(`${k} is required`);
  const { id, seam, override } = spec;
  const base = BasePlanner.prototype[seam];
  const Harness = class extends BasePlanner {};
  Object.defineProperty(Harness, "name", { value: `Harness_${id.replace(/-/g, "_")}` });
  Object.defineProperty(Harness.prototype, "id", { get: () => id });
  Object.defineProperty(Harness.prototype, seam, {
    value: function (...args) { return override.call(this, (...a) => base.apply(this, a), ...args); },
    enumerable: false, writable: false, configurable: false,
  });
  Object.freeze(Harness.prototype);
  Object.freeze(Harness);
  return Object.freeze({
    id, seam, Harness,
    cluster: Object.freeze({ description: c.description, classifier: c.classifier, appliesTo: c.appliesTo }),
    designLesson: spec.designLesson, routingLesson: spec.routingLesson,
  });
}

/** Own methods of a harness prototype other than the constructor and the id
 *  getter: exactly its one seam. */
export function ownSeams(Harness) {
  return Object.getOwnPropertyNames(Harness.prototype).filter((k) => k !== "constructor" && k !== "id");
}

/** A registry: ids unique, each harness overriding only its declared seam. */
export function makeRegistry(list) {
  const seen = new Set();
  for (const h of list) {
    if (seen.has(h.id)) throw new Error(`harness ${h.id}: duplicate id`);
    seen.add(h.id);
    const own = ownSeams(h.Harness);
    if (own.length !== 1 || own[0] !== h.seam) throw new Error(`harness ${h.id}: overrides ${own.join(", ") || "nothing"}, declared ${h.seam}`);
    if (Object.getPrototypeOf(h.Harness.prototype) !== BasePlanner.prototype) throw new Error(`harness ${h.id}: must extend the base planner directly`);
  }
  return Object.freeze([...list]);
}
