"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { computeVisibleGraphData, getConnectedNodeIds } from "@/lib/graph";
import { OntologyEdge, OntologyNode, Polarity } from "@/lib/types";

// 캔버스 기반 라이브러리라 브라우저에서만 그릴 수 있다 (서버 렌더링 불가).
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

const NODE_COLOR: Record<OntologyNode["type"], string> = {
  Sector: "var(--node-sector)",
  Industry: "var(--node-industry)",
  Asset: "var(--node-asset)",
  Concept: "var(--node-concept)",
};

const NODE_RADIUS: Record<OntologyNode["type"], number> = {
  Sector: 10,
  Industry: 7,
  Asset: 6,
  Concept: 8,
};

function polarityColor(polarity: Polarity | undefined): string {
  if (polarity === "positive") return "var(--edge-positive)";
  if (polarity === "negative") return "var(--edge-negative)";
  if (polarity === "mixed") return "var(--edge-mixed)";
  return "var(--edge-default)";
}

// canvas는 CSS 변수를 못 읽으므로, 실제 렌더링 시점에 계산된 값(hex)으로 바꿔서 써야 한다.
function resolveColor(cssVarExpr: string): string {
  if (typeof window === "undefined") return "#888888";
  const match = /var\((--[\w-]+)\)/.exec(cssVarExpr);
  if (!match) return cssVarExpr;
  return getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() || "#888888";
}

interface GraphViewProps {
  expandedIds: Set<string>;
  selectedNodeId: string | null;
  onToggleExpand: (id: string) => void;
  onSelectNode: (id: string) => void;
  onBackgroundClick: () => void;
}

export default function GraphView({
  expandedIds,
  selectedNodeId,
  onToggleExpand,
  onSelectNode,
  onBackgroundClick,
}: GraphViewProps) {
  const graphData = useMemo(() => computeVisibleGraphData(expandedIds), [expandedIds]);
  const connectedIds = useMemo(
    () => (selectedNodeId ? getConnectedNodeIds(selectedNodeId) : new Set<string>()),
    [selectedNodeId]
  );

  return (
    <ForceGraph2D
      graphData={graphData as never}
      nodeId="id"
      nodeLabel={(node) => (node as OntologyNode).name}
      nodeRelSize={4}
      nodeVal={(node) => NODE_RADIUS[(node as OntologyNode).type]}
      nodeColor={(node) => resolveColor(NODE_COLOR[(node as OntologyNode).type])}
      nodeCanvasObjectMode={() => "after"}
      nodeCanvasObject={(node, ctx, globalScale) => {
        const n = node as OntologyNode & { x: number; y: number };
        const isSelected = n.id === selectedNodeId;
        const isDimmed = selectedNodeId !== null && !isSelected && !connectedIds.has(n.id);

        if (isSelected) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, NODE_RADIUS[n.type] + 3, 0, 2 * Math.PI);
          ctx.strokeStyle = resolveColor("var(--node-selected-ring)");
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        const fontSize = 12 / globalScale;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.globalAlpha = isDimmed ? 0.35 : 1;
        ctx.fillStyle = resolveColor("var(--foreground)");
        ctx.fillText(n.name, n.x, n.y + NODE_RADIUS[n.type] + 2);
        ctx.globalAlpha = 1;
      }}
      linkSource="source"
      linkTarget="target"
      linkColor={(link) => {
        const l = link as OntologyEdge;
        const isConnected = selectedNodeId !== null && (l.source === selectedNodeId || l.target === selectedNodeId);
        const dimmed = selectedNodeId !== null && !isConnected;
        const base = resolveColor(l.type === "AFFECTS" ? polarityColor(l.polarity) : "var(--edge-default)");
        return dimmed ? `${base}55` : base;
      }}
      linkWidth={(link) => {
        const l = link as OntologyEdge;
        return l.strength ? 0.6 + l.strength * 0.3 : 1;
      }}
      linkDirectionalArrowLength={(link) => ((link as OntologyEdge).type === "COMPETES_WITH" ? 0 : 4)}
      linkDirectionalArrowRelPos={1}
      linkLabel={(link) => (link as OntologyEdge).rationale ?? (link as OntologyEdge).type}
      onNodeClick={(node) => {
        const n = node as OntologyNode;
        if (n.type === "Sector" || n.type === "Industry") {
          onToggleExpand(n.id);
        }
        onSelectNode(n.id);
      }}
      onBackgroundClick={onBackgroundClick}
      cooldownTicks={100}
    />
  );
}
