import { it, expect } from "vitest";
import { duplicateRefdes, nextRefdes, refdesIsDuplicated, refdesNumber } from "./refdes";

const components = [{ refdes: "R1" }, { refdes: "R2" }, { refdes: "R10" }, { refdes: "U1" }, { refdes: "TP3" }];

it("assigns prefix + max + 1 without refilling gaps", () => {
  expect(nextRefdes("R", components)).toBe("R11");
  expect(nextRefdes("U", components)).toBe("U2");
  expect(nextRefdes("C", components)).toBe("C1");
  expect(nextRefdes("TP", components)).toBe("TP4");
});

it("does not confuse prefixes that prefix each other", () => {
  const mixed = [{ refdes: "R1" }, { refdes: "R2" }, { refdes: "RV10" }];
  expect(nextRefdes("R", mixed)).toBe("R3");
  expect(nextRefdes("RV", mixed)).toBe("RV11");
});

it("parses numeric suffixes only", () => {
  expect(refdesNumber("R", "R12")).toBe(12);
  expect(refdesNumber("R", "RV12")).toBeNull();
  expect(refdesNumber("R", "R")).toBeNull();
  expect(refdesNumber("TP", "TP9")).toBe(9);
});

it("flags duplicated refdes project-wide", () => {
  const dup = [{ refdes: "R1" }, { refdes: "R1" }, { refdes: "U2" }];
  expect([...duplicateRefdes(dup)]).toEqual(["R1"]);
  expect(refdesIsDuplicated(dup, "R1")).toBe(true);
  expect(refdesIsDuplicated(dup, "U2")).toBe(false);
  expect(duplicateRefdes([{ refdes: "R1" }, { refdes: "R2" }]).size).toBe(0);
});
