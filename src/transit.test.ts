import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSiteFromList } from "./transit";

const SITES = [
  { id: 1461, name: "Odenplan" },
  { id: 1002, name: "T-Centralen" },
  { id: 2001, name: "Slussen" },
  { id: 3001, name: "Fridhemsplan" },
  { id: 3002, name: "Fridhemsplan T-bana" },
];

test("resolveSiteFromList: exact match wins outright, case-insensitively", () => {
  const match = resolveSiteFromList(SITES, "odenplan");
  assert.equal(match.id, 1461);
  assert.equal(match.name, "Odenplan");
});

test("resolveSiteFromList: a unique substring match resolves", () => {
  const match = resolveSiteFromList(SITES, "slus");
  assert.equal(match.id, 2001);
});

test("resolveSiteFromList: no match throws naming the query", () => {
  assert.throws(() => resolveSiteFromList(SITES, "nonexistentstationname"), /no SL stop matching/);
});

test("resolveSiteFromList: an ambiguous substring lists the candidates instead of guessing", () => {
  // "fridhems" is a substring of both stops but an exact match of neither —
  // the genuinely ambiguous case, unlike the full name below.
  assert.throws(() => resolveSiteFromList(SITES, "fridhems"), /more than one stop/);
});

test("resolveSiteFromList: exact match short-circuits even when it's also a substring of another", () => {
  // "Fridhemsplan" is itself a substring of "Fridhemsplan T-bana", but an
  // exact (case-insensitive) match should win outright rather than being
  // treated as ambiguous.
  const match = resolveSiteFromList(SITES, "Fridhemsplan");
  assert.equal(match.id, 3001);
});

test("resolveSiteFromList: empty query is rejected", () => {
  assert.throws(() => resolveSiteFromList(SITES, "   "), /can't be empty/);
});

test("resolveSiteFromList: too many candidates asks to be more specific rather than dumping a huge list", () => {
  const manySites = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Central Station ${i}` }));
  assert.throws(() => resolveSiteFromList(manySites, "central"), /be more specific/);
});
