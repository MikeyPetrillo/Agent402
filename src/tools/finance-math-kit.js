// Finance-math kit — the deterministic time-value-of-money primitives every
// business agent eventually needs: compound interest, loan payment,
// amortization schedule, NPV, IRR. All pure CPU, no dependencies, no
// network → automatically proof-of-work eligible (free tier). Covered by
// scripts/test-finance-math-kit.js.
//
// Formulas match Excel / Google Sheets / Python `numpy_financial` conventions
// so that an agent can cross-check against a spreadsheet without surprises.
// All money outputs round to 2 decimals; rates round to 6 decimals (basis
// points are 4 decimals, and we keep 2 extra for downstream chaining).

function bad(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function finite(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw bad(`"${field}" must be a finite number (got ${JSON.stringify(value)})`);
  }
  return n;
}

function positiveInt(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw bad(`"${field}" must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return n;
}

function toCashflows(value, field) {
  if (!Array.isArray(value)) throw bad(`"${field}" must be an array of numbers`);
  if (value.length < 2) throw bad(`"${field}" must have at least 2 elements (got ${value.length})`);
  if (value.length > 1200) throw bad(`"${field}" exceeds 1200 element limit (100 years monthly)`);
  const out = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const n = Number(value[i]);
    if (!Number.isFinite(n)) {
      throw bad(`"${field}[${i}]" is not a finite number (got ${JSON.stringify(value[i])})`);
    }
    out[i] = n;
  }
  return out;
}

// Money values round to cents — what a spreadsheet displays.
function round2(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

// Rates round to 6 decimals (4 = basis points, 2 extra for chaining math).
function round6(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1_000_000) / 1_000_000;
}

export const FINANCE_MATH_TOOLS = [
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/compound-interest", name: "Compound interest", slug: "compound-interest",
    category: "data", price: "$0.001",
    description:
      "Compute future value of a principal under compound interest. Returns future value, total interest earned, and the effective annual rate (APY) given the compounding frequency. Matches Excel's FV(rate, nper, 0, -principal) and the classic (1+r/n)^(nt) textbook formula.",
    tags: ["finance", "interest", "compound", "future-value", "fv", "apy", "savings"],
    discovery: {
      bodyType: "json",
      input: { principal: 1000, annualRate: 0.05, years: 10, compoundingPerYear: 12 },
      inputSchema: {
        properties: {
          principal: { type: "number", description: "Starting amount (positive)" },
          annualRate: { type: "number", description: "Annual interest rate as decimal (0.05 = 5%)" },
          years: { type: "number", description: "Time horizon in years" },
          compoundingPerYear: { type: "number", description: "Compounding periods per year (1 = annual, 12 = monthly, 365 = daily). Default 12." },
        },
        required: ["principal", "annualRate", "years"],
      },
      output: {
        example: {
          futureValue: 1647.01,
          totalInterest: 647.01,
          effectiveAnnualRate: 0.051162,
          periods: 120,
        },
      },
    },
    handler: (i) => {
      const principal = finite(i.principal, "principal");
      if (principal <= 0) throw bad('"principal" must be positive');
      const annualRate = finite(i.annualRate, "annualRate");
      const years = finite(i.years, "years");
      if (years <= 0) throw bad('"years" must be positive');
      const n = i.compoundingPerYear === undefined ? 12 : positiveInt(i.compoundingPerYear, "compoundingPerYear");

      // Classic textbook: FV = P · (1 + r/n)^(n·t)
      const periodicRate = annualRate / n;
      const periods = n * years;
      const futureValue = principal * Math.pow(1 + periodicRate, periods);
      // APY = (1 + r/n)^n - 1 — the effective annual rate after compounding.
      const effectiveAnnualRate = Math.pow(1 + periodicRate, n) - 1;

      return {
        futureValue: round2(futureValue),
        totalInterest: round2(futureValue - principal),
        effectiveAnnualRate: round6(effectiveAnnualRate),
        periods: Number.isInteger(periods) ? periods : round2(periods),
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    route: "POST /api/loan-payment", name: "Loan payment", slug: "loan-payment",
    category: "data", price: "$0.001",
    description:
      "Compute the monthly (or per-period) payment on a fully-amortizing loan: mortgage, auto, student loan, business loan. Returns the periodic payment, total paid over the term, and total interest. Matches Excel's PMT(rate, nper, -principal). Use this when you just need the payment number, not the full per-period schedule (see amortization).",
    tags: ["finance", "loan", "mortgage", "payment", "pmt", "amortization"],
    discovery: {
      bodyType: "json",
      input: { principal: 200000, annualRate: 0.06, termYears: 30 },
      inputSchema: {
        properties: {
          principal: { type: "number", description: "Loan principal (positive)" },
          annualRate: { type: "number", description: "Annual interest rate as decimal (0.06 = 6%)" },
          termYears: { type: "number", description: "Loan term in years" },
          paymentsPerYear: { type: "number", description: "Payments per year (12 = monthly, 26 = bi-weekly, 52 = weekly). Default 12." },
        },
        required: ["principal", "annualRate", "termYears"],
      },
      output: {
        example: {
          payment: 1199.1,
          totalPaid: 431676.38,
          totalInterest: 231676.38,
          periods: 360,
          periodicRate: 0.005,
        },
      },
    },
    handler: (i) => {
      const principal = finite(i.principal, "principal");
      if (principal <= 0) throw bad('"principal" must be positive');
      const annualRate = finite(i.annualRate, "annualRate");
      if (annualRate < 0) throw bad('"annualRate" must be non-negative');
      const termYears = finite(i.termYears, "termYears");
      if (termYears <= 0) throw bad('"termYears" must be positive');
      const n = i.paymentsPerYear === undefined ? 12 : positiveInt(i.paymentsPerYear, "paymentsPerYear");

      const periods = Math.round(n * termYears);
      const r = annualRate / n;

      // PMT = P · r / (1 - (1+r)^-n). Zero-rate loans degenerate to P/n.
      let payment;
      if (r === 0) {
        payment = principal / periods;
      } else {
        payment = (principal * r) / (1 - Math.pow(1 + r, -periods));
      }
      const totalPaid = payment * periods;

      return {
        payment: round2(payment),
        totalPaid: round2(totalPaid),
        totalInterest: round2(totalPaid - principal),
        periods,
        periodicRate: round6(r),
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    route: "POST /api/amortization", name: "Amortization schedule", slug: "amortization",
    category: "data", price: "$0.001",
    description:
      "Build the full per-period amortization schedule for a fully-amortizing loan. Each row reports the period number, payment, the principal vs. interest split for that payment, and the remaining balance after that payment. Use this when the user wants to see how interest tapers over the life of the loan, or to model an extra-payment scenario by reading the balance at any period.",
    tags: ["finance", "loan", "mortgage", "amortization", "schedule"],
    discovery: {
      bodyType: "json",
      input: { principal: 200000, annualRate: 0.06, termYears: 30, maxRows: 3 },
      inputSchema: {
        properties: {
          principal: { type: "number", description: "Loan principal (positive)" },
          annualRate: { type: "number", description: "Annual interest rate as decimal (0.06 = 6%)" },
          termYears: { type: "number", description: "Loan term in years" },
          paymentsPerYear: { type: "number", description: "Payments per year (default 12 = monthly)" },
          maxRows: { type: "number", description: "Cap the number of schedule rows returned (default 360; absolute max 1200 = 100 years monthly). Use a small value to preview just the first few rows." },
        },
        required: ["principal", "annualRate", "termYears"],
      },
      output: {
        example: {
          payment: 1199.1,
          totalPaid: 431676.38,
          totalInterest: 231676.38,
          periods: 360,
          rowsReturned: 3,
          schedule: [
            { period: 1, payment: 1199.1, interest: 1000, principal: 199.1, balance: 199800.9 },
            { period: 2, payment: 1199.1, interest: 999, principal: 200.1, balance: 199600.8 },
            { period: 3, payment: 1199.1, interest: 998, principal: 201.1, balance: 199399.71 },
          ],
        },
      },
    },
    handler: (i) => {
      const principal = finite(i.principal, "principal");
      if (principal <= 0) throw bad('"principal" must be positive');
      const annualRate = finite(i.annualRate, "annualRate");
      if (annualRate < 0) throw bad('"annualRate" must be non-negative');
      const termYears = finite(i.termYears, "termYears");
      if (termYears <= 0) throw bad('"termYears" must be positive');
      const n = i.paymentsPerYear === undefined ? 12 : positiveInt(i.paymentsPerYear, "paymentsPerYear");

      const periods = Math.round(n * termYears);
      // 1200 = 100 years monthly. Larger schedules don't fit a reasonable JSON
      // round-trip and the agent should be calling loan-payment for summary stats.
      if (periods > 1200) throw bad(`schedule would have ${periods} rows; exceeds 1200 cap (100 years monthly)`);
      const r = annualRate / n;
      const maxRows = i.maxRows === undefined ? Math.min(periods, 360) : positiveInt(i.maxRows, "maxRows");
      const rowsToReturn = Math.min(maxRows, periods);

      let payment;
      if (r === 0) {
        payment = principal / periods;
      } else {
        payment = (principal * r) / (1 - Math.pow(1 + r, -periods));
      }

      const schedule = [];
      let balance = principal;
      // We always walk the *full* schedule internally to avoid accumulating
      // floating-point error from partial walks, then push only the first
      // `rowsToReturn` rows. Numerical error per period is bounded by
      // Math.pow precision (~1e-15 relative) → final balance is exactly 0 to
      // about 8 cents on a 360-period mortgage.
      for (let k = 1; k <= periods; k++) {
        const interest = balance * r;
        const principalPaid = payment - interest;
        balance = balance - principalPaid;
        if (k <= rowsToReturn) {
          schedule.push({
            period: k,
            payment: round2(payment),
            interest: round2(interest),
            principal: round2(principalPaid),
            // Clamp the last balance to exactly 0 — floating-point drift
            // produces tiny negative values which are confusing in output.
            balance: round2(k === periods ? 0 : balance),
          });
        }
      }

      return {
        payment: round2(payment),
        totalPaid: round2(payment * periods),
        totalInterest: round2(payment * periods - principal),
        periods,
        rowsReturned: schedule.length,
        schedule,
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    route: "POST /api/npv", name: "Net present value (NPV)", slug: "npv",
    category: "data", price: "$0.001",
    description:
      "Compute the net present value of a stream of cashflows at a given discount rate. Index 0 is treated as t=0 (today, not discounted); indices 1..n are discounted by (1+rate)^t. Matches Excel's NPV but with the conventional t=0 treatment most finance textbooks use (Excel itself starts discounting at t=1 — see notes). Use for capital-budgeting decisions: positive NPV = creates value at the discount rate; negative = destroys value.",
    tags: ["finance", "npv", "present-value", "cashflow", "capital-budgeting", "discount-rate"],
    discovery: {
      bodyType: "json",
      input: { cashflows: [-1000, 300, 400, 500, 600], discountRate: 0.1 },
      inputSchema: {
        properties: {
          cashflows: { type: "array", description: "Array of cashflows. Index 0 = t=0 (today, not discounted). Negative = outflow, positive = inflow. 2-1200 elements." },
          discountRate: { type: "number", description: "Per-period discount rate as decimal (0.1 = 10%)" },
        },
        required: ["cashflows", "discountRate"],
      },
      output: {
        example: {
          npv: 388.77,
          discountRate: 0.1,
          presentValues: [-1000, 272.73, 330.58, 375.66, 409.81],
          undiscountedSum: 800,
        },
      },
    },
    handler: (i) => {
      const cashflows = toCashflows(i.cashflows, "cashflows");
      const rate = finite(i.discountRate, "discountRate");
      if (rate <= -1) throw bad('"discountRate" must be greater than -1');

      const presentValues = new Array(cashflows.length);
      let npv = 0;
      let sum = 0;
      for (let t = 0; t < cashflows.length; t++) {
        const pv = cashflows[t] / Math.pow(1 + rate, t);
        presentValues[t] = round2(pv);
        npv += pv;
        sum += cashflows[t];
      }

      return {
        npv: round2(npv),
        discountRate: rate,
        presentValues,
        undiscountedSum: round2(sum),
      };
    },
  },

  // ---------------------------------------------------------------------------
  {
    route: "POST /api/irr", name: "Internal rate of return (IRR)", slug: "irr",
    category: "data", price: "$0.001",
    description:
      "Compute the internal rate of return (IRR) of a cashflow stream — the discount rate at which NPV = 0. Index 0 is treated as t=0 (typically the negative initial investment); indices 1..n are inflows in subsequent periods. Solved via Newton-Raphson with bisection fallback. Requires at least one positive and one negative cashflow (otherwise IRR is undefined). Multiple sign changes in the cashflows can produce multiple IRR roots — we return the first one found.",
    tags: ["finance", "irr", "rate-of-return", "cashflow", "capital-budgeting"],
    discovery: {
      bodyType: "json",
      input: { cashflows: [-1000, 300, 400, 500, 600] },
      inputSchema: {
        properties: {
          cashflows: { type: "array", description: "Array of cashflows. Index 0 = t=0. Must contain at least one positive and one negative value. 2-1200 elements." },
          guess: { type: "number", description: "Initial guess for IRR as decimal (default 0.1 = 10%). Used as the Newton-Raphson starting point." },
        },
        required: ["cashflows"],
      },
      output: {
        example: {
          irr: 0.248883,
          npvAtIrr: 0,
          iterations: 6,
          converged: true,
        },
      },
    },
    handler: (i) => {
      const cashflows = toCashflows(i.cashflows, "cashflows");
      let hasPos = false;
      let hasNeg = false;
      for (const v of cashflows) {
        if (v > 0) hasPos = true;
        else if (v < 0) hasNeg = true;
      }
      if (!hasPos || !hasNeg) {
        throw bad("cashflows must contain at least one positive and one negative value for IRR to exist");
      }
      const guess = i.guess === undefined ? 0.1 : finite(i.guess, "guess");

      function npvAt(rate) {
        let v = 0;
        for (let t = 0; t < cashflows.length; t++) {
          v += cashflows[t] / Math.pow(1 + rate, t);
        }
        return v;
      }
      function dnpvAt(rate) {
        // d/dr [CF_t / (1+r)^t] = -t · CF_t / (1+r)^(t+1)
        let v = 0;
        for (let t = 1; t < cashflows.length; t++) {
          v += (-t * cashflows[t]) / Math.pow(1 + rate, t + 1);
        }
        return v;
      }

      // Newton-Raphson first: fast when it converges, but can diverge on
      // pathological cashflow shapes. We cap at 100 iterations and fall
      // back to bisection if NR misbehaves.
      let rate = guess;
      let iterations = 0;
      let converged = false;
      const tolerance = 1e-9;
      const maxIter = 100;
      for (let k = 0; k < maxIter; k++) {
        iterations++;
        const f = npvAt(rate);
        if (Math.abs(f) < tolerance) {
          converged = true;
          break;
        }
        const df = dnpvAt(rate);
        // If derivative is too small or rate would go non-finite, bail to bisection.
        if (!Number.isFinite(df) || Math.abs(df) < 1e-12) break;
        const next = rate - f / df;
        if (!Number.isFinite(next) || next <= -1) break;
        rate = next;
      }

      // Bisection fallback. Bracket the root by walking outward from -0.999 to
      // a wide upper bound. Most reasonable cashflows have IRR in [-0.99, 10].
      if (!converged) {
        let lo = -0.999;
        let hi = 10;
        const fLo = npvAt(lo);
        const fHi = npvAt(hi);
        if (fLo * fHi > 0) {
          // No sign change in the bracket — IRR is outside, or doesn't exist
          // in real numbers. Honest: return the best Newton-Raphson estimate
          // with converged=false so the caller knows not to trust it.
          return {
            irr: round6(rate),
            npvAtIrr: round2(npvAt(rate)),
            iterations,
            converged: false,
            warning: "could not bracket IRR root in [-0.999, 10] — try a different `guess` or check cashflow signs",
          };
        }
        for (let k = 0; k < 200; k++) {
          iterations++;
          const mid = (lo + hi) / 2;
          const fMid = npvAt(mid);
          if (Math.abs(fMid) < tolerance || (hi - lo) / 2 < tolerance) {
            rate = mid;
            converged = true;
            break;
          }
          if (fMid * npvAt(lo) < 0) hi = mid;
          else lo = mid;
        }
        if (!converged) rate = (lo + hi) / 2;
      }

      return {
        irr: round6(rate),
        npvAtIrr: round2(npvAt(rate)),
        iterations,
        converged,
      };
    },
  },
];
