import type { ElectricalComponent } from "./model";
export function fixtureComponent(
  id = "r1",
  reference = "R1",
): ElectricalComponent {
  return {
    id,
    reference,
    value: "10k",
    partName: "Resistor",
    x: 0,
    y: 0,
    layerId: "front",
    rotation: 0,
    scale: 1,
    terminals: [
      { number: "1", netId: "signal" },
      { number: "2", netId: "ground" },
    ],
    definition: {
      id: "resistor",
      name: "Resistor",
      partName: "Resistor",
      value: "10k",
      referencePrefix: "R",
      pinMap: { "1": "1", "2": "2" },
      footprint: {
        id: "r0603",
        name: "R_0603",
        source: "test",
        raw: '(footprint "R_0603" (version 20241229) (generator "pcb_re_studio") (layer "F.Cu") (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))',
        graphics: [],
        diagnostics: [],
        pads: [1, 2].map((number) => ({
          number: String(number),
          x: number === 1 ? -1 : 1,
          y: 0,
          width: 1,
          height: 1,
          rotation: 0,
          shape: "rect",
          plated: false,
          layers: ["F.Cu"],
        })),
      },
      symbol: {
        id: "resistor-symbol",
        name: "R",
        source: "test",
        raw: "test-symbol",
        reference: "R",
        diagnostics: [],
        units: [
          {
            unit: 1,
            bodyStyle: 1,
            graphics: [
              {
                kind: "rect",
                points: [
                  { x: -2, y: 1 },
                  { x: 2, y: -1 },
                ],
                width: 0.15,
                fill: false,
              },
            ],
            pins: [
              {
                number: "1",
                name: "~",
                x: -5,
                y: 0,
                rotation: 0,
                length: 3,
                electricalType: "passive",
                hidden: false,
              },
              {
                number: "2",
                name: "~",
                x: 5,
                y: 0,
                rotation: 180,
                length: 3,
                electricalType: "passive",
                hidden: false,
              },
            ],
          },
        ],
      },
    },
  };
}
