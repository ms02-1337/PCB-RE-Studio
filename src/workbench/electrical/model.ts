import type { Point } from "../placement/projectDoc";
import type { ComponentDefinition } from "../../bridge/kicad";
export interface Terminal {
  number: string;
  netId?: string;
  nc?: boolean;
}
export interface ElectricalComponent {
  id: string;
  definition: ComponentDefinition;
  reference: string;
  value: string;
  partName: string;
  x: number;
  y: number;
  layerId: string;
  rotation: number;
  scale: number;
  locked?: boolean;
  markingId?: string;
  terminals: Terminal[];
}
export interface SchematicUnit {
  id: string;
  componentId: string;
  unit: number;
  bodyStyle?: number;
  x: number;
  y: number;
  rotation: number;
  flip?: boolean;
}
export interface WireAnchor {
  componentId: string;
  terminal: string;
  unit?: number;
}
export interface SchematicWire {
  id: string;
  points: Point[];
  start?: WireAnchor;
  end?: WireAnchor;
  netId?: string;
}
export interface SchematicLabel {
  id: string;
  x: number;
  y: number;
  netId: string;
  anchor?: WireAnchor;
}
export interface SchematicDocument {
  units: SchematicUnit[];
  wires: SchematicWire[];
  labels: SchematicLabel[];
}
