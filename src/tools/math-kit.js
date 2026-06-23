// Math kit — prime factorization, GCD/LCM, combinatorics, matrix
// multiplication, descriptive statistics. All pure CPU, no dependencies,
// no network → automatically proof-of-work eligible (free tier).

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}


export const MATH_TOOLS = [
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/prime-factorize", name: "Prime factorize", slug: "prime-factorize",
    category: "math", price: "$0.001",
    description:
      "Find the prime factorization of an integer via trial division. Returns the list of prime factors (with repeats), a human-readable factorization string, whether the number is prime, and the count of distinct prime factors. Limit: numbers up to 10^15.",
    tags: ["prime", "factorize", "number-theory"],
    discovery: {
      bodyType: "json",
      input: { number: 360 },
      inputSchema: {
        properties: {
          number: { type: "integer", description: "Integer > 1 to factorize (max 10^15)" },
        },
        required: ["number"],
      },
      output: {
        example: {
          number: 360,
          factors: [2, 2, 2, 3, 3, 5],
          factorization: "2^3 \u00d7 3^2 \u00d7 5",
          isPrime: false,
          distinctFactors: 3,
        },
      },
    },
    handler(input) {
      let n = input.number;
      if (n === undefined || n === null) throw bad('Missing required field "number"');
      n = Number(n);
      if (!Number.isFinite(n) || n !== Math.floor(n)) throw bad('"number" must be an integer');
      if (n < 2) throw bad('"number" must be > 1');
      if (n > 1e15) throw bad('"number" exceeds 10^15 limit (too slow for trial division)');

      const factors = [];
      let rem = n;

      while (rem % 2 === 0) {
        factors.push(2);
        rem /= 2;
      }
      for (let d = 3; d * d <= rem; d += 2) {
        while (rem % d === 0) {
          factors.push(d);
          rem /= d;
        }
      }
      if (rem > 1) factors.push(rem);

      // Build human-readable factorization string: "2^3 x 3^2 x 5"
      const groups = [];
      let i = 0;
      while (i < factors.length) {
        const p = factors[i];
        let count = 0;
        while (i < factors.length && factors[i] === p) { count++; i++; }
        groups.push(count > 1 ? `${p}^${count}` : `${p}`);
      }

      return {
        number: n,
        factors,
        factorization: groups.join(" \u00d7 "),
        isPrime: factors.length === 1,
        distinctFactors: groups.length,
      };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/gcd-lcm", name: "GCD & LCM", slug: "gcd-lcm",
    category: "math", price: "$0.001",
    description:
      "Compute the greatest common divisor (Euclidean algorithm) and least common multiple of two positive integers. Also reports whether the two numbers are coprime (GCD = 1).",
    tags: ["gcd", "lcm", "number-theory"],
    discovery: {
      bodyType: "json",
      input: { a: 48, b: 18 },
      inputSchema: {
        properties: {
          a: { type: "integer", description: "First positive integer" },
          b: { type: "integer", description: "Second positive integer" },
        },
        required: ["a", "b"],
      },
      output: {
        example: { a: 48, b: 18, gcd: 6, lcm: 144, coprime: false },
      },
    },
    handler(input) {
      let a = input.a;
      let b = input.b;
      if (a === undefined || a === null) throw bad('Missing required field "a"');
      if (b === undefined || b === null) throw bad('Missing required field "b"');
      a = Number(a);
      b = Number(b);
      if (!Number.isFinite(a) || a !== Math.floor(a) || a < 1) throw bad('"a" must be a positive integer');
      if (!Number.isFinite(b) || b !== Math.floor(b) || b < 1) throw bad('"b" must be a positive integer');

      function gcd(x, y) {
        while (y !== 0) {
          const t = y;
          y = x % y;
          x = t;
        }
        return x;
      }

      const g = gcd(a, b);
      const lcm = (a / g) * b; // avoid overflow by dividing first

      return { a, b, gcd: g, lcm, coprime: g === 1 };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/combinatorics", name: "Combinatorics", slug: "combinatorics",
    category: "math", price: "$0.001",
    description:
      "Compute combinations C(n, r) or permutations P(n, r) using BigInt for exact arbitrary-precision results. Returns the result as a string (since values can exceed Number.MAX_SAFE_INTEGER) and a human-readable formula.",
    tags: ["combinatorics", "permutation", "combination"],
    discovery: {
      bodyType: "json",
      input: { n: 10, r: 3, type: "combination" },
      inputSchema: {
        properties: {
          n: { type: "integer", description: "Total items (0 to 1000)" },
          r: { type: "integer", description: "Items chosen (0 to n)" },
          type: { type: "string", description: '"combination" (default) or "permutation"' },
        },
        required: ["n", "r"],
      },
      output: {
        example: { n: 10, r: 3, type: "combination", result: "120", formula: "C(10,3) = 10! / (3! \u00d7 7!)" },
      },
    },
    handler(input) {
      let n = input.n;
      let r = input.r;
      if (n === undefined || n === null) throw bad('Missing required field "n"');
      if (r === undefined || r === null) throw bad('Missing required field "r"');
      n = Number(n);
      r = Number(r);
      if (!Number.isFinite(n) || n !== Math.floor(n) || n < 0) throw bad('"n" must be a non-negative integer');
      if (!Number.isFinite(r) || r !== Math.floor(r) || r < 0) throw bad('"r" must be a non-negative integer');
      if (r > n) throw bad('"r" must be <= "n"');
      if (n > 1000) throw bad('"n" must be <= 1000');

      const type = (input.type || "combination").toLowerCase();
      if (type !== "combination" && type !== "permutation") {
        throw bad('"type" must be "combination" or "permutation"');
      }

      // P(n, r) = n! / (n-r)!
      // C(n, r) = n! / (r! * (n-r)!)
      // Compute iteratively with BigInt to avoid factorial blowup.
      let result = 1n;
      const bn = BigInt(n);
      const br = BigInt(r);

      if (type === "permutation") {
        for (let i = bn; i > bn - br; i--) result *= i;
        const formula = `P(${n},${r}) = ${n}! / ${n - r}!`;
        return { n, r, type, result: result.toString(), formula };
      }

      // Combination: multiply n*(n-1)*...*(n-r+1) then divide by r!
      // Use the smaller of r and n-r for efficiency.
      const k = r < n - r ? r : n - r;
      const bk = BigInt(k);
      result = 1n;
      for (let i = 0n; i < bk; i++) {
        result = result * (bn - i) / (i + 1n);
      }
      const formula = `C(${n},${r}) = ${n}! / (${r}! \u00d7 ${n - r}!)`;
      return { n, r, type, result: result.toString(), formula };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/matrix-multiply", name: "Matrix multiply", slug: "matrix-multiply",
    category: "math", price: "$0.001",
    description:
      "Standard matrix multiplication of two 2D arrays: A[m\u00d7k] \u00d7 B[k\u00d7n] \u2192 C[m\u00d7n]. Validates that inner dimensions match. Each dimension is capped at 100.",
    tags: ["matrix", "multiply", "linear-algebra"],
    discovery: {
      bodyType: "json",
      input: {
        a: [[1, 2], [3, 4]],
        b: [[5, 6], [7, 8]],
      },
      inputSchema: {
        properties: {
          a: { type: "array", description: "First matrix (2D array of numbers)" },
          b: { type: "array", description: "Second matrix (2D array of numbers)" },
        },
        required: ["a", "b"],
      },
      output: {
        example: { result: [[19, 22], [43, 50]], dimensions: { m: 2, k: 2, n: 2 } },
      },
    },
    handler(input) {
      const a = input.a;
      const b = input.b;
      if (!Array.isArray(a) || !Array.isArray(a[0])) throw bad('"a" must be a 2D array (matrix)');
      if (!Array.isArray(b) || !Array.isArray(b[0])) throw bad('"b" must be a 2D array (matrix)');

      const m = a.length;
      const k = a[0].length;
      const k2 = b.length;
      const n = b[0].length;

      if (m > 100 || k > 100 || n > 100) throw bad("Each matrix dimension must be <= 100");
      if (k !== k2) throw bad(`Inner dimensions do not match: a has ${k} columns but b has ${k2} rows`);

      // Validate all rows have consistent length and all elements are numbers
      for (let i = 0; i < m; i++) {
        if (!Array.isArray(a[i]) || a[i].length !== k) throw bad(`Row ${i} of "a" has inconsistent length`);
        for (let j = 0; j < k; j++) {
          if (typeof a[i][j] !== "number" || !Number.isFinite(a[i][j])) throw bad(`a[${i}][${j}] is not a finite number`);
        }
      }
      for (let i = 0; i < k2; i++) {
        if (!Array.isArray(b[i]) || b[i].length !== n) throw bad(`Row ${i} of "b" has inconsistent length`);
        for (let j = 0; j < n; j++) {
          if (typeof b[i][j] !== "number" || !Number.isFinite(b[i][j])) throw bad(`b[${i}][${j}] is not a finite number`);
        }
      }

      // Multiply
      const result = new Array(m);
      for (let i = 0; i < m; i++) {
        result[i] = new Array(n);
        for (let j = 0; j < n; j++) {
          let sum = 0;
          for (let p = 0; p < k; p++) sum += a[i][p] * b[p][j];
          result[i][j] = sum;
        }
      }

      return { result, dimensions: { m, k, n } };
    },
  },
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/mod-arithmetic", name: "Modular arithmetic", slug: "mod-arithmetic",
    category: "math", price: "$0.001",
    description:
      "Modular arithmetic operations: mod (a mod m), modpow (a^b mod m via fast exponentiation), and modinverse (a^-1 mod m via extended Euclidean algorithm). Uses BigInt for arbitrary precision. Useful for cryptography and number theory.",
    tags: ["modular", "arithmetic", "number-theory"],
    discovery: {
      bodyType: "json",
      input: { op: "modpow", a: 7, b: 256, m: 13 },
      inputSchema: {
        properties: {
          op: { type: "string", description: '"mod", "modpow", or "modinverse"' },
          a: { type: "integer", description: "base value" },
          b: { type: "integer", description: "exponent (required for modpow)" },
          m: { type: "integer", description: "modulus (must be > 0)" },
        },
        required: ["op", "a", "m"],
      },
      output: {
        example: { op: "modpow", a: "7", b: "256", m: "13", result: "9" },
      },
    },
    handler(input) {
      const op = (input.op || "").toLowerCase();
      if (!["mod", "modpow", "modinverse"].includes(op)) throw bad('"op" must be "mod", "modpow", or "modinverse"');
      if (input.a === undefined) throw bad('Missing "a"');
      if (input.m === undefined) throw bad('Missing "m"');
      const a = BigInt(Number(input.a));
      const m = BigInt(Number(input.m));
      if (m <= 0n) throw bad('"m" must be > 0');

      if (op === "mod") {
        const result = ((a % m) + m) % m;
        return { op, a: a.toString(), m: m.toString(), result: result.toString() };
      }

      if (op === "modpow") {
        if (input.b === undefined) throw bad('"b" is required for modpow');
        let b = BigInt(Number(input.b));
        if (b < 0n) throw bad('"b" must be >= 0 for modpow');
        let base = ((a % m) + m) % m;
        let result = 1n;
        while (b > 0n) {
          if (b & 1n) result = (result * base) % m;
          base = (base * base) % m;
          b >>= 1n;
        }
        return { op, a: a.toString(), b: input.b.toString(), m: m.toString(), result: result.toString() };
      }

      // modinverse via extended Euclidean
      function extGcd(a, b) {
        if (b === 0n) return [a, 1n, 0n];
        const [g, x1, y1] = extGcd(b, a % b);
        return [g, y1, x1 - (a / b) * y1];
      }
      const norm = ((a % m) + m) % m;
      const [g, x] = extGcd(norm, m);
      if (g !== 1n) throw bad(`No modular inverse: gcd(${a}, ${m}) = ${g} (must be 1)`);
      const result = ((x % m) + m) % m;
      return { op, a: a.toString(), m: m.toString(), result: result.toString() };
    },
  },
];
