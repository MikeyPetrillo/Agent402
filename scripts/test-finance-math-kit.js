// Offline unit tests for finance-math-kit. Verifies textbook math against
// known cross-checkable values (Excel/PMT, classic capital-budgeting examples)
// and asserts the error contracts return statusCode=400 instead of crashing.
import "./lib/offline-stores.js"; // per-process and file backends whatever the caller exports (see the file)
import { FINANCE_MATH_TOOLS } from "../src/tools/finance-math-kit.js";

let passed = 0;
let failed = 0;
const bySlug = Object.fromEntries(FINANCE_MATH_TOOLS.map((t) => [t.slug, t]));

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log("ok -", msg);
  } else {
    failed++;
    console.error("FAIL -", msg);
  }
}

function approxEq(a, b, eps = 0.01) {
  return Math.abs(a - b) < eps;
}

function throws(fn, statusCode, msg) {
  try {
    fn();
    failed++;
    console.error("FAIL - expected throw:", msg);
  } catch (e) {
    if (e.statusCode === statusCode) {
      passed++;
      console.log("ok -", msg, `(${e.message})`);
    } else {
      failed++;
      console.error("FAIL -", msg, "wrong statusCode:", e.statusCode, "msg:", e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// compound-interest
// ---------------------------------------------------------------------------
{
  const t = bySlug["compound-interest"];

  // Textbook: $1000 @ 5%/yr compounded monthly for 10y → $1647.01
  // Cross-check: Excel =FV(0.05/12, 120, 0, -1000) = 1647.009...
  const r1 = t.handler({ principal: 1000, annualRate: 0.05, years: 10, compoundingPerYear: 12 });
  ok(approxEq(r1.futureValue, 1647.01), "compound-interest: $1000@5%/12 for 10y → $1647.01");
  ok(approxEq(r1.totalInterest, 647.01), "compound-interest: totalInterest = FV - P");
  ok(approxEq(r1.effectiveAnnualRate, 0.051162, 0.0001), "compound-interest: APY for 5% nominal monthly ≈ 5.1162%");
  ok(r1.periods === 120, "compound-interest: periods = years × n");

  // Annual compounding: $100 @ 10% for 3y → $133.10
  const r2 = t.handler({ principal: 100, annualRate: 0.1, years: 3, compoundingPerYear: 1 });
  ok(approxEq(r2.futureValue, 133.10), "compound-interest: annual compounding $100@10%·3y → $133.10");
  ok(approxEq(r2.effectiveAnnualRate, 0.1, 1e-6), "compound-interest: annual APY = nominal rate");

  // Zero rate: FV = P
  const r3 = t.handler({ principal: 500, annualRate: 0, years: 5 });
  ok(r3.futureValue === 500, "compound-interest: 0% rate → FV = principal");
  ok(r3.totalInterest === 0, "compound-interest: 0% rate → 0 interest");

  // Error contracts
  throws(() => t.handler({ principal: -100, annualRate: 0.05, years: 5 }), 400, "compound-interest: negative principal rejected");
  throws(() => t.handler({ principal: 100, annualRate: 0.05, years: -1 }), 400, "compound-interest: negative years rejected");
  throws(() => t.handler({ principal: 100, annualRate: "abc", years: 5 }), 400, "compound-interest: non-numeric rate rejected");
}

// ---------------------------------------------------------------------------
// loan-payment
// ---------------------------------------------------------------------------
{
  const t = bySlug["loan-payment"];

  // Classic mortgage: $200k @ 6%/yr 30-year → $1199.10/mo
  // Excel =PMT(0.06/12, 360, -200000) = 1199.10...
  const r1 = t.handler({ principal: 200000, annualRate: 0.06, termYears: 30 });
  ok(approxEq(r1.payment, 1199.10), "loan-payment: $200k@6%/30y → $1199.10/mo");
  ok(r1.periods === 360, "loan-payment: 30y × 12/yr = 360 periods");
  // Tolerance is loose: r1.payment is rounded to cents for display, but the
  // handler computes totalPaid from the unrounded internal value. The two
  // can differ by ~$0.50 on a 360-period loan. Cents-vs-display is intentional.
  ok(approxEq(r1.totalPaid, r1.payment * 360, 1), "loan-payment: totalPaid ≈ displayed payment × periods (within $1 rounding band)");
  ok(approxEq(r1.totalInterest, r1.totalPaid - 200000), "loan-payment: totalInterest = totalPaid - principal");

  // Zero-rate degenerate case: $1200 over 12 mo = $100/mo
  const r2 = t.handler({ principal: 1200, annualRate: 0, termYears: 1 });
  ok(approxEq(r2.payment, 100), "loan-payment: 0% rate → payment = P/periods");
  ok(approxEq(r2.totalInterest, 0), "loan-payment: 0% rate → 0 interest");

  // Bi-weekly payments
  const r3 = t.handler({ principal: 10000, annualRate: 0.05, termYears: 2, paymentsPerYear: 26 });
  ok(r3.periods === 52, "loan-payment: 2y × 26/yr = 52 bi-weekly periods");
  ok(r3.payment > 0 && r3.payment < 10000, "loan-payment: bi-weekly payment is positive and < principal");

  // Errors
  throws(() => t.handler({ principal: 0, annualRate: 0.05, termYears: 5 }), 400, "loan-payment: zero principal rejected");
  throws(() => t.handler({ principal: 1000, annualRate: -0.01, termYears: 5 }), 400, "loan-payment: negative rate rejected");
  throws(() => t.handler({ principal: 1000, annualRate: 0.05, termYears: 5, paymentsPerYear: 0 }), 400, "loan-payment: zero paymentsPerYear rejected");
}

// ---------------------------------------------------------------------------
// amortization
// ---------------------------------------------------------------------------
{
  const t = bySlug["amortization"];

  // Same $200k loan: first month interest = 200000 × 0.06/12 = $1000
  const r1 = t.handler({ principal: 200000, annualRate: 0.06, termYears: 30, maxRows: 360 });
  ok(approxEq(r1.payment, 1199.10), "amortization: payment matches loan-payment");
  ok(r1.schedule.length === 360, "amortization: full 360-row schedule returned");
  ok(approxEq(r1.schedule[0].interest, 1000, 0.01), "amortization: row 1 interest = P × r/12");
  ok(approxEq(r1.schedule[0].principal, r1.payment - r1.schedule[0].interest, 0.02), "amortization: row 1 principal = payment - interest");
  ok(r1.schedule[359].balance === 0, "amortization: final balance clamped to exactly 0");
  ok(r1.schedule[359].period === 360, "amortization: last row is period 360");

  // Balance after k payments should monotonically decrease
  let monotone = true;
  for (let k = 1; k < r1.schedule.length; k++) {
    if (r1.schedule[k].balance > r1.schedule[k - 1].balance) monotone = false;
  }
  ok(monotone, "amortization: balance is monotonically non-increasing");

  // Interest tapers (later interest < earlier interest)
  ok(r1.schedule[0].interest > r1.schedule[100].interest, "amortization: interest tapers over the life of the loan");

  // maxRows preview
  const r2 = t.handler({ principal: 200000, annualRate: 0.06, termYears: 30, maxRows: 3 });
  ok(r2.schedule.length === 3, "amortization: maxRows=3 returns only first 3 rows");
  ok(r2.periods === 360, "amortization: maxRows preview still reports full period count");

  // Errors
  throws(() => t.handler({ principal: 100, annualRate: 0.05, termYears: 101 }), 400, "amortization: >100y monthly rejected (>1200 row cap)");
}

// ---------------------------------------------------------------------------
// npv
// ---------------------------------------------------------------------------
{
  const t = bySlug["npv"];

  // Classic capital-budgeting example: invest 1000 today, get 300/400/500/600
  // in years 1-4 at 10% discount rate. Cross-checked by hand:
  //   PV(t=0) = -1000
  //   PV(t=1) = 300/1.1 = 272.73
  //   PV(t=2) = 400/1.21 = 330.58
  //   PV(t=3) = 500/1.331 = 375.66
  //   PV(t=4) = 600/1.4641 = 409.81
  //   NPV = 388.78 (rounding accumulates to .77 in our 2dp output)
  const r1 = t.handler({ cashflows: [-1000, 300, 400, 500, 600], discountRate: 0.1 });
  ok(approxEq(r1.npv, 388.77), "npv: classic 4-year example @ 10% → $388.77");
  ok(approxEq(r1.presentValues[0], -1000), "npv: t=0 cashflow is undiscounted");
  ok(approxEq(r1.presentValues[1], 272.73), "npv: t=1 PV = 300/1.1");
  ok(approxEq(r1.presentValues[4], 409.81), "npv: t=4 PV = 600/1.1^4");
  ok(r1.undiscountedSum === 800, "npv: undiscountedSum = sum of cashflows");

  // Zero discount rate: NPV = sum of cashflows
  const r2 = t.handler({ cashflows: [-100, 50, 70], discountRate: 0 });
  ok(approxEq(r2.npv, 20), "npv: 0% rate → NPV = undiscounted sum");

  // High rate makes NPV negative even though sum is positive
  const r3 = t.handler({ cashflows: [-1000, 300, 400, 500, 600], discountRate: 0.5 });
  ok(r3.npv < 0, "npv: very high discount rate makes positive-sum cashflows NPV-negative");

  // Errors
  throws(() => t.handler({ cashflows: [100], discountRate: 0.1 }), 400, "npv: single-element array rejected");
  throws(() => t.handler({ cashflows: [-100, 50], discountRate: -1.5 }), 400, "npv: discount rate <= -1 rejected");
  throws(() => t.handler({ cashflows: "abc", discountRate: 0.1 }), 400, "npv: non-array cashflows rejected");
}

// ---------------------------------------------------------------------------
// irr
// ---------------------------------------------------------------------------
{
  const t = bySlug["irr"];

  // Same classic example. With cashflows [-1000, 300, 400, 500, 600] starting
  // at t=0, the IRR is ≈ 24.89% (cross-check: NPV at this rate = 0).
  const r1 = t.handler({ cashflows: [-1000, 300, 400, 500, 600] });
  ok(r1.converged === true, "irr: classic example converges");
  ok(approxEq(r1.irr, 0.2489, 0.001), "irr: classic 4-year example → ~24.89%");
  ok(approxEq(r1.npvAtIrr, 0, 0.01), "irr: NPV at returned IRR is ~0");

  // Verify by plugging IRR back into NPV
  const npvTool = bySlug["npv"];
  const verify = npvTool.handler({ cashflows: [-1000, 300, 400, 500, 600], discountRate: r1.irr });
  ok(Math.abs(verify.npv) < 0.5, "irr: round-trip NPV at IRR is near zero");

  // Trivial case: -100 today, 110 next period → IRR = 10%
  const r2 = t.handler({ cashflows: [-100, 110] });
  ok(approxEq(r2.irr, 0.1, 1e-6), "irr: -100 today, +110 next period → 10%");

  // Errors: all positive (no negative cashflow) means no IRR
  throws(() => t.handler({ cashflows: [100, 200, 300] }), 400, "irr: all-positive cashflows rejected (no sign change)");
  throws(() => t.handler({ cashflows: [-100, -200] }), 400, "irr: all-negative cashflows rejected");
}

// ---- black-scholes (vs textbook + put-call parity) ----
{
  const t = bySlug["black-scholes"];
  const call = t.handler({ type: "call", spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.2 });
  ok(approxEq(call.price, 10.4506, 0.001), "black-scholes: ATM call 100/100/1/5%/20% ≈ 10.4506 (textbook)");
  ok(approxEq(call.delta, 0.6368, 0.001), "black-scholes: call delta ≈ 0.6368");
  const put = t.handler({ type: "put", spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.2 });
  ok(approxEq(call.price - put.price, 100 - 100 * Math.exp(-0.05), 0.01), "black-scholes: put-call parity C - P = S - K·e^(-rT)");
  throws(() => t.handler({ type: "swap", spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.2 }), 400, "black-scholes: invalid type rejected");
  throws(() => t.handler({ type: "call", spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0 }), 400, "black-scholes: zero volatility rejected");
}

// ---- bond-price / bond-ytm (round-trip + par identity) ----
{
  const bp = bySlug["bond-price"].handler({ faceValue: 1000, couponRate: 0.05, yieldToMaturity: 0.06, years: 10, periodsPerYear: 2 });
  ok(approxEq(bp.price, 925.61, 0.01), "bond-price: 5% coupon @ 6% YTM, 10y semi ≈ 925.61");
  ok(bp.premiumOrDiscount === "discount", "bond-price: below par → discount");
  const ytm = bySlug["bond-ytm"].handler({ price: 925.61, faceValue: 1000, couponRate: 0.05, years: 10, periodsPerYear: 2 });
  ok(approxEq(ytm.yieldToMaturity, 0.06, 1e-4), "bond-ytm: inverts bond-price back to ~6%");
  const par = bySlug["bond-ytm"].handler({ price: 1000, faceValue: 1000, couponRate: 0.05, years: 10, periodsPerYear: 2 });
  ok(approxEq(par.yieldToMaturity, 0.05, 1e-4), "bond-ytm: par price → YTM equals coupon");
}

// ---- cagr ----
{
  const t = bySlug["cagr"];
  ok(approxEq(t.handler({ beginValue: 1000, endValue: 2000, years: 5 }).cagr, 0.148698, 1e-5), "cagr: doubling over 5y ≈ 14.87%");
  ok(approxEq(t.handler({ beginValue: 100, endValue: 100, years: 3 }).cagr, 0, 1e-9), "cagr: no change → 0%");
  throws(() => t.handler({ beginValue: -1, endValue: 2, years: 5 }), 400, "cagr: non-positive begin rejected");
}

// ---- sharpe-ratio ----
{
  const t = bySlug["sharpe-ratio"];
  ok(approxEq(t.handler({ returns: [0.1, 0.05, 0.15, -0.02, 0.08], riskFreeRate: 0.02 }).sharpe, 0.825293, 1e-5), "sharpe-ratio: sample Sharpe ≈ 0.8253");
  ok(approxEq(t.handler({ returns: [0.1, 0.05, 0.15, -0.02, 0.08], riskFreeRate: 0.02, periodsPerYear: 12 }).annualizedSharpe, 0.825293 * Math.sqrt(12), 1e-4), "sharpe-ratio: annualized × sqrt(12)");
  throws(() => t.handler({ returns: [0.05, 0.05, 0.05] }), 400, "sharpe-ratio: zero-variance returns rejected");
}

// ---- annuity ----
{
  const t = bySlug["annuity"];
  const o = t.handler({ payment: 100, ratePerPeriod: 0.05, periods: 10, type: "ordinary" });
  ok(approxEq(o.presentValue, 772.17, 0.01) && approxEq(o.futureValue, 1257.79, 0.01), "annuity: ordinary PV 772.17 / FV 1257.79");
  ok(approxEq(t.handler({ payment: 100, ratePerPeriod: 0.05, periods: 10, type: "due" }).presentValue, 772.17 * 1.05, 0.02), "annuity: due = ordinary × (1+r)");
}

// ---- break-even ----
{
  const t = bySlug["break-even"];
  const be = t.handler({ fixedCost: 10000, pricePerUnit: 50, variableCostPerUnit: 30 });
  ok(be.breakEvenUnits === 500 && be.breakEvenRevenue === 25000, "break-even: 500 units / $25k revenue");
  throws(() => t.handler({ fixedCost: 10000, pricePerUnit: 30, variableCostPerUnit: 30 }), 400, "break-even: non-positive margin rejected");
}

// ---- effective-annual-rate ----
{
  const t = bySlug["effective-annual-rate"];
  ok(approxEq(t.handler({ nominalAnnualRate: 0.12, compoundingPerYear: 12 }).effectiveAnnualRate, 0.126825, 1e-5), "EAR: 12% APR monthly → 12.6825%");
  ok(approxEq(t.handler({ nominalAnnualRate: 0.12, continuous: true }).effectiveAnnualRate, Math.exp(0.12) - 1, 1e-6), "EAR: continuous → e^0.12 - 1");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
