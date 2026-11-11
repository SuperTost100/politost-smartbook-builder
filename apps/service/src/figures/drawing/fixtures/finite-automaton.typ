#import "@preview/finite:0.5.1": automaton
#automaton(
  (
    q0: (q0: 0, q1: 1),
    q1: (q0: 0, q2: 1),
    q2: (q2: (0, 1)),
  ),
  initial: "q0",
  final: ("q2",),
)
