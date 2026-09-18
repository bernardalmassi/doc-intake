// Every model the app can ask for must have a price the database will
// charge, or close_extraction_run refuses every run it serves. The drift
// test against the live price table is in tests/extraction.test.ts, which
// needs the Supabase secrets, so CI never runs it. This one reads the price
// rows straight out of supabase/migrations/ instead: no database, no
// network, run by `npm run test:unit` on every push.
//
// The reader understands one form, a plain `insert into
// public.extraction_model_prices (...) values (...), ...;`. Any other
// statement that writes the table (an update, a delete, an upsert) fails
// the test until the reader is taught it, so a price change can't slip past.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, PRICING, priceForModel, type ModelPrice } from "@/lib/extraction/config";

const MIGRATIONS = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
const TABLE = String.raw`(?:public\.)?extraction_model_prices\b`;

const COLUMNS = ["model", "provider", "input_usd_per_million", "output_usd_per_million", "checked_on", "source"];
// one row of the values list, in COLUMNS order
const ROW = /\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;

// The price table as the migrations leave it, in the order they apply.
function pricesFromMigrations(): Record<string, ModelPrice> {
  const prices: Record<string, ModelPrice> = {};
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    // comments can mention the table; only statements count
    const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");

    const unread = new RegExp(String.raw`\b(update\s+${TABLE}|delete\s+from\s+${TABLE}|truncate\s+(table\s+)?${TABLE}|merge\s+into\s+${TABLE}|copy\s+${TABLE})`, "i");
    const other = unread.exec(sql);
    if (other) throw new Error(`${file}: can't read "${other[0]}"; teach tests/unit/model-prices.test.ts this form`);

    for (const insert of sql.matchAll(new RegExp(String.raw`\binsert\s+into\s+${TABLE}\s*\(([^)]*)\)\s*values\s*([^;]*);`, "gi"))) {
      const columns = insert[1].split(",").map((c) => c.trim());
      if (columns.join() !== COLUMNS.join()) throw new Error(`${file}: unexpected columns ${columns.join(", ")}`);
      const values = insert[2];
      if (/\bon\s+conflict\b/i.test(values)) throw new Error(`${file}: can't read an upsert of the price table`);
      // everything in the values list must be a row the pattern read
      if (values.replace(ROW, "").replace(/[\s,]/g, "") !== "") {
        throw new Error(`${file}: a row of the price insert doesn't match the expected shape`);
      }
      for (const [, model, provider, input, output, checkedOn, source] of values.matchAll(ROW)) {
        if (model in prices) throw new Error(`${file}: ${model} inserted twice`);
        if (provider !== "anthropic" && provider !== "openai") throw new Error(`${file}: unknown provider ${provider}`);
        prices[model] = {
          provider,
          inputUsdPerMillion: Number(input),
          outputUsdPerMillion: Number(output),
          checkedOn,
          source,
        };
      }
    }
    const inserts = sql.match(new RegExp(String.raw`\binsert\s+into\s+${TABLE}`, "gi"))?.length ?? 0;
    const read = [...sql.matchAll(new RegExp(String.raw`\binsert\s+into\s+${TABLE}\s*\([^)]*\)\s*values\s*[^;]*;`, "gi"))].length;
    if (inserts !== read) throw new Error(`${file}: an insert into the price table has a form the reader can't parse`);
  }
  return prices;
}

// private.extraction_price_for_model: exact id first, then the longest
// priced id the model extends with a "-" suffix.
function priceInTable(table: Record<string, ModelPrice>, model: string): ModelPrice | undefined {
  if (table[model]) return table[model];
  const prefix = Object.keys(table)
    .filter((id) => model.startsWith(id + "-"))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? table[prefix] : undefined;
}

const fromMigrations = pricesFromMigrations();

describe("model prices, without a database", () => {
  it("reads a price table from the migrations", () => {
    expect(Object.keys(fromMigrations).length).toBeGreaterThan(0);
  });

  it("the mirror in config.ts is the table the migrations create", () => {
    expect(fromMigrations).toEqual(PRICING);
  });

  it.each(Object.entries(DEFAULT_MODELS))("the default %s model, %s, has a price the database will charge", (provider, model) => {
    const charged = priceInTable(fromMigrations, model);
    expect(charged, `${model} has no row in extraction_model_prices`).toBeDefined();
    expect(charged?.provider).toBe(provider);
    expect(priceForModel(model)).toEqual(charged);
  });

  it("every model priced in config.ts is priced by the database too", () => {
    for (const [model, price] of Object.entries(PRICING)) {
      expect(priceInTable(fromMigrations, model), model).toEqual(price);
    }
  });

  it("a snapshot id is priced by its longest prefix, and an unknown id not at all", () => {
    expect(priceInTable(fromMigrations, "gpt-5-nano-2025-08-07")).toEqual(fromMigrations["gpt-5-nano"]);
    expect(priceInTable(fromMigrations, "claude-unpriced-9")).toBeUndefined();
    // a prefix only counts up to a "-": gpt-5-nanox is another model
    expect(priceInTable(fromMigrations, "gpt-5-nanox")).toBeUndefined();
  });
});
