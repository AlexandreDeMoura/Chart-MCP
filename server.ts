import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const APP_NAME = "chart-mcp";
const APP_VERSION = "0.2.0";
export const APP_RESOURCE_URI = "ui://chart-mcp/mcp-app.html";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const UI_BUNDLE_CANDIDATES = [
  resolve(MODULE_DIR, "dist/mcp-app.html"),
  resolve(MODULE_DIR, "mcp-app.html")
];

const CHART_COLORS = [
  "#0f766e",
  "#0ea5e9",
  "#2563eb",
  "#8b5cf6",
  "#f59e0b",
  "#ef4444",
  "#22c55e",
  "#14b8a6",
  "#6366f1",
  "#f97316",
  "#84cc16",
  "#e11d48"
] as const;

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const chartTypeSchema = z
  .enum(["pie", "area-line", "funnel"])
  .describe("Chart type. Use pie for part-to-whole, area-line for ordered trends, funnel for stage conversion.");

const chartInputPointSchema = z.object({
  label: z.string().min(1).max(72).describe("Label for the category/stage/point."),
  value: z.number().finite().nonnegative().describe("Numeric value for this point."),
  color: z
    .string()
    .regex(HEX_COLOR_REGEX, "Use a hex color such as #2563eb")
    .optional()
    .describe("Optional point color as hex code.")
});

const chartBaseInputSchema = z.object({
  title: z.string().min(1).max(100).optional().describe("Optional chart title."),
  subtitle: z.string().max(180).optional().describe("Optional supporting subtitle."),
  unit: z.string().max(24).optional().describe("Optional unit suffix such as $, users, %, or ms."),
  notes: z.string().max(240).optional().describe("Optional note shown alongside the chart."),
  data: z
    .array(chartInputPointSchema)
    .min(2)
    .max(24)
    .describe("Ordered points used to render the chart.")
});

const chartOutputPointSchema = z.object({
  label: z.string(),
  value: z.number().nonnegative(),
  percentage: z.number().min(0).max(100),
  color: z.string(),
  stageConversion: z.number().min(0).max(100).nullable().optional()
});

const chartOutputSchema = z.object({
  chartType: chartTypeSchema,
  title: z.string(),
  subtitle: z.string().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
  total: z.number().nonnegative(),
  points: z.array(chartOutputPointSchema).min(2),
  summary: z.string(),
  warnings: z.array(z.string())
});

type ChartType = z.infer<typeof chartTypeSchema>;
type ChartBaseInput = z.infer<typeof chartBaseInputSchema>;
type ChartOutput = z.infer<typeof chartOutputSchema>;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatPercent(value: number): string {
  return `${round(value, 1).toFixed(1)}%`;
}

function formatValue(value: number, unit?: string): string {
  const formatted = Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

  if (!unit) {
    return formatted;
  }

  const normalizedUnit = unit.trim();
  if (!normalizedUnit) {
    return formatted;
  }

  const isPrefixUnit =
    normalizedUnit === "$" || normalizedUnit === "\u20AC" || normalizedUnit === "\u00A3";
  return isPrefixUnit ? `${normalizedUnit}${formatted}` : `${formatted} ${normalizedUnit}`;
}

function normalizeTitle(chartType: ChartType, rawTitle?: string): string {
  const title = rawTitle?.trim();
  if (title) {
    return title;
  }

  if (chartType === "pie") {
    return "Pie Chart";
  }

  if (chartType === "area-line") {
    return "Area Line Chart";
  }

  return "Funnel Chart";
}

function normalizeColor(color: string | undefined, index: number): string {
  const candidate = color?.trim();
  if (candidate && HEX_COLOR_REGEX.test(candidate)) {
    return candidate;
  }
  return CHART_COLORS[index % CHART_COLORS.length];
}

function buildWarnings(chartType: ChartType, values: Array<{ value: number }>, total: number): string[] {
  const warnings: string[] = [];

  if (total === 0) {
    warnings.push("All point values are zero, so proportional comparisons are not meaningful.");
  }

  if (chartType === "pie" && values.length > 6) {
    warnings.push("Pie charts are easiest to read with 6 or fewer slices.");
  }

  if (chartType === "funnel") {
    for (let index = 1; index < values.length; index += 1) {
      if (values[index].value > values[index - 1].value) {
        warnings.push("Funnel values increase at one or more stages; this may indicate an atypical pipeline.");
        break;
      }
    }
  }

  return warnings;
}

function buildSummary(payload: ChartOutput): string {
  if (payload.chartType === "pie") {
    const largest = payload.points.reduce((max, point) => (point.value > max.value ? point : max), payload.points[0]);
    return `Pie chart \"${payload.title}\" has ${payload.points.length} slices. Largest share is ${largest.label} at ${formatPercent(largest.percentage)}.`;
  }

  if (payload.chartType === "area-line") {
    const first = payload.points[0];
    const last = payload.points[payload.points.length - 1];
    const delta = last.value - first.value;

    if (delta === 0) {
      return `Area line chart \"${payload.title}\" is flat from ${first.label} to ${last.label} (${formatValue(first.value, payload.unit)}).`;
    }

    if (first.value === 0) {
      return `Area line chart \"${payload.title}\" rises from ${first.label} (${formatValue(first.value, payload.unit)}) to ${last.label} (${formatValue(last.value, payload.unit)}).`;
    }

    const changePercent = (delta / first.value) * 100;
    const direction = delta > 0 ? "up" : "down";
    return `Area line chart \"${payload.title}\" trends ${direction} by ${formatPercent(Math.abs(changePercent))} from ${first.label} to ${last.label}.`;
  }

  const first = payload.points[0];
  const last = payload.points[payload.points.length - 1];
  const retention = first.value > 0 ? (last.value / first.value) * 100 : 0;
  let biggestDrop = { from: first.label, to: last.label, amount: 0 };

  for (let index = 1; index < payload.points.length; index += 1) {
    const previous = payload.points[index - 1];
    const current = payload.points[index];
    const drop = previous.value - current.value;
    if (drop > biggestDrop.amount) {
      biggestDrop = {
        from: previous.label,
        to: current.label,
        amount: drop
      };
    }
  }

  return `Funnel chart \"${payload.title}\" retains ${formatPercent(retention)} from ${first.label} to ${last.label}. Largest drop is ${formatValue(biggestDrop.amount, payload.unit)} from ${biggestDrop.from} to ${biggestDrop.to}.`;
}

async function loadUiBundle(): Promise<string> {
  for (const path of UI_BUNDLE_CANDIDATES) {
    try {
      return await readFile(path, "utf8");
    } catch {
      // Keep trying other candidate locations.
    }
  }

  return [
    "<!doctype html>",
    "<html><body>",
    "<p>UI bundle not found. Run <code>npm run build</code> first.</p>",
    "</body></html>"
  ].join("");
}

function normalizePayload(chartType: ChartType, args: ChartBaseInput): ChartOutput {
  const title = normalizeTitle(chartType, args.title);

  const pointsBase = args.data.map((point, index) => ({
    label: point.label.trim() || `Point ${index + 1}`,
    value: point.value,
    color: normalizeColor(point.color, index)
  }));

  const total = round(pointsBase.reduce((sum, point) => sum + point.value, 0), 2);

  const points = pointsBase.map((point, index) => {
    const percentage = total > 0 ? round((point.value / total) * 100, 2) : 0;

    if (chartType !== "funnel") {
      return {
        ...point,
        percentage
      };
    }

    if (index === 0) {
      return {
        ...point,
        percentage,
        stageConversion: null
      };
    }

    const previous = pointsBase[index - 1].value;
    const stageConversion = previous > 0 ? round((point.value / previous) * 100, 2) : 0;

    return {
      ...point,
      percentage,
      stageConversion
    };
  });

  const warnings = buildWarnings(chartType, points, total);

  const payload: ChartOutput = {
    chartType: chartType,
    title,
    subtitle: args.subtitle,
    unit: args.unit,
    notes: args.notes,
    total,
    points,
    summary: "",
    warnings
  };

  payload.summary = buildSummary(payload);
  return payload;
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: APP_NAME,
      version: APP_VERSION
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  function formatToolResult(payload: ChartOutput) {
    const lines: string[] = [];

    lines.push(payload.summary);

    if (payload.warnings.length > 0) {
      lines.push("");
      lines.push(`Warnings: ${payload.warnings.join(" ")}`);
    }

    lines.push("");
    lines.push("Data breakdown:");
    for (const point of payload.points) {
      const pct = `${round(point.percentage, 1).toFixed(1)}%`;
      lines.push(`- ${point.label}: ${formatValue(point.value, payload.unit)} (${pct})`);
    }

    lines.push("");
    lines.push(`Total: ${formatValue(payload.total, payload.unit)}`);

    if (payload.notes) {
      lines.push("");
      lines.push(payload.notes);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n")
        }
      ],
      structuredContent: payload
    };
  }

  const toolMeta = {
    _meta: {
      ui: {
        resourceUri: APP_RESOURCE_URI
      }
    }
  };

  registerAppTool(
    server,
    "render_pie_chart",
    {
      title: "Render Pie Chart",
      description:
        "Render an interactive donut/pie chart. Use this when the user wants to visualize part-to-whole relationships, proportions, or percentage breakdowns across categories (e.g. market share, budget allocation, survey responses). Best with 2-6 slices.",
      inputSchema: chartBaseInputSchema,
      outputSchema: chartOutputSchema,
      ...toolMeta
    },
    async (args) => formatToolResult(normalizePayload("pie", args))
  );

  registerAppTool(
    server,
    "render_area_line_chart",
    {
      title: "Render Area Line Chart",
      description:
        "Render an interactive area line chart. Use this when the user wants to visualize trends over time or ordered sequences — such as revenue over months, user growth, temperature changes, or any continuous metric tracked across ordered intervals.",
      inputSchema: chartBaseInputSchema,
      outputSchema: chartOutputSchema,
      ...toolMeta
    },
    async (args) => formatToolResult(normalizePayload("area-line", args))
  );

  registerAppTool(
    server,
    "render_funnel_chart",
    {
      title: "Render Funnel Chart",
      description:
        "Render an interactive funnel chart. Use this when the user wants to visualize stage-by-stage conversion or drop-off in a sequential process — such as sales pipelines, signup flows, hiring funnels, or any workflow where items progressively filter down through stages.",
      inputSchema: chartBaseInputSchema,
      outputSchema: chartOutputSchema,
      ...toolMeta
    },
    async (args) => formatToolResult(normalizePayload("funnel", args))
  );

  registerAppResource(
    server,
    "Chart MCP App",
    APP_RESOURCE_URI,
    {
      description: "Interactive chart renderer for pie, area line, and funnel chart tool results."
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: RESOURCE_MIME_TYPE,
            text: await loadUiBundle(),
            _meta: {
              ui: {
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                },
                prefersBorder: true
              }
            }
          }
        ]
      };
    }
  );

  return server;
}
