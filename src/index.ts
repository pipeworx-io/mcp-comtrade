interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Comtrade MCP — UN Comtrade API for international bilateral trade data
 *
 * Tools:
 * - comtrade_trade_data: get bilateral trade data between countries
 * - comtrade_top_partners: top trading partners for a country
 * - comtrade_top_commodities: top traded commodities between two countries
 * - comtrade_country_codes: common country codes reference
 */


const BASE_URL = 'https://comtradeapi.un.org/public/v1/preview';

const tools: McpToolExport['tools'] = [
  {
    name: 'comtrade_trade_data',
    description:
      'Get bilateral trade data between two countries from the UN Comtrade database. Returns trade value, quantity, partner, and commodity description for imports and/or exports.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reporter_code: {
          type: 'string',
          description: 'ISO numeric country code for the reporting country (e.g., "842" for US, "156" for China)',
        },
        partner_code: {
          type: 'string',
          description: 'ISO numeric country code for the partner country (e.g., "156" for China, "0" for World)',
        },
        year: {
          type: 'string',
          description: 'Trade year (e.g., "2024")',
        },
        hs_code: {
          type: 'string',
          description: 'HS commodity code at 2/4/6 digit level (e.g., "8471" for computers). Optional — omit for all commodities.',
        },
        flow: {
          type: 'string',
          description: 'Trade flow: "M" for imports, "X" for exports. Optional — defaults to both "M,X".',
        },
      },
      required: ['reporter_code', 'partner_code', 'year'],
    },
  },
  {
    name: 'comtrade_top_partners',
    description:
      'Get top trading partners for a country by trade value. Useful for understanding a country\'s main trade relationships.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reporter_code: {
          type: 'string',
          description: 'ISO numeric country code (e.g., "842" for US)',
        },
        year: {
          type: 'string',
          description: 'Trade year (e.g., "2024")',
        },
        flow: {
          type: 'string',
          description: 'Trade flow: "M" for imports, "X" for exports',
        },
        hs_code: {
          type: 'string',
          description: 'Optional HS commodity code to filter by specific product',
        },
        limit: {
          type: 'number',
          description: 'Number of top partners to return (default 20)',
        },
      },
      required: ['reporter_code', 'year', 'flow'],
    },
  },
  {
    name: 'comtrade_top_commodities',
    description:
      'Get top traded commodities between two countries by trade value. Shows which product categories dominate bilateral trade.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reporter_code: {
          type: 'string',
          description: 'ISO numeric country code for the reporting country',
        },
        partner_code: {
          type: 'string',
          description: 'ISO numeric country code for the partner country',
        },
        year: {
          type: 'string',
          description: 'Trade year (e.g., "2024")',
        },
        flow: {
          type: 'string',
          description: 'Trade flow: "M" for imports, "X" for exports',
        },
        limit: {
          type: 'number',
          description: 'Number of top commodities to return (default 20)',
        },
      },
      required: ['reporter_code', 'partner_code', 'year', 'flow'],
    },
  },
  {
    name: 'comtrade_country_codes',
    description:
      'Get a reference list of common country ISO numeric codes used in UN Comtrade queries. No API call needed.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

interface ComtradeRecord {
  reporterCode: number;
  reporterDesc: string;
  partnerCode: number;
  partnerDesc: string;
  flowCode: string;
  flowDesc: string;
  cmdCode: string;
  cmdDesc: string;
  primaryValue: number;
  netWgt: number;
  qty: number;
  qtyUnitAbbr: string;
  period: number;
}

interface ComtradeResponse {
  data: ComtradeRecord[];
  count: number;
  error?: string;
  elapsedTime?: string;
}

// Reverse lookup: numeric code → country name (preview API returns null for desc fields)
const CODE_TO_COUNTRY: Record<number, string> = {
  0: 'World', 36: 'Australia', 76: 'Brazil', 124: 'Canada', 156: 'China',
  250: 'France', 276: 'Germany', 344: 'Hong Kong', 356: 'India', 360: 'Indonesia',
  372: 'Ireland', 381: 'Italy', 392: 'Japan', 410: 'South Korea', 458: 'Malaysia',
  484: 'Mexico', 528: 'Netherlands', 682: 'Saudi Arabia', 702: 'Singapore',
  710: 'South Africa', 724: 'Spain', 757: 'Switzerland', 764: 'Thailand',
  490: 'Taiwan', 699: 'India', 704: 'Vietnam', 826: 'United Kingdom',
  842: 'United States',
};
const FLOW_NAMES: Record<string, string> = { M: 'Imports', X: 'Exports', 'RE-X': 'Re-exports', 'RE-M': 'Re-imports' };

function resolveRecord(r: ComtradeRecord) {
  return {
    reporter: r.reporterDesc || CODE_TO_COUNTRY[r.reporterCode] || `Code ${r.reporterCode}`,
    partner: r.partnerDesc || CODE_TO_COUNTRY[r.partnerCode] || `Code ${r.partnerCode}`,
    flow: r.flowDesc || FLOW_NAMES[r.flowCode] || r.flowCode,
    commodity_code: r.cmdCode,
    commodity: r.cmdDesc || r.cmdCode,
    trade_value_usd: r.primaryValue,
    net_weight_kg: r.netWgt,
    quantity: r.qty,
    quantity_unit: r.qtyUnitAbbr,
  };
}

async function fetchComtrade(params: Record<string, string>): Promise<ComtradeResponse> {
  const url = new URL(`${BASE_URL}/C/A/HS`);
  url.searchParams.set('customsCode', 'C00');
  url.searchParams.set('motCode', '0');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`UN Comtrade API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as ComtradeResponse;
  if (data.error) {
    throw new Error(`UN Comtrade API error: ${data.error}`);
  }
  return data;
}

async function getTradeData(
  reporterCode: string,
  partnerCode: string,
  year: string,
  hsCode?: string,
  flow?: string,
) {
  const params: Record<string, string> = {
    reporterCode,
    partnerCode,
    period: year,
    flowCode: flow || 'M,X',
  };
  if (hsCode) {
    params.cmdCode = hsCode;
  }

  const response = await fetchComtrade(params);

  return {
    count: response.count,
    year,
    records: response.data.map(resolveRecord),
  };
}

async function getTopPartners(
  reporterCode: string,
  year: string,
  flow: string,
  hsCode?: string,
  limit: number = 20,
) {
  // Don't set partnerCode — omitting it returns all partners
  const params: Record<string, string> = {
    reporterCode,
    period: year,
    flowCode: flow,
    cmdCode: hsCode || 'TOTAL',
  };

  const response = await fetchComtrade(params);

  const sorted = response.data
    .filter((r) => r.partnerCode !== 0 && r.primaryValue > 0)
    .sort((a, b) => b.primaryValue - a.primaryValue)
    .slice(0, limit);

  return {
    reporter: CODE_TO_COUNTRY[Number(reporterCode)] || `Code ${reporterCode}`,
    year,
    flow: flow === 'M' ? 'Imports' : 'Exports',
    total_partners: sorted.length,
    top_partners: sorted.map((r, i) => ({
      rank: i + 1,
      partner: r.partnerDesc || CODE_TO_COUNTRY[r.partnerCode] || `Code ${r.partnerCode}`,
      partner_code: r.partnerCode,
      trade_value_usd: r.primaryValue,
      commodity: r.cmdDesc || r.cmdCode,
    })),
  };
}

async function getTopCommodities(
  reporterCode: string,
  partnerCode: string,
  year: string,
  flow: string,
  limit: number = 20,
) {
  const params: Record<string, string> = {
    reporterCode,
    partnerCode,
    period: year,
    flowCode: flow,
    cmdCode: 'TOTAL',
  };

  const response = await fetchComtrade(params);

  const sorted = response.data
    .sort((a, b) => b.primaryValue - a.primaryValue)
    .slice(0, limit);

  return {
    reporter: CODE_TO_COUNTRY[Number(reporterCode)] || `Code ${reporterCode}`,
    partner: CODE_TO_COUNTRY[Number(partnerCode)] || `Code ${partnerCode}`,
    year,
    flow: flow === 'M' ? 'Imports' : 'Exports',
    total_commodities: sorted.length,
    top_commodities: sorted.map((r, i) => ({
      rank: i + 1,
      hs_code: r.cmdCode,
      commodity: r.cmdDesc || r.cmdCode,
      trade_value_usd: r.primaryValue,
      net_weight_kg: r.netWgt,
    })),
  };
}

function getCountryCodes() {
  const codes: Record<string, { code: number; name: string }> = {
    US: { code: 842, name: 'United States' },
    China: { code: 156, name: 'China' },
    Japan: { code: 392, name: 'Japan' },
    Germany: { code: 276, name: 'Germany' },
    UK: { code: 826, name: 'United Kingdom' },
    Mexico: { code: 484, name: 'Mexico' },
    Canada: { code: 124, name: 'Canada' },
    India: { code: 699, name: 'India' },
    Brazil: { code: 76, name: 'Brazil' },
    Vietnam: { code: 704, name: 'Vietnam' },
    'South Korea': { code: 410, name: 'South Korea' },
    Taiwan: { code: 490, name: 'Taiwan' },
    France: { code: 251, name: 'France' },
    Italy: { code: 381, name: 'Italy' },
    Netherlands: { code: 528, name: 'Netherlands' },
    Australia: { code: 36, name: 'Australia' },
    Singapore: { code: 702, name: 'Singapore' },
    Thailand: { code: 764, name: 'Thailand' },
    Indonesia: { code: 360, name: 'Indonesia' },
    Malaysia: { code: 458, name: 'Malaysia' },
    'Saudi Arabia': { code: 682, name: 'Saudi Arabia' },
    Switzerland: { code: 757, name: 'Switzerland' },
    Ireland: { code: 372, name: 'Ireland' },
    Spain: { code: 724, name: 'Spain' },
    World: { code: 0, name: 'World (aggregate)' },
  };

  return {
    note: 'Use these numeric codes in reporter_code and partner_code parameters. Use 0 for World aggregate.',
    countries: Object.entries(codes).map(([key, val]) => ({
      label: key,
      numeric_code: val.code,
      full_name: val.name,
    })),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'comtrade_trade_data':
      return getTradeData(
        args.reporter_code as string,
        args.partner_code as string,
        args.year as string,
        args.hs_code as string | undefined,
        args.flow as string | undefined,
      );
    case 'comtrade_top_partners':
      return getTopPartners(
        args.reporter_code as string,
        args.year as string,
        args.flow as string,
        args.hs_code as string | undefined,
        (args.limit as number) || 20,
      );
    case 'comtrade_top_commodities':
      return getTopCommodities(
        args.reporter_code as string,
        args.partner_code as string,
        args.year as string,
        args.flow as string,
        (args.limit as number) || 20,
      );
    case 'comtrade_country_codes':
      return getCountryCodes();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
