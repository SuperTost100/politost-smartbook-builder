# Typst (Typst 0.14, offline)

The builder adds the page (transparent, as large as the drawing), 12 pt text and the ink colour. Write no `#set page`, no `#set text`, no margins, no fonts, no images and no file access. Start the source with its imports.
Packages, with exactly these versions (any other import fails): `@preview/cetz:0.5.2`, `@preview/zap:0.6.0`, `@preview/fletcher:0.5.8`, `@preview/lilaq:0.6.0`, `@preview/finite:0.5.1`, `@preview/cetz-plot:0.1.4`. There is no timing-diagram package.
Pick by figure: circuits zap, block diagrams and state machines fletcher, plots with a log axis or a cycle lilaq, everything else (free-body diagrams, beams, trees, sketches, geometry) cetz.

## Text
- Math is `$...$`. A single letter stands alone (`$V$`, `$R_1$`). A name of two or more letters is quoted, or it fails as an unknown variable: `$V_"out"$`, `$"CLK"$`, `$"AB"$`, `$10 "kHz"$`. Greek letters go by name: `$omega$`, `$phi$`, `$theta$`. Write `\/` for a slash in math.
- Words are content (`[Ingresso]`) or a string (`"Ingresso"`), in the book's language. Never put a label on a line or on another label: leave a gap or move it.

## cetz (coordinates in cm, y up)
- `#import "@preview/cetz:0.5.2": canvas, draw`, then `#canvas({ import draw: *  ... })`. Calls on one line need `;` between them.
- `line(a, b, c, mark: (end: "stealth", fill: black), stroke: red)` is an arrow (there is no `arrow()`), `rect`, `circle(pos, radius: 0.3, name: "n")`, `arc(pos, start: 0deg, stop: 30deg, radius: 1)`, `content(pos, $m$, anchor: "west")`. `group({ translate(p); rotate(30deg); ... })` moves and rotates what is inside.
- A name must be drawn before another call uses it: `line("a.south", "b.north")`. Anchors: north south east west and the corners (`north-east`).
- Draw by explicit coordinates. For a tree put each parent over the middle of its children.

Beam with supports and loads:
```typ
#import "@preview/cetz:0.5.2": canvas, draw
#canvas({
  import draw: *
  let arrow = (end: "stealth", fill: black)
  rect((0, 0), (8, 0.3), fill: gray.lighten(75%))
  line((0, 0), (-0.4, -0.7), (0.4, -0.7), close: true, fill: white)   // pin at A
  line((8, 0), (7.6, -0.6), (8.4, -0.6), close: true, fill: white)    // roller at B
  circle((8, -0.75), radius: 0.15, fill: white)
  line((2.5, 2.2), (2.5, 0.35), mark: arrow, stroke: red)             // point load
  content((2.5, 2.55), text(fill: red)[$F$])
  for i in range(0, 5) { line((4.6 + i * 0.85, 1.5), (4.6 + i * 0.85, 0.35), mark: arrow, stroke: blue) }
  line((4.6, 1.5), (8, 1.5), stroke: blue)                            // distributed load
  content((6.3, 1.85), text(fill: blue)[$q$])
  line((0, -1.9), (0, -0.8), mark: arrow); content((0.5, -1.6), $R_A$)
  line((8, -1.9), (8, -1.0), mark: arrow); content((8.5, -1.6), $R_B$)
  line((0, -2.5), (8, -2.5), mark: (start: "stealth", end: "stealth", fill: black)); content((4, -2.8), $L$)
})
```
Binary tree:
```typ
#import "@preview/cetz:0.5.2": canvas, draw
#canvas({
  import draw: *
  let vertex(pos, label, name) = { circle(pos, radius: 0.4, fill: white, name: name); content(pos, label) }
  vertex((0, 0), [$8$], "r"); vertex((-2, -1.6), [$3$], "a"); vertex((2, -1.6), [$10$], "b")
  vertex((-3, -3.2), [$1$], "c"); vertex((-1, -3.2), [$6$], "d")
  line("r.south-west", "a.north-east"); line("r.south-east", "b.north-west")
  line("a.south-west", "c.north-east"); line("a.south-east", "d.north-west")
})
```

## zap (circuits)
- `#import "@preview/zap:0.6.0": *` and `#import "@preview/cetz:0.5.2": draw`, then `#circuit({ ... })`. Text goes through `draw.content((x, y), $V_"out"$)`; a bare `content` fails.
- Two-terminal parts take a name and two points: `resistor capacitor inductor diode led vsource isource acvsource battery switch`, with `label:`, `i:` (current arrow), `u:` (voltage arrow). One-point parts: `ground vcc node` (a junction dot), `opamp` (`.plus .minus .out`), `npn pnp` (`.b .c .e`), `nmos pmos` (`.g .d .s`, where `.d` is the top terminal and `.s` the bottom one in both, so the source of a PMOS on the supply is its `.d`).
- `wire(a, b, ...)` joins points and anchors in straight segments. `zwire(a, b)` routes with right angles. Put a `node` on every junction, and a ground in every circuit. A crossing without a node is no connection.
- `label:` and `u:` both go on the same side, so a part with both collides. Move the name to the other side: `label: (content: $R_1$, anchor: "south"), u: $V_1$`. Check the result on a vertical part.

CMOS inverter:
```typ
#import "@preview/zap:0.6.0": *
#import "@preview/cetz:0.5.2": draw
#circuit({
  pmos("MP", (3, 3), label: $M_P$)
  nmos("MN", (3, 0), label: $M_N$)
  vcc("vdd", (5, 5)); ground("gnd", (5, -2))
  zwire("MP.d", (5, 5)); zwire("MP.s", (5, 1.5)); zwire("MN.d", (5, 1.5)); zwire("MN.s", (5, -2))
  node("o", (5, 1.5)); wire((5, 1.5), (7, 1.5))
  zwire("MP.g", (1, 3)); zwire("MN.g", (1, 0)); wire((1, 3), (1, 0))
  node("a", (1, 1.5)); wire((1, 1.5), (-0.5, 1.5))
  draw.content((-1.2, 1.5), $V_"in"$); draw.content((7.8, 1.5), $V_"out"$); draw.content((5.9, 5), $V_"dd"$)
})
```
Common-emitter stage:
```typ
#import "@preview/zap:0.6.0": *
#import "@preview/cetz:0.5.2": draw
#circuit({
  npn("Q1", (4, 2.5), label: $Q_1$)
  vcc("vcc", (3.5, 8.5)); wire((3.5, 7.5), (3.5, 8.5)); wire((1, 7.5), (6, 7.5)); node("j", (3.5, 7.5))
  resistor("R1", (1, 7.5), (1, 4.5), label: $R_1$); wire((1, 4.5), (1, 2.5))
  resistor("R2", (1, 2.5), (1, 0.5), label: $R_2$); wire((1, 0.5), (1, -1)); ground("g1", (1, -1))
  zwire("Q1.b", (1, 2.5)); node("b", (1, 2.5)); wire((1, 2.5), (-1, 2.5))
  draw.content((-1.8, 2.5), $V_"in"$)
  zwire("Q1.c", (6, 4)); resistor("RC", (6, 4), (6, 6.2), label: $R_C$); wire((6, 6.2), (6, 7.5))
  node("o", (6, 4)); wire((6, 4), (8, 4)); draw.content((8.9, 4), $V_"out"$)
  zwire("Q1.e", (6, 1)); resistor("RE", (6, 1), (6, -1), label: $R_E$); wire((6, -1), (6, -2.5)); ground("g2", (6, -2.5))
})
```
Divider with voltages:
```typ
#import "@preview/zap:0.6.0": *
#circuit({
  vsource("Vs", (0, 0), (0, 5), label: $V_s$)
  wire((0, 5), (3, 5)); wire((0, 0), (3, 0)); ground("g", (1.5, 0)); node("n", (3, 2.5))
  resistor("R1", (3, 5), (3, 2.5), label: (content: $R_1$, anchor: "south"), u: $V_1$)
  resistor("R2", (3, 2.5), (3, 0), label: (content: $R_2$, anchor: "south"), u: $V_2$)
})
```

## fletcher (block diagrams, state machines)
Nodes sit at `(column, row)` with x to the right and y down. Put the text in `[ ]`. An edge takes points or node names and a label as an extra argument; `bend: 20deg` curves it (opposite signs for the way back), a self loop is `edge(<s>, <s>, "-|>", [$0$], bend: 130deg, loop-angle: 90deg)`. A summing junction is a circle node with `$Sigma$`.
```typ
#import "@preview/fletcher:0.5.8" as fletcher: diagram, node, edge
#diagram(node-stroke: 0.8pt, spacing: (22mm, 14mm),
  node((0, 0), [$Sigma$], shape: circle, name: <sum>), node((1, 0), [$C(s)$], shape: rect, name: <c>),
  node((2, 0), [$G(s)$], shape: rect, name: <g>), node((2, 1), [$H(s)$], shape: rect, name: <h>),
  edge((-1, 0), <sum>, "-|>", [$R(s)$]), edge(<sum>, <c>, "-|>"), edge(<c>, <g>, "-|>"),
  edge(<g>, (3, 0), "-|>", [$Y(s)$]), edge((2.7, 0), (2.7, 1), <h>, "-|>"),
  edge(<h>, (0, 1), <sum>, "-|>", [$-$], label-side: left))
```

## lilaq (plots with a log axis, cycles)
`lq.diagram(width:, height:, xscale: "log", yscale: "log", xlim:, ylim:, xlabel:, ylabel:, ...plots)`, `lq.plot(xs, ys, mark: none, color: black)`, `lq.logspace(a, b, num: n)` (10^a to 10^b), `lq.linspace(a, b, num: n)`, `lq.marks.o`, `lq.place(x, y, [text], align: left)`. Use `calc.log(x)` (base 10), `calc.pow`, `calc.sqrt`, `calc.atan`. For a cycle plot the segments as separate `lq.plot` calls and set `xaxis: (ticks: none)`. A curve that comes from a formula needs 120 points or more (`num: 120`), in lilaq and in a cetz `line` built from a list alike: with fewer points the bends show as corners.
```typ
#import "@preview/lilaq:0.6.0" as lq
#let w = lq.logspace(1, 5, num: 120)
#let mag(x) = -10 * calc.log(1 + calc.pow(x / 1000, 2))
#lq.diagram(
  width: 9cm, height: 5.5cm, xscale: "log", ylim: (-40, 3), xlabel: [$f$ (Hz)], ylabel: [$|H|$ (dB)],
  lq.plot(w, w.map(mag), mark: none, color: black),
  lq.plot((1000,), (mag(1000),), mark: lq.marks.o, color: black),
  lq.place(1300, -1.5, [$-3$ dB], align: left),
)
```
