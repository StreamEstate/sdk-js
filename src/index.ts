/**
 * Stream Estate — official TypeScript SDK for the API V2 (beta).
 *
 * Types in ./generated/schema.ts are generated from https://next.docs.stream.estate/openapi.json
 * (`npm run generate`). Where the live API differs from that document, this file follows the live
 * API and says so next to the method.
 */
import type { components, operations } from "./generated/schema.js";

export type Schemas = components["schemas"];
export type { components, operations };

export const DEFAULT_BASE_URL = "https://api-v2.stream.estate";

type Query<Op extends keyof operations> = operations[Op] extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : never;

type JsonBody<Op extends keyof operations> = operations[Op] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : never;

type JsonOk<Op extends keyof operations, Status extends number> = operations[Op] extends {
  responses: { [S in Status]: { content: { "application/json": infer R } } };
}
  ? R
  : never;

export type PropertySearchRequest = Omit<
  Schemas["PropertySearch.PropertySearchRequestInput"],
  "paginationType" | "cursor" | "page" | "size"
> & {
  /** 1-based. */
  page?: number;
  /** 1 to 100. Every returned property costs a credit. */
  size?: number;
};
export type PropertySearchResult = Schemas["PropertySearchResult"];
export type CriteriaNode = Schemas["CriteriaNode"];

/** One page of property search results. */
export interface PropertyPage {
  items: PropertySearchResult[];
  page: number;
  size: number;
  /** True when the page came back full, so a next page may exist. */
  hasNextPage: boolean;
  /** Credits this request consumed, from the `x-credits-charged` response header. */
  creditsCharged?: number;
}

export interface StreamEstateOptions {
  /** API V2 key, created at https://console.stream.estate */
  apiKey: string;
  /** Defaults to https://api-v2.stream.estate */
  baseUrl?: string;
  /** Custom fetch implementation (defaults to the global `fetch`). */
  fetch?: typeof fetch;
}

export interface Violation {
  propertyPath?: string;
  message?: string;
  code?: string;
}

/** Thrown for any non-2xx response, and for requests the SDK refuses to send. */
export class StreamEstateError extends Error {
  readonly status: number;
  readonly title?: string;
  readonly detail?: string;
  readonly violations: Violation[];
  readonly requestId?: string;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown, requestId?: string) {
    const problem = (body && typeof body === "object" ? body : {}) as {
      title?: string;
      detail?: string;
      violations?: Violation[];
    };
    super(problem.detail ? `${message}: ${problem.detail}` : message);
    this.name = "StreamEstateError";
    this.status = status;
    this.title = problem.title;
    this.detail = problem.detail;
    this.violations = Array.isArray(problem.violations) ? problem.violations : [];
    this.requestId = requestId;
    this.body = body;
  }
}

interface RawResponse<T> {
  data: T;
  headers: Headers;
}

function toQueryString(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(`${key}[]`, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/**
 * The API ignores `uniqueCodes` (INSEE codes) silently when `countryCode` is missing, and returns
 * properties from anywhere in France. Refuse the request instead.
 */
function assertCountryCodeWithUniqueCodes(node: unknown): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of ["and", "or"]) {
    if (Array.isArray(record[key])) (record[key] as unknown[]).forEach(assertCountryCodeWithUniqueCodes);
  }
  const locations = (record.property as Record<string, unknown> | undefined)?.locations as
    | Record<string, any>
    | undefined;
  if (!locations) return;
  const usesUniqueCodes = [locations.in?.uniqueCodes, locations.nin?.uniqueCodes].some(
    (codes) => Array.isArray(codes) && codes.length > 0,
  );
  if (usesUniqueCodes && !locations.countryCode) {
    throw new StreamEstateError(
      0,
      'criteria.property.locations.countryCode is required with uniqueCodes (e.g. "FR"); without it the API ignores the location filter',
    );
  }
}

export class StreamEstate {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StreamEstateOptions) {
    if (!options?.apiKey) {
      throw new Error("StreamEstate: `apiKey` is required. Create one at https://console.stream.estate");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new Error("StreamEstate: no global `fetch`. On Node < 18, pass one via options.fetch.");
    }
    this.fetchImpl = f;
  }

  private async send<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<RawResponse<T>> {
    const headers: Record<string, string> = {
      "X-API-KEY": this.apiKey,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(`${this.baseUrl}${path}${toQueryString(options.query)}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new StreamEstateError(
        response.status,
        `Stream Estate API error ${response.status} on ${method} ${path}`,
        parsed,
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    return { data: parsed as T, headers: response.headers };
  }

  private async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return (await this.send<T>("GET", path, { query })).data;
  }

  private id(value: string): string {
    return encodeURIComponent(value);
  }

  private async *iterateProperties(
    request: PropertySearchRequest,
    options: { maxItems: number },
  ): AsyncGenerator<PropertySearchResult> {
    let remaining = options.maxItems;
    let page = request.page ?? 1;
    // The page size cannot change between pages without shifting offsets, so it is fixed up front.
    const size = Math.max(1, Math.min(request.size ?? 100, 100, options.maxItems));
    while (remaining > 0) {
      const result = await this.properties.search({ ...request, page, size });
      for (const item of result.items.slice(0, remaining)) yield item;
      remaining -= result.items.length;
      if (!result.hasNextPage) return;
      page += 1;
    }
  }

  readonly properties = {
    /**
     * POST /properties, page-based, in flat JSON: the JSON:API format keeps `totalItems` and the
     * cursor but omits the publishers' `mandate`, `reference` and `contact`. Flat JSON is a bare
     * array, so `hasNextPage` is inferred from the page size.
     */
    search: async (request: PropertySearchRequest = {}): Promise<PropertyPage> => {
      assertCountryCodeWithUniqueCodes(request.criteria);
      const page = request.page ?? 1;
      const size = request.size ?? 10;
      const { data, headers } = await this.send<PropertySearchResult[]>("POST", "/properties", {
        body: { ...request, paginationType: "PAGE", page, size },
      });
      const items = Array.isArray(data) ? data : [];
      const credits = Number(headers.get("x-credits-charged"));
      return {
        items,
        page,
        size,
        hasNextPage: items.length === size,
        creditsCharged: Number.isFinite(credits) ? credits : undefined,
      };
    },

    /**
     * Iterates over results page by page. Every returned property costs a credit, so `maxItems`
     * is required. Pages keep a fixed size, so the last page can return (and charge) up to
     * `size - 1` properties beyond `maxItems`; they are not yielded.
     */
    iterate: (request: PropertySearchRequest, options: { maxItems: number }): AsyncGenerator<PropertySearchResult> =>
      this.iterateProperties(request, options),

    /** GET /properties/{id} */
    get: (id: string): Promise<PropertySearchResult> => this.get(`/properties/${this.id(id)}`),
  };

  readonly transactions = {
    /** POST /transactions/search — recorded sales (DVF). */
    search: async (
      request: Schemas["Transaction.TransactionSearchRequestInput"] = {},
    ): Promise<Schemas["Transaction.TransactionSearchResponse"]> =>
      (await this.send<Schemas["Transaction.TransactionSearchResponse"]>("POST", "/transactions/search", { body: request }))
        .data,
    /** GET /transactions/{id} */
    get: (id: string): Promise<JsonOk<"getTransaction", 200>> => this.get(`/transactions/${this.id(id)}`),
  };

  readonly geo = {
    /** GET /geo/autocomplete */
    autocomplete: (
      query: string,
      options: Omit<Query<"autocompleteLocations">, "query"> = {},
    ): Promise<Schemas["LocationAutocomplete.LocationSuggestion"][]> =>
      this.get("/geo/autocomplete", { ...options, query }),
    /** GET /geo/administrative-divisions/{id} */
    division: (id: string): Promise<Schemas["AdministrativeDivision"]> =>
      this.get(`/geo/administrative-divisions/${this.id(id)}`),
    /** GET /geo/administrative-divisions/{id}/ancestors */
    ancestors: (
      id: string,
      options: Query<"listAdministrativeDivisionAncestors"> = {},
    ): Promise<Schemas["AdministrativeDivision"][]> =>
      this.get(`/geo/administrative-divisions/${this.id(id)}/ancestors`, options),
    /** GET /geo/administrative-divisions/{id}/descendants */
    descendants: (
      id: string,
      options: Query<"listAdministrativeDivisionDescendants"> = {},
    ): Promise<Schemas["AdministrativeDivision"][]> =>
      this.get(`/geo/administrative-divisions/${this.id(id)}/descendants`, options),
    /** GET /geo/administrative-divisions/{id}/geometry */
    geometry: (id: string): Promise<unknown> => this.get(`/geo/administrative-divisions/${this.id(id)}/geometry`),
  };

  readonly sources = {
    /** GET /sources — 30 per page. */
    list: (options: Query<"listSources"> = {}): Promise<Schemas["Source"][]> => this.get("/sources", options),
    /** GET /sources/{id} */
    get: (id: string): Promise<Schemas["Source"]> => this.get(`/sources/${this.id(id)}`),
  };

  readonly sourceCategories = {
    /** GET /source-categories */
    list: (options: Query<"listSourceCategories"> = {}): Promise<Schemas["SourceCategory"][]> =>
      this.get("/source-categories", options),
    /** GET /source-categories/{id} */
    get: (id: string): Promise<Schemas["SourceCategory"]> => this.get(`/source-categories/${this.id(id)}`),
  };

  readonly publishers = {
    /** GET /publishers/{id} */
    get: (id: string): Promise<Schemas["Publisher"]> => this.get(`/publishers/${this.id(id)}`),
  };

  readonly alerts = {
    /** GET /alerts */
    list: (options: Query<"listAlerts"> = {}): Promise<Schemas["Alert"][]> => this.get("/alerts", options),
    /** GET /alerts/{id} */
    get: (id: string): Promise<Schemas["Alert"]> => this.get(`/alerts/${this.id(id)}`),
    /** POST /alerts */
    create: async (alert: Schemas["Alert.AlertRequestInput"]): Promise<Schemas["Alert"]> => {
      assertCountryCodeWithUniqueCodes(alert.criteria);
      return (await this.send<Schemas["Alert"]>("POST", "/alerts", { body: alert })).data;
    },
    /** PUT /alerts/{id} */
    update: async (id: string, alert: Schemas["Alert.AlertRequestInput"]): Promise<Schemas["Alert"]> => {
      assertCountryCodeWithUniqueCodes(alert.criteria);
      return (await this.send<Schemas["Alert"]>("PUT", `/alerts/${this.id(id)}`, { body: alert })).data;
    },
    /** DELETE /alerts/{id} */
    delete: async (id: string): Promise<void> => {
      await this.send("DELETE", `/alerts/${this.id(id)}`);
    },
    /** GET /alerts/{alertId}/events */
    events: (alertId: string, options: Query<"listAlertEvents"> = {}): Promise<Schemas["AlertEvent"][]> =>
      this.get(`/alerts/${this.id(alertId)}/events`, options),
    /** GET /alerts/{alertId}/events/{id} */
    event: (alertId: string, id: string): Promise<Schemas["AlertEvent"]> =>
      this.get(`/alerts/${this.id(alertId)}/events/${this.id(id)}`),
  };

  readonly eventDestinations = {
    /** GET /account/event-destinations */
    list: (options: Query<"listEventDestinations"> = {}): Promise<Schemas["EventDestination"][]> =>
      this.get("/account/event-destinations", options),
    /** GET /account/event-destinations/{id} */
    get: (id: string): Promise<Schemas["EventDestination"]> => this.get(`/account/event-destinations/${this.id(id)}`),
    /** POST /account/event-destinations */
    create: async (destination: JsonBody<"createEventDestination">): Promise<Schemas["EventDestination"]> =>
      (await this.send<Schemas["EventDestination"]>("POST", "/account/event-destinations", { body: destination })).data,
    /** DELETE /account/event-destinations/{id} */
    delete: async (id: string): Promise<void> => {
      await this.send("DELETE", `/account/event-destinations/${this.id(id)}`);
    },
  };

  readonly eventNotifications = {
    /** GET /event-notifications */
    list: (options: Query<"listEventNotifications"> = {}): Promise<Schemas["EventNotification"][]> =>
      this.get("/event-notifications", options),
    /** GET /event-notifications/{id} */
    get: (id: string): Promise<Schemas["EventNotification"]> => this.get(`/event-notifications/${this.id(id)}`),
  };

  readonly favorites = {
    /** GET /favorite-properties */
    list: (options: Query<"listFavoriteProperties"> = {}): Promise<Schemas["FavoriteProperty"][]> =>
      this.get("/favorite-properties", options),
    /** POST /favorite-properties */
    create: async (favorite: JsonBody<"createFavoriteProperty">): Promise<Schemas["FavoriteProperty"]> =>
      (await this.send<Schemas["FavoriteProperty"]>("POST", "/favorite-properties", { body: favorite })).data,
    /** DELETE /favorite-properties/{id} */
    delete: async (id: string): Promise<void> => {
      await this.send("DELETE", `/favorite-properties/${this.id(id)}`);
    },
  };

  readonly account = {
    /** GET /account/api-usage */
    apiUsage: (options: Query<"getApiUsage"> = {}): Promise<Schemas["ApiUsage"]> =>
      this.get("/account/api-usage", options),
  };

  readonly analytics = {
    /** GET /analytics/listings */
    listings: (options: Query<"getListingAnalytics"> = {}): Promise<unknown> => this.get("/analytics/listings", options),
  };
}

export default StreamEstate;
