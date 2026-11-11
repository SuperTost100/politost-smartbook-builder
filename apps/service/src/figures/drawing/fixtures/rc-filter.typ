#import "@preview/zap:0.6.0": *
#import "@preview/cetz:0.5.2": draw
#circuit({
  vsource("V1", (0, 0), (0, 3), label: $V_"in"$)
  wire((0, 3), (1, 3))
  resistor("R1", (1, 3), (4, 3), label: $R$)
  node("o", (4, 3))
  capacitor("C1", (4, 3), (4, 0), label: $C$)
  wire((4, 3), (6, 3))
  wire((0, 0), (6, 0))
  node("g", (4, 0))
  ground("gnd", (3, -0.8))
  wire((3, 0), (3, -0.8))
  draw.content((6.7, 3), $V_"out"$)
})
