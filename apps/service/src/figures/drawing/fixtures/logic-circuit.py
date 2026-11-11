import schemdraw
import schemdraw.elements as elm
from schemdraw import logic
with schemdraw.Drawing(show=False) as d:
    # F = (A AND B) OR (NOT C)
    g1 = logic.And().right().at((0, 0))
    logic.Line().left(1).at(g1.in1).label('A', 'left')
    logic.Line().left(1).at(g1.in2).label('B', 'left')
    n1 = logic.Not().right().at((0, -2.5))
    logic.Line().left(1).at(n1.in1).label('C', 'left')
    g2 = logic.Or().right().at((3, -1.2))
    elm.Wire('-|').at(g1.out).to(g2.in1)
    elm.Wire('-|').at(n1.out).to(g2.in2)
    logic.Line().right(1).at(g2.out).label('F', 'right')
