// EU VAT number format and check-digit rules, offline.
//
// Pure CPU: no network, no registry, no key. Each rule below implements the
// national number's published structure and check-digit algorithm as the
// member state's tax administration describes it (the basis is named beside
// each rule). A number that passes is well formed; whether it is registered or
// active is a different question this module never asks.
//
// checkVat(national, code) takes the national part (prefix already removed,
// separators already stripped, upper case) and returns
//   { format: bool, checksum: true | false | null, kind?, reason? }
// where checksum is null for a number type that carries no check digit.

export const VAT_COUNTRIES = Object.freeze({
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DK: "Denmark", EE: "Estonia", EL: "Greece", ES: "Spain",
  FI: "Finland", FR: "France", HR: "Croatia", HU: "Hungary", IE: "Ireland",
  IT: "Italy", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", MT: "Malta",
  NL: "Netherlands", PL: "Poland", PT: "Portugal", RO: "Romania", SE: "Sweden",
  SI: "Slovenia", SK: "Slovakia", XI: "Northern Ireland",
});

// ISO 3166 code GR is accepted for Greece, whose VAT prefix is EL.
export const VAT_ALIASES = Object.freeze({ GR: "EL" });

export function vatCode(code) {
  const c = String(code).toUpperCase();
  const canon = VAT_ALIASES[c] || c;
  return Object.prototype.hasOwnProperty.call(VAT_COUNTRIES, canon) ? canon : null;
}

// ---- shared helpers ---------------------------------------------------------
const isDigits = (s) => s.length > 0 && /^[0-9]+$/.test(s);
const d = (s, i) => s.charCodeAt(i) - 48;
const mod = (a, m) => ((a % m) + m) % m;
const weighted = (s, weights) => {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i] * d(s, i);
  return sum;
};
// Remainder of a decimal string by m, digit by digit (no precision loss).
const strMod = (s, m) => {
  let r = 0;
  for (let i = 0; i < s.length; i++) r = (r * 10 + d(s, i)) % m;
  return r;
};
// Luhn (ISO/IEC 7812-1 annex B): the sum mod 10 of the digits, every second
// one from the right doubled and its digits added.
const luhnSum = (s) => {
  let sum = 0;
  for (let i = s.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
    let v = d(s, i);
    if (dbl) { v *= 2; if (v > 9) v -= 9; }
    sum += v;
  }
  return sum % 10;
};
// ISO 7064 MOD 11,10 (hybrid system): true when the full string checks.
const mod11_10 = (s) => {
  let p = 10;
  for (let i = 0; i < s.length - 1; i++) {
    let t = (p + d(s, i)) % 10;
    if (t === 0) t = 10;
    p = (t * 2) % 11;
  }
  return (p + d(s, s.length - 1)) % 10 === 1;
};
// ISO 7064 MOD 97-10 over an alphanumeric string (A=10 .. Z=35).
const mod97_10 = (s) => {
  let r = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c >= 65 ? String(c - 55) : String(c - 48);
    for (let j = 0; j < v.length; j++) r = (r * 10 + (v.charCodeAt(j) - 48)) % 97;
  }
  return r === 1;
};
const validDate = (y, m, day) => {
  if (m < 1 || m > 12 || day < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return day <= last;
};

const ok = (checksum, kind) => ({ format: true, checksum, ...(kind ? { kind } : {}) });
const badFormat = (reason) => ({ format: false, checksum: null, reason });
const sum = (passed, kind) => passed ? ok(true, kind) : { format: true, checksum: false, ...(kind ? { kind } : {}), reason: "Check digit does not match" };

// ---- per country --------------------------------------------------------------
const RULES = {
  // Austria, UID: "U" + 8 digits. Check digit per the Federal Ministry of
  // Finance description: weights 1,2,1,2,1,2,1 on digits 1-7 (products of 2
  // reduced to their digit sum), check = (10 - (S + 4) mod 10) mod 10.
  AT(n) {
    if (!/^U[0-9]{8}$/.test(n)) return badFormat("Expected U followed by 8 digits");
    return sum((6 - luhnSum(n.slice(1, 8)) + 10) % 10 === d(n, 8));
  },
  // Belgium, enterprise number: 10 digits starting 0 or 1 (a 9-digit number
  // gets a leading 0). Check: last two digits = 97 - (first 8 mod 97).
  BE(n) {
    if (/^[0-9]{9}$/.test(n)) n = "0" + n;
    if (!/^[01][0-9]{9}$/.test(n)) return badFormat("Expected 10 digits starting with 0 or 1");
    return sum((strMod(n.slice(0, 8), 97) + Number(n.slice(8))) % 97 === 0);
  },
  // Bulgaria: 9 digits (legal entity, BULSTAT: weights 1-8 mod 11, on 10
  // weights 3-10 mod 11, 10 -> 0) or 10 digits (natural person EGN with
  // weights 2,4,8,5,10,9,7,3,6 and a valid birth date; foreigner PNF with
  // weights 21,19,17,13,11,9,7,3,1 mod 10; other with 4,3,2,7,6,5,4,3,2 and
  // 11 - S mod 11).
  BG(n) {
    if (/^[0-9]{9}$/.test(n)) {
      let c = 0;
      for (let i = 0; i < 8; i++) c += (i + 1) * d(n, i);
      c %= 11;
      if (c === 10) { c = 0; for (let i = 0; i < 8; i++) c += (i + 3) * d(n, i); c %= 11; }
      return sum(c % 10 === d(n, 8), "legal entity");
    }
    if (/^[0-9]{10}$/.test(n)) {
      const last = d(n, 9);
      let y = 1900 + Number(n.slice(0, 2)), m = Number(n.slice(2, 4));
      const day = Number(n.slice(4, 6));
      if (m > 40) { y += 100; m -= 40; } else if (m > 20) { y -= 100; m -= 20; }
      if (validDate(y, m, day) && weighted(n, [2, 4, 8, 5, 10, 9, 7, 3, 6]) % 11 % 10 === last) return ok(true, "natural person");
      if (weighted(n, [21, 19, 17, 13, 11, 9, 7, 3, 1]) % 10 === last) return ok(true, "foreign natural person");
      const other = mod(11 - weighted(n, [4, 3, 2, 7, 6, 5, 4, 3, 2]), 11);
      return sum(other === last, "other");
    }
    return badFormat("Expected 9 or 10 digits");
  },
  // Cyprus: 8 digits + check letter; the first two digits are never 12.
  // Digits in odd positions map 0-9 to 1,0,5,7,9,13,15,17,19,21; even
  // positions count as themselves; letter = A + (sum mod 26).
  CY(n) {
    if (!/^[0-9]{8}[A-Z]$/.test(n)) return badFormat("Expected 8 digits followed by a letter");
    if (n.startsWith("12")) return badFormat("A Cyprus VAT number does not start with 12");
    const odd = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21];
    let s = 0;
    for (let i = 0; i < 8; i++) s += i % 2 === 0 ? odd[d(n, i)] : d(n, i);
    return sum(String.fromCharCode(65 + (s % 26)) === n[8]);
  },
  // Czechia, DIC: 8 digits (legal entity, first digit not 9: weights 8-2,
  // c = (11 - S) mod 11, 0 -> 1, then mod 10); 9 digits starting 6 (special
  // individual: weights 8-2 over digits 2-8); 10 digits (birth number: the
  // number is divisible by 11, or the first 9 mod 11 is 10 and the last is 0);
  // 9 digits otherwise (birth number issued before 1954: no check digit).
  CZ(n) {
    if (/^[0-9]{8}$/.test(n)) {
      if (n[0] === "9") return badFormat("An 8-digit Czech number does not start with 9");
      const c = mod(11 - weighted(n, [8, 7, 6, 5, 4, 3, 2]), 11);
      return sum((c || 1) % 10 === d(n, 7), "legal entity");
    }
    if (/^6[0-9]{8}$/.test(n)) {
      const c = weighted(n.slice(1), [8, 7, 6, 5, 4, 3, 2]) % 11;
      return sum(mod(8 - mod(10 - c, 11), 10) === d(n, 8), "special individual");
    }
    if (/^[0-9]{9,10}$/.test(n)) {
      let y = 1900 + Number(n.slice(0, 2));
      const m = Number(n.slice(2, 4)) % 50 % 20;
      const day = Number(n.slice(4, 6));
      if (n.length === 9) {
        if (y >= 1980) y -= 100;
        if (y > 1953) return badFormat("9-digit Czech birth numbers end with 1953");
      } else if (y < 1954) y += 100;
      if (!validDate(y, m, day)) return badFormat("The birth number does not hold a valid date");
      if (n.length === 9) return ok(null, "natural person (birth number before 1954, no check digit)");
      return sum(strMod(n.slice(0, 9), 11) % 10 === d(n, 9), "natural person");
    }
    return badFormat("Expected 8, 9 or 10 digits");
  },
  // Germany, USt-IdNr: 9 digits, first not 0; ISO 7064 MOD 11,10.
  DE(n) {
    if (!/^[1-9][0-9]{8}$/.test(n)) return badFormat("Expected 9 digits not starting with 0");
    return sum(mod11_10(n));
  },
  // Denmark, CVR: 8 digits, first not 0; weights 2,7,6,5,4,3,2,1, sum mod 11 = 0.
  DK(n) {
    if (!/^[1-9][0-9]{7}$/.test(n)) return badFormat("Expected 8 digits not starting with 0");
    return sum(weighted(n, [2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0);
  },
  // Estonia, KMKR: 9 digits; weights 3,7,1 repeating, sum mod 10 = 0.
  EE(n) {
    if (!/^[0-9]{9}$/.test(n)) return badFormat("Expected 9 digits");
    return sum(weighted(n, [3, 7, 1, 3, 7, 1, 3, 7, 1]) % 10 === 0);
  },
  // Greece, AFM: 9 digits (8-digit form gets a leading 0); check digit =
  // (sum of digit i * 2^(8-i) for the first 8) mod 11 mod 10.
  EL(n) {
    if (/^[0-9]{8}$/.test(n)) n = "0" + n;
    if (!/^[0-9]{9}$/.test(n)) return badFormat("Expected 9 digits");
    let c = 0;
    for (let i = 0; i < 8; i++) c = c * 2 + d(n, i);
    return sum((c * 2) % 11 % 10 === d(n, 8));
  },
  // Spain, NIF: DNI (8 digits + letter from TRWAGMYFPDXBNJZSQVHLCKE by mod 23),
  // NIE (X/Y/Z read as 0/1/2, then the DNI rule), K/L/M + 7 digits + DNI
  // letter, or CIF (entity letter + 7 digits + control digit or letter, from
  // the Luhn check digit of the 7 digits; letter = JABCDEFGHI[digit]).
  ES(n) {
    const letters = "TRWAGMYFPDXBNJZSQVHLCKE";
    if (/^[0-9]{8}[A-Z]$/.test(n)) return sum(letters[strMod(n.slice(0, 8), 23)] === n[8], "natural person (DNI)");
    if (/^[XYZ][0-9]{7}[A-Z]$/.test(n)) return sum(letters[strMod("XYZ".indexOf(n[0]) + n.slice(1, 8), 23)] === n[8], "foreign natural person (NIE)");
    if (/^[KLM][0-9]{7}[A-Z]$/.test(n)) return sum(letters[strMod(n.slice(1, 8), 23)] === n[8], "natural person (K/L/M)");
    if (/^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(n)) {
      const digit = (10 - luhnSum(n.slice(1, 8) + "0")) % 10;
      return sum(n[8] === String(digit) || n[8] === "JABCDEFGHI"[digit], "legal entity (CIF)");
    }
    return badFormat("Expected a DNI, NIE or CIF shape (9 characters)");
  },
  // Finland, ALV: 8 digits; weights 7,9,10,5,8,4,2,1, sum mod 11 = 0.
  FI(n) {
    if (!/^[0-9]{8}$/.test(n)) return badFormat("Expected 8 digits");
    return sum(weighted(n, [7, 9, 10, 5, 8, 4, 2, 1]) % 11 === 0);
  },
  // France, TVA: 2-character key + 9-digit SIREN. The SIREN carries a Luhn
  // check (Monaco numbers, SIREN starting 000, do not). A numeric key equals
  // (12 + 3 * (SIREN mod 97)) mod 97; an alphanumeric key (alphabet
  // 0-9 A-Z without I and O) follows the published key formula.
  FR(n) {
    const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    if (n.length !== 11 || alphabet.indexOf(n[0]) < 0 || alphabet.indexOf(n[1]) < 0 || !isDigits(n.slice(2))) {
      return badFormat("Expected a 2-character key followed by a 9-digit SIREN");
    }
    const siren = n.slice(2);
    if (!siren.startsWith("000") && luhnSum(siren) !== 0) return sum(false);
    if (isDigits(n.slice(0, 2))) return sum(Number(n.slice(0, 2)) === strMod(siren + "12", 97));
    const check = isDigits(n[0])
      ? alphabet.indexOf(n[0]) * 24 + alphabet.indexOf(n[1]) - 10
      : alphabet.indexOf(n[0]) * 34 + alphabet.indexOf(n[1]) - 100;
    return sum((strMod(siren, 11) + 1 + Math.floor(check / 11)) % 11 === check % 11);
  },
  // Croatia, OIB: 11 digits; ISO 7064 MOD 11,10.
  HR(n) {
    if (!/^[0-9]{11}$/.test(n)) return badFormat("Expected 11 digits");
    return sum(mod11_10(n));
  },
  // Hungary, ANUM: 8 digits; weights 9,7,3,1 repeating, sum mod 10 = 0.
  HU(n) {
    if (!/^[0-9]{8}$/.test(n)) return badFormat("Expected 8 digits");
    return sum(weighted(n, [9, 7, 3, 1, 9, 7, 3, 1]) % 10 === 0);
  },
  // Ireland: 7 digits + check letter (+ an optional second letter, which
  // counts with weight 9; W = 0, A = 1 ...), weights 8-2 on the digits, letter
  // = WABCDEFGHIJKLMNOPQRSTUV[S mod 23]. The older form (digit, letter or + or
  // *, 5 digits, check letter) reads as 0 + digits 3-7 + digit 1.
  IE(n) {
    const alphabet = "WABCDEFGHIJKLMNOPQRSTUV";
    const letterFor = (digits7, extra) => {
      let s = 9 * (extra ? alphabet.indexOf(extra) : 0);
      for (let i = 0; i < 7; i++) s += (8 - i) * d(digits7, i);
      return alphabet[s % 23];
    };
    if (/^[0-9]{7}[A-W]{1,2}$/.test(n)) {
      return sum(letterFor(n.slice(0, 7), n[8]) === n[7]);
    }
    if (/^[0-9][A-Z+*][0-9]{5}[A-W]$/.test(n)) {
      return sum(letterFor("0" + n.slice(2, 7) + n[0]) === n[7], "older format");
    }
    return badFormat("Expected 7 digits and 1 or 2 letters, or the older 8-character form");
  },
  // Italy, Partita IVA: 11 digits; first 7 not all zero; digits 8-10 an office
  // code (001-100, 120, 121, 888, 999); Luhn over all 11.
  IT(n) {
    if (!/^[0-9]{11}$/.test(n)) return badFormat("Expected 11 digits");
    if (/^0{7}/.test(n)) return badFormat("The first 7 digits are all zero");
    const office = Number(n.slice(7, 10));
    if (!((office >= 1 && office <= 100) || [120, 121, 888, 999].includes(office))) return badFormat("Digits 8-10 are not an office code");
    return sum(luhnSum(n) === 0);
  },
  // Lithuania, PVM: 9 digits (8th is 1) or 12 digits (11th is 1). Weights
  // 1-9 repeating, mod 11; on 10, weights 3-9,1,2 repeating; 10 -> 0.
  LT(n) {
    if (!(/^[0-9]{7}1[0-9]$/.test(n) || /^[0-9]{10}1[0-9]$/.test(n))) {
      return badFormat("Expected 9 digits with 1 in position 8, or 12 digits with 1 in position 11");
    }
    const body = n.slice(0, -1);
    let c = 0;
    for (let i = 0; i < body.length; i++) c += (1 + (i % 9)) * d(body, i);
    c %= 11;
    if (c === 10) { c = 0; for (let i = 0; i < body.length; i++) c += (1 + ((i + 2) % 9)) * d(body, i); c %= 11; }
    return sum(c % 10 === d(n, n.length - 1), n.length === 9 ? "legal entity" : "natural person or temporary taxpayer");
  },
  // Luxembourg, TVA: 8 digits; last two = first six mod 89.
  LU(n) {
    if (!/^[0-9]{8}$/.test(n)) return badFormat("Expected 8 digits");
    return sum(Number(n.slice(0, 6)) % 89 === Number(n.slice(6)));
  },
  // Latvia, PVN: 11 digits. Legal entity (first digit above 3): weights
  // 9,1,4,8,3,10,2,5,7,6,1, sum mod 11 = 3. Natural person (personal code,
  // with a birth date DDMMYY + century digit, or starting 32 since 2017):
  // check = (1101 - (1,6,3,7,9,10,5,8,4,2 weighted)) mod 11, 10 -> 0.
  LV(n) {
    if (!/^[0-9]{11}$/.test(n)) return badFormat("Expected 11 digits");
    if (n[0] > "3") return sum(weighted(n, [9, 1, 4, 8, 3, 10, 2, 5, 7, 6, 1]) % 11 === 3, "legal entity");
    if (!n.startsWith("32")) {
      const y = 1800 + Number(n[6]) * 100 + Number(n.slice(4, 6));
      if (!validDate(y, Number(n.slice(2, 4)), Number(n.slice(0, 2)))) return badFormat("The personal code does not hold a valid date");
    }
    return sum(mod(1101 - weighted(n, [1, 6, 3, 7, 9, 10, 5, 8, 4, 2]), 11) % 10 === d(n, 10), "natural person");
  },
  // Malta: 8 digits, first not 0; weights 3,4,6,7,8,9 on the first six plus
  // the last two read as one number, sum mod 37 = 0.
  MT(n) {
    if (!/^[1-9][0-9]{7}$/.test(n)) return badFormat("Expected 8 digits not starting with 0");
    return sum(weighted(n, [3, 4, 6, 7, 8, 9, 10, 1]) % 37 === 0);
  },
  // Netherlands, btw-id: 9 digits + B + 2 digits (not 00). Checks with the
  // 11-test on the 9 digits (weights 9-2, then -1, mod 11 = 0) or, for the
  // numbers issued since 2020, ISO 7064 MOD 97-10 over "NL" + the number.
  NL(n) {
    if (!/^[0-9]{9}B[0-9]{2}$/.test(n) || /^0{9}/.test(n) || n.endsWith("00")) return badFormat("Expected 9 digits, B, and 2 digits");
    const eleven = mod(weighted(n, [9, 8, 7, 6, 5, 4, 3, 2]) - d(n, 8), 11) === 0;
    return sum(eleven || mod97_10("NL" + n));
  },
  // Poland, NIP: 10 digits; weights 6,5,7,2,3,4,5,6,7, sum mod 11 = check (10 never issued).
  PL(n) {
    if (!/^[0-9]{10}$/.test(n)) return badFormat("Expected 10 digits");
    return sum(weighted(n, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11 === d(n, 9));
  },
  // Portugal, NIF: 9 digits, first not 0; weights 9-2, check = (11 - S mod 11) mod 11 mod 10.
  PT(n) {
    if (!/^[1-9][0-9]{8}$/.test(n)) return badFormat("Expected 9 digits not starting with 0");
    return sum(mod(11 - weighted(n, [9, 8, 7, 6, 5, 4, 3, 2]), 11) % 10 === d(n, 8));
  },
  // Romania, CUI/CIF: 2-10 digits, first not 0; body left-padded to 9 digits,
  // weights 7,5,3,2,1,7,5,3,2, check = (10 * S) mod 11 mod 10.
  RO(n) {
    if (!/^[1-9][0-9]{1,9}$/.test(n)) return badFormat("Expected 2 to 10 digits not starting with 0");
    const body = n.slice(0, -1).padStart(9, "0");
    return sum((10 * weighted(body, [7, 5, 3, 2, 1, 7, 5, 3, 2])) % 11 % 10 === d(n, n.length - 1));
  },
  // Sweden, momsregistreringsnummer: 10-digit organisation number (Luhn) + 01.
  SE(n) {
    if (!/^[0-9]{10}01$/.test(n)) return badFormat("Expected 12 digits ending in 01");
    return sum(luhnSum(n.slice(0, 10)) === 0);
  },
  // Slovenia, ID za DDV: 8 digits, first not 0; weights 8-2, check = 11 - (S mod 11), 10 -> 0, 11 never issued.
  SI(n) {
    if (!/^[1-9][0-9]{7}$/.test(n)) return badFormat("Expected 8 digits not starting with 0");
    const c = 11 - (weighted(n, [8, 7, 6, 5, 4, 3, 2]) % 11);
    return sum(c !== 11 && c % 10 === d(n, 7));
  },
  // Slovakia, IC DPH: 10 digits, first not 0, third in 2,3,4,7,8,9; the
  // number is divisible by 11.
  SK(n) {
    if (!/^[1-9][0-9][234789][0-9]{7}$/.test(n)) return badFormat("Expected 10 digits, first not 0, third digit 2, 3, 4, 7, 8 or 9");
    return sum(strMod(n, 11) === 0);
  },
  // Northern Ireland (XI), UK VAT number rules: 9 digits (or 12 with a branch
  // suffix): weights 8,7,6,5,4,3,2,10,1 mod 97 = 0, or 42 / 55 for numbers
  // whose first three digits are 100 or more. Government departments (GD +
  // 3 digits under 500) and health authorities (HA + 3 digits from 500) carry
  // no check digit.
  XI(n) {
    if (/^GD[0-4][0-9]{2}$/.test(n)) return ok(null, "government department");
    if (/^HA[5-9][0-9]{2}$/.test(n)) return ok(null, "health authority");
    if (!/^[0-9]{9}([0-9]{3})?$/.test(n)) return badFormat("Expected 9 or 12 digits, or GD/HA + 3 digits");
    const r = weighted(n, [8, 7, 6, 5, 4, 3, 2, 10, 1]) % 97;
    const passed = Number(n.slice(0, 3)) >= 100 ? (r === 0 || r === 42 || r === 55) : r === 0;
    return sum(passed, n.length === 12 ? "branch" : undefined);
  },
};

export function checkVat(national, code) {
  return RULES[code](national);
}
