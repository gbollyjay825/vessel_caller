/* Calabar Port — Analytics dataset
   12 months of cargo throughput & revenue, split liquid (PMS/AGO/DPK)
   vs dry/bulk (wheat, fertiliser, clinker, sugar). Reconstructed mock
   figures with a realistic upward trend for the analytics screen. */

const AN_MONTHS = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const AN_YEARS  = ['2025','2025','2025','2025','2025','2025','2026','2026','2026','2026','2026','2026'];

// monthly tonnage (MT)
const LIQ_T = [212, 198, 234, 251, 268, 295, 277, 289, 312, 305, 328, 341].map((n) => n * 1000);
const DRY_T = [128, 141, 119, 156, 162, 171, 149, 158, 167, 181, 174, 189].map((n) => n * 1000);
// monthly revenue (USD)
const LIQ_R = [428, 405, 472, 503, 538, 591, 556, 579, 624, 611, 657, 684].map((n) => n * 1000);
const DRY_R = [196, 214, 182, 238, 247, 261, 228, 241, 255, 276, 266, 289].map((n) => n * 1000);
// monthly vessel calls
const CALLS_M = [29, 27, 31, 33, 35, 38, 34, 33, 37, 39, 41, 44];

const AN_SERIES = AN_MONTHS.map((m, i) => ({
  month: m, year: AN_YEARS[i],
  liquidT: LIQ_T[i], dryT: DRY_T[i],
  liquidR: LIQ_R[i], dryR: DRY_R[i],
  calls: CALLS_M[i],
}));

const sum = (a) => a.reduce((x, y) => x + y, 0);
const totalLiqT = sum(LIQ_T), totalDryT = sum(DRY_T);
const totalLiqR = sum(LIQ_R), totalDryR = sum(DRY_R);

// product mix — share of each category's total tonnage
const PRODUCTS = [
  { key: 'PMS',        label: 'PMS (Petrol)',  cat: 'Liquid', color: '#1B5FAA', share: 0.55 },
  { key: 'AGO',        label: 'AGO (Diesel)',  cat: 'Liquid', color: '#2F84E3', share: 0.30 },
  { key: 'DPK',        label: 'DPK (Kerosene)',cat: 'Liquid', color: '#7FB4EC', share: 0.15 },
  { key: 'Wheat',      label: 'Wheat',         cat: 'Dry',    color: '#C2871D', share: 0.38 },
  { key: 'Fertiliser', label: 'Fertiliser',    cat: 'Dry',    color: '#E0A21A', share: 0.27 },
  { key: 'Clinker',    label: 'Clinker',       cat: 'Dry',    color: '#9AA3B0', share: 0.20 },
  { key: 'Sugar',      label: 'Sugar',         cat: 'Dry',    color: '#EBCB7C', share: 0.15 },
].map((p) => {
  const catT = p.cat === 'Liquid' ? totalLiqT : totalDryT;
  const catR = p.cat === 'Liquid' ? totalLiqR : totalDryR;
  return { ...p, tonnage: Math.round(catT * p.share), revenue: Math.round(catR * p.share) };
});

const PMS = PRODUCTS.find((p) => p.key === 'PMS');

const AN_TOTALS = {
  throughput: totalLiqT + totalDryT,
  revenue: totalLiqR + totalDryR,
  liquidT: totalLiqT, dryT: totalDryT,
  liquidR: totalLiqR, dryR: totalDryR,
  calls: sum(CALLS_M),
  pmsTonnage: PMS.tonnage, pmsRevenue: PMS.revenue,
  pmsShareOfThroughput: PMS.tonnage / (totalLiqT + totalDryT),
};

Object.assign(window, { AN_MONTHS, AN_SERIES, PRODUCTS, AN_TOTALS });
