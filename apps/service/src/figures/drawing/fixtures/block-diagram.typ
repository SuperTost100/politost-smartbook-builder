#import "@preview/fletcher:0.5.8" as fletcher: diagram, node, edge
#diagram(
  node-stroke: 0.8pt, spacing: (22mm, 14mm),
  node((1, 0), [$+$], shape: circle, name: <sum>),
  node((2, 0), [$C(s)$], shape: rect, name: <c>),
  node((3, 0), [$G(s)$], shape: rect, name: <g>),
  node((3, 1), [$H(s)$], shape: rect, name: <h>),
  edge((0, 0), <sum>, "-|>", [$R(s)$]),
  edge(<sum>, <c>, "-|>", [$E(s)$]),
  edge(<c>, <g>, "-|>", [$U(s)$]),
  edge(<g>, (4.2, 0), "-|>", [$Y(s)$]),
  edge((3.8, 0), (3.8, 1), <h>, "-|>"),
  edge(<h>, (1, 1), <sum>, "-|>", [$-$]),
)
