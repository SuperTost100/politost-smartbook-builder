#import "@preview/lilaq:0.6.0" as lq
#let w = lq.logspace(1, 5, num: 120)
#let mag(x) = -10 * calc.log(1 + calc.pow(x / 1000, 2))
#lq.diagram(
  width: 9cm, height: 5.5cm,
  xscale: "log",
  xlabel: [$omega$ (rad/s)], ylabel: [$|H|$ (dB)],
  lq.plot(w, w.map(mag), mark: none),
  lq.plot((1000,), (mag(1000),), mark: lq.marks.o),
)
