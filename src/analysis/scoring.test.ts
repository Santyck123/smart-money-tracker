import { describe, expect, it } from "vitest";
import {
  accumulationScore,
  DEFAULT_WEIGHTS,
  isBotTokenStats,
  recurrenceScore,
  scoreWallet,
  sizeScore,
  timingScore,
  type WalletTokenStats,
} from "./scoring.js";

const baseStats: WalletTokenStats = {
  hoursBeforePump: 12,
  minutesAfterDeploy: 120,
  buyCount: 1,
  dispersionHours: 0,
  supplyPctBought: 0.001,
};

describe("timingScore", () => {
  it("da más puntaje a compras más tempranas", () => {
    expect(timingScore(24, 120)).toBeGreaterThan(timingScore(2, 120));
  });

  it("satura en el horizonte de 48h", () => {
    expect(timingScore(48, 120)).toBe(1);
    expect(timingScore(100, 120)).toBe(1);
  });

  it("penaliza fuerte compras en la ventana sniper post-deploy", () => {
    const normal = timingScore(24, 60);
    const sniper = timingScore(24, 3);
    expect(sniper).toBeLessThan(normal * 0.2);
    expect(sniper).toBeGreaterThan(0); // penalizado, no eliminado
  });

  it("no penaliza si minutesAfterDeploy es desconocido (-1)", () => {
    expect(timingScore(24, -1)).toBe(timingScore(24, 120));
  });

  it("devuelve 0 con horas negativas o no finitas", () => {
    expect(timingScore(-5, 120)).toBe(0);
    expect(timingScore(Number.NaN, 120)).toBe(0);
  });
});

describe("sizeScore", () => {
  it("crece con el % de supply", () => {
    expect(sizeScore(0.01)).toBeGreaterThan(sizeScore(0.001));
  });

  it("normaliza con log: duplicar el tamaño no duplica el score", () => {
    const small = sizeScore(0.005);
    const double = sizeScore(0.01);
    expect(double).toBeLessThan(small * 2);
  });

  it("satura en el 2% del supply", () => {
    expect(sizeScore(0.02)).toBe(1);
    expect(sizeScore(0.5)).toBe(1);
  });

  it("devuelve 0 si no se conoce el supply", () => {
    expect(sizeScore(undefined)).toBe(0);
    expect(sizeScore(Number.NaN)).toBe(0);
    expect(sizeScore(0)).toBe(0);
  });
});

describe("accumulationScore", () => {
  it("una sola compra no suma", () => {
    expect(accumulationScore(1, 0)).toBe(0);
  });

  it("múltiples compras espaciadas superan a múltiples compras juntas", () => {
    expect(accumulationScore(3, 12)).toBeGreaterThan(accumulationScore(3, 0.1));
  });

  it("satura en 5 compras y 24h de dispersión", () => {
    expect(accumulationScore(5, 24)).toBe(1);
    expect(accumulationScore(20, 100)).toBe(1);
  });
});

describe("recurrenceScore", () => {
  it("1 token es ruido: score 0", () => {
    expect(recurrenceScore(1)).toBe(0);
  });

  it("crece con cada token adicional hasta saturar en 4", () => {
    expect(recurrenceScore(2)).toBeGreaterThan(0);
    expect(recurrenceScore(3)).toBeGreaterThan(recurrenceScore(2));
    expect(recurrenceScore(4)).toBe(1);
    expect(recurrenceScore(10)).toBe(1);
  });
});

describe("isBotTokenStats", () => {
  const base: WalletTokenStats = {
    hoursBeforePump: 10, minutesAfterDeploy: 60, buyCount: 2,
    dispersionHours: 2, maxBuysPerSecond: 1, firstBuyClusterSize: 1,
  };

  it("flaggea ≥3 compras en el mismo segundo", () => {
    expect(isBotTokenStats({ ...base, maxBuysPerSecond: 3 })).toBe(true);
    expect(isBotTokenStats({ ...base, maxBuysPerSecond: 2 })).toBe(false);
  });

  it("flaggea ráfagas: 3+ compras con dispersión casi nula", () => {
    expect(isBotTokenStats({ ...base, buyCount: 4, dispersionHours: 0.001 })).toBe(true);
    expect(isBotTokenStats({ ...base, buyCount: 4, dispersionHours: 1 })).toBe(false);
    expect(isBotTokenStats({ ...base, buyCount: 2, dispersionHours: 0 })).toBe(false);
  });

  it("flaggea bundles: primera compra en el mismo segundo que 8+ wallets", () => {
    expect(isBotTokenStats({ ...base, firstBuyClusterSize: 8 })).toBe(true);
    expect(isBotTokenStats({ ...base, firstBuyClusterSize: 7 })).toBe(false);
  });

  it("sin datos de bot (undefined) no flaggea", () => {
    expect(isBotTokenStats({ hoursBeforePump: 10, minutesAfterDeploy: 60, buyCount: 1, dispersionHours: 0 })).toBe(false);
  });
});

describe("scoreWallet", () => {
  it("devuelve 0 sin apariciones", () => {
    expect(scoreWallet({ perToken: [] }).score).toBe(0);
  });

  it("score en rango 0-100", () => {
    const perfect = scoreWallet({
      perToken: Array.from({ length: 4 }, () => ({
        hoursBeforePump: 48,
        minutesAfterDeploy: 120,
        buyCount: 5,
        dispersionHours: 24,
        supplyPctBought: 0.02,
      })),
    });
    expect(perfect.score).toBe(100);
    expect(scoreWallet({ perToken: [baseStats] }).score).toBeGreaterThanOrEqual(0);
  });

  it("la recurrencia pesa fuerte: mismo perfil con 3 tokens supera ampliamente a 1 token", () => {
    const stats: WalletTokenStats = {
      hoursBeforePump: 20,
      minutesAfterDeploy: 120,
      buyCount: 2,
      dispersionHours: 4,
      supplyPctBought: 0.005,
    };
    const oneToken = scoreWallet({ perToken: [stats] });
    const threeTokens = scoreWallet({ perToken: [stats, stats, stats] });
    // 3 apariciones aportan 2/3 del componente de recurrencia (25%) ≈ +16.7 pts
    expect(threeTokens.score - oneToken.score).toBeGreaterThan(15);
  });

  it("expone promedios coherentes", () => {
    const result = scoreWallet({
      perToken: [
        { ...baseStats, hoursBeforePump: 10, buyCount: 2 },
        { ...baseStats, hoursBeforePump: 20, buyCount: 4 },
      ],
    });
    expect(result.avgHoursBeforePump).toBe(15);
    expect(result.avgBuyCount).toBe(3);
    expect(result.tokensHitCount).toBe(2);
  });

  it("penaliza ×0.25 a wallets con señales de bot en la mayoría de sus tokens", () => {
    const human: WalletTokenStats = {
      hoursBeforePump: 20, minutesAfterDeploy: 120, buyCount: 3, dispersionHours: 5,
      supplyPctBought: 0.005, maxBuysPerSecond: 1, firstBuyClusterSize: 2,
    };
    const bot: WalletTokenStats = { ...human, maxBuysPerSecond: 5 };
    const humanScore = scoreWallet({ perToken: [human] });
    const botScore = scoreWallet({ perToken: [bot] });
    expect(humanScore.isBotSuspect).toBe(false);
    expect(botScore.isBotSuspect).toBe(true);
    expect(botScore.score).toBeCloseTo(humanScore.score * 0.25, 0);
  });

  it("una sola aparición bot entre varias humanas no penaliza", () => {
    const human: WalletTokenStats = {
      hoursBeforePump: 20, minutesAfterDeploy: 120, buyCount: 3, dispersionHours: 5,
      supplyPctBought: 0.005, maxBuysPerSecond: 1, firstBuyClusterSize: 2,
    };
    const result = scoreWallet({ perToken: [human, human, { ...human, maxBuysPerSecond: 5 }] });
    expect(result.isBotSuspect).toBe(false);
  });

  it("los pesos default suman 1", () => {
    const sum =
      DEFAULT_WEIGHTS.timing + DEFAULT_WEIGHTS.size + DEFAULT_WEIGHTS.accumulation + DEFAULT_WEIGHTS.recurrence;
    expect(sum).toBeCloseTo(1);
  });
});
