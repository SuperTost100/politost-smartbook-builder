#import "@preview/lilaq:0.6.0" as lq
// Otto cycle: two adiabats and two isochores, ideal gas with gamma = 1.4
#let g = 1.4
#let ad(p, v, v0) = p * calc.pow(v0 / v, g)
#let v1 = 1.0
#let v2 = 0.25
#let p1 = 1.0
#let p2 = ad(p1, v2, v1)
#let p3 = 2.6 * p2
#let p4 = ad(p3, v1, v2)
#let vs = lq.linspace(v2, v1, num: 40)
#lq.diagram(
  width: 8cm, height: 6cm,
  xlabel: [$V$], ylabel: [$p$],
  xlim: (0, 1.2), ylim: (0, p3 * 1.1),
  xaxis: (ticks: none), yaxis: (ticks: none),
  lq.plot(vs, vs.map(v => ad(p1, v, v1)), mark: none, color: black),
  lq.plot((v2, v2), (p2, p3), mark: none, color: black),
  lq.plot(vs, vs.map(v => ad(p3, v, v2)), mark: none, color: black),
  lq.plot((v1, v1), (p4, p1), mark: none, color: black),
  lq.plot((v1, v2, v2, v1), (p1, p2, p3, p4), mark: lq.marks.o, stroke: none, color: black),
  lq.place(v1 + 0.05, p1, [1], align: left),
  lq.place(v2 - 0.05, p2, [2], align: right),
  lq.place(v2 - 0.05, p3, [3], align: right),
  lq.place(v1 + 0.05, p4, [4], align: left),
)
