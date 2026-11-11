#import "@preview/fletcher:0.5.8" as fletcher: diagram, node, edge
#diagram(
  node-stroke: 0.8pt, spacing: (28mm, 18mm),
  node((0, 0), [$S_0$], shape: circle, name: <s0>),
  node((1, 0), [$S_1$], shape: circle, name: <s1>),
  node((2, 0), [$S_2$], shape: circle, name: <s2>, extrude: (0, 3)),
  edge((-0.8, 0), <s0>, "-|>", [Reset]),
  edge(<s0>, <s1>, "-|>", [$x = 1$], bend: 20deg),
  edge(<s1>, <s0>, "-|>", [$x = 0$], bend: 20deg),
  edge(<s1>, <s2>, "-|>", [$x = 1$]),
  edge(<s0>, <s0>, "-|>", [$x = 0$], bend: 130deg, loop-angle: 90deg),
  edge(<s2>, <s2>, "-|>", [$x = 0, 1$], bend: 130deg, loop-angle: 90deg),
)
