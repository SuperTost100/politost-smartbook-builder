#import "@preview/cetz:0.5.2": canvas, draw
#import "@preview/cetz-plot:0.1.4": plot
#canvas({
  plot.plot(size: (8, 4), x-label: [$t$], y-label: [$x(t)$], x-tick-step: calc.pi, {
    plot.add(domain: (0, 2 * calc.pi), x => calc.sin(x))
    plot.add(domain: (0, 2 * calc.pi), x => calc.sin(2 * x) / 2, style: (stroke: (dash: "dashed")))
  })
})
