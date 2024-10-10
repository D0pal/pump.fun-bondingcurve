import dotenv from 'dotenv';
import { formatPercent } from '../';

dotenv.config();

const BONDING_CURVE_MIN_PERCENT = parseFloat(process.env.BONDING_CURVE_MIN_PERCENT ?? '0');
const BONDING_CURVE_MAX_PERCENT = parseFloat(process.env.BONDING_CURVE_MAX_PERCENT ?? '100');

interface CheckResult {
  ok: boolean;
  message: string;
}

const checkBondingCurve = (bondingCurvePercentage: number): CheckResult => {
  const message = `Bonding Curve Percentage: ${formatPercent(bondingCurvePercentage)} vs SOL Range: ${formatPercent(BONDING_CURVE_MIN_PERCENT)} - ${formatPercent(BONDING_CURVE_MAX_PERCENT)}`;

  if (bondingCurvePercentage < BONDING_CURVE_MIN_PERCENT) {
    return { ok: false, message: `Bonding curve percentage is below the minimum threshold -> ${message}.` };
  } else if (bondingCurvePercentage > BONDING_CURVE_MAX_PERCENT) {
    return { ok: false, message: `Bonding curve percentage exceeds the maximum threshold -> ${message}.` };
  } else {
    return { ok: true, message: `Bonding curve percentage is within the range -> ${message}.` };
  }
}

export const bondingCurveFilter = async (percentage: number): Promise<CheckResult> => {
  return checkBondingCurve(percentage ?? 0);
}


