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

import { round4 } from "./stats-kit.js";

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

// Prices/greeks round to 4 decimals (round4, from stats-kit.js).

// Standard normal PDF/CDF. erf via Abramowitz & Stegun 7.1.26 (~1e-7 accuracy) —
// enough to price options to the cent and match standard references.
function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

export const FINANCE_MATH_TOOLS = [
  // ---------------------------------------------------------------------------
  {
    route: "POST /api/compound-interest", name: "Compound interest", slug: "compound-interest",
    category: "data", price: "$0.002",
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
      "Compute the net present value of a stream of cashflows at a given discount rate. Index 0 is treated as t=0 (today, not discounted); indices 1..n are discounted by (1+rate)^t. Matches Excel's NPV but with the conventional t=0 treatment most finance textbooks use (Excel itself starts discounting at t=1 - see notes). Use for capital-budgeting decisions: positive NPV = creates value at the discount rate; negative = destroys value.",
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
      "Compute the internal rate of return (IRR) of a cashflow stream - the discount rate at which NPV = 0. Index 0 is treated as t=0 (typically the negative initial investment); indices 1..n are inflows in subsequent periods. Solved via Newton-Raphson with bisection fallback. Requires at least one positive and one negative cashflow (otherwise IRR is undefined). Multiple sign changes in the cashflows can produce multiple IRR roots - we return the first one found.",
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
            warning: "could not bracket IRR root in [-0.999, 10] - try a different `guess` or check cashflow signs",
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

  // --- Black-Scholes European option price + greeks ---------------------------
  {
    route: "POST /api/black-scholes", name: "Black-Scholes option price", slug: "black-scholes",
    category: "data", price: "$0.002",
    description:
      "Price a European option (call or put) with the Black-Scholes-Merton model, plus the greeks (delta, gamma, vega, theta, rho). Continuous dividend yield supported. Greeks are per unit: theta is per year, vega per 1.00 change in volatility, rho per 1.00 change in rate. Deterministic - matches standard references to the cent.",
    tags: ["finance", "options", "black-scholes", "derivatives", "greeks", "call", "put"],
    discovery: {
      bodyType: "json",
      input: { type: "call", spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.2, dividendYield: 0 },
      inputSchema: {
        properties: {
          type: { type: "string", description: "\"call\" or \"put\"" },
          spot: { type: "number", description: "Current underlying price (S)" },
          strike: { type: "number", description: "Strike price (K)" },
          timeToExpiryYears: { type: "number", description: "Time to expiry in years (T)" },
          riskFreeRate: { type: "number", description: "Annual risk-free rate as decimal (r)" },
          volatility: { type: "number", description: "Annual volatility as decimal (sigma)" },
          dividendYield: { type: "number", description: "Continuous dividend yield as decimal (q). Default 0." },
        },
        required: ["type", "spot", "strike", "timeToExpiryYears", "riskFreeRate", "volatility"],
      },
      output: { example: { type: "call", price: 10.4506, delta: 0.6368, gamma: 0.0188, vega: 37.524, theta: -6.414, rho: 53.2325, d1: 0.35, d2: 0.15 } },
    },
    handler: (i) => {
      const type = String(i.type || "").toLowerCase();
      if (type !== "call" && type !== "put") throw bad('"type" must be "call" or "put"');
      const S = finite(i.spot, "spot"), K = finite(i.strike, "strike");
      const T = finite(i.timeToExpiryYears, "timeToExpiryYears");
      const r = finite(i.riskFreeRate, "riskFreeRate"), sig = finite(i.volatility, "volatility");
      const q = i.dividendYield == null ? 0 : finite(i.dividendYield, "dividendYield");
      if (S <= 0 || K <= 0) throw bad('"spot" and "strike" must be positive');
      if (T <= 0) throw bad('"timeToExpiryYears" must be positive');
      if (sig <= 0) throw bad('"volatility" must be positive');
      const sqrtT = Math.sqrt(T);
      const d1 = (Math.log(S / K) + (r - q + (sig * sig) / 2) * T) / (sig * sqrtT);
      const d2 = d1 - sig * sqrtT;
      const eqT = Math.exp(-q * T), erT = Math.exp(-r * T), pd1 = normPdf(d1);
      let price, delta, theta, rho;
      if (type === "call") {
        price = S * eqT * normCdf(d1) - K * erT * normCdf(d2);
        delta = eqT * normCdf(d1);
        theta = -S * eqT * pd1 * sig / (2 * sqrtT) - r * K * erT * normCdf(d2) + q * S * eqT * normCdf(d1);
        rho = K * T * erT * normCdf(d2);
      } else {
        price = K * erT * normCdf(-d2) - S * eqT * normCdf(-d1);
        delta = -eqT * normCdf(-d1);
        theta = -S * eqT * pd1 * sig / (2 * sqrtT) + r * K * erT * normCdf(-d2) - q * S * eqT * normCdf(-d1);
        rho = -K * T * erT * normCdf(-d2);
      }
      const gamma = eqT * pd1 / (S * sig * sqrtT);
      const vega = S * eqT * pd1 * sqrtT;
      return { type, price: round4(price), delta: round4(delta), gamma: round4(gamma), vega: round4(vega), theta: round4(theta), rho: round4(rho), d1: round4(d1), d2: round4(d2) };
    },
  },

  // --- Bond price from yield -------------------------------------------------
  {
    route: "POST /api/bond-price", name: "Bond price", slug: "bond-price", category: "data", price: "$0.001",
    description: "Price a fixed-coupon bond from its yield to maturity: present-value the coupons plus face. Returns clean price, coupon per period, current yield, and premium/discount vs par.",
    tags: ["finance", "bond", "fixed-income", "price", "ytm", "present-value"],
    discovery: {
      bodyType: "json",
      input: { faceValue: 1000, couponRate: 0.05, yieldToMaturity: 0.06, years: 10, periodsPerYear: 2 },
      inputSchema: {
        properties: {
          faceValue: { type: "number", description: "Par/face value repaid at maturity" },
          couponRate: { type: "number", description: "Annual coupon rate as decimal (0.05 = 5%)" },
          yieldToMaturity: { type: "number", description: "Annual yield to maturity as decimal" },
          years: { type: "number", description: "Years to maturity" },
          periodsPerYear: { type: "number", description: "Coupon periods per year (2 = semiannual). Default 2." },
        },
        required: ["faceValue", "couponRate", "yieldToMaturity", "years"],
      },
      output: { example: { price: 925.61, couponPerPeriod: 25, periods: 20, currentYield: 0.054018, premiumOrDiscount: "discount" } },
    },
    handler: (i) => {
      const face = finite(i.faceValue, "faceValue"), cr = finite(i.couponRate, "couponRate");
      const y = finite(i.yieldToMaturity, "yieldToMaturity"), years = finite(i.years, "years");
      const m = i.periodsPerYear == null ? 2 : positiveInt(i.periodsPerYear, "periodsPerYear");
      if (face <= 0) throw bad('"faceValue" must be positive');
      if (years <= 0) throw bad('"years" must be positive');
      const n = Math.round(years * m), c = (face * cr) / m, per = y / m;
      const price = per === 0 ? c * n + face : c * (1 - Math.pow(1 + per, -n)) / per + face * Math.pow(1 + per, -n);
      return {
        price: round2(price), couponPerPeriod: round2(c), periods: n,
        currentYield: round6(price > 0 ? (face * cr) / price : 0),
        premiumOrDiscount: price > face ? "premium" : price < face ? "discount" : "par",
      };
    },
  },

  // --- Bond yield to maturity from price (bisection) -------------------------
  {
    route: "POST /api/bond-ytm", name: "Bond yield to maturity", slug: "bond-ytm", aliases: ["bond-yield-to-maturity", "yield-to-maturity"], category: "data", price: "$0.002",
    description: "Solve a bond's yield to maturity from its market price - the annual rate that present-values the coupons plus face to that price. Bracketed bisection root-find.",
    tags: ["finance", "bond", "ytm", "yield", "fixed-income"],
    discovery: {
      bodyType: "json",
      input: { price: 925.61, faceValue: 1000, couponRate: 0.05, years: 10, periodsPerYear: 2 },
      inputSchema: {
        properties: {
          price: { type: "number", description: "Current market (clean) price" },
          faceValue: { type: "number", description: "Par/face value" },
          couponRate: { type: "number", description: "Annual coupon rate as decimal" },
          years: { type: "number", description: "Years to maturity" },
          periodsPerYear: { type: "number", description: "Coupon periods per year. Default 2." },
        },
        required: ["price", "faceValue", "couponRate", "years"],
      },
      output: { example: { yieldToMaturity: 0.06, periods: 20, converged: true } },
    },
    handler: (i) => {
      const price = finite(i.price, "price"), face = finite(i.faceValue, "faceValue");
      const cr = finite(i.couponRate, "couponRate"), years = finite(i.years, "years");
      const m = i.periodsPerYear == null ? 2 : positiveInt(i.periodsPerYear, "periodsPerYear");
      if (price <= 0 || face <= 0) throw bad('"price" and "faceValue" must be positive');
      if (years <= 0) throw bad('"years" must be positive');
      const n = Math.round(years * m), c = (face * cr) / m;
      const priceAt = (yr) => { const per = yr / m; return per === 0 ? c * n + face : c * (1 - Math.pow(1 + per, -n)) / per + face * Math.pow(1 + per, -n); };
      let lo = -0.99, hi = 1.0, y = 0, converged = false;
      if ((priceAt(lo) - price) * (priceAt(hi) - price) > 0) throw bad("could not bracket a yield for that price/terms");
      for (let k = 0; k < 200; k++) {
        y = (lo + hi) / 2;
        const f = priceAt(y) - price; // priceAt decreases in yield
        if (Math.abs(f) < 1e-8 || (hi - lo) / 2 < 1e-12) { converged = true; break; }
        if (f > 0) lo = y; else hi = y;
      }
      return { yieldToMaturity: round6(y), periods: n, converged };
    },
  },

  // --- CAGR ------------------------------------------------------------------
  {
    route: "POST /api/cagr", name: "CAGR", slug: "cagr", category: "data", price: "$0.001",
    description: "Compound annual growth rate between a beginning and ending value over N years: (end/begin)^(1/years) - 1. Also returns total growth over the whole period.",
    tags: ["finance", "cagr", "growth", "return", "annualized"],
    discovery: {
      bodyType: "json",
      input: { beginValue: 1000, endValue: 2000, years: 5 },
      inputSchema: {
        properties: {
          beginValue: { type: "number", description: "Starting value (positive)" },
          endValue: { type: "number", description: "Ending value (positive)" },
          years: { type: "number", description: "Number of years (> 0)" },
        },
        required: ["beginValue", "endValue", "years"],
      },
      output: { example: { cagr: 0.148698, totalGrowth: 1, years: 5 } },
    },
    handler: (i) => {
      const b = finite(i.beginValue, "beginValue"), e = finite(i.endValue, "endValue"), years = finite(i.years, "years");
      if (b <= 0 || e <= 0) throw bad('"beginValue" and "endValue" must be positive');
      if (years <= 0) throw bad('"years" must be positive');
      return { cagr: round6(Math.pow(e / b, 1 / years) - 1), totalGrowth: round6(e / b - 1), years };
    },
  },

  // --- Sharpe ratio ----------------------------------------------------------
  {
    route: "POST /api/sharpe-ratio", name: "Sharpe ratio", slug: "sharpe-ratio", category: "data", price: "$0.001",
    description: "Risk-adjusted return: (mean return - risk-free rate) / sample standard deviation of returns (n-1). Pass periodsPerYear to also get the annualized ratio (× sqrt(periodsPerYear)).",
    tags: ["finance", "sharpe", "risk", "return", "volatility", "portfolio"],
    discovery: {
      bodyType: "json",
      input: { returns: [0.1, 0.05, 0.15, -0.02, 0.08], riskFreeRate: 0.02 },
      inputSchema: {
        properties: {
          returns: { type: "array", description: "Periodic returns as decimals (min 2)" },
          riskFreeRate: { type: "number", description: "Risk-free rate per period as decimal. Default 0." },
          periodsPerYear: { type: "number", description: "If set, also annualize the ratio by sqrt(periodsPerYear)." },
        },
        required: ["returns"],
      },
      output: { example: { sharpe: 0.825293, mean: 0.072, stdDev: 0.063008, excessReturn: 0.052 } },
    },
    handler: (i) => {
      const r = toCashflows(i.returns, "returns");
      const rf = i.riskFreeRate == null ? 0 : finite(i.riskFreeRate, "riskFreeRate");
      const mean = r.reduce((a, b) => a + b, 0) / r.length;
      const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (r.length - 1));
      // Epsilon, not === 0: identical returns leave a tiny float residual, not exactly 0.
      if (sd < 1e-12) throw bad("standard deviation is ~zero - Sharpe ratio is undefined for constant returns");
      const out = { sharpe: round6((mean - rf) / sd), mean: round6(mean), stdDev: round6(sd), excessReturn: round6(mean - rf) };
      if (i.periodsPerYear != null) out.annualizedSharpe = round6(((mean - rf) / sd) * Math.sqrt(positiveInt(i.periodsPerYear, "periodsPerYear")));
      return out;
    },
  },

  // --- Annuity present/future value ------------------------------------------
  {
    route: "POST /api/annuity", name: "Annuity present/future value", slug: "annuity", category: "data", price: "$0.001",
    description: "Present and future value of a level annuity (equal periodic payments). Supports an ordinary annuity (payments at period end) and an annuity-due (payments at period start).",
    tags: ["finance", "annuity", "present-value", "future-value", "tvm", "pension"],
    discovery: {
      bodyType: "json",
      input: { payment: 100, ratePerPeriod: 0.05, periods: 10, type: "ordinary" },
      inputSchema: {
        properties: {
          payment: { type: "number", description: "Payment per period (PMT)" },
          ratePerPeriod: { type: "number", description: "Interest rate per period as decimal" },
          periods: { type: "number", description: "Number of payments (positive integer)" },
          type: { type: "string", description: "\"ordinary\" (end) or \"due\" (start). Default ordinary." },
        },
        required: ["payment", "ratePerPeriod", "periods"],
      },
      output: { example: { presentValue: 772.17, futureValue: 1257.79, type: "ordinary" } },
    },
    handler: (i) => {
      const pmt = finite(i.payment, "payment"), r = finite(i.ratePerPeriod, "ratePerPeriod");
      const n = positiveInt(i.periods, "periods"), type = String(i.type || "ordinary").toLowerCase();
      if (type !== "ordinary" && type !== "due") throw bad('"type" must be "ordinary" or "due"');
      let pv, fv;
      if (r === 0) { pv = pmt * n; fv = pmt * n; }
      else {
        pv = pmt * (1 - Math.pow(1 + r, -n)) / r;
        fv = pmt * (Math.pow(1 + r, n) - 1) / r;
        if (type === "due") { pv *= 1 + r; fv *= 1 + r; }
      }
      return { presentValue: round2(pv), futureValue: round2(fv), type };
    },
  },

  // --- Break-even analysis ---------------------------------------------------
  {
    route: "POST /api/break-even", name: "Break-even analysis", slug: "break-even", category: "data", price: "$0.001",
    description: "Break-even point for a product: the units and revenue at which total revenue covers fixed plus variable costs. Also returns contribution margin and margin ratio.",
    tags: ["finance", "break-even", "business", "unit-economics", "margin"],
    discovery: {
      bodyType: "json",
      input: { fixedCost: 10000, pricePerUnit: 50, variableCostPerUnit: 30 },
      inputSchema: {
        properties: {
          fixedCost: { type: "number", description: "Total fixed cost" },
          pricePerUnit: { type: "number", description: "Selling price per unit" },
          variableCostPerUnit: { type: "number", description: "Variable cost per unit" },
        },
        required: ["fixedCost", "pricePerUnit", "variableCostPerUnit"],
      },
      output: { example: { breakEvenUnits: 500, breakEvenRevenue: 25000, contributionMargin: 20, contributionMarginRatio: 0.4 } },
    },
    handler: (i) => {
      const fc = finite(i.fixedCost, "fixedCost"), p = finite(i.pricePerUnit, "pricePerUnit"), vc = finite(i.variableCostPerUnit, "variableCostPerUnit");
      const cm = p - vc;
      if (cm <= 0) throw bad("contribution margin (price - variable cost) must be positive");
      const units = fc / cm;
      return { breakEvenUnits: round2(units), breakEvenRevenue: round2(units * p), contributionMargin: round2(cm), contributionMarginRatio: round6(cm / p) };
    },
  },

  // --- Effective annual rate (APR -> EAR/APY) --------------------------------
  {
    route: "POST /api/effective-annual-rate", name: "Effective annual rate", slug: "effective-annual-rate", category: "data", price: "$0.001",
    description: "Convert a nominal annual rate (APR) compounded m times per year into the effective annual rate (EAR / APY): (1 + apr/m)^m - 1. Set continuous:true for e^apr - 1.",
    tags: ["finance", "ear", "apy", "apr", "interest", "effective-rate"],
    discovery: {
      bodyType: "json",
      input: { nominalAnnualRate: 0.12, compoundingPerYear: 12 },
      inputSchema: {
        properties: {
          nominalAnnualRate: { type: "number", description: "Nominal annual rate / APR as decimal" },
          compoundingPerYear: { type: "number", description: "Compounding periods per year. Default 12." },
          continuous: { type: "boolean", description: "If true, use continuous compounding (e^apr - 1)." },
        },
        required: ["nominalAnnualRate"],
      },
      output: { example: { effectiveAnnualRate: 0.126825, nominalAnnualRate: 0.12, compoundingPerYear: 12 } },
    },
    handler: (i) => {
      const apr = finite(i.nominalAnnualRate, "nominalAnnualRate");
      if (i.continuous) return { effectiveAnnualRate: round6(Math.exp(apr) - 1), nominalAnnualRate: apr, continuous: true };
      const m = i.compoundingPerYear == null ? 12 : positiveInt(i.compoundingPerYear, "compoundingPerYear");
      return { effectiveAnnualRate: round6(Math.pow(1 + apr / m, m) - 1), nominalAnnualRate: apr, compoundingPerYear: m };
    },
  },
];
