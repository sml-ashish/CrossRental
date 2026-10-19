import { describe, expect, it } from "vitest";
import {
  CIN_PATTERN,
  GSTN_PATTERN,
  IFSC_PATTERN,
  PAN_PATTERN,
  PHONE_PATTERN,
  accountNoField,
  cinField,
  gstinPanMismatch,
  gstnField,
  ifscField,
  micrField,
  panCompanyTypeMismatch,
  panField,
  phoneField,
  pincodeField,
} from "../validation/vendorFields";

/**
 * Brief section 9 (phase E) and working rule 5: the field formats are part of
 * the contract, so PAN, GSTIN, IFSC and mobile each get a test that pins both
 * what is accepted and what is rejected. The patterns are exercised directly,
 * because these are pure functions — the onboarding tests cover the same rules
 * as they are reached through the form.
 *
 * Every value is fabricated (working rule 3); none is a real PAN or bank number.
 */

function ok<T>(schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) {
  return schema.safeParse(value).success;
}

describe("PAN", () => {
  it("accepts 5 letters, 4 digits, 1 letter — with spaces and lower case folded in", () => {
    expect(ok(panField, "ABCDE1234F")).toBe(true);
    expect(ok(panField, "aa p r t 1234 e")).toBe(true);
  });

  it("rejects a wrong shape", () => {
    expect(ok(panField, "ABCD1234F")).toBe(false);
    expect(ok(panField, "ABCDE12345")).toBe(false);
    expect(ok(panField, "12345ABCDE")).toBe(false);
  });

  it("catches the 4th-letter company-type contradiction", () => {
    // Private ltd wants "C" at position 4; a proprietorship PAN carries "P".
    expect(panCompanyTypeMismatch("ABCPE1234F", "PRIVATE_LTD")).toBe(true);
    expect(panCompanyTypeMismatch("ABCCE1234F", "PRIVATE_LTD")).toBe(false);
  });
});

describe("GSTIN", () => {
  it("accepts a 15-character state + PAN + entity + Z + checksum", () => {
    expect(ok(gstnField, "24ABCDE1234F1Z5")).toBe(true);
    expect(GSTN_PATTERN.test("24ABCDE1234F1Z5")).toBe(true);
  });

  it("rejects a wrong length or a malformed body", () => {
    expect(ok(gstnField, "24ABCDE1234F1Z")).toBe(false);
    expect(ok(gstnField, "2XABCDE1234F1Z5")).toBe(false);
  });

  it("flags a GSTIN whose embedded PAN disagrees with the PAN field", () => {
    expect(gstinPanMismatch("24ABCDE1234F1Z5", "ZZZZZ9999Z")).toBe(true);
    expect(gstinPanMismatch("24ABCDE1234F1Z5", "ABCDE1234F")).toBe(false);
  });
});

describe("IFSC", () => {
  it("accepts 4 letters, a zero, then 6 alphanumerics", () => {
    expect(ok(ifscField, "HDFC0001234")).toBe(true);
    expect(IFSC_PATTERN.test("HDFC0ABC123")).toBe(true);
  });

  it("rejects a missing zero or the wrong length", () => {
    expect(ok(ifscField, "HDFC1001234")).toBe(false);
    expect(ok(ifscField, "HDFC000123")).toBe(false);
  });
});

describe("mobile and telephone", () => {
  it("accepts Indian landline and mobile shapes", () => {
    expect(ok(phoneField, "+91 79 4000 1200")).toBe(true);
    expect(ok(phoneField, "98200 11223")).toBe(true);
  });

  it("rejects letters and anything too short", () => {
    expect(ok(phoneField, "call-me")).toBe(false);
    expect(ok(phoneField, "12345")).toBe(false);
  });

  it("does not require a mobile to start with a particular digit", () => {
    // Brief 5.1 only makes the telephone mandatory; over-stricting pushes a
    // vendor with a landline into inventing a number that passes.
    expect(PHONE_PATTERN.test("079 4000 1200")).toBe(true);
  });
});

describe("bank and address fields", () => {
  it("accepts 9 to 18 account digits and rejects a short or non-numeric one", () => {
    expect(ok(accountNoField, "50100234567890")).toBe(true);
    expect(ok(accountNoField, "123456789012 3456")).toBe(true);
    expect(ok(accountNoField, "12345678")).toBe(false);
    expect(ok(accountNoField, "12345ABCDE")).toBe(false);
  });

  it("requires exactly 9 MICR digits", () => {
    expect(ok(micrField, "123456789")).toBe(true);
    expect(ok(micrField, "12345")).toBe(false);
  });

  it("requires a 6-digit pincode whose first digit is not zero", () => {
    expect(ok(pincodeField, "380001")).toBe(true);
    expect(ok(pincodeField, "012345")).toBe(false);
    expect(ok(pincodeField, "38001")).toBe(false);
  });

  it("accepts a 21-character CIN", () => {
    expect(ok(cinField, "U12345GJ2020PTC123456")).toBe(true);
    expect(CIN_PATTERN.test("U12345GJ2020PTC123456")).toBe(true);
    expect(ok(cinField, "X12345GJ2020PTC123456")).toBe(false);
  });
});
