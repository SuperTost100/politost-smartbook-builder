#import "@preview/zap:0.6.0": *
#import "@preview/cetz:0.5.2": draw
#circuit({
  opamp("U1", (6, 0))
  resistor("R1", (0, 0.5), (3, 0.5), label: $R_1$)
  zwire((3, 0.5), "U1.minus")
  node("j", (3, 0.5))
  wire((3, 0.5), (3, 2.5))
  resistor("R2", (3, 2.5), (8, 2.5), label: $R_2$)
  wire((8, 2.5), (8, 0), "U1.out")
  node("k", (8, 0))
  zwire("U1.plus", (3, -1.5))
  ground("g", (3, -1.5))
  wire((8, 0), (9.5, 0))
  draw.content((-0.6, 0.5), $V_"in"$)
  draw.content((10.3, 0), $V_"out"$)
})
