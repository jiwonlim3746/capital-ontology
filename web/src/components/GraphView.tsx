"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { computeVisibleGraphData, getConnectedNodeIds } from "@/lib/graph";
import { getNodeIcon } from "@/lib/nodeIcons";
import { OntologyEdge, OntologyNode, Polarity } from "@/lib/types";

// 캔버스 기반 라이브러리라 브라우저에서만 그릴 수 있다 (서버 렌더링 불가).
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

const NODE_COLOR: Record<OntologyNode["type"], string> = {
  Sector: "var(--node-sector)",
  Industry: "var(--node-industry)",
  Asset: "var(--node-asset)",
  Concept: "var(--node-concept)",
};

// 실제 화면에 그려지는 반지름(px). react-force-graph-2d는 nodeVal이 아니라
// r = sqrt(nodeVal) * nodeRelSize 공식으로 반지름을 정하므로, nodeVal 쪽에서 역산한다.
const NODE_REL_SIZE = 4; // ForceGraph2D의 nodeRelSize prop과 반드시 동일하게 유지
const NODE_RADIUS: Record<OntologyNode["type"], number> = {
  Sector: 14,
  Industry: 10,
  Asset: 9,
  Concept: 11,
};

function nodeValFromRadius(type: OntologyNode["type"]): number {
  return (NODE_RADIUS[type] / NODE_REL_SIZE) ** 2;
}

const ICON_FONT_FAMILY = '"Material Symbols Outlined"';

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
  nodes: OntologyNode[];
  edges: OntologyEdge[];
  expandedIds: Set<string>;
  selectedNodeId: string | null;
  onToggleExpand: (id: string) => void;
  onSelectNode: (id: string) => void;
  onBackgroundClick: () => void;
}

export default function GraphView({
  nodes,
  edges,
  expandedIds,
  selectedNodeId,
  onToggleExpand,
  onSelectNode,
  onBackgroundClick,
}: GraphViewProps) {
  const graphData = useMemo(() => computeVisibleGraphData(nodes, edges, expandedIds), [nodes, edges, expandedIds]);
  const connectedIds = useMemo(
    () => (selectedNodeId ? getConnectedNodeIds(edges, selectedNodeId) : new Set<string>()),
    [edges, selectedNodeId]
  );

  // 아이콘 폰트가 준비되기 전에 그래프를 그리면 아이콘이 빈 사각형(tofu)으로 나왔다가
  // 뒤늦게 나타나면서 노드가 흔들린다. 폰트를 먼저 기다렸다가 그래프를 마운트한다.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const fontsSupported = typeof document !== "undefined" && "fonts" in document;
    const ready = fontsSupported
      ? Promise.race([
          Promise.all([document.fonts.load(`16px ${ICON_FONT_FAMILY}`).catch(() => {}), document.fonts.ready]),
          // 폰트 요청이 막히거나 너무 오래 걸리는 경우(네트워크 차단 등) 그래프가
          // 영영 안 뜨는 걸 막기 위한 타임아웃 안전장치.
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ])
      : Promise.resolve();
    ready.then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!fontsReady) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        그래프 불러오는 중…
      </div>
    );
  }

  return (
    <ForceGraph2D
      graphData={graphData as never}
      nodeId="id"
      nodeLabel={(node) => (node as OntologyNode).name}
      nodeRelSize={NODE_REL_SIZE}
      nodeVal={(node) => nodeValFromRadius((node as OntologyNode).type)}
      nodeColor={(node) => resolveColor(NODE_COLOR[(node as OntologyNode).type])}
      nodeCanvasObjectMode={() => "after"}
      nodeCanvasObject={(node, ctx, globalScale) => {
        const n = node as OntologyNode & { x: number; y: number };
        const isSelected = n.id === selectedNodeId;
        const isDimmed = selectedNodeId !== null && !isSelected && !connectedIds.has(n.id);
        const radius = NODE_RADIUS[n.type];

        if (isSelected) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius + 3, 0, 2 * Math.PI);
          ctx.strokeStyle = resolveColor("var(--node-selected-ring)");
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.globalAlpha = isDimmed ? 0.35 : 1;

        // 배지 안쪽: 아이콘(Sector/Industry/Concept) 또는 티커 앞 두 글자(Asset).
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        if (n.type === "Asset") {
          const tickerText = (n.ticker ?? n.name).slice(0, 2).toUpperCase();
          ctx.font = `bold ${radius * 0.85}px sans-serif`;
          ctx.fillText(tickerText, n.x, n.y);
        } else {
          const icon = getNodeIcon(n);
          if (icon) {
            ctx.font = `${radius * 1.15}px ${ICON_FONT_FAMILY}`;
            ctx.fillText(icon, n.x, n.y);
          }
        }

        const fontSize = 12 / globalScale;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillStyle = resolveColor("var(--foreground)");
        ctx.fillText(n.name, n.x, n.y + radius + 2);
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
