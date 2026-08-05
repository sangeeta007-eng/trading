require('dotenv').config();

const TOTAL_BUDGET   = parseFloat(process.env.TOTAL_BUDGET) || 25000;
const RISK_FREE_RATE = 0.045;

// VIX regime table — gates/sizes new recommendations in agent3_risk.js
const REGIMES = {
  RISK_ON: {
    name: 'Risk-ON',
    vixMax: 22,
    weeklyTargetLow: 700,
    weeklyTargetHigh: 1000,
    sizingMod: 1.0,
    maxNewPerDay: Infinity,
    allowBullish: true,
    allowBearish: true,
  },
  RISK_OFF: {
    name: 'Risk-OFF',
    vixMin: 22,
    vixMax: 35,
    weeklyTargetLow: 300,
    weeklyTargetHigh: 600,
    sizingMod: 0.50,
    maxNewPerDay: 2,
    allowBullish: true,
    allowBearish: true,
  },
  EXTREME: {
    name: 'Extreme Risk',
    vixMin: 35,
    weeklyTargetLow: 0,
    weeklyTargetHigh: 0,
    sizingMod: 0.0,
    maxNewPerDay: 0,
    allowBullish: false,
    allowBearish: false,
  },
};

function getRegimeByVix(vix) {
  if (vix > 35) return REGIMES.EXTREME;
  if (vix >= 22) return REGIMES.RISK_OFF;
  return REGIMES.RISK_ON;
}

module.exports = {
  TOTAL_BUDGET, RISK_FREE_RATE,
  REGIMES, getRegimeByVix,
};
