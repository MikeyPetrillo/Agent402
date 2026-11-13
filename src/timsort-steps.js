// The engine's array sort, in steps.
//
// Array.prototype.sort is TimSort in the engine (V8's array-sort.tq, the
// algorithm of CPython's listsort.txt), and it runs to the end in one call: a
// sort of tens of thousands of rows holds the thread for its whole length. A
// caller that hands the loop back between slices (routeQueryAsync) needs the
// sort itself to stop at intervals.
//
// This is the same algorithm step for step: the same minimum run, the same
// run detection (a strictly descending run is reversed), binary insertion sort
// to the minimum run, the same merge-collapse rule, the same galloping with the
// same adaptive threshold. So it asks the comparator the same questions in the
// same order and leaves the array in the same order as arr.sort(cmp), including
// for a comparator that is not a consistent order (one whose answers depend on
// the order it is asked in). test-timsort-steps.js holds it to the engine's own
// sort on random arrays and on comparators that answer at random.
//
// The generator yields once every STEP_COMPARES comparisons; the caller decides
// whether a yield ends a slice. A leaf module: no imports.

const MIN_GALLOP = 7;
const STEP_COMPARES = 1024;

function minRunLength(nArg) {
  let n = nArg, r = 0;
  while (n >= 64) { r |= n & 1; n >>= 1; }
  return n + r;
}

/** Sort `a` in place with `cmpFn`, yielding every STEP_COMPARES comparisons.
 *  Returns `a`. The order is arr.sort(cmpFn)'s. */
export function* timSortSteps(a, cmpFn, { stepCompares = STEP_COMPARES } = {}) {
  const length = a.length;
  if (length < 2) return a;
  let budget = stepCompares;
  // The engine reads a comparator's answer as a number, NaN as 0.
  const cmp = (x, y) => { budget--; const v = +cmpFn(x, y); return v !== v ? 0 : v; };
  let minGallop = MIN_GALLOP;
  const runBase = [], runLen = [];

  function gallopLeft(arr, key, base, len, hint) {
    let lastOfs = 0, offset = 1;
    if (cmp(arr[base + hint], key) < 0) {
      const maxOfs = len - hint;
      while (offset < maxOfs) {
        if (cmp(arr[base + hint + offset], key) >= 0) break;
        lastOfs = offset;
        offset = (offset << 1) + 1;
        if (offset <= 0) offset = maxOfs;
      }
      if (offset > maxOfs) offset = maxOfs;
      lastOfs += hint; offset += hint;
    } else {
      const maxOfs = hint + 1;
      while (offset < maxOfs) {
        if (cmp(arr[base + hint - offset], key) < 0) break;
        lastOfs = offset;
        offset = (offset << 1) + 1;
        if (offset <= 0) offset = maxOfs;
      }
      if (offset > maxOfs) offset = maxOfs;
      const tmp = lastOfs;
      lastOfs = hint - offset; offset = hint - tmp;
    }
    lastOfs++;
    while (lastOfs < offset) {
      const m = lastOfs + ((offset - lastOfs) >> 1);
      if (cmp(arr[base + m], key) < 0) lastOfs = m + 1;
      else offset = m;
    }
    return offset;
  }

  function gallopRight(arr, key, base, len, hint) {
    let lastOfs = 0, offset = 1;
    if (cmp(key, arr[base + hint]) < 0) {
      const maxOfs = hint + 1;
      while (offset < maxOfs) {
        if (cmp(key, arr[base + hint - offset]) >= 0) break;
        lastOfs = offset;
        offset = (offset << 1) + 1;
        if (offset <= 0) offset = maxOfs;
      }
      if (offset > maxOfs) offset = maxOfs;
      const tmp = lastOfs;
      lastOfs = hint - offset; offset = hint - tmp;
    } else {
      const maxOfs = len - hint;
      while (offset < maxOfs) {
        if (cmp(key, arr[base + hint + offset]) < 0) break;
        lastOfs = offset;
        offset = (offset << 1) + 1;
        if (offset <= 0) offset = maxOfs;
      }
      if (offset > maxOfs) offset = maxOfs;
      lastOfs += hint; offset += hint;
    }
    lastOfs++;
    while (lastOfs < offset) {
      const m = lastOfs + ((offset - lastOfs) >> 1);
      if (cmp(key, arr[base + m]) < 0) offset = m;
      else lastOfs = m + 1;
    }
    return offset;
  }

  function* mergeLow(baseA, lenA, baseB, lenB) {
    const tmp = a.slice(baseA, baseA + lenA);
    let dest = baseA, cT = 0, cB = baseB;
    a[dest++] = a[cB++];
    if (--lenB === 0) { for (let i = 0; i < lenA; i++) a[dest + i] = tmp[cT + i]; return; }
    if (lenA === 1) { for (let i = 0; i < lenB; i++) a[dest + i] = a[cB + i]; a[dest + lenB] = tmp[cT]; return; }
    let mg = minGallop;
    for (;;) {
      let winsA = 0, winsB = 0;
      for (;;) {
        if (budget <= 0) { budget = stepCompares; yield; }
        if (cmp(a[cB], tmp[cT]) < 0) {
          a[dest++] = a[cB++]; winsB++; lenB--; winsA = 0;
          if (lenB === 0) { for (let i = 0; i < lenA; i++) a[dest + i] = tmp[cT + i]; return; }
          if (winsB >= mg) break;
        } else {
          a[dest++] = tmp[cT++]; winsA++; lenA--; winsB = 0;
          if (lenA === 1) { for (let i = 0; i < lenB; i++) a[dest + i] = a[cB + i]; a[dest + lenB] = tmp[cT]; return; }
          if (winsA >= mg) break;
        }
      }
      mg++;
      let first = true;
      while (winsA >= MIN_GALLOP || winsB >= MIN_GALLOP || first) {
        first = false;
        if (budget <= 0) { budget = stepCompares; yield; }
        mg = Math.max(1, mg - 1);
        minGallop = mg;
        winsA = gallopRight(tmp, a[cB], cT, lenA, 0);
        if (winsA > 0) {
          for (let i = 0; i < winsA; i++) a[dest + i] = tmp[cT + i];
          dest += winsA; cT += winsA; lenA -= winsA;
          if (lenA === 1) { for (let i = 0; i < lenB; i++) a[dest + i] = a[cB + i]; a[dest + lenB] = tmp[cT]; return; }
          if (lenA === 0) return;
        }
        a[dest++] = a[cB++];
        if (--lenB === 0) { for (let i = 0; i < lenA; i++) a[dest + i] = tmp[cT + i]; return; }
        winsB = gallopLeft(a, tmp[cT], cB, lenB, 0);
        if (winsB > 0) {
          a.copyWithin(dest, cB, cB + winsB);
          dest += winsB; cB += winsB; lenB -= winsB;
          if (lenB === 0) { for (let i = 0; i < lenA; i++) a[dest + i] = tmp[cT + i]; return; }
        }
        a[dest++] = tmp[cT++];
        if (--lenA === 1) { for (let i = 0; i < lenB; i++) a[dest + i] = a[cB + i]; a[dest + lenB] = tmp[cT]; return; }
      }
      mg++;
      minGallop = mg;
    }
  }

  function* mergeHigh(baseA, lenA, baseB, lenB) {
    const tmp = a.slice(baseB, baseB + lenB);
    let dest = baseB + lenB - 1, cT = lenB - 1, cA = baseA + lenA - 1;
    const copyA = () => {
      dest -= lenA; cA -= lenA;
      a.copyWithin(dest + 1, cA + 1, cA + 1 + lenA);
      a[dest] = tmp[cT];
    };
    const succeed = () => { for (let i = 0; i < lenB; i++) a[dest - (lenB - 1) + i] = tmp[i]; };
    a[dest--] = a[cA--];
    if (--lenA === 0) { succeed(); return; }
    if (lenB === 1) { copyA(); return; }
    let mg = minGallop;
    for (;;) {
      let winsA = 0, winsB = 0;
      for (;;) {
        if (budget <= 0) { budget = stepCompares; yield; }
        if (cmp(tmp[cT], a[cA]) < 0) {
          a[dest--] = a[cA--]; winsA++; lenA--; winsB = 0;
          if (lenA === 0) { succeed(); return; }
          if (winsA >= mg) break;
        } else {
          a[dest--] = tmp[cT--]; winsB++; lenB--; winsA = 0;
          if (lenB === 1) { copyA(); return; }
          if (winsB >= mg) break;
        }
      }
      mg++;
      let first = true;
      while (winsA >= MIN_GALLOP || winsB >= MIN_GALLOP || first) {
        first = false;
        if (budget <= 0) { budget = stepCompares; yield; }
        mg = Math.max(1, mg - 1);
        minGallop = mg;
        let k = gallopRight(a, tmp[cT], baseA, lenA, lenA - 1);
        winsA = lenA - k;
        if (winsA > 0) {
          dest -= winsA; cA -= winsA;
          a.copyWithin(dest + 1, cA + 1, cA + 1 + winsA);
          lenA -= winsA;
          if (lenA === 0) { succeed(); return; }
        }
        a[dest--] = tmp[cT--];
        if (--lenB === 1) { copyA(); return; }
        k = gallopLeft(tmp, a[cA], 0, lenB, lenB - 1);
        winsB = lenB - k;
        if (winsB > 0) {
          dest -= winsB; cT -= winsB;
          for (let i = 0; i < winsB; i++) a[dest + 1 + i] = tmp[cT + 1 + i];
          lenB -= winsB;
          if (lenB === 1) { copyA(); return; }
          if (lenB === 0) { succeed(); return; }
        }
        a[dest--] = a[cA--];
        if (--lenA === 0) { succeed(); return; }
      }
      mg++;
      minGallop = mg;
    }
  }

  function* mergeAt(i) {
    let baseA = runBase[i], lenA = runLen[i];
    const baseB = runBase[i + 1];
    let lenB = runLen[i + 1];
    runLen[i] = lenA + lenB;
    if (i === runLen.length - 3) { runBase[i + 1] = runBase[i + 2]; runLen[i + 1] = runLen[i + 2]; }
    runBase.pop(); runLen.pop();
    const k = gallopRight(a, a[baseB], baseA, lenA, 0);
    baseA += k; lenA -= k;
    if (lenA === 0) return;
    lenB = gallopLeft(a, a[baseA + lenA - 1], baseB, lenB, lenB - 1);
    if (lenB === 0) return;
    if (lenA <= lenB) yield* mergeLow(baseA, lenA, baseB, lenB);
    else yield* mergeHigh(baseA, lenA, baseB, lenB);
  }

  const settled = (n) => n < 2 || runLen[n - 2] > runLen[n - 1] + runLen[n];

  let low = 0, remaining = length;
  const minRun = minRunLength(remaining);
  while (remaining !== 0) {
    // Count (and make ascending) the run starting at low.
    let run;
    const high = low + remaining;
    if (low + 1 === high) run = 1;
    else {
      run = 2;
      const desc = cmp(a[low + 1], a[low]) < 0;
      let prev = a[low + 1];
      for (let i = low + 2; i < high; i++) {
        const order = cmp(a[i], prev);
        if (desc ? order >= 0 : order < 0) break;
        prev = a[i];
        run++;
      }
      if (desc) for (let x = low, y = low + run - 1; x < y; x++, y--) { const t = a[x]; a[x] = a[y]; a[y] = t; }
    }
    if (run < minRun) {
      const forced = Math.min(minRun, remaining);
      // Binary insertion sort of [low, low + forced), the first `run` sorted.
      for (let start = low + run; start < low + forced; start++) {
        let left = low, right = start;
        const pivot = a[start];
        while (left < right) {
          const mid = left + ((right - left) >> 1);
          if (cmp(pivot, a[mid]) < 0) right = mid;
          else left = mid + 1;
        }
        for (let p = start; p > left; p--) a[p] = a[p - 1];
        a[left] = pivot;
      }
      run = forced;
    }
    runBase.push(low); runLen.push(run);
    // Merge collapse.
    while (runLen.length > 1) {
      let n = runLen.length - 2;
      if (!settled(n + 1) || !settled(n)) {
        if (runLen[n - 1] < runLen[n + 1]) n--;
        yield* mergeAt(n);
      } else if (runLen[n] <= runLen[n + 1]) {
        yield* mergeAt(n);
      } else break;
    }
    low += run; remaining -= run;
    if (budget <= 0) { budget = stepCompares; yield; }
  }
  while (runLen.length > 1) {
    let n = runLen.length - 2;
    if (n > 0 && runLen[n - 1] < runLen[n + 1]) n--;
    yield* mergeAt(n);
  }
  return a;
}
