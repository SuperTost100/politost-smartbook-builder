/** The 118 elements with their place in the standard 18-column periodic table. */
export interface Element {
  symbol: string;
  z: number;
  period: number;
  /** Column 1-18; null for the lanthanides (La-Yb) and actinides (Ac-No), which sit in the f-block rows. */
  group: number | null;
  /** 1 for lanthanides, 2 for actinides, null elsewhere. */
  fRow: 1 | 2 | null;
}

const SYMBOLS =
  'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr ' +
  'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu ' +
  'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr ' +
  'Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og';

/** Period lengths up to the end of each period, by atomic number. */
const PERIOD_END = [2, 10, 18, 36, 54, 86, 118];

function build(): Element[] {
  return SYMBOLS.split(' ').map((symbol, i) => {
    const z = i + 1;
    const period = PERIOD_END.findIndex((end) => z <= end) + 1;
    const start = period === 1 ? 1 : PERIOD_END[period - 2] + 1;
    const k = z - start; // position within the period
    const fRow = z >= 57 && z <= 70 ? 1 : z >= 89 && z <= 102 ? 2 : null;
    let group: number | null;
    if (fRow) group = null;
    else if (period === 1) group = k === 0 ? 1 : 18;
    else if (period <= 3) group = k < 2 ? k + 1 : k + 11;
    else if (period <= 5) group = k + 1;
    else group = z > (period === 6 ? 70 : 102) ? z - (period === 6 ? 71 : 103) + 3 : k + 1;
    return { symbol, z, period, group, fRow: fRow as 1 | 2 | null };
  });
}

export const ELEMENTS: readonly Element[] = build();

const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));

export const elementBySymbol = (symbol: string): Element | undefined => BY_SYMBOL.get(symbol);

/** The correctly capitalised symbol for "NA" or "na", or undefined when there is none. */
export function suggestSymbol(text: string): string | undefined {
  const fixed = text.length ? text[0].toUpperCase() + text.slice(1).toLowerCase() : text;
  return BY_SYMBOL.has(fixed) ? fixed : undefined;
}

export interface Species {
  symbol: string;
  z: number;
  charge: number;
}

/**
 * Reads a species such as "O", "Fe3+", "Fe^3+", "Cl-", "Cu^2+", "Fe^{3+}", "O2-" or "Na+". Returns null when the text
 * is not an element symbol with an optional charge.
 */
export function parseSpecies(text: string): Species | null {
  const m = /^([A-Z][a-z]?)(?:\^?\{?(?:(\d*)([+\-−])|([+\-−])(\d+))\}?)?$/.exec(text.trim());
  if (!m) return null;
  const el = BY_SYMBOL.get(m[1]);
  if (!el) return null;
  let charge = 0;
  if (m[3]) charge = (m[2] ? Number(m[2]) : 1) * (m[3] === '+' ? 1 : -1);
  else if (m[4]) charge = Number(m[5]) * (m[4] === '+' ? 1 : -1);
  return { symbol: el.symbol, z: el.z, charge };
}
