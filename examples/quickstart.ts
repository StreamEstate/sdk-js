/**
 * Run with: STREAM_ESTATE_API_KEY=... npx tsx examples/quickstart.ts
 */
import { StreamEstate, StreamEstateError } from "@streamestate/sdk";

const client = new StreamEstate({ apiKey: process.env.STREAM_ESTATE_API_KEY! });

async function main() {
  const [city] = await client.geo.autocomplete("Bordeaux", { limit: 1 });
  console.log("City:", city?.name, city?.locationType);

  const page = await client.properties.search({
    size: 5,
    criteria: {
      property: {
        type: { in: ["FLAT"] },
        transaction: { type: "SELL" },
        locations: { countryCode: "FR", in: { uniqueCodes: ["33063"] } },
      },
    },
  });
  console.log(`${page.items.length} properties, ${page.creditsCharged} credits, more: ${page.hasNextPage}`);
  for (const { property, listings } of page.items) {
    console.log(`- ${property?.pricing?.displayed} € · ${property?.area?.displayed} m² · ${listings?.length} listing(s)`);
  }
}

main().catch((error) => {
  if (error instanceof StreamEstateError) console.error(error.status, error.detail, error.requestId);
  else console.error(error);
  process.exit(1);
});
