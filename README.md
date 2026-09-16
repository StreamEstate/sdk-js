# @streamestate/sdk

Official TypeScript SDK for the [Stream Estate](https://stream.estate) API V2 — French real-estate
listings deduplicated across sources, recorded sales, saved-search alerts and administrative geography.

> **Beta.** The API V2 is in beta and can change without notice, and this SDK follows it: pin an exact
> version. API V1 keys do not work here — create a V2 key in the [console](https://console.stream.estate/api-keys).

## Install

```bash
npm install @streamestate/sdk@beta
```

## One-command setup

```bash
npx -p @streamestate/sdk create-stream-estate
```

It finds your key (`--key`, then `$STREAM_ESTATE_API_KEY`, then a prompt), writes it to `./.env` without
silently replacing a different value, makes one free test call (`GET /sources`) and prints the next steps.
Flags: `--yes`, `--env-file <path>`, `--no-env`, `--skip-test`, `--help`. Exits `1` when the test call fails.

## Quickstart

```ts
import { StreamEstate } from "@streamestate/sdk";

const client = new StreamEstate({ apiKey: process.env.STREAM_ESTATE_API_KEY! });

const page = await client.properties.search({
  size: 10,
  criteria: {
    property: {
      type: { in: ["FLAT"] },
      transaction: { type: "SELL" },
      pricing: { displayed: { lte: 400000 } },
      locations: { countryCode: "FR", in: { uniqueCodes: ["33063"] } }, // Bordeaux (INSEE code)
    },
  },
});

for (const { property } of page.items) {
  console.log(property?.pricing?.displayed, property?.area?.displayed, property?.location?.city?.name);
}
```

Every filter is typed from the API reference, so your editor completes the criteria and rejects unknown keys.

### More than one page

```ts
for await (const result of client.properties.iterate({ criteria, size: 50 }, { maxItems: 500 })) {
  // …
}
```

Each returned property costs a credit, so `maxItems` is required. Pages have a fixed size: the last one
can return up to `size - 1` properties beyond `maxItems`, which are charged but not yielded.

## API

```ts
client.properties.search(request) / .iterate(request, { maxItems }) / .get(id)
client.transactions.search(request) / .get(id)
client.geo.autocomplete(query, options) / .division(id) / .ancestors(id) / .descendants(id) / .geometry(id)
client.sources.list({ page }) / .get(id)
client.sourceCategories.list() / .get(id)
client.publishers.get(id)
client.alerts.list() / .get(id) / .create(alert) / .update(id, alert) / .delete(id)
client.alerts.events(alertId) / .event(alertId, id)
client.eventDestinations.list() / .get(id) / .create(destination) / .delete(id)
client.eventNotifications.list() / .get(id)
client.favorites.list() / .create(favorite) / .delete(id)
client.account.apiUsage(options)
client.analytics.listings(options)
```

Errors are thrown as `StreamEstateError` with `status`, `title`, `detail`, `violations` and `requestId`
(quote it when contacting support@stream.estate).

## Where the SDK differs from the reference

- `properties.search` returns `{ items, page, size, hasNextPage, creditsCharged }`. The SDK requests flat
  JSON, which the API returns as a plain array without `totalItems` or cursor (as the guides say, although
  the OpenAPI document declares an object). It does so because the JSON:API format, which keeps
  pagination, currently omits the publishers' `mandate`, `reference` and `contact`. `hasNextPage` therefore
  means "the page came back full", and cursor pagination is not offered.
- A location filter using `uniqueCodes` without `countryCode` is refused before sending: the API would
  ignore the filter and return properties from all of France.

## Use the API from an AI assistant

```bash
claude mcp add --transport http streamestate https://api-v2.stream.estate/mcp --header "X-API-KEY: <your_key>"
```

## Development

```bash
npm install
npm run generate   # regenerate src/generated/schema.ts from the published OpenAPI document
npm run build
```

Found a bug or a difference with the API? Open an issue on this repository.

## License

MIT
