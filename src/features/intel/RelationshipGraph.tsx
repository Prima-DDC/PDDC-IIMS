"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Network } from "lucide-react";
import { Button, EmptyState, Muted } from "@/components/ui";
import {
  ENTITY_TYPE_LABELS,
  RELATIONSHIP_TYPE_LABELS,
  type Entity,
  type Relationship,
} from "@/modules/intel/shared";

/**
 * Link analysis (PRD screens 10 and 17).
 *
 * Cytoscape, imported on demand rather than bundled: it is the largest
 * dependency in the application and most screens never show a graph. The
 * import happens when somebody asks for the graph, so the case page costs
 * nothing for it.
 *
 * Colour carries the entity type and the thickness of an edge carries
 * confidence, which is the one thing a reader of a link chart most needs and
 * most often does not get: a thin line is somebody's unverified assertion and
 * should not look like a registry extract. Nothing here relies on colour
 * alone, because the list beside it says the same thing in words.
 *
 * The layout is deterministic (a breadth-first tree from the subjects asked
 * for) rather than force-directed. A force layout settles differently every
 * time, and a chart that rearranges itself between two visits is one nobody
 * trusts.
 */

const TYPE_COLOURS: Record<string, string> = {
  person: "#2E9E4F",
  company: "#0B1F3A",
  organisation: "#1F3B63",
  government_body: "#6B4E9E",
  property: "#8A6A3B",
  vehicle: "#8A6A3B",
  account: "#A8543B",
  asset: "#A8543B",
  other: "#5B6472",
};

const CONFIDENCE_WIDTH: Record<string, number> = {
  high: 3.5,
  moderate: 2,
  low: 1.2,
  unverified: 1,
};

export function RelationshipGraph({
  entities,
  relationships,
  /** The subjects the graph was built around, drawn larger. */
  focusIds = [],
}: {
  entities: Entity[];
  relationships: Relationship[];
  focusIds?: string[];
}) {
  const [shown, setShown] = useState(false);

  if (entities.length === 0 || relationships.length === 0) {
    return (
      <EmptyState
        title="Nothing to draw yet"
        description="A graph needs at least one relationship between two subjects. Record the directorships and holdings, and the picture draws itself."
      />
    );
  }

  if (!shown) {
    return (
      <div className="space-y-3">
        <Muted>
          {entities.length} subjects and {relationships.length}{" "}
          {relationships.length === 1 ? "relationship" : "relationships"} within
          two hops. The chart is loaded on demand, because it is a large
          download and most of the time the list below is what you want.
        </Muted>
        <Button size="sm" onClick={() => setShown(true)}>
          <Network className="size-4" aria-hidden="true" />
          Draw the graph
        </Button>
      </div>
    );
  }

  return (
    <Canvas
      entities={entities}
      relationships={relationships}
      focusIds={focusIds}
    />
  );
}

function Canvas({
  entities,
  relationships,
  focusIds,
}: {
  entities: Entity[];
  relationships: Relationship[];
  focusIds: string[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let destroyed = false;
    // Kept so the cleanup can tear the instance down even if the import
    // resolves after the component has gone.
    let instance: { destroy: () => void } | null = null;

    void (async () => {
      try {
        const cytoscape = (await import("cytoscape")).default;
        if (destroyed || !container.current) return;

        const focus = new Set(focusIds);

        instance = cytoscape({
          container: container.current,
          elements: [
            ...entities.map((entity) => ({
              data: {
                id: entity.id,
                label: entity.name,
                colour: TYPE_COLOURS[entity.entityType] ?? TYPE_COLOURS.other,
                size: focus.has(entity.id) ? 46 : 30,
              },
            })),
            ...relationships.map((relationship) => ({
              data: {
                id: relationship.id,
                source: relationship.fromEntityId,
                target: relationship.toEntityId,
                label:
                  RELATIONSHIP_TYPE_LABELS[relationship.relationshipType] +
                  (relationship.percentage !== null
                    ? `, ${relationship.percentage}%`
                    : ""),
                width: CONFIDENCE_WIDTH[relationship.confidence] ?? 1,
              },
              // Dashed when nothing is cited for it, so an unsourced claim
              // never looks like a sourced one. A class rather than a mapped
              // style because `line-style` takes a literal, not a data
              // expression.
              classes:
                relationship.sourceId || relationship.evidenceItemId
                  ? ""
                  : "unsourced",
            })),
          ],
          style: [
            {
              selector: "node",
              style: {
                "background-color": "data(colour)",
                width: "data(size)",
                height: "data(size)",
                label: "data(label)",
                "font-size": "9px",
                "text-valign": "bottom",
                "text-margin-y": 5,
                "text-wrap": "ellipsis",
                "text-max-width": "110px",
                color: "#3A4452",
              },
            },
            {
              selector: "edge",
              style: {
                width: "data(width)",
                "line-color": "#94A0B0",
                "target-arrow-color": "#94A0B0",
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                label: "data(label)",
                "font-size": "8px",
                color: "#6B7585",
                "text-rotation": "autorotate",
                "text-background-color": "#ffffff",
                "text-background-opacity": 0.85,
                "text-background-padding": "2px",
              },
            },
            { selector: "edge.unsourced", style: { "line-style": "dashed" } },
          ],
          layout: {
            name: "breadthfirst",
            roots: focusIds.length > 0 ? focusIds : undefined,
            directed: true,
            padding: 24,
            spacingFactor: 1.15,
            // Deterministic: the same data draws the same chart every time,
            // which is what makes it worth comparing between two visits.
            animate: false,
          },
          // Read-only: this is a picture of the register, and editing happens
          // in the forms where a change can carry a reason.
          autounselectify: true,
          userZoomingEnabled: true,
          userPanningEnabled: true,
        });

        setState("ready");
      } catch {
        if (!destroyed) setState("failed");
      }
    })();

    return () => {
      destroyed = true;
      instance?.destroy();
    };
  }, [entities, relationships, focusIds]);

  if (state === "failed") {
    return (
      <EmptyState
        title="The graph could not be drawn"
        description="The chart library did not load. The relationships are listed below, which is the same information."
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <div
          ref={container}
          className="h-96 w-full rounded-lg border border-line bg-surface-sunken"
          role="img"
          aria-label={`Link chart of ${entities.length} subjects and ${relationships.length} relationships. The same information is listed below.`}
        />
        {state === "loading" && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading the chart
          </p>
        )}
      </div>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
        <span className="inline-flex items-center gap-1">
          <Maximize2 className="size-3" aria-hidden="true" />
          Scroll to zoom, drag to pan
        </span>
        <span>A thicker line is a higher confidence.</span>
        <span>A dashed line cites nothing yet.</span>
        {Object.entries(TYPE_COLOURS)
          .filter(([type]) => entities.some((e) => e.entityType === type))
          .map(([type, colour]) => (
            <span key={type} className="inline-flex items-center gap-1">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: colour }}
                aria-hidden="true"
              />
              {ENTITY_TYPE_LABELS[type as keyof typeof ENTITY_TYPE_LABELS]}
            </span>
          ))}
      </p>
    </div>
  );
}
