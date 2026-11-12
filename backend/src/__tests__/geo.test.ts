import { describe, expect, it, vi } from "vitest";
import { GoogleGeoProvider, setGeoProvider, tryReverseGeocode } from "../lib/geo";

/**
 * Google Maps provider unit tests.
 *
 * The two calls are exercised against a stubbed `fetch`, so the suite never
 * reaches Google, needs a key, or depends on a network. What is asserted is the
 * contract the rest of the app relies on: a usable coordinate or a labelled
 * failure from geocoding, and a routed kilometre or a labelled failure from
 * routing. The caller (`tryGeocode` / `distanceBetween`) turns those into an
 * unverified crane or a straight-line fallback, so no failure here may throw.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerWith(
  handler: (
    url: string,
    init?: Parameters<typeof fetch>[1],
  ) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init?: Parameters<typeof fetch>[1] }> = [];
  const fetchImpl = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      calls.push({ url, init });
      return handler(url, init);
    },
  );
  const provider = new GoogleGeoProvider({
    apiKey: "test-key",
    region: "IN",
    language: "en",
    timeoutMs: 1_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { provider, calls };
}

describe("Google geo provider: geocoding", () => {
  it("returns the coordinate and builds an India-anchored address", async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse({
        status: "OK",
        results: [
          {
            formatted_address: "Pune, Maharashtra, India",
            geometry: { location: { lat: 18.5204, lng: 73.8567 } },
          },
        ],
      }),
    );

    const result = await provider.geocode({
      location: "Pune",
      state: "MH",
      pincode: "411001",
    });

    expect(result).toEqual({
      ok: true,
      point: { lat: 18.5204, lng: 73.8567 },
      provider: "google",
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://maps.googleapis.com/maps/api/geocode/json",
    );
    expect(url.searchParams.get("address")).toBe("Pune, 411001, MH, India");
    expect(url.searchParams.get("components")).toBe("country:IN");
    expect(url.searchParams.get("region")).toBe("in");
    expect(url.searchParams.get("key")).toBe("test-key");
  });

  it("reports a zero-result lookup as a reason, not an exception", async () => {
    const { provider } = providerWith(() => jsonResponse({ status: "ZERO_RESULTS" }));
    const result = await provider.geocode({ location: "Nowhere", state: "GJ" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/could not find/i);
  });

  it("reports a denied key without leaking the key", async () => {
    const { provider } = providerWith(() =>
      jsonResponse({ status: "REQUEST_DENIED", error_message: "API key not valid" }),
    );
    const result = await provider.geocode({ location: "Pune", state: "MH" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/REQUEST_DENIED/);
      // Google's own explanation is what makes the failure actionable.
      expect(result.reason).toContain("API key not valid");
      expect(result.reason).not.toContain("test-key");
    }
  });

  it("survives an HTTP error and a network failure", async () => {
    const http = providerWith(() => jsonResponse({}, 500));
    expect((await http.provider.geocode({ location: "Pune", state: "MH" })).ok).toBe(false);

    const network = providerWith(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const result = await network.provider.geocode({ location: "Pune", state: "MH" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("test-key");
  });

  it("refuses an empty address without calling Google", async () => {
    const { provider, calls } = providerWith(() => jsonResponse({ status: "OK" }));
    const result = await provider.geocode({ location: "  ", state: "" });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("Google geo provider: reverse geocoding", () => {
  it("reads the locality, state and pincode from the address components", async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse({
        status: "OK",
        results: [
          {
            formatted_address: "Ahmedabad Yard, Gujarat 380015, India",
            address_components: [
              { long_name: "Ahmedabad", short_name: "Ahmedabad", types: ["locality"] },
              { long_name: "Gujarat", short_name: "GJ", types: ["administrative_area_level_1"] },
              { long_name: "380015", short_name: "380015", types: ["postal_code"] },
            ],
          },
        ],
      }),
    );

    const result = await provider.reverseGeocode({ lat: 23.0225, lng: 72.5714 });

    expect(result).toEqual({
      ok: true,
      provider: "google",
      address: {
        currentLocation: "Ahmedabad",
        stateName: "Gujarat",
        stateCode: "GJ",
        pincode: "380015",
      },
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://maps.googleapis.com/maps/api/geocode/json",
    );
    expect(url.searchParams.get("latlng")).toBe("23.0225,72.5714");
    expect(url.searchParams.get("key")).toBe("test-key");
  });

  it("leaves a missing piece null rather than guessing it", async () => {
    const { provider } = providerWith(() =>
      jsonResponse({
        status: "OK",
        results: [{ address_components: [{ long_name: "Pune", types: ["locality"] }] }],
      }),
    );

    const result = await provider.reverseGeocode({ lat: 18.52, lng: 73.85 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.currentLocation).toBe("Pune");
      expect(result.address.stateCode).toBeNull();
      expect(result.address.pincode).toBeNull();
    }
  });

  it("reports a denied key without leaking it", async () => {
    const { provider } = providerWith(() =>
      jsonResponse({ status: "REQUEST_DENIED", error_message: "API key not valid" }),
    );
    const result = await provider.reverseGeocode({ lat: 18.52, lng: 73.85 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/REQUEST_DENIED/);
      expect(result.reason).not.toContain("test-key");
    }
  });

  it("reports zero results as a reason", async () => {
    const { provider } = providerWith(() => jsonResponse({ status: "ZERO_RESULTS" }));
    const result = await provider.reverseGeocode({ lat: 1, lng: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/could not find/i);
  });

  it("does not invent an address with the stub provider", async () => {
    // Vitest forces GEO_PROVIDER=stub; the stub has no reverse capability, so the
    // wrapper says so instead of returning a synthetic address for a real pin.
    setGeoProvider(null);
    const result = await tryReverseGeocode({ lat: 22.5, lng: 72.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not available/i);
  });
});

describe("Google geo provider: road distance", () => {
  it("returns the routed distance in kilometres", async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse({ routes: [{ distanceMeters: 187_500, duration: "10800s" }] }),
    );

    const result = await provider.roadDistance(
      { lat: 18.5204, lng: 73.8567 },
      { lat: 22.3072, lng: 73.1812 },
    );

    expect(result).toEqual({
      ok: true,
      km: 187.5,
      method: "road",
      provider: "google",
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    expect(headers["X-Goog-FieldMask"]).toBe("routes.distanceMeters");
    const body = JSON.parse(String(init?.body)) as {
      travelMode: string;
      origin: { location: { latLng: { latitude: number; longitude: number } } };
    };
    expect(body.travelMode).toBe("DRIVE");
    expect(body.origin.location.latLng).toEqual({ latitude: 18.5204, longitude: 73.8567 });
  });

  it("reports no route, an HTTP error and a missing coordinate as failures", async () => {
    const empty = providerWith(() => jsonResponse({ routes: [] }));
    expect(
      (await empty.provider.roadDistance({ lat: 1, lng: 2 }, { lat: 3, lng: 4 })).ok,
    ).toBe(false);

    const http = providerWith(() => jsonResponse({}, 503));
    expect(
      (await http.provider.roadDistance({ lat: 1, lng: 2 }, { lat: 3, lng: 4 })).ok,
    ).toBe(false);

    const invalid = providerWith(() => jsonResponse({ routes: [] }));
    expect(
      (await invalid.provider.roadDistance({ lat: Number.NaN, lng: 2 }, { lat: 3, lng: 4 }))
        .ok,
    ).toBe(false);
    expect(invalid.calls).toHaveLength(0);
  });

  it("requires an API key", () => {
    expect(() => new GoogleGeoProvider({ apiKey: "  " })).toThrow(/API key/);
  });
});
