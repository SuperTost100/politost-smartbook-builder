#import "@preview/cetz:0.5.2": canvas, draw
#canvas({
  import draw: *
  let arrow = (end: "stealth", fill: black)
  rect((0, 0), (8, 0.3), fill: gray.lighten(75%))
  // pin support at A, roller support at B
  line((0, 0), (-0.4, -0.7), (0.4, -0.7), close: true, fill: white)
  line((-0.7, -0.7), (0.7, -0.7))
  line((8, 0), (7.6, -0.6), (8.4, -0.6), close: true, fill: white)
  circle((7.7, -0.75), radius: 0.15, fill: white); circle((8.3, -0.75), radius: 0.15, fill: white)
  line((7.3, -0.9), (8.7, -0.9))
  // point load F and distributed load q
  line((2.5, 2.2), (2.5, 0.35), mark: arrow, stroke: red)
  content((2.5, 2.55), text(fill: red)[$F$])
  for i in range(0, 5) {
    let x = 4.6 + i * 0.85
    line((x, 1.5), (x, 0.35), mark: arrow, stroke: blue)
  }
  line((4.6, 1.5), (8, 1.5), stroke: blue)
  content((6.3, 1.85), text(fill: blue)[$q$])
  // reactions
  line((0, -1.9), (0, -0.8), mark: arrow)
  content((0.5, -1.6), $R_A$)
  line((8, -1.9), (8, -1.0), mark: arrow)
  content((8.5, -1.6), $R_B$)
  // dimension
  line((0, -2.5), (8, -2.5), mark: (start: "stealth", end: "stealth", fill: black))
  content((4, -2.8), $L$)
})
