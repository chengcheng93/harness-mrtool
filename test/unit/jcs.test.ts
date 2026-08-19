import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeJson,
  sha256CanonicalJson,
  sha256Utf8,
} from "../../src/contracts/jcs.ts";

test("canonical JSON is independent of object insertion order", () => {
  assert.equal(
    canonicalizeJson({ b: 2, a: 1 }),
    canonicalizeJson({ a: 1, b: 2 }),
  );
  assert.equal(canonicalizeJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("canonical JSON follows representative RFC 8785 number and key rules", () => {
  const control = String.fromCodePoint(0x80);
  const latin = String.fromCodePoint(0xf6);
  const euro = String.fromCodePoint(0x20ac);
  const emoji = String.fromCodePoint(0x1f600);
  const hebrew = String.fromCodePoint(0xfb33);

  assert.equal(canonicalizeJson(-0), "0");
  assert.equal(
    canonicalizeJson({
      "\ufb33": "Hebrew",
      "\ud83d\ude00": "Emoji",
      "\u20ac": "Euro",
      "\u00f6": "Latin",
      "\u0080": "Control",
      "1": "One",
      "\r": "Carriage Return",
    }),
    `{"\\r":"Carriage Return","1":"One","${control}":"Control","${latin}":"Latin","${euro}":"Euro","${emoji}":"Emoji","${hebrew}":"Hebrew"}`,
  );
});

test("canonical JSON accepts null-prototype objects and repeated references", () => {
  const child = { stable: true };
  const value = Object.create(null) as Record<string, unknown>;
  value.right = child;
  value.left = child;

  assert.equal(
    canonicalizeJson(value),
    '{"left":{"stable":true},"right":{"stable":true}}',
  );
});

test("SHA-256 helpers hash exact UTF-8 and canonical JSON bytes", () => {
  assert.equal(
    sha256Utf8("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256CanonicalJson({ b: 2, a: 1 }),
    sha256Utf8('{"a":1,"b":2}'),
  );
  assert.match(
    sha256CanonicalJson({ value: "\u4f60\u597d" }),
    /^[0-9a-f]{64}$/,
  );
});

test("canonical JSON rejects undefined everywhere and sparse arrays", () => {
  const sparse = new Array(2);
  sparse[1] = "present";

  for (const value of [undefined, { missing: undefined }, [undefined], sparse]) {
    assert.throws(() => canonicalizeJson(value), /valid JSON/i);
  }
});

test("canonical JSON rejects non-finite numbers and non-JSON primitives", () => {
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1n,
    () => undefined,
    Symbol("value"),
  ]) {
    assert.throws(() => canonicalizeJson(value), /valid JSON/i);
  }
});

test("canonical JSON rejects cycles, special objects, and class instances", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  class RecordValue {
    value = 1;
  }

  for (const value of [cycle, new Date(0), new Map(), new RecordValue()]) {
    assert.throws(() => canonicalizeJson(value), /valid JSON/i);
  }
});

test("canonical JSON rejects array subclasses and mutated array prototypes", () => {
  class Values extends Array<number> {}
  const mutatedPrototype = [1, 2];
  Object.setPrototypeOf(mutatedPrototype, { custom: true });

  for (const value of [new Values(1, 2), mutatedPrototype]) {
    assert.throws(() => canonicalizeJson(value), /valid JSON/i);
  }
});

test("canonical JSON rejects getters without invoking them", () => {
  let invoked = false;
  const value = {};
  Object.defineProperty(value, "danger", {
    enumerable: true,
    get() {
      invoked = true;
      return "secret";
    },
  });

  assert.throws(() => canonicalizeJson(value), /valid JSON/i);
  assert.equal(invoked, false);
});

test("canonical JSON rejects symbol keys and extra array properties", () => {
  const withSymbol = { ordinary: true };
  Object.defineProperty(withSymbol, Symbol("hidden"), { value: true });
  const arrayWithProperty = [1, 2] as number[] & { extra?: boolean };
  arrayWithProperty.extra = true;
  const arrayWithHiddenProperty = [1, 2];
  Object.defineProperty(arrayWithHiddenProperty, "hidden", {
    enumerable: false,
    value: true,
  });

  assert.throws(() => canonicalizeJson(withSymbol), /valid JSON/i);
  assert.throws(() => canonicalizeJson(arrayWithProperty), /valid JSON/i);
  assert.throws(() => canonicalizeJson(arrayWithHiddenProperty), /valid JSON/i);
});

test("canonical JSON rejects lone surrogate strings and keys", () => {
  for (const value of ["\ud800", "\udc00", { ["\ud800"]: "bad key" }]) {
    assert.throws(() => canonicalizeJson(value), /valid JSON/i);
  }
});
