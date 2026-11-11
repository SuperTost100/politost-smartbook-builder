import schemdraw
import schemdraw.elements as elm
with schemdraw.Drawing(show=False) as d:
    op = elm.Opamp(leads=True)
    elm.Line().down(d.unit / 4).at(op.in2).dot()
    elm.Ground()
    elm.Resistor().at(op.in1).left(d.unit * 0.75).idot().label('$R_1$', loc='bottom').label('$V_{in}$', loc='left')
    elm.Line().up(d.unit / 2).at(op.in1).dot()
    elm.Resistor().tox(op.out).label('$R_2$')
    elm.Line().toy(op.out).dot()
    elm.Line().at(op.out).right(d.unit / 4).label('$V_{out}$', loc='right')
