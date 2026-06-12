import { describe, expect, it } from "vitest";
import { computeFlags, isFreshWallet, isInsiderSuspect, isSniper } from "./filters.js";

const DAY = 86_400;
const NOW = 1_780_000_000;

describe("isSniper", () => {
  it("flaggea compras en los primeros 5 minutos post-deploy", () => {
    expect(isSniper(0)).toBe(true);
    expect(isSniper(5)).toBe(true);
  });

  it("no flaggea compras posteriores ni deploys desconocidos (-1)", () => {
    expect(isSniper(6)).toBe(false);
    expect(isSniper(120)).toBe(false);
    expect(isSniper(-1)).toBe(false);
  });
});

describe("isInsiderSuspect", () => {
  it("flaggea si el primer fondeo vino del deployer (case-insensitive)", () => {
    expect(isInsiderSuspect({ from: "0xAbC" }, "0xabc")).toBe(true);
  });

  it("no flaggea con otro funder o datos faltantes", () => {
    expect(isInsiderSuspect({ from: "0xdef" }, "0xabc")).toBe(false);
    expect(isInsiderSuspect(undefined, "0xabc")).toBe(false);
    expect(isInsiderSuspect({ from: "0xabc" }, undefined)).toBe(false);
  });
});

describe("isFreshWallet", () => {
  it("flaggea wallet creada hace menos de 7 días sin historial", () => {
    expect(isFreshWallet({ timestamp: NOW - 2 * DAY }, NOW, 3)).toBe(true);
  });

  it("no flaggea wallets viejas", () => {
    expect(isFreshWallet({ timestamp: NOW - 30 * DAY }, NOW, 3)).toBe(false);
  });

  it("no flaggea wallets jóvenes pero con mucho historial", () => {
    expect(isFreshWallet({ timestamp: NOW - 2 * DAY }, NOW, 500)).toBe(false);
  });

  it("sin primera tx conocida no flaggea", () => {
    expect(isFreshWallet(undefined, NOW, undefined)).toBe(false);
  });
});

describe("computeFlags", () => {
  it("integra los tres flags", () => {
    const flags = computeFlags({
      minMinutesAfterDeploy: 2,
      firstIncomingTx: { from: "0xdeployer", timestamp: NOW - DAY },
      deployerAddress: "0xDEPLOYER",
      earliestBuyTs: NOW,
      knownTxCount: 2,
    });
    expect(flags).toEqual({ isSniper: true, isInsiderSuspect: true, isFreshWallet: true });
  });

  it("wallet limpia: todo false", () => {
    const flags = computeFlags({
      minMinutesAfterDeploy: 600,
      firstIncomingTx: { from: "0xexchange", timestamp: NOW - 300 * DAY },
      deployerAddress: "0xdeployer",
      earliestBuyTs: NOW,
      knownTxCount: 5000,
    });
    expect(flags).toEqual({ isSniper: false, isInsiderSuspect: false, isFreshWallet: false });
  });
});
