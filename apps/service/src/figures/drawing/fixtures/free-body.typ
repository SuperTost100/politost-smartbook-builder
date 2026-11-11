#import "@preview/cetz:0.5.2": canvas, draw
#canvas({
  import draw: *
  let a = 30deg
  let (c, s) = (calc.cos(a), calc.sin(a))
  let arrow = (end: "stealth", fill: black)
  // the slope and the block, which sits on it at 3 cm from the corner
  line((0, 0), (6 * c, 6 * s), (6 * c, 0), close: true, fill: gray.lighten(85%))
  line((-0.3, 0), (6 * c + 0.4, 0))
  arc((0, 0), start: 0deg, stop: 30deg, radius: 1.5, anchor: "origin")
  content((1.0, 0.27), $alpha$)
  let base = (3 * c, 3 * s)
  let mid = (3 * c - 0.4 * s, 3 * s + 0.4 * c)
  group({
    translate(base)
    rotate(a)
    rect((-0.5, 0), (0.5, 0.8), fill: white)
  })
  // forces drawn from the centre of the block: normal force, friction along the slope, weight
  line(mid, (mid.at(0) - 1.9 * s, mid.at(1) + 1.9 * c), mark: arrow, stroke: blue)
  content((mid.at(0) - 2.3 * s, mid.at(1) + 2.3 * c), text(fill: blue)[$N$])
  line(mid, (mid.at(0) - 1.7 * c, mid.at(1) - 1.7 * s), mark: arrow, stroke: red)
  content((mid.at(0) - 2.1 * c, mid.at(1) - 2.0 * s), text(fill: red)[$F_a$])
  line(mid, (mid.at(0), mid.at(1) - 1.9), mark: arrow, stroke: green.darken(20%))
  content((mid.at(0) + 0.4, mid.at(1) - 1.8), text(fill: green.darken(20%))[$m g$])
})
