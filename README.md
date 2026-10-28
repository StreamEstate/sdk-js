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

Each page returns `totalItems`, `hasNextPage` and a `cursor`. Send the cursor back to get the next page:

```ts
const first = await client.properties.search({ size: 50, paginationType: "CURSOR", criteria });
const second = await client.properties.search({ size: 50, cursor: first.cursor!, criteria });
```

Or let the SDK follow the cursors:

```ts
for await (const result of client.properties.iterate({ criteria, size: 50 }, { maxItems: 500 })) {
  // …
}
```

Each returned property costs a credit, so `maxItems` is required. The last page can return up to
`size - 1` properties beyond `maxItems`; they are charged but not yielded.

Without a `sort`, `iterate` sorts by creation date (`STABLE_SORT`). The API sorts by update date by
default, and a property updated during the iteration would move from one page to another. Page numbers
(`page: 2`) have the same limit, so prefer the cursor to read many pages.

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

## How the SDK talks to the API

- `properties.search` requests the JSON:API format, the only one with `totalItems`, `hasNextPage` and the
  cursor, and rebuilds each result in the flat shape (`property`, `publishers`, `listings`). The
  property-scoped publisher fields (`mandate`, `reference`, `contact`) are merged into each publisher.
- Every other method requests flat JSON.
- A location filter with `uniqueCodes` and no `countryCode` is refused before sending, with a message that
  says what is missing.

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
