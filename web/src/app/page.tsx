"use client";

import { useState } from "react";
import GraphView from "@/components/GraphView";
import DetailPanel from "@/components/DetailPanel";
import { computeAncestorChain } from "@/lib/graph";
import { nodeById } from "@/lib/mockData";

export default function Home() {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const jumpToNode = (id: string) => {
    setExpandedIds((prev) => new Set([...prev, ...computeAncestorChain(id)]));
    setSelectedNodeId(id);
  };

  const selectedNode = selectedNodeId ? (nodeById.get(selectedNodeId) ?? null) : null;

  return (
    <div className="flex flex-1 overflow-hidden">
      <main className="relative min-w-0 flex-1">
        <div className="pointer-events-none absolute left-4 top-4 z-10 text-xs text-zinc-500 dark:text-zinc-400">
          섹터·산업 노드를 클릭하면 하위 노드가 펼쳐집니다. 종목을 클릭하면 오른쪽에 상세 정보가 뜹니다.
        </div>
        <GraphView
          expandedIds={expandedIds}
          selectedNodeId={selectedNodeId}
          onToggleExpand={toggleExpand}
          onSelectNode={setSelectedNodeId}
          onBackgroundClick={() => setSelectedNodeId(null)}
        />
      </main>
      <DetailPanel node={selectedNode} onJumpToNode={jumpToNode} onClose={() => setSelectedNodeId(null)} />
    </div>
  );
}
