# UN Comtrade — Bilateral Trade Statistics

The United Nations Statistics Division's Commodity Trade Database. Bilateral trade flows between every reporting country and every partner country, broken down by commodity (HS codes), going back decades. The standard source for "who exports what to whom" at country level.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

If an agent is answering anything about international trade — bilateral relationships, commodity flows, tariffs in context, supply-chain concentration — Comtrade is the source. The data is structured (HS codes) and harmonized across countries, making cross-country comparison reliable.

Common flows:

- **Bilateral analysis.** "US-China trade flows in 2024." → `comtrade_trade_data({reporter_code: "842", partner_code: "156", year: "2024"})` → imports + exports + balance.
- **Top commodities.** "What does the US import most from China?" → `comtrade_top_commodities({reporter_code, partner_code, flow: "M"})`.
- **Top partners.** "Who are the top buyers of US semiconductors?" → `comtrade_top_partners({reporter_code, hs_code: "8542", flow: "X"})`.
- **Country code lookup.** ISO 3-digit numeric codes — `comtrade_country_codes` returns the full mapping.

Used by the `trade_bilateral_analysis` and `trade_country_profile` compounds.

## Auth

Comtrade has free and premium tiers. The free tier is heavily rate-limited (a few requests per minute). For higher volumes, register at https://comtradeplus.un.org and pass an API key via `_apiKey`.

## Country and commodity codes

| Type | Format | Example |
|---|---|---|
| Country | ISO 3166-1 numeric | `842` (US), `156` (China), `484` (Mexico) |
| Commodity | HS chapter / heading / subheading | `85` (electrical), `8517` (telephones), `851712` (smartphones) |
| Flow | M / X / re-import / re-export | `M` = imports, `X` = exports |

`comtrade_country_codes` returns the full mapping. Most agents pass the 3-digit numeric to avoid name-disambiguation problems.

## Update cadence

Comtrade releases data with a substantial lag — typically 6–12 months after the calendar year. The most recent year you can query is usually last calendar year. Pipeworx caches with 30-day TTL since this data is essentially static once published.

## Common pitfalls

- **Reporter vs. partner mirror data.** Both sides of a trade report it (the US reports imports from China; China reports exports to the US). Numbers don't perfectly match — different valuation methods (CIF vs FOB), shipping treatment, classification differences. Reporter-side is the convention; if you need both, request both.
- **HS revision changes.** The HS classification updates every 5 years (HS17, HS22, etc.). Long time-series straddle revisions; codes for the same commodity can shift. Comtrade harmonizes for you in standard queries.
- **Service trade NOT included.** Comtrade is goods only. Service trade lives separately (BEA / WTO data). Don't conflate.
- **Re-exports.** Hong Kong's "exports to the US" include massive re-exports of Chinese-origin goods. The `flow` parameter distinguishes; use it explicitly.
- **Currency.** Default values are USD — but check the `unit` field. Some series report quantity (kg, units) only without value.
- **Unreported pairs.** Not every country reports to Comtrade every year. Cuba, Iran, North Korea have major gaps. Mirror data from partners can fill the holes — query the partner's reports of trade with that country.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "comtrade": {
      "url": "https://gateway.pipeworx.io/comtrade/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/comtrade/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Comtrade data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
