import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables
} from "@modelcontextprotocol/ext-apps";

type ChartType = "pie" | "area-line" | "funnel";

type ChartPoint = {
  label: string;
  value: number;
  percentage: number;
  color: string;
  stageConversion?: number | null;
};

type ChartPayload = {
  chartType: ChartType;
  title: string;
  subtitle?: string;
  notes?: string;
  unit?: string;
  total: number;
  points: ChartPoint[];
  summary: string;
  warnings?: string[];
};

type ToolResult = {
  isError?: boolean;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  structuredContent?: unknown;
};

type BasePoint = {
  label: string;
  value: number;
  color: string;
};

const FALLBACK_COLORS = [
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

const SVG_NS = "http://www.w3.org/2000/svg";
let generatedIdCounter = 0;

const chartEl = requireElement<HTMLElement>("[data-chart]");

const state: {
  inputArgs: Record<string, unknown>;
  payload: ChartPayload | null;
  activeIndex: number | null;
  pinnedIndex: number | null;
} = {
  inputArgs: {},
  payload: null,
  activeIndex: null,
  pinnedIndex: null
};

const app = new App({
  name: "chart-mcp-view",
  version: "0.2.0"
});

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nextId(prefix: string): string {
  generatedIdCounter += 1;
  return `${prefix}-${generatedIdCounter}`;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseChartType(value: unknown): ChartType | null {
  if (value === "pie" || value === "area-line" || value === "funnel") {
    return value;
  }
  return null;
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

  const prefixUnit =
    normalizedUnit === "$" || normalizedUnit === "\u20AC" || normalizedUnit === "\u00A3";
  return prefixUnit ? `${normalizedUnit}${formatted}` : `${formatted} ${normalizedUnit}`;
}

function normalizeColor(color: unknown, index: number): string {
  if (typeof color === "string") {
    const trimmed = color.trim();
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
      return trimmed;
    }
  }
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function defaultTitle(chartType: ChartType): string {
  if (chartType === "pie") {
    return "Pie Chart";
  }

  if (chartType === "area-line") {
    return "Area Line Chart";
  }

  return "Funnel Chart";
}

function buildWarnings(chartType: ChartType, points: BasePoint[], total: number): string[] {
  const warnings: string[] = [];

  if (total === 0) {
    warnings.push("All values are zero, so proportional comparisons are not meaningful.");
  }

  if (chartType === "pie" && points.length > 6) {
    warnings.push("Pie charts are usually easier to read with 6 or fewer slices.");
  }

  if (chartType === "funnel") {
    for (let index = 1; index < points.length; index += 1) {
      if (points[index].value > points[index - 1].value) {
        warnings.push("Some funnel stages increase in value, which may indicate non-linear pipeline behavior.");
        break;
      }
    }
  }

  return warnings;
}

function buildChartPoints(chartType: ChartType, points: BasePoint[], total: number): ChartPoint[] {
  return points.map((point, index) => {
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

    const previous = points[index - 1].value;
    const stageConversion = previous > 0 ? round((point.value / previous) * 100, 2) : 0;

    return {
      ...point,
      percentage,
      stageConversion
    };
  });
}

function buildSummary(chartType: ChartType, title: string, points: ChartPoint[], total: number, unit?: string): string {
  if (points.length === 0) {
    return "No points available to summarize.";
  }

  if (chartType === "pie") {
    const largest = points.reduce((max, point) => (point.value > max.value ? point : max), points[0]);
    return `Pie chart \"${title}\" has ${points.length} slices. Largest share is ${largest.label} at ${formatPercent(largest.percentage)}.`;
  }

  if (chartType === "area-line") {
    const first = points[0];
    const last = points[points.length - 1];
    const delta = last.value - first.value;

    if (delta === 0) {
      return `Area line chart \"${title}\" is flat from ${first.label} to ${last.label} (${formatValue(first.value, unit)}).`;
    }

    if (first.value === 0) {
      return `Area line chart \"${title}\" rises from ${first.label} (${formatValue(first.value, unit)}) to ${last.label} (${formatValue(last.value, unit)}).`;
    }

    const changePercent = (delta / first.value) * 100;
    const direction = delta > 0 ? "up" : "down";
    return `Area line chart \"${title}\" trends ${direction} by ${formatPercent(Math.abs(changePercent))} from ${first.label} to ${last.label}.`;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const retention = first.value > 0 ? (last.value / first.value) * 100 : 0;

  let biggestDrop = {
    from: first.label,
    to: last.label,
    amount: 0
  };

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const drop = previous.value - current.value;

    if (drop > biggestDrop.amount) {
      biggestDrop = {
        from: previous.label,
        to: current.label,
        amount: drop
      };
    }
  }

  return `Funnel chart \"${title}\" retains ${formatPercent(retention)} from ${first.label} to ${last.label}. Largest drop is ${formatValue(biggestDrop.amount, unit)} from ${biggestDrop.from} to ${biggestDrop.to}.`;
}

function toBasePointFromStructured(value: unknown, index: number): BasePoint | null {
  if (!isRecord(value)) {
    return null;
  }

  const label = typeof value.label === "string" ? value.label.trim() : "";
  const rawValue = typeof value.value === "number" && Number.isFinite(value.value) ? value.value : NaN;

  if (!label || Number.isNaN(rawValue) || rawValue < 0) {
    return null;
  }

  return {
    label,
    value: rawValue,
    color: normalizeColor(value.color, index)
  };
}

function coercePayload(value: unknown): ChartPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const chartType = parseChartType(value.chartType);
  if (!chartType) {
    return null;
  }

  const rawPoints = Array.isArray(value.points) ? value.points : [];
  const basePoints = rawPoints
    .map((point, index) => toBasePointFromStructured(point, index))
    .filter((point): point is BasePoint => point !== null);

  if (basePoints.length < 2) {
    return null;
  }

  const computedTotal = round(basePoints.reduce((sum, point) => sum + point.value, 0), 2);
  const total =
    typeof value.total === "number" && Number.isFinite(value.total) && value.total >= 0
      ? round(value.total, 2)
      : computedTotal;

  const unit = typeof value.unit === "string" ? value.unit.trim() : "";
  const points = buildChartPoints(chartType, basePoints, total > 0 ? total : computedTotal);

  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : defaultTitle(chartType);
  const subtitle = typeof value.subtitle === "string" && value.subtitle.trim() ? value.subtitle.trim() : undefined;
  const notes = typeof value.notes === "string" && value.notes.trim() ? value.notes.trim() : undefined;
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
    : buildWarnings(chartType, basePoints, total);

  const summary =
    typeof value.summary === "string" && value.summary.trim()
      ? value.summary.trim()
      : buildSummary(chartType, title, points, total, unit || undefined);

  return {
    chartType,
    title,
    subtitle,
    notes,
    unit: unit || undefined,
    total,
    points,
    summary,
    warnings
  };
}

function toBasePointFromInput(value: unknown, index: number): BasePoint | null {
  if (!isRecord(value)) {
    return null;
  }

  const label = typeof value.label === "string" ? value.label.trim() : "";
  const rawValue = typeof value.value === "number" && Number.isFinite(value.value) ? value.value : NaN;

  if (!label || Number.isNaN(rawValue) || rawValue < 0) {
    return null;
  }

  return {
    label,
    value: rawValue,
    color: normalizeColor(value.color, index)
  };
}

function payloadFromInput(input: Record<string, unknown>): ChartPayload | null {
  const chartType = parseChartType(input.chartType);
  if (!chartType) {
    return null;
  }

  const rawData = Array.isArray(input.data) ? input.data : [];
  const basePoints = rawData
    .map((point, index) => toBasePointFromInput(point, index))
    .filter((point): point is BasePoint => point !== null);

  if (basePoints.length < 2) {
    return null;
  }

  const total = round(basePoints.reduce((sum, point) => sum + point.value, 0), 2);
  const points = buildChartPoints(chartType, basePoints, total);
  const unit = typeof input.unit === "string" ? input.unit.trim() : "";

  const title =
    typeof input.title === "string" && input.title.trim().length > 0
      ? input.title.trim()
      : defaultTitle(chartType);

  const notes =
    typeof input.notes === "string" && input.notes.trim().length > 0
      ? input.notes.trim()
      : undefined;

  const warnings = buildWarnings(chartType, basePoints, total);
  const summary = buildSummary(chartType, title, points, total, unit || undefined);

  return {
    chartType,
    title,
    unit: unit || undefined,
    notes,
    total,
    points,
    summary,
    warnings
  };
}

function createSvgElement<T extends keyof SVGElementTagNameMap>(tagName: T): SVGElementTagNameMap[T] {
  return document.createElementNS(SVG_NS, tagName);
}

function polarToCartesian(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius
  };
}

function describeDonutArc(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const sweep = endAngle - startAngle;
  const adjustedEnd = sweep >= Math.PI * 2 ? endAngle - 0.0001 : endAngle;
  const largeArc = adjustedEnd - startAngle > Math.PI ? 1 : 0;

  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, adjustedEnd);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, adjustedEnd);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z"
  ].join(" ");
}

function setChartPlaceholder(message: string): void {
  chartEl.innerHTML = "";
  chartEl.classList.add("chart-empty");
  chartEl.textContent = message;
}

function attachPointInteractions(element: Element, index: number): void {
  element.setAttribute("data-point-index", String(index));

  if (element instanceof SVGElement) {
    element.setAttribute("tabindex", "0");
    element.setAttribute("role", "button");
  }

  element.addEventListener("mouseenter", () => {
    if (state.pinnedIndex === null) {
      state.activeIndex = index;
      applySelectionStyles();
    }
  });

  element.addEventListener("mouseleave", () => {
    if (state.pinnedIndex === null) {
      state.activeIndex = null;
      applySelectionStyles();
    }
  });

  element.addEventListener("focus", () => {
    if (state.pinnedIndex === null) {
      state.activeIndex = index;
      applySelectionStyles();
    }
  });

  element.addEventListener("blur", () => {
    if (state.pinnedIndex === null) {
      state.activeIndex = null;
      applySelectionStyles();
    }
  });

  element.addEventListener("click", (event) => {
    event.preventDefault();

    if (state.pinnedIndex === index) {
      state.pinnedIndex = null;
      state.activeIndex = null;
    } else {
      state.pinnedIndex = index;
      state.activeIndex = index;
    }

    applySelectionStyles();
  });

  element.addEventListener("keydown", (event) => {
    const keyEvent = event as KeyboardEvent;

    if (keyEvent.key === "Enter" || keyEvent.key === " ") {
      keyEvent.preventDefault();
      if (state.pinnedIndex === index) {
        state.pinnedIndex = null;
        state.activeIndex = null;
      } else {
        state.pinnedIndex = index;
        state.activeIndex = index;
      }
      applySelectionStyles();
      return;
    }

    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      state.pinnedIndex = null;
      state.activeIndex = null;
      applySelectionStyles();
    }
  });
}

function applySelectionStyles(): void {
  const pointElements = document.querySelectorAll<Element>("[data-point-index]");
  const hasActive = state.activeIndex !== null;

  for (const element of pointElements) {
    const indexText = element.getAttribute("data-point-index");
    const pointIndex = indexText ? Number.parseInt(indexText, 10) : Number.NaN;

    if (Number.isNaN(pointIndex)) {
      continue;
    }

    const isActive = hasActive && pointIndex === state.activeIndex;
    const isDimmed = hasActive && pointIndex !== state.activeIndex;

    element.classList.toggle("is-active", isActive);
    element.classList.toggle("is-dimmed", isDimmed);
  }
}

function renderPieChart(payload: ChartPayload): SVGSVGElement {
  const width = 340;
  const height = 292;
  const centerX = width / 2;
  const centerY = 140;
  const outerRadius = 116;
  const innerRadius = 64;

  const svg = createSvgElement("svg");
  svg.classList.add("chart-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  if (payload.total <= 0) {
    const text = createSvgElement("text");
    text.setAttribute("x", String(centerX));
    text.setAttribute("y", String(centerY));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "tick-label");
    text.textContent = "No non-zero values to draw";
    svg.append(text);
    return svg;
  }

  let angleCursor = -Math.PI / 2;

  for (let index = 0; index < payload.points.length; index += 1) {
    const point = payload.points[index];

    if (point.value <= 0) {
      continue;
    }

    const angleSize = (point.value / payload.total) * Math.PI * 2;
    const startAngle = angleCursor;
    const endAngle = angleCursor + angleSize;
    angleCursor = endAngle;

    const group = createSvgElement("g");
    group.classList.add("chart-point");

    const path = createSvgElement("path");
    path.classList.add("pie-slice");
    path.setAttribute("fill", point.color);
    path.setAttribute(
      "d",
      describeDonutArc(centerX, centerY, outerRadius, innerRadius, startAngle, endAngle)
    );

    const title = createSvgElement("title");
    title.textContent = `${point.label}: ${formatValue(point.value, payload.unit)} (${formatPercent(point.percentage)})`;

    path.append(title);
    group.append(path);

    if (point.percentage >= 8) {
      const mid = startAngle + angleSize / 2;
      const labelPoint = polarToCartesian(centerX, centerY, (outerRadius + innerRadius) / 2, mid);
      const percentageLabel = createSvgElement("text");
      percentageLabel.setAttribute("x", String(labelPoint.x));
      percentageLabel.setAttribute("y", String(labelPoint.y + 4));
      percentageLabel.setAttribute("text-anchor", "middle");
      percentageLabel.setAttribute("fill", "#ffffff");
      percentageLabel.setAttribute("font-size", "11");
      percentageLabel.textContent = formatPercent(point.percentage);
      group.append(percentageLabel);
    }

    attachPointInteractions(group, index);
    svg.append(group);
  }

  const centerLabel = createSvgElement("text");
  centerLabel.classList.add("pie-center-label");
  centerLabel.setAttribute("x", String(centerX));
  centerLabel.setAttribute("y", String(centerY - 6));
  centerLabel.textContent = "Total";

  const centerValue = createSvgElement("text");
  centerValue.classList.add("pie-center-value");
  centerValue.setAttribute("x", String(centerX));
  centerValue.setAttribute("y", String(centerY + 18));
  centerValue.textContent = formatValue(payload.total, payload.unit);

  svg.append(centerLabel, centerValue);
  return svg;
}

function renderAreaLineChart(payload: ChartPayload): SVGSVGElement {
  const width = 760;
  const height = 320;
  const margin = {
    top: 18,
    right: 20,
    bottom: 62,
    left: 54
  };

  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const bottomY = margin.top + plotHeight;

  const svg = createSvgElement("svg");
  svg.classList.add("chart-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const maxValue = Math.max(...payload.points.map((point) => point.value), 1);

  const positions = payload.points.map((point, index) => {
    const x =
      payload.points.length === 1
        ? margin.left + plotWidth / 2
        : margin.left + (index / (payload.points.length - 1)) * plotWidth;
    const y = margin.top + plotHeight - (point.value / maxValue) * plotHeight;

    return {
      x,
      y,
      point,
      index
    };
  });

  for (let tick = 0; tick <= 4; tick += 1) {
    const ratio = tick / 4;
    const y = margin.top + ratio * plotHeight;

    const grid = createSvgElement("line");
    grid.classList.add("chart-grid");
    grid.setAttribute("x1", String(margin.left));
    grid.setAttribute("x2", String(width - margin.right));
    grid.setAttribute("y1", String(y));
    grid.setAttribute("y2", String(y));

    const label = createSvgElement("text");
    label.classList.add("tick-label");
    label.setAttribute("x", String(margin.left - 8));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("text-anchor", "end");
    label.textContent = formatValue(maxValue - ratio * maxValue, payload.unit);

    svg.append(grid, label);
  }

  const gradientId = nextId("area-gradient");
  const defs = createSvgElement("defs");
  const gradient = createSvgElement("linearGradient");
  gradient.setAttribute("id", gradientId);
  gradient.setAttribute("x1", "0%");
  gradient.setAttribute("x2", "0%");
  gradient.setAttribute("y1", "0%");
  gradient.setAttribute("y2", "100%");

  const stopTop = createSvgElement("stop");
  stopTop.setAttribute("offset", "0%");
  stopTop.setAttribute("style", "stop-color: var(--app-accent); stop-opacity: 0.48;");

  const stopBottom = createSvgElement("stop");
  stopBottom.setAttribute("offset", "100%");
  stopBottom.setAttribute("style", "stop-color: var(--app-accent); stop-opacity: 0;");

  gradient.append(stopTop, stopBottom);
  defs.append(gradient);
  svg.append(defs);

  const first = positions[0];
  const last = positions[positions.length - 1];

  const lineData = positions
    .map((position, index) => `${index === 0 ? "M" : "L"} ${position.x} ${position.y}`)
    .join(" ");

  const areaData = [`M ${first.x} ${bottomY}`]
    .concat(positions.map((position) => `L ${position.x} ${position.y}`))
    .concat([`L ${last.x} ${bottomY}`, "Z"])
    .join(" ");

  const area = createSvgElement("path");
  area.classList.add("area-fill");
  area.setAttribute("d", areaData);
  area.setAttribute("fill", `url(#${gradientId})`);

  const line = createSvgElement("path");
  line.classList.add("area-line");
  line.setAttribute("d", lineData);

  svg.append(area, line);

  const labelStep = payload.points.length > 10 ? Math.ceil(payload.points.length / 10) : 1;

  for (const position of positions) {
    const group = createSvgElement("g");
    group.classList.add("chart-point");

    const pointCircle = createSvgElement("circle");
    pointCircle.classList.add("line-point");
    pointCircle.setAttribute("cx", String(position.x));
    pointCircle.setAttribute("cy", String(position.y));
    pointCircle.setAttribute("r", "5");
    pointCircle.setAttribute("fill", position.point.color);

    const pointTitle = createSvgElement("title");
    pointTitle.textContent = `${position.point.label}: ${formatValue(position.point.value, payload.unit)} (${formatPercent(position.point.percentage)})`;

    pointCircle.append(pointTitle);
    group.append(pointCircle);
    attachPointInteractions(group, position.index);

    svg.append(group);

    if (position.index % labelStep === 0 || position.index === positions.length - 1) {
      const xLabel = createSvgElement("text");
      xLabel.classList.add("axis-label");
      xLabel.setAttribute("x", String(position.x));
      xLabel.setAttribute("y", String(bottomY + 20));
      xLabel.setAttribute("text-anchor", "middle");
      xLabel.textContent = position.point.label;
      svg.append(xLabel);
    }
  }

  return svg;
}

function renderFunnelChart(payload: ChartPayload): SVGSVGElement {
  const width = 760;
  const stageHeight = 58;
  const stageGap = 10;
  const topPadding = 18;
  const sidePadding = 34;
  const innerWidth = width - sidePadding * 2;

  const height = topPadding + payload.points.length * stageHeight + (payload.points.length - 1) * stageGap + 16;

  const svg = createSvgElement("svg");
  svg.classList.add("chart-svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const maxValue = Math.max(...payload.points.map((point) => point.value), 1);
  const centerX = width / 2;

  for (let index = 0; index < payload.points.length; index += 1) {
    const current = payload.points[index];
    const next = payload.points[index + 1];

    const topRatio = Math.max(current.value / maxValue, 0.08);
    const bottomRatio = next ? Math.max(next.value / maxValue, 0.08) : Math.max(topRatio * 0.72, 0.05);

    const topWidth = innerWidth * topRatio;
    const bottomWidth = innerWidth * bottomRatio;

    const yTop = topPadding + index * (stageHeight + stageGap);
    const yBottom = yTop + stageHeight;

    const topLeft = centerX - topWidth / 2;
    const topRight = centerX + topWidth / 2;
    const bottomLeft = centerX - bottomWidth / 2;
    const bottomRight = centerX + bottomWidth / 2;

    const group = createSvgElement("g");
    group.classList.add("chart-point");

    const polygon = createSvgElement("polygon");
    polygon.classList.add("funnel-band");
    polygon.setAttribute("fill", current.color);
    polygon.setAttribute(
      "points",
      `${topLeft},${yTop} ${topRight},${yTop} ${bottomRight},${yBottom} ${bottomLeft},${yBottom}`
    );

    const title = createSvgElement("title");
    let titleText = `${current.label}: ${formatValue(current.value, payload.unit)} (${formatPercent(current.percentage)})`;
    if (index > 0 && current.stageConversion !== null && current.stageConversion !== undefined) {
      titleText += ` | ${formatPercent(current.stageConversion)} stage conversion`;
    }
    title.textContent = titleText;

    polygon.append(title);
    group.append(polygon);

    const label = createSvgElement("text");
    label.classList.add("funnel-label");
    label.setAttribute("x", String(centerX));
    label.setAttribute("y", String(yTop + stageHeight / 2 - 3));
    label.textContent = current.label;

    const value = createSvgElement("text");
    value.classList.add("funnel-value");
    value.setAttribute("x", String(centerX));
    value.setAttribute("y", String(yTop + stageHeight / 2 + 14));

    let valueText = `${formatValue(current.value, payload.unit)} | ${formatPercent(current.percentage)}`;
    if (index > 0 && current.stageConversion !== null && current.stageConversion !== undefined) {
      valueText += ` | ${formatPercent(current.stageConversion)}`;
    }

    value.textContent = valueText;

    group.append(label, value);
    attachPointInteractions(group, index);
    svg.append(group);
  }

  return svg;
}

function renderChart(payload: ChartPayload): void {
  chartEl.innerHTML = "";
  chartEl.classList.remove("chart-empty");

  let chartNode: SVGSVGElement;
  if (payload.chartType === "pie") {
    chartNode = renderPieChart(payload);
  } else if (payload.chartType === "area-line") {
    chartNode = renderAreaLineChart(payload);
  } else {
    chartNode = renderFunnelChart(payload);
  }

  chartEl.append(chartNode);
}

function renderPayload(payload: ChartPayload): void {
  state.payload = payload;
  state.activeIndex = null;
  state.pinnedIndex = null;

  renderChart(payload);
  applySelectionStyles();
}

function applyHostContext(): void {
  const context = app.getHostContext();
  if (!context) {
    return;
  }

  if (context.theme) {
    applyDocumentTheme(context.theme);
  }

  if (context.styles?.variables) {
    applyHostStyleVariables(context.styles.variables);
  }

  if (context.styles?.css?.fonts) {
    applyHostFonts(context.styles.css.fonts);
  }
}

app.ontoolinput = (params) => {
  state.inputArgs = isRecord(params.arguments) ? params.arguments : {};
  state.payload = null;
  state.activeIndex = null;
  state.pinnedIndex = null;

  setChartPlaceholder("");
};

app.ontoolresult = (result) => {
  const toolResult = result as ToolResult;

  if (toolResult.isError) {
    setChartPlaceholder("");
    return;
  }

  const parsedFromResult = coercePayload(toolResult.structuredContent);
  const parsedPayload = parsedFromResult ?? payloadFromInput(state.inputArgs);

  if (!parsedPayload) {
    setChartPlaceholder("");
    return;
  }

  renderPayload(parsedPayload);
};

app.ontoolcancelled = () => {
  setChartPlaceholder("");
};

app.onhostcontextchanged = () => {
  applyHostContext();
};

app.onteardown = async () => {
  return {};
};

async function connect(): Promise<void> {
  try {
    await app.connect();
    applyHostContext();
  } catch {
    // Connection failed silently — chart will render when tool result arrives.
  }
}

void connect();
