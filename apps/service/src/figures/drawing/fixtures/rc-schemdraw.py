import schemdraw
import schemdraw.elements as elm
with schemdraw.Drawing(show=False) as d:
    elm.SourceSin().up().label('$V_{in}$', loc='left')
    elm.Resistor().right().label('$R$')
    elm.Dot()
    elm.Capacitor().down().label('$C$')
    elm.Line().left().tox(d.here[0] - 6)
    elm.Line().right().at((6, 0)).tox(6)
    elm.Ground().at((3, 0))
