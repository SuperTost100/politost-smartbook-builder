#import "@preview/cetz:0.5.2": canvas, draw
#canvas({
  import draw: *
  let node(pos, label, name) = {
    circle(pos, radius: 0.4, fill: white, name: name)
    content(pos, label)
  }
  let edge(a, b) = line(a, b, stroke: 0.8pt)
  node((0, 0), [$8$], "r")
  node((-2.4, -1.6), [$3$], "a")
  node((2.4, -1.6), [$10$], "b")
  node((-3.6, -3.2), [$1$], "c")
  node((-1.2, -3.2), [$6$], "d")
  node((3.6, -3.2), [$14$], "e")
  node((-2.2, -4.8), [$4$], "f")
  edge("r.south-west", "a.north-east"); edge("r.south-east", "b.north-west")
  edge("a.south-west", "c.north-east"); edge("a.south-east", "d.north-west")
  edge("b.south-east", "e.north-west"); edge("d.south-west", "f.north-east")
})
